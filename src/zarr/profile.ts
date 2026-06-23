import type { Layer } from "@deck.gl/core";
import type { Device, Texture } from "@luma.gl/core";
import type { ReactNode } from "react";
import type * as zarr from "zarrita";
import type { AutoStats } from "../render/stats";
import type { ViewerState } from "../state/types";
import type { StructureProfileSummary } from "./structure";

/** Base context shape every profile's `prepare()` returns. Profiles extend
 * it with their own dataset-specific fields (variable list, dim sizes,
 * band labels, etc.). */
export type ProfileBaseContext = {
  url: string;
  group: zarr.Group<zarr.Readable>;
  /** Per-store lowest render zoom (e.g. derived from grid resolution). When
   * set, it overrides the profile's static `minRenderZoom` for the zoom hint. */
  minRenderZoom?: number;
};

/** Which bucket of controls to render. The Options panel groups controls by
 * cost/kind and asks each profile for one bucket at a time:
 *   - "fetch": data selectors that refetch chunks (variable, fetched dims)
 *   - "instant": data selectors backed by a preloaded texture array, scrubbed
 *     as a shader uniform (e.g. ECMWF lead_time, generic textureDim)
 *   - "styling": display-only knobs the profile owns (e.g. AEF rescale)
 * A profile returns `null` for buckets it has no controls in. */
export type ControlGroup = "fetch" | "instant" | "styling";

export type ProfileControlsProps<Ctx, S> = {
  ctx: Ctx;
  state: S;
  update: (patch: Partial<S>) => void;
  chassisState: ViewerState;
  chassisUpdate: (patch: Partial<ViewerState>) => void;
  autoStats: AutoStats | null;
  onFlyTo: (longitude: number, latitude: number, zoom: number) => void;
  /** Bucket to render. Omitted = render every control (back-compat). */
  group?: ControlGroup;
};

export type BuildLayerArgs<Ctx, S> = {
  ctx: Ctx;
  state: S;
  chassisState: ViewerState;
  device: Device | null;
  colormapTexture: Texture | null;
  autoStats: AutoStats | null;
  basemapBeforeId: string | undefined;
  /** The resolved `node` to hand to `ZarrLayer` — either a group or an
   * already-opened array (from {@link ZarrProfile.resolveNode}). Null
   * while the array is opening. */
  node:
    | zarr.Array<zarr.DataType, zarr.Readable>
    | zarr.Group<zarr.Readable>
    | null;
};

export type ZarrProfile<
  S extends object = object,
  Ctx extends ProfileBaseContext = ProfileBaseContext,
> = {
  id: string;
  label: string;
  /** Which render host the chassis mounts for this profile:
   *   - "map" (default): MapLibre + deck.gl overlay, geographic coords. The
   *     profile's `buildLayer` result is rendered there.
   *   - "image": a standalone deck.gl `OrthographicView` for non-geographic
   *     pixel-space data (bioimaging OME-Zarr). `buildLayer`/`initialBounds`/
   *     `initialView` are unused; the {@link ImageViewer} reads `ctx`+`state`
   *     directly. */
  host?: "map" | "image";
  prepare: (url: string, signal: AbortSignal) => Promise<Ctx>;
  initialState: (ctx: Ctx) => S;
  parseUrlParams: (p: URLSearchParams) => Partial<S>;
  serializeUrlParams: (s: S) => Record<string, string | null>;
  /** Initial bounds [west,south,east,north] for fitBounds after load. */
  initialBounds?: (ctx: Ctx) => [number, number, number, number] | null;
  /** Initial view (overrides initialBounds) for datasets that prefer flyTo. */
  initialView?: (ctx: Ctx, state: S) =>
    | { longitude: number; latitude: number; zoom: number }
    | null;
  /** Lowest map zoom at which this profile's layer renders tiles (matches
   * the layer's `minZoom`). When set, the chassis shows a "zoom in" hint
   * below it. Omit for profiles that render at every zoom. */
  minRenderZoom?: number;
  Controls: (props: ProfileControlsProps<Ctx, S>) => ReactNode;
  /** Open the variable array(s) needed by the current state. The result is
   * threaded into {@link BuildLayerArgs.node}. Profiles that render a
   * whole group can omit this; App.tsx will pass `ctx.group` as `node`. */
  resolveNode?: (
    ctx: Ctx,
    state: S,
    signal: AbortSignal,
  ) => Promise<
    zarr.Array<zarr.DataType, zarr.Readable> | zarr.Group<zarr.Readable>
  >;
  /** Keys in profile state that should re-trigger `resolveNode`. */
  resolveNodeDeps?: (state: S) => unknown[];
  /** Keys in profile state that should re-trigger `computeAutoStats`. If
   * omitted, the App falls back to the resolveNode deps. */
  statsDeps?: (state: S) => unknown[];
  buildLayer: (args: BuildLayerArgs<Ctx, S>) => Layer | null;
  /** Synchronously read the underlying data value at a lng/lat from
   * already-decoded tiles (no fetch) for the hover tooltip. Returns `null` when
   * off-grid or no tile is loaded there; a result with `value: null` means the
   * cell is fill/no-data. Profiles without a single scalar value (e.g. RGB
   * composites) omit this — the chassis then shows no tooltip. */
  sampleValue?: (
    ctx: Ctx,
    state: S,
    lng: number,
    lat: number,
  ) => { label: string; value: number | null; units: string | null } | null;
  /** Whether this profile uses single-band + colormap rendering (and so
   * needs the colormap sprite uploaded before layer construction). */
  needsColormap: boolean;
  /** Describe the store/variable shape currently being rendered. Used
   * by the Structure panel; pure function of `ctx` + `state`. */
  getStructure: (ctx: Ctx, state: S) => StructureProfileSummary;
  /** Number of pyramid levels for a multiscale store, used by the level badge.
   * Return `null` (or omit) for single-level / non-multiscale stores so the
   * badge shows no level. */
  pyramidLevelCount?: (ctx: Ctx) => number | null;
  computeAutoStats?: (args: {
    ctx: Ctx;
    state: S;
    signal: AbortSignal;
  }) => Promise<AutoStats | null>;
};

/** Erased registry type — profiles are stored without their state generic
 * so we can list them uniformly. Each entry's state shape is opaque to
 * callers that go through the registry. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyZarrProfile = ZarrProfile<any, any>;
