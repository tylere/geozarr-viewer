/**
 * Tiny pub/sub for "what pyramid level am I seeing, and are tiles loading?",
 * consumed by the corner badge via `useSyncExternalStore`. Mirrors the shape of
 * `src/zarr/tile-error.ts`: tile loaders (map host) and the ImageViewer (image
 * host) call into it from outside React.
 *
 * Levels are normalized to a **displayIndex** where 1 = coarsest overview and
 * N = finest native, so both hosts read the same way regardless of their
 * internal ordering (image levels are finest-first; deck tile `z` is
 * coarsest-first).
 */

export type TileActivity = {
  /** Number of in-flight network reads (windows or tiles). */
  inFlight: number;
  /** Current displayIndex (1=coarsest … N=finest), or null when unknown / the
   * store is single-level (non-pyramid). */
  level: number | null;
  /** Total pyramid levels, or null for a single-level / non-multiscale store. */
  levelCount: number | null;
  /** Downsample factor of the displayed level vs finest (1, 2, 4, …), when the
   * source provides it (image host). null otherwise. */
  downsample: number | null;
};

let state: TileActivity = { inFlight: 0, level: null, levelCount: null, downsample: null };
// Finest displayIndex seen during the current load burst (inFlight > 0). Lets
// the map host report the finest tile actually loaded, ignoring transient
// coarse fallbacks, and resets each burst so zooming out is reflected.
let burstMax: number | null = null;

const listeners = new Set<() => void>();
let scheduled = false;

/** Coalesce rapid changes (many tiles settling at once) into one notify. */
function emit(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    for (const l of listeners) l();
  });
}

function set(next: Partial<TileActivity>): void {
  state = { ...state, ...next };
  emit();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot(): TileActivity {
  return state;
}

/** Declare (or clear) the pyramid for the active store. `null` levelCount means
 * single-level / non-multiscale — the badge then omits the level. */
export function setPyramid(levelCount: number | null, downsample: number | null = null): void {
  set({
    levelCount,
    downsample: levelCount == null ? null : downsample,
    level: levelCount == null ? null : state.level,
  });
}

/** Image host: report the exact displayed level + downsample. */
export function setActiveLevel(level: number, downsample: number | null = null): void {
  set({ level, downsample });
}

/** A network read started. `level` (displayIndex), when given, updates the
 * displayed level immediately — so the badge reflects the level being loaded
 * before it finishes. The finest level seen this burst wins. */
export function tileLoadStart(level?: number): void {
  if (state.inFlight === 0) burstMax = null; // new burst
  let next = state.level;
  if (level != null) {
    burstMax = burstMax == null ? level : Math.max(burstMax, level);
    next = burstMax;
  }
  set({ inFlight: state.inFlight + 1, level: next });
}

/** A network read settled (success, error, or abort). `level` (displayIndex),
 * when given, updates the displayed level to the finest seen this burst. */
export function tileLoadEnd(level?: number): void {
  const inFlight = Math.max(0, state.inFlight - 1);
  let next = state.level;
  if (level != null) {
    burstMax = burstMax == null ? level : Math.max(burstMax, level);
    next = burstMax;
  }
  set({ inFlight, level: next });
}

/** Clear everything (store/profile change). */
export function reset(): void {
  burstMax = null;
  state = { inFlight: 0, level: null, levelCount: null, downsample: null };
  emit();
}
