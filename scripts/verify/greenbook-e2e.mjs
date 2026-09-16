/**
 * Greenbook end-to-end evidence.
 *
 * Drives the real application in a real browser against the real Appwrite
 * project and the real published corpus. Nothing is mocked: if the facts were
 * not published with a client-readable permission, or the RAG layer could not
 * reach them, this fails.
 *
 * Two lessons are baked into the structure below, both learned by getting them
 * wrong first:
 *   - every assertion WAITS for the condition rather than sleeping a guessed
 *     number of milliseconds. The Greenbook reads several tables in parallel and
 *     a fixed 1.5s wait was measuring the network, not the product.
 *   - navigation uses the app's own Back control, never `page.goBack()`, which
 *     walks the browser history out of the single-page app entirely.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { completeOnboarding, shellReached } from "./lib/onboarding.mjs";

const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 8443}`;
const OUT_DIR = "docs/evidence/phase4/ui";

const VIEWPORTS = [
  { name: "390x844", width: 390, height: 844 },
  { name: "430x932", width: 430, height: 932 },
  { name: "1440x900", width: 1440, height: 900 },
];

const results = [];
const shots = [];
/** Tail of the rendered answer, kept for diagnosing a citation failure. */
let answerTail = null;

function record(step, ok, detail) {
  results.push({ step, ok: Boolean(ok), detail: detail ?? null });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
}

/** Wait for text to appear, returning whether it did. Never throws. */
async function waitForText(page, pattern, timeout = 20_000) {
  try {
    await page.getByText(pattern).first().waitFor({ state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
}

/** Click the app's own Back control. */
async function appBack(page) {
  const back = page.getByRole("button", { name: "Back" }).first();
  if ((await back.count()) > 0) {
    await back.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(700);
  }
}

/**
 * Get to the five-tab shell, recovering from a stray external navigation.
 *
 * A test harness cannot complete a real OAuth flow, so if onboarding offers a
 * social sign-in and it gets clicked, the browser lands on Google's
 * `Error 401: invalid_client`. That is a harness accident, not a product
 * failure, so it is detected and undone rather than reported.
 */
async function bootToShell(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!page.url().startsWith(BASE_URL)) {
      await page.goto(BASE_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(2500);
    }
    if (await completeOnboarding(page)) return true;
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(3000);
  }
  return shellReached(page);
}

/** Reload and re-enter the Greenbook. Also proves the session survives a reload. */
async function reopenGreenbook(page) {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  // Longer than it looks like it needs to be, on purpose: the first navigation
  // after a dev-server restart is racing a cold module compile, and a short wait
  // there produces a flaky failure that looks like a product bug. Measured
  // 2026-09-16 — the same run passes 24/24 warm and failed twice cold.
  await page.waitForTimeout(5_000);
  if (!(await shellReached(page))) await bootToShell(page);
  const card = page.getByText("Living Greenbook", { exact: false }).first();
  await card.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
  await card.click({ timeout: 10_000 }).catch(() => {});
  return waitForText(page, "Your chapters", 30_000);
}

/**
 * Guarantee we are on the Greenbook home before the next step.
 *
 * Added after a measured flake: the corridor loop detours into Student Reality
 * and back, and one back-step occasionally left the overlay on a screen with no
 * chapter list, so the following chapter click silently did nothing and the test
 * reported a product failure for a navigation race in the test itself.
 */
async function ensureGreenbookHome(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await page.getByText("Your chapters", { exact: false }).first().isVisible().catch(() => false)) return true;
    await appBack(page);
    await page.waitForTimeout(700);
  }
  return reopenGreenbook(page);
}

/** Open the Greenbook's host-country switcher (the header control showing a flag). */
async function openCountrySwitcher(page) {
  return page.evaluate(() => {
    // Scope to the topmost overlay so the always-mounted tab shell underneath
    // cannot contribute a button. The overlay is what the student can see.
    const overlays = Array.from(document.querySelectorAll("div.absolute.inset-0.z-40"));
    const scope = overlays.length ? overlays[overlays.length - 1] : document;
    const buttons = Array.from(scope.querySelectorAll("button"));
    const target = buttons.find((button) => /[\u{1F1E6}-\u{1F1FF}]{2}/u.test(button.textContent || ""));
    if (!target) return { opened: false, candidates: buttons.slice(0, 8).map((button) => (button.textContent || "").trim().slice(0, 24)) };
    target.click();
    return { opened: true, label: (target.textContent || "").trim().slice(0, 24) };
  });
}

/**
 * Force the host country.
 *
 * Onboarding's walker picks whatever country it can click, and the choice is
 * persisted to the student's journey — so a second run can start in a country
 * with no corpus at all and every later assertion fails for the wrong reason.
 * Pinning the corridor makes the run deterministic and reproducible.
 *
 * The option is addressed by its test id, not by its label: the cover already
 * contains the string "National University of Singapore", so a text match
 * silently clicked the wrong element.
 */
async function selectHost(page, code) {
  const opened = await openCountrySwitcher(page);
  if (!opened.opened) return { ok: false, detail: `no flag control; buttons seen: ${(opened.candidates ?? []).join(" | ")}` };
  await page.waitForTimeout(1000);
  const option = page.locator(`[data-testid="country-option-${code}"]`).first();
  if ((await option.count()) === 0) return { ok: false, detail: `switcher opened via "${opened.label}" but no ${code} option` };
  await option.click({ timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(3000);
  return { ok: true, detail: `opened via "${opened.label}", picked ${code}` };
}

async function overflowOf(page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const pageErrors = [];
  const consoleErrors = [];

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text().slice(0, 200));
  });

  console.log(`Greenbook E2E against ${BASE_URL}\n`);

  // ---- 1. boot --------------------------------------------------------------
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  const onboarded = await bootToShell(page);
  record("onboarding reaches the five-tab shell", onboarded);
  if (!onboarded) {
    await page.screenshot({ path: `${OUT_DIR}/blocked-onboarding.png` });
    await browser.close();
    writeFileSync(`${OUT_DIR}/greenbook-e2e.json`, JSON.stringify({ results, pageErrors, consoleErrors }, null, 2));
    process.exitCode = 1;
    return;
  }
  await page.screenshot({ path: `${OUT_DIR}/today-390.png` });
  shots.push("today-390.png");

  // ---- 2. the Today card reports the real corpus size -----------------------
  const cardReady = await waitForText(page, /verified point|no verified official guidance/i, 25_000);
  const cardText = cardReady ? await page.getByText(/verified point|no verified official guidance/i).first().innerText().catch(() => "") : "";
  const corpusMatch = /(\d+)\s+verified point/.exec(cardText);
  record("Today card resolves to a real corpus count", cardReady, corpusMatch ? `${corpusMatch[1]} points` : cardText.replace(/\s+/g, " ").slice(0, 110));

  // ---- 3. open the Greenbook ------------------------------------------------
  await page.getByText("Living Greenbook", { exact: false }).first().click({ timeout: 10_000 }).catch(() => {});
  const coverVisible = await waitForText(page, "Your chapters", 20_000);
  record("Greenbook opens as an overlay", coverVisible);
  await page.screenshot({ path: `${OUT_DIR}/greenbook-open-390.png` });
  shots.push("greenbook-open-390.png");

  // Pin the demo corridor: Singapore has a real corpus, so every later check
  // measures the product rather than whichever country onboarding happened to pick.
  const pinned = await selectHost(page, "SG");
  record("host country can be switched in-app", pinned.ok, pinned.detail);
  await waitForText(page, /verified points|Nothing verified/i, 25_000);

  const bodyText = await page.locator("body").innerText();
  const hostMatch = /([A-Z][a-z]+) → ([A-Z][a-z]+)/.exec(bodyText);
  record("cover shows a home → host route", Boolean(hostMatch), hostMatch ? hostMatch[0] : "no route found");

  const pointsMatch = /(\d+)\s+verified points/.exec(bodyText);
  record("cover reports the verified corpus for the host country", Boolean(pointsMatch), pointsMatch ? pointsMatch[0] : "no count on the cover");

  await page.screenshot({ path: `${OUT_DIR}/greenbook-390.png` });
  shots.push("greenbook-390.png");

  const overflow390 = await overflowOf(page);
  record("no horizontal overflow at 390", overflow390.scrollWidth <= overflow390.clientWidth + 1, `${overflow390.scrollWidth} vs ${overflow390.clientWidth}`);

  // ---- 4. open a chapter that has real facts --------------------------------
  // Click the chapter title rather than a CSS-class-matched container: the click
  // bubbles to the row's handler, and it survives the row markup changing.
  const CHAPTER_TITLES = [
    "Before you go",
    "Landing and settling in",
    "Studying here",
    "Money and paying",
    "Living here",
    "Getting around",
    "Staying safe and healthy",
    "Culture and people",
    "Speaking and understanding",
    "Student reality",
  ];
  let clickedTitle = null;
  for (const title of CHAPTER_TITLES) {
    const target = page.getByText(title, { exact: true }).first();
    if ((await target.count()) === 0) continue;
    if (!(await target.isVisible().catch(() => false))) continue;
    await target.click({ timeout: 6000 }).catch(() => {});
    clickedTitle = title;
    break;
  }
  const entryOpened = await waitForText(page, "What to know", 30_000);
  record("an entry with real facts opens", entryOpened, clickedTitle ? `opened "${clickedTitle}"` : "no populated chapter row found");

  if (entryOpened) {
    const entryText = await page.locator("body").innerText();
    const trust = ["Official", "University", "Community", "Stale", "Needs review"].filter((state) => entryText.includes(state));
    record("entry shows trust states", trust.length > 0, trust.join(", ") || "none shown");
    record("entry shows a source sentence or source count", /Show the source sentence|official source/i.test(entryText));
    await page.screenshot({ path: `${OUT_DIR}/entry-390.png` });
    shots.push("entry-390.png");
  }

  // ---- 5. Ask this Greenbook ------------------------------------------------
  if (entryOpened) {
    const askFromEntry = page.getByText("Ask YapYep about this", { exact: false }).first();
    if ((await askFromEntry.count()) > 0) {
      await askFromEntry.click({ timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(800);
    }
  }
  // The Ask screen is identified by its input, not by its title — the Greenbook
  // home also has a button reading "Ask this Greenbook", which a title check
  // would falsely match.
  const askVisible = (await page.locator("textarea").count()) > 0 && (await waitForText(page, "Answers are built only from verified facts", 15_000));
  record("Ask this Greenbook opens", askVisible);

  if (askVisible) {
    const suggestion = page.getByRole("button", { name: /Student Pass|bank account|first week|arrive|prepare/i }).first();
    if ((await suggestion.count()) > 0) {
      await suggestion.click({ timeout: 6000 }).catch(() => {});
    } else {
      const box = page.locator("textarea").first();
      if ((await box.count()) > 0) {
        await box.fill("What do I need to prepare?");
        await page.getByRole("button", { name: /^Ask$/ }).first().click({ timeout: 6000 }).catch(() => {});
      }
    }

    // Capture the in-flight state, so a failure shows whether retrieval started
    // and whether the screen is still mounted.
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT_DIR}/ask-pending-390.png` });
    const pendingText = await page.locator("body").innerText().catch(() => "");

    // The answer block only exists once retrieval and generation have resolved.
    const answered = await waitForText(page, /Grounded in retrieved sources|Built without a model/i, 60_000);

    // Scroll to the end of the answer: the sources block sits below the fold, and
    // a viewport-sized read would miss it. Every scroll container is moved,
    // because the tab shell underneath the overlay has one too.
    await page
      .evaluate(() => {
        document.querySelectorAll("div.scroll-area").forEach((element) => {
          element.scrollTop = element.scrollHeight;
        });
      })
      .catch(() => {});
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${OUT_DIR}/ask-sources-390.png` });
    shots.push("ask-sources-390.png");

    const answeredText = await page.locator("body").innerText();
    answerTail = answeredText.replace(/\s+/g, " ").slice(-420);
    const refused = answeredText.includes("I couldn't verify this from a current authoritative source yet.");
    record("Ask returns a grounded or no-LLM answer", answered, answered ? (refused ? "refusal — no authoritative evidence" : "answer rendered") : pendingText.replace(/\s+/g, " ").slice(0, 150));

    // Case-insensitive on purpose: section titles are CSS-uppercased, and
    // Chromium's innerText returns the TRANSFORMED text ("SOURCES (2)"), not the
    // DOM text ("Sources (2)"). Matching case-sensitively fails on a correct page.
    const cited = /sources \((\d+)\)/i.exec(answeredText);
    record("answer cites retrieved sources", Boolean(cited) || refused, cited ? cited[0] : refused ? "refusal, no citation required" : "no citation block");
    const noLlm = answeredText.includes("Built without a model");
    const grounded = answeredText.includes("Grounded in retrieved sources");
    record("answer states its provenance mode", answered && (noLlm || grounded), noLlm ? "no-LLM (facts only)" : grounded ? "grounded in retrieved sources" : "no provenance marker found");

    await page.screenshot({ path: `${OUT_DIR}/ask-390.png` });
    shots.push("ask-390.png");
  }

  // ---- 6. desktop ------------------------------------------------------------
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(1200);
  const overflow1440 = await overflowOf(page);
  record("no horizontal overflow at 1440", overflow1440.scrollWidth <= overflow1440.clientWidth + 1, `${overflow1440.scrollWidth} vs ${overflow1440.clientWidth}`);
  await page.screenshot({ path: `${OUT_DIR}/ask-1440.png` });
  shots.push("ask-1440.png");

  // ---- 7. tablet -------------------------------------------------------------
  await page.setViewportSize({ width: 430, height: 932 });
  await page.waitForTimeout(900);
  const overflow430 = await overflowOf(page);
  record("no horizontal overflow at 430", overflow430.scrollWidth <= overflow430.clientWidth + 1, `${overflow430.scrollWidth} vs ${overflow430.clientWidth}`);

  // ---- 8. demo corridors 1 and 3: each country gives its OWN guidance --------
  // The check that proves the Greenbook is not one country's content relabelled.
  // Each corridor must report its own corpus, render its own entry, and cite its
  // own national sources. Malaysia is corridor 1 ("must be perfect") and
  // Indonesia is corridor 3.
  const CORRIDORS = [
    { code: "MY", label: "corridor 1 (Malaysia)", sourcePattern: /imi\.gov\.my|educationmalaysia\.gov\.my/i, sourceName: "imi.gov.my / educationmalaysia.gov.my" },
    { code: "ID", label: "corridor 3 (Indonesia)", sourcePattern: /imigrasi\.go\.id|international\.ui\.ac\.id/i, sourceName: "imigrasi.go.id / international.ui.ac.id" },
  ];

  for (const corridor of CORRIDORS) {
    await page.setViewportSize({ width: 390, height: 844 });
    const reopened = await reopenGreenbook(page);
    if (!reopened) {
      record(`${corridor.label} opens with its own data`, false, "could not re-open the Greenbook");
      continue;
    }
    const switched = await selectHost(page, corridor.code);
    if (!switched.ok) {
      record(`${corridor.label} opens with its own data`, false, switched.detail);
      continue;
    }
    await waitForText(page, /verified points|Nothing verified/i, 25_000);
    const text = await page.locator("body").innerText();
    const points = /(\d+)\s+verified points/.exec(text);
    record(`${corridor.label} reports its own corpus`, Boolean(points) && Number(points[1]) > 0, points ? points[0] : "no count");

    /*
     * Media, asserted where the product actually surfaces it.
     *
     * Checking the entry screen was wrong: a country's one curated video can
     * legitimately sit in a different chapter from the one this test opens, and
     * that would report a failure for a correct product. The Student Reality
     * screen lists every video for the country, so that is the honest place to
     * assert that a real player is embedded.
     *
     * The section itself is loaded in parallel with chapters and tasks, so it
     * appears a moment after the corpus count does — waiting for it is the
     * difference between measuring the product and measuring the network.
     */
    const seeAll = page.getByRole("button", { name: "See all" }).first();
    const hasMediaSection = await seeAll.waitFor({ state: "visible", timeout: 20_000 }).then(() => true).catch(() => false);
    if (hasMediaSection) {
      await seeAll.click({ timeout: 6000 }).catch(() => {});
      // Wait for the Student Reality screen itself rather than sleeping: a fixed
      // wait measured the network, and the first run after a cold start is slow
      // enough that the count came back zero on a screen that was still loading.
      const onReality = await waitForText(page, "What students actually filmed", 25_000);
      if (onReality) {
        // The players are lazy-loaded, so an off-screen iframe may not exist yet.
        // Scrolling is what a student does anyway.
        await page.evaluate(() => document.querySelectorAll("div.scroll-area").forEach((element) => { element.scrollTop = 700; }));
        await page.waitForTimeout(1_800);
      }
      const embeds = await page.locator("iframe[src*='youtube']").count();
      const realityText = await page.locator("body").innerText();
      const labelled = /official|verified student|curated public|community recommended/i.test(realityText);
      record(`${corridor.label} plays its own official video`, onReality && embeds > 0, `${embeds} embedded player(s)`);
      record(`${corridor.label} labels media trust tier`, onReality && labelled);
      await page.screenshot({ path: `${OUT_DIR}/reality-${corridor.code.toLowerCase()}-390.png` });
      shots.push(`reality-${corridor.code.toLowerCase()}-390.png`);
      await appBack(page);
    } else {
      record(`${corridor.label} plays its own official video`, false, "no media section on the Greenbook home");
    }

    // Back on the home screen before the chapter click, or that click is a no-op.
    await ensureGreenbookHome(page);
    // ...and the chapter list itself must have rendered. It loads after the
    // cover, so clicking too early silently does nothing.
    await waitForText(page, /Before you go|Landing and settling in|Studying here|Money and paying|Living here/, 20_000);

    let entry = false;
    for (const title of CHAPTER_TITLES) {
      const target = page.getByText(title, { exact: true }).first();
      if ((await target.count()) === 0) continue;
      if (!(await target.isVisible().catch(() => false))) continue;
      await target.click({ timeout: 6000 }).catch(() => {});
      entry = await waitForText(page, "What to know", 30_000);
      break;
    }
    record(`${corridor.label} entry renders facts`, entry);

    if (entry) {
      // Open the sources drawer and assert the national domains are listed
      // there. Checking the fact text for a URL was incidental — an action
      // string sometimes embeds one and sometimes does not — whereas the
      // provenance list is exactly where a citation is supposed to live.
      const drawerButton = page.getByRole("button").filter({ hasText: /official source/i }).first();
      if ((await drawerButton.count()) > 0) {
        await drawerButton.click({ timeout: 6000 }).catch(() => {});
        await page.waitForTimeout(900);
      }
      const entryText = await page.locator("body").innerText();
      const cites = corridor.sourcePattern.test(entryText);
      record(`${corridor.label} cites its own national sources`, cites, cites ? `cites ${corridor.sourceName}` : "no national source in the provenance list");

      await page.screenshot({ path: `${OUT_DIR}/corridor-${corridor.code.toLowerCase()}-390.png` });
      shots.push(`corridor-${corridor.code.toLowerCase()}-390.png`);

      // Close the drawer so the next corridor starts from a clean screen.
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(400);
    }
  }

  // ---- 9. a sparse country must degrade gracefully ---------------------------
  await page.setViewportSize({ width: 390, height: 844 });
  // Reload and re-enter rather than walking a deep overlay stack backwards —
  // this also proves the session and journey survive a reload.
  const reopened = await reopenGreenbook(page);
  if (!reopened) {
    record("sparse country renders a graceful baseline (no crash)", false, "could not re-open the Greenbook after reload");
  } else {
    const switched = await selectHost(page, "TH");
    if (switched.ok) {
      const settled = await waitForText(page, /Nothing verified|No verified task list|verified points/i, 25_000);
      const sparseText = await page.locator("body").innerText();
      const graceful = settled && !/Something went wrong|stack|undefined is not/i.test(sparseText);
      record("sparse country renders a graceful baseline (no crash)", graceful, graceful ? "baseline rendered" : sparseText.replace(/\s+/g, " ").slice(0, 150));
      await page.screenshot({ path: `${OUT_DIR}/sparse-th-390.png` });
      shots.push("sparse-th-390.png");
    } else {
      record("sparse country renders a graceful baseline (no crash)", false, switched.detail);
    }
  }

  // ---- 9. runtime health -----------------------------------------------------
  const meaningful = pageErrors.filter((message) => !/ResizeObserver|Appwrite|401|404/i.test(message));
  record("no uncaught page errors", meaningful.length === 0, meaningful.slice(0, 2).join(" | ") || "none");

  await browser.close();

  const evidence = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    hostRoute: hostMatch?.[0] ?? null,
    verifiedPoints: pointsMatch ? Number(pointsMatch[1]) : null,
    viewports: VIEWPORTS.map((viewport) => viewport.name),
    screenshots: shots,
    results,
    passed: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    answerTail,
    pageErrors,
    consoleErrors: consoleErrors.slice(0, 10),
  };
  writeFileSync(`${OUT_DIR}/greenbook-e2e.json`, JSON.stringify(evidence, null, 2));

  console.log(`\n${evidence.passed}/${results.length} checks passed`);
  console.log(`evidence: ${OUT_DIR}/greenbook-e2e.json`);
  if (evidence.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("greenbook e2e failed:", error.message);
  process.exitCode = 1;
});
