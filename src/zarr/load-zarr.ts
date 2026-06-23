import {
  encodeObjectId12,
  HttpStorage,
  IcechunkStore,
  Repository,
  SpecVersion,
} from "icechunk-js";
import * as zarr from "zarrita";
import { createLogger } from "../log";
import { withRetry } from "./retry-store";

const log = createLogger("store");

export type ConsolidatedStore = zarr.Readable & {
  contents: () => { path: string; kind: "array" | "group" }[];
};

/** Version/provenance facts about an Icechunk repo, surfaced in the
 * Structure panel. Attached to the opened store (see {@link asIcechunk}). */
export type IcechunkInfo = {
  specVersion: "v1" | "v2";
  branch: string;
  snapshotId: string;
  message: string;
  flushedAt: Date;
  /** Other branches/tags in the repo. Empty for v1 stores read over plain
   * HTTP — `HttpStorage` can't list refs, so only the checked-out branch is
   * known. */
  branches: string[];
  tags: string[];
};

type IcechunkAwareStore = zarr.Readable & { icechunk: IcechunkInfo };

/** Remap a source.coop S3 object URL onto the `data.source.coop` CORS proxy.
 *
 * Virtual-chunk Icechunk stores (e.g. Meta CHM v2) record their refs as
 * absolute `s3://<region>.opendata.source.coop/<key>` locations. icechunk-js
 * translates those to **path-style** `https://s3.amazonaws.com/<bucket>/<key>`
 * URLs — but the bucket name is dotted (`us-west-2.opendata.source.coop`), so
 * the global S3 endpoint answers a 301 redirect to the regional host, which
 * icechunk-js's virtual fetch treats as a hard error (it only accepts 200/206).
 * The same objects are served with permissive CORS + range support at
 * `https://data.source.coop/<key>`, so we rewrite onto that host. URLs that
 * don't match a source.coop S3 bucket pass through unchanged. */
export function rewriteSourceCoopS3Url(url: string): string {
  const m = url.match(
    /^https:\/\/s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com\/[a-z0-9-]+\.opendata\.source\.coop\/(.+)$/,
  );
  return m ? `https://data.source.coop/${m[1]}` : url;
}

export type OpenedStore = {
  group: zarr.Group<zarr.Readable>;
  /** The underlying store. When `consolidated: true` was requested, this
   * is the consolidated-metadata wrapper exposing `.contents()`. For
   * Icechunk stores this is the `IcechunkStore`, which carries both a
   * `contents()` adapter and the `icechunk` info object. */
  store: zarr.Readable;
};

/** True when a (normalized) store URL points at an Icechunk repository
 * rather than a plain Zarr hierarchy. Icechunk stores have a transactional
 * `refs/`+`snapshots/`+`manifests/`+`chunks/` layout that `FetchStore`
 * can't read; they're routed through `IcechunkStore` instead.
 *
 * This is the cheap, synchronous fast path — a `.icechunk` filename suffix.
 * Repos that omit it (e.g. source.coop datasets named `*_icechunk` or under a
 * `/icechunk/` path) aren't caught here; {@link hasIcechunkRepoConfig} settles
 * those with a layout probe at open time. */
export function isIcechunkUrl(url: string): boolean {
  return /\.icechunk\/?$/.test(url.split("?")[0]!);
}

/** Layout probe: HEAD `<url>/repo` to decide whether a suffix-less URL is an
 * Icechunk repo. Icechunk writes a root `repo` object — its "repo-info" config
 * (the response carries `x-amz-meta-ic_file_type: repo-info`) — whereas a
 * plain Zarr hierarchy has `zarr.json` there instead. data.source.coop serves
 * this object with permissive CORS and honors HEAD. Any network/CORS error (or
 * a 404 on a real Zarr store) returns false, falling back to the Zarr path. */
async function hasIcechunkRepoConfig(url: string): Promise<boolean> {
  const base = url.split("?")[0]!.replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/repo`, { method: "HEAD" });
    log.debug(`icechunk repo probe ${base}/repo → ${res.status}`);
    return res.ok;
  } catch (err) {
    log.debug(`icechunk repo probe ${base}/repo failed`, err);
    return false;
  }
}

/** Open an Icechunk repo at `url` as a zarrita-readable store.
 *
 * `IcechunkStore` implements zarrita's `AsyncReadable` (incl. `getRange`
 * with suffix reads for sharded arrays), so once opened it plugs into the
 * same `zarr.open.v3` / `ZarrLayer` path as a plain store. Unlike
 * `FetchStore`, it must NOT be wrapped with `withRangeCoalescing` (that
 * would hide its `listNodes`/`session` methods) — coalescing is opted into
 * via the `withRangeCoalescing` option instead. ({@link withRetry} IS safe to
 * wrap it with: that store-extension proxy overrides only `get`/`getRange`
 * and delegates everything else — `listNodes`/`session`/`contents`/the
 * attached `icechunk` info — to the inner store.)
 *
 * `Repository.open` auto-detects the v1/v2 format. Ref listing is guarded:
 * over plain HTTP, v1 repos can't enumerate branches/tags, so those degrade
 * to empty while the `main` checkout (legacy ref path) still works. */
async function openIcechunk(
  url: string,
  consolidated: boolean,
): Promise<OpenedStore> {
  const storage = new HttpStorage(url);
  const repo = await Repository.open({ storage });
  const [branches, tags] = await Promise.all([
    repo.listBranches().catch(() => [] as string[]),
    repo.listTags().catch(() => [] as string[]),
  ]);
  const branch =
    branches.length === 0 || branches.includes("main") ? "main" : branches[0]!;
  const session = await repo.checkoutBranch(branch);
  const ice = await IcechunkStore.open(session, {
    withRangeCoalescing: zarr.withRangeCoalescing,
    // Virtual chunks (e.g. Meta CHM v2's refs into source.coop COGs) are fetched
    // through this hook; redirect path-style S3 URLs to the CORS proxy (see
    // `rewriteSourceCoopS3Url`). Native chunk/metadata reads use `storage` and
    // are unaffected.
    fetchClient: {
      fetch: (u: string, init?: RequestInit) =>
        fetch(rewriteSourceCoopS3Url(u), init),
    },
  });

  const info: IcechunkInfo = {
    specVersion: session.getSpecVersion() === SpecVersion.V2_0 ? "v2" : "v1",
    branch,
    snapshotId: encodeObjectId12(session.getSnapshotId()),
    message: session.getMessage(),
    flushedAt: session.getFlushedAt(),
    branches,
    tags,
  };
  log.info(
    `icechunk ${info.specVersion} branch="${info.branch}" snapshot=${info.snapshotId}`,
  );
  log.debug("icechunk refs", {
    branches: branches.length,
    tags: tags.length,
    flushedAt: info.flushedAt,
  });
  Object.assign(ice, { icechunk: info });

  if (consolidated) {
    // Icechunk has no consolidated-metadata file, but the snapshot already
    // lists every node — adapt `listNodes()` into the `contents()` shape so
    // `asConsolidated()` (and profile variable-enumeration) work unchanged.
    Object.assign(ice, {
      contents: () =>
        ice.listNodes().map((n) => ({
          path: n.path,
          kind: n.nodeData.type as "array" | "group",
        })),
    });
  }

  // Retry transient network/server failures (flaky links, source.coop
  // throttling) on every chunk/metadata read. Wraps AFTER the `contents()` /
  // `icechunk` props are attached so the proxy reflects them through.
  const store = withRetry(ice as zarr.AsyncReadable);
  const group = await zarr.open.v3(store, { kind: "group" });
  return { group, store };
}

/** Open a Zarr v3 store at `url`. Routes `.icechunk` URLs to
 * {@link openIcechunk}; everything else uses the `FetchStore` stack below.
 *
 * FetchStore stacking:
 * 1. `FetchStore` — base HTTP backend. `useSuffixRequest: true` is
 *    REQUIRED for sharded stores (AEF, FTW). The sharding codec reads
 *    its index from the end of each shard via a suffix read; zarrita's
 *    default path does a HEAD first to turn that into an absolute range,
 *    but cross-origin HEAD responses on `data.source.coop` don't expose a
 *    readable `Content-Length`, so zarrita computes `length = 0` and emits
 *    the malformed header `bytes=-N--1`. The server then answers with the
 *    whole object — a ~500 MB shard pulled per tile. A direct
 *    `bytes=-N` suffix request (which the host honors with a 206) avoids
 *    the HEAD entirely and reads only the index.
 * 2. `withRangeCoalescing` — merges concurrent `getRange` calls within a
 *    microtask if they're separated by < 32 KB. For sharded stores
 *    (AEF, FTW) this is a big win: a single tile typically reads
 *    several nearby sub-shards inside the same outer-chunk file, and
 *    coalescing collapses those into one HTTP request.
 * 3. `withConsolidatedMetadata` (optional) — exposes `.contents()` for
 *    cheap hierarchy listing without per-array `zarr.json` fetches. */
export async function openV3Group(
  url: string,
  options: { consolidated?: boolean; version?: "v3" | "auto" } = {},
): Promise<OpenedStore> {
  // Suffix is the fast path; for suffix-less URLs, a layout probe catches
  // Icechunk repos whose name doesn't end in `.icechunk` (e.g. source.coop's
  // `*_icechunk` / `/icechunk/` datasets). Plain Zarr stores cost one extra
  // HEAD (404) before falling through.
  const done = log.time(`open ${url}`, "info");
  if (isIcechunkUrl(url) || (await hasIcechunkRepoConfig(url))) {
    log.info(`open (icechunk) ${url}`);
    const opened = await openIcechunk(url, options.consolidated ?? false);
    done();
    return opened;
  }
  log.info(`open (fetch) ${url}`);
  const raw = new zarr.FetchStore(url, { useSuffixRequest: true });
  const coalesced = zarr.withRangeCoalescing(raw);
  // Retry transient failures outside coalescing so a coalesced group-read is
  // retried as one unit (and consolidated-metadata reads inherit it too).
  const retrying = withRetry(coalesced);
  let store: zarr.Readable = retrying;
  if (options.consolidated) {
    try {
      store = await zarr.withConsolidatedMetadata(retrying, { format: "v3" });
      log.debug("consolidated metadata: hit");
    } catch {
      // Store ships no consolidated metadata (e.g. FireSmoke). Fall back to
      // the plain (still retrying) store; callers that need to enumerate
      // nodes detect the missing `contents()` via `asConsolidated` and probe.
      store = retrying;
      log.debug("consolidated metadata: miss (will probe variables)");
    }
  }
  // Default to v3 (every source.coop store). `version: "auto"` lets the image
  // profile open OME-Zarr v0.4 stores (zarr v2: `.zgroup`/`.zarray`); zarrita's
  // `open` auto-detects, trying v3 then falling back to v2.
  const group =
    options.version === "auto"
      ? await zarr.open(store, { kind: "group" })
      : await zarr.open.v3(store, { kind: "group" });
  done();
  return { group, store };
}

/** Narrow a store to the consolidated `Listable` shape. Returns null when
 * the store wasn't wrapped with `withConsolidatedMetadata` (or, for
 * Icechunk, given a `contents()` adapter). */
export function asConsolidated(store: zarr.Readable): ConsolidatedStore | null {
  if (typeof (store as ConsolidatedStore).contents === "function") {
    return store as ConsolidatedStore;
  }
  return null;
}

/** Narrow a store to its Icechunk info, or null for plain-Zarr stores. */
export function asIcechunk(store: zarr.Readable): IcechunkInfo | null {
  const info = (store as IcechunkAwareStore).icechunk;
  return info ?? null;
}
