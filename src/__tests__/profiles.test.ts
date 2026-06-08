import { describe, expect, it } from "vitest";
import { bandCompositeProfile } from "../zarr/profiles/band-composite/profile";
import { scalarGridProfile } from "../zarr/profiles/scalar-grid/profile";
import { detectProfile } from "../source";
import { isIcechunkUrl } from "../zarr/load-zarr";

describe("profile URL params round-trip", () => {
  it("scalar-grid serializes + parses (variable + dim indices)", () => {
    const state = {
      variable: "t2m",
      dimIndices: { time: 42, level: 3 },
    };
    const params = new URLSearchParams(
      Object.entries(scalarGridProfile.serializeUrlParams(state)).filter(
        (kv): kv is [string, string] => typeof kv[1] === "string",
      ),
    );
    expect(scalarGridProfile.parseUrlParams(params)).toEqual(state);
  });

  it("band-composite serializes + parses", () => {
    const state = {
      year: 8,
      rBand: 0,
      gBand: 16,
      bBand: 32,
      rescaleMin: -0.3,
      rescaleMax: 0.3,
    };
    const params = new URLSearchParams(
      Object.entries(bandCompositeProfile.serializeUrlParams(state)).filter(
        (kv): kv is [string, string] => typeof kv[1] === "string",
      ),
    );
    expect(bandCompositeProfile.parseUrlParams(params)).toEqual(state);
  });

  it("band-composite clamps band index out of range", () => {
    const parsed = bandCompositeProfile.parseUrlParams(
      new URLSearchParams("r=200"),
    );
    expect(parsed.rBand).toBe(63);
  });
});

describe("isIcechunkUrl", () => {
  it("detects a .icechunk store", () => {
    expect(isIcechunkUrl("https://data.source.coop/bkr/gfs/gfs.icechunk")).toBe(
      true,
    );
  });

  it("detects with a trailing slash or query", () => {
    expect(isIcechunkUrl("https://x/y.icechunk/")).toBe(true);
    expect(isIcechunkUrl("https://x/y.icechunk?p=scalar-grid")).toBe(true);
  });

  it("is false for plain .zarr stores", () => {
    expect(isIcechunkUrl("https://data.source.coop/x/global.zarr")).toBe(false);
  });
});

describe("profile selection (capability-based)", () => {
  it("defaults any store to scalar-grid", () => {
    expect(
      detectProfile("https://data.source.coop/x/global.zarr", null)?.id,
    ).toBe("scalar-grid");
    expect(
      detectProfile("https://data.source.coop/bkr/gfs/gfs.icechunk", null)?.id,
    ).toBe("scalar-grid");
  });

  it("honors an explicit ?p=band-composite override", () => {
    expect(
      detectProfile("https://data.source.coop/tge-labs/aef-mosaic", "band-composite")
        ?.id,
    ).toBe("band-composite");
  });

  it("falls back to the default for an unknown ?p=", () => {
    expect(detectProfile("https://x/y.zarr", "bogus")?.id).toBe("scalar-grid");
  });

  it("returns null when there is no url and no override", () => {
    expect(detectProfile(null, null)).toBeNull();
  });
});
