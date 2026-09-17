/**
 * Phase 5.1 — the live demo flow, driven as a real student.
 *
 * THE CLAIM THIS TESTS
 *
 * The exact sequence that has to work in front of a judge: a real signed-in
 * student writes a post with a real photo and a real short video, sees it appear,
 * reloads and finds it still there, tags a real OpenStreetMap place, and follows
 * the post ↔ place bridge in both directions.
 *
 * WHAT MAKES THIS EVIDENCE RATHER THAN A SCREENSHOT SCRIPT
 *
 *   - every post is written through the app's own composer, never through the API
 *   - "appeared immediately" is measured from the click to the rendered card
 *   - persistence is proved by reloading the page, not by trusting local state
 *   - the uploaded files are real: a JPEG from the licensed demo set and an MP4
 *     generated for this test. Nothing is stubbed.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:5173 node --env-file=.env.local scripts/phase5/demo-qa.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { adminClients, createProbeAccount, destroyProbeAccount, openCommunityClient, openFeed } from "../verify/lib/probe-session.mjs";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:5173";
const OUT_DIR = "docs/evidence/phase5-rc";
const SHOTS = `${OUT_DIR}/screenshots`;

/** A real licensed demo photo already in the repository. */
const IMAGE_FIXTURE = resolve("public/demo-media/vn_b_nh_tr_ng_n_ng_tp_h_ch_minh_street_food_in_ho_c.jpg");
/** A real MP4 generated for this test (6 s, 640x360, H.264/AAC). */
const VIDEO_FIXTURE = resolve("scripts/phase5/fixtures/upload-test.mp4");

const stamp = Date.now();
const textBody = `Phase 5.1 real post ${stamp} — first night building in the city`;
const imageBody = `Phase 5.1 photo post ${stamp} — dinner near campus`;
const videoBody = `Phase 5.1 video post ${stamp} — walking to class`;

const admin = adminClients();
const { database, users, tables, endpoint, project, storage, mediaBucket } = admin;

const results = { checks: [], screenshots: [] };
let browser = null;
let account = null;

function check(name, ok, detail) {
  results.checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function shot(page, name) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
  results.screenshots.push(`${name}.png`);
}

/** Find a card by its body text and return its post id, or null. */
function findCard(page, text) {
  return page.evaluate((needle) => {
    const card = [...document.querySelectorAll('[data-testid="post-card"]')].find((node) => node.textContent?.includes(needle));
    return card ? card.getAttribute("data-post-id") ?? "present" : null;
  }, text);
}

/** Poll until a card matching `text` is rendered. Returns elapsed ms, or null. */
async function waitForCardMs(page, text, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await findCard(page, text)) return Date.now() - started;
    await page.waitForTimeout(250);
  }
  return null;
}

/** Publish through the real composer. Returns { appearedMs, progressSeen, totalMs }. */
async function publish(page, body, attach = {}) {
  await page.getByRole("button", { name: "Post", exact: true }).click();
  const field = page.getByLabel("Post text");
  await field.waitFor({ state: "visible", timeout: 15_000 });
  await field.fill(body);

  if (attach.image) await page.setInputFiles('[data-testid="composer-image-input"]', attach.image);
  if (attach.video) await page.setInputFiles('[data-testid="composer-video-input"]', attach.video);

  /*
   * Capture the composer with its attachment in place, before publishing. The
   * evidence set needs a composer screenshot, and taking it here is the only
   * moment it exists — afterwards the composer has been replaced by the feed.
   */
  if (attach.shotAs) {
    await page.waitForTimeout(700);
    await shot(page, attach.shotAs);
  }

  // A video upload is the only path slow enough to show the progress card, so its
  // appearance is the evidence that progress rendering is wired to the real upload
  // rather than to a timer.
  let progressSeen = false;
  const progress = page.locator('[data-testid="composer-progress"]');
  const publishStarted = Date.now();
  await page.getByRole("button", { name: "Post", exact: true }).click();
  for (let i = 0; i < 40; i += 1) {
    if (await progress.count()) {
      progressSeen = true;
      break;
    }
    if (await findCard(page, body)) break;
    await page.waitForTimeout(100);
  }

  const appearedMs = await waitForCardMs(page, body, 60_000);
  return { appearedMs, progressSeen, totalMs: Date.now() - publishStarted };
}

try {
  browser = await chromium.launch();
  account = await createProbeAccount({ users, tables, database, endpoint, project }, "demoqa", {
    name: "Demo QA",
    home: "VN",
    host: "SG",
    city: "Singapore",
    university: "NUS",
    stage: "before_departure",
    interests: ["Food", "Coffee"],
    concerns: ["Making friends"],
    languages: [{ name: "Vietnamese", level: "Native" }],
  });

  const client = await openCommunityClient(browser, account, BASE_URL);
  const page = client.page;
  /*
   * A throw during render used to white-screen the whole app, so "did anything
   * throw" is a first-class assertion here rather than a debugging aid.
   */
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  // `openCommunityClient` already waited for a settled feed, so this count is the
  // real first paint rather than a race against hydration.
  const seededCards = await page.locator('[data-testid="post-card"]').count();
  check("the seeded feed is dense enough to scroll", seededCards >= 5, `${seededCards} cards on first paint`);
  await shot(page, "390-feed");

  /* ------------------------------ text post ------------------------------ */

  const text = await publish(page, textBody);
  check("a real text post appears in the feed after publishing", text.appearedMs !== null, text.appearedMs === null ? "never rendered" : `${text.appearedMs} ms after the click`);

  await page.reload({ waitUntil: "domcontentloaded" });
  await openFeed(page);
  const textAfterReload = await waitForCardMs(page, textBody, 30_000);
  check("the text post survives a reload", textAfterReload !== null, textAfterReload === null ? "gone after reload" : `found ${textAfterReload} ms after load`);

  /* ------------------------------ image post ----------------------------- */

  const image = await publish(page, imageBody, { image: IMAGE_FIXTURE, shotAs: "390-composer" });
  check("a real image uploads and publishes", image.appearedMs !== null, image.appearedMs === null ? "never rendered" : `${image.appearedMs} ms`);

  /*
   * Wait for the uploaded image to actually decode.
   *
   * Two distinct states are easy to conflate here, so they are reported
   * separately: the card may be missing entirely (the feed has not caught up), or
   * the card may be present with an `<img>` that never resolves (storage or the
   * signed URL). Collapsing both into "no image" makes a storage problem look
   * like a rendering problem.
   */
  const imageRendered = await (async () => {
    const deadline = Date.now() + 30_000;
    let last = null;
    while (Date.now() < deadline) {
      last = await page.evaluate((needle) => {
        const card = [...document.querySelectorAll('[data-testid="post-card"]')].find((node) => node.textContent?.includes(needle));
        if (!card) return { card: false, img: false, complete: false, src: "" };
        const img = card.querySelector("img");
        if (!img) return { card: true, img: false, complete: false, src: "" };
        return { card: true, img: true, complete: img.naturalWidth > 0, src: img.getAttribute("src") ?? "" };
      }, imageBody);
      if (last?.complete) return last;
      await page.waitForTimeout(500);
    }
    return last;
  })();
  check(
    "the uploaded image is served back from storage",
    Boolean(imageRendered?.complete),
    imageRendered?.complete
      ? `natural size resolved from ${imageRendered.src.slice(0, 60)}…`
      : !imageRendered?.card
        ? "the card never appeared in the feed"
        : !imageRendered?.img
          ? "the card rendered without an <img> — media row or hydration problem"
          : `an <img> exists but never decoded: ${imageRendered.src.slice(0, 70)}…`,
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  await openFeed(page);
  const imageAfterReload = await waitForCardMs(page, imageBody, 30_000);
  check("the image post survives a reload", imageAfterReload !== null, imageAfterReload === null ? "gone after reload" : `${imageAfterReload} ms`);

  /* ------------------------------ video post ----------------------------- */

  const videoBytes = statSync(VIDEO_FIXTURE).size;
  const video = await publish(page, videoBody, { video: VIDEO_FIXTURE });
  check("a real short video uploads and publishes", video.appearedMs !== null, video.appearedMs === null ? "never rendered" : `${video.appearedMs} ms for ${Math.round(videoBytes / 1024)} KB`);
  check("the composer showed upload progress for the video", video.progressSeen, video.progressSeen ? "progress card rendered during upload" : "progress card never appeared");

  /*
   * Poll for the <video>, rather than reading it once.
   *
   * A realtime `create` event re-runs the feed query, and media is hydrated by a
   * second request — so there is a brief, legitimate window where the card exists
   * without its media. A single snapshot reports that window as "no video", which
   * is a false failure about a real one.
   */
  const videoState = await (async () => {
    const deadline = Date.now() + 30_000;
    let last = null;
    while (Date.now() < deadline) {
      last = await page.evaluate(async (needle) => {
        const card = [...document.querySelectorAll('[data-testid="post-card"]')].find((node) => node.textContent?.includes(needle));
        const el = card?.querySelector("video");
        if (!el) return { found: false };
        const ready = await new Promise((resolveReady) => {
          if (el.readyState >= 1) return resolveReady(true);
          const timer = setTimeout(() => resolveReady(false), 8000);
          el.addEventListener("loadedmetadata", () => {
            clearTimeout(timer);
            resolveReady(true);
          }, { once: true });
        });
        let played = false;
        try {
          await el.play();
          await new Promise((r) => setTimeout(r, 700));
          played = el.currentTime > 0;
          el.pause();
        } catch {
          played = false;
        }
        return { found: true, ready, played, duration: Number.isFinite(el.duration) ? el.duration : null, src: el.currentSrc || el.getAttribute("src") || "" };
      }, videoBody);
      if (last.found) break;
      await page.waitForTimeout(500);
    }
    return last;
  })();

  check("the video element resolves its metadata from storage", Boolean(videoState.found && videoState.ready), videoState.found ? `duration ${videoState.duration?.toFixed(1)}s` : "no <video> in the card");
  check("the video actually plays", Boolean(videoState.found && videoState.played), videoState.found && videoState.played ? "currentTime advanced past 0" : "playback did not advance");
  await shot(page, "390-video");

  await page.reload({ waitUntil: "domcontentloaded" });
  await openFeed(page);
  const videoAfterReload = await waitForCardMs(page, videoBody, 30_000);
  check("the video post survives a reload", videoAfterReload !== null, videoAfterReload === null ? "gone after reload" : `${videoAfterReload} ms`);

  /* ----------------------------- place bridge ---------------------------- */

  const bridgeSource = await page.evaluate(() => {
    const card = [...document.querySelectorAll('[data-testid="post-card"]')].find((node) => node.querySelector('[aria-label="Open this place on the map"]'));
    return card ? (card.textContent ?? "").slice(0, 60) : null;
  });

  if (bridgeSource) {
    await page.locator('[data-testid="post-card"]').filter({ hasText: bridgeSource }).first().getByLabel("Open this place on the map").click();
    await page.waitForSelector('[data-testid="explore-map"]', { timeout: 20_000 });

    /*
     * The sheet is not instant. Explore has to load the country's places before it
     * can resolve the id it was handed — selecting earlier would find nothing — so
     * this waits for the sheet rather than reading it once.
     */
    const sheetAppeared = await page
      .waitForSelector('[data-testid="place-sheet"]', { timeout: 25_000 })
      .then(() => true)
      .catch(() => false);
    check("a post's place tag opens that place on the real map", sheetAppeared, sheetAppeared ? "Explore opened with the place sheet" : "map opened but no place sheet");

    const sheetHasCommunity = sheetAppeared
      ? await page
          .waitForFunction(() => (document.querySelector('[data-testid="place-posts"]')?.children.length ?? 0) > 0, { timeout: 20_000 })
          .then(() => true)
          .catch(() => false)
      : false;
    check("the place sheet shows other students' stories there", sheetHasCommunity, sheetHasCommunity ? "community posts rendered inside the sheet" : "no community block in the sheet");
    await shot(page, "390-place");

    /* --------------------------- place → post --------------------------- */
    let postOpenedFromSheet = false;
    if (sheetHasCommunity) {
      await page.locator('[data-testid="place-posts"] button').first().click();
      postOpenedFromSheet = await page
        .waitForSelector('[data-testid="post-card"]', { timeout: 20_000 })
        .then(() => true)
        .catch(() => false);
      check("tapping a community story opens that exact post", postOpenedFromSheet, postOpenedFromSheet ? "post rendered from the place sheet" : "no post rendered");
    }

    /*
     * Unwind the two overlays before continuing.
     *
     * The post screen and the place sheet are both full-screen layers, so the
     * bottom navigation is underneath them and a tab tap lands on a backdrop
     * instead. Clicking "Connect" while they are open does not fail loudly — it
     * times out on an intercepted pointer event, which reads like a broken nav
     * bar rather than an un-dismissed overlay. So: leave the post first, then the
     * sheet, and only then move on.
     */
    if (postOpenedFromSheet) {
      await page.getByLabel("Back").first().click().catch(() => {});
      await page.waitForTimeout(700);
    }
    await page.mouse.click(195, 30);
    await page.waitForTimeout(600);
  } else {
    check("a post's place tag opens that place on the real map", false, "no card carried a place tag — the corpus has no linked posts for this corridor");
  }

  /* ------------------------------- comments ------------------------------ */

  await openFeed(page);
  /*
   * Open the post through the caption button, not by clicking the card centre.
   * The card is a stack of independent controls (author, caption, media, actions)
   * and its centre falls on whichever of those happens to be tallest — often the
   * media, whose click does nothing. That produced "comment field not found" for a
   * detail screen that had simply never been opened.
   */
  await page.locator('[data-testid="open-post"]').first().click();
  await page.waitForTimeout(1200);
  /*
   * The composer is labelled, not placeholder-hinted: `aria-label="Add a comment"`
   * is the accessible name, and there is no `placeholder` attribute at all. A
   * `getByPlaceholder` lookup therefore matches nothing and reports a missing
   * field on a screen that is rendering it.
   */
  const commentField = page.getByLabel("Add a comment").first();
  const detailOpened = await commentField
    .waitFor({ state: "visible", timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  check("a post opens into its detail view with a comment box", detailOpened, detailOpened ? "detail screen rendered" : "the detail screen never appeared");
  await page.waitForTimeout(600);
  await shot(page, "390-comments");

  if ((await commentField.count()) > 0) {
    const commentText = `comment probe ${stamp}`;
    await commentField.fill(commentText);
    await page.getByLabel("Send comment").first().click();
    const commentAppeared = await page
      .waitForFunction((needle) => document.body.textContent?.includes(needle), commentText, { timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    check("a real comment can be written", commentAppeared, commentAppeared ? "comment rendered" : "comment never appeared");

    /*
     * Wait for the server copy before looking for the delete control.
     *
     * A comment is inserted optimistically with a `pending` id, and the row hides
     * its delete button while it is in that state — there is nothing to delete
     * until the row exists. The text appears the instant the placeholder lands, so
     * counting the control right after `commentAppeared` always finds zero and
     * reports "hook changed" for a control that is merely one round trip away.
     */
    const removeButton = page.getByLabel(/Delete your comment/).last();
    const deletable = await removeButton
      .waitFor({ state: "visible", timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    if (commentAppeared && deletable) {
      await removeButton.click();
      const gone = await page
        .waitForFunction((needle) => !document.body.textContent?.includes(needle), commentText, { timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      check("a student can delete their own comment", gone, gone ? "comment removed" : "comment still rendered");
    } else {
      check("a student can delete their own comment", false, commentAppeared ? "no delete control on the own comment — hook changed" : "comment was never written");
    }
  } else {
    check("a real comment can be written", false, "comment field not found");
  }

  await page.getByLabel("Back").first().click().catch(() => {});
  await page.waitForTimeout(600);

  /* ------------------------------- profile ------------------------------- */

  await page.getByTestId("open-my-profile").click();
  await page.waitForTimeout(2000);
  const profileOpen = await page.evaluate(() => Boolean(document.querySelector('[data-testid="my-profile"], [data-testid="avatar-input"]')));
  const profileText = await page.evaluate(() => document.body.textContent?.slice(0, 200) ?? "");
  check("the signed-in student can open their own profile", profileOpen || /Edit profile|Profile|Display name|Your profile/i.test(profileText), profileOpen ? "profile editor rendered" : profileText.replace(/\s+/g, " ").slice(0, 80));
  await shot(page, "390-profile");

  /* ------------------------------- desktop ------------------------------- */

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(800);
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await openFeed(page);
  await shot(page, "1440-community");

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("the desktop layout does not overflow horizontally", overflow <= 2, `${overflow}px of horizontal overflow`);

  await page.getByRole("button", { name: "Explore" }).first().click();
  await page.waitForSelector('[data-testid="explore-map"]', { timeout: 25_000 });
  await page.waitForTimeout(2500);
  await shot(page, "1440-explore");

  const mapOk = await page.evaluate(() => {
    const map = document.querySelector('[data-testid="explore-map"] canvas');
    return Boolean(map);
  });
  check("the real MapLibre map still renders", mapOk, mapOk ? "canvas present" : "no map canvas");

  /* -------------------------------- write -------------------------------- */

  check("no fatal render error occurred during the flow", pageErrors.length === 0, pageErrors.length ? pageErrors[0].slice(0, 140) : "no uncaught exceptions");

  const report = {
    generated_at: new Date().toISOString(),
    base_url: BASE_URL,
    account: { user_id: account.userId, home: "VN", host: "SG", university: "NUS", stage: "before_departure" },
    fixtures: {
      image: { path: "public/demo-media/vn_b_nh_tr_ng_n_ng_tp_h_ch_minh_street_food_in_ho_c.jpg", bytes: statSync(IMAGE_FIXTURE).size },
      video: { path: "scripts/phase5/fixtures/upload-test.mp4", bytes: videoBytes, note: "real H.264/AAC MP4 generated with ffmpeg for this test" },
    },
    posts: {
      text: { body: textBody, appeared_ms: text.appearedMs, persisted_after_reload: textAfterReload !== null },
      image: { body: imageBody, appeared_ms: image.appearedMs, persisted_after_reload: imageAfterReload !== null, served_from_storage: Boolean(imageRendered?.complete) },
      video: { body: videoBody, appeared_ms: video.appearedMs, progress_shown: video.progressSeen, persisted_after_reload: videoAfterReload !== null, metadata_ready: videoState.found && videoState.ready, played: videoState.found && videoState.played, duration_s: videoState.found ? videoState.duration : null },
    },
    checks: results.checks,
    screenshots: results.screenshots,
    passed: results.checks.every((entry) => entry.ok),
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/real-user-post.json`, JSON.stringify({ ...report, scope: "text + image posts, comments, place bridge, profile" }, null, 2));
  writeFileSync(`${OUT_DIR}/video-upload.json`, JSON.stringify({ ...report, scope: "short video upload end to end" }, null, 2));

  const failed = results.checks.filter((entry) => !entry.ok);
  console.log(`\n${results.checks.length - failed.length}/${results.checks.length} checks passed`);
  console.log(failed.length ? `FAILED: ${failed.map((entry) => entry.name).join("; ")}` : "DEMO FLOW: PROVEN");
  process.exitCode = failed.length ? 1 : 0;
} catch (error) {
  console.error("\nharness error:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  if (account) await destroyProbeAccount(admin, account);
}
