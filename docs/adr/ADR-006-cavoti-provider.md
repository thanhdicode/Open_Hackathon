# ADR-006 — Cavoti omnimodal provider: measured capability, not marketing

- **Status:** Accepted
- **Date:** 2026-09-16
- **Extends:** ADR-005 (multi-provider failover). The capability registry, circuit breaker and request budget are unchanged.
- **Requirement:** `docs/05_AI_CONTRACTS.md` §7 forbids silently changing model routing.

## Context

A Cavoti AI account was added as a rescue provider. Cavoti is an
OpenAI-compatible multi-provider aggregator, so it can serve several independent
upstream models behind one endpoint.

The brief listed expected capabilities for six models. **The brief was partly
wrong, and the probe found it.** The rule applied throughout: a capability is
UNKNOWN until a real request succeeds, and an HTTP 200 is not an acceptance.

## Measured result (2026-09-16)

Evidence: `docs/evidence/phase3/cavoti-matrix.json`.

| model | text | image | audio |
|---|---|---|---|
| `mimo-v2.5` | ❌ **402** balance required | not probed | not probed |
| `qwen-3.8-flash` | ❌ **402** balance required | not probed | not probed |
| `qwen3.8-flash` | ✅ | ✅ reads a real menu | ❌ 400 |
| `glm-5.3-flash` | ✅ | ✅ reads a real menu | ❌ 503 |
| `minimax-m3` | ✅ | ❌ 400 "Vision is disabled for model" | ❌ refused in content |
| `deepseek-v4-flash-0731` | ✅ | ❌ 400 "Vision is disabled for model" | ❌ refused in content |
| `hy3` | ✅ | ✅ reads a real menu | ❌ 400 |

Three corrections to the brief:

1. **MiMo-V2.5 is not usable.** It is the brief's "highest priority rescue
   model", but it returns `402 — The primary balance is not positive enough to
   start this Marketplace request`. No balance is available on this account.
2. **`qwen-3.8-flash` and `qwen3.8-flash` are different models.** Only the
   unhyphenated ID serves; the hyphenated one returns 402.
3. **No Cavoti model accepts audio input.** Every candidate either returned 400
   ("does not support audio input") or — worse — returned **HTTP 200 with a
   refusal inside the body**: "Unsupported content type … this model only
   supports text input". Counting those as passes would have shipped a false
   capability claim.

## Decision

### 1. Per-model circuits

Each Cavoti model is its own provider id, so it has its own circuit. One Cavoti
model being rate limited cannot disable the others; only the gateway itself
being unavailable affects them together.

### 2. Capability flags come from the probe

`capabilities` on each provider reflects the table above. `audio` is `false`
everywhere. No Cavoti model appears in the `stt` chain, because raw audio must
not be routed to a model that only accepts text.

### 3. 402 is a billing condition, not a transient failure

A new `PAYMENT_REQUIRED` code parks the circuit for ten minutes instead of
retrying on every request. `mimo-v2.5` and `qwen-3.8-flash` stay in the chain so
that adding balance lights them up with no code change.

### 4. Routing order follows measured latency, not the vendor list

Measured vision latency: `groq-vision` 3.1–4.7s, `cavoti-glm` 5.3s,
`cavoti-hy3` 6.0s, `cavoti-qwen` 6.6s.

```
vision  groq-vision → cavoti-glm → cavoti-qwen → cavoti-hy3 → cavoti-mimo → cloudflare-vision → gemini → openrouter
text    groq-text → groq-vision → cavoti-qwen → cavoti-glm → cavoti-hy3 → cavoti-mimo → cavoti-minimax → cavoti-deepseek → cloudflare-text → gemini → openrouter
stt     groq-whisper → cloudflare-whisper
tts     gemini
```

The brief allowed reordering the first two "based on measured latency/reliability
after probes". That is exactly what was done: `cavoti-mimo` moves later because
it cannot serve, and the verified fast provider leads.

### 5. A chain deadline bounds the worst case

One measured Scene Lens call took **111 seconds** because four providers each
failed slowly in turn. Slow failures compound. `executeStructured` now holds a
per-capability wall-clock budget (vision 75s, text 60s, env-overridable) and
will not start an attempt it cannot finish inside it. An attempt that starts is
also capped by the remaining budget.

## Consequences

- **Positive:** Scene Lens completed with Gemini disabled on all three test images, and a Cavoti route (`hy3`) served one of them — including reading English, Malay and Mandarin on the same sign.
- **Positive:** the audio claim was caught before it shipped. Three independent rejection mechanisms agreed.
- **Negative:** the Cavoti free tier is a shared aggregator and returns `503 Gateway capacity is temporarily exhausted` under load. It is a rescue provider, not a primary.
- **Open:** `cavoti-mimo` and `cavoti-qwen` are in the chain but parked. If balance is added they will serve immediately.
- **Open:** audio input remains unverified on every Cavoti model. Do not claim omnimodal audio until a probe accepts it.

## Verified

- `npm run verify:cavoti` — 17 probes across 7 models, 3 modalities, with content-level refusal detection.
- `npm run verify:scene3` — 3/3 images pass the full SceneLens contract with Gemini's circuit forced open; served-by-Gemini count is 0.
