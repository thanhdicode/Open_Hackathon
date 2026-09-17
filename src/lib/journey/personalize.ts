import { COUNTRIES, type CountryCode } from "../../data/countries";
import type { Journey } from "../../data/journeys";
import type { DnaScores } from "../../data/dna";
import { computePairDNA } from "../../data/pairDNA";
import { deriveStage, dayOfExchange, exchangeLengthDays, stageLabel, type JourneyDates } from "./dates";

const DAY_MONTH_YEAR = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/**
 * One date format for the whole product: `1 Oct 2026`.
 *
 * Two traps this closes. The locale is pinned to `en-GB` rather than `en`,
 * because `en` resolves against the *host* locale — on a `vi-VN` machine
 * `new Intl.DateTimeFormat("en", …)` renders `Oct 1, 2026`, so a student in Ha
 * Noi and a student in Singapore would read the same journey with a different
 * day/month order. And the instant is anchored to UTC, because a bare
 * `new Date("2026-10-01")` parsed west of Greenwich renders as `30 Sep 2026`;
 * the canonical timeline stores plain days, so the day shown must be the day
 * stored.
 *
 * This is the single `arrival`/`return` label used everywhere the app prints a
 * journey date. Do not call `toLocaleDateString(undefined, …)` for these: the
 * browser locale is a display preference, never a source of truth about which
 * calendar day the student chose.
 *
 * Known cosmetic quirk: `en-GB` renders September as `Sept` (four letters)
 * while the hand-written seed labels use `Sep`. September is not in the seed
 * journey set, so nothing is inconsistent today. If a seeded journey ever lands
 * in September, align the seed to this formatter rather than forking the format.
 */
export function journeyDateLabel(value: string | null): string {
  if (!value) return "Not set";
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return "Not set";
  return DAY_MONTH_YEAR.format(parsed);
}

/** Fresh and restored custom journeys share this projection; seed stories stay unchanged. */
export function personalizeJourney(home: CountryCode, host: CountryCode, myDna: DnaScores, dates: JourneyDates): Partial<Journey> {
  const country = COUNTRIES[host].name;
  const stage = deriveStage(dates);
  const upcoming = stage === "before_departure" || stage === "arriving_soon";
  return {
    id: "custom", name: "You", age: undefined, initials: "Y", avatarColor: "#3157D5", home, host, myDna,
    dates, arrival: journeyDateLabel(dates.arrivalDate), departure: journeyDateLabel(dates.returnDate),
    city: "", university: "", major: "", interests: [], concerns: [], languages: [],
    dayCount: dayOfExchange(dates), totalDays: exchangeLengthDays(dates) ?? 0,
    weekProgress: 0, readiness: computePairDNA(home, host, myDna).readiness,
    myDnaAssessed: false,
    primaryTask: { id: `${home}-${host}-${upcoming ? "prepare" : "settle"}`, title: upcoming ? `Prepare for ${country}` : `Find your next step in ${country}`, meta: "Read sourced guidance for your destination", phase: stageLabel(stage) },
    practiceMission: { title: upcoming ? "Practise introducing yourself" : "Practise a useful everyday conversation", reason: `Rehearse a situation you may meet in ${country}.` },
    reminder: { title: upcoming ? "Your arrival" : "Your journey", when: journeyDateLabel(dates.arrivalDate) },
    cultureTip: { title: "People and situations vary", body: "Use cultural guidance as a starting point. Ask the person when context is unclear." },
  };
}
