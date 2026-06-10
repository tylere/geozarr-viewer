import { ZarrLayer } from "@developmentseed/deck.gl-zarr";
import * as zarr from "zarrita";
import { createLogger } from "../../../log";
import { buildSingleBandRenderTile } from "../../../render/single-band-pipeline";
import type { MultiBandTileData } from "../../../render/shared-textures";
import { autoStatsFromGlobal, buildBandStats } from "../../../render/stats";
import { buildGeoZarrMetadata, parseMultiscaleDatasets } from "../../multiscale";
import { openV3Group } from "../../load-zarr";
import type { ZarrProfile } from "../../profile";
import { makeScalarGridTileLoader } from "../scalar-grid/tile-loader";
import { MultiscaleGridControls } from "./controls";
import type { MultiscaleGridContext, MultiscaleGridState } from "./types";

const log = createLogger("profile");

/** Name of the data array inside each `<scale>/` level group. CF/rioxarray
 * multiscale stores name it after the variable; Meta CHM uses `chm`. We pick
 * the single array child that isn't the CF `spatial_ref` grid-mapping aux. */
function pickLevelArrayName(
  contents: { path: string; kind: "array" | "group" }[],
  scale: string,
): string | null {
  const prefix = `${scale}/`;
  const arrays = contents
    .filter((e) => e.kind === "array")
    .map((e) => e.path.replace(/^\/+/, ""))
    .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
    .map((p) => p.slice(prefix.length));
  const data = arrays.find((n) => n !== "spatial_ref");
  return data ?? null;
}

const R = 6378137; // WGS84 semi-major axis (EPSG:3857 sphere radius)
const mercX = (lng: number) => R * (lng * Math.PI) / 180;
const mercY = (lat: number) =>
  R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

export const multiscaleGridProfile: ZarrProfile<
  MultiscaleGridState,
  MultiscaleGridContext
> = {
  id: "multiscale-grid",
  label: "Multiscale grid (colormap)",
  needsColormap: true,

  async prepare(url, signal) {
    const done = log.time("multiscale-grid prepare", "info");
    const opened = await openV3Group(url, { consolidated: true });
    const datasets = parseMultiscaleDatasets(opened.group.attrs); // coarsest→finest
    if (!datasets) {
      throw new Error("Not a multiscale store (no `multiscales` root attr).");
    }
    const consolidated = (
      opened.store as { contents?: () => { path: string; kind: "array" | "group" }[] }
    ).contents?.();
    const contents = consolidated ?? [];

    const levels: {
      asset: string;
      geoTransform: number[];
      shape: [number, number];
    }[] = [];
    let crsWkt = "";
    let crsCode: string | null = null;
    let dtype = "";
    let units: string | null = null;
    let longName: string | null = null;
    let variable = "chm";
    let coarsestArray: zarr.Array<zarr.DataType, zarr.Readable> | null = null;
    let coarsestGeoTransform: number[] = [];
    let finestPixelMeters = 0;
    let dims: [string, string] = ["y", "x"];
    let primaryPath = "";

    for (let i = 0; i < datasets.length; i++) {
      if (signal.aborted) throw new Error("aborted");
      const scale = datasets[i]!;
      const arrName = pickLevelArrayName(contents, scale) ?? "chm";
      const chm = await zarr.open.v3(
        opened.group.resolve(`${scale}/${arrName}`),
        { kind: "array" },
      );
      const sr = await zarr.open.v3(
        opened.group.resolve(`${scale}/spatial_ref`),
        { kind: "array" },
      );
      const nd = chm.shape.length;
      if (nd !== 2) {
        throw new Error(
          `Multiscale store: only 2-D [y,x] variables are supported (got ${nd}-D "${scale}/${arrName}").`,
        );
      }
      const gt = String(sr.attrs.GeoTransform ?? "")
        .trim()
        .split(/\s+/)
        .map(Number);
      if (gt.length < 6 || gt.some((n) => !Number.isFinite(n))) {
        throw new Error(
          `Multiscale store: invalid GeoTransform on "${scale}/spatial_ref".`,
        );
      }
      levels.push({
        asset: `${scale}/${arrName}`,
        geoTransform: gt,
        shape: [chm.shape[0]!, chm.shape[1]!],
      });
      if (typeof sr.attrs.crs_wkt === "string") crsWkt = sr.attrs.crs_wkt;
      if (typeof sr.attrs["proj:code"] === "string")
        crsCode = sr.attrs["proj:code"];
      if (i === 0) {
        coarsestArray = chm;
        coarsestGeoTransform = gt;
      }
      if (i === datasets.length - 1) {
        variable = arrName;
        dtype = chm.dtype;
        units = typeof chm.attrs.units === "string" ? chm.attrs.units : null;
        longName =
          typeof chm.attrs.long_name === "string" ? chm.attrs.long_name : null;
        finestPixelMeters = Math.abs(gt[1]!);
        primaryPath = `${scale}/${arrName}`;
        const dn = chm.dimensionNames;
        if (Array.isArray(dn) && dn.length === 2 && dn.every((d) => typeof d === "string")) {
          dims = [dn[0] as string, dn[1] as string];
        }
      }
    }
    if (!crsWkt) {
      throw new Error(
        "Multiscale store: no `crs_wkt` found in `spatial_ref` (can't resolve CRS).",
      );
    }
    const metadata = buildGeoZarrMetadata({ levels, crsWkt, dims });
    log.info(
      `prepared multiscale "${variable}" ${dtype} ${datasets.length} levels, ` +
        `${finestPixelMeters.toFixed(2)} m/px native, crs=${crsCode ?? "wkt"}`,
    );
    done();
    return {
      url,
      group: opened.group,
      store: opened.store,
      metadata,
      dtype,
      units,
      longName,
      variable,
      levelCount: datasets.length,
      finestPixelMeters,
      crsCode,
      coarsestArray: coarsestArray!,
      coarsestGeoTransform,
      primaryPath,
    };
  },

  initialState: () => ({}),
  parseUrlParams: () => ({}),
  serializeUrlParams: () => ({}),
  initialBounds: () => [-180, -85.0511, 180, 85.0511],
  Controls: MultiscaleGridControls,

  resolveNode: async (ctx) => ctx.group,
  resolveNodeDeps: () => [],
  statsDeps: () => [],

  buildLayer({ ctx, chassisState, colormapTexture, autoStats, basemapBeforeId, node }) {
    if (!node || !colormapTexture) return null;
    const renderTile = buildSingleBandRenderTile(
      {
        colormap: chassisState.colormap ?? "viridis",
        rescale: chassisState.rescale,
        gamma: chassisState.gamma,
        stretch: chassisState.stretch,
        nodata: null,
      },
      colormapTexture,
      autoStats,
    );
    return new ZarrLayer<zarr.Readable, zarr.DataType, MultiBandTileData>({
      id: `multiscale-grid-${ctx.variable}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      node: node as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      metadata: ctx.metadata as any,
      selection: {},
      getTileData: makeScalarGridTileLoader({ fillValue: null }),
      renderTile,
      opacity: chassisState.opacity,
      maxRequests: 20,
      maxCacheSize: 64,
      // beforeId is injected by @deck.gl/mapbox; attach via a wider cast.
      ...({ beforeId: basemapBeforeId } as Record<string, unknown>),
      updateTriggers: {
        renderTile: [
          chassisState.colormap,
          chassisState.rescale?.[0],
          chassisState.rescale?.[1],
          chassisState.gamma,
          chassisState.stretch,
          autoStats,
        ],
      },
    });
  },

  async computeAutoStats({ ctx, signal }) {
    // Sample a representative (vegetated) patch of the coarsest level rather
    // than the world centre (which is ocean): map an Amazon lng/lat to the
    // coarsest level's pixel grid via its GeoTransform.
    const arr = ctx.coarsestArray;
    const [h, w] = [arr.shape[0]!, arr.shape[1]!];
    const ph = Math.min(arr.chunks[0] ?? h, h);
    const pw = Math.min(arr.chunks[1] ?? w, w);
    const gt = ctx.coarsestGeoTransform;
    const [ox, px, , oy, , py] = gt;
    const centerCol = (mercX(-62) - (ox ?? 0)) / (px || 1);
    const centerRow = (mercY(-4) - (oy ?? 0)) / (py || -1);
    const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
    const rowStart = clamp(Math.floor(centerRow - ph / 2), Math.max(0, h - ph));
    const colStart = clamp(Math.floor(centerCol - pw / 2), Math.max(0, w - pw));
    let chunk: Awaited<ReturnType<typeof zarr.get>>;
    try {
      chunk = await zarr.get(
        arr as zarr.Array<zarr.NumberDataType, zarr.Readable>,
        [
          zarr.slice(rowStart, rowStart + ph),
          zarr.slice(colStart, colStart + pw),
        ],
        { signal },
      );
    } catch (err) {
      // The sample patch may sit on an unreadable/missing chunk (e.g. a store
      // whose data chunks icechunk-js can't resolve). Degrade gracefully —
      // the rescale falls back to its manual default.
      log.debug("computeAutoStats sample read failed", err);
      return null;
    }
    if (signal.aborted) return null;
    const raw = chunk.data as ArrayLike<number>;
    const decoded = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) decoded[i] = Number(raw[i]);
    const stats = buildBandStats(decoded, null);
    return stats ? autoStatsFromGlobal(stats) : null;
  },

  getStructure: (ctx) => ({
    zarrVersion: "v3",
    variables: [{ path: ctx.primaryPath, role: "finest" }],
    metadataSource: "synthesized",
    metadata: ctx.metadata,
  }),
};
