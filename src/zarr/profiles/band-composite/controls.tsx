import { StepperRange } from "../../../components/StepperRange";
import type { ProfileControlsProps } from "../../profile";
import { YEAR_ORIGIN } from "./constants";
import type { BandCompositeContext, BandCompositeState } from "./types";

export function BandCompositeControls({
  ctx,
  state,
  update,
  group,
}: ProfileControlsProps<BandCompositeContext, BandCompositeState>) {
  const labels = ctx.bandLabels;

  // Styling bucket: rescale is a shader rescale — display only, no refetch.
  if (group === "styling") {
    return (
      <div style={{ display: "grid", gap: 4 }}>
        <span className="field-label">Rescale (dequantized)</span>
        <div style={{ display: "grid", gap: 4, gridTemplateColumns: "1fr 1fr" }}>
          <input
            type="number"
            aria-label="rescaleMin"
            step={0.01}
            value={state.rescaleMin}
            onChange={(e) => update({ rescaleMin: Number(e.target.value) })}
          />
          <input
            type="number"
            aria-label="rescaleMax"
            step={0.01}
            value={state.rescaleMax}
            onChange={(e) => update({ rescaleMax: Number(e.target.value) })}
          />
        </div>
      </div>
    );
  }
  if (group === "instant") return null;

  // Fetch bucket: year + band pickers each re-read different bands.
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <label style={{ display: "grid", gap: 4 }}>
        <span className="field-label">Year</span>
        <select
          value={state.year}
          onChange={(e) => update({ year: Number(e.target.value) })}
        >
          {Array.from({ length: ctx.yearCount }, (_, i) => (
            <option key={i} value={i}>
              {YEAR_ORIGIN + i}
            </option>
          ))}
        </select>
      </label>

      <BandSlider
        label="Red band"
        value={state.rBand}
        labels={labels}
        maxBand={ctx.bandCount - 1}
        onChange={(v) => update({ rBand: v })}
      />
      <BandSlider
        label="Green band"
        value={state.gBand}
        labels={labels}
        maxBand={ctx.bandCount - 1}
        onChange={(v) => update({ gBand: v })}
      />
      <BandSlider
        label="Blue band"
        value={state.bBand}
        labels={labels}
        maxBand={ctx.bandCount - 1}
        onChange={(v) => update({ bBand: v })}
      />
    </div>
  );
}

function BandSlider({
  label,
  value,
  labels,
  maxBand,
  onChange,
}: {
  label: string;
  value: number;
  labels: readonly string[];
  maxBand: number;
  onChange: (next: number) => void;
}) {
  const labelText = labels[value] ?? `band ${value}`;
  return (
    <label style={{ display: "grid", gap: 2 }}>
      <span
        className="field-label"
        style={{ display: "flex", justifyContent: "space-between" }}
      >
        <span>{label}</span>
        <span className="mono" style={{ textTransform: "none" }}>
          {value} · {labelText}
        </span>
      </span>
      <StepperRange
        value={value}
        min={0}
        max={Math.max(0, maxBand)}
        onChange={onChange}
      />
    </label>
  );
}
