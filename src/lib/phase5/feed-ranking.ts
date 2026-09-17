import { COUNTRIES } from "../../data/countries";
import { campusFor, campusKey } from "../../data/campuses";
import { STAGE_ORDER, stageLabel, type ExchangeStage } from "../journey/dates";
import type { CommunityPost, PostType } from "./contract";

/**
 * The For You ranker.
 *
 * WHAT THIS IS
 *
 * A deterministic, auditable ranking function over a corpus of a few hundred
 * posts. It is not a trained model and does not pretend to be one. Every point a
 * post earns maps to a sentence a student can read, and `reasons` carries those
 * sentences to the card — the UI shows "Students at NUS", never "0.83 relevance".
 *
 * WHY DETERMINISTIC IS THE RIGHT ANSWER HERE, NOT A COMPROMISE
 *
 * A recommender earns its keep when the corpus is too large to inspect. YapYep's
 * community corpus is tens to low hundreds of posts and its viewer context is
 * unusually rich and *explicit*: the student told us their home country, host
 * country, host university, interests, concerns and languages during onboarding,
 * and the exchange stage is derived from real dates. Ranking that against a
 * known lexicon is both more accurate and more explainable than a model trained
 * on nothing. It also cannot fail: the feed is a pure function of rows already
 * fetched, so there is no inference on the scroll path, no quota, no latency
 * spike, and no way for a provider outage to empty the feed.
 *
 * SHAPE OF THE ALGORITHM (the same three stages a production system uses)
 *
 *   1. candidate retrieval — hard filters, applied as filters not penalties
 *   2. scoring            — weighted, human-readable components
 *   3. diversity          — greedy re-rank so no author or topic dominates
 *
 * The weights are the contract and `feed-ranking.test.mjs` pins them, so
 * changing what "relevant" means is a deliberate edit rather than a drift.
 */

export const FEED_WEIGHTS = {
  /** The single strongest signal: this post is about where you are going. */
  hostCountry: 26,
  university: 22,
  /** Same stage as the viewer. */
  stageCurrent: 15,
  /** The stage immediately ahead of the viewer — preparation value. */
  stageUpcoming: 11,
  /** Two or more stages ahead: real but not urgent. */
  stageAhead: 4,
  /** The stage is behind the viewer: reference value only. */
  stageBehind: 2,
  perSharedTopic: 7,
  maxSharedTopics: 21,
  perConcern: 9,
  maxConcerns: 18,
  followedAuthor: 20,
  savedPlace: 16,
  nearCampus: 12,
  perSharedLanguage: 5,
  maxSharedLanguages: 10,
  engagementCap: 12,
  typeAffinity: 8,
  /** Small on purpose — a tiebreak, not a bonus that can beat relevance. */
  recency: 8,
} as const;

/**
 * Recency half-life in days, and a floor on how far a post can decay.
 *
 * A pure exponential decay is wrong for this product: the best post about
 * arriving at NUS does not become useless in three weeks, and a feed that only
 * ever shows today's posts would be thin on any day the community is quiet. The
 * floor keeps an excellent older post competitive while still letting a fresh
 * one win on a tie.
 *
 * Recency is deliberately a *multiplier plus a small tiebreak* rather than a
 * flat bonus. A flat bonus of the same magnitude as the relevance weights would
 * let a brand-new, irrelevant post outrank an old, relevant one — the classic
 * "recency beats relevance" failure — so the additive part is small on purpose.
 */
export const RECENCY_HALF_LIFE_DAYS = 12;
export const FRESHNESS_FLOOR = 0.3;

/**
 * Diversity, applied during greedy selection so the strongest remaining
 * candidate always wins rather than being deleted.
 *
 * The decay is multiplicative rather than a fixed subtraction because a fixed
 * subtraction is meaningless across score scales: 20 points is decisive against
 * a 25-point post and irrelevant against a 200-point one. Multiplying by a
 * constant fraction demotes proportionally, so "the second post by this author"
 * means the same thing whatever the corpus looks like.
 */
export const DIVERSITY = {
  /** Each already-selected post by the same author multiplies the score by this. */
  authorDecay: 0.55,
  /** Each already-selected post sharing a topic multiplies the score by this. */
  topicDecay: 0.82,
  /** Each already-selected post of the same type multiplies the score by this. */
  typeDecay: 0.93,
  /** Hard ceiling. Even a perfect author cannot take the whole page. */
  maxPerAuthor: 3,
} as const;

/**
 * Which post stages are still actionable from a given viewer stage.
 *
 * A strict index delta is too crude: it puts a `first_week` post two steps ahead
 * of a student who has not left home yet, when in fact that post is exactly the
 * preparation they need. This table encodes the window that is genuinely useful
 * at each point in the journey, and everything outside it degrades to a small
 * reference score instead of disappearing.
 */
const ACTIONABLE_STAGES: Record<ExchangeStage, ExchangeStage[]> = {
  before_departure: ["before_departure", "arriving_soon", "first_24h", "first_week"],
  arriving_soon: ["arriving_soon", "first_24h", "first_week"],
  first_24h: ["first_24h", "first_week", "settling_in"],
  first_week: ["first_week", "settling_in", "studying"],
  settling_in: ["settling_in", "studying"],
  studying: ["studying"],
  returning_home: ["studying", "returning_home"],
  returned: ["returning_home", "returned"],
};

export interface ViewerFeedContext {
  userId: string | null;
  homeCountry: string;
  hostCountry: string;
  /** Campus key or university id; compared through `campusKey` so both spellings match. */
  hostUniversity: string;
  /** Derived from the journey timeline, never stored. */
  stage: ExchangeStage | null;
  interests: string[];
  concerns: string[];
  languages: string[];
  blockedIds: Set<string>;
  followedIds: Set<string>;
  /** Post ids the viewer reported or chose to hide. Hard filtered. */
  hiddenPostIds: Set<string>;
  /** Post types the viewer has reacted to, saved or commented on. */
  engagedTypes: Set<PostType>;
  /** Topics the viewer has engaged with, harvested from their interactions. */
  engagedTopics: Set<string>;
  /** Place ids the viewer has saved — a post about one of these is a strong hit. */
  savedPlaceIds: Set<string>;
  /** Place metadata, so "near your campus" is a measured fact and not a guess. */
  placeById: Map<string, { universityId: string; distanceFromCampusM: number }>;
}

export interface RankedPost {
  post: CommunityPost;
  score: number;
  reasons: string[];
}

/** Reject anything the viewer must never be shown, at any score. */
export function isEligible(post: CommunityPost, viewer: ViewerFeedContext): boolean {
  if (viewer.blockedIds.has(post.authorId)) return false;
  if (viewer.hiddenPostIds.has(post.id)) return false;
  if (post.verification === "blocked") return false;
  return true;
}

const NEAR_CAMPUS_M = 2_500;

function countryName(code: string): string {
  return (COUNTRIES as Record<string, { name?: string } | undefined>)[code]?.name ?? code;
}

/**
 * The short, human form of a university for a recommendation reason.
 *
 * The same campus is stored three ways across the corpus — seeded posts carry the
 * short code ("NUS"), posts written by the app carry whatever the campus registry
 * returned ("nus"), and a student who typed their own university has neither. The
 * reason is read by a person, so it is normalised to the registry's short code in
 * upper case, which is how students actually write it. Falling back to the raw
 * value keeps an unknown university visible rather than silently dropped.
 */
function universityLabel(id: string | undefined): string {
  const campus = campusFor(id);
  return (campus?.universityId ?? id ?? "").toUpperCase();
}

/**
 * Split a label into comparable tokens.
 *
 * Accents are folded because the product ships "Cafés" in its own onboarding
 * copy and the enrichment writes "cafe"; without folding, a French-accented
 * interest silently matches nothing. A trailing plural `s` is dropped for the
 * same reason — "cafes" and "cafe" are the same interest, and a student should
 * not lose a recommendation because of a plural.
 */
function topicTokens(value: string): Set<string> {
  const folded = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return new Set(
    folded
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3)
      .map((token) => (token.length > 4 && token.endsWith("s") ? token.slice(0, -1) : token)),
  );
}

/**
 * Intersect two label lists by shared meaning, not by identical strings.
 *
 * The onboarding stores interests as display phrases ("Street food", "Street
 * photography", "Cafés") while enrichment stores single keywords ("food",
 * "photography", "cafe"). An exact string comparison therefore matches almost
 * nothing a real student actually picked, and the "Matches your interest" reason
 * never fires — the feature looks implemented and is inert. Comparing token sets
 * makes the two vocabularies meet, which is the whole point of having a shared
 * vocabulary at all.
 *
 * The returned label is the *viewer's* phrasing, because the reason is shown to
 * the viewer: "Matches your Street food interest" reads better than "Matches your
 * food interest" and tells them the ranking used what they chose.
 */
function overlap(a: readonly string[], b: readonly string[]): string[] {
  const tokenSets = b.map((value) => topicTokens(value));
  return a.filter((value) => {
    const tokens = topicTokens(value);
    if (!tokens.size) return false;
    return tokenSets.some((set) => {
      for (const token of tokens) if (set.has(token)) return true;
      return false;
    });
  });
}

/**
 * A stage phrased so it reads correctly inside both reason templates below.
 *
 * `stageLabel` returns title-case nouns ("First week") which are right for a
 * chip and wrong inside a sentence: "Useful for First week" is not English. This
 * table exists so the reason a student reads is a sentence rather than a label
 * with a preposition glued to the front.
 */
const STAGE_PHRASES: Record<ExchangeStage, string> = {
  before_departure: "your departure prep",
  arriving_soon: "your arrival",
  first_24h: "your first day",
  first_week: "your first week",
  settling_in: "settling in",
  studying: "the study term",
  returning_home: "heading home",
  returned: "life after exchange",
};

/**
 * How useful a post's exchange stage is to a viewer in `viewerStage`.
 *
 * Direction matters, exactly as it does in PairDNA: a post written during the
 * first week is preparation for someone about to arrive and nostalgia for
 * someone about to leave, and those are different products.
 */
function stageScore(viewerStage: ExchangeStage | null, postStage: ExchangeStage | null | undefined): { points: number; reason: string | null } {
  if (!viewerStage || !postStage) return { points: 0, reason: null };
  const viewerIndex = STAGE_ORDER.indexOf(viewerStage);
  const postIndex = STAGE_ORDER.indexOf(postStage);
  if (viewerIndex === -1 || postIndex === -1) return { points: 0, reason: null };

  const phrase = STAGE_PHRASES[postStage] ?? stageLabel(postStage).toLowerCase();
  if (postStage === viewerStage) return { points: FEED_WEIGHTS.stageCurrent, reason: `Useful for ${phrase}` };
  if (ACTIONABLE_STAGES[viewerStage].includes(postStage)) {
    return { points: FEED_WEIGHTS.stageUpcoming, reason: `Worth reading before ${phrase}` };
  }
  if (postIndex > viewerIndex) return { points: FEED_WEIGHTS.stageAhead, reason: null };
  return { points: FEED_WEIGHTS.stageBehind, reason: null };
}

function ageInDays(createdAt: string, now: number): number {
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return 0;
  return Math.max(0, (now - created) / 86_400_000);
}

/**
 * Score one post. Exported so the test suite can pin individual components
 * rather than only the resulting order.
 */
export function scorePost(post: CommunityPost, viewer: ViewerFeedContext, now: number): RankedPost {
  let base = 0;
  const reasons: string[] = [];

  // --- where the post is about ---
  if (post.countryCode && post.countryCode === viewer.hostCountry) {
    base += FEED_WEIGHTS.hostCountry;
    reasons.push(`Because you're moving to ${countryName(viewer.hostCountry)}`);
  }

  const sameUniversity = Boolean(viewer.hostUniversity) && campusKey(post.universityId) === campusKey(viewer.hostUniversity);
  if (sameUniversity) {
    base += FEED_WEIGHTS.university;
    reasons.push(`Students at ${universityLabel(post.universityId || viewer.hostUniversity)}`);
  }

  // --- when the post was written ---
  const stage = stageScore(viewer.stage, post.journeyStage);
  base += stage.points;
  if (stage.reason) reasons.push(stage.reason);

  // --- what the post is about, against what the viewer said they care about ---
  /*
   * The viewer's list is the first argument on purpose: `overlap` returns the
   * labels from its first argument, and the reason is read by the viewer. Passing
   * the post's topics first would print the enrichment keyword ("Matches your
   * food interest") instead of what the student actually picked ("Matches your
   * Street food interest") — a small difference that decides whether the
   * recommendation feels personal or generated.
   */
  const sharedTopics = overlap(viewer.interests, post.topics);
  if (sharedTopics.length) {
    base += Math.min(sharedTopics.length * FEED_WEIGHTS.perSharedTopic, FEED_WEIGHTS.maxSharedTopics);
    reasons.push(`Matches your ${sharedTopics.slice(0, 2).join(" and ")} interest`);
  }

  const matchedConcerns = overlap(viewer.concerns, post.topics);
  if (matchedConcerns.length) {
    base += Math.min(matchedConcerns.length * FEED_WEIGHTS.perConcern, FEED_WEIGHTS.maxConcerns);
    reasons.push(`About something you flagged: ${matchedConcerns[0]}`);
  }

  // --- who wrote it ---
  if (viewer.followedIds.has(post.authorId)) {
    base += FEED_WEIGHTS.followedAuthor;
    reasons.push("You follow this student");
  }

  const sharedLanguages = overlap(post.author.languages ?? [], viewer.languages);
  if (sharedLanguages.length) {
    base += Math.min(sharedLanguages.length * FEED_WEIGHTS.perSharedLanguage, FEED_WEIGHTS.maxSharedLanguages);
    reasons.push("They speak a language you do too");
  }

  // --- the place it is pinned to ---
  if (post.placeId) {
    if (viewer.savedPlaceIds.has(post.placeId)) {
      base += FEED_WEIGHTS.savedPlace;
      reasons.push("About a place you saved");
    }
    const place = viewer.placeById.get(post.placeId);
    if (place && place.distanceFromCampusM <= NEAR_CAMPUS_M) {
      base += FEED_WEIGHTS.nearCampus;
      reasons.push("Near your campus");
    }
  }

  // --- how the community received it ---
  // log-scaled: the difference between 0 and 5 reactions matters far more than
  // between 40 and 45, and a linear term would let one viral post own the feed.
  const engagement = Math.log1p(post.reactionCount + 2 * post.commentCount + 3 * post.saveCount);
  base += Math.min(FEED_WEIGHTS.engagementCap, engagement * 3);

  // --- what the viewer has engaged with before ---
  if (viewer.engagedTypes.has(post.postType)) {
    base += FEED_WEIGHTS.typeAffinity;
  }
  if (post.topics.some((topic) => viewer.engagedTopics.has(topic))) {
    base += FEED_WEIGHTS.perSharedTopic;
    reasons.push("More like what you read");
  }

  /*
   * Recency is both a multiplier and a bonus.
   *
   * The multiplier alone would let a fresh, irrelevant post outrank a relevant
   * one; the bonus alone would let a year-old viral post sit at the top forever.
   * Together: relevance decides the neighbourhood, freshness decides within it.
   */
  const age = ageInDays(post.createdAt, now);
  const freshness = Math.pow(0.5, age / RECENCY_HALF_LIFE_DAYS);
  const decayed = base * (FRESHNESS_FLOOR + (1 - FRESHNESS_FLOOR) * freshness) + FEED_WEIGHTS.recency * freshness;

  return { post, score: Math.round(decayed * 100) / 100, reasons: [...new Set(reasons)].slice(0, 3) };
}

export interface RankOptions {
  viewer: ViewerFeedContext;
  limit?: number;
  /** Injectable for deterministic tests. */
  now?: number;
}

/**
 * Rank the feed.
 *
 * Selection is greedy: repeatedly take the candidate with the best *adjusted*
 * score, where the adjustment decays the score for each author, topic and type
 * already present in the result. The strongest remaining post always wins, and
 * the decay only ever reorders — it never drops a post.
 *
 * THE CEILING AND THE BACKFILL
 *
 * `maxPerAuthor` is a ceiling on the *head* of the feed, not a filter on the
 * corpus. Once every remaining candidate is at its author ceiling the loop
 * stops, and whatever is left is appended by raw score. Two things are true at
 * once: the top of the feed never belongs to one person, and the feed is never
 * shorter than the eligible corpus. A hard drop would have been wrong for this
 * product — the seeded corpus is thin, and a ceiling that silently truncated a
 * page would read as "the community is empty".
 */
export function rankFeed(posts: CommunityPost[], options: RankOptions): RankedPost[] {
  const { viewer } = options;
  const now = options.now ?? Date.now();

  const scored = posts
    .filter((post) => isEligible(post, viewer))
    .map((post) => scorePost(post, viewer, now));

  const authorCounts = new Map<string, number>();
  const topicCounts = new Map<string, number>();
  const typeCounts = new Map<PostType, number>();

  const remaining = [...scored].sort((a, b) => b.score - a.score || a.post.id.localeCompare(b.post.id));
  const selected: RankedPost[] = [];

  while (remaining.length) {
    if (options.limit && selected.length >= options.limit) return selected;

    let bestIndex = -1;
    let bestAdjusted = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const authorCount = authorCounts.get(candidate.post.authorId) ?? 0;
      if (authorCount >= DIVERSITY.maxPerAuthor) continue;

      let adjusted = candidate.score * Math.pow(DIVERSITY.authorDecay, authorCount);
      adjusted *= Math.pow(DIVERSITY.typeDecay, typeCounts.get(candidate.post.postType) ?? 0);
      for (const topic of candidate.post.topics) {
        adjusted *= Math.pow(DIVERSITY.topicDecay, topicCounts.get(topic) ?? 0);
      }

      if (adjusted > bestAdjusted) {
        bestAdjusted = adjusted;
        bestIndex = index;
      }
    }

    // Every remaining candidate is at its author ceiling: the head of the feed
    // is settled and the rest is overflow.
    if (bestIndex === -1) break;

    const [picked] = remaining.splice(bestIndex, 1);
    selected.push(picked);
    authorCounts.set(picked.post.authorId, (authorCounts.get(picked.post.authorId) ?? 0) + 1);
    typeCounts.set(picked.post.postType, (typeCounts.get(picked.post.postType) ?? 0) + 1);
    for (const topic of picked.post.topics) topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
  }

  // Overflow, ordered by score. Never truncate an eligible post.
  const overflow = [...remaining].sort((a, b) => b.score - a.score || a.post.id.localeCompare(b.post.id));
  return [...selected, ...overflow];
}

/** Attach the ranker's reasons to the post objects the UI already renders. */
export function withReasons(ranked: RankedPost[]): CommunityPost[] {
  return ranked.map((entry) => ({ ...entry.post, reasons: entry.reasons }));
}
