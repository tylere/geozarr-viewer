import * as zarr from "zarrita";
import type { OmeAxis } from "./types";

/** Pick the pyramid level to display at a given OrthographicView zoom.
 *
 * In the viewer's world space one unit = one finest-level pixel, so screen
 * pixels per finest-pixel = 2^zoom. A level with downsample `d` stretches each
 * of its pixels over `d` finest-pixels, i.e. `d · 2^zoom` screen px per
 * level-pixel; it looks crisp (no upscaling) while `d ≤ 2^-zoom`.
 *
 * `downsamples` is finest-first and ascending (e.g. [1, 2, 4, 8, …]). We return
 * the index of the COARSEST level still crisp (least data to fetch); when the
 * view is zoomed in past native resolution (`2^-zoom < 1`), nothing qualifies
 * and we fall back to the finest level (index 0). */
export function pickLevelForZoom(zoom: number, downsamples: number[]): number {
  if (downsamples.length === 0) return 0;
  const target = Math.pow(2, -zoom);
  let pick = 0;
  for (let i = 0; i < downsamples.length; i++) {
    if (downsamples[i]! <= target) pick = i;
  }
  return pick;
}

/** Build a zarrita selection (one entry per array axis): the spatial pair is
 * full (`null`); the channel axis is pinned to `channel`; every other axis
 * (z / time) is pinned to its index from `indices` (default 0). */
export function buildSelection(
  axes: OmeAxis[],
  channelAxisIndex: number | null,
  spatialAxes: { yIndex: number; xIndex: number },
  channel: number,
  indices: Record<string, number>,
): (number | null)[] {
  return axes.map((axis, i) => {
    if (i === spatialAxes.yIndex || i === spatialAxes.xIndex) return null;
    if (i === channelAxisIndex) return channel;
    return indices[axis.name] ?? 0;
  });
}

/** Visible window of a pyramid level, in that level's own pixels. */
export type LevelWindow = { x0: number; y0: number; x1: number; y1: number };

/** Compute which sub-rectangle of a pyramid level is visible, so only that
 * region is fetched (essential for gigapixel images). Maps the OrthographicView
 * viewport (target + zoom, world = finest pixels) to the level's pixel grid,
 * snaps OUT to chunk boundaries (stable keys → cache hits while panning), and
 * clamps to the level. Always returns a non-empty window. */
export function computeWindow(args: {
  targetX: number;
  targetY: number;
  zoom: number;
  canvasW: number;
  canvasH: number;
  worldW: number;
  worldH: number;
  downsample: number;
  levelW: number;
  levelH: number;
  chunkW: number;
  chunkH: number;
}): LevelWindow {
  const { targetX, targetY, zoom, canvasW, canvasH, worldW, worldH } = args;
  const { downsample: ds, levelW, levelH, chunkW, chunkH } = args;
  const scale = Math.pow(2, zoom); // screen px per world unit
  const halfW = canvasW / 2 / scale;
  const halfH = canvasH / 2 / scale;
  const clamp = (v: number, lo: number, hi: number) =>
    v < lo ? lo : v > hi ? hi : v;
  // Visible world bbox (finest px), clamped to the image.
  const wx0 = clamp(targetX - halfW, 0, worldW);
  const wx1 = clamp(targetX + halfW, 0, worldW);
  const wy0 = clamp(targetY - halfH, 0, worldH);
  const wy1 = clamp(targetY + halfH, 0, worldH);
  // → level px, snapped out to chunk boundaries, clamped to the level.
  let x0 = Math.floor(Math.floor(wx0 / ds) / chunkW) * chunkW;
  let x1 = Math.ceil(Math.ceil(wx1 / ds) / chunkW) * chunkW;
  let y0 = Math.floor(Math.floor(wy0 / ds) / chunkH) * chunkH;
  let y1 = Math.ceil(Math.ceil(wy1 / ds) / chunkH) * chunkH;
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(levelW, x1);
  y1 = Math.min(levelH, y1);
  if (x1 <= x0) x1 = Math.min(levelW, x0 + chunkW);
  if (y1 <= y0) y1 = Math.min(levelH, y0 + chunkH);
  return { x0, y0, x1, y1 };
}

/** Like {@link buildSelection} but the spatial pair is sliced to a window
 * (`y` → `[y0,y1)`, `x` → `[x0,x1)`) instead of read whole — used to fetch only
 * the visible region of a large pyramid level. */
export function buildWindowSelection(
  axes: OmeAxis[],
  channelAxisIndex: number | null,
  spatialAxes: { yIndex: number; xIndex: number },
  channel: number,
  indices: Record<string, number>,
  xRange: [number, number],
  yRange: [number, number],
): (number | zarr.Slice)[] {
  return axes.map((axis, i) => {
    if (i === spatialAxes.yIndex) return zarr.slice(yRange[0], yRange[1]);
    if (i === spatialAxes.xIndex) return zarr.slice(xRange[0], xRange[1]);
    if (i === channelAxisIndex) return channel;
    return indices[axis.name] ?? 0;
  });
}
