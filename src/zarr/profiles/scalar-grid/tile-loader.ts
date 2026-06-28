import type { GetTileDataOptions } from "@developmentseed/deck.gl-zarr";
import * as zarr from "zarrita";
import { createLogger } from "../../../log";
import { registerSampleTile } from "../../../render/sample-source";
import {
  buildMultiBandTile,
  type MultiBandTileData,
} from "../../../render/shared-textures";
import { tileLoadEnd, tileLoadStart } from "../../../render/tile-activity";
import { reportTileError, reportTileResult } from "../../tile-error";

const log = createLogger("tiles");

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
  /** When set, register each decoded tile under this key so the hover tooltip
   * can read values from it (see render/sample-source). */
  sampleKey?: string;
  /** When set, derive the sample key from the tile's deck.gl `z` (pyramid level).
   * Takes precedence over `sampleKey`. Use this for multiscale stores where each
   * level has its own array coordinate space. */
  sampleKeyForZ?: (z: number) => string;
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
    const t0 = log.isEnabled("debug") ? performance.now() : 0;
    let chunk: Awaited<ReturnType<typeof zarr.get>>;
    // Tile `z` is the pyramid level (0 = coarsest); report as displayIndex z+1
    // at load START so the badge reflects the level being fetched.
    tileLoadStart(options.z + 1);
    try {
      chunk = await zarr.get(
        arr as zarr.Array<zarr.NumberDataType, zarr.Readable>,
        sliceSpec,
        { signal },
      );
    } catch (err) {
      // Surface persistent (non-abort) tile failures to the UI; rethrow so
      // deck.gl leaves a gap for this tile rather than rendering stale data.
      tileLoadEnd();
      reportTileError(err);
      log.debug(`tile ${options.x},${options.y},${options.z} failed`, err);
      throw err;
    }
    tileLoadEnd();
    reportTileResult(true);
    if (log.isEnabled("debug")) {
      const bytes = (chunk.data as { byteLength?: number }).byteLength;
      log.debug(
        `tile ${options.x},${options.y},${options.z} ${bytes ?? "?"}B in ${Math.round(performance.now() - t0)}ms`,
      );
    }
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
    const sampleKey = opts.sampleKeyForZ ? opts.sampleKeyForZ(options.z) : opts.sampleKey;
    if (sampleKey) {
      // `float32` is already CF-decoded and (when applicable) rolled to the
      // -180..180 frame, so the value reads directly — no roll in `valueAt`.
      const nd = sliceSpec.length;
      const rowStart = (sliceSpec[nd - 2] as zarr.Slice)?.start ?? 0;
      const colStart = (sliceSpec[nd - 1] as zarr.Slice)?.start ?? 0;
      const buf = float32;
      registerSampleTile(
        sampleKey,
        options.x,
        options.y,
        options.z,
        {
          rowStart,
          colStart,
          height,
          width,
          valueAt: (lr, lc) => buf[lr * width + lc]!,
        },
        buf.byteLength,
      );
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
