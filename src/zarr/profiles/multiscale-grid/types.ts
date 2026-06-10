import type * as zarr from "zarrita";
import type { GeoZarrMetadata } from "../../multiscale";
import type { ProfileBaseContext } from "../../profile";

export type MultiscaleGridContext = ProfileBaseContext & {
  store: zarr.Readable;
  /** GeoZarr `metadata` override handed to `ZarrLayer` (multiscale + CRS). */
  metadata: GeoZarrMetadata;
  /** Data dtype of the `<scale>/chm` arrays (e.g. "uint8"). */
  dtype: string;
  units: string | null;
  longName: string | null;
  /** Display name of the rendered variable (e.g. "chm"). */
  variable: string;
  /** Number of pyramid levels. */
  levelCount: number;
  /** Native (finest) pixel size in metres. */
  finestPixelMeters: number;
  /** `proj:code` from the store's `spatial_ref`, if present (display only). */
  crsCode: string | null;
  /** Coarsest level's data array + its GDAL GeoTransform — used to sample a
   * representative patch for the auto-rescale. */
  coarsestArray: zarr.Array<zarr.DataType, zarr.Readable>;
  coarsestGeoTransform: readonly number[];
  /** Path of the finest array (primary for the Structure panel). */
  primaryPath: string;
};

/** No per-store selectors for v1 (single 2-D `chm` variable). */
export type MultiscaleGridState = Record<string, never>;
