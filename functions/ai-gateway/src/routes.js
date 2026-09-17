import { z } from "zod";
import * as C from "./contracts.js";
import * as T from "./prompts.js";
import * as P from "./providers.js";
import { assertMediaWithinBudget, redact } from "./privacy.js";
import { toPlayableAudio } from "./audio.js";
import { normalizeLanguageCode } from "./languages.js";
import { executeStructured, executeTranscribe, executeSpeech, healthReport, PROVIDER_JSON_SCHEMA } from "./registry.js";
import { normalizeGreenbookCitations, validateGroundedAnswer } from "./grounding.js";

/**
 * Route table.
 *
 * Each route declares a request contract, a result contract and a handler. No
 * handler talks to a vendor directly: they declare a capability and let the
 * registry walk the failover chain. Validation happens inside the registry, so
 * a schema-invalid response moves to the next provider instead of reaching the
 * student.
 */

export { PROVIDER_JSON_SCHEMA };

const journey = z
  .object({
    home: z.string().length(2),
    host: z.string().length(2),
    city: z.string().optional(),
    university: z.string().optional(),
  })
  .optional();

const context = {
  journey,
  userLanguage: C.languageCode.default("en"),
  coachingLanguage: C.languageCode.optional(),
  level: C.languageLevel.default("beginner"),
};

const coaching = (input) => input.coachingLanguage || input.userLanguage;

/**
 * Compose the frozen SceneResult from Stage A evidence plus Stage B meaning.
 *
 * Deterministic, and entirely server-side: the model never re-emits boxes,
 * labels or original text, so a provider that cannot reproduce a large schema
 * can still serve Stage B. The client contract is unchanged.
 */
function composeSceneResult({ evidence, interpretation, localLanguage, userLanguage }) {
  const byIndex = new Map(interpretation.translations.map((entry) => [entry.index, entry]));

  const textRegions = evidence.visibleTexts.slice(0, 8).map((entry, index) => {
    const meaning = byIndex.get(index);
    return {
      id: `r${index}`,
      kind: "text",
      box: entry.box,
      label: entry.text.slice(0, 60),
      originalText: entry.text.slice(0, 120),
      ...(meaning ? { translatedText: meaning.translatedText, ...(meaning.meaning ? { meaning: meaning.meaning } : {}) } : {}),
      uncertainty: "none",
      confidence: "medium",
    };
  });

  // Objects become regions only when the vision stage actually boxed them.
  const objectRegions = (evidence.objects ?? [])
    .filter((object) => object.box)
    .slice(0, Math.max(0, 8 - textRegions.length))
    .map((object, index) => ({
      id: `o${index}`,
      kind: "object",
      box: object.box,
      label: object.label.slice(0, 60),
      uncertainty: "low",
      confidence: "medium",
    }));

  // A price pattern is a reliable enough signal for a menu, and inferring it
  // here keeps the model contract small.
  const hasPrice = evidence.visibleTexts.some((entry) => /(?:RM|S\$|Rp|฿|₫|\$)\s?\d|\d+[.,]\d{2}\b/.test(entry.text));
  const sceneKind = evidence.objects?.length && !hasPrice ? "place" : hasPrice ? "menu" : "other";

  const detectedLanguages = evidence.visibleLanguages.length > 0 ? evidence.visibleLanguages : [localLanguage];

  return C.sceneResult.parse({
    sceneSummary: interpretation.summary,
    sceneKind,
    detectedLanguages: detectedLanguages.slice(0, 4),
    targetLanguage: userLanguage,
    regions: [...textRegions, ...objectRegions],
    usefulPhrases: interpretation.usefulPhrases,
    uncertaintyNotes: interpretation.uncertaintyNotes,
    safetyNotice: interpretation.safetyNotice,
    confidence: interpretation.confidence,
  });
}

/**
 * Structured inference over a capability chain.
 *
 * Every tuning parameter is forwarded explicitly: a wrapper that silently drops
 * one (a per-route attempt budget, say) makes the route behave as if it were
 * never set, which is hard to see from the outside.
 */
function structured({ capability, schemaName, resultSchema, buildPrompt, media, timeoutMs, deadlineMs, maxAttempts }) {
  return executeStructured({ capability, schemaName, resultSchema, buildPrompt, media, timeoutMs, deadlineMs, maxAttempts });
}

/** Shared plumbing for the media routes: budget check, then inference. */
function mediaRoute({ input, capability, schemaName, resultSchema, buildPrompt, allow, maxBytes, timeoutMs = 90000 }) {
  const budget = assertMediaWithinBudget(input.mediaBase64, { mimeType: input.mimeType, allow, maxBytes });
  if (!budget.ok) throw new P.ProviderError(budget.code, { provider: "input", code: budget.code });
  return structured({
    capability,
    schemaName,
    resultSchema,
    media: { mimeType: input.mimeType, base64: input.mediaBase64 },
    buildPrompt,
    timeoutMs,
  });
}

export const routes = {
  "/health": {
    request: z.object({}),
    result: z.object({
      ok: z.boolean(),
      providers: z.record(z.string(), z.unknown()),
      chains: z.record(z.string(), z.array(z.string())),
      concurrency: z.record(z.string(), z.unknown()),
    }),
    handler: async () => {
      const report = healthReport();
      return { data: { ok: true, ...report }, provider: "internal", model: "none" };
    },
  },

  /* ------------------------------- Lens ---------------------------------- */

  "/lens/text": {
    request: z.object({ ...context, text: z.string().min(1).max(12000), contextKey: z.string().max(60).default("social") }),
    result: C.lensResult,
    handler: async (input) =>
      structured({
        capability: "text",
        schemaName: "lensResult",
        resultSchema: C.lensResult,
        buildPrompt: () =>
          T.lensText({
            text: redact(input.text),
            contextKey: input.contextKey,
            journey: input.journey,
            coachingLanguage: coaching(input),
            userLanguage: input.userLanguage,
          }),
      }),
  },

  /**
   * Scene Lens, in two stages.
   *
   * Stage A asks a vision provider only to OBSERVE (a short VisualEvidence
   * payload). Stage B asks a text model to reason over that evidence into the
   * full SceneResult. Text providers are plentiful, so the vision provider no
   * longer has to be good at large structured output — which is what made this
   * route time out and burn output-token budgets.
   *
   * If Stage A fails completely, the device's own OCR evidence is used instead,
   * so the photo is never a dead screen.
   */
  "/lens/scene": {
    request: z.object({
      ...context,
      mediaBase64: z.string().min(1),
      mimeType: z.string().regex(/^image\//),
      localLanguage: C.languageCode.optional(),
      captureSource: z.enum(["camera", "upload", "screenshot"]).default("upload"),
      /** OCR text produced on the device, used to enrich and to survive Stage A failure. */
      deviceOcr: z.string().max(6000).optional(),
      /** Regions detected on the device, used if every vision provider is down. */
      deviceEvidence: C.visualEvidence.optional(),
    }),
    result: C.sceneResult,
    handler: async (input) => {
      const budget = assertMediaWithinBudget(input.mediaBase64, { mimeType: input.mimeType, allow: ["image/"], maxBytes: 10 * 1024 * 1024 });
      if (!budget.ok) throw new P.ProviderError(budget.code, { provider: "input", code: budget.code });

      const localLanguage = input.localLanguage || input.journey?.host || "en";
      const startedAt = Date.now();

      let evidence = null;
      let extractionProvider = "device";
      let extractionFailure = null;

      try {
        const extraction = await structured({
          capability: "visual",
          schemaName: "visualEvidence",
          resultSchema: C.visualEvidence,
          media: { mimeType: input.mimeType, base64: input.mediaBase64 },
          buildPrompt: () => T.visualExtraction({ localLanguage, localOcrText: input.deviceOcr }),
          timeoutMs: 45_000,
        });
        evidence = extraction.data;
        extractionProvider = extraction.provider;
      } catch (cause) {
        extractionFailure = cause?.code ?? "AI_UNAVAILABLE";
        // Fall back to whatever the device observed. A useful degraded result
        // beats an error screen.
        evidence = input.deviceEvidence ?? null;
      }

      if (!evidence) {
        // Nothing could observe the photo: no vision provider answered and the
        // device contributed nothing. Rather than an error screen, return a
        // valid result that says so plainly. It never fabricates content.
        return {
          data: C.sceneResult.parse({
            sceneSummary: "This photo could not be read right now. Nothing was invented to fill the gap.",
            sceneKind: "other",
            detectedLanguages: [input.userLanguage],
            targetLanguage: input.userLanguage,
            regions: [],
            usefulPhrases: [],
            uncertaintyNotes: [
              `Every photo-reading route was unavailable (${extractionFailure ?? "unknown"}).`,
              "Your photo was not modified and nothing was guessed from it.",
            ],
            safetyNotice: "Because nothing could be read, this result states no facts about the photo at all.",
            confidence: { label: "low", reason: "No route was able to observe the image." },
          }),
          provider: "degraded",
          model: "none",
          fallbackDepth: 0,
          skipped: [],
          attempted: [],
          stages: {
            extraction: { provider: "none", degraded: true, failure: extractionFailure ?? "unknown" },
            reasoning: { provider: "none" },
          },
          latencyMs: Date.now() - startedAt,
        };
      }

      const reasoning = await structured({
        capability: "interpret",
        schemaName: "sceneInterpretation",
        resultSchema: C.sceneInterpretation,
        buildPrompt: () =>
          T.sceneInterpretation({
            journey: input.journey,
            coachingLanguage: coaching(input),
            userLanguage: input.userLanguage,
            localLanguage,
            level: input.level,
            evidence,
          }),
        timeoutMs: 45_000,
        maxAttempts: Number(process.env.AI_MAX_ATTEMPTS_STAGE_B || 4),
      });

      // The frozen client contract is composed here, not demanded from a model.
      const data = composeSceneResult({
        evidence,
        interpretation: reasoning.data,
        localLanguage,
        userLanguage: input.userLanguage,
      });

      return {
        ...reasoning,
        data,
        // Report both stages so a fallback in either is visible in telemetry.
        stages: {
          extraction: { provider: extractionProvider, degraded: extractionProvider === "device", failure: extractionFailure ?? undefined },
          reasoning: { provider: reasoning.provider },
        },
        latencyMs: Date.now() - startedAt,
      };
    },
  },

  "/lens/document": {
    request: z.object({
      ...context,
      mediaBase64: z.string().min(1),
      mimeType: z.string().regex(/^(image\/|application\/pdf)/),
      documentKind: z.enum(["pdf", "image", "screenshot"]).default("pdf"),
    }),
    result: C.lensResult,
    handler: async (input) =>
      mediaRoute({
        input,
        capability: "vision",
        schemaName: "lensResult",
        resultSchema: C.lensResult,
        allow: ["image/", "application/pdf"],
        maxBytes: 14 * 1024 * 1024,
        buildPrompt: () =>
          T.lensDocument({
            journey: input.journey,
            coachingLanguage: coaching(input),
            userLanguage: input.userLanguage,
            documentKind: input.documentKind,
          }),
      }),
  },

  /* --------------------------- Reply and tone ----------------------------- */

  "/reply": {
    request: z.object({
      ...context,
      targetLanguage: C.languageCode,
      localLanguage: C.languageCode.optional(),
      userIntent: z.string().min(1).max(2000),
      situation: z.string().max(2000).optional(),
      confirmRequired: z.boolean().default(false),
    }),
    result: C.replyResult,
    handler: async (input) =>
      structured({
        capability: "text",
        schemaName: "replyResult",
        resultSchema: C.replyResult,
        buildPrompt: () =>
          T.reply({
            journey: input.journey,
            coachingLanguage: coaching(input),
            userLanguage: input.userLanguage,
            targetLanguage: input.targetLanguage,
            localLanguage: input.localLanguage,
            level: input.level,
            situation: input.situation ? redact(input.situation) : undefined,
            userIntent: redact(input.userIntent),
            confirmRequired: input.confirmRequired,
          }),
      }),
  },

  "/tone-check": {
    request: z.object({ ...context, targetLanguage: C.languageCode, text: z.string().min(1).max(4000), situation: z.string().max(1000).optional() }),
    result: C.toneCheckResult,
    handler: async (input) =>
      structured({
        capability: "text",
        schemaName: "toneCheckResult",
        resultSchema: C.toneCheckResult,
        buildPrompt: () =>
          T.toneCheck({
            journey: input.journey,
            coachingLanguage: coaching(input),
            userLanguage: input.userLanguage,
            targetLanguage: input.targetLanguage,
            situation: input.situation ? redact(input.situation) : undefined,
          }),
      }),
  },

  "/translate": {
    request: z.object({ ...context, sourceLanguage: C.languageCode, targetLanguage: C.languageCode, text: z.string().min(1).max(4000) }),
    result: C.translationTurn,
    handler: async (input) => {
      const outcome = await structured({
        capability: "text",
        schemaName: "translationTurn",
        resultSchema: C.translationTurn.partial({ engine: true, confidence: true, literalMeaning: true, romanization: true }),
        buildPrompt: () =>
          T.translateText({
            journey: input.journey,
            coachingLanguage: coaching(input),
            userLanguage: input.userLanguage,
            sourceLanguage: input.sourceLanguage,
            targetLanguage: input.targetLanguage,
            text: redact(input.text),
          }),
      });
      return {
        ...outcome,
        data: C.translationTurn.parse({
          ...outcome.data,
          engine: "text_translation",
          confidence: outcome.data.confidence ?? { label: "medium", reason: "Machine translation of a short utterance; register may vary." },
        }),
      };
    },
  },

  "/coach": {
    request: z.object({ ...context, localLanguage: C.languageCode, transcript: z.string().min(1).max(12000) }),
    result: C.coachInsight,
    handler: async (input) =>
      structured({
        capability: "text",
        schemaName: "coachInsight",
        resultSchema: C.coachInsight,
        buildPrompt: () =>
          T.contextCoach({
            journey: input.journey,
            coachingLanguage: coaching(input),
            userLanguage: input.userLanguage,
            localLanguage: input.localLanguage,
            level: input.level,
            transcript: redact(input.transcript),
          }),
      }),
  },

  /* ------------------------------- Speech --------------------------------- */

  "/transcribe": {
    request: z.object({
      ...context,
      mediaBase64: z.string().min(1),
      mimeType: z.string().regex(/^audio\//),
      languageHint: C.languageCode.optional(),
    }),
    result: C.transcriptionResult,
    handler: async (input) => {
      const budget = assertMediaWithinBudget(input.mediaBase64, { mimeType: input.mimeType, allow: ["audio/"], maxBytes: 15 * 1024 * 1024 });
      if (!budget.ok) throw new P.ProviderError(budget.code, { provider: "input", code: budget.code });
      const buffer = Buffer.from(input.mediaBase64, "base64");

      const outcome = await executeTranscribe({ buffer, mimeType: input.mimeType, language: input.languageHint });
      const raw = outcome.value;

      // Whisper reports display names ("malay"); the contract needs BCP-47.
      const detected = normalizeLanguageCode(raw.language, { fallback: input.languageHint });
      const resolved = detected === "und" && input.languageHint ? input.languageHint : detected;
      const segments = (raw.segments ?? [])
        .map((segment) => ({
          text: String(segment.text ?? "").trim(),
          startMs: Math.max(0, Math.round((segment.start ?? 0) * 1000)),
          endMs: Math.max(0, Math.round((segment.end ?? 0) * 1000)),
        }))
        .filter((segment) => segment.text.length > 0);

      const data = C.transcriptionResult.parse({
        transcript: String(raw.text).trim(),
        primaryLanguage: resolved,
        detectedLanguages: [resolved],
        codeSwitching: false,
        segments,
        ...(raw.duration ? { durationMs: Math.round(raw.duration * 1000) } : {}),
        confidence:
          resolved === "und"
            ? { label: "low", reason: "Speech was transcribed but the spoken language could not be identified." }
            : { label: "high", reason: "Recorded audio transcribed with a multilingual speech model." },
      });

      return { data, model: outcome.model, provider: outcome.provider, fallbackDepth: outcome.fallbackDepth, skipped: outcome.skipped, latencyMs: outcome.latencyMs };
    },
  },

  "/tts": {
    request: z.object({ ...context, text: z.string().min(1).max(2000), language: C.languageCode, voiceName: z.string().max(40).optional() }),
    result: C.speechResult,
    handler: async (input) => {
      // TTS failure must never fail the conversation: the client falls back to
      // browser speechSynthesis and then to a text-only card.
      const outcome = await executeSpeech({ text: input.text, voiceName: input.voiceName });
      const playable = toPlayableAudio(outcome.audioBase64, outcome.mimeType);
      return {
        data: C.speechResult.parse({
          text: input.text,
          language: input.language,
          audioBase64: playable.base64,
          mimeType: playable.mimeType,
          ...(input.voiceName ? { voiceName: input.voiceName } : {}),
        }),
        model: outcome.model,
        provider: outcome.provider,
        fallbackDepth: outcome.fallbackDepth,
      };
    },
  },

  "/live/token": {
    request: z.object({ ...context, mode: z.enum(["agent", "translate"]).default("agent"), targetLanguage: C.languageCode.optional() }),
    result: C.liveTokenResult,
    handler: async (input) => {
      // True Live is an enhancement, never the golden path.
      const model = input.mode === "translate" ? process.env.GEMINI_TRANSLATE_MODEL || "gemini-3.5-live-translate-preview" : process.env.GEMINI_LIVE_MODEL || "gemini-3.8-live";
      const token = await P.mintEphemeralToken({ model, mode: input.mode, targetLanguage: input.targetLanguage });
      return { data: C.liveTokenResult.parse({ ...token, model, mode: input.mode }), provider: "gemini", model, attempts: 1 };
    },
  },

  /* -------------------------------- YapSim -------------------------------- */

  "/sim/start": {
    request: z.object({
      ...context,
      targetLanguage: C.languageCode,
      domain: C.scenarioDomain.default("food"),
      goal: z.string().max(500).optional(),
      incident: z.string().max(2000).optional(),
    }),
    result: C.simScenario,
    handler: async (input) =>
      structured({
        capability: "text",
        schemaName: "simScenario",
        resultSchema: C.simScenario,
        buildPrompt: () =>
          T.simScenario({
            journey: input.journey,
            coachingLanguage: coaching(input),
            userLanguage: input.userLanguage,
            targetLanguage: input.targetLanguage,
            level: input.level,
            domain: input.domain,
            goal: input.goal ? redact(input.goal) : undefined,
            incident: input.incident ? redact(input.incident) : undefined,
          }),
      }),
  },

  "/sim/turn": {
    request: z.object({ ...context, scenario: C.simScenario, transcript: z.string().min(1).max(12000), turnIndex: z.number().int().min(1).max(20) }),
    result: C.simTurn,
    handler: async (input) =>
      structured({
        capability: "text",
        schemaName: "simTurn",
        resultSchema: C.simTurn,
        buildPrompt: () => T.simTurn({ scenario: input.scenario, transcript: redact(input.transcript), turnIndex: input.turnIndex, level: input.level }),
      }),
  },

  "/sim/finish": {
    request: z.object({
      ...context,
      scenario: C.simScenario,
      transcript: z.string().min(1).max(20000),
      isRetry: z.boolean().default(false),
      previousFeedback: z.string().max(3000).optional(),
    }),
    result: C.simFeedback,
    handler: async (input) =>
      structured({
        capability: "text",
        schemaName: "simFeedback",
        resultSchema: C.simFeedback,
        buildPrompt: () =>
          T.simFeedback({
            scenario: input.scenario,
            transcript: redact(input.transcript),
            level: input.level,
            coachingLanguage: coaching(input),
            isRetry: input.isRetry,
            previousFeedback: input.previousFeedback ? redact(input.previousFeedback) : undefined,
          }),
        timeoutMs: 45000,
      }),
  },

  /* ---------------------------- Living Greenbook --------------------------- */

  /**
   * Grounded question answering over retrieved Greenbook facts.
   *
   * The client (src/lib/greenbook/ask.ts) does retrieval, then sends ONLY the
   * retrieved evidence here. That ordering is deliberate: the model cannot
   * reason over a fact that retrieval did not select, so the citation allowlist
   * it is filtered against is a real boundary rather than a cosmetic one.
   *
   * This route is an enhancement, never a dependency. The client already
   * assembles a complete answer from the same facts with no model at all
   * (`buildNoLlmAnswer`), so a 429 or an undeployed function degrades the prose
   * and never the availability. That is why no special handling is needed here
   * for a provider outage: the caller catches it.
   */
  "/greenbook/ask": {
    request: z.object({
      ...context,
      question: z.string().min(1).max(1000),
      hostCountry: z.string().length(2),
      homeCountry: z.string().length(2).optional(),
      chapter: z.string().max(40).nullable().optional(),
      journeyStage: z.string().max(24).nullable().optional(),
      evidence: z.array(C.greenbookEvidenceFact).min(1).max(40),
      sources: z.array(C.greenbookEvidenceSource).max(40),
    }),
    result: C.greenbookAnswer,
    handler: async (input) =>
      structured({
        capability: "text",
        schemaName: "greenbookAnswer",
        resultSchema: C.greenbookAnswer.transform((answer) => normalizeGreenbookCitations(input, answer)).superRefine((answer, context) => {
          const validation = validateGroundedAnswer(input, answer);
          if (!validation.ok) context.addIssue({ code: "custom", message: `${validation.code}: ${validation.message}` });
        }),
        buildPrompt: () =>
          T.greenbookAsk({
            question: redact(input.question),
            hostCountry: input.hostCountry,
            homeCountry: input.homeCountry ?? "unknown",
            chapter: input.chapter ?? null,
            journeyStage: input.journeyStage ?? null,
            coachingLanguage: coaching(input),
            userLanguage: input.userLanguage,
            languageLevel: input.level,
            evidence: input.evidence,
            sources: input.sources,
          }),
        timeoutMs: 45000,
      }),
  },

  /* -------------------------------- Study --------------------------------- */

  "/study/analyze": {
    request: z.object({
      ...context,
      mode: C.studyMode,
      text: z.string().max(20000).optional(),
      mediaBase64: z.string().max(14_000_000).optional(),
      mimeType: z.string().optional(),
    }),
    result: z.union([C.studyResult, C.assignmentResult, C.lectureResult]),
    handler: async (input) => {
      const schemaName = input.mode === "assignment" ? "assignmentResult" : input.mode === "lecture_audio" ? "lectureResult" : "studyResult";
      const resultSchema = input.mode === "assignment" ? C.assignmentResult : input.mode === "lecture_audio" ? C.lectureResult : C.studyResult;
      const hasMedia = Boolean(input.mediaBase64 && input.mimeType);
      if (!hasMedia && !input.text) throw new P.ProviderError("input:empty", { provider: "input", code: "INVALID_FILE" });

      const system = T.study({ mode: input.mode, journey: input.journey, coachingLanguage: coaching(input), userLanguage: input.userLanguage, level: input.level }).system;

      if (hasMedia) {
        const allow = input.mimeType.startsWith("audio/") ? ["audio/"] : ["image/", "application/pdf"];
        return mediaRoute({
          input,
          capability: "vision",
          schemaName,
          resultSchema,
          allow,
          maxBytes: 14 * 1024 * 1024,
          timeoutMs: 60000,
          buildPrompt: () => ({ system, user: `Analyse the attached ${input.mode.replace(/_/g, " ")}.` }),
        });
      }

      return structured({
        capability: "text",
        schemaName,
        resultSchema,
        buildPrompt: () => ({ system, user: `Analyse the following input.\n\n${redact(input.text)}` }),
        timeoutMs: 45000,
      });
    },
  },
};

/** Legacy action names stay addressable so an older client build cannot hard-fail. */
export const LEGACY_ACTIONS = {
  lens: "/lens/text",
  reply: "/reply",
  "tone-check": "/tone-check",
  transcribe: "/transcribe",
  health: "/health",
};
