import { z } from "zod";
import { ConfidenceSchema, SourceSchema, ToneModeSchema } from "./common";

/**
 * LensResultSchema — text, screenshot or document interpretation.
 * Frozen shape: schemas/lens-result.schema.json.
 */
export const LensResultSchema = z.object({
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
    .array(z.object({ mode: ToneModeSchema, text: z.string().min(1), why: z.string().min(1) }))
    .min(1)
    .max(4),
  confidence: ConfidenceSchema,
  sources: z.array(SourceSchema),
  individualVariationCaveat: z.string().optional(),
});

export type LensResult = z.infer<typeof LensResultSchema>;
