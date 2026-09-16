import { recordCost } from "./budget.js";

/**
 * Provider adapters.
 *
 * Every vendor is exposed through the same small interface so the failover
 * chain is provider-agnostic:
 *
 *   structured({ system, user, jsonSchema, repair, media, timeoutMs })
 *   transcribe({ buffer, mimeType, language, timeoutMs })
 *   speak({ text, voiceName, timeoutMs })
 *
 * A provider declares which capabilities it can serve. Nothing here decides
 * routing or retries — that is registry.js. Nothing here invents missing fields;
 * validation lives in routes.js.
 */

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GROQ_BASE = "https://api.groq.com/openai/v1";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";


export class ProviderError extends Error {
  constructor(message, { status, provider, code, headers } = {}) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.status = status;
    this.headers = headers;
    this.code = code ?? (status === 402 ? "PAYMENT_REQUIRED" : status === 429 ? "RATE_LIMITED" : status && status < 500 ? "PROVIDER_REJECTED" : "AI_UNAVAILABLE");
    // A billing refusal is permanent until someone adds balance: never retry it.
    this.retryable = status === 429 || status === undefined || status >= 500;
  }
}

export const AI_ERROR_CODES = new Set([
  "RATE_LIMITED",
  "AI_UNAVAILABLE",
  "AI_EMPTY",
  "PROVIDER_REJECTED",
  "PAYMENT_REQUIRED",
  "SCHEMA_INVALID",
  "NOT_CONFIGURED",
  "EMPTY_TRANSCRIPT",
  "INVALID_FILE",
  "FILE_TOO_LARGE",
  "UNSUPPORTED_MEDIA",
]);

/**
 * Normalise anything thrown by fetch or a provider into a ProviderError with a
 * known code. An AbortSignal timeout surfaces as a DOMException whose numeric
 * `code` (23) would otherwise leak into the API response.
 */
export function normalizeProviderError(cause, provider) {
  if (cause instanceof ProviderError) return cause;
  const name = cause?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    const error = new ProviderError(`${provider}:timeout`, { provider, code: "AI_UNAVAILABLE" });
    error.detail = "The provider did not respond before the deadline.";
    return error;
  }
  const error = new ProviderError(`${provider}:${cause?.message ?? "unknown"}`, { provider, code: "AI_UNAVAILABLE" });
  error.detail = cause?.message;
  return error;
}

async function guard(provider, promise) {
  try {
    return await promise;
  } catch (cause) {
    throw normalizeProviderError(cause, provider);
  }
}

async function fail(response, provider) {
  let detail = "";
  try {
    detail = (await response.text()).slice(0, 300);
  } catch {
    /* body already consumed */
  }
  const error = new ProviderError(`${provider}:${response.status}`, { status: response.status, provider, headers: response.headers });
  error.detail = detail;
  throw error;
}

/**
 * Parse a provider's JSON reply.
 *
 * Models sometimes wrap the object in a markdown fence or in a sentence of
 * prose ("Here is the JSON you asked for: {...}"). Measured: Experiential Luna
 * does this intermittently, which made a whole vision stage look unreliable.
 * The object is still there, so extract it rather than discarding the response.
 */
function parseJsonLoose(text, provider) {
  const raw = String(text ?? "").trim();
  const unfenced = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

  try {
    return JSON.parse(unfenced);
  } catch {
    /* fall through to extraction */
  }

  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(unfenced.slice(start, end + 1));
    } catch {
      /* genuinely malformed */
    }
  }

  throw new ProviderError(`${provider}:invalid-json`, { provider, code: "SCHEMA_INVALID" });
}

/**
 * Drop JSON Schema keywords a provider rejects. `$schema` and `format` are
 * declarations rather than constraints, and Zod validates the real contract
 * afterwards, so removing them loses no enforcement.
 */
export function sanitizeForProvider(schema) {
  if (Array.isArray(schema)) return schema.map(sanitizeForProvider);
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$schema" || key === "format" || key === "$id" || key === "$comment") continue;
    out[key] = sanitizeForProvider(value);
  }
  return out;
}

/** Build the OpenAI-compatible user content, optionally with an image. */
function openAiContent(user, media) {
  if (!media) return user;
  return [
    { type: "text", text: user },
    { type: "image_url", image_url: { url: `data:${media.mimeType};base64,${media.base64}` } },
  ];
}

/**
 * Rewrite a JSON Schema into the shape strict structured-output modes require.
 *
 * Groq (like OpenAI) rejects a strict schema whose `required` omits any key in
 * `properties`. Verified failure message:
 *   "`required` is required to be supplied and to be an array including every
 *    key in properties. The following properties must be listed in `required`"
 *
 * Optional fields are therefore expressed as nullable rather than omitted, and
 * `stripNulls()` turns a returned null back into an absent field before Zod
 * validates — so a null on a REQUIRED field still fails the contract.
 */
export function toStrictSchema(schema) {
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;

    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "additionalProperties" || key === "$schema" || key === "format") continue;
      out[key] = walk(value);
    }

    if (out.type === "object" && out.properties) {
      out.additionalProperties = false;
      const keys = Object.keys(out.properties);
      const declared = Array.isArray(out.required) ? out.required : [];
      for (const key of keys) {
        if (declared.includes(key)) continue;
        const property = out.properties[key];
        if (!property || typeof property !== "object") continue;
        if (typeof property.type === "string") property.type = [property.type, "null"];
        else if (Array.isArray(property.type) && !property.type.includes("null")) property.type = [...property.type, "null"];
        else if (Array.isArray(property.enum) && !property.enum.includes(null)) property.enum = [...property.enum, null];
      }
      out.required = keys;
    }
    return out;
  };
  return walk(schema);
}

/**
 * Treat a returned JSON null as an absent field.
 *
 * This is a structural mapping, not a default: it never substitutes a value.
 * A null on a required field still fails Zod, because the field simply is not
 * there afterwards.
 */
export function stripNulls(value) {
  // A null element inside an array is treated the same way as a null value:
  // absent. Zod still rejects anything that leaves the array the wrong shape.
  if (Array.isArray(value)) return value.filter((entry) => entry !== null).map(stripNulls);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null) continue;
    out[key] = stripNulls(entry);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Groq                                                                       */
/* -------------------------------------------------------------------------- */

export const GROQ_TEXT_MODEL = () => process.env.GROQ_TEXT_MODEL || "openai/gpt-oss-120b";
export const GROQ_VISION_MODEL = () => process.env.GROQ_VISION_MODEL || "qwen/qwen3.8-27b";
export const GROQ_WHISPER_MODEL = () => process.env.GROQ_WHISPER_MODEL || "whisper-large-v3-turbo";

/**
 * Groq chat completion.
 *
 * `strict` asks for provider-side JSON Schema enforcement. A model that rejects
 * the strict shape gets one retry with the schema moved into the prompt and
 * `json_object` instead, so a capability mismatch degrades instead of failing.
 *
 * `max_tokens` matters more than it looks. Groq reserves output tokens equal to
 * the schema's theoretical maximum, and a free tier enforces a per-minute
 * output ceiling — a generous schema gets rejected with "the request's expected
 * output tokens exceed the enforced limit" before the model even runs. Capping
 * max_tokens keeps the reservation inside the budget.
 */
async function groqChat({ model, providerId, system, user, jsonSchema, repair, media, timeoutMs = 30000 }) {
  const maxTokens = Number(process.env.GROQ_MAX_TOKENS || 900);
  const send = async (mode) => {
    const schemaText = jsonSchema ? `\nRespond with a single JSON object matching this JSON Schema exactly:\n${JSON.stringify(sanitizeForProvider(jsonSchema))}` : "";
    const response = await guard(
      providerId,
      fetch(`${GROQ_BASE}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          temperature: 0.3,
          max_tokens: maxTokens,
          ...(mode === "strict" && jsonSchema
            ? { response_format: { type: "json_schema", json_schema: { name: "result", strict: true, schema: toStrictSchema(jsonSchema) } } }
            : jsonSchema
              ? { response_format: { type: "json_object" } }
              : {}),
          messages: [
            { role: "system", content: `${system}${schemaText}${repair ? `\n${repair}` : ""}` },
            { role: "user", content: openAiContent(user, media) },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      }),
    );
    if (!response.ok) await fail(response, providerId);
    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new ProviderError(`${providerId}:empty-response`, { provider: providerId, code: "AI_EMPTY", headers: response.headers });
    return { raw: content, headers: response.headers, finishReason: payload.choices?.[0]?.finish_reason };
  };

  let mode = jsonSchema ? "strict" : "plain";
  let outcome;
  try {
    outcome = await send(mode);
  } catch (cause) {
    const error = normalizeProviderError(cause, providerId);
    // A rejected response_format is a capability mismatch, not an outage.
    if (error.code === "PROVIDER_REJECTED" && mode === "strict") {
      mode = "object";
      outcome = await send(mode);
    } else {
      throw error;
    }
  }
  // A truncated response cannot satisfy the contract, so say so plainly rather
  // than letting it fail validation as if the model had answered wrongly.
  if (outcome.finishReason === "length" && jsonSchema) {
    throw new ProviderError(`${providerId}:truncated`, { provider: providerId, code: "AI_EMPTY", headers: outcome.headers });
  }
  return { value: jsonSchema ? parseJsonLoose(outcome.raw, providerId) : { text: outcome.raw }, model, schemaMode: mode };
}

export const groqText = {
  id: "groq-text",
  label: "Groq GPT-OSS 120B",
  capabilities: ["text"],
  configured: () => Boolean(process.env.GROQ_API_KEY),
  model: GROQ_TEXT_MODEL,
  structured: (options) => groqChat({ ...options, model: GROQ_TEXT_MODEL(), providerId: "groq-text" }),
};

export const groqVision = {
  id: "groq-vision",
  label: "Groq Qwen 3.8 (vision)",
  capabilities: ["text", "vision"],
  configured: () => Boolean(process.env.GROQ_API_KEY),
  model: GROQ_VISION_MODEL,
  structured: (options) => groqChat({ ...options, model: GROQ_VISION_MODEL(), providerId: "groq-vision" }),
};

export const groqWhisper = {
  id: "groq-whisper",
  label: "Groq Whisper Turbo",
  capabilities: ["stt"],
  configured: () => Boolean(process.env.GROQ_API_KEY),
  model: GROQ_WHISPER_MODEL,
  async transcribe({ buffer, mimeType, language, timeoutMs = 45000 }) {
    const form = new FormData();
    form.append("model", GROQ_WHISPER_MODEL());
    form.append("response_format", "verbose_json");
    if (language) form.append("language", language);
    form.append("file", new Blob([buffer], { type: mimeType }), "audio.webm");
    const response = await guard(
      "groq-whisper",
      fetch(`${GROQ_BASE}/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}` },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      }),
    );
    if (!response.ok) await fail(response, "groq-whisper");
    const payload = await response.json();
    if (!payload.text?.trim()) throw new ProviderError("groq-whisper:empty", { provider: "groq-whisper", code: "EMPTY_TRANSCRIPT", headers: response.headers });
    return { value: payload, model: GROQ_WHISPER_MODEL(), headers: response.headers };
  },
};

/* -------------------------------------------------------------------------- */
/* Cloudflare Workers AI                                                      */
/* -------------------------------------------------------------------------- */

export const CF_ACCOUNT = () => process.env.CLOUDFLARE_ACCOUNT_ID || "";
export const CF_TOKEN = () => process.env.CLOUDFLARE_API_TOKEN || "";
export const CF_TEXT_MODEL = () => process.env.CLOUDFLARE_TEXT_MODEL || "@cf/zai-org/glm-4.7-flash";
export const CF_VISION_MODEL = () => process.env.CLOUDFLARE_VISION_MODEL || "@cf/google/gemma-4-26b-a4b-it";
export const CF_WHISPER_MODEL = () => process.env.CLOUDFLARE_WHISPER_MODEL || "@cf/openai/whisper-large-v3-turbo";

export const cloudflareConfigured = () => Boolean(CF_ACCOUNT() && CF_TOKEN());

async function cloudflareRun(model, body, { timeoutMs = 40000, providerId = "cloudflare" } = {}) {
  const response = await guard(
    providerId,
    fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT()}/ai/run/${model}`, {
      method: "POST",
      headers: { authorization: `Bearer ${CF_TOKEN()}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }),
  );
  if (!response.ok) await fail(response, providerId);
  const payload = await response.json();
  if (payload.success === false) {
    const error = new ProviderError(`${providerId}:${payload.errors?.[0]?.code ?? "failed"}`, { provider: providerId, code: "PROVIDER_REJECTED", headers: response.headers });
    error.detail = JSON.stringify(payload.errors ?? []).slice(0, 300);
    throw error;
  }
  return { result: payload.result, headers: response.headers };
}

/**
 * Extract the assistant text from a Workers AI response.
 *
 * Chat models return an OpenAI-shaped envelope at `result.choices[0].message.content`,
 * while other model families return `result.response` or a bare string. Reading
 * the wrong field yields the whole envelope, which then fails schema validation
 * and looks like a provider outage.
 */
function extractCloudflareText(result) {
  if (typeof result === "string") return result;
  const content = result?.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) return content;
  if (typeof result?.response === "string" && result.response.trim()) return result.response;
  if (typeof result?.text === "string" && result.text.trim()) return result.text;
  return null;
}

function cloudflareChat({ model, providerId, capabilities, attemptTimeoutMs }) {
  return {
    id: providerId,
    label: `Cloudflare ${model}`,
    capabilities,
    configured: cloudflareConfigured,
    model: () => model,
    /**
     * Measured: gemma-4-26b answers a simple vision prompt in ~3.5s but does not
     * finish the full Scene Lens task (1.9k prompt + 2.2k schema + a large JSON
     * response) inside 90s. A short attempt cap makes it fail fast rather than
     * consuming the whole chain deadline, so later providers still get a turn.
     */
    attemptTimeoutMs,
    async structured({ system, user, jsonSchema, repair, media, timeoutMs = 40000 }) {
      const schemaText = jsonSchema ? `\nRespond with a single JSON object matching this JSON Schema exactly:\n${JSON.stringify(sanitizeForProvider(jsonSchema))}` : "";
      const content = media ? [{ type: "text", text: user }, { type: "image_url", image_url: { url: `data:${media.mimeType};base64,${media.base64}` } }] : user;
      const { result } = await cloudflareRun(
        model,
        {
          messages: [
            { role: "system", content: `${system}${schemaText}${repair ? `\n${repair}` : ""}` },
            { role: "user", content },
          ],
        },
        { timeoutMs, providerId },
      );
      const raw = extractCloudflareText(result);
      if (!raw) throw new ProviderError(`${providerId}:empty`, { provider: providerId, code: "AI_EMPTY" });
      return { value: parseJsonLoose(raw, providerId), model, schemaMode: "prompt" };
    },
  };
}

export const cloudflareText = cloudflareChat({ model: CF_TEXT_MODEL(), providerId: "cloudflare-text", capabilities: ["text"], attemptTimeoutMs: 30_000 });
export const cloudflareVision = cloudflareChat({ model: CF_VISION_MODEL(), providerId: "cloudflare-vision", capabilities: ["text", "vision"], attemptTimeoutMs: 35_000 });

export const cloudflareWhisper = {
  id: "cloudflare-whisper",
  label: "Cloudflare Whisper Turbo",
  capabilities: ["stt"],
  configured: cloudflareConfigured,
  model: CF_WHISPER_MODEL,
  async transcribe({ buffer, language, timeoutMs = 45000 }) {
    // Workers AI expects `audio` as a base64 STRING. Passing a byte array is
    // rejected with "Type mismatch of '/audio', 'string' not in 'array','binary'".
    const { result } = await cloudflareRun(
      CF_WHISPER_MODEL(),
      { audio: Buffer.from(buffer).toString("base64"), ...(language ? { language } : {}) },
      { timeoutMs, providerId: "cloudflare-whisper" },
    );
    const text = result?.text?.trim();
    if (!text) throw new ProviderError("cloudflare-whisper:empty", { provider: "cloudflare-whisper", code: "EMPTY_TRANSCRIPT" });
    return { value: { text, language: result?.transcription_info?.language ?? result?.language, segments: result?.segments }, model: CF_WHISPER_MODEL() };
  },
};

/* -------------------------------------------------------------------------- */
/* Gemini                                                                     */
/* -------------------------------------------------------------------------- */

export const GEMINI_MODEL = () => process.env.GEMINI_MODEL || "gemini-3.8-flash";
export const GEMINI_TTS_MODEL = () => process.env.GEMINI_TTS_MODEL || "gemini-3.1-flash-tts-preview";

export const geminiConfigured = () => Boolean(process.env.GEMINI_API_KEY);

export const gemini = {
  id: "gemini",
  label: "Gemini Flash",
  capabilities: ["text", "vision", "tts"],
  configured: geminiConfigured,
  model: GEMINI_MODEL,
  /**
   * Prefers native JSON Schema enforcement. Some payloads get a bare
   * `400 INVALID_ARGUMENT`; rather than fail the request the call is retried
   * once with the schema in the prompt, and Zod still governs the result.
   */
  async structured({ system, user, jsonSchema, repair, media, timeoutMs = 45000 }) {
    const build = (schemaMode) => {
      const clean = jsonSchema ? sanitizeForProvider(jsonSchema) : undefined;
      const parts = [];
      if (schemaMode === "prompt" && clean) parts.push({ text: `Respond with a single JSON object matching this JSON Schema exactly:\n${JSON.stringify(clean)}` });
      parts.push({ text: `${system}${repair ? `\n${repair}` : ""}\n\n${user}` });
      if (media) parts.push({ inlineData: { mimeType: media.mimeType, data: media.base64 } });
      return {
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0.3, responseMimeType: "application/json", ...(schemaMode === "native" && clean ? { responseJsonSchema: clean } : {}) },
      };
    };
    const send = (schemaMode) =>
      guard(
        "gemini",
        fetch(`${GEMINI_BASE}/models/${GEMINI_MODEL()}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
          body: JSON.stringify(build(schemaMode)),
          signal: AbortSignal.timeout(timeoutMs),
        }),
      );

    let schemaMode = "native";
    let response = await send("native");
    if (response.status === 400 && jsonSchema) {
      response = await send("prompt");
      schemaMode = "prompt";
    }
    if (!response.ok) await fail(response, "gemini");
    const payload = await response.json();
    const text = (payload.candidates?.[0]?.content?.parts ?? []).map((part) => part.text).filter(Boolean).join("");
    if (!text.trim()) {
      const blocked = payload.candidates?.[0]?.finishReason || payload.promptFeedback?.blockReason;
      throw new ProviderError(`gemini:empty:${blocked ?? "unknown"}`, { provider: "gemini", code: "AI_EMPTY", headers: response.headers });
    }
    return { value: parseJsonLoose(text, "gemini"), model: GEMINI_MODEL(), schemaMode };
  },

  async speak({ text, voiceName = process.env.GEMINI_TTS_VOICE || "Kore", timeoutMs = 45000 }) {
    const response = await guard(
      "gemini",
      fetch(`${GEMINI_BASE}/models/${GEMINI_TTS_MODEL()}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text }] }],
          generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      }),
    );
    if (!response.ok) await fail(response, "gemini");
    const payload = await response.json();
    const inline = (payload.candidates?.[0]?.content?.parts ?? []).find((part) => part.inlineData)?.inlineData;
    if (!inline?.data) throw new ProviderError("gemini:empty-audio", { provider: "gemini", code: "AI_EMPTY" });
    return { audioBase64: inline.data, mimeType: inline.mimeType || "audio/L16;codec=pcm;rate=24000", model: GEMINI_TTS_MODEL() };
  },
};

/**
 * Mint a short-lived ephemeral token so the browser can open a Live API
 * WebSocket without holding the API key. The REST field is
 * `bidiGenerateContentSetup` (the SDK calls it `liveConnectConstraints`).
 */
export async function mintEphemeralToken({ model, mode = "agent", targetLanguage, expireMinutes = 30, newSessionMinutes = 1, timeoutMs = 15000 }) {
  if (!geminiConfigured()) throw new ProviderError("gemini:no-key", { provider: "gemini", code: "NOT_CONFIGURED" });
  const now = Date.now();
  const setup =
    mode === "translate"
      ? { model: `models/${model}`, generationConfig: { responseModalities: ["AUDIO"], translationConfig: { targetLanguageCode: targetLanguage } } }
      : { model: `models/${model}`, generationConfig: { responseModalities: ["AUDIO"] } };
  const body = {
    uses: 1,
    expireTime: new Date(now + expireMinutes * 60_000).toISOString(),
    newSessionExpireTime: new Date(now + newSessionMinutes * 60_000).toISOString(),
  };
  const send = (withLock) =>
    guard(
      "gemini",
      fetch(`${GEMINI_BASE}/auth_tokens`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
        body: JSON.stringify(withLock ? { ...body, bidiGenerateContentSetup: setup } : body),
        signal: AbortSignal.timeout(timeoutMs),
      }),
    );
  let constrained = true;
  let response = await send(true);
  if (response.status === 400) {
    constrained = false;
    response = await send(false);
  }
  if (!response.ok) await fail(response, "gemini");
  const payload = await response.json();
  if (!payload.name) throw new ProviderError("gemini:token-missing", { provider: "gemini", code: "AI_EMPTY" });
  return { token: payload.name, expiresAt: payload.expireTime ?? body.expireTime, newSessionExpiresAt: payload.newSessionExpireTime ?? body.newSessionExpireTime, constrained };
}

/* -------------------------------------------------------------------------- */
/* Cavoti — OpenAI-compatible multi-provider gateway                          */
/* -------------------------------------------------------------------------- */

export const CAVOTI_BASE = () => (process.env.CAVOTI_BASE_URL || "https://cavoti.com/v1").replace(/\/$/, "");
export const cavotiConfigured = () => Boolean(process.env.CAVOTI_API_KEY);

/** Serving IDs verified against the live catalog on 2026-09-16. */
export const CAVOTI_MODELS = {
  // mimo-v2.5 and qwen-3.8-flash both exist but return 402 (balance required).
  // The working Qwen ID has no hyphen after "qwen".
  mimo: () => process.env.CAVOTI_MIMO_MODEL || "mimo-v2.5",
  qwen: () => process.env.CAVOTI_QWEN_MODEL || "qwen3.8-flash",
  glm: () => process.env.CAVOTI_GLM_MODEL || "glm-5.3-flash",
  minimax: () => process.env.CAVOTI_MINIMAX_MODEL || "minimax-m3",
  deepseek: () => process.env.CAVOTI_DEEPSEEK_MODEL || "deepseek-v4-flash-0731",
  hy3: () => process.env.CAVOTI_HY3_MODEL || "hy3",
};

/**
 * Build a Cavoti provider for one model.
 *
 * Each model gets its OWN provider id, which means its own circuit. One Cavoti
 * model being rate limited must not disable the others — they are separate
 * upstream providers behind a shared gateway, so they fail independently.
 *
 * `capabilities` is passed in from measurement, never inferred from the model
 * name. See docs/evidence/phase3/cavoti-matrix.json.
 */
export function cavotiModel({ id, label, model, capabilities, supportsAudio = false }) {
  return {
    id,
    label,
    capabilities,
    /** Reported by /health. True only where a real probe accepted audio input. */
    audio: supportsAudio,
    configured: cavotiConfigured,
    model,
    async structured({ system, user, jsonSchema, repair, media, audio, timeoutMs = 60000 }) {
      const schemaText = jsonSchema ? `\nRespond with a single JSON object matching this JSON Schema exactly:\n${JSON.stringify(sanitizeForProvider(jsonSchema))}` : "";
      let content = user;
      if (media || audio) {
        const parts = [{ type: "text", text: user }];
        if (media) parts.push({ type: "image_url", image_url: { url: `data:${media.mimeType};base64,${media.base64}` } });
        if (audio && supportsAudio) parts.push({ type: "input_audio", input_audio: { data: audio.base64, format: audio.format ?? "wav" } });
        content = parts;
      }
      const response = await guard(
        id,
        fetch(`${CAVOTI_BASE()}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${process.env.CAVOTI_API_KEY}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: model(),
            temperature: 0.3,
            ...(jsonSchema ? { response_format: { type: "json_object" } } : {}),
            messages: [
              { role: "system", content: `${system}${schemaText}${repair ? `\n${repair}` : ""}` },
              { role: "user", content },
            ],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        }),
      );
      if (!response.ok) await fail(response, id);
      const payload = await response.json();
      const text = payload.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) {
        throw new ProviderError(`${id}:empty-response`, { provider: id, code: "AI_EMPTY", headers: response.headers });
      }
      return { value: jsonSchema ? parseJsonLoose(text, id) : { text }, model: payload.model ?? model(), schemaMode: "prompt" };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Experiential Labs — free lanes plus a budgeted paid rescue tier            */
/* -------------------------------------------------------------------------- */

export const EXPLABS_BASE = () => (process.env.EXPLABS_BASE_URL || "https://api.experientiallabs.ai/v1").replace(/\/$/, "");
export const explabsConfigured = () => Boolean(process.env.EXPLABS_API_KEY);

/** Slugs verified against the live catalog on 2026-09-16. */
export const EXPLABS_MODELS = {
  luna: () => process.env.EXPLABS_TEXT_MODEL || "gpt-5.6-luna",
  lunaPaid: () => process.env.EXPLABS_PAID_TEXT_MODEL || "qwen3.8-27b",
  deepseek: () => process.env.EXPLABS_CHEAP_TEXT_MODEL || "deepseek-v4-flash",
  vision: () => process.env.EXPLABS_VISION_MODEL || "gpt-5.6-luna",
  visionExp: () => process.env.EXPLABS_VISION_EXP_MODEL || "deepseek-v4-flash-vision-exp",
  glm: () => process.env.EXPLABS_GLM_MODEL || "glm-5.3-flash",
};

/**
 * Experiential signals a purchase-locked model with **HTTP 429**, not 402:
 *
 *   "model_requires_purchase: glm-5.3-flash is locked on your account until you
 *    make a purchase"
 *
 * Treating that as a rate limit would retry a permanently unavailable model
 * every 45 seconds forever. It is a billing condition, so it is re-coded as
 * PAYMENT_REQUIRED and parked for a long cooldown.
 */
const PURCHASE_LOCK = /model_requires_purchase|not granted to this identity|is locked on your account/i;

export function explabsModel({ id, label, model, capabilities = ["text"], paid = false, supportsAudio = false }) {
  return {
    id,
    label,
    capabilities,
    audio: supportsAudio,
    /** True when this provider spends credits, so the budget guard applies. */
    paid,
    configured: explabsConfigured,
    model,
    async structured({ system, user, jsonSchema, repair, media, audio, timeoutMs = 60000 }) {
      const schemaText = jsonSchema ? `\nRespond with a single JSON object matching this JSON Schema exactly:\n${JSON.stringify(sanitizeForProvider(jsonSchema))}` : "";
      let content = user;
      if (media || audio) {
        const parts = [{ type: "text", text: user }];
        if (media) parts.push({ type: "image_url", image_url: { url: `data:${media.mimeType};base64,${media.base64}` } });
        if (audio && supportsAudio) parts.push({ input_audio: { input_audio: { data: audio.base64, format: audio.format ?? "wav" } } });
        content = parts;
      }
      const response = await guard(
        id,
        fetch(`${EXPLABS_BASE()}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${process.env.EXPLABS_API_KEY}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: model(),
            max_tokens: Number(process.env.EXPLABS_MAX_TOKENS || 1200),
            ...(jsonSchema ? { response_format: { type: "json_object" } } : {}),
            messages: [
              { role: "system", content: `${system}${schemaText}${repair ? `\n${repair}` : ""}` },
              { role: "user", content },
            ],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        }),
      );

      if (!response.ok) {
        let detail = "";
        try {
          detail = (await response.clone().text()).slice(0, 400);
        } catch {
          /* body already consumed */
        }
        if (PURCHASE_LOCK.test(detail)) {
          const error = new ProviderError(`${id}:locked`, { provider: id, code: "PAYMENT_REQUIRED", headers: response.headers });
          error.detail = detail;
          throw error;
        }
        await fail(response, id);
      }

      const payload = await response.json();
      // Record what the provider says this call cost, for the budget guard.
      recordCost(payload.usage?.cost ?? payload.usage?.total_cost);
      const text = payload.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) {
        throw new ProviderError(`${id}:empty`, { provider: id, code: "AI_EMPTY", headers: response.headers });
      }
      return { value: jsonSchema ? parseJsonLoose(text, id) : { text }, model: payload.model ?? model(), schemaMode: "prompt", costUsd: payload.usage?.cost ?? null };
    },
  };
}

export const explabsLuna = explabsModel({ id: "explabs-luna", label: "Experiential GPT-5.6 Luna (free)", model: EXPLABS_MODELS.luna, capabilities: ["text", "vision"] });
export const explabsDeepseek = explabsModel({ id: "explabs-deepseek", label: "Experiential DeepSeek V4 Flash", model: EXPLABS_MODELS.deepseek, capabilities: ["text"] });
export const explabsQwenPaid = explabsModel({ id: "explabs-qwen-paid", label: "Experiential Qwen 3.8 (paid rescue)", model: EXPLABS_MODELS.lunaPaid, capabilities: ["text", "vision"], paid: true });
export const explabsGlmPaid = explabsModel({ id: "explabs-glm-paid", label: "Experiential GLM 5.3 Flash (paid rescue)", model: EXPLABS_MODELS.glm, capabilities: ["text", "vision"], paid: true });

/* -------------------------------------------------------------------------- */
/* OpenRouter — free-tier vision and last-resort text                         */
/* -------------------------------------------------------------------------- */

export const OPENROUTER_MODEL = () => process.env.OPENROUTER_MODEL || "openrouter/free";
export const openRouterConfigured = () => Boolean(process.env.OPENROUTER_API_KEY);

/**
 * One provider per OpenRouter model, so each gets its own circuit.
 *
 * Verified free vision on 2026-09-16: `inclusionai/ling-3.0-flash-vl:free`
 * (3.5s) and `dots-studio/dots-3-note-preview:free` (5.0s) both read a real
 * menu photo. `google/gemma-4-26b-a4b-it:free` returned 429 at probe time.
 *
 * A free OpenRouter account allows roughly 50 requests/day, so these are
 * backups, never the golden-path primary.
 */
export function openRouterModel({ id, label, model, capabilities = ["text", "vision"], supportsAudio = false }) {
  return {
    id,
    label,
    capabilities,
    audio: supportsAudio,
    configured: openRouterConfigured,
    model,
    async structured({ system, user, jsonSchema, repair, media, audio, timeoutMs = 60000 }) {
      const schemaText = jsonSchema ? `\nRespond with a single JSON object matching this JSON Schema exactly:\n${JSON.stringify(sanitizeForProvider(jsonSchema))}` : "";
      let content = user;
      if (media || audio) {
        const parts = [{ type: "text", text: user }];
        if (media) parts.push({ type: "image_url", image_url: { url: `data:${media.mimeType};base64,${media.base64}` } });
        if (audio && supportsAudio) parts.push({ input_audio: { data: audio.base64, format: audio.format ?? "wav" } });
        content = parts;
      }
      const response = await guard(
        id,
        fetch(`${OPENROUTER_BASE}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: model(),
            ...(jsonSchema ? { response_format: { type: "json_object" } } : {}),
            messages: [
              { role: "system", content: `${system}${schemaText}${repair ? `\n${repair}` : ""}` },
              { role: "user", content },
            ],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        }),
      );
      if (!response.ok) await fail(response, id);
      const payload = await response.json();
      const text = payload.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) {
        throw new ProviderError(`${id}:empty`, { provider: id, code: "AI_EMPTY", headers: response.headers });
      }
      return { value: jsonSchema ? parseJsonLoose(text, id) : { text }, model: payload.model ?? model(), schemaMode: "prompt" };
    },
  };
}

export const openRouterLing = openRouterModel({
  id: "openrouter-ling",
  label: "OpenRouter Ling 3.0 Flash VL (free)",
  model: () => process.env.OPENROUTER_VISION_MODEL || "inclusionai/ling-3.0-flash-vl:free",
});

export const openRouterDots = openRouterModel({
  id: "openrouter-dots",
  label: "OpenRouter Dots 3 Note (free)",
  model: () => process.env.OPENROUTER_DOTS_MODEL || "dots-studio/dots-3-note-preview:free",
});

export const openRouter = openRouterModel({ id: "openrouter", label: "OpenRouter (free pool)", model: OPENROUTER_MODEL });
