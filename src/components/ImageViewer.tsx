import { Deck, OrthographicView } from "@deck.gl/core";
import { BitmapLayer } from "@deck.gl/layers";
import { useEffect, useMemo, useRef, useState } from "react";
import * as zarr from "zarrita";
import { formatNumber } from "./RangeSlider";
import { createLogger } from "../log";
import {
  type AutoStats,
  type BandStats,
  buildBandStats,
  percentileFromHistogram,
} from "../render/stats";
import { setActiveLevel, tileLoadEnd, tileLoadStart } from "../render/tile-activity";
import {
  buildWindowSelection,
  computeWindow,
  type LevelWindow,
  pickLevelForZoom,
} from "../zarr/profiles/image-orthographic/lod";
import type {
  ImageOrthographicContext,
  ImageOrthographicState,
} from "../zarr/profiles/image-orthographic/types";
import { loadColormapLut } from "./colormap-lut";
import { styleToRgba } from "./image-normalize";

const log = createLogger("image-viewer");

/** Cap a single windowed fetch (megapixels). LOD keeps the window ≈ viewport-
 * sized, so this is just a safety clamp against pathological zooms. */
const MAX_WINDOW_MP = 8;
/** How many decoded windows to keep before evicting the oldest. */
const CACHE_LIMIT = 24;
/** Debounce (ms) so continuous panning coalesces into one fetch. */
const REFETCH_DEBOUNCE_MS = 120;

/** A decoded window of one pyramid level: the raw samples (for restyle + hover),
 * its origin/size in level pixels, and its downsample vs world (finest) space. */
type RawWindow = {
  raw: ArrayLike<number>;
  /** Window size in level pixels. */
  winW: number;
  winH: number;
  /** Window origin in level pixels. */
  x0: number;
  y0: number;
  downsample: number;
  level: number;
  stats: BandStats | null;
};

type HoverInfo = { x: number; y: number; col: number; row: number; value: number };
type ViewState = { target: [number, number, number]; zoom: number };

function resolveRescale(
  rmin: number | undefined,
  rmax: number | undefined,
  autoStats: AutoStats | null,
  current: RawWindow | null,
): [number, number] {
  if (rmin !== undefined && rmax !== undefined) return [rmin, rmax];
  if (autoStats?.global) {
    return [
      percentileFromHistogram(autoStats.global, 0.02),
      percentileFromHistogram(autoStats.global, 0.98),
    ];
  }
  if (current?.stats) return [current.stats.min, current.stats.max];
  return [0, 1];
}

/** Standalone deck.gl `OrthographicView` host for non-geographic OME-Zarr
 * images. Picks the pyramid level matching the current zoom (LOD) and fetches
 * only the VISIBLE window of that level (chunk-snapped, cached), so gigapixel
 * whole-slides load with viewport-bounded memory. Styling (colormap/rescale/
 * gamma) is applied on the CPU and restyles without refetching. */
export function ImageViewer({
  ctx,
  state,
  opacity,
  autoStats,
}: {
  ctx: ImageOrthographicContext;
  state: ImageOrthographicState;
  opacity: number;
  autoStats: AutoStats | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const deckRef = useRef<Deck<OrthographicView> | null>(null);
  const sampleRef = useRef<RawWindow | null>(null); // read by hover handler
  const cacheRef = useRef<Map<string, RawWindow>>(new Map());

  const [view, setView] = useState<ViewState | null>(null);
  const [current, setCurrent] = useState<RawWindow | null>(null);
  const [lut, setLut] = useState<Uint8Array | null>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const { width: worldW, height: worldH } = ctx; // finest-level extent
  const downsamples = useMemo(() => ctx.levels.map((l) => l.downsample), [ctx.levels]);
  const indicesKey = JSON.stringify(state.indices);

  // Create the Deck instance once. The view is uncontrolled (deck's controller
  // owns pan/zoom); we observe viewState for LOD/windowing and the cursor for
  // hover.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap || worldW === 0 || worldH === 0) return;
    const cw = wrap.clientWidth || 800;
    const ch = wrap.clientHeight || 600;
    const fitZoom = Math.log2(Math.min(cw / worldW, ch / worldH) * 0.92);
    setView({ target: [worldW / 2, worldH / 2, 0], zoom: fitZoom });

    const deck = new Deck<OrthographicView>({
      canvas,
      views: new OrthographicView({ id: "ortho" }),
      controller: true,
      initialViewState: {
        target: [worldW / 2, worldH / 2, 0],
        zoom: fitZoom,
        minZoom: fitZoom - 1,
        maxZoom: 8,
      },
      layers: [],
      getCursor: ({ isDragging }) => (isDragging ? "grabbing" : "crosshair"),
      onViewStateChange: ({ viewState }) => {
        const vs = viewState as { target: [number, number, number]; zoom: number };
        setView({ target: vs.target, zoom: vs.zoom });
      },
      onHover: (info) => {
        const tex = sampleRef.current;
        const coord = info.coordinate;
        if (!tex || !coord) {
          setHover(null);
          return;
        }
        const col = Math.floor(coord[0]!);
        const row = Math.floor(coord[1]!);
        if (col < 0 || col >= worldW || row < 0 || row >= worldH) {
          setHover(null);
          return;
        }
        // world px → this window's level-pixel grid (offset by window origin).
        const lc = Math.floor(col / tex.downsample) - tex.x0;
        const lr = Math.floor(row / tex.downsample) - tex.y0;
        if (lc < 0 || lc >= tex.winW || lr < 0 || lr >= tex.winH) {
          setHover(null);
          return;
        }
        setHover({ x: info.x, y: info.y, col, row, value: Number(tex.raw[lr * tex.winW + lc]) });
      },
    });
    deckRef.current = deck;
    log.info(`ortho host ${worldW}×${worldH}px, fitZoom=${fitZoom.toFixed(2)}`);
    return () => {
      deck.finalize();
      deckRef.current = null;
    };
  }, [worldW, worldH]);

  const targetLevel =
    view == null ? ctx.levels.length - 1 : pickLevelForZoom(view.zoom, downsamples);

  // Visible window of the chosen level (chunk-snapped). Recomputed on view
  // change; returns a stable rect while panning within the same chunks.
  const viewWindow: LevelWindow | null = useMemo(() => {
    if (!view) return null;
    const level = ctx.levels[targetLevel];
    const wrap = wrapRef.current;
    if (!level || !wrap) return null;
    return computeWindow({
      targetX: view.target[0],
      targetY: view.target[1],
      zoom: view.zoom,
      canvasW: wrap.clientWidth || 800,
      canvasH: wrap.clientHeight || 600,
      worldW,
      worldH,
      downsample: level.downsample,
      levelW: level.width,
      levelH: level.height,
      chunkW: level.chunkW,
      chunkH: level.chunkH,
    });
  }, [view, targetLevel, ctx.levels, worldW, worldH]);

  const windowKey = viewWindow
    ? `${targetLevel}|${state.channel}|${indicesKey}|${viewWindow.x0}_${viewWindow.y0}_${viewWindow.x1}_${viewWindow.y1}`
    : null;

  // Fetch the visible window (raw + stats), cache it, and paint it. Debounced so
  // a pan gesture coalesces; the previous window stays painted until ready.
  useEffect(() => {
    if (!viewWindow || !windowKey) return;
    const cached = cacheRef.current.get(windowKey);
    if (cached) {
      sampleRef.current = cached;
      setCurrent(cached);
      setStatus("ready");
      return;
    }
    const level = ctx.levels[targetLevel]!;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        tileLoadStart();
        try {
          let { x0, y0, x1, y1 } = viewWindow;
          // Safety clamp: shrink an oversized window around its center.
          if (((x1 - x0) * (y1 - y0)) / 1e6 > MAX_WINDOW_MP) {
            const cap = Math.floor(Math.sqrt(MAX_WINDOW_MP * 1e6));
            const cx = Math.floor((x0 + x1) / 2);
            const cy = Math.floor((y0 + y1) / 2);
            x0 = Math.max(0, cx - cap / 2);
            y0 = Math.max(0, cy - cap / 2);
            x1 = Math.min(level.width, x0 + cap);
            y1 = Math.min(level.height, y0 + cap);
          }
          const sel = buildWindowSelection(
            ctx.axes,
            ctx.channelAxisIndex,
            ctx.spatialAxes,
            state.channel,
            state.indices,
            [x0, x1],
            [y0, y1],
          );
          const chunk = await zarr.get(
            level.array as zarr.Array<zarr.NumberDataType, zarr.Readable>,
            sel,
            { signal: ctrl.signal },
          );
          if (ctrl.signal.aborted) return;
          const raw = chunk.data as ArrayLike<number>;
          const tex: RawWindow = {
            raw,
            winW: x1 - x0,
            winH: y1 - y0,
            x0,
            y0,
            downsample: level.downsample,
            level: targetLevel,
            stats: buildBandStats(raw, null),
          };
          const cache = cacheRef.current;
          cache.set(windowKey, tex);
          if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
          sampleRef.current = tex;
          setCurrent(tex);
          setStatus("ready");
        } catch (err) {
          if (ctrl.signal.aborted) return;
          log.error("window load failed", err);
          setStatus("error");
        } finally {
          tileLoadEnd();
        }
      })();
    }, REFETCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // state.indices read inside; captured by indicesKey via windowKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowKey, ctx, targetLevel]);

  // Report the displayed level to the badge as soon as the zoom picks a new
  // target level — before its window finishes loading. ctx.levels are
  // finest-first (index 0 = finest), so displayIndex = N - level (1 = coarsest).
  useEffect(() => {
    const lvl = ctx.levels[targetLevel];
    if (!lvl) return;
    setActiveLevel(ctx.levels.length - targetLevel, lvl.downsample);
  }, [targetLevel, ctx.levels]);

  // Drop the cache when the store changes.
  useEffect(() => {
    const cache = cacheRef.current;
    return () => {
      cache.clear();
      sampleRef.current = null;
    };
  }, [ctx]);

  // Load the colormap LUT (null = grayscale).
  useEffect(() => {
    let cancelled = false;
    loadColormapLut(state.colormap)
      .then((l) => {
        if (!cancelled) setLut(l);
      })
      .catch(() => {
        if (!cancelled) setLut(null);
      });
    return () => {
      cancelled = true;
    };
  }, [state.colormap]);

  // Restyle the current window (no refetch). Primitive deps so it doesn't rerun
  // every render.
  const rmin = state.rescale?.[0];
  const rmax = state.rescale?.[1];
  const image = useMemo(() => {
    if (!current) return null;
    const [mn, mx] = resolveRescale(rmin, rmax, autoStats, current);
    const rgba = styleToRgba(current.raw, current.winW, current.winH, mn, mx, state.gamma, lut);
    return new ImageData(rgba, current.winW, current.winH);
  }, [current, rmin, rmax, state.gamma, lut, autoStats]);

  // Push the styled window to Deck as a BitmapLayer over its world extent.
  useEffect(() => {
    if (!image || !current) return;
    const ds = current.downsample;
    const left = current.x0 * ds;
    const top = current.y0 * ds;
    const right = (current.x0 + current.winW) * ds;
    const bottom = (current.y0 + current.winH) * ds;
    deckRef.current?.setProps({
      layers: [
        new BitmapLayer({
          id: `ome-L${current.level}-${current.x0}_${current.y0}`,
          image,
          // [left, bottom, right, top]; top<bottom puts row 0 at top under flipY.
          bounds: [left, bottom, right, top],
          opacity,
        }),
      ],
    });
  }, [image, current, opacity]);

  return (
    <div ref={wrapRef} style={{ position: "absolute", inset: 0, background: "#000" }}>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%" }} />

      {status !== "ready" && (
        <div
          className="panel mono"
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
            padding: "6px 10px",
            fontSize: 12,
            color: status === "error" ? "var(--danger, #f66)" : undefined,
          }}
        >
          {status === "error" ? "Failed to load image" : "Loading image…"}
        </div>
      )}

      {hover && (
        <div
          style={{
            position: "absolute",
            left: hover.x + 14,
            top: hover.y + 14,
            zIndex: 16,
            pointerEvents: "none",
            maxWidth: 280,
          }}
        >
          <div
            className="panel mono"
            style={{ padding: "4px 8px", fontSize: 11, lineHeight: 1.4, whiteSpace: "nowrap" }}
          >
            <div>{ctx.channels[state.channel]?.label ?? `channel ${state.channel}`}</div>
            <div>{formatNumber(hover.value)}</div>
            <div style={{ color: "var(--text-muted)" }}>
              x {hover.col}, y {hover.row}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
