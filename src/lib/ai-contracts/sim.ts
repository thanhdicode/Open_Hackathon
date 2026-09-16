import { z } from "zod";
import { LanguageCodeSchema, LanguageLevelSchema, ScenarioDomainSchema } from "./common";

/**
 * YapSim contracts.
 *
 * SimFeedbackSchema mirrors the frozen schemas/sim-feedback.schema.json exactly
 * (six score dimensions). A retry is a new attempt of the same scenario, so the
 * contract carries no delta and the UI never promises a higher score.
 */
export const SimPersonaSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  traits: z.array(z.string()).min(1).max(4),
  register: z.enum(["informal", "neutral", "formal", "authority"]),
});

export const SimScenarioSchema = z.object({
  title: z.string().min(1),
  context: z.string().min(1),
  goal: z.string().min(1),
  domain: ScenarioDomainSchema,
  difficulty: z.number().int().min(1).max(5),
  targetLanguage: LanguageCodeSchema,
  coachingLanguage: LanguageCodeSchema,
  persona: SimPersonaSchema,
  openingLine: z.object({
    text: z.string().min(1),
    translation: z.string().min(1),
    romanization: z.string().optional(),
  }),
  successCriteria: z.array(z.string()).min(1).max(5),
  maxTurns: z.number().int().min(3).max(5),
});

export const SimTurnSchema = z.object({
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

export const SimFeedbackSchema = z.object({
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

/** Display labels for the frozen six dimensions. */
export const SIM_SCORE_DIMENSIONS = [
  { key: "languageClarity", label: "Language clarity" },
  { key: "tone", label: "Tone" },
  { key: "intentRecognition", label: "Intent recognition" },
  { key: "contextAwareness", label: "Context awareness" },
  { key: "adaptability", label: "Adaptability" },
  { key: "confidence", label: "Confidence" },
] as const;

export type SimPersona = z.infer<typeof SimPersonaSchema>;
export type SimScenario = z.infer<typeof SimScenarioSchema>;
export type SimTurn = z.infer<typeof SimTurnSchema>;
export type SimFeedback = z.infer<typeof SimFeedbackSchema>;
export type SimScoreKey = (typeof SIM_SCORE_DIMENSIONS)[number]["key"];
export type SimLevel = z.infer<typeof LanguageLevelSchema>;

export function averageScore(scores: SimFeedback["scores"]): number {
  const values = Object.values(scores);
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}
