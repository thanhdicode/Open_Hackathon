/**
 * Phase 1 responsive verification (ADR-003 §5).
 *
 * Drives a real Chromium against a running dev server, walks the anonymous
 * onboarding flow, then measures and screenshots the app at the frozen
 * breakpoints: 360 / 390 / 430 (mobile, bottom nav), 768 (tablet, compact
 * rail), 1024 / 1440 (desktop, rail + workspace + context panel).
 *
 * Usage: node scripts/verify/responsive.mjs
 *   BASE_URL  dev/preview origin (default http://127.0.0.1:5173)
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:5173";
const OUT_DIR = "docs/evidence/phase1";

const VIEWPORTS = [
  { name: "360", width: 360, height: 800, expect: "bottom-nav" },
  { name: "390", width: 390, height: 844, expect: "bottom-nav" },
  { name: "430", width: 430, height: 932, expect: "bottom-nav" },
  { name: "768", width: 768, height: 1024, expect: "rail" },
  { name: "1024", width: 1024, height: 768, expect: "rail+panel" },
  { name: "1440", width: 1440, height: 900, expect: "rail+panel" },
];

const results = [];
const consoleErrors = [];
const networkFailures = [];

function log(...args) {
  console.log(...args);
}

/** Walk the anonymous onboarding flow until the app shell is reachable. */
async function ensureAppShell(page) {
  // Scope every onboarding lookup to the onboarding surface. `App.tsx` renders
  // the shell behind the overlay, and the shell's route chip is a button that
  // matches country names — a page-wide lookup clicks the chip and the walker
  // never leaves the welcome step.
  const onboarding = page.getByTestId("onboarding");
  const start = onboarding.getByRole("button", { name: "Start my journey" });
  if (!(await start.isVisible().catch(() => false))) return "already-onboarded";

  await start.click();
  // Creating the guest session is a real network round trip and can be slow.
  await onboarding.getByRole("heading", { name: "Where are you from?" }).waitFor({ timeout: 45000 });

  // Step 1 — origin. Reject the shell's route chip, which renders "→".
  await onboarding.getByRole("button", { name: /Viet Nam/ }).first().click();
  await onboarding.getByRole("button", { name: "Continue", exact: true }).click();

  // Step 2 — destination (the same country is disabled here by design).
  await onboarding.getByRole("heading", { name: "Where are you going?" }).waitFor();
  await onboarding.getByRole("button", { name: /Singapore/ }).first().click();
  await onboarding.getByRole("button", { name: "Continue", exact: true }).click();

  // Step 3 — dates. An explicit arrival is required; the return date is optional.
  await onboarding.getByRole("heading", { name: "When are you arriving?" }).waitFor();
  await onboarding.getByLabel("Arrival date", { exact: true }).fill("2026-10-01");
  await onboarding.getByRole("button", { name: "Create my Passport", exact: true }).click();
  await page.waitForTimeout(1200);

  /*
   * Dismiss the first-run product tour before measuring anything.
   *
   * `YepGuide` auto-starts a Driver.js tour on the first usable home (§5), and
   * its overlay is a full-viewport SVG that intercepts pointer events — so every
   * subsequent click on the bottom nav times out with "driver-overlay …
   * intercepts pointer events". That is the tour working, not a layout fault, and
   * the overlay must be cleared before the shell can be driven.
   */
  const tour = page.locator(".yep-tour");
  if (await tour.count()) {
    for (let i = 0; i < 8 && (await tour.count()); i += 1) {
      await page.locator(".driver-popover-next-btn").click({ timeout: 5000 }).catch(() => {});
    }
    await tour.waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
  }
  await page.waitForTimeout(300);
  return "onboarded";
}

async function measure(page, viewport) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const rect = (el) => (el ? el.getBoundingClientRect() : null);

    const navs = Array.from(document.querySelectorAll('nav[aria-label="Primary"]'));
    const bottomNav = navs.find((el) => el.className.includes("rail:hidden") && isVisible(el));
    const rail = navs.find((el) => el.className.includes("rail:flex") && isVisible(el));
    const activeNav = bottomNav || rail;
    const panel = document.querySelector("aside");
    const card = document.querySelector('div[class*="rounded-[12px]"][class*="bg-surface"]');

    // touch targets of every visible primary-nav button
    const targets = [];
    for (const btn of activeNav ? activeNav.querySelectorAll("button") : []) {
      const r = btn.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        targets.push({ label: btn.getAttribute("aria-label") || btn.textContent.trim(), h: Math.round(r.height), w: Math.round(r.width) });
      }
    }

    const style = (el, prop) => (el ? getComputedStyle(el)[prop] : null);

    return {
      innerWidth: window.innerWidth,
      docScrollWidth: doc.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      horizontalOverflow: doc.scrollWidth > window.innerWidth + 1,
      bottomNavVisible: isVisible(bottomNav),
      railVisible: isVisible(rail),
      railWidth: rail ? Math.round(rect(rail).width) : 0,
      panelPresent: Boolean(panel),
      panelVisible: isVisible(panel),
      panelWidth: panel ? Math.round(rect(panel).width) : 0,
      workspaceWidth: (() => {
        const col = document.querySelector('div[class*="max-w-[800px]"]');
        return col ? Math.round(rect(col).width) : 0;
      })(),
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      cardShadow: style(card, "boxShadow"),
      navTargets: targets,
      minTargetHeight: targets.length ? Math.min(...targets.map((t) => t.h)) : null,
    };
  });
}

async function run() {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  let aiOutcome = "not-attempted";

  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(`[${vp.name}] ${msg.text().slice(0, 200)}`);
    });
    page.on("response", (res) => {
      if (res.status() >= 400) networkFailures.push({ viewport: vp.name, status: res.status(), url: res.url().replace(/^https?:\/\/[^/]+/, "") });
    });

    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    let onboarding = "unknown";
    let metrics = null;
    let lensMetrics = null;
    try {
      onboarding = await ensureAppShell(page);
      await page.waitForTimeout(700);
      metrics = await measure(page, vp);
    } catch (error) {
      onboarding = `flow-error: ${error.message.split("\n")[0]}`;
      await page.screenshot({ path: `${OUT_DIR}/error-${vp.name}.png` });
    }

    if (metrics) {
      await page.screenshot({ path: `${OUT_DIR}/today-${vp.name}.png` });

      // Lens surface: input state, plus one real interpretation attempt at 1440
      await page.getByRole("button", { name: "Lens" }).first().click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT_DIR}/lens-${vp.name}.png` });

      if (vp.name === "1440" || vp.name === "390") {
        const segments = page.locator('div[class*="rounded-[12px]"] > button');
        await segments.first().click(); // text mode
        await page.getByRole("button", { name: "Use sample" }).click();
        await page.getByRole("button", { name: "Interpret" }).click();
        await page.waitForTimeout(12000);
        const heading = page.getByText("EVIDENCE & SOURCES");
        const errorNotice = page.getByText("YapLens unavailable");
        if (await heading.isVisible().catch(() => false)) aiOutcome = "result-rendered";
        else if (await errorNotice.isVisible().catch(() => false)) aiOutcome = "ai-unavailable";
        lensMetrics = await page.evaluate(() => {
          const aside = document.querySelector("aside");
          const r = aside ? aside.getBoundingClientRect() : null;
          const evidence = Array.from(document.querySelectorAll("p")).find((p) => p.textContent.trim() === "EVIDENCE & SOURCES");
          return {
            panelVisible: Boolean(r && r.width > 0),
            panelWidth: r ? Math.round(r.width) : 0,
            evidenceInPanel: Boolean(evidence && aside && aside.contains(evidence)),
          };
        });
        await page.screenshot({ path: `${OUT_DIR}/lens-result-${vp.name}.png` });
      }
    }

    results.push({ viewport: vp, onboarding, ...(metrics ?? {}), lens: lensMetrics });
    if (metrics) {
      log(`${vp.name}: rail=${metrics.railVisible}(${metrics.railWidth}px) bottomNav=${metrics.bottomNavVisible} panel=${metrics.panelVisible}(${metrics.panelWidth}px) workspace=${metrics.workspaceWidth}px overflow=${metrics.horizontalOverflow} minTarget=${metrics.minTargetHeight}px`);
    } else {
      log(`${vp.name}: FLOW FAILED — ${onboarding}`);
    }    await context.close();
  }

  await browser.close();
  const report = { baseUrl: BASE_URL, generatedAt: new Date().toISOString(), aiOutcome, results, consoleErrors, networkFailures };
  writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify(report, null, 2));

  const failures = [];
  for (const r of results) {
    if (r.docScrollWidth === undefined) {
      failures.push(`${r.viewport.name}: browser flow did not complete (${r.onboarding})`);
      continue;
    }
    if (r.horizontalOverflow) failures.push(`${r.viewport.name}: horizontal overflow (${r.docScrollWidth} > ${r.innerWidth})`);
    const expectBottomNav = r.viewport.width < 600;
    const expectRail = r.viewport.width >= 600;
    if (r.bottomNavVisible !== expectBottomNav) failures.push(`${r.viewport.name}: bottom nav visible=${r.bottomNavVisible}, expected ${expectBottomNav}`);
    if (r.railVisible !== expectRail) failures.push(`${r.viewport.name}: rail visible=${r.railVisible}, expected ${expectRail}`);
    // panel is claim-based: Today does not claim it, so it must not occupy space
    if (r.panelVisible) failures.push(`${r.viewport.name}: context panel rendered for a view that does not claim it`);
    if (r.lens) {
      const expectPanel = r.viewport.width >= 1200;
      if (r.lens.panelVisible !== expectPanel) failures.push(`${r.viewport.name}: Lens panel visible=${r.lens.panelVisible}, expected ${expectPanel}`);
      if (r.lens.evidenceInPanel !== expectPanel) failures.push(`${r.viewport.name}: Lens evidence in panel=${r.lens.evidenceInPanel}, expected ${expectPanel}`);
      if (r.viewport.width >= 1024 && r.workspaceWidth < 680) failures.push(`${r.viewport.name}: workspace ${r.workspaceWidth}px < 680px floor (Lens)`);
    }
    if (expectRail && r.workspaceWidth < 680) failures.push(`${r.viewport.name}: workspace ${r.workspaceWidth}px < 680px floor`);
    if (expectRail && r.workspaceWidth > 800) failures.push(`${r.viewport.name}: workspace ${r.workspaceWidth}px > 800px ceiling`);
    if (r.minTargetHeight !== null && r.minTargetHeight < 44) failures.push(`${r.viewport.name}: nav touch target ${r.minTargetHeight}px < 44px`);
    if (r.cardShadow && r.cardShadow !== "none") failures.push(`${r.viewport.name}: card has a default shadow (${r.cardShadow})`);
    if (!r.bottomNavVisible && !r.railVisible) failures.push(`${r.viewport.name}: no primary navigation visible`);
  }

  log("\nAI outcome:", aiOutcome);
  log("lens context panel:");
  for (const r of results) {
    if (r.lens) log(`  ${r.viewport.name}: panel=${r.lens.panelVisible}(${r.lens.panelWidth}px) evidenceInPanel=${r.lens.evidenceInPanel}`);
  }
  log("console errors:", consoleErrors.length);
  for (const e of consoleErrors.slice(0, 8)) log("  " + e);
  const byStatus = {};
  for (const f of networkFailures) {
    const key = `${f.status} ${f.url.replace(/\/[^/]*$/, "/…")}`;
    byStatus[key] = (byStatus[key] || 0) + 1;
  }
  log("network failures:", networkFailures.length);
  for (const [k, v] of Object.entries(byStatus)) log(`  ${v}x ${k}`);
  if (failures.length) {
    log("\nGATE FAILURES:");
    for (const f of failures) log(" - " + f);
    process.exit(1);
  }
  log("\nGATE PASS: responsive layout, nav mode, touch targets and card shadow rules hold at all viewports.");
}

await run();
