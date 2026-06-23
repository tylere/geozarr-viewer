import type {
  MinimalTileData,
  RasterModule,
  RenderTileResult,
} from "@developmentseed/deck.gl-raster";
import {
  Colormap,
  COLORMAP_INDEX,
  LinearRescale,
} from "@developmentseed/deck.gl-raster/gpu-modules";
import type { GetTileDataOptions } from "@developmentseed/deck.gl-zarr";
import type { Texture } from "@luma.gl/core";
import * as zarr from "zarrita";
import { createLogger } from "../log";
import { reportTileError, reportTileResult } from "../zarr/tile-error";
import { decodedChunkCache } from "./chunk-cache";
import { tileLoadEnd, tileLoadStart } from "./tile-activity";
import { registerSampleTile } from "./sample-source";

const log = createLogger("tiles");
import { Gamma, LogStretch, SqrtStretch } from "./shader-modules";
import {
  percentileFromHistogram,
  type AutoStats,
  type BandStats,
} from "./stats";
import type { Stretch } from "../state/types";

/**
 * Shared pipeline for the "stack of frames in one texture" rendering mode:
 * a non-spatial dimension that is fully packed into a single chunk is loaded
 * into a `r32float` Texture2DArray once, and scrubbing it becomes a free
 * shader uniform (`frameIndex`) instead of a refetch. Used by the ECMWF
 * profile (lead_time) and the generic profile (any budget-fitting bundled
 * dim, e.g. GFS pressure level).
 */

const MODULE_NAME = "sampleTexture2DArray";

export type SampleTexture2DArrayProps = {
  /** Texture2DArray of r32float data, depth = frame count. */
  dataTex: Texture;
  /** Frame index to sample (as a float — nearest sampling). */
  layerIndex: number;
};

/**
 * Samples a `sampler2DArray` at `(uv, layerIndex)` and writes the scalar
 * into `color.rgb` (broadcast). Discards NaN samples so missing-data
 * regions are transparent. Compose downstream with `LinearRescale` +
 * `Colormap` (and optionally `Gamma`/`Stretch`). Ported from the upstream
 * `dynamical-zarr-ecmwf` example.
 */
export const SampleTexture2DArray = {
  name: MODULE_NAME,
  fs: `\
uniform ${MODULE_NAME}Uniforms {
  float layerIndex;
} ${MODULE_NAME};
`,
  inject: {
    "fs:#decl": `
precision highp sampler2DArray;
uniform sampler2DArray dataTex;
`,
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      float v = texture(dataTex, vec3(geometry.uv, ${MODULE_NAME}.layerIndex)).r;
      if (isnan(v)) discard;
      color = vec4(v, v, v, 1.0);
    `,
  },
  uniformTypes: {
    layerIndex: "f32",
  },
  getUniforms: (props: Partial<SampleTexture2DArrayProps>) => ({
    layerIndex: props.layerIndex ?? 0,
    dataTex: props.dataTex,
  }),
} as const;

export type TextureArrayTileData = MinimalTileData & {
  /** r32float Texture2DArray; depth = frame count. Layer `i` = frame `i`. */
  texture: Texture;
  /** Sentinel value to treat as nodata (informational; NaN is discarded in
   * the shader regardless). */
  nodata: number | null;
};

/** Row-major strides of the LEADING axes for an array shaped
 * `[...leadingShape, height, width]`. The trailing H/W strides are `width`/`1`;
 * the last leading axis has stride `frameLen` (= height·width). */
export function leadingStrides(leadingShape: number[], frameLen: number): number[] {
  const strides = new Array<number>(leadingShape.length);
  let acc = frameLen;
  for (let a = leadingShape.length - 1; a >= 0; a--) {
    strides[a] = acc;
    acc *= leadingShape[a]!;
  }
  return strides;
}

/** Linear offset of the start of the H×W plane at the given per-leading-axis
 * `indices`, for an array shaped `[...leadingShape, H, W]`. */
export function planeOffset(
  leadingShape: number[],
  indices: number[],
  frameLen: number,
): number {
  const strides = leadingStrides(leadingShape, frameLen);
  let off = 0;
  for (let a = 0; a < leadingShape.length; a++) off += indices[a]! * strides[a]!;
  return off;
}

/** Build the float32 texture data for the texture dim's frames
 * `[start, start+len)` of an all-frames chunk shaped `[...leadingShape, H, W]`.
 * `texAxis` is the texture dim's position among the leading axes; the other
 * leading axes (the fully-packed "memory" dims) are pinned to `fixedIdx`. Coerce
 * to float32, mask a finite non-zero `fill` to NaN, and (when `roll`) roll each
 * frame's columns by half-width to map a 0..360 grid onto -180..180.
 *
 * The single-leading-axis case (`leadingShape=[depth]`, `texAxis=0`) is the old
 * `[depth, H, W]` behavior. */
export function buildWindowFloat32(
  raw: ArrayLike<number>,
  leadingShape: number[],
  texAxis: number,
  fixedIdx: number[],
  height: number,
  width: number,
  start: number,
  len: number,
  fill: number | null,
  roll: boolean,
  scale: number,
  offset: number,
): Float32Array {
  const frame = height * width;
  const out = new Float32Array(len * frame);
  const shift = roll ? width >>> 1 : 0;
  const strides = leadingStrides(leadingShape, frame);
  // Base offset from the pinned (non-texture) leading axes.
  let fixedBase = 0;
  for (let a = 0; a < leadingShape.length; a++) {
    if (a !== texAxis) fixedBase += fixedIdx[a]! * strides[a]!;
  }
  const texStride = strides[texAxis] ?? frame;
  for (let f = 0; f < len; f++) {
    const srcBase = fixedBase + (start + f) * texStride;
    const dstBase = f * frame;
    for (let r = 0; r < height; r++) {
      const sRow = srcBase + r * width;
      const dRow = dstBase + r * width;
      for (let k = 0; k < width; k++) {
        const v = Number(raw[sRow + (roll ? (k + shift) % width : k)]);
        out[dRow + k] = fill !== null && v === fill ? Number.NaN : v * scale + offset;
      }
    }
  }
  return out;
}

/** Build a tile loader that reads `[frames, H, W]` (the frame dim left as a
 * full slice by the caller's `selection`) and uploads an `r32float`
 * Texture2DArray. Coerces any numeric dtype to float32 and masks a finite,
 * non-zero fill value to NaN; `rollLongitude` rolls a 0..360 grid onto
 * -180..180.
 *
 * When `chunkKey` is given, the decoded all-frames array is memoized in
 * {@link decodedChunkCache} (keyed by `chunkKey` + spatial tile) so repeated
 * reads of the same chunk — e.g. scrubbing across `window`s, or scrubbing a
 * fully-packed "memory" dim — skip the decompress. `window` then selects the
 * frames uploaded to the GPU (the budget bound); without it the whole texture
 * dim is uploaded (ECMWF). `leading` describes how to slice a chunk that bundles
 * more than the texture dim (e.g. ECMWF `lead_time` × `ensemble_member`): which
 * leading axis is the texture dim and the pinned indices of the others. The
 * memory indices are deliberately NOT part of `chunkKey`, so changing one is a
 * cache hit (re-slice + re-upload, no re-fetch/decode). */
export function makeTextureArrayTileLoader(opts: {
  fillValue: number | null;
  /** CF packing applied as `raw*scale + offset` (defaults 1 / 0). */
  scaleFactor?: number;
  addOffset?: number;
  rollLongitude?: boolean;
  /** Frames `[start, start+len)` to upload. Omitted → all frames. */
  window?: { start: number; len: number };
  /** Cache identity for the decoded chunk (variable + pinned, non-packed dims).
   * Omitted → no CPU caching (re-decode each call). */
  chunkKey?: string;
  /** When set, register each decoded tile under this key so the hover tooltip
   * can read values from it (see render/sample-source). */
  sampleKey?: string;
  /** Slice descriptor for a chunk whose leading (non-spatial) axes are the
   * texture dim PLUS fully-packed memory dims. `texAxis` is the texture dim's
   * position among the leading axes; `memoryIndices` is the pinned index per
   * leading axis (the `texAxis` entry is ignored). Omitted → single leading
   * axis = the texture dim (the original `[depth, H, W]` behavior). */
  leading?: { texAxis: number; memoryIndices: number[] };
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
  ): Promise<TextureArrayTileData> {
    const { device, sliceSpec, signal, width, height } = options;
    const cacheKey = opts.chunkKey
      ? `${opts.chunkKey}|${options.x},${options.y},${options.z}`
      : null;

    let full = cacheKey ? decodedChunkCache.get(cacheKey) : undefined;
    if (full) {
      log.debug(`tile ${options.x},${options.y},${options.z} cache hit`);
    }
    if (!full) {
      const t0 = log.isEnabled("debug") ? performance.now() : 0;
      let chunk: Awaited<ReturnType<typeof zarr.get>>;
      tileLoadStart(options.z + 1);
      try {
        chunk = await zarr.get(
          arr as zarr.Array<zarr.NumberDataType, zarr.Readable>,
          sliceSpec,
          { signal },
        );
      } catch (err) {
        // Surface persistent (non-abort) tile failures; rethrow so deck.gl
        // leaves a gap rather than rendering stale data.
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
      const snd = chunk.shape.length;
      if (snd < 3) {
        throw new Error(
          `Texture-array tile expected [...leading, H, W]; got [${chunk.shape.join(",")}]`,
        );
      }
      if (chunk.shape[snd - 2] !== height || chunk.shape[snd - 1] !== width) {
        throw new Error(
          `Texture-array tile shape mismatch: expected [...,${height},${width}], got [${chunk.shape.join(",")}]`,
        );
      }
      const raw = chunk.data as ArrayLike<number>;
      const byteLength =
        (raw as { byteLength?: number }).byteLength ?? raw.length * 4;
      full = {
        data: raw,
        leadingShape: chunk.shape.slice(0, snd - 2),
        height,
        width,
        byteLength,
      };
      if (cacheKey) decodedChunkCache.set(cacheKey, full);
    }

    // Resolve the texture axis + pinned memory indices (default: single leading
    // axis = the texture dim).
    const leadingShape = full.leadingShape;
    const texAxis = opts.leading?.texAxis ?? 0;
    const memoryIndices =
      opts.leading?.memoryIndices ?? leadingShape.map(() => 0);
    const texSize = leadingShape[texAxis] ?? 1;

    if (opts.sampleKey) {
      // Register on every call (even a cache hit): the sample bucket may have
      // been cleared by a selection change while `full` stayed cached. `full.data`
      // is the raw [...leading, H, W] chunk, UNrolled, so `valueAt` applies CF +
      // the roll (mirrors buildWindowFloat32) to read in the displayed
      // -180..180 frame, indexing the texture axis by `frame` and the memory
      // axes by their pinned indices.
      const nd = sliceSpec.length;
      const rowStart = (sliceSpec[nd - 2] as zarr.Slice)?.start ?? 0;
      const colStart = (sliceSpec[nd - 1] as zarr.Slice)?.start ?? 0;
      const raw = full.data;
      const frameLen = height * width;
      const shift = opts.rollLongitude ? width >>> 1 : 0;
      const idx = memoryIndices.slice();
      registerSampleTile(
        opts.sampleKey,
        options.x,
        options.y,
        options.z,
        {
          rowStart,
          colStart,
          height,
          width,
          valueAt: (lr, lc, frame) => {
            if (frame < 0 || frame >= texSize) return Number.NaN;
            const physCol = shift ? (lc + shift) % width : lc;
            idx[texAxis] = frame;
            const v = Number(
              raw[planeOffset(leadingShape, idx, frameLen) + lr * width + physCol],
            );
            return fill !== null && v === fill ? Number.NaN : v * scale + offset;
          },
        },
        full.byteLength,
      );
    }

    const start = opts.window ? opts.window.start : 0;
    const len = opts.window ? Math.min(opts.window.len, texSize - start) : texSize;
    const data = buildWindowFloat32(
      full.data,
      leadingShape,
      texAxis,
      memoryIndices,
      height,
      width,
      start,
      len,
      fill,
      !!opts.rollLongitude,
      scale,
      offset,
    );
    const texture = device.createTexture({
      dimension: "2d-array",
      format: "r32float",
      width,
      height,
      depth: len,
      mipLevels: 1,
      data,
      sampler: {
        minFilter: "nearest",
        magFilter: "nearest",
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
      },
    });
    return {
      texture,
      width,
      height,
      byteLength: data.byteLength,
      nodata: opts.fillValue,
    };
  };
}

const RESCALE_EPSILON = 1e-9;
const DEFAULT_PERCENTILE_LO = 0.02;
const DEFAULT_PERCENTILE_HI = 0.98;

export type TextureArrayRenderState = {
  /** Active frame index — mapped to the shader's `layerIndex` uniform. */
  frameIndex: number;
  colormap: string;
  rescale: [number, number] | null;
  gamma: number;
  stretch: Stretch;
};

function safeRange([lo, hi]: [number, number]): [number, number] {
  return lo === hi ? [lo, lo + RESCALE_EPSILON] : [lo, hi];
}

function autoRange(stats: BandStats): [number, number] {
  const hasBins = stats.histogram.some((b) => b > 0);
  if (!hasBins) return [stats.min, stats.max];
  return [
    percentileFromHistogram(stats, DEFAULT_PERCENTILE_LO),
    percentileFromHistogram(stats, DEFAULT_PERCENTILE_HI),
  ];
}

/** Build a renderTile closure for the texture-array mode. Pipeline:
 *
 *     SampleTexture2DArray → LinearRescale → [stretch] → [gamma] → Colormap
 *
 * `frameIndex` is a shader uniform, so scrubbing the frame slider does not
 * refetch tiles. */
export function buildTextureArrayRenderTile(
  state: TextureArrayRenderState,
  colormapTexture: Texture,
  autoStats: AutoStats | null,
) {
  const name = state.colormap.toLowerCase();
  const colormapIndex =
    (COLORMAP_INDEX as Record<string, number>)[name] ?? COLORMAP_INDEX.viridis;

  let rescale: [number, number] | null = null;
  if (state.rescale) rescale = safeRange(state.rescale);
  else if (autoStats?.global) rescale = safeRange(autoRange(autoStats.global));

  return function renderTile(data: TextureArrayTileData): RenderTileResult {
    const pipeline: RasterModule[] = [
      {
        module: SampleTexture2DArray,
        props: { dataTex: data.texture, layerIndex: state.frameIndex },
      },
    ];
    if (rescale) {
      pipeline.push({
        module: LinearRescale,
        props: { rescaleMin: rescale[0], rescaleMax: rescale[1] },
      });
    }
    if (state.stretch === "log") {
      pipeline.push({ module: LogStretch, props: { strength: 99 } });
    } else if (state.stretch === "sqrt") {
      pipeline.push({ module: SqrtStretch });
    }
    if (state.gamma !== 1) {
      pipeline.push({ module: Gamma, props: { gamma: state.gamma } });
    }
    pipeline.push({
      module: Colormap,
      props: { colormapTexture, colormapIndex, reversed: false },
    });
    return { renderPipeline: pipeline };
  };
}
