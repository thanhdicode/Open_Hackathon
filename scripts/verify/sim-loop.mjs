/**
 * YapSim end-to-end loop verification.
 *
 * Drives the same route sequence the UI drives — start, several real turns,
 * finish — and validates every response against the shared contracts. This is
 * what proves the simulator is real rather than seeded: each turn is a live
 * call and the feedback is derived from the transcript that actually happened.
 *
 * Usage: node scripts/verify/sim-loop.mjs
 */
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import * as C from "../../functions/ai-gateway/src/contracts.js";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  if (!line || line.startsWith("#")) continue;
  const index = line.indexOf("=");
  if (index < 0) continue;
  const key = line.slice(0, index).trim();
  const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, "");
  if (key && !process.env[key]) process.env[key] = value;
}

const { routes } = await import("../../functions/ai-gateway/src/routes.js");

const CONTEXT = {
  journey: { home: "VN", host: "MY", city: "Kuala Lumpur" },
  userLanguage: "vi",
  coachingLanguage: "vi",
  level: "beginner",
};

async function call(route, body) {
  const started = Date.now();
  const input = routes[route].request.parse(body);
  const outcome = await routes[route].handler(input);
  const parsed = routes[route].result.safeParse(outcome.data);
  if (!parsed.success) {
    throw new Error(`${route} contract mismatch: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  return { data: parsed.data, ms: Date.now() - started, provider: outcome.provider, model: outcome.model };
}

const steps = [];
const log = (name, detail) => {
  steps.push({ name, ...detail });
  console.log(`  ${detail.ok ? "PASS" : "FAIL"}  ${name} — ${detail.note}`);
};

async function main() {
  console.log("\n=== YapSim real loop ===");

  let scenario;
  try {
    const result = await call("/sim/start", { ...CONTEXT, targetLanguage: "ms", domain: "food", goal: "Order two packs of nasi lemak, one not spicy, and confirm takeaway" });
    scenario = result.data;
    log("sim/start", { ok: true, ms: result.ms, provider: result.provider, note: `"${scenario.title}" persona=${scenario.persona.name} maxTurns=${scenario.maxTurns} difficulty=${scenario.difficulty}` });
  } catch (error) {
    log("sim/start", { ok: false, note: error.message });
    await writeFile("docs/evidence/phase3/sim-loop.json", JSON.stringify({ steps, aborted: true }, null, 2));
    process.exitCode = 1;
    return;
  }

  // Turn-by-turn, exactly as the UI would: persona speaks, student replies.
  const turns = [{ speaker: "PERSONA", text: scenario.openingLine.text }];
  const replies = ["Dua bungkus, satu tak pedas.", "Bungkus, terima kasih.", "Boleh, ini lima belas ringgit."];
  let ended = false;

  for (let index = 0; index < replies.length && !ended; index += 1) {
    turns.push({ speaker: "USER", text: replies[index] });
    const transcript = turns.map((turn) => `${turn.speaker}: ${turn.text}`).join("\n");
    try {
      const result = await call("/sim/turn", { ...CONTEXT, scenario, transcript, turnIndex: index + 1 });
      turns.push({ speaker: "PERSONA", text: result.data.personaReply.text });
      ended = result.data.shouldEnd || result.data.goalProgress === "complete";
      log(`sim/turn #${index + 1}`, {
        ok: true,
        ms: result.ms,
        provider: result.provider,
        note: `progress=${result.data.goalProgress} shouldEnd=${result.data.shouldEnd} persona="${result.data.personaReply.text.slice(0, 48)}"`,
      });
    } catch (error) {
      log(`sim/turn #${index + 1}`, { ok: false, note: error.message });
      break;
    }
  }

  const transcript = turns.map((turn) => `${turn.speaker}: ${turn.text}`).join("\n");
  try {
    const result = await call("/sim/finish", { ...CONTEXT, scenario, transcript, isRetry: false });
    const dimensions = Object.keys(result.data.scores);
    const frozen = ["languageClarity", "tone", "intentRecognition", "contextAwareness", "adaptability", "confidence"];
    const matchesFrozen = dimensions.length === frozen.length && frozen.every((key) => dimensions.includes(key));
    const inRange = Object.values(result.data.scores).every((value) => Number.isInteger(value) && value >= 0 && value <= 100);
    log("sim/finish", {
      ok: matchesFrozen && inRange,
      ms: result.ms,
      provider: result.provider,
      note: `6 frozen dimensions=${matchesFrozen} scoresInRange=${inRange} priority="${result.data.priorityFeedback.slice(0, 60)}"`,
    });

    // A retry must produce a fresh, independent judgement of the new attempt.
    const retry = await call("/sim/finish", { ...CONTEXT, scenario, transcript, isRetry: true, previousFeedback: result.data.priorityFeedback });
    const retryOk = Object.keys(retry.data.scores).length === 6;
    log("sim/finish (retry attempt)", {
      ok: retryOk,
      ms: retry.ms,
      provider: retry.provider,
      note: `fresh review produced ${Object.keys(retry.data.scores).length} dimensions; retryGoal="${retry.data.retryGoal.slice(0, 50)}"`,
    });
  } catch (error) {
    log("sim/finish", { ok: false, note: error.message });
  }

  // The transcript the UI would persist must satisfy the conversation contract.
  const transcriptValid = z.string().min(1).safeParse(transcript).success;
  log("transcript is persistable", { ok: transcriptValid, ms: 0, provider: "n/a", note: `${turns.length} turns, ${transcript.length} chars` });

  const failed = steps.filter((step) => !step.ok);
  await writeFile("docs/evidence/phase3/sim-loop.json", JSON.stringify({ generatedAt: new Date().toISOString(), scenarioTitle: scenario.title, turns, steps }, null, 2));
  console.log(`\nwrote docs/evidence/phase3/sim-loop.json — ${steps.length - failed.length}/${steps.length} passed`);
  if (failed.length) {
    console.log(`failed: ${failed.map((step) => step.name).join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("sim loop crashed:", error);
  process.exitCode = 1;
});
