# ADR-004 — Phase 3 AI Interaction Core: provider update and contract split

- **Status:** Accepted
- **Date:** 2026-09-16
- **Supersedes:** the model IDs pinned in `docs/05_AI_CONTRACTS.md` §7 and the `ai_live_optional` entry in `config/project-decisions.yaml`
- **Requirement:** `docs/05_AI_CONTRACTS.md` §7 forbids silently changing a model ID. This record exists so the change is not silent.

## Context

Phase 3 turns every existing AI affordance into a real multimodal loop:
SEE → UNDERSTAND → TRANSLATE → DECIDE → SPEAK → PRACTICE → LEARN → ADAPT.

Two things forced a decision:

1. The pinned live model (`gemini-3.1-flash-live-preview`) is now legacy, and Google ships a dedicated speech-to-speech translation model that is a better fit for the interpreter lane.
2. The single shared Lens-shaped result contract was being reused for Reply and Tone Check, and the gateway normalised provider output into shape by inventing `confidence`, `misunderstandingRisk` and reply modes. That directly violates `docs/05_AI_CONTRACTS.md` §6.

## Decision

### 1. Provider matrix

| Task | Model | Lane |
|---|---|---|
| Text reasoning / JSON | `groq/openai/gpt-oss-120b` | coach, reply, tone, sim, study text |
| Image / screenshot / PDF | `gemini-3.8-flash` | Lens scene, Lens document |
| Scene bounding boxes | `gemini-3.8-flash` | Scene Lens regions |
| Multimodal fallback | `gemini-3.7-flash` | used when the primary fails retryably |
| Recorded STT | `groq/whisper-large-v3-turbo` | push-to-talk transcription |
| Streaming STT | `gemini-3.5-transcribe-live` | P1, not yet wired |
| Pure live translation | `gemini-3.5-live-translate-preview` | Conversation Bridge interpreter lane |
| Conversational voice agent | `gemini-3.8-live` | YapSim voice, P1 |
| TTS | `gemini-3.1-flash-tts-preview` | speaking for the student |

### 2. Two lanes, never one

`gemini-3.5-live-translate-preview` supports translation only — no tools, no
function calling, no structured output, no system instructions, and audio input
only. The Context Coach therefore runs as a **separate** lane over the
transcript on a reasoning model. Translation and coaching must never share a
contract or a model call.

### 3. Tetum is refused, not degraded

Tetum is absent from the provider's 70+ supported list. `POST /live/token` with
`mode: "translate"` and an unsupported target returns `422
LANGUAGE_UNSUPPORTED` with fallback options rather than opening a voice session
that cannot work. The product must never claim voice coverage for all 11 ASEAN
member states.

### 4. Contract split

The single shared result contract is replaced by per-operation contracts:
`LensResult`, `SceneResult`, `SceneRegion`, `ReplyResult`, `ToneCheckResult`,
`TranscriptionResult`, `TranslationTurn`, `SpeechResult`, `CoachInsight`,
`ConversationSession`, `ConversationTurn`, `SimScenario`, `SimTurn`,
`SimFeedback`, `StudyResult`, `AssignmentResult`, `LectureResult`,
`LiveTokenResult`.

`schemas/*.schema.json` is generated from the gateway Zod contracts
(`npm run schemas:generate`) instead of being hand-maintained.

### 5. No invented defaults

Provider output is validated and rejected. A payload missing `confidence`,
`misunderstandingRisk` or a score dimension fails the contract, the gateway asks
the provider once more with the validation errors, and then returns
`SCHEMA_INVALID`. The previous `normalize()` repair path is deleted.

## Consequences

- **Positive:** the translation lane and the reasoning lane can evolve independently; a new provider cannot silently change result shape; every route has a real fallback.
- **Positive:** contract drift between the deployed function and the browser is caught by `npm run test:contracts`.
- **Negative:** contracts exist in two files (gateway and client) because an Appwrite function must stay self-contained when deployed. The parity test is the mitigation.
- **Constraint:** the free tier for `gemini-3.8-flash` is insufficient for sustained multimodal verification. Observed on 2026-09-16: `429 RESOURCE_EXHAUSTED` and `503 UNAVAILABLE` (high demand) alternating. The fallback chain is load-bearing, not decorative.
- **Constraint:** `responseJsonSchema` is rejected with `400 INVALID_ARGUMENT` on some requests. The gateway sanitises `$schema`/`format` and retries once with the schema moved into the prompt, still validating with Zod.

## Verified on 2026-09-16

See `docs/evidence/phase3/provider-matrix.json`. Model availability confirmed
against the account's `models` listing, which returns `gemini-3.8-flash`,
`gemini-3.7-flash`, `gemini-3.8-live`, `gemini-3.5-live-translate-preview`,
`gemini-3.5-transcribe-live` and `gemini-3.1-flash-tts-preview`.

Provider-specific corrections found by probing rather than by reading docs:

- The `auth_tokens` REST field is `bidiGenerateContentSetup`; the SDK name
  `liveConnectConstraints` is rejected with `400 Unknown name`.
- `inputAudioTranscription`/`outputAudioTranscription` cannot be locked into the
  token constraint.
- Gemini TTS returns headerless 16-bit PCM, which a browser cannot play; the
  gateway wraps it in a RIFF/WAVE container.
- Groq Whisper reports `language` as a display name ("malay"); the gateway maps
  names to BCP-47 and uses `und` when a name is unrecognised rather than
  substituting a plausible code.
