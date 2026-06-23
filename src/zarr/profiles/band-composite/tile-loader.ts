import type { MinimalTileData } from "@developmentseed/deck.gl-raster";
import type { GetTileDataOptions } from "@developmentseed/deck.gl-zarr";
import type { Texture } from "@luma.gl/core";
import * as zarr from "zarrita";
import { createLogger } from "../../../log";
import { tileLoadEnd, tileLoadStart } from "../../../render/tile-activity";
import { reportTileError, reportTileResult } from "../../tile-error";
import { NUM_BANDS } from "./constants";

const log = createLogger("tiles");

export type BandCompositeTileData = MinimalTileData & {
  /** r8sint Texture2DArray; depth = NUM_BANDS. Layer `i` = band `i`. */
  texture: Texture;
};

/** Tile loader for AEF: slice one spatial chunk × all 64 bands (year is
 * pinned by `selection`), then upload the int8 data as an r8sint
 * Texture2DArray. Zarrita's row-major `[band, y, x]` layout matches the
 * Texture2DArray's layer-major storage one-for-one — no transpose. */
export async function getBandCompositeTileData(
  arr: zarr.Array<"int8", zarr.Readable>,
  options: GetTileDataOptions,
): Promise<BandCompositeTileData> {
  const { device, sliceSpec, width, height, signal } = options;
  const t0 = log.isEnabled("debug") ? performance.now() : 0;
  tileLoadStart(options.z + 1);
  const chunk = await (async () => {
    try {
      return await zarr.get(arr, sliceSpec, { signal });
    } catch (err) {
      // Surface persistent (non-abort) tile failures; rethrow so deck.gl
      // leaves a gap rather than rendering stale data.
      tileLoadEnd();
      reportTileError(err);
      log.debug(`tile ${options.x},${options.y},${options.z} failed`, err);
      throw err;
    }
  })();
  tileLoadEnd();
  reportTileResult(true);
  const { data } = chunk;
  if (log.isEnabled("debug")) {
    log.debug(
      `tile ${options.x},${options.y},${options.z} ${data.byteLength}B in ${Math.round(performance.now() - t0)}ms`,
    );
  }

  if (chunk.shape.length !== 3) {
    throw new Error(
      `AEF tile expected 3D [band,H,W]; got [${chunk.shape.join(",")}]`,
    );
  }
  if (chunk.shape[0] !== NUM_BANDS) {
    throw new Error(
      `AEF tile expected depth=${NUM_BANDS} bands; got ${chunk.shape[0]}`,
    );
  }
  if (chunk.shape[1] !== height || chunk.shape[2] !== width) {
    throw new Error(
      `AEF tile shape mismatch: expected [${NUM_BANDS},${height},${width}], got [${chunk.shape.join(",")}]`,
    );
  }

  const texture = device.createTexture({
    dimension: "2d-array",
    format: "r8sint",
    width,
    height,
    depth: NUM_BANDS,
    mipLevels: 1,
    data,
    sampler: {
      minFilter: "nearest",
      magFilter: "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    },
  });

  return { texture, width, height, byteLength: data.byteLength };
}
