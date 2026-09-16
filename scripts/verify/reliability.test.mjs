/**
 * Circuit breaker behaviour tests.
 *
 * No network: these assert the routing decisions that must hold regardless of
 * what a provider does. Run: node --test scripts/verify/reliability.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as breaker from "../../functions/ai-gateway/src/breaker.js";
import { ProviderError, normalizeProviderError, toStrictSchema, stripNulls } from "../../functions/ai-gateway/src/providers.js";
import { sceneResult, lensResult } from "../../functions/ai-gateway/src/contracts.js";
import { PROVIDERS, CHAINS, executeStructured } from "../../functions/ai-gateway/src/registry.js";
import { z } from "zod";

test.beforeEach(() => breaker.reset());

test("a healthy provider is allowed and not flagged as a probe", () => {
  breaker.recordSuccess("p1");
  const gate = breaker.gate("p1");
  assert.equal(gate.allowed, true);
  assert.equal(gate.state, "healthy");
  assert.equal(gate.probe, false);
});

test("an unknown provider is allowed (nothing has failed yet)", () => {
  assert.equal(breaker.gate("never-seen").allowed, true);
});

test("429 opens the circuit immediately", () => {
  breaker.recordFailure("p1", new ProviderError("p1:429", { status: 429, provider: "p1" }));
  const gate = breaker.gate("p1");
  assert.equal(gate.allowed, false, "a rate-limited provider must not receive new traffic");
  assert.equal(gate.state, "cooldown");
  assert.ok(gate.retryAfterSeconds > 0);
});

test("retry-after from the provider sets the cooldown, not our guess", () => {
  const headers = new Headers({ "retry-after": "34" });
  breaker.recordFailure("p1", new ProviderError("p1:429", { status: 429, provider: "p1", headers }));
  const entry = breaker.snapshot("p1");
  assert.equal(entry.cooldownMs, 34_000);
});

test("an HTTP-date retry-after is honoured", () => {
  const future = new Date(Date.now() + 20_000).toUTCString();
  breaker.recordFailure("p1", new ProviderError("p1:429", { status: 429, provider: "p1", headers: new Headers({ "retry-after": future }) }));
  const entry = breaker.snapshot("p1");
  assert.ok(entry.cooldownMs > 15_000 && entry.cooldownMs <= 20_000, `expected ~20s, got ${entry.cooldownMs}`);
});

test("a 503 opens a SHORT cooldown (spec: 503 gets a short exponential cooldown)", () => {
  breaker.recordFailure("p1", new ProviderError("p1:503", { status: 503, provider: "p1" }));
  const gate = breaker.gate("p1");
  assert.equal(gate.allowed, false, "a provider that just returned 503 should be skipped");
  const entry = breaker.snapshot("p1");
  assert.equal(entry.cooldownMs, 15_000, "the first 5xx cooldown must be short");
});

test("repeated 503s grow the cooldown", () => {
  breaker.recordFailure("p1", new ProviderError("p1:503", { status: 503, provider: "p1" }));
  const first = breaker.snapshot("p1").cooldownMs;
  breaker.recordFailure("p1", new ProviderError("p1:503", { status: 503, provider: "p1" }));
  const second = breaker.snapshot("p1").cooldownMs;
  assert.ok(second > first, `expected growth: ${first} -> ${second}`);
});

test("a 429 cooldown is longer than a 503 cooldown", () => {
  breaker.recordFailure("rate", new ProviderError("rate:429", { status: 429, provider: "rate" }));
  breaker.recordFailure("server", new ProviderError("server:503", { status: 503, provider: "server" }));
  assert.ok(breaker.snapshot("rate").cooldownMs > breaker.snapshot("server").cooldownMs);
});

test("a schema failure never parks a provider", () => {
  // The provider answered; it just answered wrong. That is not an outage.
  for (let index = 0; index < 5; index += 1) {
    breaker.recordFailure("p1", new ProviderError("schema", { provider: "p1", code: "SCHEMA_INVALID" }));
  }
  const gate = breaker.gate("p1");
  assert.equal(gate.allowed, true, "schema misses must not remove a healthy provider");
  assert.notEqual(gate.state, "cooldown");
});

test("after cooldown exactly one probe is allowed, then the circuit closes on success", () => {
  breaker.trip("p1", 50);
  assert.equal(breaker.gate("p1").allowed, false);

  const later = Date.now() + 60;
  const probe = breaker.gate("p1", later);
  assert.equal(probe.allowed, true, "cooldown elapsed should allow a probe");
  assert.equal(probe.probe, true);

  breaker.recordSuccess("p1");
  const after = breaker.gate("p1", later);
  assert.equal(after.allowed, true);
  assert.equal(after.state, "healthy");
  assert.equal(after.probe, false);
});

test("a failed probe reopens the circuit", () => {
  breaker.trip("p1", 50);
  const later = Date.now() + 60;
  assert.equal(breaker.gate("p1", later).allowed, true);
  breaker.recordFailure("p1", new ProviderError("p1:429", { status: 429, provider: "p1" }), later);
  assert.equal(breaker.gate("p1", later).allowed, false);
});

test("cooldown grows on repeated failures but stays capped", () => {
  let now = Date.now();
  let previous = 0;
  for (let round = 0; round < 8; round += 1) {
    breaker.recordFailure("p1", new ProviderError("p1:503", { status: 503, provider: "p1" }), now);
    now = breaker.snapshot("p1").cooldownUntil + 1;
    previous = breaker.snapshot("p1").cooldownMs;
  }
  assert.ok(previous <= 5 * 60_000, `cooldown must stay capped, got ${previous}`);
  assert.ok(previous > 0);
});

test("health reports unconfigured before any call", () => {
  assert.deepEqual(breaker.healthOf("p1", { configured: false }), { state: "unconfigured", lastSuccessfulAt: null });
});

test("health reports cooldown with the remaining seconds", () => {
  breaker.trip("p1", 60_000);
  const health = breaker.healthOf("p1", { configured: true });
  assert.equal(health.state, "cooldown");
  assert.ok(health.retryAfterSeconds > 0);
});

test("health records lastSuccessfulAt", () => {
  breaker.recordSuccess("p1");
  const health = breaker.healthOf("p1", { configured: true });
  assert.equal(health.state, "healthy");
  assert.ok(health.lastSuccessfulAt, "lastSuccessfulAt must be set after a success");
});

test("a timeout normalises to a contract code, never a DOMException number", () => {
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError", code: 23 });
  const error = normalizeProviderError(timeout, "p1");
  assert.equal(error.name, "ProviderError");
  assert.equal(error.code, "AI_UNAVAILABLE");
  assert.equal(error.retryable, true);
  assert.notEqual(error.code, 23);
});

test("an unknown error still normalises to a contract code", () => {
  const error = normalizeProviderError(new Error("socket hang up"), "p1");
  assert.equal(error.code, "AI_UNAVAILABLE");
});

/* -------------------------------------------------------------------------- */
/* Strict structured-output transform                                         */
/* -------------------------------------------------------------------------- */

test("toStrictSchema lists every property in required (Groq/OpenAI strict rule)", () => {
  const strict = toStrictSchema(z.toJSONSchema(sceneResult, { io: "output" }));
  const region = strict.properties.regions.items;
  const declared = region.required;
  for (const key of Object.keys(region.properties)) {
    assert.ok(declared.includes(key), `${key} must be listed in required`);
  }
  assert.deepEqual([...declared].sort(), Object.keys(region.properties).sort());
});

test("toStrictSchema makes previously optional fields nullable", () => {
  const strict = toStrictSchema(z.toJSONSchema(sceneResult, { io: "output" }));
  const region = strict.properties.regions.items;
  // `note` is optional in the Zod contract.
  assert.deepEqual(region.properties.note.type, ["string", "null"]);
  // `label` is required, so it must not have been widened.
  assert.equal(region.properties.label.type, "string");
});

test("toStrictSchema sets additionalProperties false everywhere", () => {
  const strict = toStrictSchema(z.toJSONSchema(sceneResult, { io: "output" }));
  assert.equal(strict.additionalProperties, false);
  assert.equal(strict.properties.regions.items.additionalProperties, false);
});

test("stripNulls removes nulls but never invents a value", () => {
  const input = { a: 1, b: null, c: { d: null, e: "keep" }, f: [1, null, 3] };
  assert.deepEqual(stripNulls(input), { a: 1, c: { e: "keep" }, f: [1, 3] });
});

test("a null on a REQUIRED field still fails the contract", () => {
  const strict = toStrictSchema(z.toJSONSchema(sceneResult, { io: "output" }));
  // Simulate a provider that used the nullable escape hatch on a required field.
  const providerSaid = { ...stripNulls({ sceneSummary: null, sceneKind: "menu", detectedLanguages: ["ms"], targetLanguage: "vi", regions: [], usefulPhrases: [], uncertaintyNotes: [], safetyNotice: "x", confidence: { label: "low", reason: "x" } }) };
  assert.equal(sceneResult.safeParse(providerSaid).success, false, "a missing required field must not be repaired");
  void strict;
});

test("a null on an OPTIONAL field is accepted after stripping", () => {
  const providerSaid = stripNulls({
    sceneSummary: "A stall menu.",
    sceneKind: "menu",
    detectedLanguages: ["ms"],
    targetLanguage: "vi",
    regions: [
      {
        id: "r1",
        kind: "text",
        box: { ymin: 1, xmin: 1, ymax: 10, xmax: 10 },
        label: "Nasi Lemak",
        originalText: "Nasi Lemak",
        translatedText: null,
        romanization: null,
        meaning: null,
        uncertainty: "none",
        confidence: "high",
        note: null,
      },
    ],
    usefulPhrases: [],
    uncertaintyNotes: [],
    safetyNotice: "Ingredients cannot be established from a photo.",
    confidence: { label: "medium", reason: "Legible signage." },
  });
  assert.equal(sceneResult.safeParse(providerSaid).success, true);
});

/* -------------------------------------------------------------------------- */
/* Chain walking — stub providers, no network                                 */
/* -------------------------------------------------------------------------- */

const VALID_LENS = {
  detectedLanguage: "Malay",
  literalMeaning: "How many packs?",
  likelyIntents: [{ label: "Quantity", explanation: "Wants a number." }],
  contextExplanation: "A stallholder asking how many portions.",
  expectedNextAction: "Give a number.",
  misunderstandingRisk: "low",
  recommendedAction: "Answer with the number of packs.",
  suggestedReplies: [{ mode: "neutral", text: "Dua bungkus.", why: "Short and clear." }],
  confidence: { label: "medium", reason: "Short utterance." },
  sources: [],
};

function stubProvider(id, { value, failWith, configured = true, onCall } = {}) {
  return {
    id,
    label: id,
    capabilities: ["text"],
    configured: () => configured,
    model: () => `${id}-model`,
    async structured() {
      onCall?.(id);
      if (failWith) throw failWith;
      return { value, model: `${id}-model`, schemaMode: "plain" };
    },
  };
}

/** Run one inference with a temporary chain, then restore everything. */
async function withChain(ids, providers, run) {
  const originalChain = CHAINS.text;
  const added = [];
  for (const [id, provider] of Object.entries(providers)) {
    PROVIDERS[id] = provider;
    added.push(id);
  }
  CHAINS.text = ids;
  try {
    return await run();
  } finally {
    CHAINS.text = originalChain;
    for (const id of added) delete PROVIDERS[id];
    breaker.reset();
  }
}

const prompt = () => ({ system: "system text", user: "user text" });

test("a schema-invalid response retries once then moves to the NEXT provider", async () => {
  const calls = [];
  const outcome = await withChain(
    ["stub-bad", "stub-good"],
    {
      "stub-bad": stubProvider("stub-bad", { value: { nonsense: true }, onCall: (id) => calls.push(id) }),
      "stub-good": stubProvider("stub-good", { value: VALID_LENS, onCall: (id) => calls.push(id) }),
    },
    () => executeStructured({ capability: "text", schemaName: "lensResult", resultSchema: lensResult, buildPrompt: prompt }),
  );

  assert.equal(outcome.provider, "stub-good", "the chain must advance past an invalid provider");
  assert.equal(calls.filter((id) => id === "stub-bad").length, 2, "exactly one repair retry, never a loop");
  assert.equal(calls.filter((id) => id === "stub-good").length, 1);
  assert.equal(outcome.fallbackDepth, 1);
});

test("an unconfigured provider is skipped without being called", async () => {
  const calls = [];
  const outcome = await withChain(
    ["stub-off", "stub-good"],
    {
      "stub-off": stubProvider("stub-off", { value: VALID_LENS, configured: false, onCall: (id) => calls.push(id) }),
      "stub-good": stubProvider("stub-good", { value: VALID_LENS, onCall: (id) => calls.push(id) }),
    },
    () => executeStructured({ capability: "text", schemaName: "lensResult", resultSchema: lensResult, buildPrompt: prompt }),
  );

  assert.equal(outcome.provider, "stub-good");
  assert.equal(calls.includes("stub-off"), false, "an unconfigured provider must not be called");
  assert.ok(outcome.skipped.some((entry) => entry.provider === "stub-off" && entry.reason === "unconfigured"));
});

test("a provider in cooldown is skipped without being called", async () => {
  const calls = [];
  breaker.trip("stub-cool", 30_000);
  const outcome = await withChain(
    ["stub-cool", "stub-good"],
    {
      "stub-cool": stubProvider("stub-cool", { value: VALID_LENS, onCall: (id) => calls.push(id) }),
      "stub-good": stubProvider("stub-good", { value: VALID_LENS, onCall: (id) => calls.push(id) }),
    },
    () => executeStructured({ capability: "text", schemaName: "lensResult", resultSchema: lensResult, buildPrompt: prompt }),
  );

  assert.equal(outcome.provider, "stub-good");
  assert.equal(calls.includes("stub-cool"), false, "a rate-limited provider must not receive new traffic");
  assert.ok(outcome.skipped.some((entry) => entry.provider === "stub-cool" && entry.reason === "cooldown"));
});

test("a 429 on the first provider fails over to the second", async () => {
  let parkedStatus = null;
  const outcome = await withChain(
    ["stub-429", "stub-good"],
    {
      "stub-429": stubProvider("stub-429", { failWith: new ProviderError("stub:429", { status: 429, provider: "stub-429" }) }),
      "stub-good": stubProvider("stub-good", { value: VALID_LENS }),
    },
    async () => {
      const result = await executeStructured({ capability: "text", schemaName: "lensResult", resultSchema: lensResult, buildPrompt: prompt });
      // Read the breaker state before withChain restores it.
      parkedStatus = breaker.snapshot("stub-429").status;
      return result;
    },
  );
  assert.equal(outcome.provider, "stub-good");
  assert.equal(parkedStatus, "cooldown", "the 429 provider must be parked");
});

test("a timeout on the first provider fails over to the second", async () => {
  const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError", code: 23 });
  const outcome = await withChain(
    ["stub-slow", "stub-good"],
    {
      "stub-slow": stubProvider("stub-slow", { failWith: timeout }),
      "stub-good": stubProvider("stub-good", { value: VALID_LENS }),
    },
    () => executeStructured({ capability: "text", schemaName: "lensResult", resultSchema: lensResult, buildPrompt: prompt }),
  );
  assert.equal(outcome.provider, "stub-good");
});

test("an exhausted chain reports every attempt and never a provider secret", async () => {
  await assert.rejects(
    () =>
      withChain(
        ["stub-a", "stub-b"],
        {
          "stub-a": stubProvider("stub-a", { failWith: new ProviderError("stub-a:429", { status: 429, provider: "stub-a" }) }),
          "stub-b": stubProvider("stub-b", { failWith: new ProviderError("stub-b:503", { status: 503, provider: "stub-b" }) }),
        },
        () => executeStructured({ capability: "text", schemaName: "lensResult", resultSchema: lensResult, buildPrompt: prompt }),
      ),
    (error) => {
      assert.equal(error.code, "RATE_LIMITED");
      assert.deepEqual(error.attempted.map((entry) => entry.provider), ["stub-a", "stub-b"]);
      assert.equal(/Bearer|api[_-]?key/i.test(error.message), false, "the error must not carry credentials");
      return true;
    },
  );
});

test("a malformed prompt fails fast instead of becoming a provider 400", async () => {
  await assert.rejects(
    () => withChain(["stub-good"], { "stub-good": stubProvider("stub-good", { value: VALID_LENS }) }, () => executeStructured({ capability: "text", schemaName: "lensResult", resultSchema: lensResult, buildPrompt: () => ({ system: "s" }) })),
    /buildPrompt must return a non-empty user message/,
  );
});

test("the result schema union used by /study/analyze rejects a wrong variant", () => {
  const union = z.union([sceneResult, lensResult]);
  assert.equal(union.safeParse(VALID_LENS).success, true);
  assert.equal(union.safeParse({ mode: "nonsense" }).success, false);
});

/* -------------------------------------------------------------------------- */
/* Cavoti: independent failure domains                                        */
/* -------------------------------------------------------------------------- */

test("one Cavoti model failing does NOT disable the other Cavoti models", async () => {
  // The spec requirement: only the gateway being down may affect them together.
  const calls = [];
  breaker.reset();
  breaker.trip("cavoti-mimo", 120_000);

  let failingStatus = null;
  const outcome = await withChain(
    ["cavoti-mimo", "cavoti-glm", "cavoti-hy3"],
    {
      "cavoti-mimo": stubProvider("cavoti-mimo", { value: VALID_LENS, onCall: (id) => calls.push(id) }),
      "cavoti-glm": stubProvider("cavoti-glm", { failWith: new ProviderError("cavoti-glm:429", { status: 429, provider: "cavoti-glm" }), onCall: (id) => calls.push(id) }),
      "cavoti-hy3": stubProvider("cavoti-hy3", { value: VALID_LENS, onCall: (id) => calls.push(id) }),
    },
    async () => {
      const result = await executeStructured({ capability: "text", schemaName: "lensResult", resultSchema: lensResult, buildPrompt: prompt });
      // Read breaker state before withChain restores it.
      failingStatus = breaker.snapshot("cavoti-glm").status;
      return result;
    },
  );

  assert.equal(outcome.provider, "cavoti-hy3", "a sibling Cavoti model must still serve");
  assert.equal(calls.includes("cavoti-mimo"), false, "a parked Cavoti model must be skipped");
  assert.equal(calls.includes("cavoti-glm"), true, "the rate-limited sibling is tried once, then parked");
  assert.equal(calls.filter((id) => id === "cavoti-glm").length, 1, "a 429 is not retried on the same request");
  assert.equal(failingStatus, "cooldown", "the failing model gets its own cooldown");
});

test("a Cavoti 402 parks only that model, and for a long time", async () => {
  const calls = [];
  const outcome = await withChain(
    ["cavoti-mimo", "cavoti-glm"],
    {
      "cavoti-mimo": stubProvider("cavoti-mimo", { failWith: new ProviderError("cavoti-mimo:402", { status: 402, provider: "cavoti-mimo" }), onCall: (id) => calls.push(id) }),
      "cavoti-glm": stubProvider("cavoti-glm", { value: VALID_LENS, onCall: (id) => calls.push(id) }),
    },
    async () => {
      const result = await executeStructured({ capability: "text", schemaName: "lensResult", resultSchema: lensResult, buildPrompt: prompt });
      // Read breaker state before withChain restores it.
      assert.equal(breaker.snapshot("cavoti-mimo").lastErrorCode, "PAYMENT_REQUIRED");
      assert.ok(breaker.snapshot("cavoti-mimo").cooldownMs >= 600_000, "a billing refusal must park for at least 10 minutes");
      return result;
    },
  );
  assert.equal(outcome.provider, "cavoti-glm", "the sibling must still serve");
  assert.equal(calls.filter((id) => id === "cavoti-mimo").length, 1, "402 must not be retried");
  assert.equal(outcome.attempted[0].code, "PAYMENT_REQUIRED");
});

test("a 402 is reported as unsupported, not as a temporary cooldown", () => {
  breaker.recordFailure("cavoti-mimo", new ProviderError("402", { status: 402, provider: "cavoti-mimo" }));
  const health = breaker.healthOf("cavoti-mimo", { configured: true });
  assert.equal(health.state, "unsupported", "a billing condition is not a transient outage");
  assert.equal(health.reason, "not available on the current plan");
});

test("the chain deadline stops starting attempts it cannot finish", async () => {
  const calls = [];
  const slow = {
    id: "stub-slow",
    label: "stub-slow",
    capabilities: ["text"],
    configured: () => true,
    model: () => "stub",
    // Consume the whole budget on the first provider.
    async structured() {
      calls.push("stub-slow");
      await new Promise((resolve) => setTimeout(resolve, 400));
      throw new ProviderError("stub-slow:503", { status: 503, provider: "stub-slow" });
    },
  };
  const original = CHAINS.text;
  PROVIDERS["stub-slow"] = slow;
  PROVIDERS["stub-after"] = stubProvider("stub-after", { value: VALID_LENS, onCall: (id) => calls.push(id) });
  CHAINS.text = ["stub-slow", "stub-after"];
  try {
    await assert.rejects(
      // A deadline shorter than the first attempt, so the second must never start.
      () => executeStructured({ capability: "text", schemaName: "lensResult", resultSchema: lensResult, buildPrompt: prompt, deadlineMs: 200 }),
      (error) => {
        assert.equal(calls.includes("stub-after"), false, "a provider must not be started once the budget is gone");
        assert.ok(error.skipped.some((entry) => entry.reason === "chain-deadline"), "the skip reason must be explicit");
        return true;
      },
    );
  } finally {
    CHAINS.text = original;
    delete PROVIDERS["stub-slow"];
    delete PROVIDERS["stub-after"];
    breaker.reset();
  }
});

test("the attempt budget stops a long waterfall even when providers keep failing", async () => {
  const calls = [];
  const failing = (id) => stubProvider(id, { failWith: new ProviderError(`${id}:503`, { status: 503, provider: id }), onCall: () => calls.push(id) });
  await assert.rejects(
    () =>
      withChain(
        ["cavoti-a", "cavoti-b", "cavoti-c", "cavoti-d", "cavoti-e", "cavoti-f"],
        Object.fromEntries(["cavoti-a", "cavoti-b", "cavoti-c", "cavoti-d", "cavoti-e", "cavoti-f"].map((id) => [id, failing(id)])),
        () => executeStructured({ capability: "text", schemaName: "lensResult", resultSchema: lensResult, buildPrompt: prompt }),
      ),
    (error) => {
      // text allows 3 attempts; a long waterfall is what makes a demo hang.
      assert.equal(calls.length, 3, `expected 3 attempts, got ${calls.length}`);
      assert.ok(error.skipped.some((entry) => entry.reason === "attempt-budget"), "remaining providers must be skipped by budget");
      return true;
    },
  );
});
