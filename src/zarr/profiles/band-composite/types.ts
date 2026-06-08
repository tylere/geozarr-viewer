import type * as zarr from "zarrita";
import type { ProfileBaseContext } from "../../profile";

export type BandCompositeContext = ProfileBaseContext & {
  /** Name of the renderable multi-band variable. */
  variable: string;
  /** Pre-opened band array (int8). */
  embeddings: zarr.Array<"int8", zarr.Readable>;
  /** Pre-opened root group's attrs (GeoZarr-compliant), used as
   * `ZarrLayer.metadata` so the layer reads spatial info from them. */
  rootAttrs: unknown;
  /** Band labels read from the `band` coord. */
  bandLabels: readonly string[];
  /** Length of the leading (time/year) dim, or 1 if none. */
  yearCount: number;
  /** Number of bands (the axis before the spatial pair). */
  bandCount: number;
};

export type BandCompositeState = {
  year: number;
  rBand: number;
  gBand: number;
  bBand: number;
  rescaleMin: number;
  rescaleMax: number;
};
