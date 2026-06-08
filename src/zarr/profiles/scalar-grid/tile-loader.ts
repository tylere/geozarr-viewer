import type { GetTileDataOptions } from "@developmentseed/deck.gl-zarr";
import * as zarr from "zarrita";
import {
  buildMultiBandTile,
  type MultiBandTileData,
} from "../../../render/shared-textures";

/** ScalarGrid single-band tile loader for regular lat/lon grids.
 *
 * The layer's `selection` pins every non-spatial dim to one index, so the
 * sliced chunk is 2D `[H, W]`. We coerce whatever numeric dtype the store
 * uses (float16 / float32 / float64 / int*) to Float32 and render it as one
 * colormapped band. A finite, non-zero `fillValue` is masked to NaN; we
 * deliberately do NOT mask `0`, since for many fields (winds, anomalies) 0
 * is a valid value rather than a fill sentinel. */
export function makeScalarGridTileLoader(opts: {
  fillValue: number | null;
  /** CF packing applied as `raw*scale + offset` (defaults 1 / 0). */
  scaleFactor?: number;
  addOffset?: number;
  /** Roll each tile's columns by half-width to map a 0..360 longitude grid
   * onto the -180..180 frame (the affine origin is shifted to match). Only
   * valid when a tile spans the full longitude extent — true for these
   * stores, whose longitude is a single chunk. */
  rollLongitude?: boolean;
}) {
  const scale = opts.scaleFactor ?? 1;
  const offset = opts.addOffset ?? 0;
  const fill =
    opts.fillValue !== null &&
    Number.isFinite(opts.fillValue) &&
    opts.fillValue !== 0
      ? opts.fillValue
      : null;
  return async function getTileData(
    arr: zarr.Array<zarr.DataType, zarr.Readable>,
    options: GetTileDataOptions,
  ): Promise<MultiBandTileData> {
    const { device, sliceSpec, signal, width, height } = options;
    const chunk = await zarr.get(
      arr as zarr.Array<zarr.NumberDataType, zarr.Readable>,
      sliceSpec,
      { signal },
    );
    if (chunk.shape.length !== 2) {
      throw new Error(
        `ScalarGrid tile expected 2D [H,W] after slicing; got [${chunk.shape.join(",")}]`,
      );
    }
    if (chunk.shape[0] !== height || chunk.shape[1] !== width) {
      throw new Error(
        `ScalarGrid tile shape mismatch: expected [${height},${width}], got [${chunk.shape.join(",")}]`,
      );
    }
    const src = chunk.data as ArrayLike<number>;
    // CF-decode in one pass: fill (checked on the raw value) → NaN, else
    // raw*scale + offset.
    let float32 = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) {
      const raw = Number(src[i]);
      float32[i] = fill !== null && raw === fill ? Number.NaN : raw * scale + offset;
    }
    if (opts.rollLongitude) {
      // Roll columns by half-width: logical col k ← physical col (k+W/2)%W,
      // mapping lon 180..360 to the left (-180..0) and 0..180 to the right.
      // Relies on the tile spanning the full longitude (one chunk).
      const shift = width >>> 1;
      const rolled = new Float32Array(float32.length);
      for (let r = 0; r < height; r++) {
        const base = r * width;
        for (let k = 0; k < width; k++) {
          rolled[base + k] = float32[base + ((k + shift) % width)]!;
        }
      }
      float32 = rolled;
    }
    // nodata: null — NaN is filtered automatically for float textures by
    // the single-band render pipeline's FilterNaN.
    return buildMultiBandTile(
      device,
      [{ key: "1", data: float32 }],
      width,
      height,
      null,
    );
  };
}
