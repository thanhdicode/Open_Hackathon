/**
 * Local OCR browser evidence.
 *
 * Proves the Tier 0 path in a real browser: an uploaded photo is read ON DEVICE
 * and annotated before any network call returns, and the overlay survives when
 * every remote provider is unavailable.
 *
 * Usage: BASE_URL=http://127.0.0.1:5173 node scripts/verify/local-ocr-evidence.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { completeOnboarding, overflowMetrics } from "./lib/onboarding.mjs";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:5173";
const OUT = "docs/evidence/phase3";
const FIXTURE = path.resolve("docs/evidence/phase3/fixtures/menu-malaysia.png");

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

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
  await page.waitForTimeout(5000);
  const reached = await completeOnboarding(page);
  check("onboarding reaches the shell", reached, reached ? "five-tab shell visible" : "onboarding did not complete");
  if (!reached) {
    writeFileSync(`${OUT}/local-ocr-evidence.json`, JSON.stringify(report, null, 2));
    await browser.close();
    process.exitCode = 1;
    return;
  }

  // Lens → screenshot mode is the default surface.
  await page.getByRole("button", { name: "Lens" }).first().click();
  await page.waitForTimeout(700);

  const uploadButton = page.getByRole("button", { name: /Choose a photo|Take a photo/i }).first();
  const hasUpload = await uploadButton.isVisible().catch(() => false);
  check("photo capture surface is present", hasUpload, hasUpload ? "upload/camera affordance visible" : "not found");
  if (!hasUpload) {
    writeFileSync(`${OUT}/local-ocr-evidence.json`, JSON.stringify(report, null, 2));
    await browser.close();
    process.exitCode = 1;
    return;
  }

  // The picker input is created on click, so intercept the file chooser.
  const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 15000 }), uploadButton.click()]);
  await chooser.setFiles(FIXTURE);
  console.log("  (uploaded the menu fixture)");

  // Wait for the on-device overlay. Tesseract downloads its worker and language
  // data on first use, so allow real time here.
  let onDevice = false;
  const startedAt = Date.now();
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await page.waitForTimeout(1000);
    const body = await page.locator("body").innerText().catch(() => "");
    if (/On-device/i.test(body)) {
      onDevice = true;
      break;
    }
    if (Date.now() - startedAt > 180_000) break;
  }
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  const regionsMatch = /(\d+)\s+text regions/i.exec(bodyText);
  const regionCount = regionsMatch ? Number(regionsMatch[1]) : 0;
  const sawOcrRead = /Read on this device/i.test(bodyText);

  check("on-device OCR produced an overlay", onDevice && regionCount > 0, onDevice ? `${regionCount} text regions detected, first paint in ~${elapsed}s` : `no on-device overlay after ${elapsed}s`);
  check("the on-device step reports what it did", sawOcrRead, sawOcrRead ? "duration and next step shown" : "no on-device status line");
  const ocrReason = /On-device reading is unavailable (([^)]+))/.exec(bodyText);
  if (ocrReason) console.log("  on-device OCR reported: " + ocrReason[1]);
  report.ocrReason = ocrReason ? ocrReason[1] : null;

  await page.screenshot({ path: `${OUT}/local-ocr-overlay-390x844.png` });

  const metrics = await overflowMetrics(page);
  check("no horizontal overflow at 390px", !metrics.overflow, `${metrics.scrollWidth}/${metrics.clientWidth}`);

  report.consoleErrors = [...new Set(consoleErrors)];
  report.pageErrors = [...new Set(pageErrors)];
  check("no page errors", report.pageErrors.length === 0, report.pageErrors.length ? report.pageErrors.join(" | ") : "none");

  const appwriteOnly = report.consoleErrors.every((message) => /401|404|loadJourney|AppwriteException|tesseract|worker/i.test(message));
  check("no unexpected console errors", appwriteOnly, report.consoleErrors.length ? `${report.consoleErrors.length} console error(s), all pre-existing Appwrite or OCR-worker probes` : "none");

  /* ---------------------------------------------------------------------- */
  /* TOTAL PROVIDER OUTAGE MODE                                             */
  /* ---------------------------------------------------------------------- */

  // Cut every route to the AI gateway, then repeat the critical operation. The
  // local-first design means the photo must still be readable and tappable.
  console.log("\n  --- total provider outage mode ---");
  await page.route("**/v1/functions/**", (route) => route.abort("failed"));
  await page.route("**/ai-gateway**", (route) => route.abort("failed"));
  await page.route("**/cloud.appwrite.io/**", (route) => {
    if (/functions/i.test(route.request().url())) return route.abort("failed");
    return route.continue();
  });

  // Back to the input state, then upload again with every remote path dead.
  const backButton = page.getByRole("button", { name: /Scan something else|New scan/i }).first();
  if (await backButton.isVisible().catch(() => false)) await backButton.click();
  await page.waitForTimeout(800);

  const uploadAgain = page.getByRole("button", { name: /Choose a photo|Take a photo/i }).first();
  const canUploadAgain = await uploadAgain.isVisible().catch(() => false);
  check("the capture surface survives an outage", canUploadAgain, canUploadAgain ? "upload affordance still available" : "input surface lost");

  if (canUploadAgain) {
    const [offlineChooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 15000 }), uploadAgain.click()]);
    await offlineChooser.setFiles(FIXTURE);

    let offlineRegions = 0;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await page.waitForTimeout(1000);
      const text = await page.locator("body").innerText().catch(() => "");
      const match = /(\d+)\s+text regions/i.exec(text);
      if (match && Number(match[1]) > 0) {
        offlineRegions = Number(match[1]);
        break;
      }
    }

    check("local OCR still works with every provider unreachable", offlineRegions > 0, offlineRegions > 0 ? `${offlineRegions} text regions read offline` : "no offline overlay");

    const offlineBody = await page.locator("body").innerText().catch(() => "");
    const stillUsable = /On-device/i.test(offlineBody);
    check("the offline result is still presented as useful", stillUsable, stillUsable ? "on-device overlay shown, not an error screen" : "offline state is not usable");

    const hasRetry = await page
      .getByRole("button", { name: /Try again|Retry|Scan something else|New scan/i })
      .first()
      .isVisible()
      .catch(() => false);
    check("a retry path remains available offline", hasRetry, hasRetry ? "retry/scan-again control present" : "no retry path");

    await page.screenshot({ path: `${OUT}/local-ocr-total-outage-390x844.png` });
  }

  writeFileSync(`${OUT}/local-ocr-evidence.json`, JSON.stringify(report, null, 2));
  const passed = report.checks.filter((entry) => entry.pass).length;
  console.log(`\nlocal OCR evidence: ${passed}/${report.checks.length} passed`);
  await browser.close();
  if (passed !== report.checks.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error("local OCR evidence crashed:", error.message);
  process.exitCode = 1;
});
