import { callAi, AiError } from "../ai-contracts/client";
import { TranslationTurnSchema } from "../ai-contracts/translation";
import { DEFAULT_AI_LANGUAGE_PROFILE } from "../preferences";
import type { Journey } from "../../data/journeys";

/**
 * Translate a community post.
 *
 * This reuses the existing `/translate` route rather than inventing a second
 * translation path, and it inherits that route's behaviour: the response is
 * validated against the frozen contract before it is rendered, so a malformed
 * payload shows an error instead of a plausible-looking wrong translation.
 *
 * The failure copy matters here. A community post is often the only thing telling
 * a student what a place is really like, so a translation that silently did not
 * happen must say so — the original text stays visible underneath.
 */

export type TranslateOutcome =
  | { ok: true; text: string; targetLanguage: string; engine: string }
  | { ok: false; message: string; retryable: boolean };

export async function translateText(text: string, journey: Journey, targetLanguage?: string): Promise<TranslateOutcome> {
  const target = targetLanguage ?? DEFAULT_AI_LANGUAGE_PROFILE.explanationLanguage;
  if (!text.trim()) return { ok: false, message: "There is nothing to translate.", retryable: false };

  try {
    const { data } = await callAi(
      "/translate",
      {
        journey,
        userLanguage: target,
        coachingLanguage: target,
        level: DEFAULT_AI_LANGUAGE_PROFILE.level,
        // The source is unknown, so the route detects it. Passing a guess would
        // bias detection toward the student's own language.
        sourceLanguage: "und",
        targetLanguage: target,
        text,
      },
      TranslationTurnSchema,
    );
    return { ok: true, text: data.translatedText, targetLanguage: data.targetLanguage, engine: data.engine };
  } catch (error) {
    if (error instanceof AiError) {
      return {
        ok: false,
        retryable: error.retryable,
        message:
          error.code === "NOT_CONFIGURED"
            ? "Translation is not connected in this build. The original text is shown."
            : error.message,
      };
    }
    return { ok: false, retryable: true, message: "Translation is unavailable right now. The original text is shown." };
  }
}
