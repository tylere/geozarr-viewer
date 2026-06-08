import { test } from "vitest";
import * as zarr from "zarrita";
import { installFloat16Polyfill } from "../zarr/float16-polyfill";
import { openV3Group } from "../zarr/load-zarr";
import { normalizeStoreUrl } from "../source";

installFloat16Polyfill();

test("inspect carbonplan chunking", { timeout: 300_000 }, async () => {
  const url = normalizeStoreUrl(
    "https://source.coop/carbonplan/carbonplan-ocr/output/fire-risk/tensor/production/v1.1.0/ocr.icechunk",
  );
  const opened = await openV3Group(url, { consolidated: true });
  for (const name of ["bp_2011", "latitude", "longitude"]) {
    const arr = await zarr.open.v3(opened.group.resolve(name), { kind: "array" });
    console.log(
      `${name}: shape=[${arr.shape.join(",")}] chunks=[${arr.chunks.join(",")}] dtype=${arr.dtype}`,
    );
    // Dump codec pipeline to detect sharding (inner vs outer chunk).
    const meta = (arr as unknown as { codecs?: unknown }).codecs;
    console.log(`  codecs=${JSON.stringify(meta)}`);
  }
});
