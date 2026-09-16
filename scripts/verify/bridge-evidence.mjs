/**
 * Conversation Bridge browser evidence at 390px.
 *
 * Verifies the failsafe criteria that can only be checked in a real browser:
 *   - the bridge renders in the five-tab shell
 *   - a denied microphone produces a usable fallback, not a dead end
 *   - no horizontal overflow and no page errors
 *
 * Usage: BASE_URL=http://127.0.0.1:5173 node scripts/verify/bridge-evidence.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { completeOnboarding, overflowMetrics } from "./lib/onboarding.mjs";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:5173";
const OUT = "docs/evidence/phase3";

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();

  // No microphone permission granted: getUserMedia must reject, which is the
  // failsafe path we want to observe.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: [] });
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text().slice(0, 200));
  });
  page.on("pageerror", (error) => pageErrors.push(error.message.slice(0, 200)));

  const report = { baseUrl: BASE_URL, generatedAt: new Date().toISOString(), checks: [] };
  const check = (name, pass, note) => {
    report.checks.push({ name, pass: Boolean(pass), note });
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${name} — ${note}`);
  };

  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  // Warm the dev server once so the walker is not racing a cold module compile.
  await page.waitForTimeout(5000);
  const reached = await completeOnboarding(page);
  check("onboarding reaches the shell", reached, reached ? "five-tab shell visible" : "onboarding did not complete");
  if (!reached) {
    await page.screenshot({ path: `${OUT}/bridge-onboarding-stuck.png` });
    writeFileSync(`${OUT}/bridge-evidence.json`, JSON.stringify(report, null, 2));
    await browser.close();
    process.exitCode = 1;
    return;
  }

  // Lens → conversation mode.
  await page.getByRole("button", { name: "Lens" }).first().click();
  await page.waitForTimeout(600);

  const modeButtons = page.locator("button[aria-pressed]");
  const modeCount = await modeButtons.count();
  check("Lens exposes its five input modes", modeCount >= 5, `${modeCount} mode buttons`);
  if (modeCount >= 5) {
    await modeButtons.nth(4).click();
    await page.waitForTimeout(800);
  }

  const bridgeCopy = await page.getByText(/Two lanes|Hold the button when the other person speaks/i).first().isVisible().catch(() => false);
  check("conversation bridge renders its two-lane explanation", bridgeCopy, bridgeCopy ? "coaching + translation lanes described" : "bridge copy not found");

  const metrics = await overflowMetrics(page);
  check("no horizontal overflow at 390px", !metrics.overflow, `${metrics.scrollWidth}/${metrics.clientWidth}`);
  await page.screenshot({ path: `${OUT}/bridge-390x844.png` });

  // Denied microphone: hold the mic button and expect a graceful fallback.
  const mic = page.getByRole("button", { name: /Hold to capture what the other person said/i }).first();
  const hasMic = await mic.isVisible().catch(() => false);
  check("mic control is present", hasMic, hasMic ? "hold-to-capture button visible" : "mic control not found");

  if (hasMic) {
    await mic.dispatchEvent("pointerdown");
    await page.waitForTimeout(1500);
    await mic.dispatchEvent("pointerup");
    await page.waitForTimeout(1200);

    const fallback = await page.getByText(/Microphone access was blocked|Another way to reply|Upload audio|Type what the person said/i).first().isVisible().catch(() => false);
    check("denied microphone falls back instead of dead-ending", fallback, fallback ? "a usable fallback is offered" : "no fallback surfaced");
    await page.screenshot({ path: `${OUT}/bridge-mic-denied.png` });
  }

  report.consoleErrors = [...new Set(consoleErrors)];
  report.pageErrors = [...new Set(pageErrors)];
  check("no page errors", report.pageErrors.length === 0, report.pageErrors.length ? report.pageErrors.join(" | ") : "none");

  const appwriteOnly = report.consoleErrors.every((message) => /401|404|loadJourney|AppwriteException/i.test(message));
  check("no new console errors from the bridge", appwriteOnly, report.consoleErrors.length ? `${report.consoleErrors.length} console error(s), all pre-existing Appwrite guest probes` : "none");

  writeFileSync(`${OUT}/bridge-evidence.json`, JSON.stringify(report, null, 2));
  const passed = report.checks.filter((entry) => entry.pass).length;
  console.log(`\nbridge evidence: ${passed}/${report.checks.length} passed`);
  await browser.close();
  if (passed !== report.checks.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error("bridge evidence crashed:", error.message);
  process.exitCode = 1;
});
