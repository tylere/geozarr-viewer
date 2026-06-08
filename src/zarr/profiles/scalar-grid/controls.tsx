import { DebouncedSlider } from "../../../components/DebouncedSlider";
import { StepperRange } from "../../../components/StepperRange";
import type { ProfileControlsProps } from "../../profile";
import { defaultDimIndices, type ScalarGridContext, type ScalarGridState } from "./types";

export function ScalarGridControls({
  ctx,
  state,
  update,
  group,
}: ProfileControlsProps<ScalarGridContext, ScalarGridState>) {
  const activeVar = ctx.variables.find((v) => v.name === state.variable);
  const texDim = activeVar?.textureDim ?? null;

  const sliderFor = (dim: { name: string; size: number }, live: boolean) => {
    const value = state.dimIndices[dim.name] ?? 0;
    const onChange = (v: number) =>
      update({ dimIndices: { ...state.dimIndices, [dim.name]: v } });
    // CF-decoded label (date / duration / value) when available, else index.
    const format =
      ctx.dimLabel[dim.name] ?? ((v: number) => `${v} / ${dim.size - 1}`);
    // "(live)" when the whole dim is GPU-resident; "(live · N/win)" when only a
    // window of N frames is loaded at a time (crossing a window refetches).
    const liveLabel =
      texDim && texDim.window < dim.size
        ? `${dim.name} (live · ${texDim.window}/win)`
        : `${dim.name} (live)`;
    return live ? (
      <LiveSlider
        key={dim.name}
        label={liveLabel}
        value={value}
        min={0}
        max={Math.max(0, dim.size - 1)}
        onChange={onChange}
        formatValue={format}
      />
    ) : (
      <DebouncedSlider
        key={dim.name}
        label={dim.name}
        value={value}
        min={0}
        max={Math.max(0, dim.size - 1)}
        onCommit={onChange}
        formatValue={format}
      />
    );
  };

  if (group === "styling") return null;

  // Instant bucket: the texture-array dim (if any) is a free shader uniform.
  if (group === "instant") {
    const dim = activeVar?.dims.find((d) => d.name === texDim?.name);
    if (!dim) return null;
    return <div style={{ display: "grid", gap: 10 }}>{sliderFor(dim, true)}</div>;
  }

  // Fetch bucket: variable picker + every non-texture dim (each refetches).
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <label style={{ display: "grid", gap: 4 }}>
        <span className="field-label">Variable</span>
        <select
          value={state.variable}
          onChange={(e) => {
            const next = ctx.variables.find((v) => v.name === e.target.value);
            // Reset dim indices to sensible defaults for the new variable —
            // its dim set (and sizes) may differ from the current one.
            update({
              variable: e.target.value,
              dimIndices: next ? defaultDimIndices(next) : {},
            });
          }}
        >
          {ctx.variables.map((v) => (
            <option key={v.name} value={v.name}>
              {v.longName ? `${v.name} — ${v.longName}` : v.name}
            </option>
          ))}
        </select>
        {activeVar?.units && (
          <span className="mono" style={{ color: "var(--text-muted)" }}>
            units: {activeVar.units}
          </span>
        )}
      </label>
      {activeVar?.dims
        .filter((dim) => dim.name !== texDim?.name)
        .map((dim) => sliderFor(dim, false))}
    </div>
  );
}

/** Controlled slider with no debounce — every change fires `onChange`. Use
 * for the texture-array dim, which updates a shader uniform (no refetch). */
function LiveSlider({
  label,
  value,
  min,
  max,
  onChange,
  formatValue,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  formatValue: (v: number) => string;
}) {
  return (
    <label style={{ display: "grid", gap: 2 }}>
      <span
        className="field-label"
        style={{ display: "flex", justifyContent: "space-between" }}
      >
        <span>{label}</span>
        <span className="mono" style={{ textTransform: "none" }}>
          {formatValue(value)}
        </span>
      </span>
      <StepperRange value={value} min={min} max={max} onChange={onChange} />
    </label>
  );
}
