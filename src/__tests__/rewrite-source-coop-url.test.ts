import { describe, expect, it } from "vitest";
import { rewriteSourceCoopS3Url } from "../zarr/load-zarr";

describe("rewriteSourceCoopS3Url", () => {
  it("remaps icechunk-js's path-style global-endpoint URL onto the CORS proxy", () => {
    // What icechunk-js builds from `s3://us-west-2.opendata.source.coop/<key>`
    // (a dotted bucket → path-style → a 301 from the global endpoint).
    expect(
      rewriteSourceCoopS3Url(
        "https://s3.amazonaws.com/us-west-2.opendata.source.coop/tge-labs/meta-chm-v2/chm/2101003131.tif",
      ),
    ).toBe(
      "https://data.source.coop/tge-labs/meta-chm-v2/chm/2101003131.tif",
    );
  });

  it("remaps the regional path-style endpoint too", () => {
    expect(
      rewriteSourceCoopS3Url(
        "https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/a/b.tif",
      ),
    ).toBe("https://data.source.coop/a/b.tif");
    expect(
      rewriteSourceCoopS3Url(
        "https://s3-us-west-2.amazonaws.com/us-west-2.opendata.source.coop/a/b.tif",
      ),
    ).toBe("https://data.source.coop/a/b.tif");
  });

  it("leaves non-source.coop and already-proxied URLs unchanged", () => {
    const proxied = "https://data.source.coop/tge-labs/meta-chm-v2/chm/x.tif";
    expect(rewriteSourceCoopS3Url(proxied)).toBe(proxied);

    const other = "https://s3.amazonaws.com/some-other-bucket/key.tif";
    expect(rewriteSourceCoopS3Url(other)).toBe(other);

    const gcs = "https://storage.googleapis.com/bucket/key";
    expect(rewriteSourceCoopS3Url(gcs)).toBe(gcs);
  });
});
