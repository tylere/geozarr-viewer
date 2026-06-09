import * as zarr from "zarrita";

/** Milliseconds per CF time unit. Integer factors keep absolute-time math exact
 * (a millisecond epoch like GFS's would lose precision via a seconds factor). */
const MS_PER: Record<string, number> = {
  millisecond: 1, milliseconds: 1, msec: 1, msecs: 1, ms: 1,
  second: 1000, seconds: 1000, sec: 1000, s: 1000,
  minute: 60_000, minutes: 60_000, min: 60_000,
  hour: 3_600_000, hours: 3_600_000, hr: 3_600_000, h: 3_600_000,
  day: 86_400_000, days: 86_400_000, d: 86_400_000,
};

/** Parse a CF reference-time epoch to ms. A reference time without an explicit
 * timezone is UTC by convention, but JS `Date.parse` treats a date-*time* with
 * no zone as *local*; append `Z` in that case so labels don't shift with the
 * viewer's timezone. (A date-only string already parses as UTC.) */
function parseEpochMs(epoch: string): number {
  let s = epoch.trim().replace(" ", "T");
  const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s);
  if (!hasTz && s.includes("T")) s += "Z";
  return Date.parse(s);
}

/** Build an `idx → label` formatter from a coordinate array's values and CF
 * `units`:
 *   - `"<unit> since <epoch>"` → absolute datetime (e.g. forecast init time)
 *   - bare `"milliseconds".."days"` → relative duration (`"+N h"`)
 *   - numeric coord with other units → `"value unit"` (e.g. pressure level)
 *   - no units / unparseable → the index (`"i / N"`).
 * Pure: takes the already-read values, so it's unit-testable. */
export function makeCfDimLabel(
  units: string | null,
  values: ArrayLike<number>,
  size: number,
): (idx: number) => string {
  const indexLabel = (i: number) => `${i} / ${Math.max(0, size - 1)}`;
  if (!units) return indexLabel;

  // "<unit> since <epoch>" → absolute datetime.
  const since = /^\s*(\w+)\s+since\s+(.+?)\s*$/i.exec(units);
  if (since && MS_PER[since[1]!.toLowerCase()]) {
    const perUnitMs = MS_PER[since[1]!.toLowerCase()]!;
    const epochMs = parseEpochMs(since[2]!);
    if (Number.isFinite(epochMs)) {
      return (i) => {
        const v = values[i];
        if (v == null) return indexLabel(i);
        const iso = new Date(epochMs + v * perUnitMs).toISOString();
        return `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
      };
    }
  }

  // Bare duration → "+N h" (rendered in the coarsest whole unit ≤ value).
  const bare = MS_PER[units.trim().toLowerCase()];
  if (bare) {
    return (i) => {
      const v = values[i];
      if (v == null) return indexLabel(i);
      const ms = v * bare;
      if (ms % 86_400_000 === 0 && ms !== 0) return `+${ms / 86_400_000} d`;
      if (ms % 3_600_000 === 0) return `+${ms / 3_600_000} h`;
      if (ms % 60_000 === 0) return `+${ms / 60_000} min`;
      if (ms % 1000 === 0) return `+${ms / 1000} s`;
      return `+${ms} ms`;
    };
  }

  // Numeric coord with unknown units (e.g. pressure level) → "value unit".
  return (i) => {
    const v = values[i];
    return v == null ? indexLabel(i) : `${v} ${units}`;
  };
}

/** Format a non-spatial dimension's index into a human label by decoding its
 * coordinate array's CF `units`. Reads the (small, 1-D) coord array once, then
 * delegates to {@link makeCfDimLabel}. Falls back to the index on any error. */
export async function buildDimLabel(
  group: zarr.Group<zarr.Readable>,
  dimName: string,
  size: number,
): Promise<(idx: number) => string> {
  const indexLabel = (i: number) => `${i} / ${Math.max(0, size - 1)}`;
  try {
    const arr = await zarr.open.v3(group.resolve(dimName), { kind: "array" });
    const units = typeof arr.attrs.units === "string" ? arr.attrs.units : null;
    const chunk = await zarr.get(arr as zarr.Array<zarr.DataType, zarr.Readable>);
    const raw = chunk.data as ArrayLike<number | bigint>;
    const values = Array.from({ length: raw.length }, (_, i) => Number(raw[i]));
    return makeCfDimLabel(units, values, size);
  } catch {
    return indexLabel;
  }
}
