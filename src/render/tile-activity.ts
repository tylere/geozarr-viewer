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
// Per-level downsample factors (displayIndex order: index 0 = coarsest).
// Null when the active profile doesn't expose per-level scale info.
let levelDownsamples: number[] | null = null;

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

/** Return the downsample factor for a displayIndex level from the stored array,
 * or null when no downsample table is set. */
function downsampleForLevel(level: number | null): number | null {
  if (level == null || !levelDownsamples) return null;
  return levelDownsamples[level - 1] ?? null; // displayIndex is 1-based
}

/** Declare (or clear) the pyramid for the active store. `null` levelCount means
 * single-level / non-multiscale — the badge then omits the level. When
 * `downsamples` is provided it is an array in displayIndex order (index 0 =
 * coarsest level) of downsample factors relative to the finest level; the badge
 * then shows a scale ratio (e.g. "1:4") alongside the level. */
export function setPyramid(levelCount: number | null, downsamples?: number[] | null): void {
  levelDownsamples = levelCount != null && downsamples ? downsamples : null;
  set({
    levelCount,
    downsample: levelCount == null ? null : state.downsample,
    level: levelCount == null ? null : state.level,
  });
}

/** Image host: report the exact displayed level + downsample. */
export function setActiveLevel(level: number, downsample: number | null = null): void {
  set({ level, downsample });
}

/** Map host: report the level currently DISPLAYED, derived from deck.gl's
 * selected tiles rather than from fetches — so revisiting an already-cached
 * zoom still updates the badge. (`tileLoadStart`/`tileLoadEnd` only fire on
 * cache misses, so on their own the badge goes stale when deck reuses cached
 * tiles.) `tiles` are a TileLayer's `selectedTiles` (`index.z`: 0 = coarsest);
 * the finest LOADED one is what the user actually sees, so its displayIndex
 * (`z + 1`) is the displayed level.
 *
 * No-op for non-multiscale stores (no level badge) and while a fetch is in
 * flight — during a load the burst path (`tileLoadStart`/`tileLoadEnd`) owns
 * the level, and deck only fires this once the selected tiles are all loaded. */
export function reportDisplayedTiles(
  tiles: { index: { z: number }; isLoaded?: boolean }[],
): void {
  if (state.levelCount == null || state.inFlight > 0) return;
  let maxZ = -1;
  for (const t of tiles) {
    if (t?.isLoaded === false) continue;
    const z = t?.index?.z;
    if (typeof z === "number" && z > maxZ) maxZ = z;
  }
  if (maxZ < 0) return;
  const level = maxZ + 1; // displayIndex: deck z=0 (coarsest) → level 1
  const nextDs = levelDownsamples != null ? downsampleForLevel(level) : state.downsample;
  set({ level, downsample: nextDs });
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
  // Update downsample from the per-level table when available (map host);
  // preserve the existing value when the table is absent (image host sets it
  // via setActiveLevel and we must not overwrite it here).
  const nextDs = levelDownsamples != null ? downsampleForLevel(next) : state.downsample;
  set({ inFlight: state.inFlight + 1, level: next, downsample: nextDs });
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
  const nextDs = levelDownsamples != null ? downsampleForLevel(next) : state.downsample;
  set({ inFlight, level: next, downsample: nextDs });
}

/** Clear everything (store/profile change). */
export function reset(): void {
  burstMax = null;
  levelDownsamples = null;
  state = { inFlight: 0, level: null, levelCount: null, downsample: null };
  emit();
}
