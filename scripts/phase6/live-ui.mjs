/** Actual production UI + Appwrite + deployed AI, no response mocks. Synthetic inputs only. */
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.BASE_URL || "http://127.0.0.1:8460";
const OUT = "docs/evidence/phase6/live-ui";
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: "reduce" });
const page = await context.newPage();
page.setDefaultTimeout(20000);
const report = { at: new Date().toISOString(), transport: "real_appwrite_and_deployed_ai", steps: [], pageErrors: [], network: [] };
page.on("pageerror", (error) => report.pageErrors.push(error.message));
page.on("response", (response) => {
  if (response.status() >= 400) { const url = new URL(response.url()); report.network.push({ path: url.pathname, status: response.status() }); }
});
async function capture(name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  const text = await page.locator("body").innerText();
  assert.ok(!/\bundefined\b|\bNaN\b|providerUsed|fallbackDepth|collection[_ ]id|gemini-\d|groq-|no_llm/i.test(text), `${name}: implementation leakage`);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: horizontal overflow`);
  report.steps.push({ name, screenshot: `${OUT}/${name}.png`, text });
  writeFileSync(`${OUT}/results.json`, JSON.stringify(report, null, 2));
}
async function chooseTab(name) { await page.locator('nav[aria-label="Primary"]:visible').getByRole("button", { name, exact: true }).click(); }
try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Start my journey", exact: true }).waitFor();
  await capture("01-landing-390");
  await page.getByRole("button", { name: "Start my journey", exact: true }).click();
  await page.getByRole("heading", { name: "Where are you from?", exact: true }).waitFor();
  await capture("02-origin-390");
  await page.getByRole("button", { name: /Viet Nam/ }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("heading", { name: "Where are you going?", exact: true }).waitFor();
  await capture("03-destination-390");
  assert.ok(await page.getByRole("button", { name: /Viet Nam/ }).isDisabled());
  await page.getByRole("button", { name: /Singapore/ }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("heading", { name: "When are you arriving?", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Arrival date", { exact: true }).inputValue(), "");
  await page.getByLabel("Arrival date", { exact: true }).fill("2026-10-01");
  await capture("04-explicit-date-390");
  await page.getByRole("button", { name: "Create my Passport", exact: true }).click();
  await page.locator(".yep-tour").waitFor({ timeout: 45000 });
  await capture("05-first-home-tour-390");
  for (let i = 0; i < 5 && await page.locator(".yep-tour").count(); i++) await page.locator(".driver-popover-next-btn").click();
  await page.locator(".yep-tour").waitFor({ state: "detached" });
  await capture("06-personalized-home-390");
  const homeText = await page.locator("body").innerText();
  assert.ok(homeText.includes("Prepare for Singapore"));
  assert.ok(!/FIN|NUS|orientation.*Aug|20,|Strongest transfer/.test(homeText));
  await chooseTab("Passport");
  await page.getByRole("heading", { name: "Your Singapore Passport", exact: true }).waitFor();
  await capture("07-passport-390");
  const passportText = await page.locator("body").innerText();
  assert.ok(passportText.includes("1 Oct 2026") && passportText.includes("Return date open"));
  assert.ok(!/One semester|100%/.test(passportText), "seeded completion/semester exposed");
  await chooseTab("Today");
  // "Ask" is both the Today quick-action tile and the Ask screen's submit button.
  // The tile lives inside the today screen; the submit button carries the app's
  // own `data-yep="ask"` anchor, so neither lookup is ambiguous.
  await page.locator('[data-tour-screen="today"]').getByRole("button", { name: "Ask", exact: true }).click();
  await page.getByRole("heading", { name: "Ask this Greenbook", exact: true }).waitFor();
  await page.getByPlaceholder("Ask about Singapore…").fill("How do I prepare my Student's Pass application in Singapore?");
  await page.locator('[data-yep="ask"]').getByRole("button", { name: "Ask", exact: true }).click();
  await page.getByText(/Show linked sources/).waitFor({ timeout: 120000 });
  await capture("08-real-grounded-answer-390");
  await page.getByText(/Show linked sources/).click();
  await capture("09-inspected-sources-390");
  assert.ok(await page.locator('a[href*="ica.gov.sg"]').count(), "official ICA source absent");
  await page.getByPlaceholder("Ask about Singapore…").fill("Can I do it there?");
  await page.locator('[data-yep="ask"]').getByRole("button", { name: "Ask", exact: true }).click();
  await page.getByText("Could you specify which activity or rule you mean, and where you plan to do it?", { exact: true }).waitFor();
  await capture("10-ambiguity-clarified-390");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('[data-tour-screen="today"]').waitFor({ timeout: 45000 });
  await page.waitForTimeout(500);
  assert.equal(await page.locator('[data-testid="onboarding"]').count(), 0, "journey not restored after reload");
  assert.equal(await page.locator(".yep-tour").count(), 0, "tour repeated after reload");
  await capture("11-persistence-no-repeat-390");
  for (const size of [{ width: 320, height: 568 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(size);
    for (const [tab, selector] of [["Today", '[data-tour-screen="today"]'], ["Passport", '[data-tour-screen="passport"]'], ["Lens", '[data-tour-screen="lens"]'], ["Explore", '[data-tour-screen="explore"]'], ["Connect", '[data-tour-screen="connect"]']]) {
      await chooseTab(tab);
      await page.locator(selector).waitFor();
      await capture(`12-${tab.toLowerCase()}-${size.width}`);
    }
  }
  assert.deepEqual(report.pageErrors, [], "runtime errors");
  report.status = "PASS";
  writeFileSync(`${OUT}/results.json`, JSON.stringify(report, null, 2));
  console.log(`PASS ${report.steps.length} real UI steps/captures; reload and one-time tour verified`);
} catch (error) {
  report.status = "FAIL"; report.failure = error.message;
  writeFileSync(`${OUT}/results.json`, JSON.stringify(report, null, 2));
  await page.screenshot({ path: `${OUT}/failure.png` }).catch(() => {});
  throw error;
} finally { await browser.close(); }
