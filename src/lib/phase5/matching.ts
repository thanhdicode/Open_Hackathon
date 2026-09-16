import { campusFor, campusKey } from "../../data/campuses";
import { COUNTRIES } from "../../data/countries";
import type { MatchReason, ScoredProfile, SocialProfile } from "./contract";

/**
 * Deterministic people matching.
 *
 * WHY NOT A RECOMMENDER
 *
 * The brief rules out an ML recommender, and that is the right call for a reason
 * beyond cost: an opaque compatibility percentage on a screen that helps a
 * 19-year-old decide who to trust in a new country is a claim nobody can audit.
 * Every point below is a fact about two profiles that the student can read for
 * themselves, and the UI shows the reasons rather than the number.
 *
 * The weights are the contract. They are declared here, in one place, and
 * `matching.test.mjs` pins them — so changing what "a good match" means is a
 * deliberate edit rather than a drifting constant.
 */

export const MATCH_WEIGHTS = {
  sameCampus: 30,
  sameCity: 12,
  sameHostCountry: 15,
  sameMajor: 18,
  /** Related but not identical field, e.g. "Computer Science" vs "Software Engineering". */
  relatedMajor: 9,
  perSharedInterest: 8,
  maxSharedInterests: 24,
  perSharedLanguage: 7,
  maxSharedLanguages: 21,
  /** They have already done the journey you are about to do. */
  relevantExchangeHistory: 10,
  /** They are a local student where you are going. */
  localWhereYouAreGoing: 12,
} as const;

export const MATCH_BANDS = [
  { min: 70, label: "Strong match" },
  { min: 45, label: "Good match" },
  { min: 20, label: "Some overlap" },
  { min: 0, label: "Worth a look" },
] as const;

export interface ViewerContext {
  userId: string | null;
  homeCountry: string;
  hostCountry: string;
  city: string;
  university: string;
  major?: string;
  interests?: string[];
  languages?: string[];
  blockedIds?: Set<string>;
}

const LANGUAGES: Record<string, string> = {
  en: "English",
  ms: "Malay",
  id: "Indonesian",
  vi: "Vietnamese",
  th: "Thai",
  tl: "Filipino",
  km: "Khmer",
  zh: "Mandarin",
  my: "Burmese",
  lo: "Lao",
  ta: "Tamil",
  bn: "Bengali",
};

export function languageName(code: string): string {
  return LANGUAGES[code.toLowerCase()] ?? code.toUpperCase();
}

/**
 * Display names that mean the same language, mapped to one code.
 *
 * The app holds languages in two shapes: `journeys.ts` stores what a student
 * picked from a list ("Bahasa Indonesia"), while a social profile stores the ISO
 * code the seed pack and the DB column use ("id"). Comparing the two directly
 * silently matches nothing — no error, just an empty "Speaks …" reason — so every
 * name is funnelled through this table before it reaches `overlap`.
 */
const LANGUAGE_ALIASES: Record<string, string> = {
  "bahasa indonesia": "id",
  "bahasa melayu": "ms",
  indonesian: "id",
  malay: "ms",
  english: "en",
  vietnamese: "vi",
  thai: "th",
  filipino: "tl",
  tagalog: "tl",
  khmer: "km",
  mandarin: "zh",
  chinese: "zh",
  burmese: "my",
  lao: "lo",
  tamil: "ta",
  bengali: "bn",
};

/**
 * Normalise one language written as either an ISO code or a display name.
 * Unknown input is returned lower-cased so two identical unknowns still match.
 */
export function languageCode(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";
  if (trimmed in LANGUAGES) return trimmed;
  return LANGUAGE_ALIASES[trimmed] ?? trimmed;
}

/** Normalise a list, dropping blanks and duplicates so a reason never repeats. */
export function languageCodes(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const code = languageCode(value);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    result.push(code);
  }
  return result;
}

export function countryName(code: string): string {
  const entry = (COUNTRIES as Record<string, { name?: string } | undefined>)[code];
  return entry?.name ?? code;
}

/** Tokenise a field like "Computer Science" into comparable words. */
function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !["and", "the", "of", "for"].includes(token));
}

function overlap(a: string[], b: string[]): string[] {
  const setB = new Set(b.map((value) => value.toLowerCase()));
  return a.filter((value) => setB.has(value.toLowerCase()));
}

/**
 * Two majors are "related" when they share a meaningful token — enough to say
 * "you are both in computing" without pretending to know the field taxonomy.
 */
function majorsRelated(a: string, b: string): boolean {
  if (!a || !b) return false;
  const shared = overlap(tokens(a), tokens(b));
  return shared.length > 0;
}

export interface ScoreResult {
  score: number;
  reasons: MatchReason[];
}

export function scoreProfile(profile: SocialProfile, viewer: ViewerContext): ScoreResult {
  let score = 0;
  const reasons: MatchReason[] = [];

  // --- institution ---
  const sameCampus = campusKey(profile.universityId) === campusKey(viewer.university) && Boolean(viewer.university);
  if (sameCampus) {
    score += MATCH_WEIGHTS.sameCampus;
    const campus = campusFor(profile.universityId);
    reasons.push({ label: `Also at ${campus?.universityId.toUpperCase() ?? profile.universityId}`, detail: "You are at the same university" });
  }

  // --- place ---
  if (profile.city && viewer.city && profile.city.toLowerCase() === viewer.city.toLowerCase()) {
    score += MATCH_WEIGHTS.sameCity;
    reasons.push({ label: `Also in ${profile.city}`, detail: "You are in the same city" });
  }

  if (profile.hostCountry && profile.hostCountry === viewer.hostCountry) {
    score += MATCH_WEIGHTS.sameHostCountry;
    if (!sameCampus) {
      reasons.push({ label: `In ${countryName(profile.hostCountry)} too`, detail: "You share a host country" });
    }
  }

  // --- study ---
  if (profile.major && viewer.major) {
    if (profile.major.toLowerCase() === viewer.major.toLowerCase()) {
      score += MATCH_WEIGHTS.sameMajor;
      reasons.push({ label: `Studying ${profile.major}`, detail: "You are in the same field" });
    } else if (majorsRelated(profile.major, viewer.major)) {
      score += MATCH_WEIGHTS.relatedMajor;
      reasons.push({ label: `Also in ${profile.major}`, detail: "Your fields overlap" });
    }
  }

  // --- interests ---
  const sharedInterests = overlap(profile.interests, viewer.interests ?? []);
  if (sharedInterests.length) {
    const points = Math.min(sharedInterests.length * MATCH_WEIGHTS.perSharedInterest, MATCH_WEIGHTS.maxSharedInterests);
    score += points;
    reasons.push({
      label: `Into ${sharedInterests.slice(0, 3).join(", ")}`,
      detail: `${sharedInterests.length} shared interest${sharedInterests.length > 1 ? "s" : ""}`,
    });
  }

  // --- language ---
  const sharedLanguages = overlap(profile.languages, viewer.languages ?? []);
  if (sharedLanguages.length) {
    const points = Math.min(sharedLanguages.length * MATCH_WEIGHTS.perSharedLanguage, MATCH_WEIGHTS.maxSharedLanguages);
    score += points;
    const names = sharedLanguages.slice(0, 3).map(languageName);
    reasons.push({ label: `Speaks ${names.join(", ")}`, detail: `${sharedLanguages.length} shared language${sharedLanguages.length > 1 ? "s" : ""}` });
  }

  /*
   * Direction matters. A student who has already made the trip you are about to
   * make is more useful than one who shares a hobby, and the reverse direction
   * (you did SG→MY, they did MY→SG) is genuinely different advice — the same
   * reason `PairDNA` refuses to collapse VN→SG into SG→VN.
   *
   * A profile may legitimately have no country yet (a student who has not finished
   * onboarding). Both reasons below name a country, so they are skipped entirely
   * rather than rendered with a blank side of the arrow.
   */
  const { homeCountry, hostCountry } = profile;
  if (homeCountry && hostCountry) {
    const didYourTrip = homeCountry === viewer.homeCountry && hostCountry === viewer.hostCountry;
    if (didYourTrip && !sameCampus) {
      score += MATCH_WEIGHTS.relevantExchangeHistory;
      reasons.push({
        label: `${countryName(homeCountry)} → ${countryName(hostCountry)}`,
        detail: "They made the same move you are making",
      });
    }

    const isLocalWhereYouAreGoing = profile.role === "local" && hostCountry === viewer.hostCountry;
    if (isLocalWhereYouAreGoing) {
      score += MATCH_WEIGHTS.localWhereYouAreGoing;
      reasons.push({ label: "Local student", detail: `They live in ${countryName(hostCountry)}` });
    }
  }

  return { score, reasons };
}

export function bandFor(score: number): string {
  return MATCH_BANDS.find((band) => score >= band.min)?.label ?? "Worth a look";
}

export interface RankOptions {
  viewer: ViewerContext;
  /** How many places each author has shared, so "shared 3 useful places" is a fact. */
  placesSharedByAuthor?: Map<string, number>;
  limit?: number;
}

/**
 * Rank discoverable profiles.
 *
 * Three hard filters run before scoring, and they are filters rather than
 * penalties: a blocked student, the viewer themself, and anyone who has turned
 * discoverability off must not appear at any score.
 */
export function rankProfiles(profiles: SocialProfile[], options: RankOptions): ScoredProfile[] {
  const { viewer } = options;
  const blocked = viewer.blockedIds ?? new Set<string>();

  const scored = profiles
    .filter((profile) => profile.discoverable)
    .filter((profile) => profile.userId !== viewer.userId)
    .filter((profile) => !blocked.has(profile.userId))
    .map((profile) => {
      const { score, reasons } = scoreProfile(profile, viewer);
      const placesShared = options.placesSharedByAuthor?.get(profile.userId) ?? profile.counts.placesShared;
      const enriched = [...reasons];
      if (placesShared > 0) {
        enriched.push({
          label: `Shared ${placesShared} place${placesShared > 1 ? "s" : ""}`,
          detail: `Useful places in ${countryName(profile.hostCountry ?? viewer.hostCountry)}`,
        });
      }
      return { profile, score, reasons: enriched };
    })
    .sort((a, b) => b.score - a.score || a.profile.displayName.localeCompare(b.profile.displayName));

  return options.limit ? scored.slice(0, options.limit) : scored;
}

/** One-line summary used on the profile header. */
export function matchSummary(result: ScoreResult): string {
  if (!result.reasons.length) return "No obvious overlap yet";
  return `Matched on ${result.reasons.length} thing${result.reasons.length > 1 ? "s" : ""} you share`;
}
