/**
 * Diagnostic: what actually renders on first load.
 * Captures console errors, page errors, failed requests and visible text so a
 * stalled flow is diagnosed from evidence instead of guesswork.
 *
 * Usage: node scripts/verify/diagnose-ui.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:5173";
const OUT = "docs/evidence/phase3";

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300));
  });
  page.on("pageerror", (error) => pageErrors.push(error.message.slice(0, 300)));
  page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url().slice(0, 120)} — ${request.failure()?.errorText}`));

  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);

  const snap = async (label) => {
    const text = (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 400);
    const buttons = await page.getByRole("button").allInnerTexts();
    await page.screenshot({ path: `${OUT}/diag-${label}.png`, fullPage: false });
    console.log(`\n--- ${label} ---`);
    console.log("text   :", text);
    console.log("buttons:", buttons.map((b) => b.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 14).join(" | "));
  };

  await snap("01-first-load");

  // Walk onboarding the same way the responsive harness does.
  const steps = [
    ["Try YapYep", null],
    [null, /^(Continue|See your adaptation map|Generate my Passport|Enter YapYep|Continue as guest)$/],
    [null, /Viet Nam/],
    [null, /Singapore/],
    ["Speak with confidence", null],
    ["Coffee", null],
  ];
  for (const [name, pattern] of steps) {
    try {
      const target = name ? page.getByRole("button", { name }).first() : page.getByRole("button", { name: pattern }).first();
      await target.click({ timeout: 6000 });
      await page.waitForTimeout(1200);
    } catch (error) {
      console.log(`step failed: ${name ?? pattern} — ${error.message.split("\n")[0]}`);
      break;
    }
  }
  await snap("02-after-onboarding");

  // Try the MyDNA step if it is still showing.
  for (let i = 0; i < 6; i += 1) {
    const option = page.getByRole("button", { name: /^[A-Z]/ }).nth(3);
    try {
      await option.click({ timeout: 1500 });
      await page.waitForTimeout(500);
    } catch {
      break;
    }
  }

  console.log("\n=== console errors ===");
  console.log(consoleErrors.length ? consoleErrors.join("\n") : "(none)");
  console.log("=== page errors ===");
  console.log(pageErrors.length ? pageErrors.join("\n") : "(none)");
  console.log("=== failed requests ===");
  console.log(failedRequests.length ? [...new Set(failedRequests)].join("\n") : "(none)");

  writeFileSync(`${OUT}/ui-diagnose.json`, JSON.stringify({ consoleErrors, pageErrors, failedRequests: [...new Set(failedRequests)] }, null, 2));
  await browser.close();
}

main().catch((error) => {
  console.error("diagnose crashed:", error);
  process.exitCode = 1;
});
