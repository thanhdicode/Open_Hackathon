/**
 * Paced failover soak.
 *
 * Measures each capability chain provider by provider, with a real pause between
 * calls. It never blasts providers concurrently: the free tiers enforce
 * per-minute ceilings (measured: Groq qwen 8,000 TPM and a separate 1,000
 * output-tokens/minute), and a burst would report "the provider is dead" when
 * the truth is "we asked too fast".
 *
 * Also proves two behaviours that only show up over time:
 *   - a tripped provider is skipped rather than re-probed
 *   - a PAYMENT_REQUIRED provider is parked, not treated as rate-limited
 *
 * Usage: node scripts/verify/soak.mjs
 * Writes: docs/evidence/phase3/soak.json + soak-report.md
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import handler from "../../functions/ai-gateway/src/main.js";
import * as breaker from "../../functions/ai-gateway/src/breaker.js";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  if (!line || line.startsWith("#")) continue;
  const index = line.indexOf("=");
  if (index < 0) continue;
  const key = line.slice(0, index).trim();
  const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, "");
  if (key && !process.env[key]) process.env[key] = value;
}

const CONTEXT = { journey: { home: "VN", host: "MY" }, userLanguage: "vi", coachingLanguage: "vi", level: "beginner" };
const menuBase64 = readFileSync("docs/evidence/phase3/fixtures/menu-malaysia.png").toString("base64");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pacing per capability, tuned to the tightest measured ceiling. */
const PACE = {
  text: Number(process.env.SOAK_PACE_TEXT_MS || 4_000),
  interpret: Number(process.env.SOAK_PACE_INTERPRET_MS || 6_000),
  vision: Number(process.env.SOAK_PACE_VISION_MS || 45_000),
  stt: Number(process.env.SOAK_PACE_STT_MS || 4_000),
  tts: Number(process.env.SOAK_PACE_TTS_MS || 6_000),
};

const RUNS = Number(process.env.SOAK_RUNS || 3);

async function call(path, body) {
  const startedAt = Date.now();
  let captured = null;
  let status = 200;
  const res = { json: (payload, code) => { captured = payload; status = code ?? 200; return payload; } };
  await handler({ req: { path, bodyText: JSON.stringify(body) }, res, error: () => {} });
  return { path, status, ms: Date.now() - startedAt, ...captured };
}

function stats(values) {
  if (values.length === 0) return { count: 0, median: null, p95: null, min: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  return { count: sorted.length, median: at(0.5), p95: at(0.95), min: sorted[0], max: sorted[sorted.length - 1] };
}

const report = { generatedAt: new Date().toISOString(), runs: RUNS, pace: PACE, capabilities: {}, tripRecovery: {}, budget: null };

/* -------------------------------------------------------------------------- */
/* Capability sweeps                                                          */
/* -------------------------------------------------------------------------- */

async function sweep(capability, path, body, { pace, label }) {
  const samples = [];
  console.log(`\n--- ${label} (${RUNS} runs, ${pace / 1000}s apart) ---`);
  for (let index = 0; index < RUNS; index += 1) {
    if (index > 0) await wait(pace);
    const result = await call(path, body);
    const entry = {
      ok: result.ok === true,
      code: result.code ?? null,
      status: result.status,
      ms: result.ms,
      provider: result.meta?.providerUsed ?? null,
      fallbackDepth: result.meta?.fallbackDepth ?? null,
      degradedProviders: result.meta?.degradedProviders ?? [],
      stages: result.meta?.stages ?? null,
    };
    samples.push(entry);
    console.log(
      `  run ${index + 1}: ${entry.ok ? "OK  " : "FAIL"} ${String(entry.ms).padStart(6)}ms  provider=${String(entry.provider).padEnd(18)}` +
        `${entry.ok ? "" : ` code=${entry.code}`}${entry.degradedProviders.length ? ` skipped=[${entry.degradedProviders.join(",")}]` : ""}`,
    );
  }

  const ok = samples.filter((sample) => sample.ok);
  const byCode = {};
  for (const sample of samples) {
    if (sample.ok) continue;
    byCode[sample.code] = (byCode[sample.code] ?? 0) + 1;
  }
  const providersUsed = {};
  for (const sample of ok) providersUsed[sample.provider] = (providersUsed[sample.provider] ?? 0) + 1;

  const summary = {
    runs: samples.length,
    successes: ok.length,
    failures: samples.length - ok.length,
    failureCodes: byCode,
    latencyMs: stats(ok.map((sample) => sample.ms)),
    providersUsed,
    fallbackUsed: ok.filter((sample) => (sample.fallbackDepth ?? 0) > 0).length,
    samples,
  };
  report.capabilities[capability] = summary;
  console.log(
    `  => ${ok.length}/${samples.length} ok | median ${summary.latencyMs.median ?? "-"}ms | p95 ${summary.latencyMs.p95 ?? "-"}ms | providers ${JSON.stringify(providersUsed)}`,
  );
  return summary;
}

mkdirSync("docs/evidence/phase3", { recursive: true });
breaker.reset();

console.log("\n=== paced failover soak ===");

await sweep("text", "/lens/text", { ...CONTEXT, contextKey: "food", text: "Berapa bungkus?" }, { pace: PACE.text, label: "TEXT — /lens/text" });
await sweep("interpret", "/reply", { ...CONTEXT, targetLanguage: "ms", localLanguage: "ms", userIntent: "Hai phần, một phần không cay" }, { pace: PACE.interpret, label: "INTERPRET — /reply" });
await sweep("vision", "/lens/scene", { ...CONTEXT, mediaBase64: menuBase64, mimeType: "image/png", localLanguage: "ms" }, { pace: PACE.vision, label: "VISION — /lens/scene (two-stage)" });

// STT needs real audio; generate it once through the TTS chain.
const tts = await call("/tts", { ...CONTEXT, text: "Dua bungkus, satu tak pedas.", language: "ms" });
if (tts.ok) {
  report.capabilities.tts = {
    runs: 1,
    successes: 1,
    failures: 0,
    failureCodes: {},
    latencyMs: stats([tts.ms]),
    providersUsed: { [tts.meta?.providerUsed ?? "unknown"]: 1 },
    fallbackUsed: 0,
    samples: [{ ok: true, ms: tts.ms, provider: tts.meta?.providerUsed ?? null, status: tts.status }],
  };
  console.log(`\n--- TTS ---\n  ok in ${tts.ms}ms via ${tts.meta?.providerUsed}`);
  await sweep(
    "stt",
    "/transcribe",
    { ...CONTEXT, mediaBase64: tts.data.audioBase64, mimeType: tts.data.mimeType, languageHint: "ms" },
    { pace: PACE.stt, label: "STT — /transcribe" },
  );
} else {
  console.log(`\n--- TTS ---\n  FAILED ${tts.code}; STT sweep skipped (no audio to transcribe)`);
  report.capabilities.tts = { runs: 1, successes: 0, failures: 1, failureCodes: { [tts.code]: 1 }, latencyMs: stats([]), providersUsed: {}, fallbackUsed: 0, samples: [{ ok: false, code: tts.code }] };
}

/* -------------------------------------------------------------------------- */
/* Trip and recovery                                                          */
/* -------------------------------------------------------------------------- */

console.log("\n--- circuit trip and recovery ---");
breaker.reset();
breaker.trip("groq-text", 30_000);
const tripped = await call("/lens/text", { ...CONTEXT, contextKey: "food", text: "Berapa bungkus?" });
report.tripRecovery.trippedSkip = {
  ok: tripped.ok === true,
  servedBy: tripped.meta?.providerUsed ?? null,
  skipped: tripped.meta?.degradedProviders ?? [],
  passed: tripped.ok === true && (tripped.meta?.providerUsed ?? "") !== "groq-text",
};
console.log(`  tripped groq-text -> served by ${tripped.meta?.providerUsed} (skipped=[${(tripped.meta?.degradedProviders ?? []).join(",")}])`);
breaker.reset("groq-text");

// A PAYMENT_REQUIRED provider must be parked, not probed as rate-limited.
breaker.reset();
const { PROVIDERS } = await import("./../../functions/ai-gateway/src/registry.js");
const lockedId = "explabs-glm-paid";
let lockedCode = null;
try {
  await PROVIDERS[lockedId].structured({ system: "s", user: "u", timeoutMs: 20_000 });
} catch (error) {
  lockedCode = error.code;
  breaker.recordFailure(lockedId, error);
}
const lockedEntry = breaker.snapshot(lockedId);
report.tripRecovery.paymentRequired = {
  code: lockedCode,
  breakerCode: lockedEntry.lastErrorCode,
  cooldownMs: lockedEntry.cooldownMs,
  passed: lockedCode === "PAYMENT_REQUIRED" && lockedEntry.cooldownMs >= 600_000,
};
console.log(`  ${lockedId} -> code=${lockedCode} cooldown=${lockedEntry.cooldownMs}ms (must be >= 600000)`);
breaker.reset();

report.budget = (await import("../../functions/ai-gateway/src/budget.js")).budgetSnapshot();

/* -------------------------------------------------------------------------- */
/* Report                                                                     */
/* -------------------------------------------------------------------------- */

const totals = Object.values(report.capabilities).reduce(
  (accumulator, entry) => ({ runs: accumulator.runs + entry.runs, ok: accumulator.ok + entry.successes }),
  { runs: 0, ok: 0 },
);
report.summary = { ...totals, successRate: totals.runs ? Number((totals.ok / totals.runs).toFixed(3)) : 0 };

writeFileSync("docs/evidence/phase3/soak.json", JSON.stringify(report, null, 2));

const lines = [
  "# Paced failover soak",
  "",
  `Generated: ${report.generatedAt}`,
  `Runs per capability: ${RUNS}. Pace: ${JSON.stringify(PACE)} (ms between calls).`,
  "",
  "| capability | runs | ok | failure codes | median | p95 | providers used | fallbacks |",
  "|---|---|---|---|---|---|---|---|",
];
for (const [capability, entry] of Object.entries(report.capabilities)) {
  lines.push(
    `| ${capability} | ${entry.runs} | ${entry.successes} | ${Object.entries(entry.failureCodes).map(([code, count]) => `${code}×${count}`).join(", ") || "—"} | ${entry.latencyMs.median ?? "—"}ms | ${entry.latencyMs.p95 ?? "—"}ms | ${Object.entries(entry.providersUsed).map(([provider, count]) => `${provider}×${count}`).join(", ") || "—"} | ${entry.fallbackUsed} |`,
  );
}
lines.push(
  "",
  "## Circuit behaviour",
  "",
  `- tripped provider skipped: **${report.tripRecovery.trippedSkip.passed ? "PASS" : "FAIL"}** — tripped groq-text, request served by ${report.tripRecovery.trippedSkip.servedBy}`,
  `- PAYMENT_REQUIRED parked: **${report.tripRecovery.paymentRequired.passed ? "PASS" : "FAIL"}** — code=${report.tripRecovery.paymentRequired.code}, cooldown=${report.tripRecovery.paymentRequired.cooldownMs}ms`,
  "",
  "## Budget",
  "",
  "```json",
  JSON.stringify(report.budget, null, 2),
  "```",
  "",
  `Overall: ${report.summary.ok}/${report.summary.runs} successful (${Math.round(report.summary.successRate * 100)}%).`,
);
writeFileSync("docs/evidence/phase3/soak-report.md", `${lines.join("\n")}\n`);

console.log(`\n=== soak summary ===`);
console.log(`  ${report.summary.ok}/${report.summary.runs} calls succeeded (${Math.round(report.summary.successRate * 100)}%)`);
console.log(`  tripped provider skipped: ${report.tripRecovery.trippedSkip.passed ? "PASS" : "FAIL"}`);
console.log(`  PAYMENT_REQUIRED parked: ${report.tripRecovery.paymentRequired.passed ? "PASS" : "FAIL"}`);
console.log("  wrote docs/evidence/phase3/soak.json + soak-report.md");
