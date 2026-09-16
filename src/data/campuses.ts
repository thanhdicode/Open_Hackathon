import type { CountryCode } from "./countries";
import campusConfig from "../../config/phase5-campuses.json";

/**
 * Canonical campus registry, read from `config/phase5-campuses.json`.
 *
 * WHY THIS EXISTS
 *
 * Two conventions for "which university" were already in the repo and they did
 * not agree. `student_profiles.university_id` stores the full display name
 * ("National University of Singapore"), while the Phase 5 seed pack stores a
 * short code ("NUS"). Matching two students on `university_id` would therefore
 * silently return nothing for every seeded profile — the kind of bug that looks
 * like "no results" rather than a defect.
 *
 * Every comparison in Phase 5 goes through `campusKey()` instead of comparing the
 * raw field, so both conventions resolve to the same campus.
 */

export interface Campus {
  campusId: string;
  universityId: string;
  universityName: string;
  aliases: string[];
  country: CountryCode;
  city: string;
  center: { lat: number; lng: number };
  centerSource: string;
  centerAccuracyNote?: string;
  demoPriority: number;
}

interface RawCampus {
  campus_id: string;
  university_id: string;
  university_name: string;
  aliases: string[];
  country_code: string;
  city: string;
  center: { lat: number; lng: number };
  center_source: string;
  center_accuracy_note?: string;
  demo_priority: number;
}

const raw = campusConfig as unknown as { campuses: RawCampus[]; overpass: Record<string, unknown> };

export const CAMPUSES: Campus[] = raw.campuses
  .map((campus) => ({
    campusId: campus.campus_id,
    universityId: campus.university_id,
    universityName: campus.university_name,
    aliases: campus.aliases,
    country: campus.country_code as CountryCode,
    city: campus.city,
    center: campus.center,
    centerSource: campus.center_source,
    centerAccuracyNote: campus.center_accuracy_note,
    demoPriority: campus.demo_priority,
  }))
  .sort((a, b) => a.demoPriority - b.demoPriority);

const byUniversityId = new Map(CAMPUSES.map((campus) => [campus.universityId, campus]));
const byCampusId = new Map(CAMPUSES.map((campus) => [campus.campusId, campus]));

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const aliasIndex = new Map<string, Campus>();
for (const campus of CAMPUSES) {
  for (const alias of [...campus.aliases, campus.universityId, campus.campusId, campus.universityName]) {
    aliasIndex.set(normalize(alias), campus);
  }
}

/**
 * Resolve any university spelling to a canonical campus.
 *
 * Accepts the full name, the short code, the campus id, or a known alias, and is
 * tolerant of punctuation and case. Returns null rather than guessing when the
 * value is unknown — a wrong campus would put a student on the wrong map.
 */
export function campusFor(university: string | undefined | null): Campus | null {
  if (!university) return null;
  const key = normalize(university);
  if (!key) return null;

  const direct = aliasIndex.get(key);
  if (direct) return direct;

  // Fall back to containment so "Universiti Malaya (UM)" and
  // "National University of Singapore, Kent Ridge" still resolve.
  for (const [alias, campus] of aliasIndex) {
    if (alias.length >= 4 && (key.includes(alias) || alias.includes(key))) return campus;
  }
  return null;
}

export function campusById(campusId: string | undefined | null): Campus | null {
  return campusId ? byCampusId.get(campusId) ?? null : null;
}

export function campusByUniversityId(universityId: string | undefined | null): Campus | null {
  return universityId ? byUniversityId.get(universityId) ?? null : null;
}

/** The campus for the student's active journey, or null when it is not one we know. */
export function campusForJourney(journey: { university?: string; host: CountryCode }): Campus | null {
  return campusFor(journey.university) ?? CAMPUSES.find((campus) => campus.country === journey.host) ?? null;
}

/**
 * Canonical key used for every equality test in Connect matching.
 * Returns the campus id when known, otherwise a normalised raw string so an
 * unknown university still compares equal to itself.
 */
export function campusKey(university: string | undefined | null): string {
  return campusFor(university)?.campusId ?? normalize(university ?? "");
}
