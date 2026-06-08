import type { AnyZarrProfile } from "../profile";
import { bandCompositeProfile } from "./band-composite/profile";
import { scalarGridProfile } from "./scalar-grid/profile";

/** Registered profiles, by capability. Selection is by the explicit `?p=`
 * profile id ({@link getProfile}); when none is given, the chassis defaults to
 * `scalar-grid` (see `detectProfile`). The first entry is the default. */
export const PROFILES: readonly AnyZarrProfile[] = [
  scalarGridProfile,
  bandCompositeProfile,
];

/** The default profile when no `?p=` is given: single-band scalar → colormap. */
export const DEFAULT_PROFILE: AnyZarrProfile = scalarGridProfile;

export function getProfile(id: string | null): AnyZarrProfile | null {
  if (!id) return null;
  return PROFILES.find((p) => p.id === id) ?? null;
}
