/**
 * Languages the Live Translate model actually supports, transcribed from
 * https://ai.google.dev/gemini-api/docs/live-api/live-translate (verified
 * 2026-09-16). Used to refuse a voice session we cannot honour instead of
 * silently degrading the student's conversation.
 *
 * Tetum (Timor-Leste) is NOT in the provider list. The product must fall back
 * to typed text or a shared language for TL rather than claim voice support.
 */
export const LIVE_TRANSLATE_LANGUAGES = new Set([
  "af", "ak", "am", "ar", "hy", "az", "eu", "be", "bn", "bg", "my", "ca", "zh-Hans", "zh-Hant", "hr", "cs", "da", "nl",
  "en", "et", "fil", "fi", "fr", "gl", "ka", "de", "el", "gu", "ha", "he", "hi", "hu", "is", "id", "it", "ja", "jv",
  "kn", "kk", "km", "rw", "ko", "lo", "lv", "lt", "mk", "ms", "ml", "mr", "mn", "ne", "no", "nb", "fa", "pl", "pt-BR",
  "pt-PT", "pa", "ro", "ru", "sr", "sd", "si", "sk", "sl", "es", "su", "sw", "sv", "ta", "te", "th", "tr", "uk", "ur",
  "uz", "vi", "zu",
]);

export function isLiveTranslateSupported(code) {
  if (!code) return false;
  if (LIVE_TRANSLATE_LANGUAGES.has(code)) return true;
  const base = code.split("-")[0];
  return LIVE_TRANSLATE_LANGUAGES.has(base);
}

/** Voice fallback order for a language with no Live Translate support. */
export function voiceFallbackFor(code, hostCountry) {
  if (isLiveTranslateSupported(code)) return { supported: true };
  const perCountry = { TL: ["pt-PT", "en", "id"] };
  return {
    supported: false,
    reason: `${code} is not in the Live Translate supported set.`,
    options: (perCountry[hostCountry] ?? ["en"]).filter(isLiveTranslateSupported),
    typedTextStillAvailable: true,
  };
}
