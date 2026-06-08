import type * as zarr from "zarrita";

/** Derive a square `tileSize` for `RasterTileLayer` from a zarr array's
 * native chunk shape. Each store chunks differently; aligning the tile
 * grid with the data's spatial chunk boundaries makes one tile = one
 * chunk fetch (or one set of sub-shards for sharded stores), eliminating
 * the "tile straddles N chunks" multiplier.
 *
 * We take the last two dims as spatial (the GeoZarr convention). When
 * they differ, fall back to the smaller — that ensures any one tile
 * touches at most one chunk along the larger axis (some tiles will
 * straddle the smaller axis instead, which is the lesser overfetch). */
export function spatialTileSize(
  arr: zarr.Array<zarr.DataType, zarr.Readable>,
): number {
  const chunks = arr.chunks;
  if (chunks.length < 2) return 256;
  const cy = chunks[chunks.length - 2];
  const cx = chunks[chunks.length - 1];
  if (typeof cy !== "number" || typeof cx !== "number") return 256;
  return Math.min(cy, cx);
}

/** Bytes per element for a zarrita dtype string ("float32" → 4, "int8" → 1).
 * Used to estimate per-viewport fetch volume for the render-zoom gate. Matches
 * the trailing bit-count (robust across zarrita's dtype spellings); sub-byte
 * (e.g. "bool") and unknown dtypes fall back to 4 (float32-equivalent). */
export function bytesPerElement(dtype: string): number {
  const m = /(\d+)$/.exec(dtype);
  if (!m) return 4;
  const bits = Number(m[1]);
  return bits >= 8 ? bits / 8 : 4;
}
