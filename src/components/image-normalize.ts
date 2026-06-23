/** Map raw intensities to a packed RGBA buffer via a linear window, gamma, and
 * an optional colormap LUT. Returns the raw bytes — the caller wraps them in
 * `ImageData` (a canvas API absent in jsdom), keeping this pure and testable.
 *
 * - `min`/`max`: the display window; values map linearly to [0,1] and clamp.
 * - `gamma`: >1 brightens, <1 darkens, 1 = linear (applied as t^(1/gamma)).
 * - `lut`: 256-entry RGBA colormap (length 1024). When omitted, the normalized
 *   intensity is written as opaque grayscale. */
export function styleToRgba(
  data: ArrayLike<number>,
  width: number,
  height: number,
  min: number,
  max: number,
  gamma: number,
  lut?: Uint8Array | null,
): Uint8ClampedArray<ArrayBuffer> {
  const n = width * height;
  const span = max - min || 1;
  const invGamma = gamma > 0 ? 1 / gamma : 1;
  const useGamma = gamma !== 1;
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    let t = (Number(data[i]) - min) / span;
    t = t <= 0 ? 0 : t >= 1 ? 1 : t;
    if (useGamma) t = Math.pow(t, invGamma);
    const o = i * 4;
    if (lut) {
      const li = (t * 255 + 0.5) << 2; // round to nearest entry, ×4
      rgba[o] = lut[li]!;
      rgba[o + 1] = lut[li + 1]!;
      rgba[o + 2] = lut[li + 2]!;
    } else {
      const byte = Math.round(t * 255);
      rgba[o] = byte;
      rgba[o + 1] = byte;
      rgba[o + 2] = byte;
    }
    rgba[o + 3] = 255;
  }
  return rgba;
}
