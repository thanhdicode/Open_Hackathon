/**
 * Phase 3.6 — Cavoti capability probe.
 *
 * Capabilities are UNKNOWN until a real request succeeds. This probes the
 * actual account and the actual serving IDs, one call at a time, and records
 * HTTP status, latency, the model the gateway actually served, the response
 * shape, usage, and whether the modality was genuinely accepted.
 *
 * Cavoti is a shared aggregator with limited free throughput, so calls are
 * sequential with a pause between them. No parallel spam.
 *
 * Usage: node scripts/verify/cavoti-probe.mjs
 * Writes: docs/evidence/phase3/cavoti-matrix.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { pcmToWav } from "../../functions/ai-gateway/src/audio.js";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  if (!line || line.startsWith("#")) continue;
  const index = line.indexOf("=");
  if (index < 0) continue;
  const key = line.slice(0, index).trim();
  const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, "");
  if (key && !process.env[key]) process.env[key] = value;
}

const BASE = process.env.CAVOTI_BASE_URL;
const KEY = process.env.CAVOTI_API_KEY;
const PACE_MS = Number(process.env.CAVOTI_PACE_MS || 2500);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CANDIDATES = [
  { id: "mimo-v2.5", role: "rescue-primary", expect: ["text", "image", "audio"] },
  { id: "qwen-3.8-flash", role: "vision-fallback", expect: ["text", "image"] },
  { id: "qwen3.8-flash", role: "vision-fallback-alt", expect: ["text", "image"] },
  { id: "glm-5.3-flash", role: "vision-candidate", expect: ["text", "image"] },
  { id: "minimax-m3", role: "vision-candidate", expect: ["text", "image"] },
  { id: "deepseek-v4-flash-0731", role: "text-candidate", expect: ["text"] },
  { id: "hy3", role: "unknown", expect: ["text"] },
];

mkdirSync("docs/evidence/phase3", { recursive: true });
const menuBase64 = readFileSync("docs/evidence/phase3/fixtures/menu-malaysia.png").toString("base64");

/* ------------------------- audio fixture via Cloudflare -------------------- */

const AUDIO_FIXTURE = "docs/evidence/phase3/fixtures/spoken-malay.wav";
const SPOKEN_TEXT = "Dua bungkus, satu tak pedas. Terima kasih.";

async function cloudflareTts() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) return null;
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/myshell-ai/melotts`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: SPOKEN_TEXT, lang: "ms" }),
      signal: AbortSignal.timeout(60_000),
    });
    const payload = await response.json();
    if (!payload.success || !payload.result?.audio) return null;
    return { buffer: Buffer.from(payload.result.audio, "base64"), source: "cloudflare-melotts" };
  } catch {
    return null;
  }
}

async function geminiTts() {
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: SPOKEN_TEXT }] }],
        generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } } },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const inline = (payload.candidates?.[0]?.content?.parts ?? []).find((part) => part.inlineData)?.inlineData;
    if (!inline?.data) return null;
    // Gemini returns headerless PCM; wrap it so the fixture is a real audio file.
    const buffer = pcmToWav(Buffer.from(inline.data, "base64"), { sampleRate: 24_000 });
    return { buffer, source: "gemini-tts (wrapped to WAV)" };
  } catch {
    return null;
  }
}

async function ensureAudioFixture() {
  if (existsSync(AUDIO_FIXTURE)) {
    const existing = readFileSync(AUDIO_FIXTURE);
    console.log(`  audio fixture: reusing ${AUDIO_FIXTURE} (${Math.round(existing.length / 1024)} kB)`);
    return existing;
  }
  const generated = (await cloudflareTts()) ?? (await geminiTts());
  if (!generated) {
    console.log("  audio fixture: UNAVAILABLE — no TTS provider produced audio, so the audio probe cannot run");
    return null;
  }
  writeFileSync(AUDIO_FIXTURE, generated.buffer);
  console.log(`  audio fixture: written via ${generated.source} (${Math.round(generated.buffer.length / 1024)} kB)`);
  return generated.buffer;
}

/* --------------------------------- probing -------------------------------- */

const results = [];

/**
 * One probe, with a bounded retry for the transient gateway 503.
 *
 * Cavoti reports "Gateway capacity is temporarily exhausted; retry shortly"
 * with a 503. That is a capacity condition, not a capability rejection, so it
 * must not be recorded as "this model cannot see images".
 */
async function probe(model, modality, body, note, { retries = 2 } = {}) {
  let entry = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    entry = await probeOnce(model, modality, body, note);
    entry.attempts = attempt + 1;
    const transient = entry.httpStatus === 503 || entry.httpStatus === 429;
    if (!transient || attempt === retries) return entry;
    await wait(4000);
  }
  return entry;
}

/**
 * Detect a refusal that arrives as HTTP 200.
 *
 * Cavoti models answer a modality they cannot handle with a normal completion
 * that says so, e.g. "Unsupported content type - this model only supports text
 * input". Counting that as a pass would be reporting DONE because the gateway
 * returned 200, which is exactly the mistake to avoid.
 */
const REFUSAL_PATTERNS = [
  /unsupported content type/i,
  /does not support audio/i,
  /only supports text input/i,
  /vision is disabled/i,
  /i don'?t see any audio/i,
  /cannot process/i,
  /not support(ed)? (audio|image|vision)/i,
];

function detectRefusal(content) {
  if (typeof content !== "string") return null;
  for (const pattern of REFUSAL_PATTERNS) {
    const match = pattern.exec(content);
    if (match) return match[0];
  }
  return null;
}

async function probeOnce(model, modality, body, note) {
  const startedAt = Date.now();
  const entry = { model, modality, httpStatus: null, latencyMs: null, servedModel: null, accepted: false, shape: null, usage: null, error: null, note };
  try {
    const response = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model, temperature: 0.2, max_tokens: 400, ...body }),
      signal: AbortSignal.timeout(90_000),
    });
    entry.httpStatus = response.status;
    entry.latencyMs = Date.now() - startedAt;
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      entry.error = `non-JSON body: ${text.slice(0, 120).replace(/\s+/g, " ")}`;
    }
    if (!response.ok) {
      entry.error = payload?.error ? String(payload.error.message ?? JSON.stringify(payload.error)).slice(0, 200) : text.slice(0, 160);
      entry.accepted = false;
      return entry;
    }
    entry.servedModel = payload?.model ?? null;
    entry.usage = payload?.usage ?? null;
    const content = payload?.choices?.[0]?.message?.content;
    entry.shape = typeof content === "string" ? `string(${content.length})` : content === undefined ? "missing" : typeof content;
    entry.content = typeof content === "string" ? content.slice(0, 300) : undefined;

    // A 200 is not an acceptance. A refusal phrased as an answer is a rejection.
    const refusal = detectRefusal(content);
    if (refusal) {
      entry.refusedAsText = refusal;
      entry.accepted = false;
      entry.error = `refused in content: "${refusal}"`;
      return entry;
    }
    entry.accepted = typeof content === "string" && content.length > 0;
    return entry;
  } catch (error) {
    entry.latencyMs = Date.now() - startedAt;
    entry.error = `${error.name}: ${error.message}`.slice(0, 160);
    return entry;
  }
}

console.log("\n=== Cavoti capability probe ===\n");
console.log(`base: ${BASE.replace(/\/\/.*@/, "//")} | key present: ${Boolean(KEY)} | candidates: ${CANDIDATES.length}\n`);

console.log("--- audio fixture ---");
const audioBuffer = await ensureAudioFixture();

for (const candidate of CANDIDATES) {
  console.log(`\n--- ${candidate.id} (${candidate.role}) ---`);

  const text = await probe(candidate.id, "text", { messages: [{ role: "user", content: "Reply with the single word ok." }] });
  results.push({ ...text, role: candidate.role, expected: candidate.expect });
  console.log(`  text   HTTP ${text.httpStatus} ${text.latencyMs}ms served=${text.servedModel ?? "-"} ${text.accepted ? "ACCEPTED" : "REJECTED"}${text.error ? ` :: ${text.error}` : ""}`);
  await wait(PACE_MS);

  // Image only where the text probe already proved the model answers at all.
  if (text.accepted) {
    const image = await probe(candidate.id, "image", {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Read the largest heading in this image. Reply with just that text." },
            { type: "image_url", image_url: { url: `data:image/png;base64,${menuBase64}` } },
          ],
        },
      ],
    });
    results.push({ ...image, role: candidate.role, expected: candidate.expect });
    console.log(`  image  HTTP ${image.httpStatus} ${image.latencyMs}ms served=${image.servedModel ?? "-"} ${image.accepted ? "ACCEPTED" : "REJECTED"}${image.error ? ` :: ${image.error}` : ""}`);
    if (image.content) console.log(`         -> ${image.content.replace(/\s+/g, " ").slice(0, 90)}`);
    await wait(PACE_MS);

    if (audioBuffer) {
      const audio = await probe(candidate.id, "audio", {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Transcribe this audio. Reply with only the transcript." },
              { type: "input_audio", input_audio: { data: audioBuffer.toString("base64"), format: "wav" } },
            ],
          },
        ],
      });
      results.push({ ...audio, role: candidate.role, expected: candidate.expect });
      console.log(`  audio  HTTP ${audio.httpStatus} ${audio.latencyMs}ms served=${audio.servedModel ?? "-"} ${audio.accepted ? "ACCEPTED" : "REJECTED"}${audio.error ? ` :: ${audio.error}` : ""}`);
      if (audio.content) console.log(`         -> ${audio.content.replace(/\s+/g, " ").slice(0, 90)}`);
      await wait(PACE_MS);
    }
  }
}

/* --------------------------------- summary -------------------------------- */

const accepted = results.filter((entry) => entry.accepted);

/** Why a modality did not succeed — a capacity error is not a capability verdict. */
function verdictFor(rows) {
  if (!rows.length) return "not-probed";
  if (rows.some((row) => row.accepted)) return "verified";
  const statuses = rows.map((row) => row.httpStatus);
  if (statuses.includes(402)) return "unavailable-on-plan (balance required)";
  const refusal = rows.find((row) => row.refusedAsText)?.refusedAsText;
  if (refusal) return `refused in content ("${refusal}") — HTTP 200 is not an acceptance`;
  if (statuses.every((status) => status === 503)) return "gateway-capacity (capability unproven)";
  if (statuses.includes(400)) return "rejected by provider (HTTP 400)";
  return `rejected (HTTP ${statuses.join("/")})`;
}

const capabilities = {};
for (const candidate of CANDIDATES) {
  const rows = results.filter((entry) => entry.model === candidate.id);
  const modality = (name) => rows.filter((row) => row.modality === name);
  capabilities[candidate.id] = {
    role: candidate.role,
    text: modality("text").some((row) => row.accepted),
    image: modality("image").some((row) => row.accepted),
    audio: modality("audio").some((row) => row.accepted),
    textVerdict: verdictFor(modality("text")),
    imageVerdict: verdictFor(modality("image")),
    audioVerdict: verdictFor(modality("audio")),
    servedModel: rows.find((row) => row.servedModel)?.servedModel ?? null,
    latencyMs: Object.fromEntries(modality("text").map((row) => ["text", row.latencyMs])),
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  baseUrl: BASE,
  audioFixture: audioBuffer ? `${AUDIO_FIXTURE} (${audioBuffer.length} bytes, generated by Cloudflare melotts)` : "unavailable",
  summary: { probes: results.length, accepted: accepted.length },
  capabilities,
  probes: results,
};
writeFileSync("docs/evidence/phase3/cavoti-matrix.json", JSON.stringify(report, null, 2));

console.log("\n=== measured capability matrix ===");
console.log("  model                  text   image  audio   served id");
for (const [id, cap] of Object.entries(capabilities)) {
  console.log(`  ${id.padEnd(22)} ${String(cap.text).padEnd(6)} ${String(cap.image).padEnd(6)} ${String(cap.audio).padEnd(7)} ${cap.servedModel ?? "-"}`);
}
console.log("\n=== why each modality did or did not pass ===");
for (const [id, cap] of Object.entries(capabilities)) {
  console.log(`  ${id}`);
  console.log(`     text : ${cap.textVerdict}`);
  console.log(`     image: ${cap.imageVerdict}`);
  console.log(`     audio: ${cap.audioVerdict}`);
}
console.log(`\n${accepted.length}/${results.length} probes accepted — wrote docs/evidence/phase3/cavoti-matrix.json`);
const usable = Object.entries(capabilities).filter(([, cap]) => cap.text || cap.image || cap.audio);
console.log(`models with at least one verified capability: ${usable.map(([id]) => id).join(", ") || "(none)"}`);
