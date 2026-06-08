import * as zarr from "zarrita";
import { NUM_BANDS } from "./constants";

/** Open and fully read the `band` coordinate array from the AEF root
 * group. Returns the 64 band labels in order. Ported from upstream. */
export async function fetchBandLabels(
  root: zarr.Group<zarr.Readable>,
): Promise<string[]> {
  const bandArr = await zarr.open.v3(root.resolve("band"), { kind: "array" });
  if (!bandArr.is("string")) {
    throw new Error(
      `Expected the "band" coord to be a string array, got ${bandArr.dtype}`,
    );
  }
  const chunk = await zarr.get(bandArr);
  const labels = Array.from(chunk.data as ArrayLike<string>);
  if (labels.length !== NUM_BANDS) {
    throw new Error(`Expected ${NUM_BANDS} band labels, got ${labels.length}`);
  }
  return labels;
}
