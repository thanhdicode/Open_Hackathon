/**
 * Phase 3.6 — Scene Lens across three real images, with Gemini disabled.
 *
 * Runs each fixture through the real /lens/scene route with Gemini's circuit
 * forced open, and validates the full SceneLens contract: summary, OCR text,
 * translations, objects, regions with normalized boxes, confidence,
 * uncertainty and the safety notice.
 *
 * Paced, because Cavoti is a shared aggregator and Groq qwen allows only 1,000
 * output tokens per minute.
 *
 * Usage: node scripts/verify/scene-lens-3.mjs
 * Writes: docs/evidence/phase3/scene-lens-3.json
 */
import { readFileSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import handler from "../../functions/ai-gateway/src/main.js";
import * as breaker from "../../functions/ai-gateway/src/breaker.js";
import { sceneResult } from "../../functions/ai-gateway/src/contracts.js";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  if (!line || line.startsWith("#")) continue;
  const index = line.indexOf("=");
  if (index < 0) continue;
  const key = line.slice(0, index).trim();
  const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, "");
  if (key && !process.env[key]) process.env[key] = value;
}

const CONTEXT = { journey: { home: "VN", host: "MY" }, userLanguage: "vi", coachingLanguage: "vi", level: "beginner" };
// Groq qwen allows 1,000 output tokens per minute and one Scene Lens response is
// most of that, so roughly one image per minute is the real ceiling.
const PACE_MS = Number(process.env.SCENE_PACE_MS || 65_000);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FIXTURES = [
  { id: "A-menu-malaysia", file: "docs/evidence/phase3/fixtures/menu-malaysia.png", localLanguage: "ms", describes: "Malaysian food menu" },
  { id: "B-campus-singapore", file: "docs/evidence/phase3/fixtures/campus-singapore.png", localLanguage: "en", describes: "Singapore campus notice (English + Malay + Mandarin)" },
  { id: "C-mixed-chat", file: "docs/evidence/phase3/fixtures/mixed-chat.png", localLanguage: "ms", describes: "screenshot with mixed English/local text" },
];

async function call(path, body) {
  const startedAt = Date.now();
  let captured = null;
  let status = 200;
  const res = { json: (payload, code) => { captured = payload; status = code ?? 200; return payload; } };
  await handler({ req: { path, bodyText: JSON.stringify(body) }, res, error: () => {} });
  return { path, status, ms: Date.now() - startedAt, ...captured };
}

await mkdir("docs/evidence/phase3", { recursive: true });

console.log("\n=== Scene Lens across three real images (Gemini disabled) ===\n");
breaker.reset();
// Force Gemini's circuit open: nothing below may depend on it.
breaker.trip("gemini", 300_000);
console.log("  gemini circuit: OPEN (forced)\n");

const rows = [];

for (const [index, fixture] of FIXTURES.entries()) {
  if (index > 0) await wait(PACE_MS);
  const base64 = (await readFile(fixture.file)).toString("base64");
  console.log(`--- ${fixture.id} (${fixture.describes}) ---`);
  const result = await call("/lens/scene", { ...CONTEXT, mediaBase64: base64, mimeType: "image/png", localLanguage: fixture.localLanguage });

  if (!result.ok) {
    console.log(`  FAIL  ${result.code}: ${result.message}`);
    console.log(`        attempted=${JSON.stringify(result.attempted)}`);
    rows.push({ id: fixture.id, describes: fixture.describes, pass: false, code: result.code, attempted: result.attempted });
    continue;
  }

  const contract = sceneResult.safeParse(result.data);
  const boxes = result.data.regions.map((region) => region.box);
  const boxesValid = boxes.every((box) => [box.ymin, box.xmin, box.ymax, box.xmax].every((value) => Number.isInteger(value) && value >= 0 && value <= 1000) && box.ymin < box.ymax && box.xmin < box.xmax);
  const withText = result.data.regions.filter((region) => region.originalText).length;
  const withTranslation = result.data.regions.filter((region) => region.translatedText).length;
  const passed = contract.success && boxesValid && result.data.regions.length > 0 && Boolean(result.data.safetyNotice);

  console.log(`  ${passed ? "PASS" : "FAIL"}  provider=${result.meta.providerUsed} ${result.meta.latencyMs}ms fallbackDepth=${result.meta.fallbackDepth}`);
  console.log(`        contract=${contract.success} regions=${result.data.regions.length} boxesValid=${boxesValid} withOcr=${withText} withTranslation=${withTranslation}`);
  console.log(`        langs=${result.data.detectedLanguages.join(",")} kind=${result.data.sceneKind} confidence=${result.data.confidence.label}`);
  console.log(`        summary: ${result.data.sceneSummary.slice(0, 150)}`);
  console.log(`        safety : ${result.data.safetyNotice.slice(0, 150)}`);
  const sample = result.data.regions.filter((region) => region.originalText).slice(0, 4).map((region) => `${region.originalText}${region.translatedText ? ` -> ${region.translatedText.slice(0, 40)}` : ""}`);
  if (sample.length) console.log(`        ocr    : ${sample.join(" | ")}`);

  rows.push({
    id: fixture.id,
    describes: fixture.describes,
    pass: passed,
    provider: result.meta.providerUsed,
    model: result.meta.model,
    latencyMs: result.meta.latencyMs,
    fallbackDepth: result.meta.fallbackDepth,
    degradedProviders: result.meta.degradedProviders,
    contractValid: contract.success,
    regions: result.data.regions.length,
    boxesValid,
    regionsWithOcr: withText,
    regionsWithTranslation: withTranslation,
    detectedLanguages: result.data.detectedLanguages,
    sceneKind: result.data.sceneKind,
    confidence: result.data.confidence,
    sceneSummary: result.data.sceneSummary,
    safetyNotice: result.data.safetyNotice,
    uncertaintyNotes: result.data.uncertaintyNotes,
    sampleRegions: result.data.regions.slice(0, 6).map((region) => ({ label: region.label, originalText: region.originalText, translatedText: region.translatedText, box: region.box, uncertainty: region.uncertainty })),
  });
}

breaker.reset("gemini");

const passed = rows.filter((row) => row.pass).length;
const cavotiServed = rows.filter((row) => row.provider?.startsWith("cavoti")).length;
const geminiUsed = rows.filter((row) => row.provider === "gemini").length;

/**
 * Keep every run, and the best result ever seen per image.
 *
 * Verification consumes the free tier, so a later run can fail purely because an
 * earlier one used the budget. Recording history stops a genuine pass from being
 * erased by a rate-limited run, without pretending the later run passed.
 */
let history = [];
try {
  history = JSON.parse(await readFile("docs/evidence/phase3/scene-lens-3.json", "utf8")).runs ?? [];
} catch {
  history = [];
}
history.push({ runAt: new Date().toISOString(), passed, total: rows.length, servedByCavoti: cavotiServed, servedByGemini: geminiUsed, rows });

const bestEver = {};
for (const run of history) {
  for (const row of run.rows) {
    if (!bestEver[row.id] || row.pass) bestEver[row.id] = { ...row, runAt: run.runAt };
  }
}
const bestPassed = Object.values(bestEver).filter((row) => row.pass).length;

await writeFile(
  "docs/evidence/phase3/scene-lens-3.json",
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      geminiDisabled: true,
      latest: { total: rows.length, passed, servedByCavoti: cavotiServed, servedByGemini: geminiUsed },
      bestEver,
      bestEverPassed: bestPassed,
      runs: history,
    },
    null,
    2,
  ),
);

console.log(`\n=== summary ===`);
console.log(`  this run: ${passed}/${rows.length} images passed the full SceneLens contract with Gemini disabled`);
console.log(`  served by a Cavoti route this run: ${cavotiServed}/${rows.length}`);
console.log(`  served by Gemini this run: ${geminiUsed} (must be 0)`);
console.log(`  best ever across ${history.length} run(s): ${bestPassed}/${Object.keys(bestEver).length}`);
for (const [id, row] of Object.entries(bestEver)) {
  if (row.pass) console.log(`    passed: ${id} — ${row.provider} ${row.latencyMs}ms regions=${row.regions}`);
}
console.log("  wrote docs/evidence/phase3/scene-lens-3.json");
if (bestPassed !== Object.keys(bestEver).length) process.exitCode = 1;
