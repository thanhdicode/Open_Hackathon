import { z } from "zod";
import { ConfidenceSchema, ToneModeSchema } from "./common";

/** ToneCheckResultSchema — register assessment and rewrites for a draft. */
export const ToneCheckResultSchema = z.object({
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
    .array(z.object({ mode: ToneModeSchema, text: z.string().min(1) }))
    .min(1)
    .max(3),
  contextNotes: z.array(z.string()).max(4),
  confidence: ConfidenceSchema,
});

export type ToneCheckResult = z.infer<typeof ToneCheckResultSchema>;
