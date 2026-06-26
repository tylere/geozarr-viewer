/**
 * Types + helpers for the Structure panel (Zarr-store introspection).
 *
 * Each profile knows its own metadata story (whether GeoZarr attrs are
 * store-native, hand-injected, or synthesized from coord arrays), so the
 * profile contributes a `StructureProfileSummary`. Everything else
 * (shape / dtype / chunks / fill value / attrs) is introspected by the
 * Structure panel directly from the opened `zarr.Array`, plus a one-shot
 * `fetchCodecSummary()` for sharding/compressor info (zarrita doesn't
 * expose codec details on the public `Array` surface).
 */

/** A single detected Zarr convention (name + optional version string). */
export type ConventionEntry = {
  name: string;
  version: string | null;
  /** Link to the convention's spec/docs, when one can be sourced. */
  specUrl?: string;
  /** Set when the convention was inferred from a legacy/pre-standard signal
   * rather than the canonical `zarr_conventions` registry. The text explains
   * the current best practice and is surfaced as a warning tooltip. */
  legacy?: string;
};

const LEGACY_MULTISCALES_NOTE =
  "Detected from a legacy array-shaped `multiscales` attribute (the " +
  "xarray-multiscale / ndpyramid layout). Current best practice is to declare " +
  "multiscale pyramids via the `zarr_conventions` registry — see " +
  "github.com/zarr-conventions/multiscales.";

/** A canonical spec/docs URL, or a builder when the URL is version-specific. */
type SpecUrl = string | ((version: string | null) => string);

/**
 * Curated map of convention name → canonical spec link. Keys are normalized
 * (see {@link normalizeConventionName}). This is the ONLY source of links: a
 * convention is rendered as a link iff it appears here, so we never depend on a
 * store's self-declared `spec_url` (which can be dead — see issue #36) and never
 * fabricate a URL for an unknown convention. All URLs verified 2026-06-25.
 */
const CONVENTION_SPECS: Record<string, SpecUrl> = {
  cf: (v) =>
    v
      ? `https://cfconventions.org/Data/cf-conventions/cf-conventions-${v}/cf-conventions.html`
      : "https://cfconventions.org/",
  "ome-zarr": (v) =>
    v
      ? `https://ngff.openmicroscopy.org/${v}/`
      : "https://ngff.openmicroscopy.org/latest/",
  multiscales: "https://github.com/zarr-conventions/multiscales",
  proj: "https://github.com/zarr-conventions/proj",
  spatial: "https://github.com/zarr-conventions/spatial",
  geoemb: "https://github.com/geo-embeddings/embeddings-zarr-convention",
  geozarr: "https://github.com/zarr-developers/geozarr-spec",
  ugrid: "http://ugrid-conventions.github.io/ugrid-conventions/",
  acdd: "https://wiki.esipfed.org/Attribute_Convention_for_Data_Discovery_1-3",
};

/** Normalize a convention name for table lookup: lowercase, trim, and strip a
 * trailing `:` (registry names like FTW's `proj:` / `spatial:`). */
function normalizeConventionName(name: string): string {
  return name.trim().toLowerCase().replace(/:+$/, "");
}

/** Canonical spec URL for a convention from {@link CONVENTION_SPECS}, or
 * undefined when the convention isn't in the curated table. */
function specUrlFor(name: string, version: string | null): string | undefined {
  const entry = CONVENTION_SPECS[normalizeConventionName(name)];
  return typeof entry === "function" ? entry(version) : entry;
}

/**
 * Detect Zarr conventions explicitly declared by the root group's attributes.
 *
 * Checks, in order:
 *   - The CF-style `Conventions` string attr (CF, ACDD, UGRID, …).
 *   - The canonical `zarr_conventions` registry (array of {name, …}).
 *   - A `multiscales` array attr — OME-Zarr when it carries `axes`, otherwise
 *     the legacy datasets-based pyramid layout (flagged legacy).
 *
 * Every link comes from the curated {@link CONVENTION_SPECS} table; conventions
 * not in the table are listed without a link. Names are deduped (first wins),
 * so a registry-declared `multiscales` takes precedence over the legacy array.
 */
export function detectConventions(
  attrs: Record<string, unknown>,
): ConventionEntry[] {
  const result: ConventionEntry[] = [];
  const seen = new Set<string>();
  const add = (entry: ConventionEntry) => {
    if (seen.has(entry.name)) return;
    seen.add(entry.name);
    result.push(entry);
  };

  const conv = attrs["Conventions"];
  if (typeof conv === "string" && conv.trim()) {
    for (const token of conv.split(/[\s,]+/).filter(Boolean)) {
      const m = /^([A-Za-z][A-Za-z0-9_-]*)-(\d[\d.]*)$/.exec(token);
      const name = m ? m[1]! : token;
      const version = m ? m[2]! : null;
      const specUrl = specUrlFor(name, version);
      add(specUrl ? { name, version, specUrl } : { name, version });
    }
  }

  // Canonical registry: stores declare their conventions explicitly here. Links
  // come from our curated table keyed by the (normalized) name — NOT the store's
  // declared `spec_url`, which can be dead (FTW's `proj:`/`spatial:` both 404).
  const registry = attrs["zarr_conventions"];
  if (Array.isArray(registry)) {
    for (const entry of registry) {
      if (!isObject(entry)) continue;
      const name = entry["name"];
      if (typeof name !== "string" || !name) continue;
      const version = registryVersion(entry);
      const specUrl = specUrlFor(name, version);
      add(specUrl ? { name, version, specUrl } : { name, version });
    }
  }

  // The `multiscales` key is NOT unique to OME-Zarr: the legacy datasets-based
  // pyramid layout (e.g. Meta CHM, xarray-multiscale) reuses it. OME-NGFF
  // multiscale entries always carry an `axes` array (spec-required since v0.3);
  // the legacy layout has none. Gate OME on `axes`; treat an `axes`-less
  // datasets array as the legacy `multiscales` convention (unless the registry
  // already declared it). A legacy entry is both linked (table) and warned.
  const multiscales = attrs["multiscales"];
  if (Array.isArray(multiscales) && multiscales.length > 0) {
    const first = multiscales[0];
    if (isObject(first) && Array.isArray(first["axes"])) {
      const version =
        typeof first["version"] === "string" ? first["version"] : null;
      const specUrl = specUrlFor("OME-Zarr", version);
      add(specUrl ? { name: "OME-Zarr", version, specUrl } : { name: "OME-Zarr", version });
    } else if (isObject(first) && Array.isArray(first["datasets"])) {
      add({
        name: "multiscales",
        version: null,
        specUrl: specUrlFor("multiscales", null),
        legacy: LEGACY_MULTISCALES_NOTE,
      });
    }
  }

  return result;
}

/** Version for a `zarr_conventions` registry entry: only an explicit `version`
 * string, else null. We deliberately do NOT infer it from the `schema_url` tag
 * — that produced misleading labels for real stores (e.g. a `v1` tag rendering
 * a colon-suffixed name as `proj:-1`). See issue #36. */
function registryVersion(entry: Record<string, unknown>): string | null {
  return typeof entry["version"] === "string" ? entry["version"] : null;
}

/** Where the GeoZarr-style attrs handed to `ZarrLayer.metadata` came from. */
export type GeoZarrMetadataSource =
  /** Already on the store at open time (AEF, FTW). */
  | "store-native"
  /** Hand-crafted constant injected because the store has no GeoZarr
   * attrs of its own. */
  | "injected"
  /** Built at prepare-time from coord arrays or other store metadata
   * (FireSmoke). */
  | "synthesized";

export type StructureVariable = {
  /** Path within the root group (e.g. `"temperature_2m"`, `"PM25_latest"`). */
  path: string;
  /** Optional human role for multi-array setups (`"red"` / `"green"` /
   * `"level 0"` / etc.). Renderer ignores when omitted. */
  role?: string;
};

export type StructureProfileSummary = {
  /** "v2" | "v3" — matches how the profile opened the store. All current
   * profiles use `zarr.open.v3` → `"v3"`. */
  zarrVersion: "v2" | "v3";
  /** One entry per array the profile considers part of this view. The
   * first entry is the primary one (drives the shape / dtype / codec
   * rows in the panel). Extras render as a sub-list. */
  variables: readonly [StructureVariable, ...StructureVariable[]];
  metadataSource: GeoZarrMetadataSource;
  /** The exact value handed to `ZarrLayer.metadata` (or `null` if the
   * layer reads attrs straight off the node). */
  metadata: unknown;
};

export type CodecSummary = {
  sharded: boolean;
  /** Sub-chunk shape from `sharding_indexed` codec, when present. */
  subChunkShape: readonly number[] | null;
  /** Display string like `"blosc(zstd, clevel=3, shuffle)"` or `"raw"`. */
  compressor: string | null;
};

/** Fetch and parse the primary array's metadata document, returning a
 * `CodecSummary` for the panel. Tries `zarr.json` (v3) first, falls back
 * to `.zarray` (v2). Returns `null` on any failure (404, JSON parse
 * error, abort) — the panel renders `"—"` for affected rows. */
export async function fetchCodecSummary(
  storeUrl: string,
  variablePath: string,
  signal: AbortSignal,
): Promise<CodecSummary | null> {
  const base = storeUrl.replace(/\/+$/, "");
  const path = variablePath.replace(/^\/+|\/+$/g, "");
  const v3Url = `${base}/${path}/zarr.json`;
  const v2Url = `${base}/${path}/.zarray`;

  const json = await fetchJson(v3Url, signal);
  if (json) return summarizeV3(json);
  if (signal.aborted) return null;

  const v2 = await fetchJson(v2Url, signal);
  if (v2) return summarizeV2(v2);
  return null;
}

async function fetchJson(
  url: string,
  signal: AbortSignal,
): Promise<unknown | null> {
  try {
    const resp = await fetch(url, { signal });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/** Parse a Zarr v3 array's `zarr.json`. v3 codecs are a flat list under
 * `codecs[]`; sharding lives in a `sharding_indexed` codec with its own
 * inner `codecs[]` chain. */
function summarizeV3(json: unknown): CodecSummary | null {
  if (!isObject(json)) return null;
  if (json.node_type !== "array") return null;
  const codecs = Array.isArray(json.codecs) ? json.codecs : [];
  let sharded = false;
  let subChunkShape: readonly number[] | null = null;
  let innerCodecs: unknown[] = codecs;
  for (const c of codecs) {
    if (!isObject(c)) continue;
    if (c.name === "sharding_indexed") {
      sharded = true;
      const cfg = isObject(c.configuration) ? c.configuration : {};
      if (Array.isArray(cfg.chunk_shape)) {
        subChunkShape = cfg.chunk_shape.filter(
          (n): n is number => typeof n === "number",
        );
      }
      // Compressor lives in the *inner* codecs chain for sharded stores.
      if (Array.isArray(cfg.codecs)) innerCodecs = cfg.codecs;
    }
  }
  return {
    sharded,
    subChunkShape,
    compressor: describeCompressor(innerCodecs),
  };
}

/** Parse a Zarr v2 array's `.zarray`. Compressor is a single object
 * under `compressor` (or `null`). No sharding in v2. */
function summarizeV2(json: unknown): CodecSummary | null {
  if (!isObject(json)) return null;
  const compressor = json.compressor;
  if (compressor === null || compressor === undefined) {
    return { sharded: false, subChunkShape: null, compressor: "raw" };
  }
  if (!isObject(compressor)) return null;
  return {
    sharded: false,
    subChunkShape: null,
    compressor: formatCompressorObject(compressor),
  };
}

/** Build a one-line compressor string from a v3 inner-codec list. Skips
 * the `bytes` codec (always present, structural) and any unknown codecs
 * after the compressor — we only summarize the *primary* compressor. */
function describeCompressor(codecs: readonly unknown[]): string | null {
  for (const c of codecs) {
    if (!isObject(c)) continue;
    if (c.name === "bytes") continue; // endian / packing, not interesting
    return formatCompressorObject(c);
  }
  return "raw";
}

function formatCompressorObject(c: Record<string, unknown>): string {
  const name = typeof c.name === "string" ? c.name : typeof c.id === "string" ? c.id : "?";
  const cfg = isObject(c.configuration) ? c.configuration : c;
  // Pull the small set of fields commonly seen on blosc/zstd/gzip.
  const parts: string[] = [];
  if (typeof cfg.cname === "string") parts.push(cfg.cname);
  if (typeof cfg.clevel === "number") parts.push(`clevel=${cfg.clevel}`);
  if (typeof cfg.shuffle !== "undefined") {
    parts.push(`shuffle=${cfg.shuffle}`);
  }
  if (parts.length === 0) return name;
  return `${name}(${parts.join(", ")})`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
