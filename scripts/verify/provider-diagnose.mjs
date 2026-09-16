/**
 * Dev-only provider diagnostics.
 *
 * Calls route handlers directly so a provider rejection surfaces its raw
 * status and message instead of the sanitised client-facing error. Never
 * deployed — it exists so failures are diagnosed from evidence, not guesses.
 *
 * Usage: node scripts/verify/provider-diagnose.mjs [route ...]
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { routes } from "../../functions/ai-gateway/src/routes.js";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  if (!line || line.startsWith("#")) continue;
  const i = line.indexOf("=");
  if (i < 0) continue;
  const k = line.slice(0, i).trim();
  const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  if (k && !process.env[k]) process.env[k] = v;
}

const CONTEXT = { journey: { home: "VN", host: "MY" }, userLanguage: "vi", coachingLanguage: "vi", level: "beginner" };
const menuBase64 = (await readFile("docs/evidence/phase3/fixtures/menu-malaysia.png")).toString("base64");

const CASES = {
  "/lens/scene": { ...CONTEXT, mediaBase64: menuBase64, mimeType: "image/png", localLanguage: "ms" },
  "/lens/document": { ...CONTEXT, mediaBase64: menuBase64, mimeType: "image/png", documentKind: "image" },
  "/study/analyze": { ...CONTEXT, mode: "professor_message", text: "Submit your group report by Friday 5pm. Late submissions lose 10% per day." },
  "/transcribe": null, // built from TTS output below
  "/live/token": { ...CONTEXT, mode: "agent" },
};

async function run(route, body) {
  const started = Date.now();
  try {
    const parsed = routes[route].request.parse(body);
    const outcome = await routes[route].handler(parsed);
    const validated = routes[route].result.safeParse(outcome.data);
    if (!validated.success) {
      console.log(`  ${route}  CONTRACT FAIL  ${validated.error.issues.slice(0, 4).map((i) => `${i.path.join(".")}: ${i.message}`).join(" | ")}`);
      return;
    }
    console.log(`  ${route}  OK  provider=${outcome.provider} model=${outcome.model} schemaMode=${outcome.schemaMode ?? "-"} ${Date.now() - started}ms`);
  } catch (error) {
    console.log(`  ${route}  ERROR  name=${error.name} code=${error.code} status=${error.status} provider=${error.provider} ${Date.now() - started}ms`);
    console.log(`     message: ${error.message}`);
    if (error.detail) console.log(`     detail : ${String(error.detail).replace(/\s+/g, " ").slice(0, 500)}`);
    if (error.issues) console.log(`     zod    : ${error.issues}`);
  }
}

const requested = process.argv.slice(2);
const targets = requested.length ? requested : Object.keys(CASES);

console.log("=== provider diagnostics ===");
for (const route of targets) {
  if (route === "/transcribe") {
    try {
      const tts = routes["/tts"].handler(routes["/tts"].request.parse({ ...CONTEXT, text: "Dua bungkus, satu tak pedas.", language: "ms" }));
      const audio = await tts;
      await run("/transcribe", { ...CONTEXT, mediaBase64: audio.data.audioBase64, mimeType: audio.data.mimeType, languageHint: "ms" });
    } catch (error) {
      console.log(`  /transcribe  TTS PREREQUISITE FAILED  ${error.message}`);
    }
    continue;
  }
  if (!CASES[route]) {
    console.log(`  ${route}  (no case defined)`);
    continue;
  }
  await run(route, CASES[route]);
}
