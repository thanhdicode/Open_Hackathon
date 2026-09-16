/**
 * Validation gate tests.
 *
 * The gate is the only thing between "a model wrote something" and "the app
 * tells a student what the law requires", so its refusals matter more than its
 * approvals. Every test here feeds it something that MUST be rejected or
 * downgraded; if any of these pass as guidance, the trust story is hollow.
 *
 * Run: node --test scripts/greenbook/validate.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCandidate, validateBatch, summarize, STATUS } from "./validate.mjs";

const REGISTRY_URL = "https://www.imi.gov.my/index.php/en/main-services/pass/student-pass/";
const registryUrls = new Set([REGISTRY_URL]);

/** A candidate that should pass every rule, used as the control. */
function goodCandidate(overrides = {}) {
  return {
    claim: "Applicants for a Student Pass must be outside Malaysia when the application is submitted.",
    action: "Be outside Malaysia before submitting the application.",
    chapter: "get_ready",
    journeyStage: "before_arrival",
    evidenceQuote: "Applicants MUST BE OUTSIDE MALAYSIA at the time of application submission.",
    effectiveFrom: null,
    validUntil: null,
    confidence: 0.9,
    country: "MY",
    sourceId: "my-immigration-student",
    sourceUrl: REGISTRY_URL,
    authorityLevel: "A",
    sourceType: "government",
    sourceStatus: "verified_official",
    factHash: "control-hash",
    ...overrides,
  };
}

test("the control candidate is accepted as official guidance", () => {
  const result = validateCandidate(goodCandidate(), { registryUrls });
  assert.equal(result.verificationStatus, STATUS.OFFICIAL);
  assert.deepEqual(result.validationNotes, []);
});

test("a fact with NO source URL can never be verified", () => {
  const result = validateCandidate(goodCandidate({ sourceUrl: null }), { registryUrls });
  assert.equal(result.verificationStatus, STATUS.UNVERIFIED, "the trust rule is absolute");
  assert.ok(result.validationNotes.some((note) => /no source URL/i.test(note)));
});

test("a source URL the registry does not know about is rejected", () => {
  const result = validateCandidate(goodCandidate({ sourceUrl: "https://example.com/made-up" }), { registryUrls });
  assert.equal(result.verificationStatus, STATUS.UNVERIFIED, "a model must not be able to introduce a URL");
  assert.ok(result.validationNotes.some((note) => /not the one recorded/i.test(note)));
});

test("a claim with no verbatim evidence quote is rejected", () => {
  const result = validateCandidate(goodCandidate({ evidenceQuote: "" }), { registryUrls });
  assert.equal(result.verificationStatus, STATUS.UNVERIFIED);
  assert.ok(result.validationNotes.some((note) => /verbatim evidence/i.test(note)));
});

test("a claim too short to be a requirement is rejected", () => {
  const result = validateCandidate(goodCandidate({ claim: "Apply early." }), { registryUrls });
  assert.equal(result.verificationStatus, STATUS.UNVERIFIED);
});

test("a claim long enough to bundle several requirements is rejected", () => {
  const result = validateCandidate(goodCandidate({ claim: "A".repeat(500) }), { registryUrls });
  assert.equal(result.verificationStatus, STATUS.UNVERIFIED);
  assert.ok(result.validationNotes.some((note) => /bundled/i.test(note)));
});

test("an unrecognised chapter is rejected", () => {
  const result = validateCandidate(goodCandidate({ chapter: "visa_and_food" }), { registryUrls });
  assert.equal(result.verificationStatus, STATUS.UNVERIFIED);
});

test("an implausible effective date is rejected", () => {
  const result = validateCandidate(goodCandidate({ effectiveFrom: "2099-01-01" }), { registryUrls });
  assert.equal(result.verificationStatus, STATUS.UNVERIFIED);
  assert.ok(result.validationNotes.some((note) => /plausible date/i.test(note)));
});

test("a weak-authority source cannot give administrative guidance", () => {
  // A blog saying "students can work 20 hours" is not the Immigration Department.
  const result = validateCandidate(goodCandidate({ authorityLevel: "C", sourceType: "blog" }), { registryUrls });
  assert.equal(result.verificationStatus, STATUS.REVIEW, "downgraded, not deleted");
  assert.ok(result.validationNotes.some((note) => /too weak/i.test(note)));
});

test("a weak source is still fine for a non-administrative chapter", () => {
  const result = validateCandidate(goodCandidate({ authorityLevel: "D", chapter: "culture_and_people", sourceType: "media" }), { registryUrls });
  assert.equal(result.verificationStatus, STATUS.COMMUNITY, "community experience gets its own status, never the official badge");
});

test("a low-confidence fact is downgraded to review", () => {
  const result = validateCandidate(goodCandidate({ confidence: 0.3 }), { registryUrls });
  assert.equal(result.verificationStatus, STATUS.REVIEW);
  assert.ok(result.validationNotes.some((note) => /confidence/i.test(note)));
});

test("a missing confidence is downgraded rather than assumed", () => {
  const result = validateCandidate(goodCandidate({ confidence: null }), { registryUrls });
  assert.equal(result.verificationStatus, STATUS.REVIEW, "an absent signal is not a passing signal");
});

test("a university source is marked as its own tier", () => {
  const result = validateCandidate(goodCandidate({ sourceType: "university", sourceUrl: REGISTRY_URL }), { registryUrls });
  assert.equal(result.verificationStatus, STATUS.UNIVERSITY, "the UI shows university guidance differently from government guidance");
});

test("a hard-rule failure overrides a soft downgrade", () => {
  const result = validateCandidate(goodCandidate({ confidence: 0.2, sourceUrl: null }), { registryUrls });
  assert.equal(result.verificationStatus, STATUS.UNVERIFIED, "unverified wins over needs_review");
});

test("duplicates within one batch collapse to a single fact", () => {
  const first = goodCandidate({ confidence: 0.8 });
  const second = goodCandidate({ confidence: 0.95, factHash: "control-hash" });
  const { accepted, duplicates } = validateBatch([first, second], { registryUrls });

  assert.equal(accepted.length, 1, "the same requirement is stored once");
  assert.equal(duplicates.length, 1);
  assert.equal(accepted[0].confidence, 0.95, "the highest-confidence wording wins");
  assert.equal(duplicates[0].verificationStatus, STATUS.UNVERIFIED);
});

test("the summary separates guidance-ready facts from the review queue", () => {
  const { accepted, duplicates } = validateBatch(
    [
      goodCandidate(),
      goodCandidate({ claim: "A different requirement that is long enough to be valid.", factHash: "hash-2", confidence: 0.2 }),
      goodCandidate({ claim: "Another distinct requirement long enough to pass the length rule.", factHash: "hash-3", sourceUrl: null }),
    ],
    { registryUrls },
  );
  const summary = summarize(accepted, duplicates);
  assert.equal(summary.accepted, 3);
  assert.equal(summary.guidanceReady, 1, "only the clean fact may be shown as guidance");
  assert.equal(summary.needsReview, 1);
  assert.equal(summary.unverified, 1);
});

/*
 * The registry's own verdict has to be respected.
 *
 * Found in the live corpus, not in a fixture: `id-immigration-candidate` points
 * at imigrasi.go.id's homepage and is marked `candidate_verify_before_ingest` by
 * the curator. The pipeline ignored that field, so news items from the homepage
 * were stored as official guidance:
 *
 *   "An overstay of nearly 400 days can result in immediate apprehension during
 *    patrols."   — a crime report, stamped official_verified
 *
 * Authority cannot tell a rule from a news story. The curator's status can.
 */
test("a source awaiting verification cannot produce official guidance", () => {
  const result = validateCandidate(goodCandidate({ sourceStatus: "candidate_verify_before_ingest" }), { registryUrls });
  assert.equal(result.verificationStatus, STATUS.REVIEW, "the curator's flag must be honoured, not overridden");
  assert.ok(result.validationNotes.some((note) => note.includes("requires verification")), "and the reason must be recorded");
});

test("an unknown source status is treated as unverified, not as trusted", () => {
  // Not knowing a source was verified is not the same as knowing it was.
  const result = validateCandidate(goodCandidate({ sourceStatus: null }), { registryUrls });
  assert.equal(result.verificationStatus, STATUS.REVIEW);
});

test("a curator-verified source still produces official guidance", () => {
  // The control: the new rule must not demote everything.
  const result = validateCandidate(goodCandidate({ sourceStatus: "verified_official" }), { registryUrls });
  assert.equal(result.verificationStatus, STATUS.OFFICIAL);
});

test("the source-status rule cannot rescue a hard failure", () => {
  // An unverified source with no quote stays unverified; the rules compose.
  const result = validateCandidate(goodCandidate({ sourceStatus: "candidate_verify_before_ingest", evidenceQuote: "" }), { registryUrls });
  assert.equal(result.verificationStatus, STATUS.UNVERIFIED);
});
