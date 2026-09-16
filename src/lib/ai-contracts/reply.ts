import { z } from "zod";
import { ConfidenceSchema, LanguageCodeSchema, ToneModeSchema } from "./common";

/** ReplyResultSchema — student intent rendered as a host-language sentence. */
export const ReplyResultSchema = z.object({
  intentSummary: z.string().min(1),
  targetLanguage: LanguageCodeSchema,
  variants: z
    .array(
      z.object({
        mode: ToneModeSchema,
        text: z.string().min(1),
        romanization: z.string().optional(),
        backTranslation: z.string().min(1),
        why: z.string().min(1),
      }),
    )
    .min(1)
    .max(4),
  warnings: z.array(z.string()).max(4),
  confidence: ConfidenceSchema,
});

export type ReplyResult = z.infer<typeof ReplyResultSchema>;
