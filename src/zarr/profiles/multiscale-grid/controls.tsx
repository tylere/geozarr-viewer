import type { ProfileControlsProps } from "../../profile";
import type { MultiscaleGridContext, MultiscaleGridState } from "./types";

/** Multiscale-grid has no per-store data selectors (single 2-D variable);
 * the chassis provides colormap / rescale / opacity. Show a one-line note
 * about the pyramid in the "styling" bucket so the panel isn't empty. */
export function MultiscaleGridControls({
  ctx,
  group,
}: ProfileControlsProps<MultiscaleGridContext, MultiscaleGridState>) {
  if (group && group !== "styling") return null;
  return (
    <div className="field-label" style={{ textTransform: "none" }}>
      <span className="mono" style={{ color: "var(--text-muted)" }}>
        {ctx.variable} · {ctx.levelCount}-level pyramid ·{" "}
        {ctx.crsCode ?? "projected"}
      </span>
    </div>
  );
}
