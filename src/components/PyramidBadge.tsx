import { useEffect, useState } from "react";

/** Convert the internal displayIndex (`1` = coarsest overview … `N` = finest
 * native, the shared `tile-activity` convention used by both render hosts) to
 * OME-Zarr dataset numbering for display: `0` = finest (full resolution) …
 * `N-1` = coarsest overview, matching the dataset paths microscopy tools
 * (vizarr/napari) use. Pure so it can be unit-tested. */
export function omeLevelLabel(
  level: number,
  levelCount: number,
): { shown: number; max: number } {
  return { shown: levelCount - level, max: levelCount - 1 };
}

/** Bottom-left overlay showing the current pyramid level and a tiles-loading
 * dot. Works for both render hosts (fed by `src/render/tile-activity.ts`).
 * Renders nothing when there's neither a multiscale level nor activity.
 *
 * `level`/`levelCount` arrive as a displayIndex (1 = coarsest … N = finest) but
 * are shown in OME-Zarr dataset numbering (0 = finest native … N-1 = coarsest)
 * via {@link omeLevelLabel}. `downsample` (when given) is the level's factor vs
 * finest. */
export function PyramidBadge({
  level,
  levelCount,
  downsample,
  loading,
}: {
  level: number | null;
  levelCount: number | null;
  downsample: number | null;
  loading: boolean;
}) {
  // Debounce the loading dot so quick cache hits don't flash it.
  const [showLoading, setShowLoading] = useState(false);
  useEffect(() => {
    if (!loading) {
      setShowLoading(false);
      return;
    }
    const t = setTimeout(() => setShowLoading(true), 150);
    return () => clearTimeout(t);
  }, [loading]);

  const hasLevel = level != null && levelCount != null && levelCount > 1;
  if (!hasLevel && !showLoading) return null;

  return (
    <div
      className="panel mono"
      style={{
        position: "absolute",
        left: 12,
        bottom: 12,
        zIndex: 16,
        pointerEvents: "none",
        padding: "4px 8px",
        fontSize: 11,
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      {hasLevel && (
        <span>
          {(() => {
            const { shown, max } = omeLevelLabel(level, levelCount);
            return `Level ${shown}/${max}`;
          })()}
          {downsample != null ? ` · 1:${downsample}` : ""}
        </span>
      )}
      {showLoading && (
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span className="pyramid-badge__dot" aria-hidden="true" />
          <span style={{ color: "var(--text-muted)" }}>loading…</span>
        </span>
      )}
    </div>
  );
}
