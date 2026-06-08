/** URL pattern for the AlphaEarth Foundations GeoZarr Mosaic. */
export const AEF_URL_PATTERN = "aef-mosaic";

/** Path to the embeddings array within the root group. */
export const AEF_VARIABLE = "embeddings";

/** Number of embedding dimensions. */
export const NUM_BANDS = 64;

/** Calendar year corresponding to time index 0. */
export const YEAR_ORIGIN = 2017;

/** int8 sentinel written by the producer for missing pixels. */
export const NODATA_INT8 = -128;

/** Dequantization divisor: `(v / 127.5)² · sign(v)`. */
export const DEQUANT_DIVISOR = 127.5;

/** Minimum viewport zoom at which the layer renders tiles. The AEF source
 * is a single-level zarr at ~10 m/px with NO overviews (no multiscale
 * pyramid), so its only resolution sits at native Web-Mercator zoom ≈13.9
 * (156543 / 10 m ⇒ 2^z ≈ 15654). `tileSize` bounds the output texture, not
 * the data region a tile reads: that region is `tileSize · 2^(nativeZoom −
 * tileZoom)`, and zarrita fetches every inner chunk covering it regardless
 * of stride (no read-time downsampling on a sharded store). So each zoom
 * level below native ~quadruples the chunks read to fill the screen:
 * z14 ≈ 55 MB, z13 ≈ 220 MB, z12 ≈ 850 MB, z11 ≈ 3.5 GB. We floor at z12
 * — two levels out, deliberately accepting the heavier wide-view cost so
 * tiles appear when moderately zoomed out. Going lower (or getting cheap
 * zoomed-out views at all) needs real overviews in the dataset. */
export const MIN_ZOOM = 13;
