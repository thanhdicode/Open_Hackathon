import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("./ts-resolve-hooks.mjs", import.meta.url);
const { timelineProblems, EMPTY_JOURNEY_DATES } = await import("../../src/lib/journey/dates.ts");

test("explicit arrival accepts unknown return and rejects malformed supplied dates", () => {
  assert.deepEqual(timelineProblems({ ...EMPTY_JOURNEY_DATES, arrivalDate: "2026-10-01" }), []);
  assert.ok(timelineProblems({ ...EMPTY_JOURNEY_DATES, arrivalDate: "2026-10-01", returnDate: "2026-02-31" }).length);
  assert.ok(timelineProblems({ ...EMPTY_JOURNEY_DATES, arrivalDate: "2026-10-01", departureDate: "not-a-date" }).length);
});

test("custom projection never inherits another student’s route or biography", async () => {
  const { personalizeJourney } = await import("../../src/lib/journey/personalize.ts");
  const dna = { directness: 50, formality: 50, hierarchy: 50, conflict: 50, relationship: 50, time: 50, participation: 50, uncertainty: 50 };
  const dates = { ...EMPTY_JOURNEY_DATES, arrivalDate: "2026-10-01" };
  const a = personalizeJourney("VN", "TH", dna, dates);
  const b = personalizeJourney("TH", "VN", dna, dates);
  assert.equal(a.host, "TH");
  assert.equal(a.university, "");
  assert.deepEqual(a.interests, []);
  assert.deepEqual(a.languages, []);
  assert.equal(a.departure, "Not set");
  assert.notEqual(a.primaryTask.id, b.primaryTask.id);
  assert.match(a.reminder.when, /2026/);
  assert.ok(!JSON.stringify(a).includes("NUS"));
});
