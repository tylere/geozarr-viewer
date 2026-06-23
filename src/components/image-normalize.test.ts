import { describe, expect, it } from "vitest";
import { styleToRgba } from "./image-normalize";

describe("styleToRgba", () => {
  it("maps window endpoints to 0 and 255 and writes opaque grayscale", () => {
    // 2×1 image, window [0,100]: 0 → 0, 100 → 255.
    const rgba = styleToRgba([0, 100], 2, 1, 0, 100, 1);
    expect(rgba).toHaveLength(8);
    expect(Array.from(rgba)).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
  });

  it("clamps values outside the window", () => {
    const rgba = styleToRgba([-50, 200], 2, 1, 0, 100, 1);
    expect(rgba[0]).toBe(0); // below floor → 0
    expect(rgba[4]).toBe(255); // above ceiling → 255
  });

  it("maps the window midpoint to ~128 at gamma 1", () => {
    const rgba = styleToRgba([50], 1, 1, 0, 100, 1);
    expect(rgba[0]).toBe(128);
  });

  it("brightens the midpoint when gamma > 1", () => {
    // t=0.5, gamma=2 → 0.5^(1/2) ≈ 0.707 → ~180.
    const rgba = styleToRgba([50], 1, 1, 0, 100, 2);
    expect(rgba[0]).toBeGreaterThan(170);
    expect(rgba[0]).toBeLessThan(190);
  });

  it("applies a colormap LUT instead of grayscale", () => {
    // 256-entry LUT where entry k = (k, 255-k, 0). t=1 → entry 255 → (255,0,0).
    const lut = new Uint8Array(256 * 4);
    for (let k = 0; k < 256; k++) {
      lut[k * 4] = k;
      lut[k * 4 + 1] = 255 - k;
      lut[k * 4 + 2] = 0;
      lut[k * 4 + 3] = 255;
    }
    const rgba = styleToRgba([100], 1, 1, 0, 100, 1, lut);
    expect(Array.from(rgba.slice(0, 4))).toEqual([255, 0, 0, 255]);
  });
});
