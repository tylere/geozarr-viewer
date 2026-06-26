import { describe, expect, it } from "vitest";
import { parseMultiscaleDatasets } from "../../multiscale";
import { isOmeZarrAttrs } from "./ome";

describe("isOmeZarrAttrs", () => {
  it("detects OME-Zarr v0.5 (ome wrapper, multiscales)", () => {
    const attrs = {
      ome: { version: "0.5", multiscales: [{ axes: [{ name: "y" }] }] },
    };
    expect(isOmeZarrAttrs(attrs)).toBe(true);
  });

  it("detects OME-Zarr v0.5 plate (ome wrapper)", () => {
    const attrs = { ome: { plate: { wells: [{ path: "A/1" }] } } };
    expect(isOmeZarrAttrs(attrs)).toBe(true);
  });

  it("detects OME-Zarr v0.4 root multiscales (has axes) and would otherwise mis-route", () => {
    const attrs = {
      multiscales: [
        {
          axes: [{ name: "y", type: "space" }],
          datasets: [{ path: "0" }, { path: "1" }],
        },
      ],
    };
    expect(isOmeZarrAttrs(attrs)).toBe(true);
    // Documents why OME must be checked FIRST: this same store also looks like
    // a CF/rioxarray pyramid to parseMultiscaleDatasets.
    expect(parseMultiscaleDatasets(attrs)).not.toBeNull();
  });

  it("detects OME-Zarr v0.4 plate (root-level)", () => {
    expect(isOmeZarrAttrs({ plate: { wells: [{ path: "A/1" }] } })).toBe(true);
  });

  it("detects OME-Zarr v0.4 well (root-level)", () => {
    expect(isOmeZarrAttrs({ well: { images: [{ path: "0" }] } })).toBe(true);
  });

  it("detects bioformats2raw.layout", () => {
    expect(isOmeZarrAttrs({ "bioformats2raw.layout": 3 })).toBe(true);
  });

  it("rejects a CF/rioxarray multiscale pyramid (datasets, no axes)", () => {
    const attrs = { multiscales: [{ datasets: [{ path: "1x/chm" }] }] };
    expect(isOmeZarrAttrs(attrs)).toBe(false);
    // ...and it still routes to multiscale-grid via parseMultiscaleDatasets.
    expect(parseMultiscaleDatasets(attrs)).toEqual(["1x/chm"]);
  });

  it("rejects a plain geographic scalar grid", () => {
    expect(
      isOmeZarrAttrs({ "spatial:transform": [1, 0, 0, 0, 1, 0] }),
    ).toBe(false);
  });

  it("rejects empty / non-object / null attrs", () => {
    expect(isOmeZarrAttrs({})).toBe(false);
    expect(isOmeZarrAttrs(null)).toBe(false);
    expect(isOmeZarrAttrs(undefined)).toBe(false);
    expect(isOmeZarrAttrs("ome")).toBe(false);
  });

  it("rejects a null `ome` value (must be a non-null object)", () => {
    expect(isOmeZarrAttrs({ ome: null })).toBe(false);
  });
});
