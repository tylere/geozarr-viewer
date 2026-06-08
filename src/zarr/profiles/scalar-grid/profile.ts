import { ZarrLayer } from "@developmentseed/deck.gl-zarr";
import * as zarr from "zarrita";
import {
  autoStatsFromGlobal,
  buildBandStats,
} from "../../../render/stats";
import { buildSingleBandRenderTile } from "../../../render/single-band-pipeline";
import type { MultiBandTileData } from "../../../render/shared-textures";
import {
  buildTextureArrayRenderTile,
  makeTextureArrayTileLoader,
  type TextureArrayTileData,
} from "../../../render/texture-array-pipeline";
import { spatialTileSize } from "../../chunk-size";
import { asConsolidated, openV3Group } from "../../load-zarr";
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

/** Max r32float Texture2DArray we'll build to scrub a bundled dim on the GPU.
 * A bundled dim whose frames exceed this stays a per-frame fetch instead. */
const TEXTURE_ARRAY_BUDGET_BYTES = 128 * 1e6;
/** WebGL2 guarantees at least 256 array-texture layers. */
const MAX_TEXTURE_LAYERS = 256;

/** Pick the non-spatial dim to load into a GPU texture array, or null.
 *
 * Shape-vs-chunks heuristic: a dim with `chunk > 1` is "free" to read in
 * bulk, so scrubbing it shouldn't cost a per-frame refetch. We require the dim
 * to be fully packed into a single chunk (`chunk === size`), then load as many
 * consecutive frames as the texture budget allows — the **window**. If the
 * whole dim fits (e.g. GFS `level`, 13 frames), scrubbing is fully free; if not
 * (e.g. SILAM `step`, 120 frames → a ~19-frame window), the window is
 * page-aligned and only crossing a boundary refetches. Among candidates, prefer
 * the dim with the most frames (most to amortize). */
function pickTextureDim(
  arr: zarr.Array<zarr.DataType, zarr.Readable>,
): { name: string; window: number } | null {
  const dims = arr.dimensionNames;
  if (!Array.isArray(dims)) return null;
  const tileH = arr.chunks[arr.chunks.length - 2] ?? 0;
  const tileW = arr.chunks[arr.chunks.length - 1] ?? 0;
  const frameBytes = tileW * tileH * 4;
  if (frameBytes <= 0) return null;
  // Most frames that fit the budget (and the WebGL layer cap).
  const maxFrames = Math.min(
    MAX_TEXTURE_LAYERS,
    Math.floor(TEXTURE_ARRAY_BUDGET_BYTES / frameBytes),
  );
  if (maxFrames < 2) return null; // can't even hold a useful window
  let best: { name: string; window: number; size: number } | null = null;
  for (let i = 0; i < dims.length - 2; i++) {
    const chunk = arr.chunks[i] ?? 1;
    const size = arr.shape[i] ?? 0;
    const name = dims[i];
    if (typeof name !== "string") continue;
    if (chunk <= 1 || chunk !== size) continue; // whole dim in one chunk
    const window = Math.min(size, maxFrames);
    if (window < 2) continue;
    if (!best || size > best.size) best = { name, window, size };
  }
  return best ? { name: best.name, window: best.window } : null;
}

/** Enumerate renderable variables = top-level arrays whose last two dims are
 * a recognized lat/lon pair and whose dtype is numeric. */
async function enumerateVariables(
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
  const out: ScalarGridVariable[] = [];
  for (const rest of paths) {
    if (signal.aborted) return out;
    if (!rest || rest.includes("/")) continue; // top-level only
    let arr: zarr.Array<zarr.DataType, zarr.Readable>;
    try {
      arr = await zarr.open.v3(group.resolve(rest), { kind: "array" });
    } catch {
      continue; // probed candidate doesn't exist in this store
    }
    if (!isNumericDtype(arr.dtype)) continue;
    const pair = spatialPair(arr.dimensionNames);
    if (!pair) continue;
    arrays.set(rest, arr);
    const dimNames = arr.dimensionNames!;
    const leading = dimNames.slice(0, dimNames.length - 2);
    const dims: ScalarGridDim[] = leading.map((name, i) => ({
      name: typeof name === "string" ? name : `dim${i}`,
      size: arr.shape[i] ?? 0,
    }));
    const attrs = arr.attrs;
    out.push({
      name: rest,
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
      textureDim: pickTextureDim(arr),
    });
    if (probing) break; // can't list further; one variable is enough
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Synthesize GeoZarr grid attrs from the 1-D lat/lon coordinate arrays
 * (named by the spatial dims). Mirrors the FireSmoke approach: the affine
 * origin is the first cell's coordinate, the step is the cell spacing
 * (negative for descending latitude).
 *
 * Detects a 0..360 longitude convention (first cell >= 0, last cell > 180,
 * e.g. GFS) and, for it, shifts the transform origin to the -180..180 frame
 * so the basemap places the data correctly — the tile loader then rolls each
 * tile's columns by half-width to match (see {@link makeScalarGridTileLoader}). */
async function synthesizeSpatialAttrs(
  group: zarr.Group<zarr.Readable>,
  latName: string,
  lonName: string,
): Promise<{ attrs: ScalarGridSpatialAttrs; rollLongitude: boolean }> {
  const [latArr, lonArr] = await Promise.all([
    zarr.open.v3(group.resolve(latName), { kind: "array" }),
    zarr.open.v3(group.resolve(lonName), { kind: "array" }),
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
  const stepLon = Number(lon[1]) - Number(lon[0]);
  const lon0 = Number(lon[0]);
  const lonLast = Number(lon[lon.length - 1]);
  const span = Math.abs(lon.length * stepLon);
  // A grid whose longitude spans ~360° is global. Some (e.g. SILAM) are
  // offset so their east edge pokes past +180; that antimeridian crossing
  // makes the raster→mercator reprojection mesh diverge and nothing draws.
  const isGlobal = Math.abs(span - 360) < Math.abs(stepLon) * 1.5;
  // 0..360 convention (e.g. GFS): origin >= 0 and extent past 180 — rolled
  // into the -180..180 frame by the tile loader.
  const rollLongitude = lon0 >= 0 && lonLast > 180;
  // For any global grid, snap the origin to exactly -180 so the extent is
  // [-180, 180] and the reprojection converges (sub-cell shift; no-op for a
  // grid already starting at -180 like GEOS). Regional grids keep lon[0].
  const originLon = rollLongitude || isGlobal ? -180 : lon0;
  return {
    attrs: {
      "spatial:dimensions": [latName, lonName],
      "spatial:transform": [stepLon, 0, originLon, 0, stepLat, Number(lat[0])],
      "spatial:shape": [lat.length, lon.length],
      "proj:code": "EPSG:4326",
    },
    rollLongitude,
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

/** Lowest web-mercator zoom to render at, from the grid's pixel size: two
 * levels below the data's native zoom (where 1 data px ≈ 1 tile px). High-res
 * grids (FTW ~10 m → ~z12) gate; coarse grids (≥0.2° → ~z0–1) don't. */
function deriveMinZoom(metersPerPx: number): number {
  if (!(metersPerPx > 0)) return 0;
  const nativeZoom = Math.log2(EARTH_CIRCUMFERENCE_M / (metersPerPx * 256));
  return Math.max(0, Math.ceil(nativeZoom) - 2);
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
    const opened = await openV3Group(url, { consolidated: true });
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
      const syn = await synthesizeSpatialAttrs(opened.group, pair.lat, pair.lon);
      spatialAttrs = syn.attrs;
      rollLongitude = syn.rollLongitude;
      metadataSource = "synthesized";
      degPerPxLon = Math.abs(syn.attrs["spatial:transform"][0]);
      projCode = "EPSG:4326";
    }
    const metersPerPx = /4326/.test(projCode)
      ? degPerPxLon * (EARTH_CIRCUMFERENCE_M / 360)
      : degPerPxLon; // projected transforms are already in metres
    const minRenderZoom = deriveMinZoom(metersPerPx);

    // CF labels for every non-spatial dim (dates / durations / index).
    const dimSize = new Map<string, number>();
    for (const v of variables)
      for (const d of v.dims) dimSize.set(d.name, d.size);
    const dimLabel: Record<string, (idx: number) => string> = {};
    for (const [name, size] of dimSize) {
      if (signal.aborted) break;
      dimLabel[name] = await buildDimLabel(opened.group, name, size);
    }

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

    // Pin every non-spatial dim to its selected index. The texture dim is left
    // as a full slice (`null`) so the whole chunk is decoded once for the cache.
    const selection: Record<string, number | null> = {};
    for (const dim of variableMeta.dims) {
      selection[dim.name] =
        texDim && dim.name === texDim.name
          ? null
          : (state.dimIndices[dim.name] ?? 0);
    }
    // Layer id = variable + fetched (pinned) dim indices, plus the texture
    // dim's *window start* (not its scrub index — that's a free uniform).
    const fetchedDims = Object.fromEntries(
      Object.entries(state.dimIndices).filter(([k]) => k !== texDim?.name),
    );
    if (texDim) fetchedDims[`${texDim.name}@win`] = windowStart;
    const pinnedKey = serializeDims(fetchedDims);
    // Cache the decoded chunk by variable + the pinned (non-texture) dims; the
    // window start is NOT part of the key, so every window shares one decode.
    const chunkKey = `${state.variable}|${serializeDims(
      Object.fromEntries(
        Object.entries(state.dimIndices).filter(([k]) => k !== texDim?.name),
      ),
    )}`;
    const common = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      node: arr as any,
      metadata: ctx.spatialAttrs,
      selection,
      tileSize: spatialTileSize(arr),
      minZoom: ctx.minRenderZoom,
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
