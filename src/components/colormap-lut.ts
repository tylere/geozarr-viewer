import { COLORMAP_INDEX } from "@developmentseed/deck.gl-raster/gpu-modules";
import colormapsPngUrl from "@developmentseed/deck.gl-raster/gpu-modules/colormaps.png";

/** The colormaps sprite is one row per colormap (height = colormap count), each
 * row a left→right gradient. We decode it once and slice the row for a named
 * colormap into a 256-entry RGBA lookup table for CPU colormapping in the
 * OME-Zarr image viewer (which paints a plain BitmapLayer, not a shader). */

const ROW_COUNT = Object.keys(COLORMAP_INDEX).length;

let spritePromise: Promise<ImageData> | null = null;
const lutCache = new Map<string, Uint8Array>();

function loadSprite(): Promise<ImageData> {
  if (spritePromise) return spritePromise;
  spritePromise = new Promise<ImageData>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const cx = canvas.getContext("2d");
      if (!cx) {
        reject(new Error("no 2d context for colormap sprite"));
        return;
      }
      cx.drawImage(img, 0, 0);
      resolve(cx.getImageData(0, 0, canvas.width, canvas.height));
    };
    img.onerror = () => reject(new Error("failed to load colormaps sprite"));
    img.src = colormapsPngUrl;
  });
  return spritePromise;
}

/** Resolve a 256×RGBA LUT for the named colormap (cached). Returns `null` for
 * an unknown name so the caller falls back to grayscale. */
export async function loadColormapLut(name: string): Promise<Uint8Array | null> {
  const cached = lutCache.get(name);
  if (cached) return cached;
  const rowIndex = (COLORMAP_INDEX as Record<string, number>)[name];
  if (rowIndex === undefined) return null;

  const sprite = await loadSprite();
  // Sample the center of this colormap's row band, then resample its width to
  // exactly 256 entries.
  const bandHeight = sprite.height / ROW_COUNT;
  const y = Math.min(sprite.height - 1, Math.floor((rowIndex + 0.5) * bandHeight));
  const rowStart = y * sprite.width * 4;
  const lut = new Uint8Array(256 * 4);
  for (let k = 0; k < 256; k++) {
    const sx = Math.min(sprite.width - 1, Math.round((k / 255) * (sprite.width - 1)));
    const s = rowStart + sx * 4;
    const o = k * 4;
    lut[o] = sprite.data[s]!;
    lut[o + 1] = sprite.data[s + 1]!;
    lut[o + 2] = sprite.data[s + 2]!;
    lut[o + 3] = 255;
  }
  lutCache.set(name, lut);
  return lut;
}
