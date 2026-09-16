/**
 * Isolate the on-device OCR failure.
 *
 * Runs Tesseract directly in the browser, with no app code in the path, so a
 * failure is attributable to the environment rather than to our integration.
 * Also reports the CDN requests it makes, because a blocked worker or wasm
 * download looks identical to "OCR is just slow" from the outside.
 *
 * Usage: BASE_URL=http://127.0.0.1:5173 node scripts/verify/ocr-isolate.mjs
 */
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:5173";
const FIXTURE = "docs/evidence/phase3/fixtures/menu-malaysia.png";

async function attempt(label, { headless, timeoutMs = 120_000 }) {
  const browser = await chromium.launch({ headless });
  const page = await browser.newPage();
  const requests = [];
  const failures = [];
  page.on("request", (request) => {
    if (/tesseract|traineddata|jsdelivr|unpkg/i.test(request.url())) requests.push(request.url().slice(0, 110));
  });
  page.on("requestfailed", (request) => failures.push(`${request.url().slice(0, 90)} — ${request.failure()?.errorText}`));

  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  const startedAt = Date.now();
  const outcome = await page
    .evaluate(
      async ({ base64, timeoutMs: limit }) => {
        const load = (src) =>
          new Promise((resolve, reject) => {
            const element = document.createElement("script");
            element.src = src;
            element.onload = resolve;
            element.onerror = () => reject(new Error(`script failed: ${src}`));
            document.head.appendChild(element);
          });
        try {
          await load("/node_modules/tesseract.js/dist/tesseract.min.js");
        } catch (cause) {
          return { stage: "script", error: cause.message };
        }
        if (typeof window.Tesseract === "undefined") return { stage: "script", error: "Tesseract global missing" };

        const work = (async () => {
          const worker = await window.Tesseract.createWorker(["eng"], 1, {});
          try {
            const { data } = await worker.recognize(`data:image/png;base64,${base64}`);
            return { stage: "done", text: (data.text || "").slice(0, 200), lines: (data.lines || []).length };
          } finally {
            await worker.terminate().catch(() => {});
          }
        })();

        const timeout = new Promise((resolve) => setTimeout(() => resolve({ stage: "timeout" }), limit));
        try {
          return await Promise.race([work, timeout]);
        } catch (cause) {
          return { stage: "error", error: cause.message };
        }
      },
      { base64: readFileSync(FIXTURE).toString("base64"), timeoutMs },
    )
    .catch((cause) => ({ stage: "evaluate", error: cause.message.slice(0, 200) }));

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n--- ${label} (headless=${headless}) ---`);
  console.log(`  outcome : ${outcome.stage} after ${seconds}s${outcome.error ? ` — ${outcome.error}` : ""}`);
  if (outcome.text !== undefined) console.log(`  text    : ${JSON.stringify(outcome.text.slice(0, 120))} (${outcome.lines} lines)`);
  console.log(`  requests: ${requests.length} OCR-related`);
  requests.slice(0, 5).forEach((url) => console.log(`     ${url}`));
  if (failures.length) {
    console.log("  FAILED requests:");
    [...new Set(failures)].slice(0, 5).forEach((line) => console.log(`     ${line}`));
  }
  await browser.close();
  return outcome;
}

mkdirSync("docs/evidence/phase3", { recursive: true });

const headless = await attempt("headless Chromium", { headless: true });
const headed = process.env.SKIP_HEADED ? null : await attempt("headed Chromium", { headless: false });

writeFileSync(
  "docs/evidence/phase3/ocr-isolation.json",
  JSON.stringify({ generatedAt: new Date().toISOString(), headless, headed, note: "Tesseract run directly in the browser with no app code in the path." }, null, 2),
);
console.log("\nwrote docs/evidence/phase3/ocr-isolation.json");
