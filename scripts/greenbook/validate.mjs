/**
 * Validation gate — the deterministic step between extraction and storage.
 *
 * This is the most important file in the ingestion pipeline, because it is the
 * only thing standing between "a model wrote something" and "the app tells a
 * student what the law requires".
 *
 * Rules are deterministic and inspectable. No model runs here, and no model may
 * override the outcome. A candidate that fails is not deleted — it is stored
 * with a status that keeps it out of critical guidance until a human resolves it.
 */
import { factHash } from "./extract.mjs";

/** Chapters and stages the app knows about. Kept in sync with the Greenbook. */
const CHAPTERS = new Set(["get_ready", "land_and_settle", "study_here", "speak_and_understand", "money_and_pay", "live_here", "move_around", "stay_safe_and_healthy", "culture_and_people", "student_reality"]);
const JOURNEY_STAGES = new Set(["before_arrival", "arrival", "first_week", "settling", "ongoing"]);

/** Authority that may appear in critical administrative guidance. */
const ADMINISTRATIVE_AUTHORITY = new Set(["A", "B"]);

/**
 * Registry statuses that permit a source's facts to become official guidance.
 *
 * The registry carries a curator's verdict per source, and 18 of 41 are marked
 * `candidate_verify_before_ingest` — flagged as unverified placeholders, usually
 * pointing at a site root rather than a requirement page. See the rule in
 * `validateCandidate` for what happened when the pipeline ignored that.
 */
const INGESTIBLE_SOURCE_STATUS = new Set(["verified_official"]);

/** Categories where being wrong has real consequences for a student. */
const ADMINISTRATIVE_CHAPTERS = new Set(["get_ready", "land_and_settle", "study_here", "money_and_pay", "stay_safe_and_healthy"]);

const MIN_CLAIM_CHARS = 20;
const MAX_CLAIM_CHARS = 400;
const MIN_QUOTE_CHARS = 15;
const MIN_CONFIDENCE = 0.5;

/**
 * Verification statuses, in the order the UI understands them.
 *   official_verified   Tier A/B source, all checks passed
 *   university_verified Tier A university source, all checks passed
 *   community_verified  Tier C/D lived experience — NEVER shown as a rule
 *   needs_review        plausible but something is missing or weak
 *   unverified          failed a hard rule; never surfaced as guidance
 */
export const STATUS = {
  OFFICIAL: "official_verified",
  UNIVERSITY: "university_verified",
  COMMUNITY: "community_verified",
  REVIEW: "needs_review",
  UNVERIFIED: "unverified",
};

/** Only these may ever be presented as a rule the student must follow. */
export const GUIDANCE_STATUSES = [STATUS.OFFICIAL, STATUS.UNIVERSITY];

function plausibleDate(value) {
  if (!value) return true;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  // A source may not claim a requirement that starts more than two years out,
  // and may not still be valid if it expired more than five years ago.
  const twoYears = Date.now() + 2 * 365 * 24 * 60 * 60 * 1000;
  const fiveYearsAgo = Date.now() - 5 * 365 * 24 * 60 * 60 * 1000;
  return parsed < twoYears && parsed > fiveYearsAgo;
}

/**
 * Decide the fate of one candidate.
 *
 * Returns the candidate with `verificationStatus` and `validationNotes` set.
 * Every rejection names the rule that rejected it, so a human reviewing the
 * queue sees why rather than a bare "failed".
 */
export function validateCandidate(candidate, { registryUrls } = {}) {
  const notes = [];
  let status = STATUS.OFFICIAL;

  // --- hard rules: any failure means the fact cannot be guidance -------------

  if (!candidate.claim || candidate.claim.length < MIN_CLAIM_CHARS) {
    notes.push(`claim shorter than ${MIN_CLAIM_CHARS} characters`);
  }
  if (candidate.claim && candidate.claim.length > MAX_CLAIM_CHARS) {
    notes.push(`claim longer than ${MAX_CLAIM_CHARS} characters — likely bundled requirements`);
  }
  if (!candidate.chapter || !CHAPTERS.has(candidate.chapter)) {
    notes.push("chapter is missing or not in the lifecycle taxonomy");
  }
  if (!JOURNEY_STAGES.has(candidate.journeyStage)) {
    notes.push("journeyStage is not recognised");
  }

  // The trust rule: no source URL means no verification, ever.
  if (!candidate.sourceUrl) {
    notes.push("no source URL — cannot be verified");
  }
  if (registryUrls && candidate.sourceUrl && !registryUrls.has(candidate.sourceUrl)) {
    notes.push("source URL is not the one recorded in the registry");
  }

  // Provenance: a claim with no quotable sentence is an assertion, not a fact.
  if (!candidate.evidenceQuote || candidate.evidenceQuote.length < MIN_QUOTE_CHARS) {
    notes.push("no verbatim evidence quote");
  }

  if (candidate.effectiveFrom && !plausibleDate(candidate.effectiveFrom)) {
    notes.push("effectiveFrom is not a plausible date");
  }
  if (candidate.validUntil && !plausibleDate(candidate.validUntil)) {
    notes.push("validUntil is not a plausible date");
  }

  // --- soft rules: downgrade to review, do not discard -----------------------

  if (candidate.confidence === null) {
    notes.push("confidence was not reported");
    status = STATUS.REVIEW;
  } else if (candidate.confidence < MIN_CONFIDENCE) {
    notes.push(`confidence ${candidate.confidence} is below ${MIN_CONFIDENCE}`);
    status = STATUS.REVIEW;
  }

  // An administrative requirement from a weak source is not guidance.
  if (ADMINISTRATIVE_CHAPTERS.has(candidate.chapter) && !ADMINISTRATIVE_AUTHORITY.has(candidate.authorityLevel)) {
    notes.push(`authority ${candidate.authorityLevel} is too weak for an administrative chapter`);
    status = STATUS.REVIEW;
  }

  /*
   * Below A/B can never be official — in ANY chapter.
   *
   * Found by test: a Tier-D source in a non-administrative chapter was passing
   * as official_verified, which would let a TikTok caption be rendered with the
   * same badge as the Immigration Department. Tier C/D is lived experience, so
   * it gets its own status that the UI renders differently and that RAG never
   * cites as a requirement.
   */
  if (!ADMINISTRATIVE_AUTHORITY.has(candidate.authorityLevel)) {
    if (status !== STATUS.REVIEW) status = STATUS.COMMUNITY;
    notes.push(`authority ${candidate.authorityLevel} is community experience, not an official rule`);
  }

  // University pages are their own tier, which the UI shows differently.
  if (status === STATUS.OFFICIAL && candidate.sourceType === "university") {
    status = STATUS.UNIVERSITY;
  }

  /*
   * Honour the registry's own verification verdict.
   *
   * The registry marks 18 of 41 sources `candidate_verify_before_ingest`: the
   * curator flagged them as unverified placeholders, and they mostly point at a
   * site root rather than a requirement page. The pipeline ignored that field
   * entirely, so a news item on the Indonesian immigration homepage was promoted
   * to official guidance — "An overstay of nearly 400 days can result in
   * immediate apprehension during patrols" is a crime report, not a rule a
   * student must follow. It carried the same badge as the Immigration
   * Department's actual requirements because the gate only ever checked
   * authority, quote and chapter.
   *
   * Authority alone cannot separate a rule from a news story. The curator's
   * status can, and it already exists — so the gate now defers to it rather than
   * overriding it. Facts are still stored; they are just not guidance until a
   * human verifies the source.
   *
   * A missing status is treated the same as an unverified one: not knowing that
   * a source was verified is not the same as knowing it was, and the safe
   * default for a trust gate is to withhold the badge rather than grant it.
   */
  if (!candidate.sourceStatus || !INGESTIBLE_SOURCE_STATUS.has(candidate.sourceStatus)) {
    if (status === STATUS.OFFICIAL || status === STATUS.UNIVERSITY) status = STATUS.REVIEW;
    notes.push(`source status "${candidate.sourceStatus ?? "unknown"}" requires verification before its facts are guidance`);
  }

  // Any hard-rule failure overrides everything above.
  const hardFailures = notes.filter((note) =>
    /no source URL|not the one recorded|no verbatim evidence|not a plausible date|shorter than|longer than|chapter is missing|journeyStage is not recognised/.test(note),
  );
  if (hardFailures.length > 0) status = STATUS.UNVERIFIED;

  return {
    ...candidate,
    verificationStatus: status,
    validationNotes: notes,
    validatedAt: new Date().toISOString(),
  };
}

/**
 * Validate a whole extraction batch, with cross-candidate deduplication.
 *
 * Duplicates are resolved by keeping the highest-confidence candidate for a
 * given (country, chapter, claim) identity and marking the rest as duplicates —
 * rather than storing the same requirement twice with two different wordings.
 */
export function validateBatch(candidates, { registryUrls } = {}) {
  const validated = candidates.map((candidate) => validateCandidate(candidate, { registryUrls }));
  const best = new Map();
  const duplicates = [];

  for (const candidate of validated) {
    const hash = candidate.factHash ?? factHash(candidate);
    const existing = best.get(hash);
    if (!existing) {
      best.set(hash, { ...candidate, factHash: hash });
      continue;
    }
    const keep = (candidate.confidence ?? 0) > (existing.confidence ?? 0) ? candidate : existing;
    const drop = keep === candidate ? existing : candidate;
    best.set(hash, { ...keep, factHash: hash });
    duplicates.push({ ...drop, factHash: hash, verificationStatus: STATUS.UNVERIFIED, validationNotes: [...drop.validationNotes, "duplicate claim within the same batch"] });
  }

  return { accepted: [...best.values()], duplicates };
}

/** Summary for the run report. */
export function summarize(accepted, duplicates) {
  const byStatus = {};
  for (const fact of accepted) byStatus[fact.verificationStatus] = (byStatus[fact.verificationStatus] ?? 0) + 1;
  return {
    accepted: accepted.length,
    duplicates: duplicates.length,
    byStatus,
    guidanceReady: accepted.filter((fact) => GUIDANCE_STATUSES.includes(fact.verificationStatus)).length,
    community: accepted.filter((fact) => fact.verificationStatus === STATUS.COMMUNITY).length,
    needsReview: accepted.filter((fact) => fact.verificationStatus === STATUS.REVIEW).length,
    unverified: accepted.filter((fact) => fact.verificationStatus === STATUS.UNVERIFIED).length,
  };
}
