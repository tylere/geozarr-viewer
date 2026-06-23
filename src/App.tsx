import type { MapboxOverlayProps } from "@deck.gl/mapbox";
import { MapboxOverlay } from "@deck.gl/mapbox";
import {
  createColormapTexture,
  decodeColormapSprite,
} from "@developmentseed/deck.gl-raster/gpu-modules";
import colormapsPngUrl from "@developmentseed/deck.gl-raster/gpu-modules/colormaps.png";
import type { Device, Texture } from "@luma.gl/core";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type * as zarr from "zarrita";
import type { MapRef } from "react-map-gl/maplibre";
import { Map as MaplibreMap, useControl } from "react-map-gl/maplibre";
import { isDarkChrome, resolveBasemap } from "./basemaps";
import { ControlsPanel } from "./components/ControlsPanel";
import { EmptyState } from "./components/EmptyState";
import { formatNumber } from "./components/RangeSlider";
import { FullscreenButton } from "./components/FullscreenButton";
import { ArrayOverview, StructureSection } from "./components/StructurePanel";
import { humanizeError, Toast } from "./components/Toast";
import { ZoomHint } from "./components/ZoomHint";
import { createLogger } from "./log";
import { installKeepMinZoomTiles } from "./render/keep-min-zoom-tiles";
import type { AutoStats } from "./render/stats";
import { subscribeTileHealth } from "./zarr/tile-error";
import { detectProfile, normalizeStoreUrl } from "./source";
import { MultiscaleStoreError } from "./zarr/multiscale";
import { getProfile } from "./zarr/profiles";
import {
  buildExampleLoadPatch,
  type ExampleLoadRequest,
} from "./state/load-example";
import { mergeProfileState } from "./state/merge-profile-state";
import { useViewerState } from "./state/useViewerState";
import type { AnyZarrProfile, ProfileBaseContext } from "./zarr/profile";
import {
  fetchCodecSummary,
  type CodecSummary,
  type StructureProfileSummary,
} from "./zarr/structure";

const log = createLogger("app");

// Keep already-loaded tiles painted when zoomed out past a layer's minZoom
// (deck.gl-zarr would otherwise blank the map below the threshold).
installKeepMinZoomTiles();

const darkMql = window.matchMedia("(prefers-color-scheme: dark)");
const subscribeColorScheme = (cb: () => void) => {
  darkMql.addEventListener("change", cb);
  return () => darkMql.removeEventListener("change", cb);
};
const getColorSchemeSnapshot = () => darkMql.matches;
const usePrefersDark = () =>
  useSyncExternalStore(subscribeColorScheme, getColorSchemeSnapshot, () => false);

function DeckGLOverlay(
  props: MapboxOverlayProps & { onDeviceInitialized?: (d: Device) => void },
) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props));
  overlay.setProps(props);
  return null;
}


export default function App() {
  const mapRef = useRef<MapRef>(null);
  const { state, update, params, updateParams } = useViewerState();
  const prefersDark = usePrefersDark();
  const [device, setDevice] = useState<Device | null>(null);
  const [colormapTexture, setColormapTexture] = useState<Texture | null>(null);
  const [profileCtx, setProfileCtx] = useState<ProfileBaseContext | null>(null);
  const [node, setNode] = useState<
    zarr.Array<zarr.DataType, zarr.Readable> | zarr.Group<zarr.Readable> | null
  >(null);
  const [autoStats, setAutoStats] = useState<AutoStats | null>(null);
  const [codecSummary, setCodecSummary] = useState<CodecSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  // True when tiles are repeatedly failing to load (non-abort). Drives a
  // non-blocking "loading slowly" notice; reset when a tile next succeeds or
  // the user dismisses it.
  const [tilesDegraded, setTilesDegraded] = useState(false);
  const [tileNoticeDismissed, setTileNoticeDismissed] = useState(false);
  const [firstSymbolId, setFirstSymbolId] = useState<string | undefined>();
  // True while a programmatic flyTo animation is in flight. The layer
  // `useMemo` returns null when set, so tiles aren't requested for the
  // animation's intermediate viewports — only for the final settled view.
  const [isAnimatingView, setIsAnimatingView] = useState(false);
  // Live map zoom, used only to drive the zoom-in hint (kept out of chassis
  // `state` so it never re-triggers layer construction). Updated on `zoom`
  // events, including the programmatic initial flyTo. `mapSettled` gates the
  // hint until the camera first comes to rest, so it doesn't flash during
  // that flyTo from the default z2 world view; a URL with an explicit view
  // is "settled" from the start.
  const [viewZoom, setViewZoom] = useState<number>(() => state.view?.[2] ?? 2);
  const [mapSettled, setMapSettled] = useState<boolean>(() => !!state.view);

  // Hover-value tooltip. The cursor read is rAF-throttled (one re-render per
  // frame); `hover` is local state and is NOT a layer dep, so it never rebuilds
  // the layer.
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    lines: string[];
  } | null>(null);
  const hoverRaf = useRef<number | null>(null);
  const hoverPt = useRef<{
    lng: number;
    lat: number;
    px: number;
    py: number;
  } | null>(null);

  useEffect(() => {
    setFirstSymbolId(undefined);
  }, [state.basemap]);

  // Profile selection. Default = scalar-grid; if its prepare throws
  // `MultiscaleStoreError` (a multiscale pyramid), the prepare effect below
  // records the switch in `autoProfile`, keyed to the url so a stale value
  // never leaks onto a different store.
  const [autoProfile, setAutoProfile] = useState<{ url: string; id: string } | null>(
    null,
  );
  const profile: AnyZarrProfile | null = useMemo(() => {
    if (state.profileId) return detectProfile(state.url, state.profileId);
    if (!state.url) return null;
    if (autoProfile && autoProfile.url === state.url) {
      return getProfile(autoProfile.id);
    }
    return detectProfile(state.url, null); // scalar-grid default
  }, [state.url, state.profileId, autoProfile]);

  // Re-derive profile state on every render from URL params (defaults
  // come from profile.initialState; URL overrides win).
  const profileState = useMemo(() => {
    if (!profile || !profileCtx) return null;
    const base = profile.initialState(profileCtx);
    const overrides = profile.parseUrlParams(params);
    return mergeProfileState(base, overrides);
  }, [profile, profileCtx, params]);

  const updateProfileState = useCallback(
    (patch: Record<string, unknown>) => {
      if (!profile || !profileState) return;
      const merged = { ...profileState, ...patch };
      updateParams(profile.serializeUrlParams(merged));
    },
    [profile, profileState, updateParams],
  );

  const handleHoverMove = useCallback(
    (e: { lngLat: { lng: number; lat: number }; point: { x: number; y: number } }) => {
      if (!profile?.sampleValue || !profileCtx || !profileState) return;
      hoverPt.current = {
        lng: e.lngLat.lng,
        lat: e.lngLat.lat,
        px: e.point.x,
        py: e.point.y,
      };
      if (hoverRaf.current != null) return;
      hoverRaf.current = requestAnimationFrame(() => {
        hoverRaf.current = null;
        const pt = hoverPt.current;
        if (!pt || !profile?.sampleValue || !profileCtx || !profileState) {
          setHover(null);
          return;
        }
        const res = profile.sampleValue(profileCtx, profileState, pt.lng, pt.lat);
        if (!res) {
          setHover(null);
          return;
        }
        const valueText =
          res.value === null
            ? "no data"
            : `${formatNumber(res.value)}${res.units ? ` ${res.units}` : ""}`;
        setHover({
          x: pt.px,
          y: pt.py,
          lines: [
            res.label,
            valueText,
            `${pt.lat.toFixed(3)}, ${pt.lng.toFixed(3)}`,
          ],
        });
      });
    },
    [profile, profileCtx, profileState],
  );

  const handleHoverOut = useCallback(() => {
    if (hoverRaf.current != null) {
      cancelAnimationFrame(hoverRaf.current);
      hoverRaf.current = null;
    }
    hoverPt.current = null;
    setHover(null);
  }, []);

  // Cancel any pending rAF on unmount.
  useEffect(() => {
    return () => {
      if (hoverRaf.current != null) cancelAnimationFrame(hoverRaf.current);
    };
  }, []);

  // Open store + prepare profile context whenever (url, profile) changes.
  useEffect(() => {
    setProfileCtx(null);
    setNode(null);
    setAutoStats(null);
    setError(null);
    if (!state.url || !profile) return;
    const ctrl = new AbortController();
    log.info(`load: profile "${profile.id}" url=${state.url}`);
    (async () => {
      try {
        const ctx = await profile.prepare(state.url!, ctrl.signal);
        if (ctrl.signal.aborted) return;
        log.info("profile context ready");
        setProfileCtx(ctx);
        // Skip the profile's auto-fit when the URL has explicit view
        // params — the user's view wins.
        if (state.view) return;
        const bounds = profile.initialBounds?.(ctx);
        if (bounds) {
          mapRef.current?.fitBounds(
            [
              [bounds[0], bounds[1]],
              [bounds[2], bounds[3]],
            ],
            { padding: 40, duration: 600 },
          );
        }
      } catch (err) {
        if (ctrl.signal.aborted) return;
        if (err instanceof MultiscaleStoreError) {
          // The default profile detected a multiscale pyramid → switch to the
          // multiscale-grid profile (which re-runs prepare). No error toast.
          if (!state.profileId && state.url) {
            log.info("switching to multiscale-grid profile");
            setAutoProfile({ url: state.url, id: "multiscale-grid" });
          }
          return;
        }
        log.error("profile.prepare failed", err);
        setError(humanizeError(err));
      }
    })();
    return () => ctrl.abort();
    // state.view is read above but intentionally excluded from deps:
    // user-driven view updates must not retrigger a fitBounds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.url, profile]);

  // After ctx is ready and the URL didn't pin a view, fly to the
  // profile's preferred initial view (e.g. AEF's location preset).
  useEffect(() => {
    if (!profile || !profileCtx || !profileState) return;
    if (state.view) return;
    const view = profile.initialView?.(profileCtx, profileState);
    if (view) {
      mapRef.current?.flyTo({
        center: [view.longitude, view.latitude],
        zoom: view.zoom,
        duration: 600,
      });
    }
    // Only fire on profile/ctx change, not on every state tick. state.view
    // is read for gating but excluded — see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id, profileCtx]);

  // Stable string keys for the profile-provided dep lists. Spreading the
  // arrays directly into a `useEffect` dep array would change the array
  // *length* whenever the profile / dep shape changes, which React
  // forbids. Serializing collapses them to a single primitive key.
  const resolveNodeDepsKey =
    profile && profileState
      ? JSON.stringify(profile.resolveNodeDeps?.(profileState) ?? [])
      : "";
  const statsDepsKey =
    profile && profileState
      ? JSON.stringify(
          profile.statsDeps?.(profileState) ??
            profile.resolveNodeDeps?.(profileState) ??
            [],
        )
      : "";

  // Resolve the layer's `node` (group or pre-opened array).
  useEffect(() => {
    if (!profile || !profileCtx || !profileState) {
      setNode(null);
      return;
    }
    if (!profile.resolveNode) {
      setNode(profileCtx.group);
      return;
    }
    const ctrl = new AbortController();
    (async () => {
      try {
        const resolved = await profile.resolveNode!(
          profileCtx,
          profileState,
          ctrl.signal,
        );
        if (!ctrl.signal.aborted) setNode(resolved);
      } catch (err) {
        if (ctrl.signal.aborted) return;
        log.error("profile.resolveNode failed", err);
        setError(humanizeError(err));
      }
    })();
    return () => ctrl.abort();
    // profileState is read inside the effect; the deps that should
    // re-trigger it are captured by `resolveNodeDepsKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, profileCtx, resolveNodeDepsKey]);

  // Compute auto-stats per profile.
  useEffect(() => {
    if (!profile?.computeAutoStats || !profileCtx || !profileState) return;
    const ctrl = new AbortController();
    setAutoStats(null);
    (async () => {
      try {
        const stats = await profile.computeAutoStats!({
          ctx: profileCtx,
          state: profileState,
          signal: ctrl.signal,
        });
        if (!ctrl.signal.aborted) {
          const g = stats?.global;
          log.debug(
            g
              ? `autoStats range [${g.min}, ${g.max}]`
              : "autoStats: none (no finite samples)",
          );
          setAutoStats(stats);
        }
      } catch (err) {
        if (ctrl.signal.aborted) return;
        log.warn("computeAutoStats failed", err);
      }
    })();
    return () => ctrl.abort();
    // Profiles narrow `statsDeps` (e.g. FTW returns `[time, band]`) so
    // stats recompute only on those changes, not on every dim-slider tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, profileCtx, statsDepsKey]);

  // Surface repeated (non-abort) tile-load failures as a non-blocking notice.
  // The counter ignores AbortErrors, so routine pan/zoom pruning never trips
  // it; a successful tile clears it (and re-arms the dismissable notice).
  useEffect(() => {
    return subscribeTileHealth((degraded) => {
      log.info(degraded ? "tiles degraded (repeated failures)" : "tiles recovered");
      setTilesDegraded(degraded);
      if (!degraded) setTileNoticeDismissed(false);
    });
  }, []);

  // Decode + upload the colormap sprite once the device is ready (only
  // needed for single-band/colormapped profiles).
  useEffect(() => {
    if (!device || !profile?.needsColormap) return;
    let cancelled = false;
    (async () => {
      const resp = await fetch(colormapsPngUrl);
      const bytes = await resp.arrayBuffer();
      const image = await decodeColormapSprite(bytes);
      if (cancelled) return;
      setColormapTexture(createColormapTexture(device, image));
    })();
    return () => {
      cancelled = true;
    };
  }, [device, profile?.needsColormap]);

  // Profile's read-only structure summary (drives the Structure panel).
  // Recomputed on every render — it's a pure pick of fields already in
  // state. Cheap.
  const structureSummary: StructureProfileSummary | null = useMemo(() => {
    if (!profile || !profileCtx || !profileState) return null;
    return profile.getStructure(profileCtx, profileState);
  }, [profile, profileCtx, profileState]);

  // Fetch the primary variable's codec / sharding info for the Structure
  // panel. One small HTTP request per (url, variable) change.
  useEffect(() => {
    if (!state.url || !structureSummary) {
      setCodecSummary(null);
      return;
    }
    const primary = structureSummary.variables[0];
    const ctrl = new AbortController();
    setCodecSummary(null);
    (async () => {
      const summary = await fetchCodecSummary(
        state.url!,
        primary.path,
        ctrl.signal,
      );
      if (!ctrl.signal.aborted) setCodecSummary(summary);
    })();
    return () => ctrl.abort();
    // structureSummary.variables[0].path is captured via the JSON key
    // below — primitives only, stable across same-value renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.url, structureSummary?.variables[0]?.path]);

  const layer = useMemo(() => {
    // Suppress layer construction while a flyTo is in flight so deck.gl
    // doesn't request tiles for the animation's intermediate viewports.
    // Cleared on the underlying Map's `moveend` (see `handleFlyTo`).
    if (isAnimatingView) return null;
    if (!profile || !profileCtx || !profileState) return null;
    return profile.buildLayer({
      ctx: profileCtx,
      state: profileState,
      chassisState: state,
      device,
      colormapTexture,
      autoStats,
      basemapBeforeId:
        state.labelsAbove &&
        state.basemap !== "satellite" &&
        state.basemap !== "off"
          ? firstSymbolId
          : undefined,
      node,
    });
  }, [
    isAnimatingView,
    profile,
    profileCtx,
    profileState,
    state,
    device,
    colormapTexture,
    autoStats,
    firstSymbolId,
    node,
  ]);

  const handleFlyTo = useCallback(
    (longitude: number, latitude: number, zoom: number) => {
      const map = mapRef.current;
      if (!map) return;
      // Gate the layer; the React `onMoveEnd` handler below clears the
      // flag when the animation settles. (`map.once("moveend", ...)`
      // doesn't reliably bubble through react-map-gl's MapRef proxy,
      // so we use the React event prop, which is supported.)
      setIsAnimatingView(true);
      map.flyTo({ center: [longitude, latitude], zoom, duration: 600 });
    },
    [],
  );

  const handleLoad = useCallback(
    (request: ExampleLoadRequest) => {
      // Current URL params win over example defaults (so a shared link
      // round-trips), then example defaults fill gaps, then the chassis
      // render fields reset. See `buildExampleLoadPatch`.
      const cur = new URLSearchParams(window.location.search);
      const patch = buildExampleLoadPatch(cur, {
        url: normalizeStoreUrl(request.url),
        params: request.params,
      });
      // Update the URL first so EmptyState dismisses and `state.url` is
      // set; the layer would otherwise mount mid-animation, but the
      // `isAnimatingView` gate handles that.
      updateParams(patch);
      // Then animate to the destination — the gate ensures tiles only
      // load once the camera settles.
      if (
        typeof patch.lng === "string" &&
        typeof patch.lat === "string" &&
        typeof patch.zoom === "string"
      ) {
        const lng = Number(patch.lng);
        const lat = Number(patch.lat);
        const zoom = Number(patch.zoom);
        if (
          Number.isFinite(lng) &&
          Number.isFinite(lat) &&
          Number.isFinite(zoom)
        ) {
          handleFlyTo(lng, lat, zoom);
        }
      }
    },
    [updateParams, handleFlyTo],
  );

  const darkChrome = isDarkChrome(state.basemap, prefersDark);
  useEffect(() => {
    document.documentElement.classList.toggle("theme-dark", darkChrome);
  }, [darkChrome]);

  const showSingleBandControls = profile?.needsColormap ?? false;

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <MaplibreMap
        ref={mapRef}
        initialViewState={
          state.view
            ? {
                longitude: state.view[0],
                latitude: state.view[1],
                zoom: state.view[2],
              }
            : { longitude: 0, latitude: 20, zoom: 2 }
        }
        mapStyle={resolveBasemap(state.basemap, prefersDark)}
        onStyleData={(e) => {
          const layers = e.target.getStyle()?.layers ?? [];
          const next = layers.find((l) => l.type === "symbol")?.id;
          setFirstSymbolId((prev) => (prev === next ? prev : next));
        }}
        onZoom={(e) => {
          // Drive the zoom-in hint. Skip no-op updates (round to 0.1) so a
          // zoom gesture doesn't re-render every frame.
          const z = e.viewState.zoom;
          setViewZoom((prev) =>
            Math.round(prev * 10) === Math.round(z * 10) ? prev : z,
          );
        }}
        onMoveEnd={(e) => {
          setMapSettled(true);
          const isProgrammatic = !e.originalEvent;
          if (isProgrammatic) {
            // Programmatic move (flyTo / fitBounds). Clear the
            // animation gate so the layer can mount at the settled
            // viewport. Don't write to URL — only user-driven moves do.
            setIsAnimatingView(false);
            return;
          }
          const c = e.target.getCenter();
          const z = e.target.getZoom();
          update({ view: [c.lng, c.lat, z] });
        }}
        onMouseMove={handleHoverMove}
        onMouseOut={handleHoverOut}
      >
        <DeckGLOverlay
          layers={layer ? [layer] : []}
          interleaved
          // Deck writes `cursor` inline on the shared canvas container on every
          // pointer move (default grab/grabbing), which overrides any CSS — so
          // the crosshair must be set here. Grabbing still shows while panning.
          getCursor={({ isDragging }) => (isDragging ? "grabbing" : "crosshair")}
          onDeviceInitialized={setDevice}
        />
      </MaplibreMap>

      {profile && profileCtx && profileState && (
        <ControlsPanel
          state={state}
          update={update}
          showSingleBandControls={showSingleBandControls}
          autoStats={autoStats}
          onFlyTo={handleFlyTo}
          profileFetchSlot={profile.Controls({
            ctx: profileCtx,
            state: profileState,
            update: updateProfileState,
            chassisState: state,
            chassisUpdate: update,
            autoStats,
            onFlyTo: handleFlyTo,
            group: "fetch",
          })}
          profileInstantSlot={profile.Controls({
            ctx: profileCtx,
            state: profileState,
            update: updateProfileState,
            chassisState: state,
            chassisUpdate: update,
            autoStats,
            onFlyTo: handleFlyTo,
            group: "instant",
          })}
          profileStyleSlot={profile.Controls({
            ctx: profileCtx,
            state: profileState,
            update: updateProfileState,
            chassisState: state,
            chassisUpdate: update,
            autoStats,
            onFlyTo: handleFlyTo,
            group: "styling",
          })}
          overviewSlot={
            structureSummary ? (
              <ArrayOverview
                state={state}
                group={profileCtx.group}
                structure={structureSummary}
                node={node}
              />
            ) : null
          }
          structureSlot={
            structureSummary ? (
              <StructureSection
                state={state}
                update={update}
                group={profileCtx.group}
                node={node}
                structure={structureSummary}
                codecs={codecSummary}
              />
            ) : null
          }
        />
      )}

      {(() => {
        // Per-store min-zoom (scalar-grid derives it from resolution) overrides
        // the profile's static value for the zoom-in hint.
        const minZoom = profileCtx?.minRenderZoom ?? profile?.minRenderZoom;
        return (
          mapSettled &&
          profileCtx != null &&
          minZoom != null &&
          viewZoom < minZoom && (
            <ZoomHint current={viewZoom} threshold={minZoom} />
          )
        );
      })()}

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
            style={{
              padding: "4px 8px",
              fontSize: 11,
              lineHeight: 1.4,
              whiteSpace: "nowrap",
            }}
          >
            {hover.lines.map((line, i) => (
              <div
                key={i}
                style={
                  i === hover.lines.length - 1
                    ? { color: "var(--text-muted)" }
                    : undefined
                }
              >
                {line}
              </div>
            ))}
          </div>
        </div>
      )}

      <Toast message={error} onDismiss={() => setError(null)} />

      {/* Non-fatal notice; the red error toast (above) takes precedence. */}
      <Toast
        intent="warn"
        message={
          tilesDegraded && !tileNoticeDismissed && !error
            ? "Tiles are loading slowly or failing — your connection may be slow."
            : null
        }
        onDismiss={() => setTileNoticeDismissed(true)}
      />

      <FullscreenButton />

      {!state.url && <EmptyState onSubmit={handleLoad} />}
    </div>
  );
}
