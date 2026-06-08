import * as zarr from "zarrita";

/** Format a non-spatial dimension's index into a human label by decoding its
 * coordinate array's CF `units`:
 *   - `"<unit> since <epoch>"`  → absolute datetime (e.g. forecast init time)
 *   - bare `"seconds"|"minutes"|"hours"|"days"` → relative duration (`"+N h"`)
 *   - otherwise / no coord array → the index (`"i / N"`).
 * Returns a pure `idx → string` formatter; reads the (small, 1-D) coord array
 * once. */
export async function buildDimLabel(
  group: zarr.Group<zarr.Readable>,
  dimName: string,
  size: number,
): Promise<(idx: number) => string> {
  const indexLabel = (i: number) => `${i} / ${Math.max(0, size - 1)}`;
  let values: number[];
  let units: string | null;
  try {
    const arr = await zarr.open.v3(group.resolve(dimName), { kind: "array" });
    units = typeof arr.attrs.units === "string" ? arr.attrs.units : null;
    const chunk = await zarr.get(arr as zarr.Array<zarr.DataType, zarr.Readable>);
    const raw = chunk.data as ArrayLike<number | bigint>;
    values = Array.from({ length: raw.length }, (_, i) => Number(raw[i]));
  } catch {
    return indexLabel;
  }
  if (!units) return indexLabel;

  const SEC: Record<string, number> = {
    second: 1, seconds: 1, sec: 1, s: 1,
    minute: 60, minutes: 60, min: 60,
    hour: 3600, hours: 3600, hr: 3600, h: 3600,
    day: 86400, days: 86400, d: 86400,
  };

  // "<unit> since <epoch>" → absolute datetime.
  const since = /^\s*(\w+)\s+since\s+(.+?)\s*$/i.exec(units);
  if (since && SEC[since[1]!.toLowerCase()]) {
    const perUnit = SEC[since[1]!.toLowerCase()]!;
    const epochMs = Date.parse(since[2]!.replace(" ", "T"));
    if (Number.isFinite(epochMs)) {
      return (i) => {
        const v = values[i];
        if (v == null) return indexLabel(i);
        const iso = new Date(epochMs + v * perUnit * 1000).toISOString();
        return `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
      };
    }
  }

  // Bare duration → "+N h" (rendered in the coarsest whole unit ≤ value).
  const bare = SEC[units.trim().toLowerCase()];
  if (bare) {
    return (i) => {
      const v = values[i];
      if (v == null) return indexLabel(i);
      const seconds = v * bare;
      if (seconds % 86400 === 0 && seconds !== 0) return `+${seconds / 86400} d`;
      if (seconds % 3600 === 0) return `+${seconds / 3600} h`;
      if (seconds % 60 === 0) return `+${seconds / 60} min`;
      return `+${seconds} s`;
    };
  }

  // Numeric coord with unknown units (e.g. pressure level) → "value unit".
  return (i) => {
    const v = values[i];
    return v == null ? indexLabel(i) : `${v} ${units}`;
  };
}
