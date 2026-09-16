/**
 * Provider circuit breaker.
 *
 * A provider that just returned 429 or repeated 5xx must not receive new user
 * traffic. Retrying a rate-limited provider on every request is what turns a
 * transient limit into a dead demo.
 *
 * State is per function instance. Appwrite may run several instances, so this
 * is a best-effort local breaker, not a global one — it bounds damage rather
 * than guaranteeing a single shared view. It is deliberately in-memory: a
 * breaker that needs a database round-trip would add latency to every request.
 */

export const BREAKER_STATES = ["healthy", "degraded", "cooldown", "unconfigured"];

/** Cooldown applied when the provider gives us no retry-after hint. */
const DEFAULT_COOLDOWN_MS = {
  RATE_LIMITED: 45_000,
  AI_UNAVAILABLE: 15_000,
  TIMEOUT: 20_000,
  SCHEMA_INVALID: 0,
  // A billing refusal does not clear on its own. Park it for a long time so a
  // model that needs balance is not retried on every single request.
  PAYMENT_REQUIRED: 10 * 60_000,
  OTHER: 20_000,
};

/** Cap exponential growth so a long outage does not park a provider forever. */
const MAX_COOLDOWN_MS = 5 * 60_000;
/** Failures within this window count toward the streak. */
const FAILURE_WINDOW_MS = 60_000;
/** Consecutive failures before a provider is taken out of rotation entirely. */
const FAILURE_THRESHOLD = 3;

const state = new Map();

function blank(providerId) {
  return {
    providerId,
    status: "healthy",
    consecutiveFailures: 0,
    failureTimes: [],
    cooldownUntil: 0,
    cooldownMs: 0,
    lastErrorCode: null,
    lastErrorAt: null,
    lastSuccessAt: null,
    totalCalls: 0,
    totalFailures: 0,
  };
}

export function snapshot(providerId) {
  return state.get(providerId) ?? blank(providerId);
}

export function allSnapshots() {
  return Object.fromEntries([...state.entries()].map(([id, entry]) => [id, { ...entry, failureTimes: undefined }]));
}

/** Seconds remaining in a cooldown, or 0. */
function remainingCooldown(entry, now) {
  return entry.cooldownUntil > now ? Math.ceil((entry.cooldownUntil - now) / 1000) : 0;
}

/**
 * Decide whether a provider may be used right now.
 * A provider in cooldown is skipped; once the cooldown expires it is allowed
 * exactly one probe request, so a recovered provider rejoins without a stampede.
 */
export function gate(providerId, now = Date.now()) {
  const entry = state.get(providerId);
  if (!entry) return { allowed: true, state: "healthy", probe: false };
  const remaining = remainingCooldown(entry, now);
  if (remaining > 0) {
    return { allowed: false, state: "cooldown", retryAfterSeconds: remaining };
  }
  if (entry.status === "cooldown" || entry.status === "degraded") {
    // Cooldown elapsed: allow a single probe.
    return { allowed: true, state: entry.status, probe: true };
  }
  return { allowed: true, state: "healthy", probe: false };
}

function parseRetryAfterMs(headers) {
  if (!headers) return null;
  const raw = headers.get?.("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_COOLDOWN_MS);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    return delta > 0 ? Math.min(delta, MAX_COOLDOWN_MS) : null;
  }
  return null;
}

export function recordSuccess(providerId, now = Date.now()) {
  const entry = state.get(providerId) ?? blank(providerId);
  entry.status = "healthy";
  entry.consecutiveFailures = 0;
  entry.failureTimes = [];
  entry.cooldownUntil = 0;
  entry.cooldownMs = 0;
  entry.lastErrorCode = null;
  entry.lastSuccessAt = new Date(now).toISOString();
  entry.totalCalls += 1;
  state.set(providerId, entry);
  return entry;
}

/**
 * Record a failure and open or extend the cooldown.
 *
 * A 429 always opens the circuit immediately — the provider told us it is
 * over capacity, so a second request would be wasted. Other failures need a
 * short streak before the provider is parked.
 */
export function recordFailure(providerId, error, now = Date.now()) {
  const entry = state.get(providerId) ?? blank(providerId);
  const code = error?.code ?? "OTHER";

  entry.totalCalls += 1;
  entry.totalFailures += 1;
  entry.lastErrorCode = code;
  entry.lastErrorAt = new Date(now).toISOString();
  entry.failureTimes = [...(entry.failureTimes ?? []).filter((time) => now - time < FAILURE_WINDOW_MS), now];
  entry.consecutiveFailures += 1;

  const schemaOnly = code === "SCHEMA_INVALID";
  const retryAfterMs = parseRetryAfterMs(error?.headers);
  const base = retryAfterMs ?? DEFAULT_COOLDOWN_MS[code] ?? DEFAULT_COOLDOWN_MS.OTHER;

  if (schemaOnly) {
    // A schema miss is not a health problem: the provider answered. Do not park it.
    state.set(providerId, entry);
    return entry;
  }

  const shouldOpen = code === "RATE_LIMITED" || code === "AI_UNAVAILABLE" || code === "PAYMENT_REQUIRED" || entry.consecutiveFailures >= FAILURE_THRESHOLD;
  if (shouldOpen && base > 0) {
    // Grow the cooldown while failures keep coming, capped.
    const grown = entry.cooldownMs > 0 ? Math.min(entry.cooldownMs * 2, MAX_COOLDOWN_MS) : base;
    entry.cooldownMs = grown;
    entry.cooldownUntil = now + grown;
    entry.status = "cooldown";
  } else if (entry.consecutiveFailures > 0) {
    entry.status = "degraded";
  }

  state.set(providerId, entry);
  return entry;
}

/** Force a provider into cooldown. Used by the soak test to prove failover. */
export function trip(providerId, ms = DEFAULT_COOLDOWN_MS.RATE_LIMITED, now = Date.now()) {
  const entry = state.get(providerId) ?? blank(providerId);
  entry.status = "cooldown";
  entry.cooldownMs = ms;
  entry.cooldownUntil = now + ms;
  entry.lastErrorCode = "FORCED";
  entry.lastErrorAt = new Date(now).toISOString();
  state.set(providerId, entry);
  return entry;
}

export function reset(providerId) {
  if (providerId) state.delete(providerId);
  else state.clear();
}

/**
 * Health summary for /health. `unconfigured` is decided by the caller because
 * only the registry knows which env vars a provider needs.
 *
 * A provider whose cooldown has elapsed but which has not yet succeeded is
 * reported as `degraded` — it is allowed to serve as a probe, but the UI should
 * treat it as unconfirmed rather than healthy.
 */
export function healthOf(providerId, { configured = true } = {}, now = Date.now()) {
  if (!configured) return { state: "unconfigured", lastSuccessfulAt: null };
  const entry = state.get(providerId);
  if (!entry) return { state: "healthy", lastSuccessfulAt: null };

  // A billing refusal is not a temporary outage: report it as `unsupported` so
  // the health view says "not available on this plan" instead of "cooldown".
  if (entry.lastErrorCode === "PAYMENT_REQUIRED" && entry.consecutiveFailures > 0) {
    return {
      state: "unsupported",
      lastSuccessfulAt: entry.lastSuccessAt,
      lastErrorCode: entry.lastErrorCode,
      consecutiveFailures: entry.consecutiveFailures,
      reason: "not available on the current plan",
    };
  }

  const remaining = remainingCooldown(entry, now);
  const awaitingProbe = !remaining && entry.status === "cooldown";
  return {
    state: remaining > 0 ? "cooldown" : awaitingProbe || entry.status === "degraded" ? "degraded" : "healthy",
    lastSuccessfulAt: entry.lastSuccessAt,
    retryAfterSeconds: remaining || undefined,
    lastErrorCode: entry.lastErrorCode ?? undefined,
    consecutiveFailures: entry.consecutiveFailures || undefined,
  };
}
