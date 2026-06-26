import { ZarrLayer } from "@developmentseed/deck.gl-zarr";
import * as zarr from "zarrita";
import {
  autoStatsFromGlobal,
  buildBandStats,
} from "../../../render/stats";
import { readSampleValue } from "../../../render/sample-source";
import { buildSingleBandRenderTile } from "../../../render/single-band-pipeline";
import type { MultiBandTileData } from "../../../render/shared-textures";
import {
  buildTextureArrayRenderTile,
  makeTextureArrayTileLoader,
  type TextureArrayTileData,
} from "../../../render/texture-array-pipeline";
import { KEEP_MIN_ZOOM_EXTENT } from "../../../render/keep-min-zoom-tiles";
import { createLogger } from "../../../log";
import { bytesPerElement, spatialTileSize } from "../../chunk-size";
import { asConsolidated, openV3Group, type OpenedStore } from "../../load-zarr";
import { MultiscaleStoreError, parseMultiscaleDatasets } from "../../multiscale";
import { OmeZarrStoreError, isOmeZarrAttrs } from "../image-orthographic/ome";

const log = createLogger("profile");
import type { ZarrProfile } from "../../profile";
import { buildDimLabel } from "./cf-coords";
import { ScalarGridControls } from "./controls";
import { makeScalarGridTileLoader } from "./tile-loader";
import {
  defaultDimIndices,
  type ScalarGridContext,
  type ScalarGridDim,
  type ScalarGridSpatialAttrs,
  type ScalarGridState,
  type ScalarGridVariable,
} from "./types";

// Recognized spatial coordinate names, in priority order. A variable is
// renderable when its last two dims are (one of LAT, one of LON).
const LAT_NAMES = ["latitude", "lat", "y"];
const LON_NAMES = ["longitude", "lon", "x"];

// Variables we prefer to land on by default (first match wins). Everything
// else falls back to the first enumerated variable.
const PREFERRED_VARIABLES = [
  "t2m",
  "temperature_2m",
  "temperature",
  "SLP",
  "prmsl",
  "PM25",
  "PM25_latest",
  "PM25_RH35_GCC",
];

// Candidate variable names probed when a store ships no consolidated metadata
// (so its nodes can't be listed, e.g. FireSmoke). Each is opened by name and
// the first lat/lon grid found wins (we can't list the rest anyway), so common
// names come first to keep the number of probe fetches small.
const CANDIDATE_VARIABLES = [
  "PM25_latest",
  "PM25",
  "precip",
  "precipitation",
  "RRQPE",
  ...PREFERRED_VARIABLES,
];

/** Join a (possibly empty) subgroup path with a leaf name. `""` (a root-level
 * variable) yields the bare leaf; `zarr.Location.resolve()` joins the rest. */
function joinPath(group: string, leaf: string): string {
  return group ? `${group}/${leaf}` : leaf;
}

function spatialPair(
  dims: readonly (string | null)[] | undefined,
): { lat: string; lon: string } | null {
  if (!Array.isArray(dims) || dims.length < 2) return null;
  const lat = dims[dims.length - 2];
  const lon = dims[dims.length - 1];
  if (typeof lat !== "string" || typeof lon !== "string") return null;
  if (LAT_NAMES.includes(lat) && LON_NAMES.includes(lon)) return { lat, lon };
  return null;
}

function isNumericDtype(dtype: string): boolean {
  return /^(float|int|uint)/.test(dtype);
}

/** The outer (shard) spatial shape `[height, width]` from raw v3 array
 * metadata when the array is sharded, else null.
 *
 * zarrita exposes a sharded array's INNER sub-chunk as `arr.chunks`, but a tile
 * read coalesces every inner read inside one shard (see `withRangeCoalescing`),
 * so the atomic fetch unit is the OUTER shard. The single-tile min-zoom gate
 * (see {@link deriveMinZoom}) must judge that shard, not the sub-chunk —
 * otherwise a coarse global grid whose whole plane is one shard (e.g. CCIWR,
 * 360×720 in a single shard of 20×20 sub-chunks) is mis-gated to a high zoom
 * and never draws at world view. Pure (takes the parsed metadata) for testing. */
export function shardSpatialShape(meta: unknown): [number, number] | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as {
    codecs?: { name?: string }[];
    chunk_grid?: { configuration?: { chunk_shape?: number[] } };
  };
  const sharded =
    Array.isArray(m.codecs) &&
    m.codecs.some((c) => c?.name === "sharding_indexed");
  if (!sharded) return null;
  const outer = m.chunk_grid?.configuration?.chunk_shape;
  if (!Array.isArray(outer) || outer.length < 2) return null;
  const h = Number(outer[outer.length - 2]);
  const w = Number(outer[outer.length - 1]);
  return Number.isFinite(h) && Number.isFinite(w) ? [h, w] : null;
}

/** Max r32float Texture2DArray we'll build to scrub a bundled dim on the GPU.
 * A bundled dim whose frames exceed this stays a per-frame fetch instead. */
const TEXTURE_ARRAY_BUDGET_BYTES = 128 * 1e6;
/** WebGL2 guarantees at least 256 array-texture layers. */
const MAX_TEXTURE_LAYERS = 256;

/** Max bytes of the decoded chunk we'll keep resident to enable cheap
 * (slice + re-upload, no fetch/decode) scrubbing of fully-packed "memory" dims.
 * The chunk is fetched whole regardless; this only bounds how much we retain. */
const MEMORY_CHUNK_BUDGET_BYTES = 128 * 1e6;

/** Classify a variable's fully-packed non-spatial dims into the one GPU
 * texture-array dim (free shader-uniform scrub) and the "memory" dims.
 *
 * Shape-vs-chunks heuristic: a dim with `chunk > 1` is "free" to read in
 * bulk, so scrubbing it shouldn't cost a per-frame refetch. We require the dim
 * to be fully packed into a single chunk (`chunk === size`).
 *
 * - **textureDim**: the largest packed dim, loaded into an r32float
 *   Texture2DArray and scrubbed via a shader uniform. `window` is how many
 *   consecutive frames fit the texture budget (whole dim fits → fully free;
 *   else page-aligned windows, crossing a boundary re-uploads from cache). GFS
 *   `level`, SILAM `step`, ECMWF `lead_time`.
 * - **memoryDims**: the OTHER packed dims (e.g. ECMWF `ensemble_member`). They
 *   already ride along in every fetched chunk, so scrubbing one re-slices the
 *   cached chunk + re-uploads — no network, no decode. Admitted greedily
 *   (largest first) while the retained chunk stays within
 *   {@link MEMORY_CHUNK_BUDGET_BYTES}; any that don't fit stay genuinely pinned
 *   (re-read on change). Only populated when a textureDim exists (the
 *   texture-array render path is what holds the chunk). */
export function pickTextureDim(
  arr: zarr.Array<zarr.DataType, zarr.Readable>,
): {
  textureDim: { name: string; window: number } | null;
  memoryDims: { name: string; size: number }[];
} {
  const none = {
    textureDim: null,
    memoryDims: [] as { name: string; size: number }[],
  };
  const dims = arr.dimensionNames;
  if (!Array.isArray(dims)) return none;
  const tileH = arr.chunks[arr.chunks.length - 2] ?? 0;
  const tileW = arr.chunks[arr.chunks.length - 1] ?? 0;
  const frameBytes = tileW * tileH * 4;
  if (frameBytes <= 0) return none;
  // Most frames that fit the budget (and the WebGL layer cap).
  const maxFrames = Math.min(
    MAX_TEXTURE_LAYERS,
    Math.floor(TEXTURE_ARRAY_BUDGET_BYTES / frameBytes),
  );
  if (maxFrames < 2) return none; // can't even hold a useful window
  // Every fully-packed (chunk === size > 1) non-spatial dim is a candidate.
  const packed: { name: string; size: number }[] = [];
  for (let i = 0; i < dims.length - 2; i++) {
    const chunk = arr.chunks[i] ?? 1;
    const size = arr.shape[i] ?? 0;
    const name = dims[i];
    if (typeof name !== "string") continue;
    if (chunk <= 1 || chunk !== size) continue; // whole dim in one chunk
    packed.push({ name, size });
  }
  // Texture dim = the largest packed dim yielding a ≥2-frame window.
  let best: { name: string; size: number } | null = null;
  for (const p of packed) {
    if (Math.min(p.size, maxFrames) < 2) continue;
    if (!best || p.size > best.size) best = p;
  }
  if (!best) return none;
  const textureDim = { name: best.name, window: Math.min(best.size, maxFrames) };
  // Memory dims = the rest, admitted while the retained chunk fits the budget.
  const rawBytes = bytesPerElement(arr.dtype) || 4;
  const frameRaw = tileW * tileH * rawBytes;
  let chunkBytes = best.size * frameRaw; // texture dim is always held in full
  const memoryDims: { name: string; size: number }[] = [];
  for (const p of packed
    .filter((p) => p.name !== best!.name)
    .sort((a, b) => b.size - a.size)) {
    if (chunkBytes * p.size > MEMORY_CHUNK_BUDGET_BYTES) continue;
    memoryDims.push(p);
    chunkBytes *= p.size;
  }
  return { textureDim, memoryDims };
}

/** Enumerate renderable variables = arrays whose last two dims are a
 * recognized lat/lon pair and whose dtype is numeric. With consolidated
 * metadata this walks the whole hierarchy, so arrays nested in subgroups
 * (e.g. `RC/qtot`) are included; each variable records its parent `group` so
 * its sibling lat/lon and per-dim coord arrays resolve under that path. The
 * no-consolidated-metadata fallback probes a flat candidate list, so it stays
 * root-only (those names carry no `/`). */
export async function enumerateVariables(
  group: zarr.Group<zarr.Readable>,
  signal: AbortSignal,
  /** Opened arrays are cached here (keyed by name) so later opens — and the
   * per-variable resolveNode — reuse them instead of re-fetching `zarr.json`
   * (which matters for non-consolidated stores where every open is a fetch). */
  arrays: Map<string, zarr.Array<zarr.DataType, zarr.Readable>>,
): Promise<ScalarGridVariable[]> {
  const store = asConsolidated(group.store);
  // Consolidated metadata → list every node. No consolidated metadata (a plain
  // .zarr like FireSmoke can't be listed) → probe a candidate name list and
  // stop at the first hit (we can't list the others, and extra probe fetches
  // are slow/flaky over plain HTTP).
  const probing = !store;
  const paths = store
    ? store
        .contents()
        .filter((e) => e.kind === "array")
        .map((e) => e.path.replace(/^\/+/, ""))
    : CANDIDATE_VARIABLES;
  log.debug(
    probing
      ? `enumerate: no consolidated metadata, probing ${paths.length} candidate names`
      : `enumerate: ${paths.length} array node(s) from consolidated metadata`,
  );
  const out: ScalarGridVariable[] = [];
  for (const rest of paths) {
    if (signal.aborted) return out;
    if (!rest) continue;
    let arr: zarr.Array<zarr.DataType, zarr.Readable>;
    try {
      arr = await zarr.open.v3(group.resolve(rest), { kind: "array" });
    } catch {
      continue; // probed candidate doesn't exist in this store
    }
    if (!isNumericDtype(arr.dtype)) {
      log.debug(`enumerate: skip "${rest}" (non-numeric dtype ${arr.dtype})`);
      continue;
    }
    const pair = spatialPair(arr.dimensionNames);
    if (!pair) {
      log.debug(
        `enumerate: skip "${rest}" (no lat/lon pair in [${arr.dimensionNames?.join(",")}])`,
      );
      continue;
    }
    arrays.set(rest, arr);
    const dimNames = arr.dimensionNames!;
    const leading = dimNames.slice(0, dimNames.length - 2);
    const dims: ScalarGridDim[] = leading.map((name, i) => ({
      name: typeof name === "string" ? name : `dim${i}`,
      size: arr.shape[i] ?? 0,
    }));
    const attrs = arr.attrs;
    const slash = rest.lastIndexOf("/");
    const { textureDim, memoryDims } = pickTextureDim(arr);
    out.push({
      name: rest,
      group: slash < 0 ? "" : rest.slice(0, slash),
      longName: typeof attrs.long_name === "string" ? attrs.long_name : null,
      units: typeof attrs.units === "string" ? attrs.units : null,
      fillValue:
        typeof attrs._FillValue === "number"
          ? attrs._FillValue
          : typeof attrs.missing_value === "number"
            ? attrs.missing_value
            : typeof arr.fillValue === "number"
              ? arr.fillValue
              : null,
      scaleFactor:
        typeof attrs.scale_factor === "number" ? attrs.scale_factor : 1,
      addOffset: typeof attrs.add_offset === "number" ? attrs.add_offset : 0,
      dims,
      textureDim,
      memoryDims,
    });
    const v = out[out.length - 1]!;
    log.debug(`enumerate: variable "${rest}"`, {
      dtype: arr.dtype,
      shape: arr.shape,
      chunks: arr.chunks,
      fillValue: v.fillValue,
      scaleFactor: v.scaleFactor,
      addOffset: v.addOffset,
      textureDim: v.textureDim,
      memoryDims: v.memoryDims,
    });
    if (probing) break; // can't list further; one variable is enough
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  log.info(`enumerate: ${out.length} renderable variable(s)`);
  return out;
}

/** Resolve the longitude framing for a 1-D longitude coordinate array: the
 * affine origin/step to render with, and whether the tile loader must roll
 * columns. Pure (no I/O) so it can be unit-tested.
 *
 * Three conventions are handled:
 *  - **0..360** (e.g. GFS): `lon0 >= 0` and the extent reaches past +180.
 *    Reframed to -180..180 and the tile loader rolls each tile's columns by
 *    half-width to match (see {@link makeScalarGridTileLoader}).
 *  - **global -180..180** (e.g. ECMWF, GEOS, EEPS): a grid spanning ~360°.
 *  - **regional**: anything else — kept at its native origin/step.
 *
 * For any global grid the origin is pinned to exactly -180 AND the step to an
 * exact `360 / count`, so the extent is exactly [-180, 180]. This matters
 * because a global grid whose stored longitudes are low-precision (e.g. EEPS,
 * a 0.02° / 18000-cell grid) yields a `lon[1]-lon[0]` step that drifts by a
 * few cells over the full width — pushing the computed east edge past +180.
 * That antimeridian overshoot makes the raster→mercator reprojection mesh
 * diverge and nothing draws; snapping the step removes the overshoot. The
 * `isGlobal` tolerance is likewise generous (≥0.5°) to absorb that drift. */
export function resolveLonFrame(opts: {
  lon0: number;
  lon1: number;
  lonLast: number;
  count: number;
}): {
  originLon: number;
  stepLon: number;
  rollLongitude: boolean;
  isGlobal: boolean;
} {
  const { lon0, lon1, lonLast, count } = opts;
  const nativeStep = lon1 - lon0;
  const span = Math.abs(count * nativeStep);
  const isGlobal =
    Math.abs(span - 360) < Math.max(Math.abs(nativeStep) * 1.5, 0.5);
  const rollLongitude = lon0 >= 0 && lonLast > 180;
  const globalFrame = rollLongitude || isGlobal;
  return {
    originLon: globalFrame ? -180 : lon0,
    stepLon: globalFrame ? 360 / count : nativeStep,
    rollLongitude,
    isGlobal,
  };
}

/** Synthesize GeoZarr grid attrs from the 1-D lat/lon coordinate arrays
 * (named by the spatial dims). Mirrors the FireSmoke approach: the affine
 * origin is the first cell's coordinate, the step is the cell spacing
 * (negative for descending latitude). Longitude framing (0..360 roll, global
 * snap) is delegated to {@link resolveLonFrame}. */
async function synthesizeSpatialAttrs(
  group: zarr.Group<zarr.Readable>,
  groupPath: string,
  latName: string,
  lonName: string,
): Promise<{ attrs: ScalarGridSpatialAttrs; rollLongitude: boolean }> {
  // Coord arrays are siblings of the variable, i.e. under its subgroup path.
  const [latArr, lonArr] = await Promise.all([
    zarr.open.v3(group.resolve(joinPath(groupPath, latName)), { kind: "array" }),
    zarr.open.v3(group.resolve(joinPath(groupPath, lonName)), { kind: "array" }),
  ]);
  const [latChunk, lonChunk] = await Promise.all([
    zarr.get(latArr as zarr.Array<zarr.NumberDataType, zarr.Readable>),
    zarr.get(lonArr as zarr.Array<zarr.NumberDataType, zarr.Readable>),
  ]);
  const lat = latChunk.data as ArrayLike<number>;
  const lon = lonChunk.data as ArrayLike<number>;
  if (lat.length < 2 || lon.length < 2) {
    throw new Error(
      `ScalarGrid profile: coordinate arrays "${latName}"/"${lonName}" too short to derive a grid`,
    );
  }
  const stepLat = Number(lat[1]) - Number(lat[0]);
  const frame = resolveLonFrame({
    lon0: Number(lon[0]),
    lon1: Number(lon[1]),
    lonLast: Number(lon[lon.length - 1]),
    count: lon.length,
  });
  log.debug(`synthesized grid from ${latName}/${lonName}`, {
    latLen: lat.length,
    lonLen: lon.length,
    stepLat,
    originLon: frame.originLon,
    stepLon: frame.stepLon,
    rollLongitude: frame.rollLongitude,
    isGlobal: frame.isGlobal,
  });
  return {
    attrs: {
      "spatial:dimensions": [latName, lonName],
      "spatial:transform": [
        frame.stepLon,
        0,
        frame.originLon,
        0,
        stepLat,
        Number(lat[0]),
      ],
      "spatial:shape": [lat.length, lon.length],
      "proj:code": "EPSG:4326",
    },
    rollLongitude: frame.rollLongitude,
  };
}

/** Read store-native GeoZarr grid attrs (`spatial:transform` +
 * `spatial:dimensions`) from the root group, or null when absent. */
function readStoreNativeGrid(
  attrs: unknown,
): { transform: number[]; projCode: string } | null {
  if (typeof attrs !== "object" || attrs === null) return null;
  const a = attrs as Record<string, unknown>;
  const t = a["spatial:transform"];
  if (!Array.isArray(t) || t.length < 6) return null;
  if (!Array.isArray(a["spatial:dimensions"])) return null;
  if (!t.every((n) => typeof n === "number")) return null;
  const proj = typeof a["proj:code"] === "string" ? a["proj:code"] : "EPSG:4326";
  return { transform: t as number[], projCode: proj };
}

const EARTH_CIRCUMFERENCE_M = 40_075_017;

/** Per-axis screen px the render-zoom budget is sized for. 256 = one tile;
 * matches the legacy `nativeZoom − 2` cushion this gate replaces, so typical
 * stores reproduce their old min-zoom. */
const REF_AXIS_PX = 256;
/** Fetch budget for the lowest render zoom: a viewport fill must stay within
 * BOTH a byte budget (resolution × dtype — the bytes a zoom-out actually pulls)
 * AND a request-count budget (chunks the viewport straddles). Tuned so typical
 * stores land on the old resolution-only floor (FTW ~z12, 0.25° ~z1). */
const BUDGET_BYTES = 8_000_000;
const BUDGET_CHUNKS = 16;
const MAX_RENDER_ZOOM = 24;
/** A single-chunk-plane store (the spatial chunk spans the whole lat/lon
 * shape) is exactly one tile; zooming in never loads anything new. Render it at
 * world view when its *spatial* (displayed) plane is at most this many bytes.
 * ~256 MB admits EEPS-class global float16 grids (18000×6501×2 ≈ 234 MB) while
 * still deferring a single plane whose own spatial footprint is enormous
 * (e.g. a 50000² high-res chunk). Bundled non-spatial frames (a step/time axis
 * sharing the chunk) are excluded here — they load regardless of zoom, so a
 * coarse global grid like SILAM (0.2°/120-step) still renders at z0. */
const SINGLE_TILE_BYTE_BUDGET = 256 * 1e6;

/** Lowest web-mercator zoom to render at, modelling the data a zoom-out pulls.
 * The deck.gl-zarr layer reads single-resolution stores at full resolution,
 * one chunk per tile, fetching every chunk the viewport straddles — so zooming
 * out multiplies both bytes (more data pixels) and requests (more chunks).
 *
 * For each candidate zoom we estimate, over a {@link REF_AXIS_PX}-px reference
 * tile, the data pixels covered (`d`), the bytes (`d² · bytesPerEl` — the
 * zoom-fixable, resolution/dtype-driven cost), and the chunk requests
 * (`⌈d/chunkW⌉·⌈d/chunkH⌉` — the chunk-driven overfetch). The gate is the
 * lowest zoom satisfying both budgets.
 *
 * The per-zoom byte estimate is the *full atomic chunk*: spatial pixels ×
 * `bundledChunkEls` (the product of non-spatial chunk dims) × element size,
 * because a zarr chunk is fetched whole — a bundled `step`/`time` axis sharing
 * the spatial chunk is pulled per tile regardless of zoom. This matters for
 * multi-chunk-spatial stores, where zooming in genuinely reduces the chunk
 * count.
 *
 * **Single-chunk-plane special case** (when `shapeW`/`shapeH` are passed and the
 * spatial chunk spans the whole plane): the store is one tile, so zooming in
 * can't reduce the fetch — gating it is pure friction. We render it at world
 * view (z0) when its *spatial* footprint fits {@link SINGLE_TILE_BYTE_BUDGET},
 * deliberately ignoring bundled frames (only one shows at a time, and they load
 * regardless of zoom). So a coarse global grid like SILAM (0.2°/120-step,
 * spatial plane ≈3 MB) renders at z0; only a single plane whose own spatial
 * footprint is huge (e.g. a 50000² high-res chunk) falls through to the loop.
 *
 * Bytes are otherwise the *pure viewport* (not rounded up to whole chunks):
 * tiny chunks blow the request budget and gate up, where zoom can actually fix
 * the overfetch.
 *
 * Examples: FTW ~10 m/256-chunk/f32 → ~z12; 0.25° → ~z1; the same 10 m grid
 * with 64-px chunks → ~z14 (request-bound); int8 gates ~1 level looser than
 * float32 when bytes bind; EEPS 0.02°/whole-plane float16 → z0. */
export function deriveMinZoom(
  metersPerPx: number,
  chunkW: number,
  chunkH: number,
  bytesPerEl: number,
  /** Full spatial shape, when known. Enables the single-chunk-plane
   * short-circuit; omit to keep the pure per-zoom budget gate. */
  shapeW?: number,
  shapeH?: number,
  /** Product of the NON-spatial chunk dims (e.g. a bundled `step`/`time` axis
   * that shares the spatial chunk). Zarr chunks are atomic, so a tile read
   * pulls the whole chunk including these frames. Applied in the per-zoom loop
   * (multi-chunk-spatial stores) but NOT to the single-chunk-plane gate, where
   * zooming can't reduce the fetch anyway — see {@link SINGLE_TILE_BYTE_BUDGET}.
   * Defaults to 1 (a pure 2-D plane). */
  bundledChunkEls = 1,
): number {
  if (!(metersPerPx > 0)) return 0;
  if (
    shapeW != null &&
    shapeH != null &&
    chunkW >= shapeW &&
    chunkH >= shapeH &&
    // Judge the SPATIAL (displayed) footprint, NOT the bundled chunk size: a
    // coarse global grid is a fine world-view tile even if its chunk bundles
    // many step/time frames (only one frame shows at a time; bundled frames
    // load regardless of zoom, so gating on them just hides global data).
    chunkW * chunkH * bytesPerEl <= SINGLE_TILE_BYTE_BUDGET
  ) {
    return 0; // one global tile; zooming loads nothing new
  }
  const cw = chunkW > 0 ? chunkW : REF_AXIS_PX;
  const ch = chunkH > 0 ? chunkH : REF_AXIS_PX;
  const nativeZoom = Math.log2(EARTH_CIRCUMFERENCE_M / (metersPerPx * 256));
  for (let z = 0; z <= MAX_RENDER_ZOOM; z++) {
    const d = REF_AXIS_PX * 2 ** (nativeZoom - z); // data px per axis
    const requests = Math.ceil(d / cw) * Math.ceil(d / ch);
    // Each fetched chunk carries its full bundled (non-spatial) extent.
    const bytes = d * d * bundledChunkEls * bytesPerEl;
    if (bytes <= BUDGET_BYTES && requests <= BUDGET_CHUNKS) return z;
  }
  return MAX_RENDER_ZOOM;
}

function pickDefaultVariable(variables: ScalarGridVariable[]): string {
  for (const pref of PREFERRED_VARIABLES) {
    const hit = variables.find((v) => v.name === pref);
    if (hit) return hit.name;
  }
  return variables[0]!.name;
}

export const scalarGridProfile: ZarrProfile<ScalarGridState, ScalarGridContext> = {
  id: "scalar-grid",
  label: "Scalar grid (colormap)",
  needsColormap: true,

  getStructure: (ctx, state) => ({
    zarrVersion: "v3",
    variables: [{ path: state.variable }],
    metadataSource: ctx.metadataSource,
    metadata: ctx.spatialAttrs,
  }),

  async prepare(url, signal) {
    const done = log.time("scalar-grid prepare", "info");
    let opened: OpenedStore;
    try {
      opened = await openV3Group(url, { consolidated: true });
    } catch (openErr) {
      // v3 open failed. OME-Zarr v0.4 (Zarr v2) has no root zarr.json, so this
      // is where v0.4 bioimaging lands. Retry a metadata-only auto-version open
      // just to read root attrs; if OME markers are present, redirect.
      // Otherwise rethrow the original v3 error (don't mask genuine failures).
      // This extra open runs ONLY after the v3 open already failed — the
      // geographic v3 fast path pays nothing.
      try {
        const probe = await openV3Group(url, {
          consolidated: false,
          version: "auto",
        });
        if (isOmeZarrAttrs(probe.group.attrs)) throw new OmeZarrStoreError();
      } catch (probeErr) {
        if (probeErr instanceof OmeZarrStoreError) throw probeErr;
        // auto-open also failed (genuinely broken / not zarr) — fall through.
      }
      throw openErr;
    }
    // OME-Zarr image store → image-orthographic. MUST precede the multiscale
    // check: OME v0.4 roots carry `multiscales` with `datasets` AND `axes`,
    // which parseMultiscaleDatasets would otherwise mis-route to multiscale-grid.
    if (isOmeZarrAttrs(opened.group.attrs)) throw new OmeZarrStoreError();
    // A multiscale pyramid needs the multiscale-grid profile; signal the
    // chassis to switch (cheaper than probing the store up front on every load).
    if (parseMultiscaleDatasets(opened.group.attrs)) throw new MultiscaleStoreError();
    const arrays = new Map<string, zarr.Array<zarr.DataType, zarr.Readable>>();
    const variables = await enumerateVariables(opened.group, signal, arrays);
    if (variables.length === 0) {
      throw new Error(
        "No regular lat/lon gridded variables found. This store may use an " +
          "unstructured mesh (e.g. ICON's `values` dimension) or a projected " +
          "grid, which this viewer can't render.",
      );
    }
    const first = variables[0]!;
    const firstArr = arrays.get(first.name)!;
    const pair = spatialPair(firstArr.dimensionNames)!;

    // Grid: prefer the store's own GeoZarr attrs (e.g. FTW/AEF); else
    // synthesize from the lat/lon coord arrays (e.g. ECMWF/icechunk grids).
    const native = readStoreNativeGrid(opened.group.attrs);
    let spatialAttrs: unknown;
    let rollLongitude = false;
    let metadataSource: "store-native" | "synthesized";
    let degPerPxLon: number;
    let projCode: string;
    if (native) {
      spatialAttrs = opened.group.attrs;
      metadataSource = "store-native";
      degPerPxLon = Math.abs(native.transform[0]!);
      projCode = native.projCode;
    } else {
      const syn = await synthesizeSpatialAttrs(
        opened.group,
        first.group,
        pair.lat,
        pair.lon,
      );
      spatialAttrs = syn.attrs;
      rollLongitude = syn.rollLongitude;
      metadataSource = "synthesized";
      degPerPxLon = Math.abs(syn.attrs["spatial:transform"][0]);
      projCode = "EPSG:4326";
    }
    const metersPerPx = /4326/.test(projCode)
      ? degPerPxLon * (EARTH_CIRCUMFERENCE_M / 360)
      : degPerPxLon; // projected transforms are already in metres
    const nd = firstArr.chunks.length;
    const innerH = firstArr.chunks[nd - 2] ?? REF_AXIS_PX;
    const innerW = firstArr.chunks[nd - 1] ?? REF_AXIS_PX;
    const shapeH = firstArr.shape[nd - 2] ?? 0;
    const shapeW = firstArr.shape[nd - 1] ?? 0;
    // For a sharded array, prefer the OUTER shard spatial shape for the
    // min-zoom gate, but only when that shard spans the whole plane — then the
    // store is effectively one tile and should render at z0 (the per-zoom
    // budget loop never runs). Multi-shard stores (AEF/FTW) keep the inner
    // sub-chunk, preserving their resolution-based gate. Falls back to the
    // inner chunk on any read/parse failure.
    let chunkH = innerH;
    let chunkW = innerW;
    try {
      const raw = await opened.store.get(
        `/${first.name}/zarr.json` as `/${string}`,
      );
      const shard = raw
        ? shardSpatialShape(JSON.parse(new TextDecoder().decode(raw)))
        : null;
      if (shard && shard[0] >= shapeH && shard[1] >= shapeW) {
        [chunkH, chunkW] = shard;
      }
    } catch {
      // keep inner chunk
    }
    // Non-spatial chunk dims share the (atomic) spatial chunk, so a tile read
    // pulls them too — e.g. SILAM bundles 120 `step` frames per chunk.
    const bundledChunkEls = firstArr.chunks
      .slice(0, nd - 2)
      .reduce((a, b) => a * b, 1);
    const minRenderZoom = deriveMinZoom(
      metersPerPx,
      chunkW,
      chunkH,
      bytesPerElement(firstArr.dtype),
      shapeW,
      shapeH,
      bundledChunkEls,
    );
    log.info(
      `prepared "${first.name}" ${firstArr.dtype} [${firstArr.shape.join(",")}] ` +
        `${metadataSource}, metersPerPx=${Math.round(metersPerPx)}, minRenderZoom=${minRenderZoom}`,
    );
    log.debug("prepare detail", {
      variables: variables.length,
      chunks: firstArr.chunks,
      bundledChunkEls,
      rollLongitude,
      projCode,
      textureDim: first.textureDim,
    });

    // CF labels for every non-spatial dim (dates / durations / index). The
    // map is keyed by the BARE dim name (state/UI use bare names), but each
    // dim's coord array is resolved from a subgroup that actually holds it —
    // assuming identically-named dims across subgroups share values (true for
    // nested stores like CCIWR, whose subgroups duplicate the coord arrays).
    const dimMeta = new Map<string, { size: number; group: string }>();
    for (const v of variables)
      for (const d of v.dims)
        if (!dimMeta.has(d.name))
          dimMeta.set(d.name, { size: d.size, group: v.group });
    const dimLabel: Record<string, (idx: number) => string> = {};
    for (const [name, { size, group }] of dimMeta) {
      if (signal.aborted) break;
      dimLabel[name] = await buildDimLabel(
        opened.group,
        joinPath(group, name),
        size,
      );
    }

    done();
    return {
      url,
      group: opened.group,
      store: opened.store,
      variables,
      arrays,
      spatialAttrs,
      metadataSource,
      rollLongitude,
      minRenderZoom,
      dimLabel,
    };
  },

  initialState(ctx) {
    const variable = pickDefaultVariable(ctx.variables);
    const v = ctx.variables.find((x) => x.name === variable)!;
    return { variable, dimIndices: defaultDimIndices(v) };
  },

  parseUrlParams(p) {
    const out: Partial<ScalarGridState> = {};
    const v = p.get("var");
    if (v) out.variable = v;
    // Dim indices are serialized as `dim.<name>=<index>`.
    const dimIndices: Record<string, number> = {};
    for (const [key, value] of p.entries()) {
      if (!key.startsWith("dim.")) continue;
      const n = Number(value);
      if (Number.isFinite(n)) dimIndices[key.slice(4)] = n;
    }
    if (Object.keys(dimIndices).length > 0) out.dimIndices = dimIndices;
    return out;
  },

  serializeUrlParams(s) {
    const out: Record<string, string | null> = { var: s.variable };
    for (const [name, idx] of Object.entries(s.dimIndices)) {
      out[`dim.${name}`] = String(idx);
    }
    return out;
  },

  initialBounds: () => [-180, -90, 180, 90],

  Controls: ScalarGridControls,

  async resolveNode(ctx, state) {
    // Reuse the array opened during enumeration (no re-fetch); only open if
    // somehow missing.
    const cached = ctx.arrays.get(state.variable);
    if (cached) return cached;
    const arr = await zarr.open.v3(ctx.group.resolve(state.variable), {
      kind: "array",
    });
    ctx.arrays.set(state.variable, arr);
    return arr;
  },
  // resolveNode opens the variable array — only the variable name affects it.
  resolveNodeDeps: (state) => [state.variable],
  statsDeps: (state) => [state.variable],

  buildLayer({
    ctx,
    state,
    chassisState,
    colormapTexture,
    autoStats,
    basemapBeforeId,
    node,
  }) {
    if (!node || !colormapTexture) return null;
    const variableMeta = ctx.variables.find((v) => v.name === state.variable);
    if (!variableMeta) return null;
    const arr = node as zarr.Array<zarr.DataType, zarr.Readable>;
    const texDim = variableMeta.textureDim;
    // Fully-packed dims that ride along in the decoded chunk: scrubbing them
    // re-slices the cached chunk instead of re-reading (see makeTextureArrayTileLoader).
    const memNames = new Set(variableMeta.memoryDims.map((d) => d.name));

    // For the texture-array dim, decode ALL frames once (cached on the CPU) and
    // upload a page-aligned window of `window` frames to the GPU. Scrubbing
    // within the window is a free shader uniform (`frameIndex`); crossing a
    // window changes `windowStart` (in the layer id) and re-uploads from the
    // cache (no re-decompress).
    let frameIndex = 0;
    let windowStart = 0;
    let windowLen = 0;
    if (texDim) {
      const size =
        variableMeta.dims.find((d) => d.name === texDim.name)?.size ??
        texDim.window;
      const idx = state.dimIndices[texDim.name] ?? 0;
      windowStart = Math.floor(idx / texDim.window) * texDim.window;
      windowLen = Math.min(texDim.window, size - windowStart);
      frameIndex = idx - windowStart;
    }

    // Pin every genuinely-pinned non-spatial dim to its selected index. The
    // texture dim AND the fully-packed memory dims are left as full slices
    // (`null`) so the whole chunk is decoded once and cached; the memory dims
    // are then sliced from that cache in-memory (no re-fetch) per selection.
    const selection: Record<string, number | null> = {};
    for (const dim of variableMeta.dims) {
      selection[dim.name] =
        (texDim && dim.name === texDim.name) || memNames.has(dim.name)
          ? null
          : (state.dimIndices[dim.name] ?? 0);
    }
    // Slice descriptor for the loader: among the full-sliced leading axes
    // (texture dim + memory dims, in array order), which is the texture axis and
    // what are the memory dims' current indices.
    const survivors = variableMeta.dims.filter(
      (d) => (texDim && d.name === texDim.name) || memNames.has(d.name),
    );
    const leading = texDim
      ? {
          texAxis: survivors.findIndex((d) => d.name === texDim.name),
          memoryIndices: survivors.map((d) =>
            d.name === texDim.name ? 0 : (state.dimIndices[d.name] ?? 0),
          ),
        }
      : undefined;
    // Layer id = variable + fetched (pinned) dim indices, plus the texture
    // dim's *window start* (not its scrub index — that's a free uniform).
    const fetchedDims = Object.fromEntries(
      Object.entries(state.dimIndices).filter(([k]) => k !== texDim?.name),
    );
    if (texDim) fetchedDims[`${texDim.name}@win`] = windowStart;
    const pinnedKey = serializeDims(fetchedDims);
    // Cache the decoded chunk by variable + the genuinely-pinned dims; the
    // texture window start AND the memory-dim indices are NOT part of the key,
    // so changing them is a cache hit (re-slice/re-upload, no re-decode). The
    // same key identifies the tiles registered for the hover tooltip.
    const sampleKey = sampleKeyFor(state, variableMeta);
    const chunkKey = sampleKey;
    const common = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      node: arr as any,
      metadata: ctx.spatialAttrs,
      selection,
      tileSize: spatialTileSize(arr),
      minZoom: ctx.minRenderZoom,
      // Required (with the getTileIndices patch) to keep already-loaded tiles
      // painted below minZoom: a non-null extent disables TileLayer's own
      // below-minZoom hide gate. See keep-min-zoom-tiles.ts.
      extent: KEEP_MIN_ZOOM_EXTENT,
      maxRequests: 20,
      maxCacheSize: 10,
      opacity: chassisState.opacity,
      // beforeId is injected by @deck.gl/mapbox; ZarrLayerProps doesn't
      // expose it, so attach via a wider cast.
      ...({ beforeId: basemapBeforeId } as Record<string, unknown>),
    };

    if (texDim) {
      const renderTile = buildTextureArrayRenderTile(
        {
          frameIndex,
          colormap: chassisState.colormap ?? "viridis",
          rescale: chassisState.rescale,
          gamma: chassisState.gamma,
          stretch: chassisState.stretch,
        },
        colormapTexture,
        autoStats,
      );
      return new ZarrLayer<zarr.Readable, zarr.DataType, TextureArrayTileData>({
        ...common,
        id: `scalar-grid-${state.variable}-${pinnedKey}`,
        getTileData: makeTextureArrayTileLoader({
          fillValue: variableMeta.fillValue,
          scaleFactor: variableMeta.scaleFactor,
          addOffset: variableMeta.addOffset,
          rollLongitude: ctx.rollLongitude,
          window: { start: windowStart, len: windowLen },
          chunkKey,
          sampleKey,
          leading,
        }),
        renderTile,
        updateTriggers: {
          renderTile: [
            frameIndex,
            chassisState.colormap,
            chassisState.rescale?.[0],
            chassisState.rescale?.[1],
            chassisState.gamma,
            chassisState.stretch,
            autoStats,
          ],
        },
      });
    }

    const renderTile = buildSingleBandRenderTile(
      {
        colormap: chassisState.colormap ?? "viridis",
        rescale: chassisState.rescale,
        gamma: chassisState.gamma,
        stretch: chassisState.stretch,
        nodata: null,
      },
      colormapTexture,
      autoStats,
    );
    return new ZarrLayer<zarr.Readable, zarr.DataType, MultiBandTileData>({
      ...common,
      id: `scalar-grid-${state.variable}-${pinnedKey}`,
      getTileData: makeScalarGridTileLoader({
        fillValue: variableMeta.fillValue,
        scaleFactor: variableMeta.scaleFactor,
        addOffset: variableMeta.addOffset,
        rollLongitude: ctx.rollLongitude,
        sampleKey,
      }),
      renderTile,
      updateTriggers: {
        renderTile: [
          chassisState.colormap,
          chassisState.rescale?.[0],
          chassisState.rescale?.[1],
          chassisState.gamma,
          chassisState.stretch,
          autoStats,
        ],
      },
    });
  },

  sampleValue(ctx, state, lng, lat) {
    const variableMeta = ctx.variables.find((v) => v.name === state.variable);
    if (!variableMeta) return null;
    const attrs = ctx.spatialAttrs as ScalarGridSpatialAttrs;
    const t = attrs?.["spatial:transform"];
    const shape = attrs?.["spatial:shape"];
    if (!Array.isArray(t) || !Array.isArray(shape)) return null;
    const [stepLon, , originLon, , stepLat, originLat] = t;
    const [height, width] = shape;
    if (!stepLon || !stepLat) return null;
    // Invert the affine. Both render paths read in the same -180..180 logical
    // frame (the texture-array tile re-rolls internally), so one inversion
    // serves both. Wrap lng into [-180, 180) so hovering a repeated world copy
    // (maplibre renders several) still resolves on global grids.
    //
    // `floor`, not `round`: deck places the affine origin at the pixel *corner*
    // (it spans array index [0, W]×[0, H], so texel i covers index [i, i+1)).
    // Flooring the fractional index picks the texel actually drawn under the
    // cursor; rounding would snap to cell centers — a half-cell offset.
    const wrappedLng = ((((lng + 180) % 360) + 360) % 360) - 180;
    const col = Math.floor((wrappedLng - originLon) / stepLon);
    const row = Math.floor((lat - originLat) / stepLat);
    if (row < 0 || row >= height || col < 0 || col >= width) return null;
    const frame = variableMeta.textureDim
      ? (state.dimIndices[variableMeta.textureDim.name] ?? 0)
      : 0;
    const value = readSampleValue(sampleKeyFor(state, variableMeta), row, col, frame);
    if (value === null) return null; // no tile loaded here → hide
    return {
      label: variableMeta.longName ?? variableMeta.name,
      value: Number.isNaN(value) ? null : value,
      units: variableMeta.units,
    };
  },

  async computeAutoStats({ ctx, state, signal }) {
    const variableMeta = ctx.variables.find((v) => v.name === state.variable);
    if (!variableMeta) return null;
    const arr =
      ctx.arrays.get(state.variable) ??
      (await zarr.open.v3(ctx.group.resolve(state.variable), {
        kind: "array",
      }));
    if (signal.aborted) return null;
    // Sample a central patch sized to the spatial chunk — for coarse grids
    // that's the whole plane (one chunk); for high-res sharded grids (FTW) it
    // bounds the read to ~one shard instead of the entire world. A texture-array
    // dim is sliced in full so the rescale stays stable across frames.
    const nd = arr.shape.length;
    const latSize = arr.shape[nd - 2] ?? 0;
    const lonSize = arr.shape[nd - 1] ?? 0;
    const patchH = Math.min(arr.chunks[nd - 2] ?? latSize, latSize);
    const patchW = Math.min(arr.chunks[nd - 1] ?? lonSize, lonSize);
    const latStart = Math.max(0, Math.floor((latSize - patchH) / 2));
    const lonStart = Math.max(0, Math.floor((lonSize - patchW) / 2));
    const sliceSpec: (number | zarr.Slice | null)[] = [
      ...variableMeta.dims.map((d) =>
        d.name === variableMeta.textureDim?.name
          ? null
          : (state.dimIndices[d.name] ?? 0),
      ),
      zarr.slice(latStart, latStart + patchH),
      zarr.slice(lonStart, lonStart + patchW),
    ];
    const chunk = await zarr.get(
      arr as zarr.Array<zarr.NumberDataType, zarr.Readable>,
      sliceSpec,
      { signal },
    );
    if (signal.aborted) return null;
    const fill =
      variableMeta.fillValue !== null &&
      Number.isFinite(variableMeta.fillValue) &&
      variableMeta.fillValue !== 0
        ? variableMeta.fillValue
        : null;
    // CF-decode to physical units so the auto rescale matches the rendered
    // (decoded) texture; fill → NaN, which buildBandStats skips.
    const raw = chunk.data as ArrayLike<number>;
    const decoded = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      const v = Number(raw[i]);
      decoded[i] =
        fill !== null && v === fill
          ? Number.NaN
          : v * variableMeta.scaleFactor + variableMeta.addOffset;
    }
    const stats = buildBandStats(decoded, null);
    if (!stats) return null;
    return autoStatsFromGlobal(stats);
  },
};

/** Stable string key for a dim-index map (order-independent), used in layer
 * ids and resolve/stat deps. */
function serializeDims(dimIndices: Record<string, number>): string {
  return Object.keys(dimIndices)
    .sort()
    .map((k) => `${k}=${dimIndices[k]}`)
    .join(",");
}

/** Identity of the decoded chunk for the current selection, EXCLUDING the
 * texture/scrub frame AND the fully-packed memory dims (one cached chunk holds
 * every frame of all of them). Computed identically in `buildLayer` (cache /
 * sample-tile key) and `sampleValue` (read) so they always agree. Equals the
 * texture path's `chunkKey`, so changing a memory dim is a cache hit. */
function sampleKeyFor(
  state: ScalarGridState,
  variable: ScalarGridVariable,
): string {
  const packed = new Set<string>(variable.memoryDims.map((d) => d.name));
  if (variable.textureDim) packed.add(variable.textureDim.name);
  const pinned = Object.fromEntries(
    Object.entries(state.dimIndices).filter(([k]) => !packed.has(k)),
  );
  return `${state.variable}|${serializeDims(pinned)}`;
}
