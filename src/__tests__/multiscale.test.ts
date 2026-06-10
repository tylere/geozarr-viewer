import { describe, expect, it } from "vitest";
import {
  buildGeoZarrMetadata,
  parseMultiscaleDatasets,
} from "../zarr/multiscale";

describe("parseMultiscaleDatasets", () => {
  it("reads dataset paths (coarsest→finest) from the CF/rioxarray convention", () => {
    const attrs = {
      multiscales: [
        {
          name: "chm",
          datasets: [
            { path: "64x", downscale_factor: 64 },
            { path: "32x", downscale_factor: 32 },
            { path: "1x", downscale_factor: 1 },
          ],
          type: "average",
        },
      ],
    };
    expect(parseMultiscaleDatasets(attrs)).toEqual(["64x", "32x", "1x"]);
  });

  it("returns null when there is no multiscales attr", () => {
    expect(parseMultiscaleDatasets({})).toBeNull();
    expect(parseMultiscaleDatasets({ multiscales: [] })).toBeNull();
    expect(parseMultiscaleDatasets({ multiscales: [{ datasets: [] }] })).toBeNull();
    expect(parseMultiscaleDatasets(null)).toBeNull();
    expect(parseMultiscaleDatasets("nope")).toBeNull();
  });
});

describe("buildGeoZarrMetadata", () => {
  // Two-level toy pyramid, coarsest→finest (store order).
  const levels = [
    {
      asset: "2x/chm",
      // GDAL GeoTransform [ox, px, rx, oy, ry, py]
      geoTransform: [-20037508.34, 2.388, 0, 20037508.34, 0, -2.388],
      shape: [256, 256] as [number, number],
    },
    {
      asset: "1x/chm",
      geoTransform: [-20037508.34, 1.194, 0, 20037508.34, 0, -1.194],
      shape: [512, 512] as [number, number],
    },
  ];

  it("emits the layout finest-first (reverse of store order)", () => {
    const meta = buildGeoZarrMetadata({ levels, crsWkt: "WKT" });
    expect(meta.multiscales.layout.map((l) => l.asset)).toEqual([
      "1x/chm",
      "2x/chm",
    ]);
  });

  it("reorders GDAL GeoTransform → spatial:transform [px,rx,ox,ry,py,oy]", () => {
    const meta = buildGeoZarrMetadata({ levels, crsWkt: "WKT" });
    // finest (1x) is first now
    expect(meta.multiscales.layout[0]!["spatial:transform"]).toEqual([
      1.194, 0, -20037508.34, 0, -1.194, 20037508.34,
    ]);
    expect(meta.multiscales.layout[0]!["spatial:shape"]).toEqual([512, 512]);
  });

  it("sets proj:wkt2 and default y/x dims", () => {
    const meta = buildGeoZarrMetadata({ levels, crsWkt: "MY_WKT" });
    expect(meta["proj:wkt2"]).toBe("MY_WKT");
    expect(meta["spatial:dimensions"]).toEqual(["y", "x"]);
  });

  it("allows overriding the spatial dim names", () => {
    const meta = buildGeoZarrMetadata({
      levels,
      crsWkt: "WKT",
      dims: ["latitude", "longitude"],
    });
    expect(meta["spatial:dimensions"]).toEqual(["latitude", "longitude"]);
  });
});
