/**
 * Extraction parser tests.
 *
 * These exist because of a measured production failure, not a hypothetical one.
 * On 2026-09-16 a 15-fact extraction truncated at ~4,000 characters and the
 * whole run was thrown away with a generic "invalid JSON" error. The output
 * ceiling is a real constraint here: `evidenceQuote` must be verbatim, so it
 * cannot be shortened to fit.
 *
 * So the parser has to distinguish three situations that a bare JSON.parse
 * collapses into one useless error:
 *   - the body is clean,
 *   - the model wrapped JSON in prose,
 *   - the body was cut off mid-array and some facts are still recoverable.
 *
 * Run: node --test scripts/greenbook/extract.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFacts, EXTRACTION_LADDER, factHash } from "./extract.mjs";

test("clean JSON parses and is not flagged as salvaged", () => {
  const result = parseFacts('{"facts":[{"claim":"ok"}]}');
  assert.equal(result.salvaged, false);
  assert.equal(result.droppedTrailing, false);
  assert.equal(result.parsed.facts[0].claim, "ok");
});

test("JSON wrapped in prose is recovered without salvage", () => {
  const result = parseFacts('Here you go:\n{"facts":[{"claim":"wrapped"}]}\nHope that helps.');
  assert.equal(result.salvaged, false);
  assert.equal(result.parsed.facts[0].claim, "wrapped");
});

test("a truncated array yields the objects that closed", () => {
  const truncated =
    '{"facts":[' +
    '{"claim":"A","chapter":"get_ready"},' +
    '{"claim":"B","chapter":"money_and_pay"},' +
    '{"claim":"C is cut off mid';

  const result = parseFacts(truncated);
  assert.equal(result.salvaged, true, "a truncated body must be reported as salvaged");
  assert.deepEqual(
    result.parsed.facts.map((fact) => fact.claim),
    ["A", "B"],
  );
});

test("a closing brace inside a quoted string does not end the object", () => {
  /*
   * The failure this guards against: naive brace counting sees the `}` inside
   * the evidenceQuote and treats a half-written fact as complete. That would
   * put a truncated sentence into a trust-critical field.
   */
  const truncated = '{"facts":[{"claim":"A","evidenceQuote":"the form } must be signed"},{"claim":"B is cut';

  const result = parseFacts(truncated);
  assert.equal(result.parsed.facts.length, 1);
  assert.equal(result.parsed.facts[0].evidenceQuote, "the form } must be signed");
});

test("an escaped quote inside a string does not desynchronise the scan", () => {
  const truncated = '{"facts":[{"claim":"He said \\"apply early\\"","chapter":"get_ready"},{"claim":"cut';

  const result = parseFacts(truncated);
  assert.equal(result.parsed.facts.length, 1);
  assert.equal(result.parsed.facts[0].claim, 'He said "apply early"');
});

test("unparseable input returns null so the caller raises a real error", () => {
  assert.equal(parseFacts("the model refused to answer"), null);
  assert.equal(parseFacts(""), null);
});

test("a truncated response that recovered nothing is still a failure", () => {
  // Only the opening brace arrived. There is no fact to salvage, and pretending
  // otherwise would silently persist an empty batch.
  assert.equal(parseFacts('{"facts":[{"claim":"only a fragment'), null);
});

test("the ladder never contains the reasoning model", () => {
  /*
   * `deepseek-v4.1` returned invalid JSON for this contract when measured on
   * 2026-09-16. It is a prose RAG model, not an extractor, and a future edit
   * that adds it back would reintroduce that failure silently.
   */
  assert.ok(!EXTRACTION_LADDER().some((model) => model.includes("v4.1")));
});

test("factHash anchors on the verbatim quote, not the model's paraphrase", () => {
  /*
   * The measured failure this prevents: two runs over an identical page wrote
   * the same rule twice because the model reworded the claim. The quote is
   * copied verbatim, so it is the stable half of the pair.
   */
  const first = factHash({
    sourceUrl: "https://www.imi.gov.my/student-pass/",
    evidenceQuote: "Applicants MUST BE OUTSIDE MALAYSIA at the time of application submission.",
    claim: "Higher education student pass applications must be submitted while the applicant is outside Malaysia.",
    country: "MY",
    chapter: "get_ready",
  });
  const second = factHash({
    sourceUrl: "https://www.imi.gov.my/student-pass/",
    evidenceQuote: "Applicants MUST BE OUTSIDE MALAYSIA at the time of application submission.",
    claim: "Applicants for a Student Pass must be outside Malaysia when submitting their application.",
    country: "MY",
    chapter: "get_ready",
  });
  assert.equal(first, second, "the same source sentence is the same requirement, however it is worded");
});

test("factHash ignores quote formatting but not the quote itself", () => {
  const base = { sourceUrl: "https://x.gov/p", country: "MY", chapter: "get_ready", claim: "c" };
  const spaced = factHash({ ...base, evidenceQuote: "The  fee   is RM90." });
  const punctuated = factHash({ ...base, evidenceQuote: "The fee is RM90" });
  assert.equal(spaced, punctuated, "whitespace and punctuation are not identity");

  const different = factHash({ ...base, evidenceQuote: "The fee is RM60" });
  assert.notEqual(spaced, different, "a different requirement is a different fact");
});

test("factHash separates the same rule across different sources", () => {
  const shared = { evidenceQuote: "A Student Pass is required.", country: "MY", chapter: "get_ready", claim: "c" };
  const a = factHash({ ...shared, sourceUrl: "https://a.gov/p" });
  const b = factHash({ ...shared, sourceUrl: "https://b.gov/p" });
  assert.notEqual(a, b, "the same sentence on two agencies' pages is two provenance records");
});

test("factHash still yields a stable id when there is no quote", () => {
  // The validator rejects these as unverified, but a re-run must not store the
  // rejection twice.
  const bare = { country: "MY", chapter: "get_ready", claim: "Apply BEFORE arriving." };
  assert.equal(factHash(bare), factHash({ ...bare, claim: "apply before arriving" }));
  assert.ok(factHash(bare).length === 64, "sha256 hex");
});
