import { describe, expect, it } from "vitest";
import { omeLevelLabel } from "./PyramidBadge";

describe("omeLevelLabel", () => {
  it("maps a 3-level image: finest → 0/2, coarsest → 2/2", () => {
    // displayIndex N = finest, 1 = coarsest.
    expect(omeLevelLabel(3, 3)).toEqual({ shown: 0, max: 2 }); // finest
    expect(omeLevelLabel(1, 3)).toEqual({ shown: 2, max: 2 }); // coarsest
  });

  it("maps a 7-level pyramid (e.g. Meta CHM): finest → 0/6, coarsest → 6/6", () => {
    expect(omeLevelLabel(7, 7)).toEqual({ shown: 0, max: 6 }); // finest
    expect(omeLevelLabel(1, 7)).toEqual({ shown: 6, max: 6 }); // coarsest
  });

  it("maps a partial map-host burst (finest loaded so far) sensibly", () => {
    // Only coarse tiles loaded → displayIndex 4 of 7 → OME index 3.
    expect(omeLevelLabel(4, 7)).toEqual({ shown: 3, max: 6 });
  });
});
