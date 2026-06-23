import { COLORMAP_INDEX } from "@developmentseed/deck.gl-raster/gpu-modules";
import colormapsPngUrl from "@developmentseed/deck.gl-raster/gpu-modules/colormaps.png";
import type { ReactNode } from "react";
import { findMatchingLocation, LOCATIONS } from "../locations";
import type { AutoStats } from "../render/stats";
import { percentileFromHistogram } from "../render/stats";
import type {
  Basemap,
  Stretch,
  ViewerState,
  ViewerStateUpdate,
} from "../state/types";
import { ColormapPicker, type ColormapOption } from "./ColormapPicker";
import { RangeSlider } from "./RangeSlider";

const BASEMAP_OPTIONS: { value: Basemap; label: string }[] = [
  { value: "auto", label: "Auto (system)" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "satellite", label: "Satellite" },
  { value: "off", label: "None" },
];

const STRETCH_OPTIONS: { value: Stretch; label: string }[] = [
  { value: "linear", label: "Linear" },
  { value: "log", label: "Log" },
  { value: "sqrt", label: "Sqrt" },
];

const COLORMAP_NAMES = Object.keys(COLORMAP_INDEX).sort();
const COLORMAP_ROW_COUNT = Object.keys(COLORMAP_INDEX).length;
const COLORMAP_OPTIONS: ColormapOption[] = COLORMAP_NAMES.map((name) => ({
  name,
  label: name,
  rowIndex: (COLORMAP_INDEX as Record<string, number>)[name] ?? 0,
}));

type Props = {
  state: ViewerState;
  update: (patch: ViewerStateUpdate) => void;
  /** Profile controls that refetch chunks on change (variable, fetched dims). */
  profileFetchSlot: ReactNode;
  /** Profile controls backed by a preloaded texture array — instant, no
   * refetch (e.g. ECMWF lead_time). `null` when the profile has none. */
  profileInstantSlot: ReactNode;
  /** Profile display-only controls (e.g. AEF rescale). `null` when none. */
  profileStyleSlot: ReactNode;
  /** Always-visible store identity + dimensions table, shown above the Data
   * controls. `null` while the structure summary is still resolving. */
  overviewSlot: ReactNode;
  /** Store-introspection content (the former Structure panel), rendered as a
   * collapsible section below "View". `null` while the structure summary is
   * still resolving. */
  structureSlot: ReactNode;
  /** Whether to show single-band colormap + rescale controls. */
  showSingleBandControls: boolean;
  /** False for non-geographic (image) hosts — hides map-only controls
   * (basemap, location presets). */
  geographic: boolean;
  autoStats: AutoStats | null;
  /** Animated map move. Wired to the location dropdown so picking a
   * preset both moves the map and updates the URL. */
  onFlyTo: (longitude: number, latitude: number, zoom: number) => void;
};

export function ControlsPanel({
  state,
  update,
  profileFetchSlot,
  profileInstantSlot,
  profileStyleSlot,
  overviewSlot,
  structureSlot,
  showSingleBandControls,
  geographic,
  autoStats,
  onFlyTo,
}: Props) {
  const isOpen = state.panel === "open";
  return (
    <div className="controls-panel">
      <details
        className="panel"
        open={isOpen}
        onToggle={(e) =>
          update({
            panel: (e.target as HTMLDetailsElement).open ? "open" : "closed",
          })
        }
        style={{ padding: 12 }}
      >
        <summary style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="panel-header">Options</span>
        </summary>

        <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
          {overviewSlot}

          <ControlGroup
            variant="fetch"
            title="Data · re-reads on change"
            caption="Loads new chunks from the store — may be slow for large chunks."
          >
            {profileFetchSlot}
          </ControlGroup>

          {profileInstantSlot && (
            <ControlGroup
              variant="instant"
              title="Data · instant"
              caption="Pre-loaded into GPU memory — scrubs instantly, no fetch."
            >
              {profileInstantSlot}
            </ControlGroup>
          )}

          <ControlGroup
            variant="style"
            title="Styling"
            caption="Display only — applies immediately."
          >
            {profileStyleSlot}
            {showSingleBandControls && (
              <>
                <label style={{ display: "grid", gap: 4 }}>
                  <span className="field-label">Colormap</span>
                  <ColormapPicker
                    colormapsPngUrl={colormapsPngUrl}
                    rowCount={COLORMAP_ROW_COUNT}
                    value={state.colormap ?? "viridis"}
                    options={COLORMAP_OPTIONS}
                    onChange={(name) => update({ colormap: name })}
                  />
                </label>
                <RescaleEditor
                  state={state}
                  update={update}
                  autoStats={autoStats}
                />
                <label style={{ display: "grid", gap: 4 }}>
                  <span className="field-label">Stretch</span>
                  <select
                    value={state.stretch}
                    onChange={(e) =>
                      update({ stretch: e.target.value as Stretch })
                    }
                  >
                    {STRETCH_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ display: "grid", gap: 4 }}>
                  <span
                    className="field-label"
                    style={{ display: "flex", justifyContent: "space-between" }}
                  >
                    <span>Gamma</span>
                    <span className="mono" style={{ textTransform: "none" }}>
                      {state.gamma.toFixed(2)}
                    </span>
                  </span>
                  <input
                    type="range"
                    min={0.1}
                    max={3}
                    step={0.05}
                    value={state.gamma}
                    onChange={(e) => update({ gamma: Number(e.target.value) })}
                  />
                </label>
              </>
            )}
            <label style={{ display: "grid", gap: 4 }}>
              <span
                className="field-label"
                style={{ display: "flex", justifyContent: "space-between" }}
              >
                <span>Opacity</span>
                <span className="mono" style={{ textTransform: "none" }}>
                  {Math.round(state.opacity * 100)}%
                </span>
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={state.opacity}
                onChange={(e) => update({ opacity: Number(e.target.value) })}
              />
            </label>
            {geographic && (
              <label style={{ display: "grid", gap: 4 }}>
                <span className="field-label">Basemap</span>
                <select
                  value={state.basemap}
                  onChange={(e) =>
                    update({ basemap: e.target.value as Basemap })
                  }
                >
                  {BASEMAP_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </ControlGroup>

          {geographic && (
            <div className="section">
              <span className="section-title">View</span>
              <div style={{ display: "grid", gap: 4, marginTop: 6 }}>
                <LocationPicker
                  state={state}
                  update={update}
                  onFlyTo={onFlyTo}
                />
              </div>
            </div>
          )}

          {structureSlot}
        </div>
      </details>
    </div>
  );
}

const GROUP_GLYPH: Record<"fetch" | "instant" | "style", string> = {
  fetch: "⟳",
  instant: "⚡",
  style: "🎨",
};

/** A styled, captioned box grouping controls by cost/kind. The accent colour
 * and glyph are driven by `variant` (see `.control-group--*` in styles.css). */
function ControlGroup({
  variant,
  title,
  caption,
  children,
}: {
  variant: "fetch" | "instant" | "style";
  title: string;
  caption: string;
  children: ReactNode;
}) {
  return (
    <section className={`control-group control-group--${variant}`}>
      <span className="control-group__title">
        <span aria-hidden="true">{GROUP_GLYPH[variant]}</span>
        {title}
      </span>
      <span className="control-group__caption">{caption}</span>
      <div style={{ display: "grid", gap: 10, marginTop: 8 }}>{children}</div>
    </section>
  );
}

function LocationPicker({
  state,
  update,
  onFlyTo,
}: {
  state: ViewerState;
  update: (patch: ViewerStateUpdate) => void;
  onFlyTo: (longitude: number, latitude: number, zoom: number) => void;
}) {
  // The dropdown's selected value derives from state.view (the URL). When
  // the user pans/zooms manually, the match flips to "" ("Custom view").
  const match = findMatchingLocation(state.view);
  const value = match?.id ?? "";
  const handleChange = (id: string) => {
    const loc = LOCATIONS.find((l) => l.id === id);
    if (!loc) return;
    // Trigger the animated map move first, then write the new view to
    // the URL. The flyTo's `moveend` fires without `originalEvent`, so
    // App.onMoveEnd won't double-write.
    onFlyTo(loc.longitude, loc.latitude, loc.zoom);
    update({ view: [loc.longitude, loc.latitude, loc.zoom] });
  };
  return (
    <select
      aria-label="location"
      value={value}
      onChange={(e) => handleChange(e.target.value)}
    >
      <option value="" disabled>
        {value === "" ? "Custom view" : "Choose a preset…"}
      </option>
      {LOCATIONS.map((l) => (
        <option key={l.id} value={l.id}>
          {l.label}
        </option>
      ))}
    </select>
  );
}

function RescaleEditor({
  state,
  update,
  autoStats,
}: {
  state: ViewerState;
  update: (patch: ViewerStateUpdate) => void;
  autoStats: AutoStats | null;
}) {
  // Use existing rescale or fall back to a 2-98% percentile of autoStats
  // for the displayed default.
  const auto = autoStats?.global ?? null;
  const fallback: [number, number] | null = auto
    ? [
        percentileFromHistogram(auto, 0.02),
        percentileFromHistogram(auto, 0.98),
      ]
    : null;
  const value = state.rescale ?? fallback;

  // Slider track bounds: the data's full range (from autoStats), widened to
  // include the current handles when they sit outside it (e.g. a shared link
  // with a rescale beyond the data range). With no stats, pad around the value
  // so the handles have room to move.
  let bounds: [number, number] | null = null;
  if (value) {
    const [lo, hi] = value;
    const pad = Math.abs(hi - lo) || Math.max(Math.abs(lo), Math.abs(hi), 1);
    let bmin = auto ? Math.min(auto.min, lo) : lo - pad;
    let bmax = auto ? Math.max(auto.max, hi) : hi + pad;
    if (bmin >= bmax) {
      bmin = lo - pad;
      bmax = hi + pad;
    }
    bounds = [bmin, bmax];
  }

  return (
    <div style={{ display: "grid", gap: 4 }}>
      <span
        className="field-label"
        style={{ display: "flex", justifyContent: "space-between" }}
      >
        <span>Rescale (min → max)</span>
        {state.rescale ? (
          <button
            type="button"
            style={{
              fontSize: 10,
              padding: "2px 6px",
              background: "transparent",
              border: "none",
              color: "var(--text-muted)",
              textTransform: "none",
            }}
            onClick={() => update({ rescale: null })}
          >
            reset
          </button>
        ) : (
          <span
            className="mono"
            style={{ color: "var(--text-muted)", textTransform: "none" }}
          >
            auto
          </span>
        )}
      </span>
      {value && bounds ? (
        <RangeSlider
          min={bounds[0]}
          max={bounds[1]}
          value={value}
          onCommit={(next) => update({ rescale: next })}
        />
      ) : (
        <span
          className="mono"
          style={{
            color: "var(--text-muted)",
            fontSize: 11,
            textTransform: "none",
          }}
        >
          Adjust once data statistics load.
        </span>
      )}
    </div>
  );
}
