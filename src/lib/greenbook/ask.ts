/**
 * "Ask this Greenbook" — retrieval and grounded answers.
 *
 * THE CENTRAL DESIGN CONSTRAINT
 *
 * The brief requires that the Greenbook never becomes unusable because an LLM
 * rate-limited. That is not a nice-to-have, it is the acceptance criterion: a
 * demo where "Ask this Greenbook" shows a spinner and then an error because a
 * free-tier provider returned 429 is a failed demo.
 *
 * So the no-LLM path is built FIRST and treated as a first-class answer mode,
 * not as an error branch. `askGreenbook` retrieves verified facts, and:
 *
 *   - if a provider answers, the model's prose is used, but every citation it
 *     emits is filtered against the evidence packet's source allowlist;
 *   - if every provider fails, the answer is assembled directly from the
 *     verified facts, the official sources and the recorded actions.
 *
 * Both modes return the same `GreenbookAnswer` shape. The UI does not have to
 * know which happened, though it may show it.
 *
 * WHAT THIS MODULE WILL NOT DO
 *
 * It will not answer from model knowledge. If retrieval finds no authoritative
 * evidence, the answer is a refusal, not a guess. That rule is enforced by the
 * absence of any code path that could produce prose without an evidence packet.
 */
import { AiError, callAi } from "../ai-contracts/client";
import { GreenbookAnswerSchema } from "../ai-contracts/greenbook";
import type { EvidencePacket, GreenbookAnswer, GreenbookFact, GreenbookQuery, GreenbookSource } from "./contract";
import { UNVERIFIED_ANSWER, buildNoLlmAnswer, latestCheck, trustStateOf } from "./no-llm";
import { listFacts, listPhrases, listSources, sourcesByIds } from "./store";
import { requiresClarification, validateGroundedAnswer } from "../../../functions/ai-gateway/src/grounding.js";
import { campusFor } from "../../data/campuses";

/**
 * Re-exported from ./no-llm so existing importers (AskGreenbook.tsx) do not
 * change. The sentence is the contract for "we could not verify this", and it
 * must be identical on both the grounded and the no-LLM path.
 */
export { UNVERIFIED_ANSWER };

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are", "do", "does", "i", "my", "me", "how", "what",
  "where", "when", "can", "should", "need", "have", "has", "it", "this", "that", "at", "as", "be", "if", "from", "by", "you",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

/**
 * Step 2 of the retrieval order: fulltext scoring, weighted by term rarity.
 *
 * Scored client-side rather than through a TablesDB fulltext index. The corpus is
 * ~300 facts, so a linear scan is faster than a round trip, and it avoids
 * requiring an index that would need re-provisioning on a database that is being
 * written to by another process right now. When the corpus grows past a few
 * thousand facts this should move server-side — noted rather than pretended.
 *
 * WHY THE WEIGHTING IS NOT OPTIONAL
 *
 * Plain term overlap ranks a common word as high as a specific one. Measured on
 * the corridor questions: "Singapore", "student" and "university" appear in a
 * large share of the Singapore corpus, so a question about the Student's Pass
 * pulled a transport-authority data-licence fact into the top three, and the
 * Vietnam corridor led with a campus address rather than entry requirements.
 * Every retrieved fact was true and verified; the ORDER was wrong, which is the
 * difference between retrieval and a keyword search.
 *
 * `idf = ln(1 + N / df)` is the standard fix and needs no tuning: a term in
 * every fact contributes ~0, a term in one fact contributes the most.
 */
function inverseDocumentFrequency(term: string, facts: GreenbookFact[]): number {
  let documentFrequency = 0;
  for (const fact of facts) {
    const haystack = `${fact.claim} ${fact.action ?? ""} ${fact.evidenceQuote ?? ""}`.toLowerCase();
    if (haystack.includes(term)) documentFrequency += 1;
  }
  return Math.log(1 + facts.length / (1 + documentFrequency));
}

function scoreFact(fact: GreenbookFact, terms: string[], idf: Map<string, number>): number {
  if (!terms.length) return 0;
  const claim = fact.claim.toLowerCase();
  const action = (fact.action ?? "").toLowerCase();
  const quote = (fact.evidenceQuote ?? "").toLowerCase();
  let score = 0;
  for (const term of terms) {
    const weight = idf.get(term) ?? 1;
    // The claim carries the requirement, so it is worth the most; the evidence
    // quote is the raw source text and is worth the least.
    if (claim.includes(term)) score += 3 * weight;
    if (action.includes(term)) score += 2 * weight;
    if (quote.includes(term)) score += 1 * weight;
  }
  return score;
}

/**
 * Assemble the evidence packet.
 *
 * Order follows the brief: metadata filter, fulltext, related-group expansion,
 * rerank, packet. The expansion step is what makes a question like "how do I pay
 * my tuition" also surface the sibling facts from the same chapter, so the answer
 * is not built from one orphaned sentence.
 */
export async function retrieveEvidence(query: GreenbookQuery): Promise<EvidencePacket> {
  const countryCode = query.hostCountry;
  const steps: string[] = [];
  if (!countryCode) {
    return { countryCode: "", chapter: query.chapter ?? null, facts: [], sources: [], retrievalSteps: ["no host country in context"], retrievedAt: new Date().toISOString() };
  }

  // 1. metadata filter
  let facts = await listFacts({ countryCode, chapter: query.chapter ?? null, limit: 200 });
  const studyPermit = /student|exchange|study/i.test(query.question ?? "") && /visa|permit|immigration|student.?s? pass/i.test(query.question ?? "");
  const studentAuthorization = /student.?s?\s*pass|student\s*visa|study\s*visa|student\s*permit|E30B|\b9F\b/i;
  const studySources = new Set<string>();
  if (studyPermit) {
    const sources = await listSources(countryCode);
    for (const source of sources) if (studentAuthorization.test(source.title) && ["A", "B"].includes(source.authorityLevel)) studySources.add(source.sourceId);
    for (const fact of facts) if (studentAuthorization.test(fact.claim) && ["A", "B"].includes(fact.authorityLevel)) studySources.add(fact.sourceId);
    facts = facts.filter((fact) => studySources.has(fact.sourceId));
    if (!/extend|extension|renew|ITK|ITAS|KITAS/i.test(query.question ?? "")) facts = facts.filter((fact) => !/extension|extend|renewal|renew|ITK/i.test(`${fact.claim} ${fact.action ?? ""}`));
  }
  const scopeSources = await listSources(countryCode);
  const scoped = new Map(scopeSources.filter((source) => source.universityId).map((source) => [source.sourceId, source.universityId!]));
  const matchesCampus = (campus: string) => Boolean(query.university && (campusFor(query.university)?.universityId === campus || query.university.toLowerCase() === campus.toLowerCase()) || campus.length > 4 && (query.question ?? "").toLowerCase().includes(campus.toLowerCase()));
  facts = facts.filter((fact) => !(fact.universityId || scoped.get(fact.sourceId)) || matchesCampus(fact.universityId || scoped.get(fact.sourceId)!));
  steps.push(`metadata filter: ${facts.length} fact(s) for ${countryCode}${query.chapter ? `/${query.chapter}` : ""}`);

  // 2. fulltext
  //
  // The score is kept, not discarded. An earlier version sorted by score here
  // and then threw the score away in the rerank below, which re-sorted by
  // authority and recency — so a question about the Student's Pass could end up
  // led by whichever Authority-A fact happened to be checked most recently, and
  // the ranked order the rest of the function assumes did not exist. Carrying
  // the score through is what makes "top-ranked" mean "most relevant".
  const terms = query.question ? tokenize(query.question) : [];
  const scores = new Map<string, number>();
  if (terms.length) {
    const idf = new Map(terms.map((term) => [term, inverseDocumentFrequency(term, facts)]));
    for (const fact of facts) scores.set(fact.factId, scoreFact(fact, terms, idf));
    const matched = facts.filter((fact) => (scores.get(fact.factId) ?? 0) > 0);
    if (matched.length) {
      facts = matched;
      steps.push(`fulltext: ${facts.length} fact(s) matched ${terms.length} term(s)`);
    } else {
      facts = [];
      steps.push("No relevant verified point covers this question");
    }
  } else {
    steps.push("fulltext: skipped (no question, browsing context)");
  }

  // 3. related fact-group expansion.
  // Expanded siblings carry no score, so they can never outrank a direct match.
  if (facts.length) {
    const chapters = new Set(facts.map((fact) => fact.chapter));
    const siblings = await listFacts({ countryCode, limit: 200 });
    const expansion = siblings.filter((fact) => chapters.has(fact.chapter) && !facts.some((kept) => kept.factId === fact.factId) && (!studyPermit || studySources.has(fact.sourceId) && (/extend|extension|renew|ITK|ITAS|KITAS/i.test(query.question ?? "") || !/extension|extend|renewal|renew|ITK/i.test(`${fact.claim} ${fact.action ?? ""}`))) && (!(fact.universityId || scoped.get(fact.sourceId)) || matchesCampus(fact.universityId || scoped.get(fact.sourceId)!)));
    if (expansion.length) {
      for (const fact of expansion) if (!scores.has(fact.factId)) scores.set(fact.factId, 0);
      facts = [...facts, ...expansion];
      steps.push(`group expansion: +${expansion.length} related fact(s)`);
    }
  }

  // 4. rerank — relevance first, then journey stage, then authority, then recency.
  const stageOrder = ["before_arrival", "arrival", "first_week", "settling", "ongoing"];
  const target = query.journeyStage ? stageOrder.indexOf(query.journeyStage) : -1;
  const rank = (fact: GreenbookFact) => (fact.authorityLevel === "A" ? 0 : fact.authorityLevel === "B" ? 1 : 2);
  facts = [...facts].sort((a, b) => {
    const byScore = (scores.get(b.factId) ?? 0) - (scores.get(a.factId) ?? 0);
    if (byScore !== 0) return byScore;
    if (target >= 0) {
      const da = Math.abs(stageOrder.indexOf(a.journeyStage) - target);
      const db = Math.abs(stageOrder.indexOf(b.journeyStage) - target);
      if (da !== db) return da - db;
    }
    return rank(a) - rank(b) || String(b.checkedAt).localeCompare(String(a.checkedAt));
  });

  // 5. evidence packet — the source allowlist an answer is permitted to cite
  const sourceIds = [...new Set(facts.map((fact) => fact.sourceId))];
  let sources = await sourcesByIds(sourceIds);
  if (!sources.length && sourceIds.length) sources = await listSources(countryCode);
  steps.push(`evidence packet: ${facts.length} fact(s), ${sources.length} source(s)`);

  return {
    countryCode,
    chapter: query.chapter ?? null,
    facts: facts.slice(0, 40),
    sources,
    retrievalSteps: steps,
    retrievedAt: new Date().toISOString(),
  };
}

/**
 * Shape the gateway is expected to return.
 *
 * This is the shared contract from src/lib/ai-contracts/greenbook.ts rather than
 * a private copy: the parity test runs the same fixtures through the server and
 * the client, so a field added on one side cannot silently drift on the other.
 * The gateway validates provider output against the identical schema before it
 * responds, so anything that reaches here has already been checked once.
 */
const answerSchema = GreenbookAnswerSchema;

/**
 * Filter model citations against the packet.
 *
 * This is the enforcement point for "every generated answer may cite ONLY source
 * IDs present in the retrieved evidence packet". It is done here, in code, and
 * not by asking the model to behave — a model that invents a citation is the
 * exact failure the rule exists to prevent, so trusting the prompt to prevent it
 * would be circular.
 */
function allowlistedSources(citedIds: string[], packet: EvidencePacket): { sources: GreenbookSource[]; dropped: number } {
  const allowed = new Map(packet.sources.map((source) => [source.sourceId, source]));
  const kept: GreenbookSource[] = [];
  let dropped = 0;
  for (const id of citedIds) {
    const source = allowed.get(id);
    if (source && !kept.some((entry) => entry.sourceId === source.sourceId)) kept.push(source);
    else if (!source) dropped += 1;
  }
  return { sources: kept, dropped };
}

function confidenceFor(facts: GreenbookFact[]): "high" | "medium" | "low" {
  if (!facts.length) return "low";
  const official = facts.filter((fact) => fact.authorityLevel === "A").length;
  if (official >= 3) return "high";
  if (official >= 1) return "medium";
  return "low";
}

function warningsFor(facts: GreenbookFact[]): string[] {
  const warnings: string[] = [];
  const stale = facts.filter((fact) => trustStateOf(fact) === "stale");
  if (stale.length) warnings.push(`${stale.length} of these ${facts.length} points may be out of date — check the source before relying on it.`);
  const community = facts.filter((fact) => trustStateOf(fact) === "community");
  if (community.length) warnings.push("Some of this comes from community reports, not an official body. Treat it as a hint, not a rule.");
  const tiers = new Set(facts.map((fact) => fact.authorityLevel));
  if (tiers.has("C") || tiers.has("D")) warnings.push("Some sources here are secondary rather than official.");
  return warnings;
}

/**
 * Answer a question about the Greenbook.
 *
 * Never throws. A provider outage, a missing function deployment, a schema
 * mismatch and an empty corpus all resolve to a well-formed answer.
 */
export async function askGreenbook(query: GreenbookQuery, retrieved?: EvidencePacket): Promise<GreenbookAnswer> {
  if (requiresClarification(query.question ?? "")) return { answer: "Could you specify which activity or rule you mean, and where you plan to do it?", whatToDo: [], whatToPrepare: [], whatToSay: [], warnings: [], confidence: "low", sources: [], lastChecked: null, mode: "no_llm" };
  const packet = retrieved ?? await retrieveEvidence(query);

  // Phrases are cheap, public and cached; fetch them so even the no-LLM answer
  // can offer something to say.
  let phrases: string[] = [];
  try {
    const rows = await listPhrases(packet.countryCode, query.chapter ?? undefined);
    phrases = rows.slice(0, 5).map((phrase) => `${phrase.localText}${phrase.romanization ? ` (${phrase.romanization})` : ""} — ${phrase.translation ?? ""}`.trim());
  } catch {
    phrases = [];
  }

  if (!packet.facts.length) {
    return {
      ...buildNoLlmAnswer(packet, phrases),
      warnings: ["Nothing in the verified corpus covers this yet."],
    };
  }

  const body = {
    question: query.question ?? "",
    journey: { home: query.homeCountry, host: query.hostCountry, city: query.city || "", university: query.university || "" },
    hostCountry: query.hostCountry,
    homeCountry: query.homeCountry,
    chapter: query.chapter ?? null,
    journeyStage: query.journeyStage ?? null,
    language: query.language ?? "en",
    userLanguage: query.language ?? "en",
    coachingLanguage: query.language ?? "en",
    languageLevel: query.languageLevel ?? null,
    // Only the retrieved evidence is ever sent, so the model cannot reason over
    // anything outside the allowlist in the first place.
    evidence: packet.facts.map((fact) => ({
      factId: fact.factId,
      sourceId: fact.sourceId,
      chapter: fact.chapter,
      claim: fact.claim,
      action: fact.action,
      authority: fact.authorityLevel,
      status: fact.verificationStatus,
      checkedAt: fact.checkedAt,
    })),
    sources: packet.sources.map((source) => ({ sourceId: source.sourceId, title: source.title, url: source.url, authority: source.authorityLevel })),
  };

  try {
    const { data } = await callAi("greenbook/ask", body, answerSchema);
    if (!validateGroundedAnswer(body, data).ok) return buildNoLlmAnswer(packet, phrases);
    const { sources, dropped } = allowlistedSources(data.citedSourceIds, packet);
    return {
      answer: data.answer,
      whatToDo: data.whatToDo,
      whatToPrepare: data.whatToPrepare,
      whatToSay: data.whatToSay.length ? data.whatToSay : phrases,
      warnings: dropped ? [...data.warnings, `${dropped} citation(s) were removed because they were not in the retrieved evidence.`] : data.warnings,
      confidence: data.confidence,
      // A grounded answer with zero surviving citations is not grounded. Fall
      // back to the packet's own sources rather than showing an unsourced claim.
      sources: sources.length ? sources : packet.sources,
      lastChecked: latestCheck(packet.facts),
      mode: "grounded",
    };
  } catch (error) {
    // Every provider path lands here: not deployed, 429, 5xx, timeout, bad schema.
    // The answer degrades in quality, never in availability.
    const reason = error instanceof AiError ? error.code : "AI_UNAVAILABLE";
    const fallback = buildNoLlmAnswer(packet, phrases);
    if (reason === "OFFLINE") fallback.warnings = ["You appear to be offline — showing the stored guidance.", ...fallback.warnings];
    return fallback;
  }
}
