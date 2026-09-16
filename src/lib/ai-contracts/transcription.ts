import { z } from "zod";
import { ConfidenceSchema, LanguageCodeSchema } from "./common";

/**
 * TranscriptionResultSchema — recorded and streaming speech to text.
 *
 * `codeSwitching` and per-segment `language` exist because students routinely
 * mix languages inside one sentence ("Anh muốn order nasi lemak but no sambal").
 */
export const TranscriptionResultSchema = z.object({
  transcript: z.string().min(1),
  primaryLanguage: LanguageCodeSchema,
  detectedLanguages: z.array(LanguageCodeSchema).min(1),
  codeSwitching: z.boolean(),
  segments: z
    .array(
      z.object({
        text: z.string().min(1),
        startMs: z.number().int().min(0),
        endMs: z.number().int().min(0),
        speaker: z.string().optional(),
        language: LanguageCodeSchema.optional(),
      }),
    )
    .max(500),
  durationMs: z.number().int().min(0).optional(),
  confidence: ConfidenceSchema,
});

export type TranscriptionResult = z.infer<typeof TranscriptionResultSchema>;
