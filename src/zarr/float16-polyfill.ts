import { Float16Array } from "@petamoriken/float16";

/** zarrita reads `float16` arrays via `globalThis.Float16Array` (see its
 * `getCtr` dtype map). That global is Baseline-2025 native in current
 * browsers, but absent in older ones — and several Icechunk examples (GFS,
 * GEOS, and all of SILAM) store their variables as float16. Install the
 * spec-compatible polyfill only when the runtime lacks the native class, so
 * modern browsers keep using their (faster) built-in.
 *
 * Must run before any `zarr.open`/`zarr.get` touches a float16 array — call
 * it at the app entry point, ahead of rendering. */
export function installFloat16Polyfill(): void {
  if (!("Float16Array" in globalThis)) {
    (globalThis as { Float16Array?: unknown }).Float16Array = Float16Array;
  }
}
