import type { MinimalTileData } from "@developmentseed/deck.gl-raster";
import type { GetTileDataOptions } from "@developmentseed/deck.gl-zarr";
import type { Texture } from "@luma.gl/core";
import * as zarr from "zarrita";
import { NUM_BANDS } from "./constants";

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
  const chunk = await zarr.get(arr, sliceSpec, { signal });
  const { data } = chunk;

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
