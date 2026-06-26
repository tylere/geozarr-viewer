import { beforeEach, describe, expect, it } from "vitest";
import {
  getSnapshot,
  reportDisplayedTiles,
  reset,
  setActiveLevel,
  setPyramid,
  tileLoadEnd,
  tileLoadStart,
} from "./tile-activity";

const tile = (z: number, isLoaded = true) => ({ index: { x: 0, y: 0, z }, isLoaded });

beforeEach(() => reset());

describe("tile-activity", () => {
  it("counts in-flight reads and never goes negative", () => {
    expect(getSnapshot().inFlight).toBe(0);
    tileLoadStart();
    tileLoadStart();
    expect(getSnapshot().inFlight).toBe(2);
    tileLoadEnd();
    expect(getSnapshot().inFlight).toBe(1);
    tileLoadEnd();
    tileLoadEnd(); // extra end is clamped
    expect(getSnapshot().inFlight).toBe(0);
  });

  it("setPyramid(null) clears the level (single-level store)", () => {
    setActiveLevel(3, 8);
    setPyramid(null);
    expect(getSnapshot().levelCount).toBeNull();
    expect(getSnapshot().level).toBeNull();
    expect(getSnapshot().downsample).toBeNull();
  });

  it("setActiveLevel reports exact level + downsample (image host)", () => {
    setPyramid(11);
    setActiveLevel(9, 4);
    expect(getSnapshot()).toMatchObject({ level: 9, levelCount: 11, downsample: 4 });
  });

  it("updates the level at load START, before it finishes", () => {
    setPyramid(11);
    tileLoadStart(6); // load begins…
    expect(getSnapshot().level).toBe(6); // …level already shown
    expect(getSnapshot().inFlight).toBe(1);
    tileLoadEnd(); // settle (no level arg needed)
    expect(getSnapshot().level).toBe(6);
  });

  it("tracks the finest (max) level loaded within a burst, resetting per burst", () => {
    setPyramid(11);
    // Burst 1: a coarse fallback (z=2 → level 3) then the target (z=5 → 6).
    tileLoadStart(3);
    tileLoadEnd();
    tileLoadStart(6);
    tileLoadEnd();
    expect(getSnapshot().level).toBe(6); // finest in the burst
    expect(getSnapshot().inFlight).toBe(0);

    // Burst 2 (e.g. zoomed out): a coarser level only → level drops.
    tileLoadStart(2);
    tileLoadEnd();
    expect(getSnapshot().level).toBe(2);
  });

  it("reportDisplayedTiles tracks the finest displayed level without a fetch", () => {
    setPyramid(7, [64, 32, 16, 8, 4, 2, 1]); // displayIndex order: 0=coarsest
    // Zoomed in: deck shows tiles up to z=6 (finest) → displayIndex 7.
    reportDisplayedTiles([tile(5), tile(6)]);
    expect(getSnapshot()).toMatchObject({ level: 7, downsample: 1 });
    // Zoom back out to a cached coarser set (z=2) — no fetch, badge still updates.
    reportDisplayedTiles([tile(2)]);
    expect(getSnapshot()).toMatchObject({ level: 3, downsample: 16 });
  });

  it("reportDisplayedTiles ignores not-yet-loaded tiles and empty sets", () => {
    setPyramid(7, [64, 32, 16, 8, 4, 2, 1]);
    reportDisplayedTiles([tile(2)]);
    // A finer tile is selected but still loading → don't advance the level yet.
    reportDisplayedTiles([tile(2), tile(6, false)]);
    expect(getSnapshot().level).toBe(3);
    reportDisplayedTiles([]); // no tiles → no change
    expect(getSnapshot().level).toBe(3);
  });

  it("reportDisplayedTiles is a no-op for non-multiscale stores and during loads", () => {
    setPyramid(null); // single-level store
    reportDisplayedTiles([tile(3)]);
    expect(getSnapshot().level).toBeNull();

    setPyramid(7, [64, 32, 16, 8, 4, 2, 1]);
    tileLoadStart(2); // a fetch is in flight → the load path owns the level
    reportDisplayedTiles([tile(6)]);
    expect(getSnapshot().level).toBe(2);
  });

  it("reset clears all state", () => {
    setPyramid(5);
    setActiveLevel(2, 2);
    tileLoadStart();
    reset();
    expect(getSnapshot()).toEqual({
      inFlight: 0,
      level: null,
      levelCount: null,
      downsample: null,
    });
  });
});
