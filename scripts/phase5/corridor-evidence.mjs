/**
 * Phase 5.1 — corridor and recommendation evidence.
 *
 * THE CLAIM THIS TESTS
 *
 * "Changing your journey must not only change a flag." The product promises that
 * a student going VN -> SG/NUS and a student going SG -> VN/FPT see materially
 * different communities, and that the For You feed explains itself in sentences
 * the student can audit.
 *
 * Both halves are asserted here against the running app, not against the ranker
 * in isolation:
 *
 *   - the same corpus is served to two real accounts whose journeys differ only
 *     in direction, and the resulting feeds are compared
 *   - the reasons are read out of the DOM, so a ranker that ranks correctly but
 *     stops explaining itself fails this test
 *
 * A ranker unit test cannot catch either failure: it is handed posts that already
 * have the right shape, and it never renders anything.
 *
 * Usage:
 *   node --env-file=.env.local scripts/phase5/corridor-evidence.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  adminClients,
  createProbeAccount,
  destroyProbeAccount,
  openCommunityClient,
  readFeedCards,
} from "../verify/lib/probe-session.mjs";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:5173";
const OUT_DIR = "docs/evidence/phase5-rc";

const admin = adminClients();
const { database, users, tables, endpoint, project, storage, mediaBucket } = admin;

const CORRIDORS = [
  {
    key: "vn-sg",
    label: "VN → SG / NUS",
    journey: {
      name: "Corridor VN",
      home: "VN",
      host: "SG",
      city: "Singapore",
      university: "NUS",
      /*
       * Pre-departure on purpose: it is the demo narrative and the only stage at
       * which the ranker's preparation branch ("Worth reading before your first
       * week") can fire. A mid-exchange probe would pass this test while never
       * exercising the reason the product is built around.
       */
      stage: "before_departure",
      interests: ["Food", "Coffee", "Photography"],
      concerns: ["Speaking up in class", "Understanding local English"],
      languages: [{ name: "Vietnamese", level: "Native" }, { name: "English", level: "B2" }],
    },
    /** What must appear for this corridor to be believable, and what must not. */
    expectReasons: [/Singapore|NUS|first week|interest|language|place you saved|Near your campus/i],
  },
  {
    key: "sg-vn",
    label: "SG → VN / FPT HCMC",
    journey: {
      name: "Corridor SG",
      home: "SG",
      host: "VN",
      city: "Ho Chi Minh City",
      university: "FPT",
      stage: "before_departure",
      interests: ["Food", "Travel", "Music"],
      concerns: ["Vietnamese pronouns", "Slang and fast speech"],
      languages: [{ name: "English", level: "Native" }, { name: "Vietnamese", level: "A2" }],
    },
    expectReasons: [/Vietnam|FPT|first week|interest|language|place you saved|Near your campus/i],
  },
];

const results = [];
const created = [];
let browser = null;

try {
  browser = await chromium.launch();

  for (const corridor of CORRIDORS) {
    const account = await createProbeAccount({ users, tables, database, endpoint, project }, corridor.key, corridor.journey);
    created.push(account);

    const client = await openCommunityClient(browser, account, BASE_URL);
    // For You is the default mode, but make it explicit: the evidence must not
    // depend on a default staying the default.
    await client.page.getByRole("button", { name: "For You" }).first().click().catch(() => {});
    await client.page.waitForTimeout(3500);

    const cards = await readFeedCards(client.page, 10);
    const withReasons = cards.filter((card) => card.reasons.length > 0);
    const allReasons = cards.flatMap((card) => card.reasons);
    const matchedExpectation = allReasons.some((reason) => corridor.expectReasons.some((pattern) => pattern.test(reason)));

    const evidence = {
      generated_at: new Date().toISOString(),
      corridor: corridor.label,
      account: { user_id: account.userId, home: corridor.journey.home, host: corridor.journey.host, university: corridor.journey.university, interests: corridor.journey.interests, concerns: corridor.journey.concerns },
      cards_returned: cards.length,
      cards_with_reasons: withReasons.length,
      distinct_reasons: [...new Set(allReasons)],
      matched_corridor_expectation: matchedExpectation,
      sample: cards.slice(0, 6).map((card) => ({ demo: card.demo, has_place: card.place, reasons: card.reasons, excerpt: card.text.slice(0, 180) })),
    };

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(`${OUT_DIR}/corridor-${corridor.key}.json`, JSON.stringify(evidence, null, 2));
    console.log(`\n=== ${corridor.label} ===`);
    console.log(`cards: ${cards.length}, with reasons: ${withReasons.length}`);
    console.log(`reasons: ${evidence.distinct_reasons.slice(0, 8).join(" | ") || "(none)"}`);
    for (const card of evidence.sample.slice(0, 3)) {
      console.log(`  - [${card.reasons.join(" / ") || "no reasons"}] ${card.excerpt.slice(0, 90).replace(/\s+/g, " ")}`);
    }

    results.push({ corridor, cards, evidence, matchedExpectation });
    await client.context.close();
  }

  /* ---------------------- material difference check ---------------------- */

  /*
   * "Materially different" is judged on the text of the cards, not on a reason
   * count: two corridors that both return the SG/NUS corpus would be the failure
   * this is looking for, and that failure is invisible to a count.
   */
  const [first, second] = results;
  const idsOf = (cards) => cards.map((card) => card.text.slice(0, 120));
  const setA = new Set(idsOf(first.cards));
  const overlap = idsOf(second.cards).filter((entry) => setA.has(entry));
  const unionSize = new Set([...idsOf(first.cards), ...idsOf(second.cards)]).size;
  const overlapRatio = unionSize === 0 ? 1 : overlap.length / unionSize;

  const summary = {
    generated_at: new Date().toISOString(),
    corridors: results.map((entry) => entry.corridor.label),
    cards_per_corridor: results.map((entry) => entry.cards.length),
    distinct_reasons_per_corridor: results.map((entry) => entry.evidence.distinct_reasons.length),
    reasons_displayed_for_both: results.every((entry) => entry.evidence.cards_with_reasons > 0),
    corridor_expectation_matched: results.map((entry) => entry.matchedExpectation),
    feed_overlap_ratio: Number(overlapRatio.toFixed(3)),
    feeds_materially_different: overlapRatio < 0.8,
    recommendation_engine: "deterministic scoring (src/lib/phase5/feed-ranking.ts) — no trained model, no per-scroll model call",
    weights: "host country, university, exchange stage, interest/concern overlap, followed author, saved place, campus proximity, engagement, recency decay, author/topic diversity",
  };

  writeFileSync(`${OUT_DIR}/recommendation.json`, JSON.stringify(summary, null, 2));
  console.log("\n=== recommendation summary ===");
  console.log(JSON.stringify(summary, null, 2));

  const passed = summary.reasons_displayed_for_both && summary.feeds_materially_different && summary.corridor_expectation_matched.every(Boolean);
  console.log(passed ? "\nCORRIDORS: PROVEN" : "\nCORRIDORS: NOT PROVEN");
  process.exitCode = passed ? 0 : 1;
} catch (error) {
  console.error("\nharness error:", error.message);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  for (const account of created) await destroyProbeAccount(admin, account);
}
