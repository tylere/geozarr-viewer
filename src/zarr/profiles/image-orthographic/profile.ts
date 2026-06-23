import * as zarr from "zarrita";
import { autoStatsFromGlobal, buildBandStats } from "../../../render/stats";
import { openV3Group } from "../../load-zarr";
import type { ZarrProfile } from "../../profile";
import { ImageOrthographicControls } from "./controls";
import { buildSelection } from "./lod";
import { parseOme } from "./ome";
import type {
  ImageOrthographicContext,
  ImageOrthographicState,
} from "./types";

/** Non-geographic image profile for OME-Zarr bioimaging stores.
 *
 * Microscopy OME-Zarr has no CRS or lat/lon coords — it's pixel-space data
 * (typically `t,c,z,y,x` with channels). The geographic `scalar-grid` profile
 * rejects it, so this profile renders into a standalone deck.gl
 * `OrthographicView` instead of the MapLibre map (see {@link ImageViewer}).
 *
 * MVP scope: load the coarsest pyramid level whole and show one channel as a
 * grayscale BitmapLayer. Tiling, z/t scrubbing, and pixel-value hover are
 * Stage 2. Select with `?p=image-orthographic`. */
export const imageOrthographicProfile: ZarrProfile<
  ImageOrthographicState,
  ImageOrthographicContext
> = {
  id: "image-orthographic",
  label: "Image (OME-Zarr)",
  host: "image",
  needsColormap: false,

  async prepare(url, signal) {
    // OME-Zarr ships no consolidated metadata; open plain and descend.
    // `version: "auto"` so OME-Zarr v0.4 (zarr v2) stores open too.
    const opened = await openV3Group(url, {
      consolidated: false,
      version: "auto",
    });
    const ome = await parseOme(opened.group, signal);
    // Cheap version probe for the Structure panel: v3 stores have a root
    // `zarr.json`; v0.4 (v2) stores don't.
    let zarrVersion: "v2" | "v3" = "v3";
    try {
      const head = await fetch(`${url.replace(/\/+$/, "")}/zarr.json`, {
        method: "HEAD",
        signal,
      });
      zarrVersion = head.ok ? "v3" : "v2";
    } catch {
      // Network/abort — leave the v3 default.
    }
    return {
      url,
      zarrVersion,
      group: opened.group,
      seriesPath: ome.seriesPath,
      axes: ome.axes,
      channelAxisIndex: ome.channelAxisIndex,
      spatialAxes: ome.spatialAxes,
      otherAxes: ome.otherAxes,
      channels: ome.channels,
      channelCount: ome.channelCount,
      levels: ome.levels,
      width: ome.width,
      height: ome.height,
      finestVariablePath: ome.finestVariablePath,
    };
  },

  initialState(ctx) {
    // Default to the first omero-active channel, else channel 0.
    const firstActive = ctx.channels.findIndex((c) => c.active);
    // z / time axes start at index 0.
    const indices: Record<string, number> = {};
    for (const a of ctx.otherAxes) indices[a.name] = 0;
    return {
      channel: firstActive >= 0 ? firstActive : 0,
      indices,
      colormap: "gray",
      gamma: 1,
      rescale: null, // auto (percentile) — see computeAutoStats
    };
  },

  parseUrlParams(p) {
    const out: Partial<ImageOrthographicState> = {};
    const c = p.get("c");
    if (c !== null && Number.isFinite(Number(c))) out.channel = Number(c);
    // Non-spatial axis pins serialize as `dim.<name>=<index>`.
    const indices: Record<string, number> = {};
    for (const [k, v] of p.entries()) {
      if (k.startsWith("dim.") && Number.isFinite(Number(v))) {
        indices[k.slice(4)] = Number(v);
      }
    }
    if (Object.keys(indices).length > 0) out.indices = indices;
    const cmap = p.get("colormap");
    if (cmap) out.colormap = cmap;
    const gamma = p.get("gamma");
    if (gamma !== null && Number.isFinite(Number(gamma))) out.gamma = Number(gamma);
    const rmin = p.get("rmin");
    const rmax = p.get("rmax");
    if (
      rmin !== null &&
      rmax !== null &&
      Number.isFinite(Number(rmin)) &&
      Number.isFinite(Number(rmax))
    ) {
      out.rescale = [Number(rmin), Number(rmax)];
    }
    return out;
  },

  serializeUrlParams(s) {
    const out: Record<string, string | null> = {
      c: String(s.channel),
      colormap: s.colormap,
      gamma: String(s.gamma),
      // null clears the param (back to auto).
      rmin: s.rescale ? String(s.rescale[0]) : null,
      rmax: s.rescale ? String(s.rescale[1]) : null,
    };
    for (const [name, idx] of Object.entries(s.indices)) {
      out[`dim.${name}`] = String(idx);
    }
    return out;
  },

  Controls: ImageOrthographicControls,

  // Expose the finest-level array as the chassis `node` so the Structure panel
  // shows its shape/dtype/chunks.
  resolveNode: async (ctx) => ctx.levels[0]!.array,

  // Rendering happens in ImageViewer (OrthographicView), not via a deck.gl
  // layer in the map overlay.
  buildLayer: () => null,

  // Stats over the coarsest level for the current channel/z/t — drives the
  // rescale slider's bounds + auto (percentile) default. Recomputed only when
  // the selection changes (statsDeps), not on styling tweaks.
  statsDeps: (s) => [s.channel, JSON.stringify(s.indices)],
  async computeAutoStats({ ctx, state, signal }) {
    const level = ctx.levels[ctx.levels.length - 1]!;
    const sel = buildSelection(
      ctx.axes,
      ctx.channelAxisIndex,
      ctx.spatialAxes,
      state.channel,
      state.indices,
    );
    const chunk = await zarr.get(
      level.array as zarr.Array<zarr.NumberDataType, zarr.Readable>,
      sel,
      { signal },
    );
    const stats = buildBandStats(chunk.data as ArrayLike<number>, null);
    return stats ? autoStatsFromGlobal(stats) : null;
  },

  pyramidLevelCount: (ctx) => ctx.levels.length,

  getStructure: (ctx) => ({
    zarrVersion: ctx.zarrVersion,
    variables: [{ path: ctx.finestVariablePath }],
    metadataSource: "store-native",
    metadata: { ome: (ctx.group.attrs as Record<string, unknown>).ome },
  }),
};
