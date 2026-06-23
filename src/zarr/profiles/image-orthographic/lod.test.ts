import { describe, expect, it } from "vitest";
import {
  buildSelection,
  buildWindowSelection,
  computeWindow,
  pickLevelForZoom,
} from "./lod";
import type { OmeAxis } from "./types";

describe("pickLevelForZoom", () => {
  const ds = [1, 2, 4, 8, 16, 32]; // 6 levels, finest-first

  it("picks the finest level when zoomed in past native (zoom > 0)", () => {
    expect(pickLevelForZoom(1, ds)).toBe(0);
    expect(pickLevelForZoom(0, ds)).toBe(0); // 2^0 = 1 → only d=1 qualifies
  });

  it("picks coarser levels as the view zooms out (zoom < 0)", () => {
    expect(pickLevelForZoom(-1, ds)).toBe(1); // 2^1 = 2 → coarsest d≤2 is d=2
    expect(pickLevelForZoom(-2, ds)).toBe(2); // 2^2 = 4 → d=4
    expect(pickLevelForZoom(-3, ds)).toBe(3); // d=8
  });

  it("clamps to the coarsest level when zoomed far out", () => {
    expect(pickLevelForZoom(-10, ds)).toBe(5); // all qualify → coarsest
  });

  it("returns 0 for an empty pyramid", () => {
    expect(pickLevelForZoom(-5, [])).toBe(0);
  });
});

describe("buildSelection", () => {
  const cyx: OmeAxis[] = [
    { name: "c", type: "channel" },
    { name: "y", type: "space" },
    { name: "x", type: "space" },
  ];

  it("pins the channel and leaves the spatial pair full", () => {
    expect(buildSelection(cyx, 0, { yIndex: 1, xIndex: 2 }, 3, {})).toEqual([
      3,
      null,
      null,
    ]);
  });

  it("pins z/t axes from indices, defaulting missing ones to 0", () => {
    const tczyx: OmeAxis[] = [
      { name: "t", type: "time" },
      { name: "c", type: "channel" },
      { name: "z", type: "space" }, // (depth treated as non-spatial here)
      { name: "y", type: "space" },
      { name: "x", type: "space" },
    ];
    // spatial pair = last two (y, x); t and z are "other" axes.
    const sel = buildSelection(tczyx, 1, { yIndex: 3, xIndex: 4 }, 2, {
      t: 5,
    });
    expect(sel).toEqual([5, 2, 0, null, null]); // t=5, c=2, z default 0
  });
});

describe("computeWindow", () => {
  it("covers the whole image at fit-zoom (snaps + clamps to bounds)", () => {
    const w = computeWindow({
      targetX: 100,
      targetY: 50,
      zoom: 1, // scale 2; half = canvas/2/2
      canvasW: 400,
      canvasH: 200,
      worldW: 200,
      worldH: 100,
      downsample: 1,
      levelW: 200,
      levelH: 100,
      chunkW: 64,
      chunkH: 64,
    });
    expect(w).toEqual({ x0: 0, y0: 0, x1: 200, y1: 100 });
  });

  it("returns a viewport-sized chunk-snapped window when zoomed into a huge level", () => {
    const w = computeWindow({
      targetX: 72192,
      targetY: 46592,
      zoom: 2, // scale 4 → ~250×200 world px visible
      canvasW: 1000,
      canvasH: 800,
      worldW: 144384,
      worldH: 93184,
      downsample: 1,
      levelW: 144384,
      levelH: 93184,
      chunkW: 1024,
      chunkH: 1024,
    });
    // Small window aligned to 1024 chunks — NOT the whole gigapixel level.
    expect(w).toEqual({ x0: 71680, y0: 46080, x1: 72704, y1: 47104 });
    expect((w.x1 - w.x0) * (w.y1 - w.y0)).toBe(1024 * 1024);
  });
});

describe("buildWindowSelection", () => {
  const tczyx: OmeAxis[] = [
    { name: "t", type: "time" },
    { name: "c", type: "channel" },
    { name: "z", type: "space" },
    { name: "y", type: "space" },
    { name: "x", type: "space" },
  ];

  it("slices the spatial pair and pins channel + z/t", () => {
    const sel = buildWindowSelection(
      tczyx,
      1,
      { yIndex: 3, xIndex: 4 },
      2,
      { t: 7 },
      [100, 612], // x range
      [200, 456], // y range
    );
    // t=7, c=2, z default 0 are integer pins; y/x are slices.
    expect(sel[0]).toBe(7);
    expect(sel[1]).toBe(2);
    expect(sel[2]).toBe(0);
    expect(sel[3]).toMatchObject({ start: 200, stop: 456 }); // y
    expect(sel[4]).toMatchObject({ start: 100, stop: 612 }); // x
  });
});
