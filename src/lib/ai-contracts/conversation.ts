import { z } from "zod";
import { ConfidenceSchema, LanguageCodeSchema, LanguageLevelSchema, ToneModeSchema } from "./common";

/**
 * Conversation Bridge contracts.
 *
 * CoachInsight is a separate contract from translation on purpose: the
 * translator model cannot reason, so the coach runs as its own lane over the
 * transcript and never overrides what the other person actually said.
 */
/**
 * Structured conversation memory.
 *
 * The bridge must not translate each turn in isolation: the coach needs to know
 * what has already been settled so it stops re-asking. Explicit fields rather
 * than free text, so the student can see what the assistant believes it knows.
 */
export const ConversationMemorySchema = z.object({
  topic: z.string().max(120).optional(),
  entities: z.array(z.string().max(80)).max(6),
  quantity: z.string().max(40).optional(),
  location: z.string().max(80).optional(),
  price: z.string().max(40).optional(),
  intent: z.string().max(160).optional(),
  openQuestions: z.array(z.string().max(160)).max(4),
  resolvedFacts: z.array(z.string().max(160)).max(6),
});

export const CoachInsightSchema = z.object({
  literalMeaning: z.string().min(1),
  likelyIntent: z.string().min(1),
  missingInformation: z.array(z.string()).max(5),
  whatTheyMayExpect: z.string().min(1),
  whatUserNeedsToDecide: z.string().min(1),
  safeReplyOptions: z
    .array(z.object({ text: z.string().min(1), tone: ToneModeSchema, why: z.string().min(1) }))
    .min(1)
    .max(4),
  clarificationQuestion: z.string().optional(),
  confidence: ConfidenceSchema,
  /** Probabilistic-language reminder shown next to the coach output. */
  caveat: z.string().min(1),
  /** Running state of the conversation, carried across turns. */
  memory: ConversationMemorySchema.optional(),
});

export const ConversationTurnSchema = z.object({
  id: z.string().min(1),
  index: z.number().int().min(0),
  speaker: z.enum(["local", "user"]),
  sourceLanguage: LanguageCodeSchema,
  targetLanguage: LanguageCodeSchema,
  originalText: z.string().min(1),
  translatedText: z.string().min(1),
  romanization: z.string().optional(),
  coach: CoachInsightSchema.optional(),
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
      language: LanguageCodeSchema,
      audioRef: z.string().optional(),
      synthesized: z.boolean(),
    })
    .optional(),
  createdAt: z.string(),
});

export const ConversationSessionSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  hostCountry: z.string().length(2),
  userLanguage: LanguageCodeSchema,
  localLanguage: LanguageCodeSchema,
  level: LanguageLevelSchema,
  status: z.enum(["active", "ended"]),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  turns: z.array(ConversationTurnSchema).max(200),
});

export type ConversationMemory = z.infer<typeof ConversationMemorySchema>;
export type CoachInsight = z.infer<typeof CoachInsightSchema>;
export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;
export type ConversationSession = z.infer<typeof ConversationSessionSchema>;
