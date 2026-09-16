import { z } from "zod";
import * as C from "./contracts.js";
import * as T from "./prompts.js";
import * as breaker from "./breaker.js";
import {
  ProviderError,
  normalizeProviderError,
  stripNulls,
  cavotiModel,
  CAVOTI_MODELS,
  explabsLuna,
  explabsDeepseek,
  explabsQwenPaid,
  explabsGlmPaid,
  openRouterLing,
  openRouterDots,
  groqText,
  groqVision,
  groqWhisper,
  cloudflareText,
  cloudflareVision,
  cloudflareWhisper,
  gemini,
  openRouter,
} from "./providers.js";
import { maySpendPaid, budgetSnapshot, recordRefusal } from "./budget.js";

/**
 * Capability registry and failover.
 *
 * Gemini is deliberately NOT the load-bearing provider for any capability.
 * Google's free tier returned 429/503 intermittently through the whole build, so
 * it sits behind Groq for text and vision and behind Groq for speech.
 *
 * A provider that is in cooldown is skipped entirely rather than retried: a
 * rate-limited provider must not receive new user traffic.
 */

/**
 * Cavoti is a shared aggregator, so each model gets its own provider id and
 * therefore its own circuit: one Cavoti model being rate limited must not
 * disable the others. Only the gateway itself being down affects them together.
 *
 * `capabilities` reflects MEASURED probe evidence, not the model name or the
 * vendor's marketing. Verified 2026-09-16 (docs/evidence/phase3/cavoti-matrix.json):
 *
 *   text   : qwen3.8-flash, glm-5.3-flash, minimax-m3, deepseek-v4-flash-0731, hy3
 *   vision : qwen3.8-flash, glm-5.3-flash, hy3   (all three read a real menu photo)
 *   audio  : NONE — every candidate either returned 400 or refused inside a
 *            HTTP 200 body ("Unsupported content type … only supports text input")
 *
 * mimo-v2.5 and qwen-3.8-flash return 402 "primary balance is not positive
 * enough", so they stay in the chain but park their own circuit.
 */
const CAVOTI = {
  mimo: cavotiModel({ id: "cavoti-mimo", label: "Cavoti MiMo V2.5", model: CAVOTI_MODELS.mimo, capabilities: ["text", "vision"] }),
  qwen: cavotiModel({ id: "cavoti-qwen", label: "Cavoti Qwen 3.8 Flash", model: CAVOTI_MODELS.qwen, capabilities: ["text", "vision"] }),
  glm: cavotiModel({ id: "cavoti-glm", label: "Cavoti GLM 5.3 Flash", model: CAVOTI_MODELS.glm, capabilities: ["text", "vision"] }),
  minimax: cavotiModel({ id: "cavoti-minimax", label: "Cavoti MiniMax M3", model: CAVOTI_MODELS.minimax, capabilities: ["text"] }),
  deepseek: cavotiModel({ id: "cavoti-deepseek", label: "Cavoti DeepSeek V4 Flash", model: CAVOTI_MODELS.deepseek, capabilities: ["text"] }),
  hy3: cavotiModel({ id: "cavoti-hy3", label: "Cavoti Hy3", model: CAVOTI_MODELS.hy3, capabilities: ["text", "vision"] }),
};

export const PROVIDERS = {
  "groq-text": groqText,
  "groq-vision": groqVision,
  "groq-whisper": groqWhisper,
  "cloudflare-text": cloudflareText,
  "cloudflare-vision": cloudflareVision,
  "cloudflare-whisper": cloudflareWhisper,
  gemini,
  openrouter: openRouter,
  "openrouter-ling": openRouterLing,
  "openrouter-dots": openRouterDots,
  "cavoti-mimo": CAVOTI.mimo,
  "cavoti-qwen": CAVOTI.qwen,
  "cavoti-glm": CAVOTI.glm,
  "cavoti-minimax": CAVOTI.minimax,
  "cavoti-deepseek": CAVOTI.deepseek,
  "cavoti-hy3": CAVOTI.hy3,
  "explabs-luna": explabsLuna,
  "explabs-deepseek": explabsDeepseek,
  "explabs-qwen-paid": explabsQwenPaid,
  "explabs-glm-paid": explabsGlmPaid,
};

/**
 * Ordered failover chains per capability, organised as TIERS.
 *
 *   tier 1  free primary      — measured fastest reliable option
 *   tier 2  independent free  — a different vendor, so one outage cannot take both
 *   tier 3  cheap rescue      — Cavoti / Cloudflare / Gemini
 *   tier 4  local             — handled in the browser, not here
 *
 * Gemini is not load-bearing anywhere. Ordering follows MEASURED latency, not
 * the vendor list. See docs/evidence/phase3/*.json.
 */
export const CHAINS = {
  text: ["groq-text", "explabs-luna", "explabs-deepseek", "groq-vision", "cavoti-qwen", "cavoti-glm", "cavoti-hy3", "cavoti-mimo", "cavoti-minimax", "cavoti-deepseek", "openrouter-ling", "cloudflare-text", "gemini", "explabs-qwen-paid", "openrouter"],
  // Stage A only: observation. Short output, so it fits every provider's budget.
  // Verified free vision: groq-vision 3.1-4.7s, explabs-luna 2.2s,
  // openrouter-ling 3.5s, openrouter-dots 5.0s.
  visual: ["groq-vision", "explabs-luna", "openrouter-ling", "openrouter-dots", "cavoti-qwen", "cavoti-glm", "cavoti-hy3", "cavoti-mimo", "cloudflare-vision", "gemini", "explabs-qwen-paid", "openrouter"],
  // Kept for any caller still asking for a full scene in one shot.
  vision: ["groq-vision", "explabs-luna", "openrouter-ling", "cavoti-glm", "cavoti-qwen", "cavoti-hy3", "cavoti-mimo", "cloudflare-vision", "gemini", "openrouter"],
  stt: ["groq-whisper", "cloudflare-whisper"],
  tts: ["gemini"],
  /**
   * Stage B (interpretation) has its own order, by MEASURED latency.
   *
   * Measured 2026-09-16 on the small interpretation contract: groq-vision 1.3s,
   * explabs-luna 8.4s, explabs-deepseek 26.9s, cavoti-qwen 83.2s. cavoti-glm
   * failed that run and groq-text cannot produce the JSON at all.
   *
   * Splitting Stage B into a small contract is what made this a chain instead of
   * a single provider: before the split only cavoti-glm could serve it, which
   * was a fresh single point of failure.
   */
  interpret: ["groq-vision", "explabs-luna", "explabs-deepseek", "cavoti-qwen", "cavoti-glm", "cavoti-hy3", "groq-text", "gemini", "cloudflare-text", "explabs-qwen-paid", "openrouter"],
};

/**
 * Maximum remote attempts per user action.
 *
 * A long waterfall is the reason a demo hangs: eight providers each failing
 * slowly compounds into tens of seconds. The normal path gets two attempts; the
 * rescue allowance is opt-in so a demo can widen it deliberately.
 */
const MAX_ATTEMPTS = {
  text: Number(process.env.AI_MAX_ATTEMPTS_TEXT || 3),
  visual: Number(process.env.AI_MAX_ATTEMPTS_VISUAL || 2),
  vision: Number(process.env.AI_MAX_ATTEMPTS_VISUAL || 2),
  interpret: Number(process.env.AI_MAX_ATTEMPTS_INTERPRET || 4),
};

/**
 * Per-capability wall-clock budget for one request.
 *
 * A long chain of slow failures compounds: one measured Scene Lens call took
 * 111s because four providers each failed slowly in turn. A bounded deadline
 * turns that into either a fast success or a fast, honest failure.
 */
const CHAIN_DEADLINE_MS = {
  vision: Number(process.env.AI_VISION_DEADLINE_MS || 75_000),
  text: Number(process.env.AI_TEXT_DEADLINE_MS || 60_000),
};

/** Health keys match the /health contract. */
const HEALTH_KEYS = {
  "groq-text": "groqText",
  "groq-vision": "groqVision",
  "groq-whisper": "groqStt",
  "cloudflare-text": "cloudflareText",
  "cloudflare-vision": "cloudflareVision",
  "cloudflare-whisper": "cloudflareStt",
  gemini: "gemini",
  openrouter: "openrouter",
  "openrouter-ling": "openrouterLing",
  "explabs-luna": "explabsLuna",
  "explabs-deepseek": "explabsDeepseek",
  "explabs-qwen-paid": "explabsQwenPaid",
  "explabs-glm-paid": "explabsGlmPaid",
  "openrouter-dots": "openrouterDots",
  "cavoti-mimo": "cavotiMimo",
  "cavoti-qwen": "cavotiQwen",
  "cavoti-glm": "cavotiGlm",
  "cavoti-minimax": "cavotiMinimax",
  "cavoti-deepseek": "cavotiDeepseek",
  "cavoti-hy3": "cavotiHy3",
};

export const PROVIDER_JSON_SCHEMA = Object.fromEntries(
  Object.entries(C.contracts).map(([name, schema]) => [name, z.toJSONSchema(schema, { io: "output" })]),
);

/* -------------------------------------------------------------------------- */
/* Request budget                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Bounds outbound concurrency inside one function instance.
 *
 * A single user action is already one inference, but several users (or a soak
 * test) can arrive together, and free tiers enforce TPM as well as RPM. Queuing
 * is better than a burst that trips every provider at once.
 */
const MAX_CONCURRENT = Math.max(1, Number(process.env.AI_MAX_CONCURRENT || 4));
const QUEUE_TIMEOUT_MS = Number(process.env.AI_QUEUE_TIMEOUT_MS || 20000);

let active = 0;
const waiting = [];

function release() {
  active -= 1;
  const next = waiting.shift();
  if (next) {
    active += 1;
    next.resolve();
  }
}

async function acquire() {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return;
  }
  await new Promise((resolve, reject) => {
    const entry = { resolve, reject };
    const timer = setTimeout(() => {
      const index = waiting.indexOf(entry);
      if (index >= 0) waiting.splice(index, 1);
      reject(new ProviderError("queue:timeout", { provider: "internal", code: "AI_UNAVAILABLE" }));
    }, QUEUE_TIMEOUT_MS);
    entry.resolve = () => {
      clearTimeout(timer);
      resolve();
    };
    waiting.push(entry);
  });
}

export function concurrencySnapshot() {
  return { active, queued: waiting.length, max: MAX_CONCURRENT };
}

/* -------------------------------------------------------------------------- */
/* Failover                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Call one provider and validate its output against the route contract.
 *
 * A schema-invalid response gets exactly one repair retry on the SAME provider
 * (the provider answered, it just answered wrong). If it is still invalid the
 * chain moves to the next provider — it never loops on a broken provider.
 */
async function inferStructured(provider, { schemaName, resultSchema, buildPrompt, media, timeoutMs }) {
  let repair = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { system, user } = buildPrompt();
    const outcome = await provider.structured({
      system,
      user,
      jsonSchema: PROVIDER_JSON_SCHEMA[schemaName],
      repair,
      media,
      timeoutMs,
    });
    // Strict structured output expresses optional fields as nullable, so a
    // returned null is mapped back to "absent" before validation. This never
    // substitutes a value: a null on a required field still fails Zod.
    const parsed = resultSchema.safeParse(stripNulls(outcome.value));
    if (parsed.success) {
      return { data: parsed.data, model: outcome.model, schemaMode: outcome.schemaMode, repairs: attempt };
    }
    repair = T.repairInstruction(
      parsed.error.issues
        .slice(0, 12)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; "),
    );
  }
  throw new ProviderError(`schema:${schemaName}`, { provider: provider.id, code: "SCHEMA_INVALID" });
}

/**
 * Walk the capability chain until one provider returns a contract-valid result.
 * Records every skip and failure so the caller can report provider-neutral
 * telemetry without leaking a raw provider error to the client.
 */
export async function executeStructured({ capability, schemaName, resultSchema, buildPrompt, media, timeoutMs, deadlineMs, maxAttempts: attemptOverride }) {
  const chain = CHAINS[capability];
  if (!chain) throw new ProviderError(`unknown-capability:${capability}`, { provider: "internal", code: "NOT_CONFIGURED" });

  // Fail fast on a malformed prompt. Without this a prompt builder that forgets
  // `user` sends an undefined message body and every provider answers 400, which
  // looks like a provider outage instead of a bug in our own code.
  const probe = buildPrompt();
  if (typeof probe?.system !== "string" || !probe.system.trim()) throw new Error(`route ${schemaName}: buildPrompt must return a non-empty system message`);
  if (typeof probe?.user !== "string" || !probe.user.trim()) throw new Error(`route ${schemaName}: buildPrompt must return a non-empty user message`);

  const startedAt = Date.now();
  const deadline = startedAt + (deadlineMs ?? CHAIN_DEADLINE_MS[capability] ?? 90_000);
  const maxAttempts = attemptOverride ?? MAX_ATTEMPTS[capability] ?? 3;
  const skipped = [];
  const tried = [];

  await acquire();
  try {
    for (const providerId of chain) {
      const provider = PROVIDERS[providerId];
      if (!provider) continue;
      if (!provider.configured()) {
        skipped.push({ provider: providerId, reason: "unconfigured" });
        continue;
      }
      // Bound the waterfall: a long chain of slow failures is what makes a
      // demo appear to hang. Local fallback covers the rest.
      if (tried.length >= maxAttempts) {
        skipped.push({ provider: providerId, reason: "attempt-budget" });
        continue;
      }
      // A paid rescue provider may only run when the free paths failed AND the
      // budget allows it. This is the only place credits can be spent.
      if (provider.paid) {
        const decision = maySpendPaid(0);
        if (!decision.allowed) {
          recordRefusal();
          skipped.push({ provider: providerId, reason: "budget", detail: decision.reason });
          continue;
        }
      }
      const gate = breaker.gate(providerId);
      if (!gate.allowed) {
        skipped.push({ provider: providerId, reason: "cooldown", retryAfterSeconds: gate.retryAfterSeconds });
        continue;
      }
      // Do not start an attempt we cannot finish inside the request budget.
      const remaining = deadline - Date.now();
      if (remaining < 5_000) {
        skipped.push({ provider: providerId, reason: "chain-deadline" });
        continue;
      }

      try {
        const outcome = await inferStructured(provider, {
          schemaName,
          resultSchema,
          buildPrompt,
          media,
          // Bound by the request budget, the caller's timeout, and any
          // provider-specific cap (a provider known to be slow on this task
          // should fail fast rather than eat the whole chain deadline).
          timeoutMs: Math.min(timeoutMs ?? 60_000, remaining, provider.attemptTimeoutMs ?? Number.POSITIVE_INFINITY),
        });
        breaker.recordSuccess(providerId);
        return {
          ...outcome,
          provider: providerId,
          fallbackDepth: tried.length,
          skipped,
          attempted: tried,
          latencyMs: Date.now() - startedAt,
        };
      } catch (cause) {
        const error = normalizeProviderError(cause, providerId);
        breaker.recordFailure(providerId, error);
        tried.push({ provider: providerId, code: error.code, status: error.status });
      }
    }
  } finally {
    release();
  }

  const error = new ProviderError("chain-exhausted", {
    provider: tried[tried.length - 1]?.provider ?? "none",
    code: tried.some((entry) => entry.code === "RATE_LIMITED") ? "RATE_LIMITED" : "AI_UNAVAILABLE",
  });
  error.attempted = tried;
  error.skipped = skipped;
  throw error;
}

/** Walk the STT chain. Returns the provider's raw transcript payload. */
export async function executeTranscribe({ buffer, mimeType, language, timeoutMs }) {
  const startedAt = Date.now();
  const skipped = [];
  const tried = [];

  await acquire();
  try {
    for (const providerId of CHAINS.stt) {
      const provider = PROVIDERS[providerId];
      if (!provider.configured()) {
        skipped.push({ provider: providerId, reason: "unconfigured" });
        continue;
      }
      const gate = breaker.gate(providerId);
      if (!gate.allowed) {
        skipped.push({ provider: providerId, reason: "cooldown", retryAfterSeconds: gate.retryAfterSeconds });
        continue;
      }
      try {
        const outcome = await provider.transcribe({ buffer, mimeType, language, timeoutMs });
        breaker.recordSuccess(providerId);
        return { ...outcome, provider: providerId, fallbackDepth: tried.length, skipped, attempted: tried, latencyMs: Date.now() - startedAt };
      } catch (cause) {
        const error = normalizeProviderError(cause, providerId);
        breaker.recordFailure(providerId, error);
        tried.push({ provider: providerId, code: error.code, status: error.status });
      }
    }
  } finally {
    release();
  }

  const error = new ProviderError("stt-chain-exhausted", { provider: "none", code: "AI_UNAVAILABLE" });
  error.attempted = tried;
  error.skipped = skipped;
  throw error;
}

/** Walk the TTS chain. Failure here must never fail the conversation. */
export async function executeSpeech({ text, voiceName, timeoutMs }) {
  const tried = [];
  await acquire();
  try {
    for (const providerId of CHAINS.tts) {
      const provider = PROVIDERS[providerId];
      if (!provider.configured() || typeof provider.speak !== "function") continue;
      const gate = breaker.gate(providerId);
      if (!gate.allowed) {
        tried.push({ provider: providerId, code: "COOLDOWN" });
        continue;
      }
      try {
        const outcome = await provider.speak({ text, voiceName, timeoutMs });
        breaker.recordSuccess(providerId);
        return { ...outcome, provider: providerId, fallbackDepth: tried.length, attempted: tried };
      } catch (cause) {
        const error = normalizeProviderError(cause, providerId);
        breaker.recordFailure(providerId, error);
        tried.push({ provider: providerId, code: error.code, status: error.status });
      }
    }
  } finally {
    release();
  }
  const error = new ProviderError("tts-chain-exhausted", { provider: "none", code: "AI_UNAVAILABLE" });
  error.attempted = tried;
  throw error;
}

/* -------------------------------------------------------------------------- */
/* Health                                                                     */
/* -------------------------------------------------------------------------- */

export function healthReport() {
  const providers = {};
  for (const [providerId, key] of Object.entries(HEALTH_KEYS)) {
    const provider = PROVIDERS[providerId];
    const health = breaker.healthOf(providerId, { configured: provider?.configured() ?? false });
    providers[key] = {
      state: health.state,
      lastSuccessfulAt: health.lastSuccessfulAt,
      ...(health.retryAfterSeconds ? { retryAfterSeconds: health.retryAfterSeconds } : {}),
      ...(health.lastErrorCode ? { lastErrorCode: health.lastErrorCode } : {}),
      ...(health.consecutiveFailures ? { consecutiveFailures: health.consecutiveFailures } : {}),
      ...(health.reason ? { reason: health.reason } : {}),
      model: provider?.model?.(),
      /** Capability flags come from probe evidence, never from a model name. */
      capabilities: provider?.capabilities ?? [],
      audio: Boolean(provider?.audio),
    };
  }
  return { providers, chains: CHAINS, concurrency: concurrencySnapshot(), budget: budgetSnapshot() };
}
