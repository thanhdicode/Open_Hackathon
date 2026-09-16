/**
 * Fact extraction — Stage A of the Greenbook AI pipeline.
 *
 * Turns a fetched page into candidate facts. It is deliberately a CANDIDATE
 * producer: nothing here decides that a fact is verified. That decision belongs
 * to the deterministic validator, because a model must never be the thing that
 * certifies an administrative requirement.
 *
 * Two rules are enforced structurally rather than by asking the model nicely:
 *   - `sourceUrl` is copied from the registry, never taken from the model. A
 *     model that invents a URL cannot get one into a fact.
 *   - every candidate must carry `evidenceQuote`, the sentence it came from, so
 *     a human (or the validator) can check it against the archived snapshot.
 *
 * Provider: Vyce AI. This handles PUBLIC source text only — never user media,
 * messages or documents. See ADR-007.
 */
import { createHash } from "node:crypto";

export const EXTRACTION_MODEL = () => process.env.VYCE_EXTRACTION_MODEL || "agnes-3.0-flash";
export const VYCE_BASE = () => (process.env.VYCE_BASE_URL || "https://vyceai.com/v1").replace(/\/$/, "");

/**
 * Model ladder for extraction.
 *
 * Measured 2026-09-16 on the same 9.6k-char page: `agnes-3.0-flash` returned
 * valid JSON in 48.6s once and exceeded a 90s timeout on a later run, so a
 * single attempt is not enough for a batch job. `deepseek-v4-flash` returned
 * valid JSON in 6.0s on the probe and is the first fallback.
 *
 * `deepseek-v4.1` is deliberately absent: it returned invalid JSON for this
 * contract. It is a reasoning model for prose RAG answers, not an extractor.
 */
export const EXTRACTION_LADDER = () =>
  (process.env.VYCE_EXTRACTION_LADDER || "agnes-3.0-flash,deepseek-v4-flash,deepseek-v4-flash-lr").split(",").map((entry) => entry.trim()).filter(Boolean);

/** Chapters follow the student lifecycle, not a topic menu. */
export const CHAPTERS = [
  "get_ready",
  "land_and_settle",
  "study_here",
  "speak_and_understand",
  "money_and_pay",
  "live_here",
  "move_around",
  "stay_safe_and_healthy",
  "culture_and_people",
  "student_reality",
];

export const JOURNEY_STAGES = ["before_arrival", "arrival", "first_week", "settling", "ongoing"];

/**
 * The contract the model is asked to fill.
 *
 * Kept small on purpose: measured on 2026-09-16, `deepseek-v4.1` returned
 * invalid JSON for a comparable extraction task while `agnes-3.0-flash` returned
 * valid JSON in 8.1s. A smaller contract is what lets the cheap model succeed.
 */
export const EXTRACTION_INSTRUCTION = `You extract candidate facts from a public government or university page for a student field manual.

Return JSON only, shaped exactly:
{"facts":[{"claim":"string","action":"string","chapter":"string","journeyStage":"string","evidenceQuote":"string","effectiveFrom":"string or null","validUntil":"string or null","confidence":0.0}]}

Rules:
- A "claim" is one checkable statement, written plainly. One requirement per fact. Never bundle two requirements into one claim.
- "action" is what the student should DO about it, in the imperative. Empty string if the page states no action.
- "chapter" must be one of: ${CHAPTERS.join(", ")}.
- "journeyStage" must be one of: ${JOURNEY_STAGES.join(", ")}.
- "evidenceQuote" MUST be an exact sentence copied verbatim from the supplied text that supports the claim. If you cannot quote it, do not emit the fact.
- "effectiveFrom" and "validUntil" only when the text literally states a date. Otherwise null. Never infer a date.
- "confidence" is 0.0-1.0 and reflects how directly the text supports the claim.
- Keep "claim" and "action" to one short sentence each. "evidenceQuote" is the only field that may be long, because it must be verbatim.
- Extract at most 15 facts. Prefer the ones a newly arriving student actually needs.
- Do NOT state fees, deadlines, addresses or eligibility that are not in the text.
- Do NOT write prose. Facts only.`;

function normalizeForHash(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Stable identity for a fact, so the same requirement is never stored twice.
 *
 * Anchored on the verbatim `evidenceQuote`, NOT on the model's `claim`.
 *
 * Measured 2026-09-16: the model paraphrases the claim freely between runs but
 * copies the source sentence verbatim, because the contract requires an exact
 * quote. Two runs over an identical page produced:
 *
 *   "Higher education student pass applications must be submitted while the
 *    applicant is outside Malaysia."
 *   "Applicants for a Student Pass must be outside Malaysia when submitting
 *    their application."
 *
 * Claim-keyed identity saw two facts; quote-keyed identity sees one requirement.
 * Across the 29 rows that accumulated, quote-anchoring collapses them to 17.
 *
 * KNOWN LIMIT: one source sentence that legitimately supports two distinct
 * requirements yields a single fact, because the two share a quote. That is a
 * real limitation, not an oversight — deterministic identity cannot tell
 * "same rule, rephrased" from "two rules, one sentence". Resolving it properly
 * needs semantic similarity, which is the `gemini-embedding-2` work the spec
 * schedules post-P0. Until then this errs toward the paraphrase case, which is
 * what actually happens in practice.
 */
export function factHash({ sourceUrl, evidenceQuote, country, chapter, claim }) {
  const quote = normalizeForHash(evidenceQuote);
  if (quote) return createHash("sha256").update(`${sourceUrl ?? country}|${quote}`).digest("hex");
  // No quote: the validator will reject this as unverified anyway, but it still
  // needs a stable id so a re-run does not double-store the rejection.
  return createHash("sha256").update(`${country}|${chapter}|${normalizeForHash(claim)}`).digest("hex");
}

/**
 * Call Vyce with the model ladder.
 *
 * Walks the ladder on a timeout, a 429, a 5xx, a truncated response, or output
 * that does not parse — the failures a shared gateway actually produces. A 4xx
 * that is not a rate limit is the request's fault, so it is raised rather than
 * retried on another model.
 *
 * `accept` is how an unparseable body becomes retryable. Measured 2026-09-16:
 * `sg-data-gov` returned something with no recoverable JSON and the run died on
 * it, without ever asking the next model — which is the one thing a ladder
 * exists to prevent. Whether a model's output is usable is a property of the
 * model, so it belongs inside the loop, not after it.
 */
async function callVyceWithLadder({ system, user, timeoutMs = Number(process.env.VYCE_EXTRACT_TIMEOUT_MS || 120_000), accept = () => true }) {
  const ladder = EXTRACTION_LADDER();
  const attempts = [];
  let truncatedFallback = null;

  for (const model of ladder) {
    const startedAt = Date.now();
    try {
      const result = await callVyce({ system, user, timeoutMs, model });

      /*
       * A response cut off by the output ceiling is not a success.
       *
       * Measured 2026-09-16: a 15-fact extraction lands at ~4,000 characters
       * because `evidenceQuote` must be verbatim and cannot be shortened. The
       * same request succeeded once and truncated once, so this is a genuine
       * coin-flip at the boundary rather than a model defect.
       *
       * We keep the truncated body as a last resort, but try the next model
       * first — a clean response is always preferable to a salvaged one.
       */
      if (result.finishReason === "length") {
        attempts.push({ model, ok: false, ms: Date.now() - startedAt, error: "truncated" });
        truncatedFallback = result;
        continue;
      }

      if (!accept(result.content)) {
        attempts.push({ model, ok: false, ms: Date.now() - startedAt, error: "unusable-output" });
        continue;
      }

      attempts.push({ model, ok: true, ms: Date.now() - startedAt });
      return { ...result, attempts };
    } catch (error) {
      attempts.push({ model, ok: false, ms: Date.now() - startedAt, error: error.name === "TimeoutError" ? "timeout" : error.message });
      const retryable = error.name === "TimeoutError" || error.retryable === true || error.status === 429 || (error.status && error.status >= 500);
      if (!retryable) throw error;
    }
  }

  // Every model truncated. Salvage what closed rather than losing the run.
  if (truncatedFallback) return { ...truncatedFallback, attempts, salvagedFromTruncation: true };

  const failure = new Error(`vyce:ladder-exhausted (${attempts.map((attempt) => `${attempt.model}:${attempt.error}`).join(", ")})`);
  failure.attempts = attempts;
  throw failure;
}

async function callVyce({ system, user, timeoutMs = 90_000, model = EXTRACTION_MODEL() }) {
  const key = process.env.VYCE_API_KEY;
  if (!key) throw new Error("VYCE_API_KEY is not configured");

  const response = await fetch(`${VYCE_BASE()}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: Number(process.env.VYCE_EXTRACT_MAX_TOKENS || 4000),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`vyce:${response.status}`);
    error.status = response.status;
    error.detail = text.slice(0, 200);
    throw error;
  }
  const payload = JSON.parse(text);
  const choice = payload.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("vyce:empty-response");
  return { content, usage: payload.usage ?? null, model: payload.model ?? model, finishReason: choice?.finish_reason ?? null };
}

/**
 * Parse the model's JSON, tolerating a response that was cut off mid-array.
 *
 * Three attempts, in descending order of trust:
 *   1. the whole body parses;
 *   2. the outermost `{...}` parses (a model that wrapped its JSON in prose);
 *   3. the response was truncated, so recover every object that DID close.
 *
 * Only step 3 can lose data, and it says so via `salvaged`, so the run record
 * can distinguish "the model gave me 15 facts" from "I recovered 11 of them".
 */
export function parseFacts(content) {
  const attempt = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  const direct = attempt(content);
  if (direct) return { parsed: direct, salvaged: false, droppedTrailing: false };

  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const wrapped = attempt(content.slice(start, end + 1));
    if (wrapped) return { parsed: wrapped, salvaged: false, droppedTrailing: false };
  }

  /*
   * Truncated recovery. Scan the array and take each top-level object that has a
   * matching closing brace, tracking string state so a `}` inside an
   * `evidenceQuote` cannot be mistaken for the end of an object.
   */
  const arrayStart = content.indexOf("[");
  if (arrayStart >= 0) {
    const objects = [];
    let depth = 0;
    let objectStart = -1;
    let inString = false;
    let escaped = false;

    for (let index = arrayStart + 1; index < content.length; index += 1) {
      const char = content[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === "{") {
        if (depth === 0) objectStart = index;
        depth += 1;
        continue;
      }
      if (char === "}") {
        depth -= 1;
        if (depth === 0 && objectStart >= 0) {
          const object = attempt(content.slice(objectStart, index + 1));
          if (object) objects.push(object);
          objectStart = -1;
        }
      }
    }

    if (objects.length) return { parsed: { facts: objects }, salvaged: true, droppedTrailing: depth > 0 || inString };
  }

  return null;
}

/**
 * Extract candidates from one fetched source.
 *
 * Text is truncated to a sane prompt budget. If the page is longer than that,
 * the extraction covers the first slice and the record says so — silently
 * pretending to have read a 200 KB page would be worse than admitting the limit.
 */
export async function extractFacts({ source, text, maxChars = Number(process.env.GREENBOOK_EXTRACT_MAX_CHARS || 24_000) }) {
  const truncated = text.length > maxChars;
  const slice = truncated ? text.slice(0, maxChars) : text;

  const user = [
    `Source: ${source.agency} (${source.url})`,
    `Country: ${source.country}`,
    `Authority: ${source.authority}`,
    "",
    "Page text:",
    slice,
  ].join("\n");

  const startedAt = Date.now();
  const { content, usage, model, attempts, salvagedFromTruncation } = await callVyceWithLadder({
    system: EXTRACTION_INSTRUCTION,
    user,
    // A model whose output does not parse is a model failure, so it walks the
    // ladder like any other instead of ending the source.
    accept: (text) => parseFacts(text) !== null,
  });

  const parsedResult = parseFacts(content);
  if (!parsedResult) throw new Error("vyce:invalid-json");
  const { parsed, salvaged, droppedTrailing } = parsedResult;

  const raw = Array.isArray(parsed.facts) ? parsed.facts : [];

  /*
   * sourceUrl, authorityLevel and sourceType come from the REGISTRY.
   *
   * This is the structural guarantee behind the trust rule: whatever the model
   * writes, it cannot introduce a URL, and it cannot promote its own authority.
   */
  const candidates = raw.slice(0, 20).map((fact) => {
    const claim = String(fact.claim ?? "").trim();
    const chapter = CHAPTERS.includes(fact.chapter) ? fact.chapter : null;
    return {
      claim,
      action: String(fact.action ?? "").trim(),
      chapter,
      journeyStage: JOURNEY_STAGES.includes(fact.journeyStage) ? fact.journeyStage : "before_arrival",
      evidenceQuote: String(fact.evidenceQuote ?? "").trim(),
      effectiveFrom: typeof fact.effectiveFrom === "string" && fact.effectiveFrom ? fact.effectiveFrom : null,
      validUntil: typeof fact.validUntil === "string" && fact.validUntil ? fact.validUntil : null,
      confidence: typeof fact.confidence === "number" ? Math.min(Math.max(fact.confidence, 0), 1) : null,
      // Provenance is attached here, not requested from the model.
      country: source.country,
      sourceId: source.id,
      sourceUrl: source.url,
      authorityLevel: source.authority,
      sourceType: source.source_type,
      sourceStatus: source.status ?? null,
      city: source.city ?? null,
      university: source.university ?? null,
      origin: "crawler",
      checkedAt: new Date().toISOString(),
    };
  });

  return {
    sourceId: source.id,
    country: source.country,
    model,
    attempts,
    salvaged: salvaged || Boolean(salvagedFromTruncation),
    droppedTrailing,
    latencyMs: Date.now() - startedAt,
    usage,
    truncated,
    textLength: text.length,
    candidateCount: candidates.length,
    candidates: candidates.map((candidate) => ({ ...candidate, factHash: candidate.evidenceQuote || (candidate.claim && candidate.chapter) ? factHash(candidate) : null })),
  };
}
