import { beforeEach, describe, expect, it } from "vitest";
import {
  getSnapshot,
  reset,
  setActiveLevel,
  setPyramid,
  tileLoadEnd,
  tileLoadStart,
} from "./tile-activity";

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
