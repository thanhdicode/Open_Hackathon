/**
 * When does "WebSocket is already in CLOSING or CLOSED state" actually fire?
 *
 * Chromium emits that message itself when `close()` is called on a socket that is
 * already closing, and it is attributed to the Appwrite bundle because that is where
 * the call originates. The question that decides whether it is a product defect or
 * harness noise is whether ordinary navigation between tabs triggers it, or only
 * tearing the whole browser context down does.
 */
import { chromium } from "@playwright/test";
import { completeOnboarding } from "../verify/lib/onboarding.mjs";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:5173";

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();

const socketErrors = [];
page.on("console", (message) => {
  if (!/WebSocket is already in CLOSING or CLOSED/i.test(message.text())) return;
  socketErrors.push({ at: new Date().toISOString(), phase: currentPhase });
});

let currentPhase = "boot";
await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
currentPhase = "onboarding";
const onboarded = await completeOnboarding(page);
console.log("onboarded:", onboarded);

const tab = async (name) => {
  currentPhase = `tab:${name}`;
  await page.getByRole("button", { name }).first().click().catch(() => {});
  await page.waitForTimeout(3500);
  console.log(`  after ${name}: socket errors = ${socketErrors.length}`);
};

for (const name of ["Connect", "Explore", "Today", "Connect", "Explore", "Connect"]) {
  await tab(name);
}

currentPhase = "reload";
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
console.log(`  after reload: socket errors = ${socketErrors.length}`);

currentPhase = "context-close";
await context.close();

console.log("\n=== socket errors by phase ===");
const byPhase = {};
for (const entry of socketErrors) byPhase[entry.phase] = (byPhase[entry.phase] ?? 0) + 1;
console.log(JSON.stringify(byPhase, null, 1));
console.log(`total: ${socketErrors.length}`);

await browser.close();
