import type * as zarr from "zarrita";
import type { ProfileBaseContext } from "../../profile";

/** One axis from an OME-Zarr `multiscales[].axes` entry. `type` is
 * `"space"` | `"channel"` | `"time"` | (others); `unit` is optional. */
export type OmeAxis = {
  name: string;
  type: string;
  unit?: string;
};

/** A pyramid level: the opened array plus its spatial size and downsample
 * factor relative to the finest level (finest = 1). Finest level first. */
export type OmeLevel = {
  path: string;
  scale: number[];
  array: zarr.Array<zarr.DataType, zarr.Readable>;
  /** Spatial size at this level, in this level's own pixels. */
  width: number;
  height: number;
  /** Spatial chunk size at this level (x, y). Windowed reads snap to these. */
  chunkW: number;
  chunkH: number;
  /** Linear downsample vs the finest level (1, 2, 4, …). */
  downsample: number;
};

/** A channel description from OME-Zarr `omero.channels`. `start`/`end` are the
 * suggested intensity display window; `label` names the channel. */
export type OmeChannel = {
  label: string;
  /** 6-digit hex (e.g. "00FF00"), no leading "#". May be empty. */
  color: string;
  start: number;
  end: number;
  active: boolean;
};

export type ImageOrthographicContext = ProfileBaseContext & {
  url: string;
  /** Detected zarr format ("v2" for OME-Zarr v0.4, "v3" for v0.5+). Display
   * only — shown in the Structure panel. */
  zarrVersion: "v2" | "v3";
  /** Root group (for the Structure panel). For a bioformats2raw layout this
   * is the wrapper above the multiscale series group. */
  group: zarr.Group<zarr.Readable>;
  /** Path from the root to the multiscale image group (e.g. "0" for a
   * bioformats2raw series, or "" when multiscales live at the root). */
  seriesPath: string;
  /** Axes in array order (matches `coarseArray.shape`). */
  axes: OmeAxis[];
  /** Index into `axes` of the channel axis, or null if none. */
  channelAxisIndex: number | null;
  /** Indices into `axes` of the (y, x) spatial pair. */
  spatialAxes: { yIndex: number; xIndex: number };
  /** Non-spatial, non-channel axes (time / z). MVP pins these to index 0. */
  otherAxes: { name: string; axisIndex: number; size: number }[];
  /** From `omero.channels`; empty when the store has no omero block. */
  channels: OmeChannel[];
  channelCount: number;
  /** Full pyramid (finest-first), each level opened. */
  levels: OmeLevel[];
  /** Spatial size of the FINEST level — the world coordinate extent that all
   * levels' textures are painted over. */
  width: number;
  height: number;
  /** Array path of the finest level, relative to the root group. */
  finestVariablePath: string;
};

export type ImageOrthographicState = {
  /** Selected channel index (0-based). */
  channel: number;
  /** Pinned index for each non-spatial, non-channel axis (z / time), keyed by
   * axis name. */
  indices: Record<string, number>;
  /** Colormap name (from deck.gl-raster's COLORMAP_INDEX; "gray" = grayscale). */
  colormap: string;
  /** Display gamma; >1 brightens, <1 darkens, 1 = linear. */
  gamma: number;
  /** Intensity window [min, max] in raw units. `null` = auto (a 2–98%
   * percentile of the data), which is the default and avoids the "everything
   * dark" look when a store's omero window is set wide. */
  rescale: [number, number] | null;
};
