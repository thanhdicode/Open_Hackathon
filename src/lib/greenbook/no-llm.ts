/**
 * The no-LLM answer path, extracted so it can be tested on its own.
 *
 * WHY THIS IS A SEPARATE MODULE
 *
 * This is the reliability fallback the whole Greenbook design rests on: when
 * every AI provider is rate-limited, undeployed or offline, "Ask this
 * Greenbook" must still answer from verified facts. That claim is only worth
 * anything if it can be exercised, and it could not be: the assembly lived in
 * ask.ts, which imports store.ts, which imports the Appwrite browser client and
 * therefore cannot load in Node.
 *
 * So the pure decision was extracted rather than the dependency mocked — the
 * same pattern used for `speech-mode.ts`. Nothing here touches the network, the
 * clock beyond an injectable `now`, or the Appwrite client. Given a packet it
 * returns the same answer every time, which is what makes it testable and what
 * makes it safe to fall back to.
 *
 * It also owns `trustStateOf`, because "how much do we trust this row" is the
 * one judgement both the fallback and the UI need to agree on. `store.ts`
 * re-exports it so no existing import changes.
 */
import type { EvidencePacket, GreenbookAnswer, GreenbookFact, TrustState } from "./contract";

/** The exact sentence the brief specifies for an unverifiable question. */
export const UNVERIFIED_ANSWER = "I couldn't verify this from a current authoritative source yet.";

/**
 * How many top-ranked facts the briefing is assembled from.
 *
 * Large enough to cover several chapters, small enough that an expanded sibling
 * cannot lead the answer. See `buildNoLlmAnswer`.
 */
export const BRIEFING_FACTS = 12;

/**
 * How much a stored row can be trusted, derived from its verification status
 * plus freshness. A row past its `validUntil` is stale no matter how it was
 * verified: an expired Student Pass rule is not official guidance any more.
 */
export function trustStateOf(fact: GreenbookFact, now = Date.now()): TrustState {
  if (fact.validUntil) {
    const expiry = Date.parse(fact.validUntil);
    if (!Number.isNaN(expiry) && expiry < now) return "stale";
  }
  switch (fact.verificationStatus) {
    case "stale":
      return "stale";
    case "community_verified":
      return "community";
    case "university_verified":
      return "university";
    case "official_verified":
      return "official";
    default:
      return "needs_review";
  }
}

function confidenceFor(facts: GreenbookFact[]): "high" | "medium" | "low" {
  if (!facts.length) return "low";
  const official = facts.filter((fact) => fact.authorityLevel === "A").length;
  if (official >= 3) return "high";
  if (official >= 1) return "medium";
  return "low";
}

export function latestCheck(facts: GreenbookFact[]): string | null {
  const dates = facts.map((fact) => fact.checkedAt).filter(Boolean).sort();
  return dates.at(-1) ?? null;
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
 * Assemble an answer with no model involved.
 *
 * The output is deliberately plain: the verified claims, the actions they imply,
 * the phrases that exist, and the official sources. It is less fluent than a
 * generated answer and it is never wrong about its provenance, which is the
 * trade this path is designed to make.
 *
 * An empty packet returns a refusal, never a guess. That is the same rule the
 * grounded path follows, so "we have no evidence" produces the same sentence
 * whichever path served the request.
 */
export function buildNoLlmAnswer(packet: EvidencePacket, phrases: string[]): GreenbookAnswer {
  const facts = packet.facts;
  if (!facts.length) {
    return {
      answer: UNVERIFIED_ANSWER,
      whatToDo: [],
      whatToPrepare: [],
      whatToSay: phrases,
      warnings: [],
      confidence: "low",
      sources: [],
      lastChecked: null,
      mode: "no_llm",
      facts: [],
    };
  }

  const official = facts.filter((fact) => trustStateOf(fact) === "official");
  const lead = official.length ? official : facts;

  /*
   * The briefing is built from the TOP-RANKED facts, not from everything
   * retrieved.
   *
   * The packet is ordered by relevance, so the first entries are what the
   * question was actually about. Group expansion deliberately adds siblings from
   * the matched chapters, and without this cap a question about a Student's Pass
   * produced a briefing led by a bank's investment disclaimer — true, verified,
   * and useless. The cap changes what is shown, never what is stored:
   * `answer.facts` still carries the whole packet for the UI.
   */
  const ranked = facts.slice(0, BRIEFING_FACTS);
  const byChapter = new Map<string, GreenbookFact[]>();
  for (const fact of ranked) {
    const list = byChapter.get(fact.chapter) ?? [];
    list.push(fact);
    byChapter.set(fact.chapter, list);
  }
  const summary = [...byChapter.entries()]
    .slice(0, 4)
    .map(([chapter, list]) => `${chapter.replace(/_/g, " ")}: ${list[0].claim}`)
    .join(" ");

  const prepare = facts
    .filter((fact) => fact.chapter === "get_ready" || /document|apply|prepare|bring|required/i.test(`${fact.claim} ${fact.action ?? ""}`))
    .map((fact) => fact.action ?? fact.claim)
    .slice(0, 5);

  return {
    answer: summary,
    whatToDo: [...new Set(facts.map((fact) => fact.action).filter((action): action is string => Boolean(action)))].slice(0, 8),
    whatToPrepare: [...new Set(prepare)],
    whatToSay: phrases,
    warnings: warningsFor(facts),
    confidence: confidenceFor(lead),
    sources: packet.sources,
    lastChecked: latestCheck(facts),
    mode: "no_llm",
    facts,
  };
}
