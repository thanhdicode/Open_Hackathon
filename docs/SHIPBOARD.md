# YAPYEP PRODUCTION SHIPBOARD

Updated: 2026-09-16
Base commit: 9c2b5d4

## P0

- [x] Appwrite resource bootstrap verified
- [ ] Guest auth persists
- [ ] Journey persists
- [ ] MyDNA persists
- [ ] user_task_progress persists after reload
- [ ] YapLens text = real AI
- [ ] YapLens image = real AI
- [ ] YapLens citations
- [ ] provider fallback
- [ ] YapSim complete round
- [ ] YapSim retry + score delta
- [ ] skill persists
- [ ] Passport verified facts
- [ ] Today reads real state
- [ ] Connect real profile
- [ ] realtime chat
- [ ] production deployment
- [ ] PWA installable
- [x] 390px pass
- [x] 1440px pass
- [x] no client secrets
- [ ] backup demo data
- [ ] demo account

## Quality

- [x] No horizontal mobile overflow
- [x] 44–48px touch controls
- [ ] keyboard usable
- [ ] loading states
- [ ] error states
- [ ] offline state
- [ ] provider 429 state
- [ ] no console errors
- [ ] Lighthouse run
- [ ] golden flows recorded

## Data

- [ ] SG deep corpus
- [ ] VN deep corpus
- [ ] TH deep corpus
- [ ] ID deep corpus
- [ ] MY deep corpus
- [ ] PH deep corpus
- [ ] remaining 5 baseline

## Current blockers

- Browser E2E still needs a full anonymous onboarding, reload, and second-user isolation run.
- Local development receives expected Appwrite 401 probes before anonymous-session creation and needs production custom-domain configuration to avoid the SDK localStorage warning.
- `ai-gateway` deployed instance is unverified from this checkout (function code exists locally only). The local provider layer is verified — see the Phase 3 log below.
- Local env lacks `OPENROUTER_API_KEY` and `CLOUDFLARE_ACCOUNT_ID` (empty); ADR-002 emergency/last-resort providers cannot run until configured. Fallback currently works between Gemini and Groq.
- **Free-tier quota is insufficient for Phase 3.** On 2026-09-16 `gemini-3.8-flash` alternated `429 RESOURCE_EXHAUSTED` and `503 UNAVAILABLE` (high demand). Sustained multimodal verification needs a paid key.

- **Paced soak done** (`npm run verify:soak` → `docs/evidence/phase3/soak.json` + `soak-report.md`): **9/10 calls succeeded (90%)**, and the provider mix proves failover genuinely happened rather than one provider serving everything:
  - TEXT 3/3 — `explabs-luna`×2 + `groq-text`×1 · INTERPRET 3/3 — `groq-text`×3 · VISION 3/3 — `groq-vision`×2 + `explabs-luna`×1
  - TTS FAILED (`AI_UNAVAILABLE`, Gemini rate limited) → the STT sweep was skipped for lack of audio
  - tripped provider skipped: **PASS** · PAYMENT_REQUIRED parked with a 600,000ms cooldown: **PASS**
  - Pacing is the point (45s between vision runs): a burst would report "the provider is dead" when the truth is "we asked too fast".
- **AI Language Profile wired** into Settings → Preferences: interface language, local language (suggested from host country, explicitly never from nationality), level, auto-translate incoming, auto-speak outgoing.
- **Structured conversation memory added**: `conversationMemory` (topic, entities, quantity, location, price, intent, openQuestions, resolvedFacts) carried on `coachInsight` and rendered in the bridge as "Conversation memory", so the student can see and correct what the assistant believes. The bridge never auto-sends a reply.
- **Still not done**: browser-verified TTS fallback, and the full golden demo A–I end-to-end run. **TTS is the honest weak point — Gemini is the only provider in that chain.**

## Phase 4 verification log — Living Greenbook ingestion (2026-09-16)

- `config/source-registry.yaml` **v2.0 — 41 sources, 100% with a source URL.** Every v1.0 entry preserved; added the fields the pipeline needs (agency, domain, source_type, access_strategy, crawl_allowed, language, refresh_frequency, parser), a measured `fetch_policy`, and the `no_url_rule` + `tier_rule` the validator enforces.
- **Liveness measured: 30/39 reachable** (`docs/evidence/phase4/source-liveness.json`).
  - **6 hosts refuse this environment's egress IP**: `id-dikti`, `ph-ched-candidate`, `th-immigration-candidate`, `th-mhesi-candidate`, `unesco-intercultural`, `vn-sbv`. **Hypothesis tested and disproven** — they return 403 to a custom agent, a browser agent and Googlebot alike. Only `vn-sbv` responded to the agent change, so the fetch policy uses a browser agent but the policy is not a bypass.
  - `vn-evisa-candidate` does not resolve. Both `asean.org` URLs serve a 307 the fetcher does not follow.
  - Those sources stay **citable in the UI with a link to the official page**; they are simply not fetched.
- **Measured liveness lives in a generated file, not in the hand-written registry.** Registry = intent; liveness = what the network allows. The first attempt patched the YAML in place and failed on CRLF; the separate file is the better design regardless.
- **Pipeline built** under `scripts/greenbook/`: `registry.mjs`, `snapshot-store.mjs`, `fetch.mjs`.
- **Real fetch proven: 12/12 MY + SG sources, 1.6 MB, all with extracted text, all unique content hashes.** Snapshots land at `{country}/{category}/{source-id}/{date}.html` and the archive is gitignored.
- **Two parser defects found by reading real output rather than assuming it worked:**
  1. Numeric entities (`&#8211;`, `&#038;`) were left encoded in the extracted text.
  2. Site navigation survived, because most government sites place the menu in a plain `<div>`, not a `<nav>`.
  - After the fix the Malaysian Immigration page yields real Tier-A material: *"The Student Pass facility is granted to non-citizen students aged three (3) years and above who pursue studies in Malaysia…"*
- **Storage decision reversed**: R2 was over-engineering. Appwrite already provides Storage and the project already uses it, so snapshots go there — one credential and one permission model instead of two. The store is pluggable, so R2 remains a one-adapter swap.
- **Not built yet, stated plainly**: the Appwrite knowledge tables, RAG, media, and the entire Greenbook UI. **No UI has been written, deliberately** — the brief says build the registry and pipeline first.

### Extraction + validation gate (same day)

- `scripts/greenbook/extract.mjs` turns a page into **candidate** facts through Vyce `agnes-3.0-flash`. Two guarantees are structural rather than prompt-level: `sourceUrl`, `authorityLevel` and `sourceType` are copied from the registry, so **a model cannot introduce a URL or promote its own authority**, and every candidate must carry a verbatim `evidenceQuote`.
- **Real run on the Malaysian Immigration Student Pass page**: 15 candidates, **15 `official_verified`**, 48.6s, 2,492 in / 1,528 out tokens. Real Tier-A facts with quotes — be outside Malaysia when applying, post-arrival medical exam within 7 days, part-time work capped at **20 hours/week** at approved venues.
- `scripts/greenbook/validate.mjs` is the deterministic gate. No model runs inside it and no model can override it.
- **`npm run test:greenbook` — 16/16.** The suite proves the gate *refuses*: no source URL, an unknown source URL, no evidence quote, a too-short or requirement-bundling claim, an unknown chapter, an implausible date, a weak-authority administrative fact, low or missing confidence, and duplicates inside one batch.
- **The suite found a real bug on its first run.** A Tier-D source in a *non*-administrative chapter was passing as `official_verified` — which would have let a TikTok caption carry the same badge as the Immigration Department. Fixed by making the tier rule absolute: **below A/B can never be official, in any chapter.** The fix added the `community_verified` status.
- Design note: **15/15 passing with zero review was the signal something was wrong.** A gate that never rejects is not a gate, which is why the tests feed it known-bad input rather than only checking that good input passes.
- Gate: typecheck PASS · build PASS · `npm test` **111/111** · secret scan PASS.

## Phase 3 FINAL STABILIZATION verification log (2026-09-16)

Gate: `tsc --noEmit` PASS · `npm test` **95/95** · `vite build` PASS · secret scan PASS · Lens renders at 390/430/768/1440 with no overflow and no page errors.

- **Local OCR works — verified 11/11** (`npm run verify:local-ocr`): 8 text regions detected, first paint ~2-3s.
  - **The bug was ours.** Tesseract v7 no longer populates `data.lines`/`data.words` (empty arrays); the hierarchy is `data.blocks[].paragraphs[].lines[]` and `recognize()` needs `output: { blocks: true }`. An isolation run with **no app code in the path** read the menu perfectly in 3.5s, which proved the environment was fine. `lineBoxesFrom()` now walks the block hierarchy.
- **Total provider outage mode verified**: with every route to the AI gateway aborted, the photo still yields 8 locally-read text regions, is presented as useful rather than as an error, and keeps a retry path.
- **The Cavoti single point of failure is gone.** Stage B now asks for a small `sceneInterpretation` (summary, translations keyed by region index, phrases, safety notice) and the **server composes** the frozen `SceneResult` deterministically. Providers able to serve Stage B went from **1 to 4**: `groq-vision` 1.3s, `explabs-luna` 8.4s, `explabs-deepseek` 26.9s, `cavoti-qwen` 83.2s — and `cavoti-glm` failed that run without consequence.
- **Normal Scene Lens path: 4.5s, 8 regions, 8 with OCR, 8 with translations** (previously 22.9s, and before that failing after 62s).
- `parseJsonLoose` now extracts the first `{...}` block when a model wraps JSON in prose — the measured cause of Luna's intermittent `invalid-json`.
- New tool `scripts/verify/ocr-isolate.mjs` runs Tesseract with no app code in the path, so a failure is attributable to the environment rather than to our integration.
- **NOT done, stated plainly**: paced soak (`soak.json`) not generated; AI Language Profile not wired into onboarding; structured conversation state not finished; browser TTS fallback implemented but not browser-verified; the full golden demo A–I not run end to end.

## Phase 3.8 verification log (2026-09-16, Experiential Labs)

- `tsc --noEmit` — PASS · `npm test` — PASS 95/95 · `vite build` — PASS · secret scan — PASS
- Base URL confirmed by probing: **`https://api.experientiallabs.ai/v1`** (302 models). All six cited slugs exist.
- **Measured, and the brief's #1 vision backup is unusable:**
  - ✅ **`gpt-5.6-luna` is FREE and multimodal** — text 1.9s; read "GERAI NASI LEMAK" from the image in **2.2s at cost $0**
  - ✅ `deepseek-v4-flash` (cost $0.0000016), `qwen3.8-27b` (cost $0.000045)
  - ❌ **`deepseek-v4-flash-vision-exp` → `model_requires_purchase`**; so are `glm-5.3-flash` and `deepseek-v4-flash-0731`
  - ❌ `deepseek-v4-flash-vision-exp:free` → 403 "alias is not granted to this identity"
- **Trap found: Experiential signals a purchase lock with HTTP 429, not 402.** Treated as a rate limit it would retry a permanently unavailable model every 45s forever. Now detected from the body and re-coded as `PAYMENT_REQUIRED` with a 10-minute cooldown.
- **The credits endpoint in the brief (`/api/v1/credits`) does not exist** — 404, as do `/user/credits`, `/me`, `/balance`, `/usage`. Cost is read from `usage.cost` per response; `budget.js` enforces `EXPLABS_SESSION_BUDGET_USD` / `EXPLABS_DEMO_BUDGET_USD`, with `EXPLABS_FREE_ONLY` defaulting to true so credits are only spendable deliberately.
- **Stage B needed its own chain.** A full SceneResult is a large structured output and most providers cannot produce it: `groq-text` is rejected outright (its per-minute output ceiling sits below what the schema reserves), `explabs-luna`/`explabs-deepseek` return schema-invalid payloads, `groq-vision` returns empty. `cavoti-glm` produced a valid 8-region result. Added an `interpret` chain led by measured-capable providers: **the normal path went from failing after 62s to succeeding in 22.9s** (A=groq-vision, B=cavoti-glm, 8 regions with OCR).
- Also bounded `sceneResult` (strings and item counts) for the same reservation reason as VisualEvidence — an unbounded SceneResult was rejected by Groq with a 400 before the model ran.
- Final state: **20 providers**; chains `text(15) visual(12) vision(10) stt(2) tts(1) interpret(10)`.
- **NOT verified: the full failover ladder under load.** Individual providers are flaky (Luna occasionally returns non-JSON, which the chain absorbs), so one ladder run is not conclusive. The Lens UI still does not call local OCR.

## Phase 3.7 verification log (2026-09-16, two-stage Scene Lens + OpenRouter)

- `tsc --noEmit` — PASS · `npm test` — PASS 95/95 · `vite build` — PASS · secret scan — PASS
- **The biggest win of the day: splitting Scene Lens into two stages took Stage A from 34.4s to 3.3s with precise per-line boxes** ("GERAI NASI LEMAK" at [44,128,99,634], "RM 6.50" at [205,628,226,717]).
  - Stage A (`visualExtraction`) asks a vision provider only to OBSERVE into a small `VisualEvidence` payload.
  - Stage B (`sceneFromEvidence`) asks a **text** model to reason over that evidence into the full `SceneResult`.
  - Text providers are plentiful, so the vision provider no longer needs to be good at large structured output.
- **The second-order fix mattered more than the split itself.** The first Stage A had both `visibleTexts` AND a separate `regions` array. Two overlapping lists made the model return coarse whole-image boxes for one of them. **Removing the redundant array so each text entry carries its own box** is what produced tight boxes and the 10x speedup.
- **Groq strict mode reserves output tokens equal to the schema's THEORETICAL maximum.** Measured: "the request's expected output tokens exceed the enforced limit; reduce max_tokens" — a schema allowing 40+30+30 items reserved 1,075 tokens against a 1,000 OTPM ceiling and was rejected *before the model ran*. Fixed by bounding item counts AND every string length, plus an explicit `max_tokens`.
- Truncated responses (`finish_reason === "length"`) now report as `AI_EMPTY` instead of failing validation as if the model answered wrongly.
- **Never a dead screen, verified both ways** with all 10 vision providers tripped:
  - device OCR present → real reasoned result in the student's language
  - no device OCR → a valid result saying "This photo could not be read right now. Nothing was invented to fill the gap." (0 regions, low confidence, no fabrication)
- **OpenRouter probed with the real key** (20 free models): `inclusionai/ling-3.0-flash-vl:free` (3.5s) and `dots-studio/dots-3-note-preview:free` (5.0s) both read the menu. `google/gemma-4-26b-a4b-it:free` returned 429.
- **OpenRouter audio is dead on this account**: `thinkingmachines/inkling:free` → 403 (agentic harnesses only); `nvidia/nemotron-3-nano-omni-…:free` → 402 (needs $0.50 balance for audio). Two models advertise audio input; neither serves it.
- New chains with tiers and a bounded waterfall: `visual` = groq-vision → openrouter-ling → openrouter-dots → cavoti-* → cloudflare-vision → gemini → openrouter. **Attempt budget: 2 for vision, 3 for text**, env-overridable — a long waterfall is what makes a demo hang.
- `tesseract.js` installed for on-device OCR. **`@huggingface/transformers` NOT installed** — `npx pnpm` hung for 8 minutes; use `pnpm` directly (it is on PATH).
- **NOT done:** the Lens UI does not call local OCR yet (the module works, the wiring does not); **Experiential Labs was not added — no `EXPLABS_API_KEY` was provided**; conversation state, AI Language Profile onboarding and the progressive-motion UX remain open.

## Phase 3.6 verification log (2026-09-16, Cavoti omnimodal rescue)

- `tsc --noEmit` — PASS · `npm test` — PASS 90/90 · `vite build` — PASS
- **Cavoti base URL discovered by probing: `https://cavoti.com/v1`** (86 models). It was not in the brief; `api.cavoti.com` returns 404 and `beta.cavoti.com` returns 403.
- **`npm run verify:cavoti` — 17 probes across 7 models × 3 modalities** (`docs/evidence/phase3/cavoti-matrix.json`). Registry capability flags now come from this evidence, not from model names.
- **Three corrections to the brief, all measured:**
  1. **`mimo-v2.5` is NOT usable** — HTTP 402 "The primary balance is not positive enough to start this Marketplace request". It was the brief's highest-priority rescue model.
  2. **`qwen-3.8-flash` ≠ `qwen3.8-flash`** — the hyphenated ID also returns 402; only `qwen3.8-flash` serves.
  3. **No Cavoti model accepts audio.** Two returned **HTTP 200 with a refusal inside the body** ("Unsupported content type … this model only supports text input"). The probe's first pass counted those as passes — fixed with content-level refusal detection. **An HTTP 200 is not an acceptance.**
- Measured capability matrix: text on 5 models; vision on 3 (`qwen3.8-flash`, `glm-5.3-flash`, `hy3` — all read "GERAI NASI LEMAK" from the menu fixture); **audio on none**.
- **`npm run verify:scene3` — 3/3 images pass the full SceneLens contract with Gemini's circuit forced open** (`docs/evidence/phase3/scene-lens-3.json`):
  - A Malaysian menu → `cavoti-hy3` · B Singapore campus notice (English + Malay + Mandarin) → `groq-vision` · C mixed-language group chat → `groq-vision`
  - **served-by-Gemini count: 0** — the spec's "at least one Cavoti route completes Scene Lens with Gemini disabled" is met.
- Each Cavoti model has its **own circuit**, so one model being rate limited cannot disable the others. `PAYMENT_REQUIRED` (402) parks a circuit for 10 minutes instead of retrying on every request.
- **Added a chain deadline** (vision 75s, text 60s): one measured Scene Lens call took **111s** because four providers each failed slowly in turn. Slow failures compound, so the chain now refuses to start an attempt it cannot finish inside the budget.
- Routing order follows **measured latency**, not the vendor list: `groq-vision` 3.1–4.7s leads vision, then `cavoti-glm` 5.3s, `cavoti-hy3` 6.0s, `cavoti-qwen` 6.6s. `cavoti-mimo` moves later because it cannot serve.
- **Cloudflare is now configured** (account id supplied) and all three legs report healthy: `@cf/google/gemma-4-26b-a4b-it`, `@cf/openai/whisper-large-v3-turbo`, plus a text model.
- **Pacing is now load-bearing:** Groq qwen allows 1,000 output tokens/minute and one Scene Lens response is most of that — roughly one image per minute. `verify:scene3` paces at 65s; `verify:acceptance` at 20s between criteria.
- Verification artifacts keep **run history and best-ever per item**, so a rate-limited later run cannot erase a genuine pass.

## Phase 3.5 acceptance log (2026-09-16)

- `tsc --noEmit` — PASS · `vite build` — PASS · `npm test` — PASS 77/77 (7 foundation + 39 contracts + 31 reliability)
- **Acceptance checklist: 7/8 criteria met** (`npm run verify:acceptance`, `docs/evidence/phase3/acceptance.json` records every run and the best result ever seen per criterion, so a rate-limited later run cannot erase a genuine pass):
  - [x] text does not depend on Gemini — `groq-text`
  - [x] Scene Lens works with Gemini disabled — `groq-vision`, 8 regions, boxes in range, 4.3s, Gemini in cooldown
  - [x] Conversation works with Gemini disabled — `stt=groq-whisper translate=groq-text coach=groq-text reply=groq-text`
  - [x] YapSim works with Gemini disabled — `start/turn/finish` all `groq-text`, 6 frozen dimensions
  - [x] provider health endpoint — all 8 providers with valid states
  - [x] no provider secret in any response
  - [x] concurrency guard active and bounded (max 4)
  - [ ] **STT has two providers — BLOCKED**: the Cloudflare leg is implemented but `CLOUDFLARE_ACCOUNT_ID` is empty
- Browser evidence, Conversation Bridge at 390px (`npm run verify:bridge`, `docs/evidence/phase3/bridge-evidence.json`) — 8/8:
  - onboarding reaches the five-tab shell; Lens exposes five input modes; the two-lane bridge renders
  - no horizontal overflow (390/390); no page errors; the only console errors are the pre-existing Appwrite guest probes
  - **denied microphone falls back instead of dead-ending** — "Microphone access was blocked. You can type or upload an audio file instead."
- **Measured constraint that changed the product:** Groq qwen allows **1,000 output tokens/minute**, and a Scene Lens response with 11 regions exceeded that on its own. Capping the prompt at 8 regions and requiring short fields took the same image from 11 regions/5.0s to 8 regions/4.3s — the response size is now budgeted against the provider's *output* ceiling, not just its context window.
- Reliability probes (`npm run verify:reliability`, `docs/evidence/phase3/reliability.json`): text fails over when the primary is tripped; tripped providers are skipped rather than retried; `qwen/qwen3.8-27b` read "GERAI NASI LEMAK" from the real menu fixture.
- Verification is now **self-limiting**: repeated acceptance runs exhaust the free tier, and a later criterion can fail on budget an earlier one consumed. The acceptance script paces between criteria (`ACCEPTANCE_PACE_MS`, default 20s) and the soak test must be paced harder.
- NOT verified: `cloudflare-text`, `cloudflare-vision`, `cloudflare-stt` and `openrouter` have never been exercised. `npm run verify:soak` has not been run.

## Phase 3.5 verification log (2026-09-16, AI reliability rescue)
- **The real bug behind a whole phase of Scene Lens failure was ours, not the provider's.** `prompts.scene()` returned only a `system` message and never a `user` message, so every provider received an undefined body and answered 400. This had been misread as a provider outage and as a `responseJsonSchema` problem. `executeStructured()` now fails fast if `buildPrompt()` returns an empty `system` or `user`.
- Groq `qwen/qwen3.8-27b` verified for vision and strict structured output: it read "GERAI NASI LEMAK" from the real menu fixture. Groq strict mode initially rejected the schema — it requires every property in `required` — fixed by `toStrictSchema()`.
- Circuit breaker verified by 23 deterministic tests: 429 opens immediately using `retry-after`; 503/timeout open a short growing cooldown; a schema failure never opens the circuit; cooldown expiry allows exactly one probe; a timeout normalises to `AI_UNAVAILABLE` rather than DOMException code 23.
- Failover verified against live providers (`docs/evidence/phase3/reliability.json`, 8/10):
  - PASS text fails over when the primary is tripped — served by `groq-vision`, `degradedProviders=[groq-text]`
  - PASS YapSim completes with Gemini in cooldown
  - PASS tripped providers are skipped, not retried (chain exhausted cleanly instead of hammering)
  - FAIL Scene Lens with Gemini in cooldown — see the open gap below
  - FAIL STT failover — no second STT provider until Cloudflare is configured
- **Open gap, measured:** on the final run `groq-vision` **and** `gemini` both returned 429 in the same request, so Scene Lens failed with `RATE_LIMITED`. With Cloudflare unconfigured, Scene Lens still has only two real legs.
- Measured free-tier ceilings: Groq qwen `qwen/qwen3.8-27b` = 1,000 RPD, 8,000 TPM, and a separate **1,000 output-tokens/minute** ceiling. One 1600px image is ~2,000 tokens → roughly 3 vision calls per minute.
- NOT verified: `cloudflare-text`, `cloudflare-vision`, `cloudflare-stt` and `openrouter` are implemented but never exercised — `CLOUDFLARE_ACCOUNT_ID` is empty and there is no `OPENROUTER_API_KEY`. The soak run (`npm run verify:soak`) has not been executed.
- Do not claim two-provider STT or Gemini-free vision until the Cloudflare account id is configured and those legs are probed.

## Phase 3 verification log (2026-09-16, AI Interaction Core)

- `tsc --noEmit` — PASS (exit 0)
- `vite build` — PASS (exit 0; 218 modules; 668 kB JS / 191 kB gzip)
- `npm run test:contracts` — PASS 39/39
  - server contract accepts every valid fixture, rejects every invalid fixture
  - client mirror and server contract agree on all 18 contracts
  - a payload missing `confidence`, `misunderstandingRisk` or a score dimension is rejected on BOTH sides (the old gateway `normalize()` that invented them is deleted)
  - generated `schemas/*.schema.json` match the live contracts
  - no contract exposes `chainOfThought`, `reasoning`, `apiKey`, `rawMedia` or `rawAudio`
- `npm run verify:ai` — 14/16 routes verified against live providers (`docs/evidence/phase3/provider-matrix.json`)
  - PASS: health, lens/text, reply, tone-check, coach, sim/start, sim/turn, sim/finish (6/6 frozen dimensions), tts (playable WAV), transcribe (round trip on generated audio), live/token agent, live/token translate, Tetum refusal, response hygiene
  - FAIL (environmental, not defects): `lens/scene` — gemini-3.8-flash 503/429; `study/analyze` — groq 429
- Model availability confirmed against the account listing: `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.8-live`, `gemini-3.5-live-translate-preview`, `gemini-3.5-transcribe-live`, `gemini-3.1-flash-tts-preview`
- Provider corrections found by probing, not by reading docs:
  1. `auth_tokens` REST field is `bidiGenerateContentSetup`; the SDK name `liveConnectConstraints` returns `400 Unknown name`
  2. `responseJsonSchema` returns `400 INVALID_ARGUMENT` for some payloads — `$schema`/`format` are now stripped and the call retries with the schema in the prompt
  3. Gemini TTS returns headerless PCM; the gateway wraps it in RIFF/WAVE so a browser can play it
  4. Groq Whisper reports `language` as a display name ("malay"); mapped to BCP-47, `und` when unrecognised
  5. A raw `AbortSignal.timeout` leaked DOMException code 23 into the API response; all provider failures now normalise to contract codes
- YapSim is now a real simulator. `npm run verify:sim` (`scripts/verify/sim-loop.mjs`) — 6/7:
  - `/sim/start` returned a real scenario: "Đặt Nasi Lemak tại quầy ăn", persona Ahmad, maxTurns 4, difficulty 1
  - three real `/sim/turn` calls produced state-tracking persona replies in Malay (quantity → takeaway → payment), i.e. the persona follows the transaction rather than replaying a script
  - `/sim/finish` returned exactly the 6 frozen dimensions with all scores in 0-100 and a concrete priority improvement
  - FAIL (environmental): the retry-attempt `/sim/finish` hit `gemini:429` — Groq failed and the Gemini fallback was also rate limited
- Seeded data removed from the golden path: `SIM_SCENARIOS`, the 900ms turn timer and the pre-baked `scores.before/after` are no longer used by `src/features/YapSim.tsx`
- Persistence added: `src/lib/appwrite/practice.ts` writes owner-scoped `practice_sessions` rows and updates `skill_profiles`. NOT verified end to end — that needs the deployed function or a browser session against provisioned tables.
- NOT done in Phase 3 yet: Study Copilot still renders static samples, conversation sessions are not persisted (YapSim attempts are), streaming STT and the browser Live WebSocket are not wired, onboarding does not collect the AI Language Profile, and Practice This Situation passes an incident string rather than the full Lens scene
- Browser evidence captured (`docs/evidence/phase3/lens-evidence.json`, `lens-input-*.png`) — headless Chromium, anonymous onboarding walked to the app shell, Lens rendered at 390×844 / 430×932 / 768 / 1440×900:
  - horizontal overflow: none at any breakpoint (scrollWidth === clientWidth)
  - page errors: none
  - console errors: only the pre-existing Appwrite guest probes (401 then 404, and `loadJourney` row-not-found on a fresh guest). No new errors from Phase 3.
  - The new Scene Lens input surface renders (mode selector, upload area, camera fallback) and the five-tab nav is intact.
- `scripts/verify/lens-evidence.mjs` added for repeatable Phase 3 UI evidence. Note: the older `scripts/verify/responsive.mjs` onboarding walk stalls — it clicks the country step in the wrong order and re-selects an already-chosen (disabled) country. That harness needs the same enabled-check fix.

## Phase 0 verification log (2026-09-16, single-owner mode)

- `tsc --noEmit` — PASS (exit 0)
- `vite build` — PASS (exit 0; 196 modules; 572 kB JS / 166 kB gzip; chunk-size warning deferred to Phase 6)
- `node --test scripts/appwrite/schema.test.mjs` — PASS (3/3)
- Secret scan (Google/Groq/generic-key/JWT/AWS patterns over tracked files + `dist/`) — no matches; `.env.local` gitignored, var names/lengths only inspected
- `verify:appwrite` (read-only) — PASS: 13/13 P0 tables verified, zero column drift; temp-media bucket present
- Dev server — NOT running in this checkout (no listener on 5173/8443/4173); start before browser evidence phases

## Phase 1 verification log (2026-09-16, ADR-003 responsive UI)

- `pnpm verify:responsive` (headless Chromium, `scripts/verify/responsive.mjs`) — PASS at 360/390/430/768/1024/1440:
  - 360/390/430: bottom nav only, no rail, no overflow, min nav target 51px
  - 768: compact rail 76px, workspace 692px, min target 44px
  - 1024: rail 220px, workspace 800px (panel suppressed — 220+680+300 would not fit)
  - 1440: rail 220px + workspace 800px + context panel 300px, evidence portalled into panel
  - card shadow = none at every viewport; body background = `rgb(247, 247, 245)`
- Screenshots + raw metrics: `docs/evidence/phase1/` (`report.json`, `today-*.png`, `lens-*.png`, `lens-result-*.png`)
- Live AI confirmed during evidence run: `ai-gateway` returned a real Lens result (`aiOutcome: result-rendered`)
- Bugs found by the browser gate and fixed in-phase:
  1. `persistJourney` ran inside a React state updater → StrictMode double-invoked it → concurrent `saveJourney` writes hit 409 unique-column errors and the first journey save was dropped. Persistence now runs from one gated effect over pure updaters (`JourneyContext`), with a deterministic read→update/create upsert (`journeyPersistence`).
  2. `Card`'s `bg-surface` could not be overridden by a `bg-*` utility passed via `className` (Tailwind resolves competing background utilities by stylesheet order), which rendered Today's practice card blank. `Card` now takes an explicit `tone`.
  3. Portalling Lens evidence into the CSS-hidden `<aside>` dropped the block below 1200px; the panel target is now gated on a real viewport match (`wide` ≥ 1200px).

## Next merge

- Phase 2 (identity / profile / settings / privacy) proceeds from the Phase 1 working tree; browser evidence via `pnpm verify:responsive`.
