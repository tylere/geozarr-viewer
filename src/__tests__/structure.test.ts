import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectConventions, fetchCodecSummary } from "../zarr/structure";

const cf = (v: string) =>
  `https://cfconventions.org/Data/cf-conventions/cf-conventions-${v}/cf-conventions.html`;
const ome = (v: string) => `https://ngff.openmicroscopy.org/${v}/`;
const OME_LATEST = "https://ngff.openmicroscopy.org/latest/";
const MULTISCALES_REPO = "https://github.com/zarr-conventions/multiscales";
const PROJ_REPO = "https://github.com/zarr-conventions/proj";
const SPATIAL_REPO = "https://github.com/zarr-conventions/spatial";
const GEOEMB_REPO = "https://github.com/geo-embeddings/embeddings-zarr-convention";
const GEOZARR_SPEC = "https://github.com/zarr-developers/geozarr-spec";
const ACDD = "https://wiki.esipfed.org/Attribute_Convention_for_Data_Discovery_1-3";
const UGRID = "http://ugrid-conventions.github.io/ugrid-conventions/";

describe("detectConventions", () => {
  it("returns empty array for empty attrs", () => {
    expect(detectConventions({})).toEqual([]);
  });

  it("parses a single CF convention with a versioned spec link", () => {
    expect(detectConventions({ Conventions: "CF-1.8" })).toEqual([
      { name: "CF", version: "1.8", specUrl: cf("1.8") },
    ]);
  });

  it("links a version-less CF convention to the landing page", () => {
    expect(detectConventions({ Conventions: "CF" })).toEqual([
      { name: "CF", version: null, specUrl: "https://cfconventions.org/" },
    ]);
  });

  it("links every known token (CF + ACDD) from a space-separated list", () => {
    expect(detectConventions({ Conventions: "CF-1.8 ACDD-1.3" })).toEqual([
      { name: "CF", version: "1.8", specUrl: cf("1.8") },
      { name: "ACDD", version: "1.3", specUrl: ACDD },
    ]);
  });

  it("parses comma-separated conventions (UGRID linked from the table)", () => {
    expect(detectConventions({ Conventions: "CF-1.9,UGRID-1.0" })).toEqual([
      { name: "CF", version: "1.9", specUrl: cf("1.9") },
      { name: "UGRID", version: "1.0", specUrl: UGRID },
    ]);
  });

  it("leaves an unknown convention token unlinked", () => {
    expect(detectConventions({ Conventions: "MyConvention" })).toEqual([
      { name: "MyConvention", version: null },
    ]);
  });

  it("links an explicitly-declared GeoZarr token", () => {
    expect(detectConventions({ Conventions: "GeoZarr" })).toEqual([
      { name: "GeoZarr", version: null, specUrl: GEOZARR_SPEC },
    ]);
  });

  it("detects OME-Zarr from a multiscales attr with `axes` and version (versioned link)", () => {
    expect(
      detectConventions({
        multiscales: [
          { version: "0.5", axes: [{ name: "y", type: "space" }] },
        ],
      }),
    ).toEqual([{ name: "OME-Zarr", version: "0.5", specUrl: ome("0.5") }]);
  });

  it("detects OME-Zarr (null version) from `axes`, linking the latest spec", () => {
    expect(
      detectConventions({ multiscales: [{ axes: [{ name: "y" }] }] }),
    ).toEqual([{ name: "OME-Zarr", version: null, specUrl: OME_LATEST }]);
  });

  it("no longer infers GeoZarr from spatial:/proj: attribute keys", () => {
    expect(
      detectConventions({
        "spatial:dimensions": ["x", "y"],
        "proj:code": "EPSG:4326",
      }),
    ).toEqual([]);
  });

  it("combines explicit sources: Conventions + registry + OME-Zarr multiscales", () => {
    const attrs = {
      Conventions: "CF-1.8",
      zarr_conventions: [{ name: "proj:" }],
      multiscales: [{ version: "0.4", axes: [{ name: "y", type: "space" }] }],
    };
    expect(detectConventions(attrs)).toEqual([
      { name: "CF", version: "1.8", specUrl: cf("1.8") },
      { name: "proj:", version: null, specUrl: PROJ_REPO },
      { name: "OME-Zarr", version: "0.4", specUrl: ome("0.4") },
    ]);
  });

  it("labels a CF/rioxarray multiscale pyramid as legacy `multiscales` (linked AND warned), not OME-Zarr", () => {
    // Meta CHM v2 shape: the `multiscales` key is reused by the legacy
    // multiscale-pyramid layout (datasets[].downscale_factor + a top-level
    // `type`), which has no OME-Zarr `axes` and predates the `zarr_conventions`
    // registry. It must be reported as `multiscales` (linked via the table AND
    // flagged legacy), NOT OME-Zarr.
    const attrs = {
      Conventions: "CF-1.10",
      multiscales: [
        {
          name: "chm",
          datasets: [
            { path: "64x", downscale_factor: 64 },
            { path: "1x", downscale_factor: 1 },
          ],
          type: "average",
        },
      ],
    };
    expect(detectConventions(attrs)).toEqual([
      { name: "CF", version: "1.10", specUrl: cf("1.10") },
      {
        name: "multiscales",
        version: null,
        specUrl: MULTISCALES_REPO,
        legacy: expect.any(String),
      },
    ]);
  });

  it("links registry conventions via the curated table, not the declared spec_url", () => {
    const attrs = {
      zarr_conventions: [
        {
          name: "multiscales",
          version: "0.1",
          uuid: "d35379db-88df-4056-af3a-620245f8e347",
          // A dead spec_url must be ignored — links come from the curated table.
          spec_url:
            "https://github.com/zarr-conventions/multiscales/blob/v0.1/README.md",
        },
        {
          // No explicit `version` — the `v0.2` tag in schema_url must be ignored.
          name: "proj",
          schema_url:
            "https://raw.githubusercontent.com/zarr-conventions/proj/refs/tags/v0.2/schema.json",
        },
      ],
    };
    expect(detectConventions(attrs)).toEqual([
      { name: "multiscales", version: "0.1", specUrl: MULTISCALES_REPO },
      { name: "proj", version: null, specUrl: PROJ_REPO },
    ]);
  });

  it("links colon-suffixed registry names via name normalization", () => {
    // AEF's registry shape: proj:/spatial:/geoemb: with trailing colons.
    const attrs = {
      zarr_conventions: [
        { name: "proj:" },
        { name: "spatial:" },
        { name: "geoemb:" },
      ],
    };
    // Display name keeps the colon; only the table lookup is normalized.
    expect(detectConventions(attrs)).toEqual([
      { name: "proj:", version: null, specUrl: PROJ_REPO },
      { name: "spatial:", version: null, specUrl: SPATIAL_REPO },
      { name: "geoemb:", version: null, specUrl: GEOEMB_REPO },
    ]);
  });

  it("prefers the registry `multiscales` over a legacy array (deduped, not flagged legacy)", () => {
    const attrs = {
      zarr_conventions: [{ name: "multiscales" }],
      multiscales: [{ datasets: [{ path: "1x", downscale_factor: 1 }] }],
    };
    // Registry entry wins: linked via the table, no version, no legacy flag.
    expect(detectConventions(attrs)).toEqual([
      { name: "multiscales", version: null, specUrl: MULTISCALES_REPO },
    ]);
  });
});

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function notFound(): Response {
  return new Response(null, { status: 404 });
}

describe("fetchCodecSummary (v3 zarr.json)", () => {
  it("recognizes a sharded array and extracts sub-chunk shape + inner compressor", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        node_type: "array",
        shape: [789, 85, 51, 721, 1440],
        codecs: [
          {
            name: "sharding_indexed",
            configuration: {
              chunk_shape: [1, 85, 51, 32, 32],
              codecs: [
                { name: "bytes", configuration: { endian: "little" } },
                {
                  name: "blosc",
                  configuration: {
                    cname: "zstd",
                    clevel: 3,
                    shuffle: "shuffle",
                  },
                },
              ],
            },
          },
        ],
      }),
    );

    const summary = await fetchCodecSummary(
      "https://example.com/data.zarr",
      "temperature_2m",
      new AbortController().signal,
    );
    expect(summary).not.toBeNull();
    expect(summary!.sharded).toBe(true);
    expect(summary!.subChunkShape).toEqual([1, 85, 51, 32, 32]);
    expect(summary!.compressor).toBe(
      "blosc(zstd, clevel=3, shuffle=shuffle)",
    );
  });

  it("recognizes an unsharded array and skips the structural `bytes` codec", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        node_type: "array",
        shape: [171, 381, 1081],
        codecs: [
          { name: "bytes", configuration: { endian: "little" } },
          {
            name: "blosc",
            configuration: { cname: "zstd", clevel: 5, shuffle: "shuffle" },
          },
        ],
      }),
    );

    const summary = await fetchCodecSummary(
      "https://example.com/data.zarr",
      "PM25_latest",
      new AbortController().signal,
    );
    expect(summary).not.toBeNull();
    expect(summary!.sharded).toBe(false);
    expect(summary!.subChunkShape).toBeNull();
    expect(summary!.compressor).toBe(
      "blosc(zstd, clevel=5, shuffle=shuffle)",
    );
  });

  it("reports `raw` when only the `bytes` codec is present", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        node_type: "array",
        codecs: [{ name: "bytes", configuration: { endian: "little" } }],
      }),
    );
    const summary = await fetchCodecSummary(
      "https://example.com/data.zarr",
      "x",
      new AbortController().signal,
    );
    expect(summary).not.toBeNull();
    expect(summary!.compressor).toBe("raw");
  });

  it("falls back to v2 `.zarray` when v3 zarr.json is missing", async () => {
    fetchMock
      .mockResolvedValueOnce(notFound())
      .mockResolvedValueOnce(
        jsonResponse({
          shape: [10, 10],
          chunks: [5, 5],
          dtype: "<f4",
          compressor: {
            id: "blosc",
            cname: "zstd",
            clevel: 3,
            shuffle: 1,
          },
        }),
      );
    const summary = await fetchCodecSummary(
      "https://example.com/data.zarr",
      "field",
      new AbortController().signal,
    );
    expect(summary).not.toBeNull();
    expect(summary!.sharded).toBe(false);
    expect(summary!.compressor).toContain("blosc");
    expect(summary!.compressor).toContain("zstd");
  });

  it("returns null when both v3 and v2 fetches fail", async () => {
    fetchMock.mockResolvedValueOnce(notFound()).mockResolvedValueOnce(notFound());
    const summary = await fetchCodecSummary(
      "https://example.com/data.zarr",
      "missing",
      new AbortController().signal,
    );
    expect(summary).toBeNull();
  });

  it("survives non-JSON / network errors gracefully", async () => {
    fetchMock.mockRejectedValueOnce(new Error("net error"));
    fetchMock.mockRejectedValueOnce(new Error("net error"));
    const summary = await fetchCodecSummary(
      "https://example.com/data.zarr",
      "x",
      new AbortController().signal,
    );
    expect(summary).toBeNull();
  });

  it("trims trailing slashes in the URL and leading slashes in the path", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ node_type: "array", codecs: [] }),
    );
    await fetchCodecSummary(
      "https://example.com/data.zarr/",
      "/embeddings",
      new AbortController().signal,
    );
    const calledUrl = fetchMock.mock.calls[0]?.[0];
    expect(calledUrl).toBe(
      "https://example.com/data.zarr/embeddings/zarr.json",
    );
  });
});
