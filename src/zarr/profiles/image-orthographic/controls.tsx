import { COLORMAP_INDEX } from "@developmentseed/deck.gl-raster/gpu-modules";
import colormapsPngUrl from "@developmentseed/deck.gl-raster/gpu-modules/colormaps.png";
import { ColormapPicker, type ColormapOption } from "../../../components/ColormapPicker";
import { RangeSlider } from "../../../components/RangeSlider";
import { StepperRange } from "../../../components/StepperRange";
import { percentileFromHistogram } from "../../../render/stats";
import type { ProfileControlsProps } from "../../profile";
import type { ImageOrthographicContext, ImageOrthographicState } from "./types";

const COLORMAP_ROW_COUNT = Object.keys(COLORMAP_INDEX).length;
const COLORMAP_OPTIONS: ColormapOption[] = Object.keys(COLORMAP_INDEX)
  .sort()
  .map((name) => ({
    name,
    label: name,
    rowIndex: (COLORMAP_INDEX as Record<string, number>)[name] ?? 0,
  }));

export function ImageOrthographicControls({
  ctx,
  state,
  update,
  autoStats,
  group,
}: ProfileControlsProps<ImageOrthographicContext, ImageOrthographicState>) {
  if (group === "styling") {
    return (
      <div style={{ display: "grid", gap: 10 }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span className="field-label">Colormap</span>
          <ColormapPicker
            colormapsPngUrl={colormapsPngUrl}
            rowCount={COLORMAP_ROW_COUNT}
            value={state.colormap}
            options={COLORMAP_OPTIONS}
            onChange={(name) => update({ colormap: name })}
          />
        </label>
        <RescaleControl
          rescale={state.rescale}
          autoStats={autoStats}
          onChange={(next) => update({ rescale: next })}
        />
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
      </div>
    );
  }

  // Channel + z/t pins re-read pixel data → "fetch" bucket.
  if (group !== "fetch") return null;

  const scrubAxes = ctx.otherAxes.filter((a) => a.size > 1);
  if (ctx.channelCount <= 1 && scrubAxes.length === 0) return null;

  const channelLabel =
    ctx.channels[state.channel]?.label ?? `channel ${state.channel}`;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {ctx.channelCount > 1 && (
        <AxisSlider
          label="Channel"
          value={state.channel}
          max={ctx.channelCount - 1}
          valueLabel={channelLabel}
          onChange={(v) => update({ channel: v })}
        />
      )}
      {scrubAxes.map((axis) => (
        <AxisSlider
          key={axis.name}
          label={axis.name}
          value={state.indices[axis.name] ?? 0}
          max={axis.size - 1}
          onChange={(v) =>
            update({ indices: { ...state.indices, [axis.name]: v } })
          }
        />
      ))}
    </div>
  );
}

function AxisSlider({
  label,
  value,
  max,
  valueLabel,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  valueLabel?: string;
  onChange: (next: number) => void;
}) {
  return (
    <label style={{ display: "grid", gap: 2 }}>
      <span
        className="field-label"
        style={{ display: "flex", justifyContent: "space-between" }}
      >
        <span>{label}</span>
        <span className="mono" style={{ textTransform: "none" }}>
          {value}
          {valueLabel ? ` · ${valueLabel}` : ` / ${max}`}
        </span>
      </span>
      <StepperRange value={value} min={0} max={Math.max(0, max)} onChange={onChange} />
    </label>
  );
}

/** Intensity window slider. With no explicit rescale, shows the auto 2–98%
 * percentile (from autoStats) and a muted "auto" tag; once set, a reset link
 * returns to auto. Bounds come from the data's full min/max. */
function RescaleControl({
  rescale,
  autoStats,
  onChange,
}: {
  rescale: [number, number] | null;
  autoStats: ProfileControlsProps<
    ImageOrthographicContext,
    ImageOrthographicState
  >["autoStats"];
  onChange: (next: [number, number] | null) => void;
}) {
  const stats = autoStats?.global ?? null;
  const fallback: [number, number] | null = stats
    ? [percentileFromHistogram(stats, 0.02), percentileFromHistogram(stats, 0.98)]
    : null;
  const value = rescale ?? fallback;

  let bounds: [number, number] | null = null;
  if (value) {
    const [lo, hi] = value;
    const pad = Math.abs(hi - lo) || Math.max(Math.abs(lo), Math.abs(hi), 1);
    let bmin = stats ? Math.min(stats.min, lo) : lo - pad;
    let bmax = stats ? Math.max(stats.max, hi) : hi + pad;
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
        {rescale ? (
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
            onClick={() => onChange(null)}
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
          onCommit={(next) => onChange(next)}
        />
      ) : (
        <span
          className="mono"
          style={{ color: "var(--text-muted)", fontSize: 11, textTransform: "none" }}
        >
          Adjust once statistics load.
        </span>
      )}
    </div>
  );
}
