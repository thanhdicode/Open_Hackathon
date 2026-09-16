import { z } from "zod";
import { ConfidenceSchema, LanguageCodeSchema } from "./common";

/**
 * TranslationTurnSchema — the pure translation lane.
 *
 * Deliberately separate from CoachInsight: the Live Translate model performs
 * translation only (no tools, no reasoning), so translation output and
 * coaching output must never share a contract or a model call.
 */
export const TranslationTurnSchema = z.object({
  sourceLanguage: LanguageCodeSchema,
  targetLanguage: LanguageCodeSchema,
  originalText: z.string().min(1),
  translatedText: z.string().min(1),
  romanization: z.string().optional(),
  literalMeaning: z.string().optional(),
  confidence: ConfidenceSchema,
  engine: z.enum(["live_translate", "text_translation", "user_override"]),
});

export type TranslationTurn = z.infer<typeof TranslationTurnSchema>;
