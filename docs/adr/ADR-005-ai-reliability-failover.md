# ADR-005 — AI reliability: multi-provider failover, circuit breaker, request budget

- **Status:** Accepted
- **Date:** 2026-09-16
- **Supersedes:** the provider ordering in ADR-004 §1. ADR-004's contract split, two-lane design and Tetum refusal remain in force.
- **Requirement:** `docs/05_AI_CONTRACTS.md` §7 forbids silently changing model routing.

## Context

Phase 3 shipped with Gemini as both a special capability provider and the
fallback. Measured on 2026-09-16, `gemini-3.8-flash` alternated
`429 RESOURCE_EXHAUSTED` and `503 UNAVAILABLE` for the whole session. With
Gemini in the chain twice, one Google outage took out several routes at once.

Separately, the first reliability run found Scene Lens failing with
`PROVIDER_REJECTED`. The cause was **not** the provider: `prompts.scene()`
returned only a `system` message and never a `user` message, so every provider
received an undefined message body and answered 400. That failure looked like a
provider outage for an entire phase.

## Decision

### 1. Gemini is not load-bearing for any capability

| Capability | Chain |
|---|---|
| text | `groq-text` → `groq-vision` → `cloudflare-text` → `gemini` → `openrouter` |
| vision | `groq-vision` → `cloudflare-vision` → `gemini` → `openrouter` |
| stt | `groq-whisper` → `cloudflare-whisper` |
| tts | `gemini` (with client-side browser speechSynthesis, then text-only) |

Google now sits behind Groq for text and vision, and behind Groq for speech.

### 2. Capability registry, not per-route provider calls

Routes declare a **capability**; `registry.js` walks the chain. A route cannot
name a vendor, so ordering changes in one place.

### 3. Circuit breaker

`breaker.js` keeps per-provider health. A 429 opens the circuit immediately
using the provider's `retry-after` when present (30–60s otherwise). A 503 or
timeout opens a *short* cooldown that grows on repeat, capped at 5 minutes.
A schema failure never opens the circuit — the provider answered, it answered
wrong. When a cooldown elapses, exactly one probe is allowed; success closes the
circuit, failure reopens it.

State is per function instance and in-memory. Appwrite may run several
instances, so this bounds damage rather than providing a single global view.
A breaker that needed a database round-trip would add latency to every request.

### 4. Schema-invalid output moves to the next provider

One repair retry on the same provider carrying the Zod issue list, then the
chain advances. It never loops on a broken provider.

### 5. Strict structured output is transformed, not abandoned

Groq (like OpenAI) rejects a strict schema whose `required` omits any key in
`properties`. Verified message:

> `required` is required to be supplied and to be an array including every key
> in properties. The following properties must be listed in `required`: …

`toStrictSchema()` therefore makes every property required and expresses
optional fields as nullable, and `stripNulls()` maps a returned `null` back to
"absent" before Zod runs. This is a structural mapping, not a default: a null on
a required field still fails the contract. `json_object` remains the fallback
when strict is rejected.

### 6. Request budget

`MAX_CONCURRENT` (default 4) bounds outbound calls per instance with a bounded
wait queue. Every route is exactly one inference: Scene Lens is one structured
call, a YapSim turn is one call, Sim finish is one call, Study analyze is one
call.

Measured constraints that make this necessary:
- Groq qwen `qwen/qwen3.8-27b`: 1,000 requests/day, **8,000 TPM**, and a separate
  **1,000 output-tokens/minute** ceiling. One 1600px image costs ~2,000 tokens.
  Roughly 3 vision calls per minute is the practical ceiling.

### 7. Provider neutrality in the UI

The response carries `providerUsed`, `fallbackDepth`, `degradedProviders`,
`unconfiguredProviders` and `latencyMs` as internal telemetry. The student sees
"Primary AI" / "Backup AI" / "AI is busy — trying another route" /
"Voice unavailable" / "Text only". No vendor name, no HTTP status, no stack trace.

### 8. TTS must never block the conversation

`gemini` TTS → browser `speechSynthesis` with a language-matched voice → a
text-only card. `speakWithFallback()` never throws.

### 9. Fail fast on a malformed prompt

`executeStructured()` validates that `buildPrompt()` returns a non-empty
`system` **and** `user` before dispatching. This exists specifically because the
missing-`user` bug above was indistinguishable from a provider outage.

## Consequences

- **Positive:** no golden-path scene depends on one provider; a tripped provider is skipped rather than retried.
- **Positive:** the prompt-shape guard converts a whole class of silent bug into an immediate, explicit failure.
- **Negative:** more moving parts. The breaker's per-instance state means failover is not perfectly consistent across concurrent function instances.
- **Open:** `cloudflare-*` and `openrouter` are implemented but **unverified** — `CLOUDFLARE_ACCOUNT_ID` is empty and no `OPENROUTER_API_KEY` exists. Until then the second vision and second STT legs are theoretical, and a Groq outage still degrades Scene Lens to Gemini.
- **Constraint:** free tiers have no SLA. A paid or prepaid route at the end of the chain is the insurance, not the default path.

## Verified 2026-09-16

See `docs/evidence/phase3/reliability.json` and the 23 breaker/schema tests in
`scripts/verify/reliability.test.mjs`. Confirmed: text fails over when the
primary is tripped; YapSim completes with Gemini in cooldown; tripped providers
are skipped and not retried; a timeout normalises to a contract code rather than
a DOMException number.
