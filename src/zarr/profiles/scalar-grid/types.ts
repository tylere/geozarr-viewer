import type * as zarr from "zarrita";
import type { ProfileBaseContext } from "../../profile";

/** A non-spatial (leading) dimension of a variable — gets a slider. */
export type ScalarGridDim = {
  name: string;
  size: number;
};

/** A renderable data variable: an array whose last two dims are a
 * recognized lat/lon spatial pair. */
export type ScalarGridVariable = {
  name: string;
  longName: string | null;
  units: string | null;
  /** Numeric fill value if present (used as nodata when non-zero). */
  fillValue: number | null;
  /** CF packing: decoded value = raw * scaleFactor + addOffset (defaults
   * 1 / 0). Lets packed stores (e.g. int16 ×0.1) render in physical units. */
  scaleFactor: number;
  addOffset: number;
  /** Leading non-spatial dims (everything before the spatial pair), in
   * order. Drives the per-dim sliders. */
  dims: ScalarGridDim[];
  /** The non-spatial dim loaded into a GPU texture array (or null). `window`
   * is how many consecutive frames are loaded per read (the most that fit the
   * texture budget): when it covers the whole dim, scrubbing is fully free;
   * otherwise windows are page-aligned and only crossing a boundary refetches.
   * Either way, scrubbing within the loaded window is a free shader uniform. */
  textureDim: { name: string; window: number } | null;
};

/** Synthesized GeoZarr attrs describing the (regular) lat/lon grid. */
export type ScalarGridSpatialAttrs = {
  "spatial:dimensions": [string, string];
  "spatial:transform": [number, number, number, number, number, number];
  "spatial:shape": [number, number];
  "proj:code": "EPSG:4326";
};

export type ScalarGridContext = ProfileBaseContext & {
  store: zarr.Readable;
  variables: ScalarGridVariable[];
  /** Opened variable arrays cached by name (avoids re-fetching `zarr.json`
   * for non-consolidated stores on every resolveNode). */
  arrays: Map<string, zarr.Array<zarr.DataType, zarr.Readable>>;
  /** Grid attrs passed to `ZarrLayer.metadata` — the store's own GeoZarr
   * attrs when present, else synthesized from the lat/lon coord arrays. */
  spatialAttrs: ScalarGridSpatialAttrs | unknown;
  /** Where {@link spatialAttrs} came from (drives the Structure panel). */
  metadataSource: "store-native" | "synthesized";
  /** True when the store's longitude runs 0..360 (e.g. GFS). The synthesized
   * transform is shifted to -180..180 and the tile loader rolls each tile's
   * columns by half-width to match. (Always false for store-native grids.) */
  rollLongitude: boolean;
  /** Lowest map zoom the layer renders at, derived from the grid resolution
   * (high-res grids like FTW would otherwise pull huge data when zoomed out). */
  minRenderZoom: number;
  /** Per-dim label formatter (`idx → string`), decoded from each coord
   * array's CF `units`/`calendar` (dates / durations / index fallback). */
  dimLabel: Record<string, (idx: number) => string>;
};

export type ScalarGridState = {
  variable: string;
  /** Selected index per non-spatial dim name (e.g. `{ time: 5, level: 0 }`). */
  dimIndices: Record<string, number>;
};

/** Default index per non-spatial dim: most-recent for time-like dims, 0 for
 * the rest. Shared by `initialState` and the variable-switch handler so a
 * new variable lands on a sensible frame. */
export function defaultDimIndices(
  variable: ScalarGridVariable,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const dim of variable.dims) {
    out[dim.name] = /time/i.test(dim.name) ? Math.max(0, dim.size - 1) : 0;
  }
  return out;
}
