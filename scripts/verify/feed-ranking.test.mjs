/**
 * For You ranking and deterministic enrichment tests.
 *
 * WHY THESE ARE PINNED
 *
 * The ranker decides what a 19-year-old sees first in a country they just moved
 * to, and it does so with no model to point at when the result looks wrong. The
 * only defence against silent drift is that the behaviour is asserted: the
 * weights, the decay, the diversity caps and — most importantly — the sentences
 * shown to the student.
 *
 * The reasons get their own assertions because they are the product claim. A
 * feed that ranks well but explains itself with "0.83 relevance" has failed the
 * brief even when the ordering is perfect.
 *
 * Run: node --test scripts/verify/feed-ranking.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);

const {
  DIVERSITY,
  FEED_WEIGHTS,
  FRESHNESS_FLOOR,
  RECENCY_HALF_LIFE_DAYS,
  isEligible,
  rankFeed,
  scorePost,
  withReasons,
} = await import("../../src/lib/phase5/feed-ranking.ts");
const { deriveMetadata } = await import("../../src/lib/phase5/enrichment.ts");

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-17T00:00:00.000Z");

let counter = 0;
function makePost(overrides = {}) {
  counter += 1;
  const id = overrides.id ?? `post_${counter}`;
  return {
    id,
    authorId: overrides.authorId ?? `author_${id}`,
    author: {
      id: overrides.authorId ?? `author_${id}`,
      displayName: "Student",
      initials: "ST",
      color: "#111111",
      isDemoSeed: true,
      languages: [],
      ...(overrides.author ?? {}),
    },
    countryCode: "SG",
    universityId: "NUS",
    postType: "tip",
    body: "A tip",
    tags: [],
    topics: [],
    journeyStage: undefined,
    reactionCount: 0,
    commentCount: 0,
    saveCount: 0,
    media: [],
    isDemoSeed: true,
    createdAt: new Date(NOW - DAY).toISOString(),
    viewerReacted: false,
    viewerSaved: false,
    ...overrides,
  };
}

function makeViewer(overrides = {}) {
  return {
    userId: "viewer",
    homeCountry: "VN",
    hostCountry: "SG",
    hostUniversity: "NUS",
    stage: "before_departure",
    interests: [],
    concerns: [],
    languages: [],
    blockedIds: new Set(),
    followedIds: new Set(),
    hiddenPostIds: new Set(),
    engagedTypes: new Set(),
    engagedTopics: new Set(),
    savedPlaceIds: new Set(),
    placeById: new Map(),
    ...overrides,
  };
}

/* ------------------------------- hard filters ------------------------------ */

test("a blocked author is filtered, not merely penalised", () => {
  const post = makePost({ authorId: "blocked_user" });
  const viewer = makeViewer({ blockedIds: new Set(["blocked_user"]) });
  assert.equal(isEligible(post, viewer), false);
  assert.deepEqual(rankFeed([post], { viewer, now: NOW }), []);
});

test("a hidden post is filtered even when it is the most relevant one", () => {
  const post = makePost({ id: "reported", countryCode: "SG", universityId: "NUS", reactionCount: 500 });
  const viewer = makeViewer({ hiddenPostIds: new Set(["reported"]) });
  assert.deepEqual(rankFeed([post], { viewer, now: NOW }), []);
});

test("a post with no author is still rankable, because a profile read can fail", () => {
  // `loadAuthors` falls back to a synthesised author rather than dropping the
  // post; the ranker must not be the thing that reintroduces the drop.
  const post = makePost({ author: { id: "ghost", displayName: "Student", initials: "ST", color: "#000", isDemoSeed: false } });
  assert.equal(rankFeed([post], { viewer: makeViewer(), now: NOW }).length, 1);
});

/* --------------------------------- scoring -------------------------------- */

test("host country is the strongest single signal and says so", () => {
  const sg = makePost({ countryCode: "SG", universityId: "OTHER" });
  const th = makePost({ countryCode: "TH", universityId: "OTHER" });
  const viewer = makeViewer({ hostUniversity: "NUS" });

  const sgScored = scorePost(sg, viewer, NOW);
  const thScored = scorePost(th, viewer, NOW);

  assert.ok(sgScored.score > thScored.score);
  assert.ok(sgScored.reasons.includes("Because you're moving to Singapore"));
  assert.equal(thScored.reasons.includes("Because you're moving to Singapore"), false);
});

test("the campus registry, not the raw field, decides a university match", () => {
  // The seed pack stores "NUS"; the profile stores the full display name. Only
  // `campusKey` knows they are the same place, and a raw comparison would
  // silently match nothing.
  const post = makePost({ universityId: "NUS" });
  const viewer = makeViewer({ hostUniversity: "National University of Singapore" });
  const scored = scorePost(post, viewer, NOW);
  assert.ok(scored.reasons.some((reason) => reason.startsWith("Students at")));
});

test("the same stage reads as useful now, the next stage as preparation", () => {
  const viewer = makeViewer({ stage: "settling_in" });

  const same = scorePost(makePost({ journeyStage: "settling_in" }), viewer, NOW);
  const next = scorePost(makePost({ journeyStage: "studying" }), viewer, NOW);
  const far = scorePost(makePost({ journeyStage: "returned" }), viewer, NOW);
  const behind = scorePost(makePost({ journeyStage: "first_week" }), viewer, NOW);

  assert.ok(same.reasons.includes("Useful for settling in"));
  assert.ok(next.reasons.includes("Worth reading before the study term"));
  assert.ok(same.score > next.score, "same stage should outweigh the next stage");
  assert.ok(next.score > far.score, "an actionable stage should outweigh a distant one");
  assert.ok(far.score > behind.score, "ahead beats behind");
});

test("a pre-departure student is still served first-week content, not told it is distant", () => {
  // A strict index delta would file "first week" two steps ahead of a student
  // who has not left home, and drop the single most useful post in the corpus to
  // a 4-point reference score. The actionable window exists to prevent that.
  const viewer = makeViewer({ stage: "before_departure" });
  const firstWeek = scorePost(makePost({ journeyStage: "first_week" }), viewer, NOW);
  const longAfter = scorePost(makePost({ journeyStage: "returned" }), viewer, NOW);
  assert.ok(firstWeek.reasons.includes("Worth reading before your first week"));
  assert.ok(firstWeek.score > longAfter.score);
});

test("stage reasons read as sentences, not labels with a preposition glued on", () => {
  const viewer = makeViewer({ stage: "before_departure" });
  const scored = scorePost(makePost({ journeyStage: "first_week" }), viewer, NOW);
  assert.ok(scored.reasons.includes("Worth reading before your first week"));
  assert.equal(
    scored.reasons.some((reason) => /for First week|before First week/.test(reason)),
    false,
  );
});

test("engagement is log-scaled and capped so one viral post cannot own the feed", () => {
  const viewer = makeViewer();
  const quiet = scorePost(makePost({ reactionCount: 0 }), viewer, NOW);
  const warm = scorePost(makePost({ reactionCount: 5 }), viewer, NOW);
  const viral = scorePost(makePost({ reactionCount: 5000, commentCount: 900, saveCount: 900 }), viewer, NOW);

  const warmGain = warm.score - quiet.score;
  const viralGain = viral.score - quiet.score;
  assert.ok(warmGain > 0);
  // The whole engagement contribution is bounded by the cap plus its decayed
  // share, so a post with 5000 reactions cannot open an unbounded gap.
  assert.ok(viralGain < FEED_WEIGHTS.engagementCap * 2, `viral gain ${viralGain} should stay bounded`);
  assert.ok(viralGain > warmGain, "engagement must still matter");
});

test("a followed author and a saved place are both explainable boosts", () => {
  const viewer = makeViewer({
    followedIds: new Set(["followed"]),
    savedPlaceIds: new Set(["place_1"]),
  });
  const followed = scorePost(makePost({ authorId: "followed" }), viewer, NOW);
  const pinned = scorePost(makePost({ placeId: "place_1" }), viewer, NOW);
  const plain = scorePost(makePost(), viewer, NOW);

  assert.ok(followed.reasons.includes("You follow this student"));
  assert.ok(pinned.reasons.includes("About a place you saved"));
  assert.ok(followed.score > plain.score);
  assert.ok(pinned.score > plain.score);
});

test("a place within the campus radius is a measured fact, not a guess", () => {
  const viewer = makeViewer({ placeById: new Map([["near", { universityId: "NUS", distanceFromCampusM: 400 }]]) });
  const near = scorePost(makePost({ placeId: "near" }), viewer, NOW);
  const unknown = scorePost(makePost({ placeId: "far" }), viewer, NOW);
  assert.ok(near.reasons.includes("Near your campus"));
  assert.equal(unknown.reasons.includes("Near your campus"), false);
});

/* -------------------------------- recency --------------------------------- */

test("an identical newer post outranks an older one, and the floor stops the decay", () => {
  const viewer = makeViewer();
  const fresh = makePost({ createdAt: new Date(NOW - 0.5 * DAY).toISOString() });
  const old = makePost({ createdAt: new Date(NOW - 90 * DAY).toISOString() });

  const freshScore = scorePost(fresh, viewer, NOW).score;
  const oldScore = scorePost(old, viewer, NOW).score;
  assert.ok(freshScore > oldScore, "freshness must break a tie");

  // A very old post still scores: the feed must not empty out on a quiet day.
  const stale = scorePost(makePost({ createdAt: new Date(NOW - 3650 * DAY).toISOString() }), viewer, NOW).score;
  assert.ok(stale > 0);
  assert.ok(FRESHNESS_FLOOR > 0 && FRESHNESS_FLOOR < 1);
  assert.ok(RECENCY_HALF_LIFE_DAYS > 0);
});

/* -------------------------------- diversity ------------------------------- */

test("among equally relevant posts, no single author takes consecutive slots", () => {
  const viewer = makeViewer();
  // Everyone is equally relevant, so the only thing deciding the order is
  // diversity. That is the case a feed actually has to get right.
  const posts = [
    ...Array.from({ length: 6 }, (_, index) => makePost({ id: `dom_${index}`, authorId: "prolific" })),
    ...Array.from({ length: 4 }, (_, index) => makePost({ id: `other_${index}`, authorId: `author_${index}` })),
  ];

  const ranked = rankFeed(posts, { viewer, now: NOW });
  const firstThree = ranked.slice(0, 3).map((entry) => entry.post.authorId);

  assert.equal(ranked.length, 10, "diversity reorders, it does not drop");
  assert.ok(new Set(firstThree).size > 1, `first three were all ${firstThree[0]}`);
});

test("an author who is the only relevant source is capped at the head, never truncated", () => {
  const viewer = makeViewer();
  const dominant = Array.from({ length: 6 }, (_, index) =>
    makePost({ id: `dom_${index}`, authorId: "prolific", countryCode: "SG", universityId: "NUS", reactionCount: 100 }),
  );
  const irrelevant = Array.from({ length: 4 }, (_, index) =>
    makePost({ id: `other_${index}`, authorId: `author_${index}`, countryCode: "TH", universityId: "OTHER" }),
  );

  const ranked = rankFeed([...dominant, ...irrelevant], { viewer, now: NOW });
  const ids = ranked.map((entry) => entry.post.id);
  const dominantPositions = ids.map((id, index) => (id.startsWith("dom_") ? index : -1)).filter((index) => index >= 0);

  // Every eligible post is still present: a thin corpus must not produce a feed
  // that looks empty just because one author was prolific.
  assert.equal(ranked.length, 10);

  // The prolific author's 4th post must sit after every other author's posts.
  const lastOtherPosition = Math.max(...ids.map((id, index) => (id.startsWith("other_") ? index : -1)));
  assert.ok(
    dominantPositions[3] > lastOtherPosition,
    `4th prolific post at ${dominantPositions[3]} should be after the last other post at ${lastOtherPosition}`,
  );
});

test("a caller-supplied limit is respected exactly", () => {
  const viewer = makeViewer();
  const posts = Array.from({ length: 30 }, (_, index) => makePost({ id: `p${index}`, authorId: `a${index}` }));
  assert.equal(rankFeed(posts, { viewer, now: NOW, limit: 12 }).length, 12);
});

test("a repeated topic is demoted but never deleted", () => {
  const viewer = makeViewer({ interests: ["food"] });
  const foodPosts = Array.from({ length: 4 }, (_, index) =>
    makePost({ id: `food_${index}`, authorId: `a${index}`, topics: ["food"], countryCode: "SG", universityId: "NUS" }),
  );
  const studyPost = makePost({ id: "study_0", authorId: "s1", topics: ["study"], countryCode: "TH", universityId: "OTHER" });

  const ranked = rankFeed([...foodPosts, studyPost], { viewer, now: NOW });
  assert.equal(ranked.length, 5, "diversity reorders, it does not drop");
  assert.ok(ranked.some((entry) => entry.post.id === "study_0"));
});

/* --------------------------------- reasons -------------------------------- */

test("reasons are capped, deduplicated and never an opaque score", () => {
  const viewer = makeViewer({
    interests: ["food"],
    concerns: ["food"],
    followedIds: new Set(["author_x"]),
    savedPlaceIds: new Set(["p1"]),
    placeById: new Map([["p1", { universityId: "NUS", distanceFromCampusM: 100 }]]),
  });
  const post = makePost({
    id: "everything",
    authorId: "author_x",
    placeId: "p1",
    topics: ["food"],
    journeyStage: "before_departure",
    countryCode: "SG",
    universityId: "NUS",
  });

  const scored = scorePost(post, viewer, NOW);
  assert.ok(scored.reasons.length <= 3, "the card has room for three reasons");
  assert.equal(new Set(scored.reasons).size, scored.reasons.length, "no repeated reason");
  for (const reason of scored.reasons) {
    assert.equal(/%|\bscore\b|\bAI knows\b/i.test(reason), false, `opaque reason leaked: ${reason}`);
  }
});

test("reasons survive onto the post objects the UI renders", () => {
  const viewer = makeViewer();
  const ranked = rankFeed([makePost({ countryCode: "SG" })], { viewer, now: NOW });
  const [post] = withReasons(ranked);
  assert.ok(Array.isArray(post.reasons));
  assert.ok(post.reasons.includes("Because you're moving to Singapore"));
});

/* ------------------------------- determinism ------------------------------ */

test("ranking is a pure function of its inputs", () => {
  const viewer = makeViewer({ interests: ["food"] });
  const posts = Array.from({ length: 25 }, (_, index) =>
    makePost({ id: `p${index}`, authorId: `a${index % 7}`, topics: [index % 2 ? "food" : "study"], reactionCount: index }),
  );
  const first = rankFeed(posts, { viewer, now: NOW }).map((entry) => entry.post.id);
  const second = rankFeed([...posts].reverse(), { viewer, now: NOW }).map((entry) => entry.post.id);
  assert.deepEqual(first, second, "input order must not change the ranking");
});

/* ------------------------------- enrichment ------------------------------- */

test("topics come from the caption, and a question still gets one", () => {
  const food = deriveMetadata({ body: "Cheap hawker food near the campus food court, under 5 dollars." });
  assert.ok(food.topics.includes("food"));
  assert.ok(food.helpfulnessTags.includes("affordable_food"));

  const question = deriveMetadata({ body: "Anyone know how to get this done?", postType: "question" });
  assert.deepEqual(question.topics, ["question"]);
});

test("stage hints prefer the most specific phrase", () => {
  // "first week" and "last week here" both appear; the longer phrase is the
  // later stage and must win, because that is what the student actually said.
  const mixed = deriveMetadata({ body: "My first week was hard but now it is my last week here." });
  assert.equal(mixed.journeyStage, "returning_home");

  const firstWeek = deriveMetadata({ body: "Settling into my first week at NUS." });
  assert.equal(firstWeek.journeyStage, "first_week");

  const landed = deriveMetadata({ body: "Just landed and already lost at the airport." });
  assert.equal(landed.journeyStage, "first_24h");
});

test("place context is only claimed when a place is actually pinned", () => {
  const without = deriveMetadata({ body: "Great coffee somewhere near campus." });
  assert.equal(without.placeContext, null);
  const withPin = deriveMetadata({ body: "Great coffee.", placeName: "NUS Central Library" });
  assert.equal(withPin.placeContext, "NUS Central Library");
});

test("enrichment never fails and always declares its source", () => {
  for (const body of ["", "   ", "??", "a".repeat(4000)]) {
    const meta = deriveMetadata({ body });
    assert.equal(meta.source, "deterministic");
    assert.ok(Array.isArray(meta.topics));
    assert.ok(meta.summary.length <= 141);
  }
});

test("a long caption is summarised rather than truncated mid-word by the caller", () => {
  const meta = deriveMetadata({ body: `${"word ".repeat(80)}end.` });
  assert.ok(meta.summary.endsWith("…"));
  assert.ok(meta.summary.length <= 141);
});

/* --------------------- interest matching across vocabularies --------------- */

/*
 * The onboarding stores interests as display phrases ("Street food", "Cafés",
 * "Photography") while enrichment stores single lowercase keywords ("food",
 * "cafe", "photography"). These tests pin the bridge between the two: a ranker
 * whose "Matches your interest" reason can never fire looks finished and is
 * inert, which is worse than not shipping the reason at all.
 */

function interestReason(viewer, post) {
  return scorePost(post, viewer, NOW).reasons.find((reason) => reason.includes("interest"));
}

test("a multi-word interest matches a single-keyword topic", () => {
  const reason = interestReason(makeViewer({ interests: ["Street food"] }), makePost({ topics: ["food"] }));
  assert.ok(reason, "expected an interest reason for Street food vs the topic food");
  assert.ok(reason.includes("Street food"), reason);
});

test("an accented interest matches its unaccented topic", () => {
  const reason = interestReason(makeViewer({ interests: ["Cafés"] }), makePost({ topics: ["cafe"] }));
  assert.ok(reason, "expected Cafés to match the topic cafe");
});

test("a plural interest matches its singular topic", () => {
  const reason = interestReason(makeViewer({ interests: ["Study spots"] }), makePost({ topics: ["study"] }));
  assert.ok(reason, "expected Study spots to match the topic study");
});

test("unrelated interests do not manufacture a match", () => {
  const reason = interestReason(makeViewer({ interests: ["Football"] }), makePost({ topics: ["food", "study"] }));
  assert.equal(reason, undefined, `Football should not match food/study, got ${reason}`);
});

test("a two-letter interest is not matched by substring", () => {
  // "AI" is a real onboarding chip. It must not be satisfied by any word that
  // merely contains those letters.
  const reason = interestReason(makeViewer({ interests: ["AI"] }), makePost({ topics: ["travel", "hiking"] }));
  assert.equal(reason, undefined, `AI should not match travel/hiking, got ${reason}`);
});

test("the reason quotes the viewer's own wording, not the topic keyword", () => {
  const reason = interestReason(makeViewer({ interests: ["Street food"] }), makePost({ topics: ["food"] }));
  assert.ok(reason.includes("Street food"), reason);
  assert.equal(
    reason.includes("Matches your food interest"),
    false,
    "the raw enrichment keyword leaked into the student-facing sentence",
  );
});

test("a concern matches its topic using the same token rules", () => {
  const viewer = makeViewer({ concerns: ["Speaking up in class"] });
  const post = makePost({ topics: ["class"] });
  const reason = scorePost(post, viewer, NOW).reasons.find((entry) => entry.startsWith("About something you flagged"));
  assert.ok(reason, "expected a concern reason, since the post is about class participation");
  assert.ok(reason.includes("Speaking up in class"), reason);
});

/* ----------------------- university label normalisation -------------------- */

/*
 * The same campus is stored three ways across the corpus: seeded posts carry the
 * short code, posts written by the app carried whatever the campus registry
 * returned (lower case), and the reason is read by a person. These pin the single
 * spelling, because the mismatch was visible in a real feed as both
 * "Students at nus" and "Students at NUS" at the same time.
 */

test("a lower-case university id is shown as the short code students use", () => {
  const viewer = makeViewer({ hostUniversity: "nus" });
  const post = makePost({ universityId: "nus" });
  const reason = scorePost(post, viewer, NOW).reasons.find((entry) => entry.startsWith("Students at"));
  assert.ok(reason, "expected a university reason");
  assert.equal(reason, "Students at NUS", reason);
});

test("an already-canonical university id is unchanged", () => {
  const viewer = makeViewer({ hostUniversity: "NUS" });
  const post = makePost({ universityId: "NUS" });
  const reason = scorePost(post, viewer, NOW).reasons.find((entry) => entry.startsWith("Students at"));
  assert.equal(reason, "Students at NUS", reason);
});

test("the two spellings match each other and produce one reason, not two", () => {
  const viewer = makeViewer({ hostUniversity: "fpt" });
  const reason = scorePost(makePost({ universityId: "FPT" }), viewer, NOW).reasons.filter((entry) =>
    entry.startsWith("Students at"),
  );
  assert.equal(reason.length, 1, JSON.stringify(reason));
  assert.equal(reason[0], "Students at FPT");
});

test("an unknown university stays visible rather than being dropped", () => {
  const viewer = makeViewer({ hostUniversity: "Somewhere Else" });
  const post = makePost({ universityId: "Somewhere Else" });
  const reason = scorePost(post, viewer, NOW).reasons.find((entry) => entry.startsWith("Students at"));
  assert.ok(reason, "an unknown university must still explain itself");
  assert.ok(reason.includes("SOMEWHERE ELSE"), reason);
});
