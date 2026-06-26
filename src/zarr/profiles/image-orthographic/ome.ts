import * as zarr from "zarrita";
import { createLogger } from "../../../log";
import type { OmeAxis, OmeChannel, OmeLevel } from "./types";

const log = createLogger("ome");

/** Minimal shape of the OME metadata block we read. Everything is optional /
 * cast loosely — stores vary, and we validate the parts we depend on. */
type OmeBlock = {
  multiscales?: {
    axes?: OmeAxis[];
    datasets?: { path: string; coordinateTransformations?: unknown[] }[];
  }[];
  omero?: { channels?: unknown[] };
  "bioformats2raw.layout"?: number;
  /** HCS plate: wells reference well groups, each holding field images. */
  plate?: { wells?: { path?: string }[] };
  /** A well group: images are the fields acquired in that well. */
  well?: { images?: { path?: string }[] };
};

/** Thrown by the default (scalar-grid) profile's `prepare` when it detects an
 * OME-Zarr image store, signalling the chassis to switch to the
 * `image-orthographic` profile. Mirrors `MultiscaleStoreError`. */
export class OmeZarrStoreError extends Error {
  constructor() {
    super("OME-Zarr image store — use the image-orthographic profile");
    this.name = "OmeZarrStoreError";
  }
}

/** Pure attrs predicate: true when a root group's attrs carry OME-Zarr image
 * markers. v0.5 = `ome` wrapper object; v0.4 = root-level `multiscales` with an
 * `axes` array (distinct from CF/rioxarray multiscales, which have no `axes`),
 * or HCS `plate`/`well`, or `bioformats2raw.layout`.
 *
 * Takes raw attrs directly (not via {@link omeOf}): `omeOf` falls back to the
 * raw root attrs when there's no `ome` wrapper, which would blur the
 * v0.5-wrapper vs v0.4-root distinction this detector relies on. */
export function isOmeZarrAttrs(rootAttrs: unknown): boolean {
  if (typeof rootAttrs !== "object" || rootAttrs === null) return false;
  const attrs = rootAttrs as Record<string, unknown>;
  if (typeof attrs.ome === "object" && attrs.ome !== null) return true; // v0.5
  const ms = attrs.multiscales;
  if (
    Array.isArray(ms) &&
    ms.length > 0 &&
    Array.isArray((ms[0] as { axes?: unknown })?.axes)
  ) {
    return true; // v0.4 OME (axes distinguish it from CF/rioxarray pyramids)
  }
  if (typeof attrs.plate === "object" && attrs.plate !== null) return true;
  if (typeof attrs.well === "object" && attrs.well !== null) return true;
  if ("bioformats2raw.layout" in attrs) return true;
  return false;
}

function omeOf(group: zarr.Group<zarr.Readable>): OmeBlock | undefined {
  const attrs = group.attrs as Record<string, unknown>;
  // OME-Zarr v0.5 nests metadata under an `ome` key; v0.4 puts `multiscales`/
  // `omero`/`plate` at the root attrs directly. Prefer the wrapper, else fall
  // back to the root attrs themselves.
  const ome = attrs.ome;
  if (typeof ome === "object" && ome !== null) return ome as OmeBlock;
  return attrs as OmeBlock;
}

/** Resolve the group that actually holds `multiscales`, descending the common
 * OME-Zarr container layouts. Returns the multiscale group plus its path from
 * the root (`""` when multiscales are at the root). The MVP renders a single
 * image, so containers (plates/series) resolve to their first image:
 *   - multiscales at the root → use it.
 *   - HCS plate → first well → first field image.
 *   - bioformats2raw.layout 3 → series `0`. */
async function resolveMultiscaleGroup(
  root: zarr.Group<zarr.Readable>,
  signal: AbortSignal,
): Promise<{ group: zarr.Group<zarr.Readable>; seriesPath: string }> {
  if (omeOf(root)?.multiscales?.length) {
    return { group: root, seriesPath: "" };
  }

  const openImageAt = async (path: string) => {
    // `open` (auto) so v0.4 (zarr v2) plate/well/field sub-groups open too.
    const g = await zarr.open(root.resolve(path), { kind: "group" });
    if (signal.aborted) throw new Error("aborted");
    return g;
  };

  // HCS plate: plate → well → field. Pick the first well, then its first field.
  const plate = omeOf(root)?.plate;
  if (plate?.wells?.length) {
    const wellPath = plate.wells[0]?.path;
    if (wellPath) {
      const well = await openImageAt(wellPath);
      const fieldPath = omeOf(well)?.well?.images?.[0]?.path;
      if (fieldPath) {
        const seriesPath = `${wellPath}/${fieldPath}`;
        const field = await openImageAt(seriesPath);
        if (omeOf(field)?.multiscales?.length) {
          return { group: field, seriesPath };
        }
      }
    }
  }

  // bioformats2raw: first image series. (Multi-series would enumerate here.)
  if (omeOf(root)?.["bioformats2raw.layout"] === 3) {
    const series = await openImageAt("0");
    if (omeOf(series)?.multiscales?.length) {
      return { group: series, seriesPath: "0" };
    }
  }

  throw new Error(
    "Not an OME-Zarr image: no `ome.multiscales` at the root, first plate well, or series 0.",
  );
}

/** Pull the per-axis `scale` vector out of a dataset's coordinateTransformations
 * (OME requires exactly one `scale`; translation is optional and ignored). */
function scaleOf(transforms: unknown[] | undefined, ndim: number): number[] {
  if (Array.isArray(transforms)) {
    for (const t of transforms) {
      if (
        typeof t === "object" &&
        t !== null &&
        (t as { type?: string }).type === "scale" &&
        Array.isArray((t as { scale?: unknown }).scale)
      ) {
        return (t as { scale: number[] }).scale;
      }
    }
  }
  return new Array(ndim).fill(1);
}

function parseChannels(omero: { channels?: unknown[] } | undefined): OmeChannel[] {
  const raw = omero?.channels;
  if (!Array.isArray(raw)) return [];
  return raw.map((c, i): OmeChannel => {
    const o = (typeof c === "object" && c !== null ? c : {}) as Record<
      string,
      unknown
    >;
    const win = (
      typeof o.window === "object" && o.window !== null ? o.window : {}
    ) as Record<string, unknown>;
    const num = (v: unknown, fallback: number) =>
      typeof v === "number" && Number.isFinite(v) ? v : fallback;
    return {
      label: typeof o.label === "string" ? o.label : `channel ${i}`,
      color: typeof o.color === "string" ? o.color : "",
      start: num(win.start, num(win.min, 0)),
      end: num(win.end, num(win.max, 65535)),
      active: o.active !== false,
    };
  });
}

export type ParsedOme = {
  seriesPath: string;
  axes: OmeAxis[];
  channelAxisIndex: number | null;
  spatialAxes: { yIndex: number; xIndex: number };
  otherAxes: { name: string; axisIndex: number; size: number }[];
  channels: OmeChannel[];
  channelCount: number;
  levels: OmeLevel[];
  finestVariablePath: string;
  /** Finest-level spatial size — the world coordinate extent. */
  width: number;
  height: number;
};

/** Parse an opened OME-Zarr root group into the facts the image profile needs,
 * opening every pyramid level so shapes and downsample factors are known. */
export async function parseOme(
  root: zarr.Group<zarr.Readable>,
  signal: AbortSignal,
): Promise<ParsedOme> {
  const { group, seriesPath } = await resolveMultiscaleGroup(root, signal);
  const ms = omeOf(group)!.multiscales![0]!;
  const axes = (ms.axes ?? []).map((a) => ({
    name: a.name,
    type: a.type,
    unit: a.unit,
  }));
  const datasets = ms.datasets ?? [];
  if (datasets.length === 0) throw new Error("OME-Zarr multiscale has no levels.");

  // Spatial pair: the two axes typed "space", in order (y before x).
  const spaceIdx = axes
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => a.type === "space")
    .map(({ i }) => i);
  if (spaceIdx.length < 2) {
    throw new Error(
      `OME-Zarr image needs two spatial axes; found ${spaceIdx.length}.`,
    );
  }
  const yIndex = spaceIdx[spaceIdx.length - 2]!;
  const xIndex = spaceIdx[spaceIdx.length - 1]!;

  // Open every level (cheap metadata reads) so we know each one's shape.
  // `open` (auto) handles both v3 and v0.4 (zarr v2) arrays.
  const arrays = await Promise.all(
    datasets.map((d) => zarr.open(group.resolve(d.path), { kind: "array" })),
  );
  if (signal.aborted) throw new Error("aborted");

  // OME datasets are finest-first. Downsample is each level's spatial scale
  // relative to the finest level's (falls back to the y-size ratio).
  const finestScale = scaleOf(datasets[0]!.coordinateTransformations, axes.length);
  const finestHeight = arrays[0]!.shape[yIndex] ?? 1;
  const levels: OmeLevel[] = datasets.map((d, i) => {
    const arr = arrays[i]!;
    const scale = scaleOf(d.coordinateTransformations, axes.length);
    const height = arr.shape[yIndex] ?? 1;
    const byScale = (finestScale[yIndex] ?? 1) > 0
      ? (scale[yIndex] ?? 1) / (finestScale[yIndex] ?? 1)
      : 1;
    const downsample = Number.isFinite(byScale) && byScale > 0
      ? byScale
      : finestHeight / Math.max(1, height);
    return {
      path: d.path,
      scale,
      array: arr,
      width: arr.shape[xIndex] ?? 0,
      height,
      chunkW: arr.chunks[xIndex] ?? 512,
      chunkH: arr.chunks[yIndex] ?? 512,
      downsample,
    };
  });

  const finest = levels[0]!;
  const channelAxisIndex = axes.findIndex((a) => a.type === "channel");
  const channelCount =
    channelAxisIndex >= 0 ? (finest.array.shape[channelAxisIndex] ?? 1) : 1;

  const otherAxes = axes
    .map((a, i) => ({ name: a.name, axisIndex: i, size: finest.array.shape[i] ?? 1 }))
    .filter(
      ({ axisIndex }) =>
        axisIndex !== yIndex && axisIndex !== xIndex && axisIndex !== channelAxisIndex,
    );

  const channels = parseChannels(omeOf(group)!.omero);

  log.info(
    `OME image: series="${seriesPath}" axes=[${axes.map((a) => a.name).join(",")}] ` +
      `levels=${levels.length} finest=${finest.width}×${finest.height} ` +
      `downsamples=[${levels.map((l) => l.downsample).join(",")}] channels=${channelCount}`,
  );

  return {
    seriesPath,
    axes,
    channelAxisIndex: channelAxisIndex >= 0 ? channelAxisIndex : null,
    spatialAxes: { yIndex, xIndex },
    otherAxes,
    channels,
    channelCount,
    levels,
    finestVariablePath: (seriesPath ? `${seriesPath}/` : "") + finest.path,
    width: finest.width,
    height: finest.height,
  };
}
