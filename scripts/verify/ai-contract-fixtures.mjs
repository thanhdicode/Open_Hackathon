/**
 * Shared fixtures for the AI contract parity test.
 *
 * Each contract has at least one payload that must validate and at least one
 * that must be rejected. The invalid cases target the specific failure the
 * Phase 3 refactor exists to prevent: a gateway "normalising" a payload into
 * shape by inventing confidence, risk or score defaults.
 */

const confidence = { label: "medium", reason: "Context interpretation can vary." };
const source = { sourceId: "my-immigration", title: "Malaysia immigration", url: "https://example.gov.my/visa", authorityLevel: "A" };

const sceneRegion = {
  id: "r1",
  kind: "text",
  box: { ymin: 100, xmin: 50, ymax: 160, xmax: 900 },
  label: "Nasi Lemak Ayam",
  originalText: "Nasi Lemak Ayam",
  translatedText: "Cơm nấu nước cốt dừa với gà",
  meaning: "A rice dish cooked in coconut milk, served with chicken.",
  uncertainty: "none",
  confidence: "high",
};

export const fixtures = {
  lensResult: {
    valid: [
      {
        detectedLanguage: "Malay",
        literalMeaning: "How many packs?",
        likelyIntents: [{ label: "Asking quantity", explanation: "The seller wants to know how many portions you want." }],
        contextExplanation: "A stallholder asking how many portions to pack.",
        expectedNextAction: "Give a number.",
        misunderstandingRisk: "low",
        recommendedAction: "Answer with the number of packs you want.",
        suggestedReplies: [{ mode: "neutral", text: "Dua bungkus.", why: "Clear and short." }],
        confidence,
        sources: [source],
      },
    ],
    invalid: [
      { detectedLanguage: "Malay", literalMeaning: "x", likelyIntents: [], contextExplanation: "x", expectedNextAction: "x", misunderstandingRisk: "low", recommendedAction: "x", suggestedReplies: [{ mode: "neutral", text: "x", why: "x" }], confidence, sources: [] },
      { detectedLanguage: "Malay", literalMeaning: "x", likelyIntents: [{ label: "a", explanation: "b" }], contextExplanation: "x", expectedNextAction: "x", misunderstandingRisk: "certain", recommendedAction: "x", suggestedReplies: [{ mode: "neutral", text: "x", why: "x" }], confidence, sources: [] },
      // Missing confidence entirely: the old gateway invented one. It must fail.
      { detectedLanguage: "Malay", literalMeaning: "x", likelyIntents: [{ label: "a", explanation: "b" }], contextExplanation: "x", expectedNextAction: "x", misunderstandingRisk: "low", recommendedAction: "x", suggestedReplies: [{ mode: "neutral", text: "x", why: "x" }], sources: [] },
      // Strings where objects are required: the old gateway coerced these.
      { detectedLanguage: "Malay", literalMeaning: "x", likelyIntents: ["possible intent"], contextExplanation: "x", expectedNextAction: "x", misunderstandingRisk: "low", recommendedAction: "x", suggestedReplies: ["Dua bungkus."], confidence, sources: [] },
    ],
  },

  sceneResult: {
    valid: [
      {
        sceneSummary: "A nasi lemak stall menu with six items and prices in ringgit.",
        sceneKind: "menu",
        detectedLanguages: ["ms"],
        targetLanguage: "vi",
        regions: [sceneRegion],
        usefulPhrases: [{ text: "Boleh kurang pedas?", translation: "Có thể bớt cay không?", whenToUse: "When you do not want it spicy." }],
        uncertaintyNotes: [],
        safetyNotice: "The photo cannot establish ingredients, allergens or halal certification.",
        confidence,
      },
      {
        sceneSummary: "A notice board.",
        sceneKind: "sign",
        detectedLanguages: ["en", "ms"],
        targetLanguage: "vi",
        regions: [],
        usefulPhrases: [],
        uncertaintyNotes: ["The lower half of the board is blurred."],
        safetyNotice: "Blurred text was not guessed.",
        confidence,
      },
    ],
    invalid: [
      // Box out of the documented 0-1000 range.
      { sceneSummary: "x", sceneKind: "menu", detectedLanguages: ["ms"], targetLanguage: "vi", regions: [{ ...sceneRegion, box: { ymin: 0, xmin: 0, ymax: 1200, xmax: 900 } }], usefulPhrases: [], uncertaintyNotes: [], safetyNotice: "x", confidence },
      // Inverted box.
      { sceneSummary: "x", sceneKind: "menu", detectedLanguages: ["ms"], targetLanguage: "vi", regions: [{ ...sceneRegion, box: { ymin: 500, xmin: 50, ymax: 100, xmax: 900 } }], usefulPhrases: [], uncertaintyNotes: [], safetyNotice: "x", confidence },
      // Non-integer coordinates.
      { sceneSummary: "x", sceneKind: "menu", detectedLanguages: ["ms"], targetLanguage: "vi", regions: [{ ...sceneRegion, box: { ymin: 10.5, xmin: 50, ymax: 160, xmax: 900 } }], usefulPhrases: [], uncertaintyNotes: [], safetyNotice: "x", confidence },
      // Missing the safety notice that states what the image cannot establish.
      { sceneSummary: "x", sceneKind: "menu", detectedLanguages: ["ms"], targetLanguage: "vi", regions: [], usefulPhrases: [], uncertaintyNotes: [], confidence },
      // Unknown scene kind.
      { sceneSummary: "x", sceneKind: "billboard", detectedLanguages: ["ms"], targetLanguage: "vi", regions: [], usefulPhrases: [], uncertaintyNotes: [], safetyNotice: "x", confidence },
    ],
  },

  replyResult: {
    valid: [
      {
        intentSummary: "Ask for two packs, one not spicy.",
        targetLanguage: "ms",
        variants: [{ mode: "neutral", text: "Dua bungkus, satu tak pedas.", backTranslation: "Two packs, one not spicy.", why: "Short and clear at a stall." }],
        warnings: [],
        confidence,
      },
    ],
    invalid: [
      { intentSummary: "x", targetLanguage: "ms", variants: [], warnings: [], confidence },
      { intentSummary: "x", targetLanguage: "ms", variants: [{ mode: "neutral", text: "x", why: "x" }], warnings: [], confidence },
      { intentSummary: "x", targetLanguage: "ms", variants: [{ mode: "shouting", text: "x", backTranslation: "x", why: "x" }], warnings: [], confidence },
    ],
  },

  toneCheckResult: {
    valid: [{ register: "too_direct", issues: [{ quote: "Give me extension", problem: "Reads as a demand.", suggestion: "Could I please have a short extension?" }], rewrites: [{ mode: "academic", text: "I would like to request a short extension." }], contextNotes: ["Lecturers usually expect a reason."], confidence }],
    invalid: [
      { register: "angry", issues: [], rewrites: [{ mode: "neutral", text: "x" }], contextNotes: [], confidence },
      { register: "neutral", issues: [], rewrites: [], contextNotes: [], confidence },
    ],
  },

  transcriptionResult: {
    valid: [
      {
        transcript: "Berapa bungkus?",
        primaryLanguage: "ms",
        detectedLanguages: ["ms"],
        codeSwitching: false,
        segments: [{ text: "Berapa bungkus?", startMs: 0, endMs: 900 }],
        durationMs: 900,
        confidence: { label: "high", reason: "Clear recording." },
      },
      {
        transcript: "Anh muốn order nasi lemak but no sambal",
        primaryLanguage: "vi",
        detectedLanguages: ["vi", "en", "ms"],
        codeSwitching: true,
        segments: [{ text: "Anh muốn order nasi lemak", startMs: 0, endMs: 1500, language: "vi" }],
        confidence: { label: "medium", reason: "Three languages in one utterance." },
      },
    ],
    invalid: [
      { transcript: "", primaryLanguage: "ms", detectedLanguages: ["ms"], codeSwitching: false, segments: [], confidence },
      // Whisper returns display names; "malay" is not a BCP-47 code and must fail.
      { transcript: "Berapa bungkus?", primaryLanguage: "malay", detectedLanguages: ["malay"], codeSwitching: false, segments: [], confidence },
      { transcript: "x", primaryLanguage: "ms", detectedLanguages: [], codeSwitching: false, segments: [], confidence },
    ],
  },

  translationTurn: {
    valid: [{ sourceLanguage: "ms", targetLanguage: "vi", originalText: "Berapa bungkus?", translatedText: "Bao nhiêu gói?", confidence, engine: "text_translation" }],
    invalid: [
      { sourceLanguage: "ms", targetLanguage: "vi", originalText: "x", translatedText: "x", confidence, engine: "guesswork" },
      { sourceLanguage: "ms", targetLanguage: "vi", originalText: "", translatedText: "x", confidence, engine: "text_translation" },
    ],
  },

  speechResult: {
    valid: [{ text: "Dua bungkus, satu tak pedas.", language: "ms", audioBase64: "UklGRg==", mimeType: "audio/wav" }],
    invalid: [
      { text: "x", language: "ms", audioBase64: "UklGRg==", mimeType: "text/plain" },
      { text: "x", language: "ms", audioBase64: "", mimeType: "audio/wav" },
    ],
  },

  coachInsight: {
    valid: [
      {
        literalMeaning: "How many packs?",
        likelyIntent: "The seller probably wants a quantity before packing your order.",
        missingInformation: ["How many packs", "Whether you want it spicy"],
        whatTheyMayExpect: "A number, and whether you are eating in or taking away.",
        whatUserNeedsToDecide: "How many packs you want.",
        safeReplyOptions: [{ text: "Dua bungkus", tone: "neutral", why: "Answers the question directly." }],
        confidence,
        caveat: "This reading is contextual, not certain.",
      },
    ],
    invalid: [
      { literalMeaning: "x", likelyIntent: "x", missingInformation: [], whatTheyMayExpect: "x", whatUserNeedsToDecide: "x", safeReplyOptions: [], confidence, caveat: "x" },
      { literalMeaning: "x", likelyIntent: "x", missingInformation: [], whatTheyMayExpect: "x", whatUserNeedsToDecide: "x", safeReplyOptions: [{ text: "x", tone: "neutral", why: "x" }], confidence },
    ],
  },

  conversationTurn: {
    valid: [
      {
        id: "t1",
        index: 0,
        speaker: "local",
        sourceLanguage: "ms",
        targetLanguage: "vi",
        originalText: "Berapa bungkus?",
        translatedText: "Bao nhiêu gói?",
        createdAt: new Date().toISOString(),
      },
    ],
    invalid: [
      { id: "t1", index: -1, speaker: "local", sourceLanguage: "ms", targetLanguage: "vi", originalText: "x", translatedText: "x", createdAt: "now" },
      { id: "t1", index: 0, speaker: "bystander", sourceLanguage: "ms", targetLanguage: "vi", originalText: "x", translatedText: "x", createdAt: "now" },
    ],
  },

  conversationSession: {
    valid: [
      {
        id: "s1",
        userId: "u1",
        hostCountry: "MY",
        userLanguage: "vi",
        localLanguage: "ms",
        level: "beginner",
        status: "active",
        startedAt: new Date().toISOString(),
        turns: [],
      },
    ],
    invalid: [
      { id: "s1", userId: "u1", hostCountry: "MYS", userLanguage: "vi", localLanguage: "ms", level: "beginner", status: "active", startedAt: "now", turns: [] },
      { id: "s1", userId: "u1", hostCountry: "MY", userLanguage: "vi", localLanguage: "ms", level: "native", status: "active", startedAt: "now", turns: [] },
    ],
  },

  simScenario: {
    valid: [
      {
        title: "Ordering nasi lemak",
        context: "A stall at Taman Universiti during lunch.",
        goal: "Order two packs, one not spicy, and confirm takeaway.",
        domain: "food",
        difficulty: 2,
        targetLanguage: "ms",
        coachingLanguage: "vi",
        persona: { name: "Ahmad", role: "Stallholder", traits: ["brisk", "friendly"], register: "informal" },
        openingLine: { text: "Berapa bungkus?", translation: "Bao nhiêu gói?", romanization: "" },
        successCriteria: ["States a quantity", "Says one should not be spicy"],
        maxTurns: 4,
      },
    ],
    invalid: [
      // maxTurns outside the 3-5 range the contract allows.
      { title: "x", context: "x", goal: "x", domain: "food", difficulty: 2, targetLanguage: "ms", coachingLanguage: "vi", persona: { name: "A", role: "B", traits: ["x"], register: "informal" }, openingLine: { text: "x", translation: "x" }, successCriteria: ["x"], maxTurns: 9 },
      { title: "x", context: "x", goal: "x", domain: "cryptocurrency", difficulty: 2, targetLanguage: "ms", coachingLanguage: "vi", persona: { name: "A", role: "B", traits: ["x"], register: "informal" }, openingLine: { text: "x", translation: "x" }, successCriteria: ["x"], maxTurns: 4 },
      { title: "x", context: "x", goal: "x", domain: "food", difficulty: 9, targetLanguage: "ms", coachingLanguage: "vi", persona: { name: "A", role: "B", traits: ["x"], register: "informal" }, openingLine: { text: "x", translation: "x" }, successCriteria: ["x"], maxTurns: 4 },
    ],
  },

  simTurn: {
    valid: [{ personaReply: { text: "Nak bungkus ke makan sini?", translation: "Takeaway or eat here?" }, goalProgress: "on_track", shouldEnd: false }],
    invalid: [
      { personaReply: { text: "x", translation: "x" }, goalProgress: "winning", shouldEnd: false },
      { personaReply: { text: "x" }, goalProgress: "on_track", shouldEnd: false },
    ],
  },

  simFeedback: {
    valid: [
      {
        scores: { languageClarity: 62, tone: 70, intentRecognition: 75, contextAwareness: 60, adaptability: 58, confidence: 55 },
        priorityFeedback: "Answer the quantity question before adding detail.",
        strengths: ["Used the local word bungkus correctly."],
        examples: [{ userText: "Dua bungkus, satu tak pedas", feedback: "Answers quantity and spice in one turn." }],
        retryGoal: "Confirm takeaway without being prompted.",
      },
    ],
    invalid: [
      // Score above the frozen 0-100 range.
      { scores: { languageClarity: 140, tone: 70, intentRecognition: 75, contextAwareness: 60, adaptability: 58, confidence: 55 }, priorityFeedback: "x", strengths: [], retryGoal: "x" },
      // A dimension missing: the frozen schema requires all six.
      { scores: { languageClarity: 60, tone: 70, intentRecognition: 75, contextAwareness: 60, adaptability: 58 }, priorityFeedback: "x", strengths: [], retryGoal: "x" },
      // Renamed dimension from an earlier draft of the plan.
      { scores: { clarity: 60, tone: 70, listening: 75, taskCompletion: 60, confidence: 58, adaptability: 50 }, priorityFeedback: "x", strengths: [], retryGoal: "x" },
      { scores: { languageClarity: 60, tone: 70, intentRecognition: 75, contextAwareness: 60, adaptability: 58, confidence: 55 }, strengths: [], retryGoal: "x" },
    ],
  },

  studyResult: {
    valid: [
      {
        mode: "professor_message",
        summary: "The lecturer sets a Friday 5pm deadline for the group report.",
        sections: [{ label: "What it says", body: "Submit the group report by Friday 5pm." }],
        actionItems: [{ text: "Submit the group report", dueHint: "Friday 5pm" }],
        questionsToAsk: ["Who signs the contribution form?"],
        terminology: [{ term: "contribution form", plainMeaning: "A form listing what each member did." }],
        practiceSuggestion: { scenarioGoal: "Ask a lecturer for clarification about a deadline", domain: "professor" },
        confidence,
        sources: [],
      },
    ],
    invalid: [
      { mode: "professor_message", summary: "x", sections: [], actionItems: [], questionsToAsk: [], terminology: [], confidence, sources: [] },
      { mode: "mind_reading", summary: "x", sections: [{ label: "x" }], actionItems: [], questionsToAsk: [], terminology: [], confidence, sources: [] },
    ],
  },

  assignmentResult: {
    valid: [
      {
        deliverables: [{ text: "Group report", owner: "all members", dueHint: "Friday 5pm" }],
        deadlineHints: [{ text: "Friday 5pm", source: "the brief", explicit: true }],
        rubric: [{ criterion: "Analysis", detail: "Depth of argument", weight: "40%" }],
        ambiguities: ["The brief does not state a word count."],
        questionsToAsk: ["What is the expected word count?"],
        confidence,
      },
    ],
    invalid: [
      { deliverables: [], deadlineHints: [], rubric: [], ambiguities: [], questionsToAsk: [], confidence },
      { deliverables: [{ text: "x" }], deadlineHints: [{ text: "x", source: "y", explicit: "yes" }], rubric: [], ambiguities: [], questionsToAsk: [], confidence },
    ],
  },

  lectureResult: {
    valid: [
      {
        transcript: "Today we cover supply and demand.",
        detectedLanguages: ["en"],
        translation: "Hôm nay chúng ta học cung và cầu.",
        concepts: [{ term: "demand curve", explanation: "How much people want at each price.", importance: "core" }],
        unclearMoments: [],
        actionItems: [],
        confidence,
      },
    ],
    invalid: [
      { transcript: "x", detectedLanguages: [], concepts: [], unclearMoments: [], actionItems: [], confidence },
      { transcript: "x", detectedLanguages: ["en"], concepts: [{ term: "x", explanation: "y", importance: "critical" }], unclearMoments: [], actionItems: [], confidence },
    ],
  },

  liveTokenResult: {
    valid: [{ token: "auth_tokens/abc", model: "gemini-3.8-live", mode: "agent", constrained: true, expiresAt: "2026-09-16T10:00:00Z", newSessionExpiresAt: "2026-09-16T09:31:00Z" }],
    invalid: [
      { token: "auth_tokens/abc", model: "gemini-3.8-live", mode: "chat", constrained: true, expiresAt: "x", newSessionExpiresAt: "y" },
      { token: "", model: "gemini-3.8-live", mode: "agent", constrained: true, expiresAt: "x", newSessionExpiresAt: "y" },
    ],
  },

  greenbookAnswer: {
    valid: [
      {
        answer: "Incoming exchange students at NUS need a Student's Pass issued by ICA. Apply through the Student's Pass Online Application and Registration system once the university has registered you.",
        whatToDo: ["Wait for the university to register you before applying", "Submit the Student's Pass application through ICA's system"],
        whatToPrepare: ["Passport valid for the length of stay", "The university's registration details"],
        whatToSay: [],
        warnings: [],
        confidence: "high",
        citedSourceIds: ["sg-ica-student"],
      },
      // An empty answer is not valid: an ungrounded reply is a refusal, not silence.
      {
        answer: "I couldn't verify this from a current authoritative source yet.",
        whatToDo: [],
        whatToPrepare: [],
        whatToSay: [],
        warnings: ["Nothing in the verified corpus covers this yet."],
        confidence: "low",
        citedSourceIds: [],
      },
    ],
    invalid: [
      // Missing the citation list: the whole point of the contract.
      { answer: "x", whatToDo: [], whatToPrepare: [], whatToSay: [], warnings: [], confidence: "low" },
      // An invented confidence value.
      { answer: "x", whatToDo: [], whatToPrepare: [], whatToSay: [], warnings: [], confidence: "certain", citedSourceIds: [] },
      // Empty prose.
      { answer: "", whatToDo: [], whatToPrepare: [], whatToSay: [], warnings: [], confidence: "low", citedSourceIds: [] },
      // More than the bounded number of cited sources.
      { answer: "x", whatToDo: [], whatToPrepare: [], whatToSay: [], warnings: [], confidence: "low", citedSourceIds: Array.from({ length: 13 }, (_, i) => `s${i}`) },
    ],
  },
};

/** Contracts whose JSON Schema is generated into schemas/ by generate-schemas.mjs. */
export const SCHEMA_FILE_NAMES = {
  lensResult: "lens-result.schema.json",  visualEvidence: "visual-evidence.schema.json",
  sceneResult: "scene-result.schema.json",
  sceneRegion: "scene-region.schema.json",
  replyResult: "reply-result.schema.json",
  toneCheckResult: "tone-check-result.schema.json",
  transcriptionResult: "transcription-result.schema.json",
  translationTurn: "translation-turn.schema.json",
  speechResult: "speech-result.schema.json",
  coachInsight: "coach-insight.schema.json",
  conversationSession: "conversation-session.schema.json",
  conversationTurn: "conversation-turn.schema.json",
  simScenario: "sim-scenario.schema.json",
  simTurn: "sim-turn.schema.json",
  simFeedback: "sim-feedback.schema.json",
  studyResult: "study-result.schema.json",
  assignmentResult: "assignment-result.schema.json",
  lectureResult: "lecture-result.schema.json",
  liveTokenResult: "live-token-result.schema.json",
  greenbookAnswer: "greenbook-answer.schema.json",
};
