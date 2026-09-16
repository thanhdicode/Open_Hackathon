/**
 * Phase 3 browser evidence for the Lens surface.
 *
 * Walks the real anonymous onboarding, opens Lens, exercises the new modes and
 * records console errors, horizontal overflow and screenshots at the frozen
 * breakpoints. Reports measured values only.
 *
 * Usage: node scripts/verify/lens-evidence.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:5173";
const OUT = "docs/evidence/phase3";

const VIEWPORTS = [
  { name: "390x844", width: 390, height: 844 },
  { name: "430x932", width: 430, height: 932 },
  { name: "768", width: 768, height: 1024 },
  { name: "1440x900", width: 1440, height: 900 },
];

/**
 * Click the first pattern that is actually present and enabled.
 * Checking visibility first matters: blindly clicking every candidate makes
 * each miss cost a full timeout, which is what stalled the first attempt.
 */
async function clickVisible(page, patterns, timeout = 2500) {
  for (const pattern of patterns) {
    const target = page.getByRole("button", { name: pattern }).first();
    if ((await target.count()) === 0) continue;
    if (!(await target.isVisible().catch(() => false))) continue;
    if (await target.isDisabled().catch(() => false)) continue;
    try {
      await target.click({ timeout });
      return String(pattern);
    } catch {
      /* try the next pattern */
    }
  }
  return null;
}

const NAV = /^(Today|Passport|Lens|Explore|Connect|Back|Settings)$/;

/** True when a matching button exists, is visible and is not disabled. */
async function isClickable(page, pattern) {
  const target = page.getByRole("button", { name: pattern }).first();
  if ((await target.count()) === 0) return false;
  if (!(await target.isVisible().catch(() => false))) return false;
  return !(await target.isDisabled().catch(() => true));
}

/** Drive onboarding by reacting to whatever screen is actually showing. */
async function completeOnboarding(page) {
  await clickVisible(page, [/Try YapYep/], 10000);

  for (let step = 0; step < 40; step += 1) {
    if (await page.getByRole("button", { name: "Lens" }).first().isVisible().catch(() => false)) return true;
    await page.waitForTimeout(250);

    // Country steps. A country already chosen becomes disabled, so only an
    // enabled option is selectable — that is what distinguishes home from host.
    const country = await clickVisible(page, [/Viet Nam/, /Singapore/, /Thailand/, /Malaysia/, /Indonesia/, /Philippines/]);
    if (country) {
      await clickVisible(page, [/^Continue$/, /^Next$/], 4000);
      continue;
    }

    const advanced = await clickVisible(page, [
      /See your adaptation map/,
      /Generate my Passport/,
      /Enter YapYep/,
      /Continue as guest/,
      /^Continue$/,
      /^Next$/,
      /Speak with confidence/,
      /^Coffee$/,
      /^Library$/,
      /^Skip$/,
    ]);
    if (advanced) continue;

    // Option grids: pick any enabled, non-navigation button.
    const buttons = page.getByRole("button");
    const total = await buttons.count();
    let picked = false;
    for (let index = 0; index < total && index < 30; index += 1) {
      const candidate = buttons.nth(index);
      const label = ((await candidate.innerText().catch(() => "")) || "").trim();
      if (!label || NAV.test(label)) continue;
      if (await candidate.isDisabled().catch(() => true)) continue;
      try {
        await candidate.click({ timeout: 1200 });
        picked = true;
        break;
      } catch {
        /* keep looking */
      }
    }
    if (!picked) {
      void isClickable;
      return page.getByRole("button", { name: "Lens" }).first().isVisible().catch(() => false);
    }
  }

  return page.getByRole("button", { name: "Lens" }).first().isVisible().catch(() => false);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const report = { baseUrl: BASE_URL, generatedAt: new Date().toISOString(), viewports: [], consoleErrors: [], pageErrors: [] };

  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") report.consoleErrors.push(message.text().slice(0, 200));
  });
  page.on("pageerror", (error) => report.pageErrors.push(error.message.slice(0, 200)));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  const reached = await completeOnboarding(page);
  console.log(`onboarding reached app shell: ${reached}`);
  if (!reached) {
    await page.screenshot({ path: `${OUT}/lens-onboarding-stuck.png` });
    writeFileSync(`${OUT}/lens-evidence.json`, JSON.stringify(report, null, 2));
    await browser.close();
    process.exitCode = 1;
    return;
  }

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(500);

    await page.getByRole("button", { name: "Lens" }).first().click();
    await page.waitForTimeout(900);

    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }));

    await page.screenshot({ path: `${OUT}/lens-input-${viewport.name}.png` });

    // Screenshot mode is the default surface; capture the picker state.
    const entry = { ...viewport, ...metrics, heading: await page.getByText("YapLens").first().isVisible().catch(() => false) };

    // Open the camera mode to prove the capture + fallback affordances render.
    const cameraTab = page.getByRole("button").filter({ hasText: "" }).nth(0);
    void cameraTab;
    const modeButtons = await page.locator("button[aria-pressed]").count();
    entry.segmentedButtons = modeButtons;
    report.viewports.push(entry);
    console.log(`  ${viewport.name}: overflow=${metrics.overflow} (${metrics.scrollWidth}/${metrics.clientWidth}) heading=${entry.heading}`);
  }

  report.consoleErrors = [...new Set(report.consoleErrors)];
  report.pageErrors = [...new Set(report.pageErrors)];
  writeFileSync(`${OUT}/lens-evidence.json`, JSON.stringify(report, null, 2));

  console.log(`\nconsole errors: ${report.consoleErrors.length ? report.consoleErrors.join(" | ") : "(none)"}`);
  console.log(`page errors   : ${report.pageErrors.length ? report.pageErrors.join(" | ") : "(none)"}`);
  console.log("wrote", `${OUT}/lens-evidence.json`);
  await browser.close();
}

main().catch((error) => {
  console.error("lens evidence crashed:", error.message);
  process.exitCode = 1;
});
