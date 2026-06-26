import type { Layer } from "@deck.gl/core";
import type { MinimalTileData } from "@developmentseed/deck.gl-raster";
import { ZarrLayer } from "@developmentseed/deck.gl-zarr";
import * as zarr from "zarrita";
import { reportDisplayedTiles } from "./tile-activity";

/** A `ZarrLayer` that also reports which pyramid level is currently DISPLAYED,
 * so the level badge stays accurate when revisiting an already-cached zoom.
 *
 * Why a subclass: `@developmentseed/deck.gl-raster`'s `RasterTileLayer` (the
 * base of `ZarrLayer`) builds its inner deck.gl `TileLayer` from a fixed prop
 * list and never forwards `onViewportLoad`. The badge's level was therefore
 * driven only by the tile loader (`getTileData`), which deck calls on cache
 * misses only — so panning/zooming back into cached tiles left it stale.
 *
 * deck.gl fires `TileLayer.onViewportLoad(selectedTiles)` on every viewport
 * change once the selected tiles are loaded — including cache hits (see
 * `_updateTileset`'s `tilesetChanged` path). `renderLayers()` returns that
 * inner TileLayer, so we clone it to attach the callback. The callback target
 * is fixed (`reportDisplayedTiles`); this layer exists purely to wire it. */
export class ReportingZarrLayer<
  Store extends zarr.Readable = zarr.Readable,
  Dtype extends zarr.DataType = zarr.DataType,
  DataT extends MinimalTileData = MinimalTileData,
> extends ZarrLayer<Store, Dtype, DataT> {
  static layerName = "ReportingZarrLayer";

  renderLayers(): Layer | null {
    // RasterTileLayer.renderLayers returns the inner deck.gl TileLayer (or null
    // while the source is still loading).
    const rendered = super.renderLayers();
    if (!rendered) return rendered;
    // The inner layer is a deck.gl TileLayer, which supports `onViewportLoad`,
    // but ZarrLayer's prop types don't expose it — hence the loose clone arg.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (rendered as any).clone({ onViewportLoad: reportDisplayedTiles });
  }
}
