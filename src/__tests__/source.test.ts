import { describe, expect, it } from "vitest";
import { detectProfile, normalizeStoreUrl } from "../source";

describe("detectProfile", () => {
  it("defaults any store to scalar-grid", () => {
    expect(
      detectProfile(
        "https://data.source.coop/dynamical/ecmwf-ifs-ens-forecast-15-day-0-25-degree/v0.1.0.zarr",
        null,
      )?.id,
    ).toBe("scalar-grid");
    expect(
      detectProfile("https://example.com/random.zarr", null)?.id,
    ).toBe("scalar-grid");
  });

  it("returns null for null url", () => {
    expect(detectProfile(null, null)).toBeNull();
  });

  it("honors explicit ?p= override", () => {
    const p = detectProfile(
      "https://data.source.coop/tge-labs/aef-mosaic",
      "band-composite",
    );
    expect(p?.id).toBe("band-composite");
  });

  it("falls back to default for an invalid explicit override", () => {
    const p = detectProfile("https://example.com/random.zarr", "bogus");
    expect(p?.id).toBe("scalar-grid");
  });
});

describe("normalizeStoreUrl", () => {
  it("strips a trailing /zarr.json", () => {
    expect(
      normalizeStoreUrl("https://data.source.coop/tge-labs/aef-mosaic/zarr.json"),
    ).toBe("https://data.source.coop/tge-labs/aef-mosaic");
  });

  it("strips a trailing /.zmetadata", () => {
    expect(
      normalizeStoreUrl("https://example.com/x/.zmetadata"),
    ).toBe("https://example.com/x");
  });

  it("rewrites source.coop to data.source.coop", () => {
    expect(
      normalizeStoreUrl("https://source.coop/tge-labs/aef-mosaic"),
    ).toBe("https://data.source.coop/tge-labs/aef-mosaic");
  });

  it("does both at once for the user's pasted URL", () => {
    expect(
      normalizeStoreUrl("https://source.coop/tge-labs/aef-mosaic/zarr.json"),
    ).toBe("https://data.source.coop/tge-labs/aef-mosaic");
  });

  it("leaves an already-normalized data.source.coop URL unchanged", () => {
    const url = "https://data.source.coop/some-account/some-dataset/v1.zarr";
    expect(normalizeStoreUrl(url)).toBe(url);
  });

  it("trims whitespace", () => {
    expect(normalizeStoreUrl("  https://example.com/x  ")).toBe(
      "https://example.com/x",
    );
  });
});
