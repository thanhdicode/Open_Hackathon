/**
 * Exchange timeline and derived-stage tests.
 *
 * The stage this module returns is written to the profile and then read by
 * Today, the Greenbook filters and every AI prompt. A boundary bug here would be
 * invisible in the UI — the student would simply be shown the wrong chapter —
 * and wrong in every prompt, so the boundaries are pinned rather than eyeballed.
 *
 * The timezone cases matter more than they look. The user is at GMT+7 and the
 * product is for all of ASEAN, so "arrival day" must mean the same calendar day
 * for everyone; every date is a `YYYY-MM-DD` day, never an instant.
 *
 * Run: node --test scripts/verify/journey-dates.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);

const {
  EMPTY_JOURNEY_DATES,
  STAGE_ORDER,
  daysUntil,
  deriveRole,
  deriveStage,
  exchangeLengthDays,
  parseDay,
  stageLabel,
  stageToChapterHint,
  timelineProblems,
} = await import("../../src/lib/journey/dates.ts");

/** A well-formed Corridor A timeline: Minh, Vietnam → Singapore, Oct 2026. */
const MINH = {
  departureDate: "2026-09-29",
  arrivalDate: "2026-10-01",
  programStartDate: "2026-10-05",
  programEndDate: "2027-01-22",
  returnDate: "2027-01-31",
};

/** A moment, as a UTC date, so tests do not depend on the machine clock. */
const at = (day) => new Date(`${day}T12:00:00Z`);

/* -------------------------------------------------------------------------- */
/* Parsing — the UTC rule                                                     */
/* -------------------------------------------------------------------------- */

test("a calendar day parses to UTC midnight, not local midnight", () => {
  assert.equal(parseDay("2026-10-01"), Date.UTC(2026, 9, 1));
});

test("anything that is not a plain day is rejected rather than guessed", () => {
  for (const bad of [null, undefined, "", "01/10/2026", "2026-10", "2026-10-01T00:00:00Z", "not a date"]) {
    assert.equal(parseDay(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

/* -------------------------------------------------------------------------- */
/* Stage boundaries                                                           */
/* -------------------------------------------------------------------------- */

test("with no arrival date the student is before departure", () => {
  // The only stage that assumes nothing has happened yet.
  assert.equal(deriveStage(EMPTY_JOURNEY_DATES, at("2026-10-01")), "before_departure");
});

test("far out is before departure, inside two weeks is arriving soon", () => {
  assert.equal(deriveStage(MINH, at("2026-09-01")), "before_departure");
  // Exactly 14 days out: the window opens inclusively.
  assert.equal(deriveStage(MINH, at("2026-09-17")), "arriving_soon");
  assert.equal(deriveStage(MINH, at("2026-09-30")), "arriving_soon");
});

test("arrival day is its own stage", () => {
  assert.equal(deriveStage(MINH, at("2026-10-01")), "first_24h");
});

test("the first week runs to day seven, then settling begins", () => {
  assert.equal(deriveStage(MINH, at("2026-10-02")), "first_week");
  assert.equal(deriveStage(MINH, at("2026-10-07")), "first_week");
  assert.equal(deriveStage(MINH, at("2026-10-08")), "settling_in");
});

test("settling in is anchored to teaching start when it is known", () => {
  // Teaching starts 2026-10-05; settling runs 21 days past it, to 2026-10-26.
  assert.equal(deriveStage(MINH, at("2026-10-25")), "settling_in");
  assert.equal(deriveStage(MINH, at("2026-10-27")), "studying");
  assert.equal(deriveStage(MINH, at("2026-12-01")), "studying");
});

test("without a programme start, settling falls back to three weeks past arrival", () => {
  const noProgram = { ...MINH, programStartDate: null };
  assert.equal(deriveStage(noProgram, at("2026-10-20")), "settling_in");
  assert.equal(deriveStage(noProgram, at("2026-11-01")), "studying");
});

test("the last fortnight is returning home, even though teaching may continue", () => {
  // Return is 2027-01-31, so the window opens 2027-01-17.
  assert.equal(deriveStage(MINH, at("2027-01-16")), "studying");
  assert.equal(deriveStage(MINH, at("2027-01-17")), "returning_home");
  assert.equal(deriveStage(MINH, at("2027-01-30")), "returning_home");
});

test("on and after the return date the student has returned", () => {
  assert.equal(deriveStage(MINH, at("2027-01-31")), "returned");
  assert.equal(deriveStage(MINH, at("2027-06-01")), "returned");
});

test("a return date in the past wins over every other window", () => {
  // Even though arrival is far away, a past return means the exchange is over.
  assert.equal(deriveStage({ ...EMPTY_JOURNEY_DATES, arrivalDate: "2030-01-01", returnDate: "2026-01-01" }, at("2026-10-01")), "returned");
});

/* -------------------------------------------------------------------------- */
/* The stage is a closed set                                                  */
/* -------------------------------------------------------------------------- */

test("every stage the deriver can return is in the declared order", () => {
  const samples = ["2026-08-01", "2026-09-20", "2026-10-01", "2026-10-03", "2026-10-12", "2026-11-15", "2027-01-20", "2027-02-05"];
  for (const day of samples) {
    const stage = deriveStage(MINH, at(day));
    assert.ok(STAGE_ORDER.includes(stage), `${day} produced unknown stage ${stage}`);
    assert.ok(stageLabel(stage).length > 0, `${stage} has no label`);
  }
});

test("stage order matches the journey, earliest first", () => {
  assert.deepEqual(STAGE_ORDER, ["before_departure", "arriving_soon", "first_24h", "first_week", "settling_in", "studying", "returning_home", "returned"]);
});

test("stages map to a Greenbook chapter hint", () => {
  assert.equal(stageToChapterHint("before_departure"), "get_ready");
  assert.equal(stageToChapterHint("arriving_soon"), "get_ready");
  assert.equal(stageToChapterHint("first_24h"), "land_and_settle");
  assert.equal(stageToChapterHint("first_week"), "land_and_settle");
  assert.equal(stageToChapterHint("settling_in"), "land_and_settle");
  assert.equal(stageToChapterHint("studying"), "study_here");
  assert.equal(stageToChapterHint("returned"), "study_here");
});

/* -------------------------------------------------------------------------- */
/* Role                                                                       */
/* -------------------------------------------------------------------------- */

test("role follows the timeline so the profile cannot contradict itself", () => {
  assert.equal(deriveRole(MINH, at("2026-09-01")), "incoming");
  assert.equal(deriveRole(MINH, at("2026-09-25")), "incoming");
  assert.equal(deriveRole(MINH, at("2026-10-01")), "current_exchange");
  assert.equal(deriveRole(MINH, at("2026-12-01")), "current_exchange");
  assert.equal(deriveRole(MINH, at("2027-02-01")), "returned");
});

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

test("a complete, coherent timeline has no problems", () => {
  assert.deepEqual(timelineProblems(MINH), []);
});

test("arrival and return are both required", () => {
  const problems = timelineProblems(EMPTY_JOURNEY_DATES);
  assert.equal(problems.length, 2);
  assert.ok(problems.some((problem) => /arrival date is required/.test(problem)));
  assert.ok(problems.some((problem) => /return date is required/.test(problem)));
});

test("an impossible ordering is reported in plain language", () => {
  assert.ok(timelineProblems({ ...MINH, returnDate: "2026-09-01" }).some((problem) => /return date must be after the arrival/.test(problem)));
  assert.ok(timelineProblems({ ...MINH, departureDate: "2026-10-15" }).some((problem) => /cannot depart after you arrive/.test(problem)));
  assert.ok(timelineProblems({ ...MINH, programStartDate: "2026-09-01" }).some((problem) => /cannot start before you arrive/.test(problem)));
  assert.ok(timelineProblems({ ...MINH, programEndDate: "2026-10-01" }).some((problem) => /cannot end before it starts/.test(problem)));
  assert.ok(timelineProblems({ ...MINH, returnDate: "2026-12-01" }).some((problem) => /before the programme ends/.test(problem)));
});

test("optional dates may be absent without raising a problem", () => {
  const problems = timelineProblems({ departureDate: null, arrivalDate: "2026-10-01", programStartDate: null, programEndDate: null, returnDate: "2027-01-31" });
  assert.deepEqual(problems, []);
});

/* -------------------------------------------------------------------------- */
/* Derived extras                                                             */
/* -------------------------------------------------------------------------- */

test("exchange length is measured arrival to return", () => {
  assert.equal(exchangeLengthDays(MINH), 122);
  assert.equal(exchangeLengthDays(EMPTY_JOURNEY_DATES), null);
});

test("daysUntil counts calendar days and returns null once the date has passed", () => {
  assert.equal(daysUntil("2026-10-01", at("2026-10-01")), 0);
  assert.equal(daysUntil("2026-10-11", at("2026-10-01")), 10);
  assert.equal(daysUntil("2026-09-01", at("2026-10-01")), null);
  assert.equal(daysUntil(null, at("2026-10-01")), null);
});

test("deriving the stage twice for the same moment gives the same answer", () => {
  assert.equal(deriveStage(MINH, at("2026-10-08")), deriveStage(MINH, at("2026-10-08")));
});
