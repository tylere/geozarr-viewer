type Props = {
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
};

/** A range slider flanked by step-back / step-forward buttons. The buttons
 * nudge the value by one step (clamped to [min, max]) and disable at the
 * bounds; the slider itself behaves exactly as a bare `<input type="range">`.
 * Shared by every dimension scrubber (LiveSlider / DebouncedSlider /
 * BandSlider) so a single click advances one frame without dragging. */
export function StepperRange({ value, min, max, onChange }: Props) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <button
        type="button"
        className="step-btn"
        aria-label="Step back"
        disabled={value <= min}
        onClick={() => onChange(clamp(value - 1))}
      >
        <Chevron dir="left" />
      </button>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ flex: 1 }}
      />
      <button
        type="button"
        className="step-btn"
        aria-label="Step forward"
        disabled={value >= max}
        onClick={() => onChange(clamp(value + 1))}
      >
        <Chevron dir="right" />
      </button>
    </div>
  );
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points={dir === "left" ? "15 18 9 12 15 6" : "9 18 15 12 9 6"} />
    </svg>
  );
}
