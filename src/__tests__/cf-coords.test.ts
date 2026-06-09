import { describe, expect, it } from "vitest";
import { makeCfDimLabel } from "../zarr/profiles/scalar-grid/cf-coords";

describe("makeCfDimLabel", () => {
  it("formats GFS milliseconds-since-epoch as a date/time", () => {
    // The reported GFS value: 1701536400000 ms since 1970 = 2023-12-02 17:00Z.
    const label = makeCfDimLabel(
      "milliseconds since 1970-01-01",
      [1701536400000],
      1,
    );
    expect(label(0)).toBe("2023-12-02 17:00Z");
  });

  it("keeps millisecond-epoch math exact (no off-by-one minute)", () => {
    // A value landing exactly on a minute boundary must not round down to the
    // previous minute via float error.
    const label = makeCfDimLabel("milliseconds since 1970-01-01T00:00:00", [60_000], 1);
    expect(label(0)).toBe("1970-01-01 00:01Z");
  });

  it("still formats seconds/hours/days since epoch", () => {
    expect(makeCfDimLabel("seconds since 1970-01-01", [0], 1)(0)).toBe(
      "1970-01-01 00:00Z",
    );
    expect(
      makeCfDimLabel("hours since 2020-01-01 00:00:00", [24], 1)(0),
    ).toBe("2020-01-02 00:00Z");
    expect(makeCfDimLabel("days since 2000-01-01", [1], 1)(0)).toBe(
      "2000-01-02 00:00Z",
    );
  });

  it("formats bare durations in the coarsest whole unit", () => {
    expect(makeCfDimLabel("hours", [6], 1)(0)).toBe("+6 h");
    expect(makeCfDimLabel("seconds", [86400], 1)(0)).toBe("+1 d");
    expect(makeCfDimLabel("minutes", [90], 1)(0)).toBe("+90 min");
    expect(makeCfDimLabel("milliseconds", [500], 1)(0)).toBe("+500 ms");
    expect(makeCfDimLabel("milliseconds", [1000], 1)(0)).toBe("+1 s");
  });

  it("falls back to value+unit for unknown numeric units", () => {
    expect(makeCfDimLabel("hPa", [500], 1)(0)).toBe("500 hPa");
  });

  it("falls back to the index when units are missing", () => {
    expect(makeCfDimLabel(null, [42], 5)(0)).toBe("0 / 4");
  });

  it("falls back to the index for an unparseable epoch", () => {
    expect(makeCfDimLabel("hours since not-a-date", [3], 3)(1)).toBe("1 / 2");
  });
});
