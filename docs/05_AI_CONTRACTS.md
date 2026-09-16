# 05 — AI Contracts and Prompting Rules

## 1. Global system rules

All AI features must follow:
- help students learn, communicate, and adapt;
- never claim nationality determines personality;
- use probabilistic language for cultural interpretation;
- distinguish evidence from inference;
- administrative facts require supplied authoritative evidence;
- do not fabricate citations;
- if evidence is insufficient, say so;
- return structured output only where schema is defined;
- never expose chain-of-thought; provide concise rationale/evidence instead;
- minimize storage of private raw messages/media.

## 2. YapLens contract

Input:
- user text and/or screenshot-derived content
- home country
- host country
- city/university optional
- situation/context
- MyDNA summary
- preferred output language
- retrieved evidence snippets

Output schema: `schemas/lens-result.schema.json`

### Interpretation policy
Use:
- “may mean”
- “likely”
- “in this context”
- “some speakers”
- “individual preference varies”

Do not use:
- “people from X always”
- deterministic cultural personality claims

### Confidence
Confidence is a product signal based on:
- evidence availability
- context specificity
- ambiguity
- source authority

It is not a calibrated probability unless separately validated.

## 3. YapSim contract

Input:
- scenario goal
- persona/context
- journey
- MyDNA
- language level
- previous weak skill
- optional Lens incident summary

During session:
- stay in role
- do not interrupt every mistake
- keep exchange realistic
- preserve scenario goal

End:
- parse transcript
- return schema `schemas/sim-feedback.schema.json`
- cite exact user utterance examples sparingly
- give one prioritized improvement
- generate retry goal

## 4. Study Copilot

### Professor Mode
Goal: improve communication, not impersonate a professor or promise outcomes.

Output:
- tone assessment
- ambiguity/risk
- suggested rewrite(s)
- why
- optional question to clarify

### Group Project Mode
Goal:
- detect coordination ambiguity,
- clarify responsibilities/deadlines,
- reduce communication friction,
- propose an explicit collaborative message.

Do not infer teammate personality from nationality.

## 5. Source-grounded admin response

Function must provide sources to the model.

Prompt invariant:
> You may only state administrative requirements that are directly supported by the supplied authoritative sources. If they are absent or conflicting, say that the information could not be verified and direct the user to the official source.

## 6. Structured output

All model JSON must be validated before UI consumption.

On schema failure:
1. retry once with strict repair instruction,
2. if still invalid, return safe fallback,
3. log schema error without raw private user content where possible.

**No default may be invented to make invalid output pass.** A payload missing
`confidence`, `misunderstandingRisk` or a score dimension is rejected. The
gateway must never coerce provider output into shape.

## 7. Model routing

Current routing is recorded in `docs/adr/ADR-004-phase3-ai-interaction-core.md`
and mirrored in `config/project-decisions.yaml`. Summary:

| Task | Model |
|---|---|
| text reasoning / JSON | `groq/openai/gpt-oss-120b` |
| image / screenshot / PDF / scene boxes | `gemini-3.8-flash` |
| multimodal fallback | `gemini-3.7-flash` |
| recorded STT | `groq/whisper-large-v3-turbo` |
| streaming STT (P1) | `gemini-3.5-transcribe-live` |
| pure live translation | `gemini-3.5-live-translate-preview` |
| conversational voice agent (P1) | `gemini-3.8-live` |
| TTS | `gemini-3.1-flash-tts-preview` |
| embedding (optional) | `gemini-embedding-2` |

Retired: `gemini-3.1-flash-live-preview` (legacy, superseded by `gemini-3.8-live`).

No agent may silently change a model ID. Model upgrades require a Project
Decision Record because pricing/quotas/capabilities may change.

### 7.1 Translation and coaching are separate lanes

`gemini-3.5-live-translate-preview` performs translation only. It supports no
tools, no function calling, no structured output and no system instructions, and
accepts audio input only. Context reasoning therefore runs as its own lane over
the transcript on a reasoning model. The two lanes must never share a contract.

### 7.2 Languages without voice support are refused, not degraded

Tetum (Timor-Leste) is absent from the provider's supported set. `/live/token`
with `mode: "translate"` returns `422 LANGUAGE_UNSUPPORTED` with real fallback
options. The product must never claim voice coverage for all 11 ASEAN member
states.
