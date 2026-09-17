import type { ExchangeStage } from "../journey/dates";

/**
 * Deterministic post enrichment.
 *
 * WHY THIS IS NOT AN LLM CALL
 *
 * The Phase 5.1 brief allows AI to derive post metadata and requires the feed to
 * survive a total AI outage. It also fences this work off from the AI gateway
 * contracts, which another task is hardening in parallel.
 *
 * Those two constraints point the same way. The gateway exposes no post
 * enrichment route, and adding one is out of scope, so the only ways to get
 * "AI metadata" would be to bolt an ill-fitting route on (`/study/analyze` is
 * academic-document analysis) or to invent a provider call in the client. Both
 * would produce metadata that is either wrong or unaccountable, on the critical
 * path of publishing a post.
 *
 * So enrichment is a lexicon. It is boring, it is instant, it costs nothing, it
 * cannot fail, and — the part that matters for this product — a student can look
 * at the caption and see exactly why the tag was applied. When a real enrichment
 * route exists, `DerivedMetadata.source` is where it declares itself, and every
 * consumer already reads through this interface rather than around it.
 */

export interface DerivedMetadata {
  topics: string[];
  journeyStage: ExchangeStage | null;
  helpfulnessTags: string[];
  placeContext: string | null;
  summary: string;
  source: "deterministic";
}

/**
 * Topic lexicon. Keys are the canonical topic; values are lowercase substrings
 * searched in the caption. Substrings rather than word boundaries because
 * captions mix languages and stem inconsistently ("studying", "studied").
 */
const TOPIC_LEXICON: Record<string, string[]> = {
  food: [
    "food", "eat", "meal", "lunch", "dinner", "breakfast", "canteen", "hawker", "restaurant", "cafe",
    "coffee", "noodle", "rice", "halal", "vegetarian", "mamak", "banh mi", "pho", "cheap eats", "food court",
  ],
  study: ["study", "library", "exam", "assignment", "lecture", "notes", "revision", "deadline", "tutorial", "group work", "project"],
  accommodation: ["dorm", "hostel", "housing", "room", "rent", "landlord", "flatmate", "roommate"],
  transport: ["bus", "mrt", "metro", "train", "grab", "taxi", "bike", "scooter", "commute", "traffic", "airport"],
  language: ["language", "phrase", "speak", "accent", "vocabulary", "pronounce", "translation", "mandarin", "vietnamese", "thai", "malay", "bahasa", "english"],
  money: ["money", "budget", "cost", "price", "cheap", "expensive", "bank", "payment", "cash", "card", "scholarship"],
  health: ["clinic", "hospital", "doctor", "pharmacy", "sick", "medicine", "insurance", "health"],
  social: ["friend", "club", "society", "event", "party", "meet", "community", "volunteer", "sport", "football", "basketball"],
  culture: ["culture", "custom", "tradition", "festival", "religion", "temple", "mosque", "church", "etiquette", "respect", "taboo"],
  place: ["place", "spot", "area", "neighbourhood", "neighborhood", "mall", "market", "park", "museum"],
  campus: ["campus", "university", "faculty", "lecturer", "professor", "class", "semester"],
};

/**
 * Stage hints, ordered by how *specific* the phrase is rather than by stage
 * order. "first week" must beat "week", and a caption that says "my first week"
 * must not be read as "returning home" just because it also says "last week".
 * The scorer below picks the longest matching phrase, which is why the longest
 * phrasing of each stage is listed explicitly.
 */
const STAGE_HINTS: { stage: ExchangeStage; phrases: string[] }[] = [
  { stage: "first_24h", phrases: ["just landed", "first day", "day one", "just arrived", "just got here", "landed today"] },
  { stage: "arriving_soon", phrases: ["flying out", "leaving in", "next week i", "arriving soon", "about to leave"] },
  { stage: "before_departure", phrases: ["pre-departure", "before i go", "visa application", "still packing", "preparing to go"] },
  { stage: "first_week", phrases: ["first week", "week one", "first few days", "welcome week", "orientation week", "just moved"] },
  { stage: "settling_in", phrases: ["settling in", "getting settled", "getting used to", "still adjusting", "few weeks in", "second week", "third week"] },
  { stage: "returning_home", phrases: ["going home", "heading back", "before i leave", "wrapping up", "last week here"] },
  { stage: "studying", phrases: ["midterm", "finals", "this semester", "my classes", "lecture", "assignment due", "tutorial"] },
];

/** Short labels a student can act on, derived from the topics that fired. */
const HELPFULNESS_BY_TOPIC: Record<string, string> = {
  food: "affordable_food",
  study: "study_spot",
  accommodation: "housing",
  transport: "getting_around",
  language: "language_tip",
  money: "budget",
  health: "health",
  social: "making_friends",
  culture: "cultural_note",
  place: "place_recommendation",
  campus: "campus_life",
};

const MAX_TOPICS = 5;

/**
 * Lowercase, strip punctuation to spaces, collapse whitespace.
 *
 * Punctuation is stripped rather than merely lowercased because the stage
 * matcher tests whole words against a space-padded haystack: without this,
 * "my last week here." would fail to match "last week here" purely because the
 * sentence ended. Diacritics are preserved — `\p{L}` covers Vietnamese, Thai and
 * Khmer, which a naive `[^a-z0-9]` class would have destroyed.
 */
function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pick the stage whose matched phrase is the longest. A tie is impossible for
 * distinct phrases, and an equal-length tie falls back to the first listed
 * stage, which keeps the function total and deterministic.
 *
 * Matching is on whole words, not raw substrings. "Settling into my first week"
 * contains the substring "settling in" but is not a statement about settling in
 * — and because that false positive is longer than "first week", substring
 * matching would silently pick the wrong stage. Padding the haystack and the
 * needle with spaces turns the check into a word-boundary test.
 *
 * Topics deliberately still use substring matching, because "study" must match
 * "studying" and there is no such confusion there.
 */
function deriveStage(text: string): ExchangeStage | null {
  const haystack = ` ${text} `;
  let best: { stage: ExchangeStage; length: number } | null = null;
  for (const entry of STAGE_HINTS) {
    for (const phrase of entry.phrases) {
      if (!haystack.includes(` ${phrase} `)) continue;
      if (!best || phrase.length > best.length) best = { stage: entry.stage, length: phrase.length };
    }
  }
  return best?.stage ?? null;
}

/** First sentence, clipped, so a card can show a one-line gist without re-parsing. */
function summarise(body: string, limit = 140): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const stop = flat.search(/[.!?](\s|$)/);
  const sentence = stop === -1 ? flat : flat.slice(0, stop + 1);
  return sentence.length <= limit ? sentence : `${sentence.slice(0, limit - 1).trimEnd()}…`;
}

export interface EnrichInput {
  body: string;
  postType?: string;
  /** The place name, when the post is pinned, so place context is a fact not a guess. */
  placeName?: string | null;
  /** Tags the author chose explicitly. Always retained, never overwritten. */
  explicitTags?: string[];
}

export function deriveMetadata(input: EnrichInput): DerivedMetadata {
  const text = normalise(`${input.body} ${(input.explicitTags ?? []).join(" ")}`);

  const topics: string[] = [];
  for (const [topic, needles] of Object.entries(TOPIC_LEXICON)) {
    if (needles.some((needle) => text.includes(needle))) topics.push(topic);
    if (topics.length >= MAX_TOPICS) break;
  }

  // A question is about its topic even when the caption never names it.
  if (!topics.length && input.postType) topics.push(input.postType);

  const helpfulnessTags = topics.map((topic) => HELPFULNESS_BY_TOPIC[topic]).filter(Boolean);

  return {
    topics: [...new Set(topics)],
    journeyStage: deriveStage(text),
    helpfulnessTags: [...new Set(helpfulnessTags)],
    // Only a real pin produces a place context. Guessing one from the caption
    // would put a place name on a post that never claimed it.
    placeContext: input.placeName ? input.placeName : null,
    summary: summarise(input.body),
    source: "deterministic",
  };
}
