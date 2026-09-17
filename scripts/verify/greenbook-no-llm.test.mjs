/**
 * No-LLM Greenbook answer tests.
 *
 * The whole Greenbook design rests on one claim: when every AI provider is
 * rate-limited, undeployed or offline, "Ask this Greenbook" still answers from
 * verified facts. Until this file existed that claim was asserted in a comment
 * and never exercised, because the assembly lived behind the Appwrite client.
 *
 * These tests drive the extracted pure module directly, so the reliability
 * fallback is now a measured property rather than a promise. They deliberately
 * check that the fallback REFUSES when there is no evidence — the failure mode
 * worth guarding against is a plausible-sounding answer assembled from nothing.
 *
 * Run: node --test scripts/verify/greenbook-no-llm.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);

const { UNVERIFIED_ANSWER, buildNoLlmAnswer, latestCheck, trustStateOf } = await import("../../src/lib/greenbook/no-llm.ts");

/** A stored fact row, in the shape the store returns. */
function fact(overrides = {}) {
  return {
    factId: "f1",
    sourceId: "sg-ica-student",
    countryCode: "SG",
    city: null,
    universityId: null,
    chapter: "land_and_settle",
    journeyStage: "arrival",
    claim: "Incoming students must hold a Student's Pass issued by ICA.",
    action: "Apply through the Student's Pass Online Application and Registration system.",
    evidenceQuote: "The Student's Pass facility is granted to non-citizen students…",
    authorityLevel: "A",
    verificationStatus: "official_verified",
    confidenceLabel: "high",
    checkedAt: "2026-09-10T00:00:00.000Z",
    validUntil: null,
    ...overrides,
  };
}

function packet(facts, sources = [{ sourceId: "sg-ica-student", title: "ICA — Student's Pass", url: "https://www.ica.gov.sg/", authorityLevel: "A" }]) {
  return { countryCode: "SG", chapter: null, facts, sources, retrievalSteps: [], retrievedAt: "2026-09-16T00:00:00.000Z" };
}

/* -------------------------------------------------------------------------- */
/* The refusal path — the one that matters most                               */
/* -------------------------------------------------------------------------- */

test("an empty evidence packet refuses instead of inventing an answer", () => {
  const answer = buildNoLlmAnswer(packet([]), []);
  assert.equal(answer.answer, UNVERIFIED_ANSWER);
  assert.equal(answer.mode, "no_llm");
  assert.equal(answer.confidence, "low");
  assert.deepEqual(answer.sources, []);
  assert.deepEqual(answer.facts, []);
  // No action may be suggested when there is no evidence for one.
  assert.deepEqual(answer.whatToDo, []);
});

test("a packet with sources but no facts still refuses", () => {
  // Sources alone are not evidence: the corpus holds URLs for every registered
  // agency, including ones with no published fact yet.
  const answer = buildNoLlmAnswer(packet([], [{ sourceId: "sg-ica-student", title: "ICA", url: "https://www.ica.gov.sg/", authorityLevel: "A" }]), []);
  assert.equal(answer.answer, UNVERIFIED_ANSWER);
  assert.deepEqual(answer.sources, []);
});

/* -------------------------------------------------------------------------- */
/* The useful path — what the student actually sees                            */
/* -------------------------------------------------------------------------- */

test("official facts produce a briefing, the actions and the official sources", () => {
  const answer = buildNoLlmAnswer(packet([fact()]), ["Xin chào — hello"]);
  assert.equal(answer.mode, "no_llm");
  assert.match(answer.answer, /Student's Pass/);
  // The briefing leads each group with the chapter's human title. A raw id here
  // ("land_and_settle" or "land and settle") is implementation leakage into
  // student-facing copy, so this asserts the copy, not the slug.
  assert.match(answer.answer, /Landing and settling in/);
  assert.doesNotMatch(answer.answer, /land[_\s]and[_\s]settle/i);
  assert.deepEqual(answer.whatToDo, ["Apply through the Student's Pass Online Application and Registration system."]);
  assert.equal(answer.sources.length, 1);
  assert.equal(answer.sources[0].sourceId, "sg-ica-student");
  assert.deepEqual(answer.whatToSay, ["Xin chào — hello"]);
  assert.equal(answer.lastChecked, "2026-09-10T00:00:00.000Z");
});

test("the briefing is grouped by chapter and capped at four", () => {
  const facts = ["get_ready", "land_and_settle", "study_here", "money_and_pay", "live_here", "move_around"].map((chapter, index) =>
    fact({ factId: `f${index}`, chapter, claim: `Claim for ${chapter}.` }),
  );
  const answer = buildNoLlmAnswer(packet(facts), []);
  const chapters = answer.answer.split(" ").filter((token) => token.endsWith(":"));
  assert.ok(chapters.length <= 4, `expected at most 4 chapter groups, got ${chapters.length}`);
});

test("documents and preparation are surfaced from get_ready and action text", () => {
  const answer = buildNoLlmAnswer(
    packet([
      fact({ factId: "a", chapter: "get_ready", claim: "Bring a passport valid for six months.", action: "Check your passport expiry date." }),
      fact({ factId: "b", chapter: "culture_and_people", claim: "Address lecturers formally.", action: null }),
    ]),
    [],
  );
  assert.ok(answer.whatToPrepare.includes("Check your passport expiry date."));
  assert.ok(answer.whatToPrepare.length <= 5);
});

/* -------------------------------------------------------------------------- */
/* Trust state — the judgement the UI and the fallback must share              */
/* -------------------------------------------------------------------------- */

test("trust state maps every verification status the pipeline can emit", () => {
  assert.equal(trustStateOf(fact({ verificationStatus: "official_verified" })), "official");
  assert.equal(trustStateOf(fact({ verificationStatus: "university_verified" })), "university");
  assert.equal(trustStateOf(fact({ verificationStatus: "community_verified" })), "community");
  assert.equal(trustStateOf(fact({ verificationStatus: "stale" })), "stale");
  // Anything unrecognised is unverified, never trusted by default.
  assert.equal(trustStateOf(fact({ verificationStatus: "needs_review" })), "needs_review");
  assert.equal(trustStateOf(fact({ verificationStatus: "something_new" })), "needs_review");
});

test("an expired validUntil makes a verified fact stale", () => {
  const now = Date.parse("2026-09-16T00:00:00.000Z");
  assert.equal(trustStateOf(fact({ validUntil: "2026-09-15T00:00:00.000Z" }), now), "stale");
  assert.equal(trustStateOf(fact({ validUntil: "2026-10-01T00:00:00.000Z" }), now), "official");
});

/* -------------------------------------------------------------------------- */
/* Warnings — the caveats a student must not be shielded from                  */
/* -------------------------------------------------------------------------- */

test("stale facts raise a warning that counts them", () => {
  const answer = buildNoLlmAnswer(packet([fact({ factId: "a" }), fact({ factId: "b", validUntil: "2020-01-01T00:00:00.000Z" })]), []);
  assert.ok(answer.warnings.some((warning) => /out of date/.test(warning)));
});

test("community-sourced facts are labelled as hints, not rules", () => {
  const answer = buildNoLlmAnswer(packet([fact({ verificationStatus: "community_verified", authorityLevel: "C" })]), []);
  assert.ok(answer.warnings.some((warning) => /community reports/.test(warning)));
  assert.ok(answer.warnings.some((warning) => /secondary rather than official/.test(warning)));
});

test("a fully official packet raises no warnings", () => {
  const answer = buildNoLlmAnswer(packet([fact()]), []);
  assert.deepEqual(answer.warnings, []);
});

/* -------------------------------------------------------------------------- */
/* Confidence and freshness                                                   */
/* -------------------------------------------------------------------------- */

test("confidence follows the count of authority-A facts, not the model's mood", () => {
  assert.equal(buildNoLlmAnswer(packet([fact({ factId: "a" })]), []).confidence, "medium");
  assert.equal(buildNoLlmAnswer(packet([fact({ factId: "a" }), fact({ factId: "b" }), fact({ factId: "c" })]), []).confidence, "high");
  // Authority C only: nothing authoritative carries the answer.
  assert.equal(buildNoLlmAnswer(packet([fact({ authorityLevel: "C", verificationStatus: "community_verified" })]), []).confidence, "low");
});

test("lastChecked is the most recent check across the packet", () => {
  const facts = [fact({ factId: "a", checkedAt: "2026-01-01T00:00:00.000Z" }), fact({ factId: "b", checkedAt: "2026-09-10T00:00:00.000Z" })];
  assert.equal(latestCheck(facts), "2026-09-10T00:00:00.000Z");
  assert.equal(latestCheck([]), null);
});

/* -------------------------------------------------------------------------- */
/* Determinism — the property that makes a fallback safe                       */
/* -------------------------------------------------------------------------- */

test("the same packet always produces the same answer", () => {
  const input = packet([fact({ factId: "a" }), fact({ factId: "b", chapter: "get_ready", action: "Prepare documents." })]);
  assert.deepEqual(buildNoLlmAnswer(input, ["x"]), buildNoLlmAnswer(input, ["x"]));
});

test("the no-LLM answer never exceeds the shape the UI renders", () => {
  const facts = Array.from({ length: 30 }, (_, index) => fact({ factId: `f${index}`, chapter: `ch${index % 9}`, action: `Action ${index}` }));
  const answer = buildNoLlmAnswer(packet(facts), []);
  assert.ok(answer.whatToDo.length <= 8, `whatToDo was ${answer.whatToDo.length}`);
  assert.ok(answer.whatToPrepare.length <= 5, `whatToPrepare was ${answer.whatToPrepare.length}`);
});
