import { describe, expect, it } from "vitest";
import { mergeProfileState } from "../state/merge-profile-state";

describe("mergeProfileState", () => {
  it("overrides scalar fields", () => {
    const base = { variable: "t2m", a: 1 };
    expect(mergeProfileState(base, { variable: "prmsl" })).toEqual({
      variable: "prmsl",
      a: 1,
    });
  });

  it("merges nested dimIndices one level deep (the bug fix)", () => {
    // URL pins only `step`; `init_time` default must survive. Mirrors the
    // generic profile's state shape (`dimIndices: Record<string, number>`).
    const base: { variable: string; dimIndices: Record<string, number> } = {
      variable: "PM25",
      dimIndices: { init_time: 917, step: 0 },
    };
    const overrides = { dimIndices: { step: 30 } };
    expect(mergeProfileState(base, overrides)).toEqual({
      variable: "PM25",
      dimIndices: { init_time: 917, step: 30 },
    });
  });

  it("leaves base untouched when overrides is empty", () => {
    const base = { variable: "t", dimIndices: { time: 5, level: 2 } };
    expect(mergeProfileState(base, {})).toEqual(base);
  });

  it("replaces (does not merge) array-valued fields", () => {
    const base = { rescale: [0, 1] as number[] };
    expect(mergeProfileState(base, { rescale: [2, 3] })).toEqual({
      rescale: [2, 3],
    });
  });
});
