import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectConventions, fetchCodecSummary } from "../zarr/structure";

const cf = (v: string) =>
  `https://cfconventions.org/Data/cf-conventions/cf-conventions-${v}/cf-conventions.html`;
const MULTISCALES_REPO = "https://github.com/zarr-conventions/multiscales";

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

  it("parses multiple space-separated conventions (only CF linked)", () => {
    expect(detectConventions({ Conventions: "CF-1.8 ACDD-1.3" })).toEqual([
      { name: "CF", version: "1.8", specUrl: cf("1.8") },
      { name: "ACDD", version: "1.3" },
    ]);
  });

  it("parses comma-separated conventions", () => {
    expect(detectConventions({ Conventions: "CF-1.9,UGRID-1.0" })).toEqual([
      { name: "CF", version: "1.9", specUrl: cf("1.9") },
      { name: "UGRID", version: "1.0" },
    ]);
  });

  it("handles convention token without version", () => {
    expect(detectConventions({ Conventions: "MyConvention" })).toEqual([
      { name: "MyConvention", version: null },
    ]);
  });

  it("detects OME-Zarr from a multiscales attr with `axes` and version", () => {
    expect(
      detectConventions({
        multiscales: [
          { version: "0.5", axes: [{ name: "y", type: "space" }] },
        ],
      }),
    ).toEqual([{ name: "OME-Zarr", version: "0.5" }]);
  });

  it("detects OME-Zarr (null version) from `axes` when version is missing", () => {
    expect(
      detectConventions({ multiscales: [{ axes: [{ name: "y" }] }] }),
    ).toEqual([{ name: "OME-Zarr", version: null }]);
  });

  it("detects GeoZarr from spatial: attr key", () => {
    const result = detectConventions({ "spatial:dimensions": ["x", "y"] });
    expect(result).toEqual([{ name: "GeoZarr", version: null }]);
  });

  it("detects GeoZarr from proj:code attr key", () => {
    const result = detectConventions({ "proj:code": "EPSG:4326" });
    expect(result).toEqual([{ name: "GeoZarr", version: null }]);
  });

  it("combines all three sources", () => {
    const attrs = {
      Conventions: "CF-1.8",
      multiscales: [{ version: "0.4", axes: [{ name: "y", type: "space" }] }],
      "spatial:dimensions": ["x", "y"],
    };
    expect(detectConventions(attrs)).toEqual([
      { name: "CF", version: "1.8", specUrl: cf("1.8") },
      { name: "OME-Zarr", version: "0.4" },
      { name: "GeoZarr", version: null },
    ]);
  });

  it("labels a CF/rioxarray multiscale pyramid as legacy `multiscales`, not OME-Zarr", () => {
    // Meta CHM v2 shape: the `multiscales` key is reused by the legacy
    // multiscale-pyramid layout (datasets[].downscale_factor + a top-level
    // `type`), which has no OME-Zarr `axes` and predates the `zarr_conventions`
    // registry. It must be reported as `multiscales` (flagged legacy), NOT
    // OME-Zarr.
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

  it("detects registry conventions; explicit version only, and never links the declared spec_url", () => {
    const attrs = {
      zarr_conventions: [
        {
          name: "multiscales",
          version: "0.1",
          uuid: "d35379db-88df-4056-af3a-620245f8e347",
          schema_url:
            "https://raw.githubusercontent.com/zarr-conventions/multiscales/refs/tags/v0.1/schema.json",
          // spec_url is intentionally NOT surfaced as a link (can be dead).
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
    // Registry entries are canonical — no `legacy` flag, and no `specUrl`.
    expect(detectConventions(attrs)).toEqual([
      { name: "multiscales", version: "0.1" },
      { name: "proj", version: null },
    ]);
  });

  it("prefers the registry `multiscales` over a legacy array (deduped, not flagged legacy)", () => {
    const attrs = {
      zarr_conventions: [
        {
          name: "multiscales",
          schema_url:
            "https://raw.githubusercontent.com/zarr-conventions/multiscales/refs/tags/v0.1/schema.json",
        },
      ],
      multiscales: [{ datasets: [{ path: "1x", downscale_factor: 1 }] }],
    };
    // No explicit version on the registry entry → null (schema_url tag ignored).
    expect(detectConventions(attrs)).toEqual([
      { name: "multiscales", version: null },
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
