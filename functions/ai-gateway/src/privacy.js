/**
 * Privacy boundary for the AI gateway.
 *
 * docs/05_AI_CONTRACTS.md §1: minimise storage of private raw messages/media.
 * Raw image/audio/chat content is temporary by default. Nothing here writes
 * to disk, and the gateway never logs raw user content or provider keys.
 */

/** Strip direct identifiers before free text reaches a provider or a log. */
export const redact = (value = "") =>
  String(value)
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/@\w+/g, "[redacted-user]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[redacted-phone]");

/** Log lines carry an event name and a code only — never payload. */
export function logEvent(error, event, code) {
  try {
    error(`ai-gateway:${event}:${code}`);
  } catch {
    /* logging must never break a request */
  }
}

/**
 * Media that is sent inline is never echoed back in a response or an error.
 * Only the derived result leaves the gateway.
 */
export function assertMediaWithinBudget(base64, { maxBytes = 10 * 1024 * 1024, mimeType, allow = [] } = {}) {
  if (!base64) return { ok: false, code: "INVALID_FILE", message: "No media was provided." };
  if (allow.length && mimeType && !allow.some((prefix) => mimeType.startsWith(prefix))) {
    return { ok: false, code: "UNSUPPORTED_MEDIA", message: `Unsupported media type: ${mimeType}.` };
  }
  // base64 is ~4/3 of raw size; the estimate is deliberately conservative.
  const estimatedBytes = Math.floor((base64.length * 3) / 4);
  if (estimatedBytes > maxBytes) {
    return {
      ok: false,
      code: "FILE_TOO_LARGE",
      message: `File is about ${Math.round(estimatedBytes / 1024 / 1024)} MB. The limit is ${Math.round(maxBytes / 1024 / 1024)} MB.`,
    };
  }
  return { ok: true };
}

/** Enforced on every response body the gateway returns. */
export const FORBIDDEN_RESPONSE_KEYS = ["apiKey", "api_key", "authorization", "mediaBase64", "rawAudio", "prompt", "chainOfThought", "reasoning"];

export function stripForbiddenKeys(value) {
  if (Array.isArray(value)) return value.map(stripForbiddenKeys);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_RESPONSE_KEYS.includes(key)) continue;
    out[key] = stripForbiddenKeys(item);
  }
  return out;
}
