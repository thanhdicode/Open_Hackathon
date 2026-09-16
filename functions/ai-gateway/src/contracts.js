import { z } from "zod";

/**
 * Server-side source of truth for every AI result contract.
 *
 * Rules enforced here (docs/05_AI_CONTRACTS.md §6):
 *  - Provider output is validated, never coerced into shape.
 *  - No default is invented to make invalid output pass. If a field is
 *    missing, the contract fails and the gateway asks the provider once more.
 *  - `schemas/*.schema.json` is generated from this file, not hand-written.
 */

/* -------------------------------------------------------------------------- */
/* Shared primitives                                                          */
/* -------------------------------------------------------------------------- */

export const languageCode = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "must be a BCP-47 language code such as vi, ms, zh-Hans");

export const confidenceLabel = z.enum(["low", "medium", "high"]);

export const confidence = z.object({
  label: confidenceLabel,
  reason: z.string().min(1),
});

export const toneMode = z.enum(["casual", "neutral", "academic", "very_respectful"]);

export const authorityLevel = z.enum(["A", "B", "C", "D"]);

export const source = z.object({
  sourceId: z.string().min(1),
  title: z.string().min(1),
  url: z.url(),
  authorityLevel,
  retrievedAt: z.string().optional(),
  freshness: z.enum(["current", "stale", "unknown"]).optional(),
});

/** Gemini spatial output: [ymin, xmin, ymax, xmax] normalized to 0-1000. */
export const box2d = z
  .object({
    ymin: z.number().int().min(0).max(1000),
    xmin: z.number().int().min(0).max(1000),
    ymax: z.number().int().min(0).max(1000),
    xmax: z.number().int().min(0).max(1000),
  })
  .refine((b) => b.ymin < b.ymax && b.xmin < b.xmax, "box requires ymin<ymax and xmin<xmax");

/** 20-domain situation grammar used by YapSim and Study practice handoff. */
export const scenarioDomain = z.enum([
  "food",
  "transport",
  "campus",
  "classroom",
  "group_work",
  "professor",
  "social",
  "housing",
  "banking",
  "sim",
  "health",
  "safety",
  "police",
  "immigration",
  "shopping",
  "religion",
  "events",
  "clubs",
  "part_time",
  "travel",
]);

export const languageLevel = z.enum(["beginner", "intermediate", "advanced"]);

/* -------------------------------------------------------------------------- */
/* 1. LensResult — text / screenshot / document interpretation                */
/* -------------------------------------------------------------------------- */

export const lensResult = z.object({
  detectedLanguage: z.string().min(1),
  literalMeaning: z.string().min(1),
  likelyIntents: z
    .array(z.object({ label: z.string().min(1), explanation: z.string().min(1) }))
    .min(1)
    .max(3),
  contextExplanation: z.string().min(1),
  expectedNextAction: z.string().min(1),
  misunderstandingRisk: z.enum(["low", "medium", "high"]),
  recommendedAction: z.string().min(1),
  suggestedReplies: z
    .array(z.object({ mode: toneMode, text: z.string().min(1), why: z.string().min(1) }))
    .min(1)
    .max(4),
  confidence,
  sources: z.array(source),
  individualVariationCaveat: z.string().optional(),
});

/* -------------------------------------------------------------------------- */
/* 2. VisualEvidence — Stage A output (observation only)                      */
/* -------------------------------------------------------------------------- */

/**
 * What a vision provider is allowed to produce.
 *
 * Deliberately small. Asking one vision model for the full SceneResult meant a
 * ~1.5k-token JSON response, which is what caused timeouts and burned the
 * provider's output-token budget. Stage A only observes; Stage B reasons.
 *
 * There is no separate `regions` array: each visible text entry carries its own
 * box, so the text entries ARE the regions. Two overlapping lists made the model
 * return coarse whole-image boxes for one of them.
 *
 * The caps and string lengths are a hard budget, not style. A strict structured
 * output mode reserves output tokens equal to the schema's THEORETICAL maximum,
 * so generous bounds get the request rejected on a free tier with a per-minute
 * output ceiling, and an over-long response gets truncated.
 *
 * No translations, no interpretation, no safety notice here.
 */
export const visualEvidence = z.object({
  scene: z.string().min(1).max(240),
  visibleTexts: z
    .array(
      z.object({
        text: z.string().min(1).max(120),
        language: languageCode.optional(),
        /** Required: this entry is the region, so it must carry a box. */
        box: box2d,
      }),
    )
    .max(8),
  objects: z
    .array(
      z.object({
        label: z.string().min(1).max(40),
        box: box2d.optional(),
      }),
    )
    .max(5),
  visibleLanguages: z.array(languageCode).max(3),
});

/* -------------------------------------------------------------------------- */
/* 3. SceneResult — Stage B output (annotated photo)                          */
/* -------------------------------------------------------------------------- */

export const sceneRegion = z.object({
  id: z.string().min(1).max(16),
  kind: z.enum(["text", "object", "mixed"]),
  box: box2d,
  label: z.string().min(1).max(60),
  originalText: z.string().max(120).optional(),
  translatedText: z.string().max(160).optional(),
  romanization: z.string().max(160).optional(),
  meaning: z.string().max(200).optional(),
  uncertainty: z.enum(["none", "low", "high"]),
  confidence: confidenceLabel,
  note: z.string().max(200).optional(),
});

/* -------------------------------------------------------------------------- */
/* 3. SceneInterpretation — Stage B output (meaning only)                     */
/* -------------------------------------------------------------------------- */

/**
 * What a text model is asked for in Stage B.
 *
 * Deliberately NOT the full SceneResult. The model must not re-emit boxes,
 * labels or original text — it only says what each already-detected region
 * MEANS, keyed by its index. The server composes the frozen SceneResult from
 * the Stage A evidence plus this interpretation.
 *
 * Measured reason: requiring one giant structured result made a single provider
 * (cavoti-glm) the only one able to serve Stage B, which is a new single point
 * of failure. A model that cannot reproduce a large schema can still produce
 * this small one.
 */
export const sceneInterpretation = z.object({
  summary: z.string().min(1).max(300),
  /** One entry per region index the model wants to explain. */
  translations: z
    .array(
      z.object({
        index: z.number().int().min(0).max(20),
        translatedText: z.string().min(1).max(160),
        meaning: z.string().max(200).optional(),
      }),
    )
    .max(10),
  usefulPhrases: z
    .array(
      z.object({
        text: z.string().min(1).max(120),
        translation: z.string().min(1).max(160),
        whenToUse: z.string().min(1).max(140),
      }),
    )
    .max(3),
  safetyNotice: z.string().min(1).max(280),
  uncertaintyNotes: z.array(z.string().max(160)).max(3),
  confidence,
});

/* -------------------------------------------------------------------------- */
/* 4. SceneResult — the frozen client-facing result                           */
/* -------------------------------------------------------------------------- */
/**
 * The frozen client-facing result.
 *
 * Bounded because a strict structured-output mode reserves output tokens equal
 * to the schema theoretical maximum. This shape is now composed server-side
 * rather than being demanded from one model, so no provider is a single point
 * of failure for it.
 */
export const sceneResult = z.object({
  sceneSummary: z.string().min(1).max(300),
  sceneKind: z.enum(["menu", "sign", "document", "product", "place", "screen", "other"]),
  detectedLanguages: z.array(languageCode).min(1).max(4),
  targetLanguage: languageCode,
  regions: z.array(sceneRegion).max(8),
  usefulPhrases: z
    .array(
      z.object({
        text: z.string().min(1).max(120),
        translation: z.string().min(1).max(160),
        romanization: z.string().max(160).optional(),
        whenToUse: z.string().min(1).max(140),
      }),
    )
    .max(4),
  uncertaintyNotes: z.array(z.string().max(200)).max(3),
  /** Always populated: states what the image cannot establish. */
  safetyNotice: z.string().min(1).max(280),
  confidence,
});

/* -------------------------------------------------------------------------- */
/* 3. ReplyResult — user intent → host-language sentence                      */
/* -------------------------------------------------------------------------- */

export const replyResult = z.object({
  intentSummary: z.string().min(1),
  targetLanguage: languageCode,
  variants: z
    .array(
      z.object({
        mode: toneMode,
        text: z.string().min(1),
        romanization: z.string().optional(),
        backTranslation: z.string().min(1),
        why: z.string().min(1),
      }),
    )
    .min(1)
    .max(4),
  warnings: z.array(z.string()).max(4),
  confidence,
});

/* -------------------------------------------------------------------------- */
/* 4. ToneCheckResult                                                         */
/* -------------------------------------------------------------------------- */

export const toneCheckResult = z.object({
  register: z.enum(["too_direct", "neutral", "respectful", "overly_formal", "unclear"]),
  issues: z
    .array(
      z.object({
        quote: z.string().min(1),
        problem: z.string().min(1),
        suggestion: z.string().min(1),
      }),
    )
    .max(6),
  rewrites: z
    .array(z.object({ mode: toneMode, text: z.string().min(1) }))
    .min(1)
    .max(3),
  contextNotes: z.array(z.string()).max(4),
  confidence,
});

/* -------------------------------------------------------------------------- */
/* 5. TranscriptionResult                                                     */
/* -------------------------------------------------------------------------- */

export const transcriptionResult = z.object({
  transcript: z.string().min(1),
  primaryLanguage: languageCode,
  detectedLanguages: z.array(languageCode).min(1),
  codeSwitching: z.boolean(),
  segments: z
    .array(
      z.object({
        text: z.string().min(1),
        startMs: z.number().int().min(0),
        endMs: z.number().int().min(0),
        speaker: z.string().optional(),
        language: languageCode.optional(),
      }),
    )
    .max(500),
  durationMs: z.number().int().min(0).optional(),
  confidence,
});

/* -------------------------------------------------------------------------- */
/* 6. TranslationTurn — pure translation lane output                          */
/* -------------------------------------------------------------------------- */

export const translationTurn = z.object({
  sourceLanguage: languageCode,
  targetLanguage: languageCode,
  originalText: z.string().min(1),
  translatedText: z.string().min(1),
  romanization: z.string().optional(),
  literalMeaning: z.string().optional(),
  confidence,
  engine: z.enum(["live_translate", "text_translation", "user_override"]),
});

/* -------------------------------------------------------------------------- */
/* 7. SpeechResult — TTS                                                      */
/* -------------------------------------------------------------------------- */

export const speechResult = z.object({
  text: z.string().min(1),
  language: languageCode,
  audioBase64: z.string().min(1),
  mimeType: z.string().regex(/^audio\//, "must be an audio mime type"),
  voiceName: z.string().optional(),
  durationMs: z.number().int().min(0).optional(),
});

/* -------------------------------------------------------------------------- */
/* 8. Context Coach                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Structured conversation memory.
 *
 * The bridge must not translate each turn in isolation: the coach needs to know
 * what has already been settled so it stops re-asking. This is deliberately a
 * small, explicit shape rather than free text, so the UI can show the student
 * exactly what the assistant believes it knows.
 */
export const conversationMemory = z.object({
  topic: z.string().max(120).optional(),
  /** Named things established so far, e.g. "nasi lemak". */
  entities: z.array(z.string().max(80)).max(6),
  quantity: z.string().max(40).optional(),
  location: z.string().max(80).optional(),
  price: z.string().max(40).optional(),
  /** What the student appears to be trying to achieve. */
  intent: z.string().max(160).optional(),
  /** Questions the other person has asked that are still unanswered. */
  openQuestions: z.array(z.string().max(160)).max(4),
  /** Facts both sides have agreed. */
  resolvedFacts: z.array(z.string().max(160)).max(6),
});

export const coachInsight = z.object({
  literalMeaning: z.string().min(1),
  likelyIntent: z.string().min(1),
  missingInformation: z.array(z.string()).max(5),
  whatTheyMayExpect: z.string().min(1),
  whatUserNeedsToDecide: z.string().min(1),
  safeReplyOptions: z
    .array(z.object({ text: z.string().min(1), tone: toneMode, why: z.string().min(1) }))
    .min(1)
    .max(4),
  clarificationQuestion: z.string().optional(),
  confidence,
  /** Probabilistic-language reminder surfaced in the UI. */
  caveat: z.string().min(1),
  /** Running state of the conversation, carried across turns. */
  memory: conversationMemory.optional(),
});

/* -------------------------------------------------------------------------- */
/* 9. ConversationSession / ConversationTurn                                  */
/* -------------------------------------------------------------------------- */

export const conversationTurn = z.object({
  id: z.string().min(1),
  index: z.number().int().min(0),
  speaker: z.enum(["local", "user"]),
  sourceLanguage: languageCode,
  targetLanguage: languageCode,
  originalText: z.string().min(1),
  translatedText: z.string().min(1),
  romanization: z.string().optional(),
  coach: coachInsight.optional(),
  decision: z
    .object({
      question: z.string().min(1),
      options: z.array(z.string()).max(6),
      chosen: z.string().optional(),
    })
    .optional(),
  spoken: z
    .object({
      text: z.string().min(1),
      language: languageCode,
      audioRef: z.string().optional(),
      synthesized: z.boolean(),
    })
    .optional(),
  createdAt: z.string(),
});

export const conversationSession = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  hostCountry: z.string().length(2),
  userLanguage: languageCode,
  localLanguage: languageCode,
  level: languageLevel,
  status: z.enum(["active", "ended"]),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  turns: z.array(conversationTurn).max(200),
});

/* -------------------------------------------------------------------------- */
/* 10. YapSim                                                                 */
/* -------------------------------------------------------------------------- */

export const simPersona = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  traits: z.array(z.string()).min(1).max(4),
  register: z.enum(["informal", "neutral", "formal", "authority"]),
});

export const simScenario = z.object({
  title: z.string().min(1),
  context: z.string().min(1),
  goal: z.string().min(1),
  domain: scenarioDomain,
  difficulty: z.number().int().min(1).max(5),
  targetLanguage: languageCode,
  coachingLanguage: languageCode,
  persona: simPersona,
  openingLine: z.object({
    text: z.string().min(1),
    translation: z.string().min(1),
    romanization: z.string().optional(),
  }),
  successCriteria: z.array(z.string()).min(1).max(5),
  maxTurns: z.number().int().min(3).max(5),
});

export const simTurn = z.object({
  personaReply: z.object({
    text: z.string().min(1),
    translation: z.string().min(1),
    romanization: z.string().optional(),
  }),
  hint: z.string().optional(),
  coachNote: z.string().optional(),
  goalProgress: z.enum(["on_track", "at_risk", "complete"]),
  shouldEnd: z.boolean(),
});

/** Mirrors schemas/sim-feedback.schema.json (frozen: six dimensions). */
export const simFeedback = z.object({
  scores: z.object({
    languageClarity: z.number().int().min(0).max(100),
    tone: z.number().int().min(0).max(100),
    intentRecognition: z.number().int().min(0).max(100),
    contextAwareness: z.number().int().min(0).max(100),
    adaptability: z.number().int().min(0).max(100),
    confidence: z.number().int().min(0).max(100),
  }),
  priorityFeedback: z.string().min(1),
  strengths: z.array(z.string()).max(3),
  examples: z
    .array(z.object({ userText: z.string().min(1), feedback: z.string().min(1) }))
    .max(3)
    .optional(),
  retryGoal: z.string().min(1),
  recommendedPractice: z.string().optional(),
});

/* -------------------------------------------------------------------------- */
/* 11. Study Copilot                                                          */
/* -------------------------------------------------------------------------- */

export const studyMode = z.enum([
  "professor_message",
  "group_chat",
  "slide",
  "lecture_audio",
  "whiteboard",
  "assignment",
  "vocabulary",
  "essay_draft",
  "meeting_summary",
  "presentation",
]);

export const studySection = z.object({
  label: z.string().min(1),
  body: z.string().optional(),
  items: z.array(z.string()).optional(),
});

export const actionItem = z.object({
  text: z.string().min(1),
  owner: z.string().optional(),
  dueHint: z.string().optional(),
});

export const terminologyItem = z.object({
  term: z.string().min(1),
  plainMeaning: z.string().min(1),
  academicUsage: z.string().optional(),
});

export const practiceSuggestion = z.object({
  scenarioGoal: z.string().min(1),
  domain: scenarioDomain,
});

export const studyResult = z.object({
  mode: studyMode,
  summary: z.string().min(1),
  sections: z.array(studySection).min(1).max(6),
  actionItems: z.array(actionItem).max(8),
  questionsToAsk: z.array(z.string()).max(6),
  terminology: z.array(terminologyItem).max(10),
  practiceSuggestion: practiceSuggestion.optional(),
  confidence,
  sources: z.array(source).max(6),
});

export const assignmentResult = z.object({
  deliverables: z.array(actionItem).min(1).max(10),
  deadlineHints: z
    .array(
      z.object({
        text: z.string().min(1),
        source: z.string().min(1),
        explicit: z.boolean(),
      }),
    )
    .max(8),
  rubric: z
    .array(
      z.object({
        criterion: z.string().min(1),
        detail: z.string().optional(),
        weight: z.string().optional(),
      }),
    )
    .max(10),
  ambiguities: z.array(z.string()).max(8),
  questionsToAsk: z.array(z.string()).max(8),
  confidence,
});

export const lectureResult = z.object({
  transcript: z.string(),
  detectedLanguages: z.array(languageCode).min(1),
  translation: z.string().optional(),
  concepts: z
    .array(
      z.object({
        term: z.string().min(1),
        explanation: z.string().min(1),
        importance: z.enum(["core", "supporting", "tangential"]),
      }),
    )
    .max(12),
  unclearMoments: z.array(z.string()).max(6),
  actionItems: z.array(actionItem).max(8),
  confidence,
});

/* -------------------------------------------------------------------------- */
/* 12. Live token broker (infrastructure, not a model result)                 */
/* -------------------------------------------------------------------------- */

export const liveTokenResult = z.object({
  token: z.string().min(1),
  model: z.string().min(1),
  mode: z.enum(["translate", "agent"]),
  /** False when the provider refused to lock the token to one configuration. */
  constrained: z.boolean(),
  expiresAt: z.string(),
  newSessionExpiresAt: z.string(),
});

/* -------------------------------------------------------------------------- */
/* 13. Living Greenbook — grounded question answering                         */
/* -------------------------------------------------------------------------- */

/**
 * One retrieved fact, as the retrieval layer hands it to the model.
 *
 * The model receives `factId` and `sourceId` so it can reference evidence, and
 * it is never given a fact the retrieval layer did not select. There is no
 * field here that could carry an outside URL: the answer can only ever point at
 * what retrieval found, which is what makes the citation allowlist meaningful.
 */
export const greenbookEvidenceFact = z.object({
  factId: z.string().min(1).max(64),
  sourceId: z.string().min(1).max(64),
  chapter: z.string().max(40),
  claim: z.string().min(1).max(1200),
  action: z.string().max(1200).nullable().optional(),
  authority: authorityLevel,
  status: z.string().max(32),
  checkedAt: z.string().max(40).optional(),
});

export const greenbookEvidenceSource = z.object({
  sourceId: z.string().min(1).max(64),
  title: z.string().min(1).max(300),
  url: z.string().max(2048),
  authority: authorityLevel,
});

/**
 * The grounded answer.
 *
 * `citedSourceIds` is the whole point of the contract: the client filters it
 * against the packet's allowlist, so a model that invents a citation loses that
 * citation rather than shipping it. The array is bounded so a model cannot
 * reserve an unbounded output budget with it (the Groq strict-mode trap).
 */
export const greenbookAnswer = z.object({
  answer: z.string().min(1).max(2400),
  whatToDo: z.array(z.string().max(400)).max(8),
  whatToPrepare: z.array(z.string().max(400)).max(8),
  whatToSay: z.array(z.string().max(400)).max(6),
  warnings: z.array(z.string().max(400)).max(5),
  confidence: confidenceLabel,
  citedSourceIds: z.array(z.string().max(64)).max(12),
});

/* -------------------------------------------------------------------------- */
/* Registry — used by the route table, the schema generator and the tests     */
/* -------------------------------------------------------------------------- */

export const contracts = {
  lensResult,
  visualEvidence,
  sceneInterpretation,
  sceneResult,
  sceneRegion,
  replyResult,
  toneCheckResult,
  transcriptionResult,
  translationTurn,
  speechResult,
  coachInsight,
  conversationMemory,
  conversationSession,
  conversationTurn,
  simScenario,
  simTurn,
  simFeedback,
  studyResult,
  assignmentResult,
  lectureResult,
  liveTokenResult,
  greenbookAnswer,
  greenbookEvidenceFact,
  greenbookEvidenceSource,
};
