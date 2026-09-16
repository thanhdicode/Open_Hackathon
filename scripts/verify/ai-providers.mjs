/**
 * Phase 3 provider capability matrix.
 *
 * Runs every ai-gateway route against the real providers with safe, synthetic
 * input and records measured evidence. Nothing here is mocked: a route that
 * fails is recorded as failed.
 *
 * Usage: node scripts/verify/ai-providers.mjs
 * Writes: docs/evidence/phase3/provider-matrix.json
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import handler from "../../functions/ai-gateway/src/main.js";

/* ------------------------------- env -------------------------------------- */

function loadEnvLocal() {
  let text = "";
  try {
    text = readFileSync(path.resolve(".env.local"), "utf8");
  } catch {
    console.error(".env.local not found — cannot run real provider verification.");
    process.exit(1);
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !process.env[key]) process.env[key] = value;
  }
}
loadEnvLocal();

/* ------------------------------ harness ----------------------------------- */

async function call(route, body) {
  const startedAt = Date.now();
  let captured = null;
  let status = 200;
  const res = { json: (payload, code) => { captured = payload; status = code ?? 200; return payload; } };
  await handler({ req: { path: route, bodyText: JSON.stringify(body) }, res, error: () => {} });
  return { route, status, ms: Date.now() - startedAt, ...captured };
}

const results = [];
const checks = [];

function record(name, pass, detail) {
  const entry = { name, pass: Boolean(pass), ...detail };
  checks.push(entry);
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail.note ? ` — ${detail.note}` : ""}`);
}

/* -------------------------------- main ------------------------------------ */

const JOURNEY = { home: "VN", host: "MY", city: "Kuala Lumpur", university: "Universiti Malaya" };
const CONTEXT = { journey: JOURNEY, userLanguage: "vi", coachingLanguage: "vi", level: "beginner" };

async function main() {
  await mkdir("docs/evidence/phase3", { recursive: true });

  console.log("\n=== 1. health ===");
  const health = await call("/health", {});
  record("health", health.ok === true, { route: "/health", status: health.status, ms: health.ms, providers: health.data?.providers });
  if (!health.data?.providers?.gemini?.configured || !health.data?.providers?.groq?.configured) {
    console.error("A provider key is missing. Aborting — the matrix would be meaningless.");
    process.exit(1);
  }

  console.log("\n=== 2. /lens/text (Groq primary) ===");
  const lensText = await call("/lens/text", { ...CONTEXT, contextKey: "food", text: "Berapa bungkus?" });
  record("lens/text", lensText.ok === true, {
    route: "/lens/text",
    status: lensText.status,
    ms: lensText.ms,
    provider: lensText.meta?.provider,
    model: lensText.meta?.model,
    attempts: lensText.meta?.attempts,
    note: lensText.ok ? `intents=${lensText.data.likelyIntents.length} replies=${lensText.data.suggestedReplies.length} risk=${lensText.data.misunderstandingRisk}` : `${lensText.code}: ${lensText.message}`,
    sample: lensText.ok ? { literalMeaning: lensText.data.literalMeaning, recommendedAction: lensText.data.recommendedAction } : undefined,
  });
  results.push(lensText);

  console.log("\n=== 3. /lens/scene (Gemini 3.8 Flash, real image) ===");
  const menu = await readFile("docs/evidence/phase3/fixtures/menu-malaysia.png");
  const menuBase64 = menu.toString("base64");
  const scene = await call("/lens/scene", { ...CONTEXT, mediaBase64: menuBase64, mimeType: "image/png", localLanguage: "ms", captureSource: "camera" });
  const boxes = scene.ok ? scene.data.regions.map((region) => region.box) : [];
  const boxesInRange = boxes.every((box) => [box.ymin, box.xmin, box.ymax, box.xmax].every((value) => Number.isInteger(value) && value >= 0 && value <= 1000) && box.ymin < box.ymax && box.xmin < box.xmax);
  record("lens/scene", scene.ok === true && scene.data.regions.length > 0 && boxesInRange, {
    route: "/lens/scene",
    status: scene.status,
    ms: scene.ms,
    provider: scene.meta?.provider,
    model: scene.meta?.model,
    note: scene.ok ? `regions=${scene.data.regions.length} boxesInRange=${boxesInRange} kind=${scene.data.sceneKind} langs=${scene.data.detectedLanguages.join(",")}` : `${scene.code}: ${scene.message}`,
    sample: scene.ok
      ? {
          sceneSummary: scene.data.sceneSummary,
          safetyNotice: scene.data.safetyNotice,
          firstRegions: scene.data.regions.slice(0, 4).map((region) => ({ label: region.label, originalText: region.originalText, translatedText: region.translatedText, box: region.box, uncertainty: region.uncertainty })),
          usefulPhrases: scene.data.usefulPhrases.slice(0, 2),
        }
      : undefined,
  });
  results.push(scene);

  console.log("\n=== 4. /reply (Vietnamese intent -> Malay) ===");
  const reply = await call("/reply", { ...CONTEXT, targetLanguage: "ms", localLanguage: "ms", userIntent: "Hai phần, một phần không cay", situation: "Ordering nasi lemak at a stall" });
  record("reply", reply.ok === true && reply.data.variants.length > 0, {
    route: "/reply",
    status: reply.status,
    ms: reply.ms,
    provider: reply.meta?.provider,
    model: reply.meta?.model,
    note: reply.ok ? `variants=${reply.data.variants.length}` : `${reply.code}: ${reply.message}`,
    sample: reply.ok ? reply.data.variants[0] : undefined,
  });
  results.push(reply);

  console.log("\n=== 5. /tone-check ===");
  const tone = await call("/tone-check", { ...CONTEXT, targetLanguage: "en", text: "Give me extension for assignment now.", situation: "Email to a lecturer" });
  record("tone-check", tone.ok === true, {
    route: "/tone-check",
    status: tone.status,
    ms: tone.ms,
    provider: tone.meta?.provider,
    model: tone.meta?.model,
    note: tone.ok ? `register=${tone.data.register} issues=${tone.data.issues.length}` : `${tone.code}: ${tone.message}`,
  });
  results.push(tone);

  console.log("\n=== 6. /coach (Context Coach) ===");
  const coach = await call("/coach", {
    ...CONTEXT,
    localLanguage: "ms",
    transcript: "SELLER: Berapa bungkus?\n[student has not replied yet]",
  });
  record("coach", coach.ok === true && Boolean(coach.data.whatUserNeedsToDecide), {
    route: "/coach",
    status: coach.status,
    ms: coach.ms,
    provider: coach.meta?.provider,
    model: coach.meta?.model,
    note: coach.ok ? `decision="${coach.data.whatUserNeedsToDecide}" options=${coach.data.safeReplyOptions.length}` : `${coach.code}: ${coach.message}`,
    sample: coach.ok ? coach.data : undefined,
  });
  results.push(coach);

  console.log("\n=== 7. /sim/start ===");
  const scenario = await call("/sim/start", { ...CONTEXT, targetLanguage: "ms", domain: "food", goal: "Order two packs of nasi lemak, one not spicy" });
  record("sim/start", scenario.ok === true && scenario.data.maxTurns >= 3, {
    route: "/sim/start",
    status: scenario.status,
    ms: scenario.ms,
    provider: scenario.meta?.provider,
    model: scenario.meta?.model,
    note: scenario.ok ? `persona=${scenario.data.persona.name} turns=${scenario.data.maxTurns} difficulty=${scenario.data.difficulty}` : `${scenario.code}: ${scenario.message}`,
    sample: scenario.ok ? scenario.data : undefined,
  });
  results.push(scenario);

  if (scenario.ok) {
    console.log("\n=== 8. /sim/turn (dynamic reaction) ===");
    const turn = await call("/sim/turn", {
      ...CONTEXT,
      scenario: scenario.data,
      turnIndex: 1,
      transcript: `PERSONA: ${scenario.data.openingLine.text}\nUSER: Dua bungkus, satu tak pedas.`,
    });
    record("sim/turn", turn.ok === true, {
      route: "/sim/turn",
      status: turn.status,
      ms: turn.ms,
      provider: turn.meta?.provider,
      model: turn.meta?.model,
      note: turn.ok ? `progress=${turn.data.goalProgress} shouldEnd=${turn.data.shouldEnd}` : `${turn.code}: ${turn.message}`,
      sample: turn.ok ? turn.data : undefined,
    });
    results.push(turn);

    console.log("\n=== 9. /sim/finish (validated feedback) ===");
    const feedback = await call("/sim/finish", {
      ...CONTEXT,
      scenario: scenario.data,
      isRetry: false,
      transcript: [
        `PERSONA: ${scenario.data.openingLine.text}`,
        "USER: Dua bungkus, satu tak pedas.",
        "PERSONA: Nak bungkus ke makan sini?",
        "USER: Bungkus. Terima kasih.",
      ].join("\n"),
    });
    const dimensions = feedback.ok ? Object.keys(feedback.data.scores) : [];
    const frozen = ["languageClarity", "tone", "intentRecognition", "contextAwareness", "adaptability", "confidence"];
    const matchesFrozen = frozen.every((key) => dimensions.includes(key)) && dimensions.length === frozen.length;
    record("sim/finish", feedback.ok === true && matchesFrozen, {
      route: "/sim/finish",
      status: feedback.status,
      ms: feedback.ms,
      provider: feedback.meta?.provider,
      model: feedback.meta?.model,
      note: feedback.ok ? `dimensions=${dimensions.length} matchesFrozenSchema=${matchesFrozen}` : `${feedback.code}: ${feedback.message}`,
      sample: feedback.ok ? feedback.data : undefined,
    });
    results.push(feedback);
  }

  console.log("\n=== 10. /study/analyze (professor message) ===");
  const study = await call("/study/analyze", {
    ...CONTEXT,
    mode: "professor_message",
    text: "Dear students, please submit your group report by Friday 5pm. Late submissions will lose 10% per day. Make sure all group members sign the contribution form.",
  });
  record("study/analyze", study.ok === true, {
    route: "/study/analyze",
    status: study.status,
    ms: study.ms,
    provider: study.meta?.provider,
    model: study.meta?.model,
    note: study.ok ? `sections=${study.data.sections?.length ?? 0} actionItems=${study.data.actionItems?.length ?? 0}` : `${study.code}: ${study.message}`,
  });
  results.push(study);

  console.log("\n=== 11. /tts (Gemini 3.1 Flash TTS -> playable WAV) ===");
  const tts = await call("/tts", { ...CONTEXT, text: "Dua bungkus, satu tak pedas.", language: "ms" });
  const isPlayable = tts.ok === true && /^audio\//.test(tts.data.mimeType);
  record("tts", isPlayable, {
    route: "/tts",
    status: tts.status,
    ms: tts.ms,
    provider: tts.meta?.provider,
    model: tts.meta?.model,
    note: tts.ok ? `mimeType=${tts.data.mimeType} bytes=${Math.round((tts.data.audioBase64.length * 3) / 4)}` : `${tts.code}: ${tts.message}`,
  });
  results.push(tts);

  console.log("\n=== 12. /transcribe (round trip on the generated audio) ===");
  if (tts.ok) {
    const stt = await call("/transcribe", { ...CONTEXT, mediaBase64: tts.data.audioBase64, mimeType: tts.data.mimeType, languageHint: "ms" });
    record("transcribe", stt.ok === true, {
      route: "/transcribe",
      status: stt.status,
      ms: stt.ms,
      provider: stt.meta?.provider,
      model: stt.meta?.model,
      note: stt.ok ? `detected=${stt.data.primaryLanguage} segments=${stt.data.segments.length} transcript="${stt.data.transcript.slice(0, 60)}"` : `${stt.code}: ${stt.message}`,
    });
    results.push(stt);
  } else {
    record("transcribe", false, { route: "/transcribe", note: "skipped — no TTS audio to transcribe" });
  }

  console.log("\n=== 13. /live/token (agent) ===");
  const agentToken = await call("/live/token", { ...CONTEXT, mode: "agent" });
  record("live/token agent", agentToken.ok === true && Boolean(agentToken.data?.token), {
    route: "/live/token",
    status: agentToken.status,
    ms: agentToken.ms,
    provider: agentToken.meta?.provider,
    model: agentToken.meta?.model,
    note: agentToken.ok ? `model=${agentToken.data.model} tokenPrefix=${agentToken.data.token.slice(0, 6)}… expires=${agentToken.data.expiresAt}` : `${agentToken.code}: ${agentToken.message}`,
  });
  results.push(agentToken);

  console.log("\n=== 14. /live/token (translate, vi) ===");
  const translateToken = await call("/live/token", { ...CONTEXT, mode: "translate", targetLanguage: "vi" });
  record("live/token translate", translateToken.ok === true, {
    route: "/live/token",
    status: translateToken.status,
    ms: translateToken.ms,
    provider: translateToken.meta?.provider,
    model: translateToken.meta?.model,
    note: translateToken.ok ? `model=${translateToken.data.model}` : `${translateToken.code}: ${translateToken.message}`,
  });
  results.push(translateToken);

  console.log("\n=== 15. /live/token (Tetum must be refused, not degraded) ===");
  const tetum = await call("/live/token", { ...CONTEXT, mode: "translate", targetLanguage: "tet" });
  record("live/token tetum gate", tetum.status === 422 && tetum.code === "LANGUAGE_UNSUPPORTED", {
    route: "/live/token",
    status: tetum.status,
    ms: tetum.ms,
    note: `${tetum.code} fallbackOptions=${JSON.stringify(tetum.fallback?.options)}`,
  });
  results.push(tetum);

  console.log("\n=== 16. no secret or raw media may leave the gateway ===");
  const serialised = JSON.stringify(results);
  const leaks = [
    process.env.GEMINI_API_KEY && serialised.includes(process.env.GEMINI_API_KEY) ? "gemini key" : null,
    process.env.GROQ_API_KEY && serialised.includes(process.env.GROQ_API_KEY) ? "groq key" : null,
    serialised.includes(menuBase64.slice(0, 200)) ? "raw image echoed" : null,
    /"reasoning"\s*:/.test(serialised) ? "reasoning trace" : null,
  ].filter(Boolean);
  record("response hygiene", leaks.length === 0, { note: leaks.length ? `LEAKS: ${leaks.join(", ")}` : "no key, no raw media, no reasoning trace" });

  const matrix = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    summary: {
      total: checks.length,
      passed: checks.filter((check) => check.pass).length,
      failed: checks.filter((check) => !check.pass).map((check) => check.name),
    },
    checks,
  };
  await writeFile("docs/evidence/phase3/provider-matrix.json", JSON.stringify(matrix, null, 2));
  console.log(`\nwrote docs/evidence/phase3/provider-matrix.json — ${matrix.summary.passed}/${matrix.summary.total} passed`);
  if (matrix.summary.failed.length) console.log(`failed: ${matrix.summary.failed.join(", ")}`);
}

main().catch((error) => {
  console.error("provider verification crashed:", error);
  process.exitCode = 1;
});
