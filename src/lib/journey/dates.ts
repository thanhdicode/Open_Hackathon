/**
 * The canonical exchange timeline, and the stage derived from it.
 *
 * WHY STAGE IS DERIVED AND NOT CHOSEN
 *
 * The onboarding form used to show a hardcoded "Aug 2026 / Dec 2026" card and
 * then write `exchange_stage: "studying"` regardless of what the student said.
 * Two consequences followed: the dates were never real, and Today, the Greenbook
 * and every AI prompt were told the student was mid-exchange even if they had
 * not left home yet. The brief is explicit that stage must come from the dates
 * and that a manual override is the exception, not the mechanism.
 *
 * So this module owns one decision: given a timeline and a moment, which stage
 * is the student in? It is pure — no clock, no network, no storage — because the
 * value it produces feeds Today, the Greenbook filters and the AI context, and a
 * date bug there would be invisible in the UI and wrong in every prompt.
 *
 * All dates are `YYYY-MM-DD` calendar days. A student's exchange is a local
 * calendar fact, not an instant, so parsing them as instants in the viewer's
 * timezone is the bug this avoids.
 */

export type JourneyRole = "incoming" | "current_exchange" | "returned" | "local";

export type ExchangeStage =
  | "before_departure"
  | "arriving_soon"
  | "first_24h"
  | "first_week"
  | "settling_in"
  | "studying"
  | "returning_home"
  | "returned";

/** The canonical timeline. Arrival and return are the two the product depends on. */
export interface JourneyDates {
  /** The day the student leaves home. Optional: a local student never departs. */
  departureDate: string | null;
  /** The day the student lands in the host country. */
  arrivalDate: string | null;
  /** The day teaching starts. Optional: often the same week as arrival. */
  programStartDate: string | null;
  /** The day teaching ends. Optional. */
  programEndDate: string | null;
  /** The day the student flies home. */
  returnDate: string | null;
}

export const EMPTY_JOURNEY_DATES: JourneyDates = {
  departureDate: null,
  arrivalDate: null,
  programStartDate: null,
  programEndDate: null,
  returnDate: null,
};

/**
 * Stage boundaries, in days.
 *
 * Named constants rather than literals because the boundaries are a product
 * decision ("when does 'arriving soon' begin?") and a reader should be able to
 * see and change them without decoding arithmetic.
 */
export const STAGE_WINDOWS = {
  /** Two weeks out is when pre-departure admin becomes urgent. */
  arrivingSoonDays: 14,
  /** The first day is its own stage: it is the one with arrival logistics. */
  first24HoursDays: 1,
  /** A week is the conventional settling window before teaching dominates. */
  firstWeekDays: 7,
  /** "Settling in" runs to three weeks past teaching start, then it is routine. */
  settlingDaysAfterStart: 21,
  /** The last two weeks are the return window. */
  returningHomeDays: 14,
};

/** Stage order, used for sorting and for "which stage is later" comparisons. */
export const STAGE_ORDER: ExchangeStage[] = [
  "before_departure",
  "arriving_soon",
  "first_24h",
  "first_week",
  "settling_in",
  "studying",
  "returning_home",
  "returned",
];

const STAGE_LABELS: Record<ExchangeStage, string> = {
  before_departure: "Before departure",
  arriving_soon: "Arriving soon",
  first_24h: "First 24 hours",
  first_week: "First week",
  settling_in: "Settling in",
  studying: "Studying",
  returning_home: "Returning home",
  returned: "Returned home",
};

export function stageLabel(stage: ExchangeStage): string {
  return STAGE_LABELS[stage] ?? stage;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a `YYYY-MM-DD` day into UTC midnight.
 *
 * UTC rather than local: `new Date("2026-10-01")` is already UTC midnight, and
 * mixing it with `new Date()` (local) is how an off-by-one-day bug appears for
 * anyone east of Greenwich — which is everyone this product is for.
 */
export function parseDay(value: string | null | undefined): number | null {
  if (!value || !DATE_PATTERN.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** Today, as a UTC-midnight day number, so comparisons stay in one frame. */
export function todayAsDay(now: Date = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

const DAY_MS = 86_400_000;

/**
 * Derive the stage from the timeline.
 *
 * Order matters, and it is deliberately "most specific window first":
 *   - a returned student is returned no matter what else the dates say
 *   - inside the last two weeks before return, they are returning home even
 *     though they are also technically still studying
 *   - with no arrival date we cannot place the student, so the answer is
 *     `before_departure` — the only stage that assumes nothing has happened yet.
 */
export function deriveStage(dates: JourneyDates, now: Date = new Date()): ExchangeStage {
  const today = todayAsDay(now);
  const arrival = parseDay(dates.arrivalDate);
  const programStart = parseDay(dates.programStartDate);
  const returnDay = parseDay(dates.returnDate);

  if (arrival === null) return "before_departure";

  if (returnDay !== null && today >= returnDay) return "returned";

  const daysToArrival = Math.round((arrival - today) / DAY_MS);

  // Before landing: two windows, split by how soon the flight is.
  if (daysToArrival > 0) {
    return daysToArrival <= STAGE_WINDOWS.arrivingSoonDays ? "arriving_soon" : "before_departure";
  }

  // Return window wins over "studying": the last fortnight is its own stage.
  if (returnDay !== null && today >= returnDay - STAGE_WINDOWS.returningHomeDays * DAY_MS) return "returning_home";

  const daysSinceArrival = Math.round((today - arrival) / DAY_MS);
  if (daysSinceArrival < STAGE_WINDOWS.first24HoursDays) return "first_24h";
  if (daysSinceArrival < STAGE_WINDOWS.firstWeekDays) return "first_week";

  // Teaching start is the better anchor for "settling in" when we have it;
  // without it, fall back to three weeks past arrival.
  if (programStart !== null) {
    const daysSinceStart = Math.round((today - programStart) / DAY_MS);
    if (daysSinceStart < STAGE_WINDOWS.settlingDaysAfterStart) return "settling_in";
    return "studying";
  }
  if (daysSinceArrival < STAGE_WINDOWS.firstWeekDays + STAGE_WINDOWS.settlingDaysAfterStart) return "settling_in";
  return "studying";
}

/**
 * Which Greenbook chapter set the student is in.
 *
 * Kept separate from `deriveStage` because several stages share one chapter set:
 * the first day and the first week both need arrival logistics.
 */
export function stageToChapterHint(stage: ExchangeStage): "get_ready" | "land_and_settle" | "study_here" {
  switch (stage) {
    case "before_departure":
    case "arriving_soon":
      return "get_ready";
    case "first_24h":
    case "first_week":
    case "settling_in":
      return "land_and_settle";
    default:
      return "study_here";
  }
}

/** Days remaining until a date, or null when it is absent or past. */
export function daysUntil(value: string | null, now: Date = new Date()): number | null {
  const day = parseDay(value);
  if (day === null) return null;
  const diff = Math.round((day - todayAsDay(now)) / DAY_MS);
  return diff >= 0 ? diff : null;
}

/**
 * Problems with a timeline, as human-readable strings.
 *
 * The onboarding form is the only place these can be fixed, so the rule lives
 * here and the form renders whatever it returns — one definition, not a form
 * validation and a separate persistence check that can disagree.
 */
export function timelineProblems(dates: JourneyDates): string[] {
  const problems: string[] = [];
  const arrival = parseDay(dates.arrivalDate);
  const departure = parseDay(dates.departureDate);
  const programStart = parseDay(dates.programStartDate);
  const programEnd = parseDay(dates.programEndDate);
  const returnDay = parseDay(dates.returnDate);

  if (arrival === null) problems.push("An arrival date is required — Today, the Greenbook and every AI answer depend on it.");
  if (returnDay === null) problems.push("A return date is required so we know how long you are staying.");
  if (arrival !== null && returnDay !== null && returnDay <= arrival) problems.push("The return date must be after the arrival date.");
  if (departure !== null && arrival !== null && departure > arrival) problems.push("You cannot depart after you arrive.");
  if (programStart !== null && arrival !== null && programStart < arrival) problems.push("The programme cannot start before you arrive.");
  if (programStart !== null && programEnd !== null && programEnd < programStart) problems.push("The programme cannot end before it starts.");
  if (programEnd !== null && returnDay !== null && returnDay < programEnd) problems.push("You cannot return home before the programme ends.");
  return problems;
}

/** Total days of the exchange, for the "~130 days" summary. Null when unknown. */
export function exchangeLengthDays(dates: JourneyDates): number | null {
  const arrival = parseDay(dates.arrivalDate);
  const returnDay = parseDay(dates.returnDate);
  if (arrival === null || returnDay === null) return null;
  return Math.max(0, Math.round((returnDay - arrival) / DAY_MS));
}

/**
 * Which day of the exchange it is, 1-based, counted from arrival.
 *
 * Before arrival this is 0, not a negative number and not 1 — "Day 0" is the
 * honest answer to "how far into your exchange are you" when the answer is
 * "you have not left yet". The seed journeys carried a hardcoded `dayCount` of
 * 34, which a brand-new student inherited because `makeCustomJourney` spreads
 * the first seed; deriving it is what stops one student seeing another's
 * schedule.
 */
export function dayOfExchange(dates: JourneyDates, now: Date = new Date()): number {
  const arrival = parseDay(dates.arrivalDate);
  if (arrival === null) return 0;
  const diff = Math.round((todayAsDay(now) - arrival) / DAY_MS);
  return diff < 0 ? 0 : diff + 1;
}

/**
 * The role a timeline implies, unless the student is a local student.
 *
 * A local student has no arrival: they are already there. Everything else is
 * derived so the profile cannot claim "incoming" while the dates say they
 * landed three months ago.
 */
export function deriveRole(dates: JourneyDates, now: Date = new Date()): JourneyRole {
  const stage = deriveStage(dates, now);
  if (stage === "returned") return "returned";
  if (stage === "before_departure" || stage === "arriving_soon") return "incoming";
  return "current_exchange";
}
