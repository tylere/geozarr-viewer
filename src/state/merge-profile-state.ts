function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Merge URL-parsed profile params over the profile's default state. Scalars
 * override; nested plain-object fields (e.g. the generic profile's
 * `dimIndices`) are merged one level deep, so a URL that pins only `dim.step`
 * keeps the defaults for the other dims instead of dropping them. */
export function mergeProfileState<S extends object>(
  base: S,
  overrides: Partial<S>,
): S {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(overrides)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = isPlainObject(b) && isPlainObject(v) ? { ...b, ...v } : v;
  }
  return out as S;
}
