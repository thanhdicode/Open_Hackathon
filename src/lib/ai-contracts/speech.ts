import { z } from "zod";
import { LanguageCodeSchema } from "./common";

/** SpeechResultSchema — synthesized speech returned as a playable audio URL. */
export const SpeechResultSchema = z.object({
  text: z.string().min(1),
  language: LanguageCodeSchema,
  audioBase64: z.string().min(1),
  mimeType: z.string().regex(/^audio\//),
  voiceName: z.string().optional(),
  durationMs: z.number().int().min(0).optional(),
});

export type SpeechResult = z.infer<typeof SpeechResultSchema>;

/**
 * Turn base64 audio into an object URL. The caller owns revocation, so the URL
 * never outlives the turn it belongs to.
 */
export function speechToObjectUrl(speech: SpeechResult): string {
  const binary = atob(speech.audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return URL.createObjectURL(new Blob([bytes], { type: speech.mimeType }));
}
