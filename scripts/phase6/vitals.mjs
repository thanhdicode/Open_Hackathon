/**
 * Core Web Vitals on the production build (§15 release gate).
 *
 * Targets: LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.1 — measured on the four surfaces the
 * brief names: landing, onboarding, personalized home, and the AI experience.
 *
 * Two measurement rules this follows, because getting them wrong produces a
 * number that is worse than no number:
 *
 *  1. **LCP observers must be installed before the page loads.** A `buffered`
 *     observer added after `goto` does not receive the landing LCP entry, so the
 *     value silently falls back to whatever the harness's own timer measured —
 *     which reported an identical 11.6s "LCP" on four different screens. The
 *     observer is installed via `addInitScript` so it is live from the first byte.
 *
 *  2. **INP cannot be observed without field traffic.** It is approximated the
 *     standard way here: drive real interactions and record the worst `event`
 *     entry duration. That is a *proxy* and is labelled as one — calling it INP
 *     would overstate the evidence.
 */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE_URL || "http://127.0.0.1:8460";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });

/*
 * Installed into every document before any app code runs, so the landing paint
 * is captured rather than missed.
 */
await context.addInitScript(() => {
  window.__vitals = { lcp: 0, cls: 0, worstEvent: 0, shifts: [], lcpAt: 0 };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.startTime >= window.__vitals.lcp) {
          window.__vitals.lcp = entry.startTime;
          window.__vitals.lcpAt = performance.now();
        }
      }
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) {
          window.__vitals.cls += entry.value;
          window.__vitals.shifts.push(Number(entry.value.toFixed(4)));
        }
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__vitals.worstEvent = Math.max(window.__vitals.worstEvent, entry.duration);
    }).observe({ type: "event", buffered: true, durationThreshold: 16 });
  } catch {}
});

const page = await context.newPage();

/** Read the counters the init script has been accumulating. */
async function read() {
  return page.evaluate(() => {
    const v = window.__vitals ?? { lcp: 0, cls: 0, worstEvent: 0, shifts: [] };
    return { lcp: Math.round(v.lcp), cls: Number(v.cls.toFixed(4)), worstEvent: Math.round(v.worstEvent), shifts: v.shifts };
  });
}

/** Reset per surface so each screen is measured on its own merits. */
async function reset() {
  await page.evaluate(() => {
    if (window.__vitals) window.__vitals = { lcp: 0, cls: 0, worstEvent: 0, shifts: [], lcpAt: 0 };
  });
}

const report = { at: new Date().toISOString(), base: BASE, surfaces: {}, notes: [] };

// --- 1. Landing (cold load, fresh document so the init script runs first)
await page.goto(BASE, { waitUntil: "load" }).catch(() => {});
await page.getByRole("button", { name: "Start my journey", exact: true }).waitFor({ timeout: 60000 });
await page.waitForTimeout(1500);
report.surfaces.landing = await read();

// --- 2. Onboarding
await reset();
await page.getByRole("button", { name: "Start my journey", exact: true }).click();
await page.getByRole("heading", { name: "Where are you from?" }).waitFor({ timeout: 60000 });
await page.getByTestId("onboarding").getByRole("button", { name: /Viet Nam/ }).first().click();
await page.getByRole("button", { name: "Continue", exact: true }).click();
await page.getByTestId("onboarding").getByRole("button", { name: /Singapore/ }).first().click();
await page.getByRole("button", { name: "Continue", exact: true }).click();
await page.getByLabel("Arrival date", { exact: true }).fill("2026-10-01");
await page.getByRole("button", { name: "Create my Passport", exact: true }).click();
report.surfaces.onboarding = await read();

// --- 3. Personalized home (after the one-time tour settles)
await page.locator(".yep-tour").waitFor({ timeout: 60000 }).catch(() => {});
for (let i = 0; i < 6 && (await page.locator(".yep-tour").count()); i += 1) {
  await page.locator(".driver-popover-next-btn").click().catch(() => {});
}
await page.locator(".yep-tour").waitFor({ state: "detached", timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1200);
report.surfaces.home = await read();

// --- 4. AI experience
await reset();
await page.locator('nav[aria-label="Primary"]:visible').getByRole("button", { name: "Today", exact: true }).click();
await page.locator('[data-tour-screen="today"]').getByRole("button", { name: "Ask", exact: true }).click();
await page.getByRole("heading", { name: "Ask this Greenbook", exact: true }).waitFor({ timeout: 30000 });
await page.getByPlaceholder(/Ask about Singapore/).fill("How do I prepare my Student's Pass application in Singapore?");
const askStarted = Date.now();
await page.locator('[data-yep="ask"]').getByRole("button", { name: "Ask", exact: true }).click();
await page.getByText(/Show linked sources|From verified guidance|More context needed/).waitFor({ timeout: 120000 });
report.aiAnswerMs = Date.now() - askStarted;
await page.waitForTimeout(1000);
report.surfaces.ai = await read();

console.log("surface        LCP(ms)    CLS      worstEvent(ms)  shifts");
for (const [name, m] of Object.entries(report.surfaces)) {
  console.log(
    `${name.padEnd(14)} ${String(m.lcp).padStart(7)}   ${String(m.cls).padStart(6)}   ${String(m.worstEvent).padStart(6)}          ${m.shifts.length}`,
  );
}
console.log(`\naiAnswerMs (real model round trip): ${report.aiAnswerMs}`);
console.log("\nGATES: LCP<=2500ms, CLS<=0.1. worstEvent is an INP *proxy*, not field INP.");
console.log(
  "LCP is a *document* metric. It is only meaningful for the landing surface, which is a real\n" +
    "navigation; onboarding/home/ai are in-app state changes on the same document, so no further\n" +
    "LCP entry is emitted and those rows read 0 by construction, not by failure.",
);

let failed = 0;
for (const [name, m] of Object.entries(report.surfaces)) {
  // LCP is only asserted where a document actually loaded.
  const lcpApplies = name === "landing";
  const lcpOk = !lcpApplies || (m.lcp > 0 && m.lcp <= 2500);
  const clsOk = m.cls <= 0.1;
  if (!lcpOk || !clsOk) failed += 1;
  console.log(
    `  ${name.padEnd(14)} LCP ${lcpApplies ? (lcpOk ? "PASS" : "FAIL") : "n/a (same document)"}${lcpApplies ? ` (${m.lcp}ms)` : ""} | CLS ${clsOk ? "PASS" : "FAIL"} (${m.cls})`,
  );
}
console.log(failed ? `\n${failed} surface(s) outside budget` : "\nAll measured surfaces within the LCP and CLS budgets");

await browser.close();
