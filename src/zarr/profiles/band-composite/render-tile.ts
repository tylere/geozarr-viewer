import type { RenderTileResult } from "@developmentseed/deck.gl-raster";
import { SampleBandCompositeRgb } from "./sample-rgb";
import type { BandCompositeTileData } from "./tile-loader";

export type BandCompositeRenderTileArgs = {
  rBandIdx: number;
  gBandIdx: number;
  bBandIdx: number;
  rescaleMin: number;
  rescaleMax: number;
};

/** Build a `renderTile` closure for AEF. The shader module owns
 * dequantization + RGB band picks + linear rescale + nodata discard. */
export function makeRgbRenderTile(args: BandCompositeRenderTileArgs) {
  const { rBandIdx, gBandIdx, bBandIdx, rescaleMin, rescaleMax } = args;
  return function renderTile(data: BandCompositeTileData): RenderTileResult {
    return {
      renderPipeline: [
        {
          module: SampleBandCompositeRgb,
          props: {
            dataTex: data.texture,
            rBandIdx,
            gBandIdx,
            bBandIdx,
            rescaleMin,
            rescaleMax,
          },
        },
      ],
    };
  };
}
