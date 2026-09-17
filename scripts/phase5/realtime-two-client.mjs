/**
 * Phase 5.1 — two-client Realtime propagation proof.
 *
 * WHY THIS IS NOT A UNIT TEST
 *
 * Phase 5 proved that Realtime "does not break": the socket connects, no error is
 * logged, the console stays clean. That is not the same claim as "A posts and B
 * sees it". A subscription can connect, be subscribed to the wrong channel, and
 * receive nothing — and every assertion in Phase 5 would still pass.
 *
 * So this script stands up TWO REAL BROWSER SESSIONS with two real authenticated
 * accounts, acts in one, and measures how long the other takes to show the
 * result. Nothing is faked in local state, and nothing is inferred from a
 * network log: the assertion is on the rendered DOM of the *other* client.
 *
 * WHAT IS MEASURED
 *
 *   1. A publishes a text post   -> B's feed contains it, without a reload
 *   2. B reacts                  -> A's card reaction count moves
 *   3. B comments                -> A's card comment count moves
 *   4. A deletes their own post  -> B's card disappears
 *
 * HTTP stays the source of truth throughout: the post is also confirmed present
 * via a plain server query, so a passing run proves propagation *and* persistence
 * rather than a live-only illusion.
 *
 * Usage:
 *   node --env-file=.env.local scripts/phase5/realtime-two-client.mjs
 *   BASE_URL=http://127.0.0.1:5173 node --env-file=.env.local scripts/phase5/realtime-two-client.mjs
 */
import { chromium } from "@playwright/test";
import { Query } from "node-appwrite";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  adminClients,
  createProbeAccount,
  destroyProbeAccount,
  openCommunityClient,
  openFeed,
  waitForCard,
} from "../verify/lib/probe-session.mjs";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:5173";
const EVIDENCE = "docs/evidence/phase5-rc/realtime-two-client.json";

/** Propagation budget. Beyond this the feature is not demo-grade, whatever the log says. */
const PROPAGATION_BUDGET_MS = 15_000;
const POLL_MS = 250;

const admin = adminClients();
const { database, users, tables, storage, mediaBucket } = admin;

const steps = [];
function record(step, ok, detail) {
  steps.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
}

/*
 * One account per corridor, so the probe also exercises the two golden journeys
 * rather than two identical anonymous students.
 */
const JOURNEYS = {
  A: { name: "A", home: "VN", host: "SG", city: "Singapore", university: "NUS", interests: ["Food", "Coffee", "Photography"], concerns: ["Speaking up in class"], languages: [{ name: "Vietnamese", level: "Native" }, { name: "English", level: "B2" }] },
  B: { name: "B", home: "SG", host: "VN", city: "Ho Chi Minh City", university: "FPT", interests: ["Food", "Travel", "Music"], concerns: ["Vietnamese pronouns"], languages: [{ name: "English", level: "Native" }, { name: "Vietnamese", level: "A2" }] },
};

let browser = null;
let postId = null;
const created = [];

try {
  for (const [label, journey] of Object.entries(JOURNEYS)) {
    created.push(await createProbeAccount({ users, tables, database, endpoint: process.env.VITE_APPWRITE_ENDPOINT, project: process.env.VITE_APPWRITE_PROJECT_ID }, label, journey));
  }
  record("two real authenticated accounts created", true, created.map((entry) => `${entry.label}:${entry.userId.slice(0, 8)}…`).join(" "));

  browser = await chromium.launch();
  const clientA = await openCommunityClient(browser, created[0], BASE_URL);
  const clientB = await openCommunityClient(browser, created[1], BASE_URL);
  record("both clients reached the community feed", true, `${created[0].label} and ${created[1].label} on ${BASE_URL}`);

  /*
   * Both clients move to Latest before anything is published.
   *
   * This probe measures whether a Realtime event arrives, and For You is the wrong
   * surface to measure it on: it is *personalised*, so whether a given post appears
   * is a ranking decision, not a propagation one. A is VN→SG and B is SG→VN, so
   * A's Singapore post can legitimately sit outside B's first page — and then a
   * working subscription reports as "never arrived". Latest is chronological and
   * deterministic, which isolates the event from the ranker. Personalisation is
   * covered by corridor-evidence.mjs instead.
   */
  let switched = 0;
  for (const client of [clientA, clientB]) {
    const chip = client.page.getByRole("button", { name: "Latest", exact: true }).first();
    await chip.scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(() => {});
    await chip.click({ timeout: 15_000 }).catch(() => {});
    /*
     * Let the re-query finish before touching anything else on the page.
     *
     * Switching mode clears the list and renders a skeleton, so the feed's height
     * changes while the request is in flight. Interacting during that window makes
     * Playwright wait for layout stability that never arrives and time out with a
     * call log that blames the button.
     */
    await client.page.waitForFunction(() => document.querySelectorAll('[data-testid="post-card"]').length > 0, { timeout: 30_000 }).catch(() => {});
    await client.page.waitForTimeout(800);

    /*
     * Confirm the mode actually changed. Without this the check below would pass
     * on a tap that silently missed, and the probe would then measure propagation
     * against a personalised feed — the exact confusion this switch exists to
     * remove.
     */
    const active = await chip.getAttribute("aria-pressed").catch(() => null);
    if (active === "true") switched += 1;
  }
  record(
    "both clients switched to the chronological feed",
    switched === 2,
    switched === 2 ? "Latest — propagation is measured independently of ranking" : `only ${switched}/2 chips reported the active state`,
  );

  /* ---------------------------- 1. A publishes ---------------------------- */

  const body = `Phase 5.1 realtime probe ${Date.now()}`;

  /*
   * `exact: true` is load-bearing. Playwright's role-name matching is a
   * case-insensitive *substring* match by default, and the feed is full of
   * buttons whose accessible name contains "post" — "React to this post",
   * "Save this post", "Translate this post". Without `exact`, `.first()` clicks
   * whichever of those appears first in the DOM and the probe measures nothing.
   */
  const postButton = (page) => page.getByRole("button", { name: "Post", exact: true });

  // Publish through A's real composer — not a direct API call. The point is that
  // the ordinary student path produces the event B receives.
  await postButton(clientA.page).first().click();
  await clientA.page.getByLabel("Post text").waitFor({ state: "visible", timeout: 15_000 });
  await clientA.page.getByLabel("Post text").fill(body);
  const publishStarted = Date.now();
  await postButton(clientA.page).first().click();

  const appearedForA = await waitForCard(clientA.page, body, PROPAGATION_BUDGET_MS);
  record(
    "A sees their own post immediately after publishing",
    appearedForA !== null,
    appearedForA === null ? "not rendered within budget" : `${appearedForA} ms`,
  );

  const appearedForB = await waitForCard(clientB.page, body, PROPAGATION_BUDGET_MS);
  const bLatency = appearedForB === null ? null : Date.now() - publishStarted;
  record(
    "B receives A's post over Realtime without reloading",
    appearedForB !== null,
    bLatency === null ? "never arrived" : `${bLatency} ms from A's publish`,
  );

  postId = await tables
    .listRows({ databaseId: database, tableId: "community_posts", queries: [Query.equal("body", body), Query.limit(1)] })
    .then((page) => page.rows[0]?.post_id ?? null)
    .catch(() => null);
  record("the post is really persisted on the server", Boolean(postId), postId ? `post_id ${postId.slice(0, 12)}…` : "not found via HTTP");

  /* ------------------- 2 & 3. B reacts, B comments ----------------------- */

  if (postId) {
    /*
     * Re-resolve the card and scroll it into view before every interaction.
     *
     * A realtime event reloads the feed, and the reload re-ranks it — so the card
     * that was at the top a second ago can move, and a locator captured earlier
     * resolves to a node Playwright then waits on forever because it is off
     * screen. `.first()` on a `:has-text` match also re-resolves on each use, so
     * holding the locator is fine; what was missing was bringing it into view.
     */
    const cardForB = () =>
      clientB.page.locator(`[data-testid="post-card"]:has-text("${body}")`).first();

    const beforeReactions = await readCount(clientA.page, body, "reaction");
    const reactStarted = Date.now();
    await cardForB().scrollIntoViewIfNeeded({ timeout: 15_000 });
    await cardForB().getByLabel(/React to this post|Remove reaction/).first().click();

    /*
     * Confirm the write actually landed before blaming propagation.
     *
     * Without this the two failures are indistinguishable: a click that never
     * fired and an event that never arrived both present as "the count did not
     * move", and only one of them is a Realtime problem.
     *
     * Polled rather than read once. The tap returns as soon as React has painted
     * the optimistic state, while the row is still in flight — so a single read
     * here reports "no row written" for a write that is merely 200 ms behind.
     */
    let reactionRow = null;
    const rowDeadline = Date.now() + 10_000;
    while (Date.now() < rowDeadline) {
      reactionRow = await tables
        .listRows({
          databaseId: database,
          tableId: "post_reactions",
          queries: [Query.equal("post_id", postId), Query.limit(1)],
        })
        .then((page) => page.rows[0] ?? null)
        .catch(() => null);
      if (reactionRow) break;
      await clientB.page.waitForTimeout(250);
    }
    record(
      "B's reaction really reached the server",
      Boolean(reactionRow),
      reactionRow ? `reaction row for ${postId.slice(0, 10)}…` : "no reaction row was written",
    );

    const reactionsMoved = await waitForCount(clientA.page, body, "reaction", beforeReactions);
    record(
      "A's reaction count updates from B's reaction",
      reactionsMoved !== null,
      reactionsMoved === null ? `stayed at ${beforeReactions}` : `${beforeReactions} -> ${reactionsMoved} in ${Date.now() - reactStarted} ms`,
    );

    const beforeComments = await readCount(clientA.page, body, "comment");
    await cardForB().getByLabel("View comments").first().click();
    /*
     * `getByLabel`, not `getByPlaceholder`.
     *
     * The field carries both, but the placeholder ends in a real ellipsis
     * character — and a locator that depends on an exact typographic mark is a
     * locator that breaks the first time somebody retypes the string. The
     * accessible name is the stable handle, and it is what the QA suite already
     * uses successfully.
     */
    const commentField = clientB.page.getByLabel("Add a comment").first();
    await commentField.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    if ((await commentField.count()) > 0) {
      const commentText = `Good luck with the demo! ${Date.now()}`;
      await commentField.fill(commentText);
      const commentStarted = Date.now();
      await clientB.page.getByLabel("Send comment").first().click();

      /*
       * Establish that the write landed before judging propagation, exactly as
       * the reaction check does. "B's comment never posted" and "B's comment
       * posted but A never heard" are different defects with different owners,
       * and a single "the count did not move" cannot tell them apart.
       */
      const commentLanded = await clientB.page
        .waitForFunction((needle) => document.body.textContent?.includes(needle), commentText, { timeout: 15_000 })
        .then(() => true)
        .catch(() => false);

      const commentRow = await tables
        .listRows({
          databaseId: database,
          tableId: "post_comments",
          queries: [Query.equal("post_id", postId), Query.limit(1)],
        })
        .then((page) => page.rows[0] ?? null)
        .catch(() => null);
      record(
        "B's comment really reached the server",
        commentLanded && Boolean(commentRow),
        commentRow ? `comment row for ${postId.slice(0, 10)}…` : commentLanded ? "rendered locally but no row written" : "comment never rendered for B",
      );

      const commentsMoved = await waitForCount(clientA.page, body, "comment", beforeComments);
      record(
        "A's comment count updates from B's comment",
        commentsMoved !== null,
        commentsMoved === null ? `stayed at ${beforeComments}` : `${beforeComments} -> ${commentsMoved} in ${Date.now() - commentStarted} ms`,
      );
    } else {
      record("A's comment count updates from B's comment", false, "comment field not found — hook changed");
    }
  }

  /* --------------------------- 4. A deletes ------------------------------ */

  if (postId) {
    await clientA.page.reload({ waitUntil: "domcontentloaded" });
    /*
     * Re-entering Connect is mandatory, not a convenience: the selected tab lives
     * in React memory, so a reload drops the app back on Today and the feed the
     * rest of this block needs does not exist until it is opened again.
     */
    await openFeed(clientA.page);
    const own = clientA.page.locator(`[data-testid="post-card"]:has-text("${body}")`).first();
    await own.waitFor({ state: "attached", timeout: 30_000 });
    await own.scrollIntoViewIfNeeded({ timeout: 15_000 });
    /*
     * Open the post through its caption button rather than the card centre. The
     * card is a stack of independent controls, so a centre click lands on whatever
     * is tallest — usually the media — and does nothing at all.
     */
    await own.getByTestId("open-post").click();

    /*
     * Delete lives behind the post's options sheet, not on the detail screen.
     * Clicking for it directly finds nothing and the probe reports "hook changed"
     * for what is really a navigation step it skipped.
     */
    const options = clientA.page.getByLabel("Post options").first();
    await options.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    if ((await options.count()) > 0) await options.click();

    const deleteButton = clientA.page.getByRole("button", { name: "Delete your post" }).first();
    await deleteButton.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    if ((await deleteButton.count()) > 0) {
      const deletedAt = Date.now();
      await deleteButton.click();
      const stillThereForB = await waitForCard(clientB.page, body, 6000);
      record(
        "A deletes their own post and it disappears for B",
        stillThereForB === null,
        stillThereForB === null ? `${Date.now() - deletedAt} ms` : "still rendered after 6 s",
      );
    } else {
      record("A deletes their own post and it disappears for B", false, "delete control not found on the post detail — hook changed");
    }
  }

  const fatalErrors = [...clientA.errors, ...clientB.errors];
  record("no uncaught page errors in either client", fatalErrors.length === 0, fatalErrors.slice(0, 3).join(" | ") || "clean");

  const evidence = {
    generated_at: new Date().toISOString(),
    base_url: BASE_URL,
    propagation_budget_ms: PROPAGATION_BUDGET_MS,
    accounts: created.map((entry) => ({
      label: entry.label,
      user_id: entry.userId,
      corridor: `${entry.journey.home}->${entry.journey.host}`,
      university: entry.journey.university,
    })),
    post_id: postId,
    steps,
    passed: steps.every((step) => step.ok),
  };
  mkdirSync("docs/evidence/phase5-rc", { recursive: true });
  writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2));
  console.log(`\nevidence -> ${EVIDENCE}`);
  console.log(evidence.passed ? "\nREALTIME: PROVEN" : "\nREALTIME: NOT PROVEN");
  process.exitCode = evidence.passed ? 0 : 1;
} catch (error) {
  console.error("\nharness error:", error.message);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  // Remove the probe post and accounts so a re-run starts from a clean corpus.
  if (postId) await tables.deleteRow({ databaseId: database, tableId: "community_posts", rowId: postId }).catch(() => {});
  for (const account of created) await destroyProbeAccount(admin, account);
}

/* ------------------------------- helpers -------------------------------- */

/** Read a card's rendered reaction or comment count. */
function readCount(page, body, kind) {
  return page.evaluate(
    ({ source, which }) => {
      const card = [...document.querySelectorAll('[data-testid="post-card"]')].find((node) => node.textContent?.includes(source));
      if (!card) return null;
      /*
       * Both controls render their count as their own text — the icon contributes
       * none — so the button itself is the correct scope. Reading the parent
       * instead walked up to the whole actions row, which holds the reaction,
       * comment and save counts together and only happened to return the right
       * number because reaction is first.
       */
      const selector = which === "reaction" ? '[aria-label="React to this post"], [aria-label="Remove reaction"]' : '[aria-label="View comments"]';
      const control = card.querySelector(selector);
      if (!control) return null;
      const digits = control.textContent?.match(/\d+/);
      return digits ? Number(digits[0]) : 0;
    },
    { source: body, which: kind },
  );
}

/** Wait for a card's count to differ from `before`. Returns the new value, or null. */
async function waitForCount(page, body, kind, before, timeout = PROPAGATION_BUDGET_MS) {
  const deadline = Date.now() + timeout;
  let cardSeen = false;
  let lastSeen = null;
  while (Date.now() < deadline) {
    const current = await readCount(page, body, kind);
    if (current !== null) {
      cardSeen = true;
      lastSeen = current;
    }
    if (current !== null && current !== before) return current;
    await page.waitForTimeout(POLL_MS);
  }
  /*
   * The distinction matters when this fails: a card that was never on screen is a
   * feed problem (the post re-ranked out of the first page), whereas a card that
   * sat at the same number for fifteen seconds is a propagation problem. They
   * have different fixes and the bare "stayed at N" hid which one had happened.
   */
  if (!cardSeen) console.log(`      [diag] the card was never rendered for ${kind} on this client`);
  else console.log(`      [diag] the card stayed at ${lastSeen} for the whole ${timeout} ms budget`);
  return null;
}
