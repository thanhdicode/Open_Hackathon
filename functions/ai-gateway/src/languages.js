/**
 * Language code normalisation.
 *
 * Speech providers do not agree on how to report a detected language: Groq
 * Whisper returns a display name ("malay"), Gemini returns a BCP-47 code.
 * The contract requires BCP-47, so names are mapped here rather than coerced.
 * An unrecognised name becomes `und` (ISO 639-3, undetermined) — we never
 * substitute a plausible-looking code we did not detect.
 */

const NAME_TO_CODE = {
  afrikaans: "af", albanian: "sq", amharic: "am", arabic: "ar", armenian: "hy", azerbaijani: "az",
  basque: "eu", belarusian: "be", bengali: "bn", bosnian: "bs", bulgarian: "bg", burmese: "my",
  catalan: "ca", chinese: "zh-Hans", "chinese (simplified)": "zh-Hans", "chinese (traditional)": "zh-Hant",
  croatian: "hr", czech: "cs", danish: "da", dutch: "nl", english: "en", estonian: "et", filipino: "fil",
  finnish: "fi", french: "fr", galician: "gl", georgian: "ka", german: "de", greek: "el", gujarati: "gu",
  hausa: "ha", hebrew: "he", hindi: "hi", hungarian: "hu", icelandic: "is", indonesian: "id", italian: "it",
  japanese: "ja", javanese: "jv", kannada: "kn", kazakh: "kk", khmer: "km", korean: "ko", lao: "lo",
  latvian: "lv", lithuanian: "lt", macedonian: "mk", malay: "ms", malayalam: "ml", maltese: "mt",
  marathi: "mr", mongolian: "mn", nepali: "ne", norwegian: "no", persian: "fa", polish: "pl",
  portuguese: "pt-PT", punjabi: "pa", romanian: "ro", russian: "ru", serbian: "sr", sinhala: "si",
  slovak: "sk", slovenian: "sl", spanish: "es", sundanese: "su", swahili: "sw", swedish: "sv",
  tamil: "ta", telugu: "te", thai: "th", turkish: "tr", ukrainian: "uk", urdu: "ur", uzbek: "uz",
  vietnamese: "vi", welsh: "cy", yiddish: "yi", zulu: "zu",
};

const BCP47 = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** Returns a BCP-47 code, or `und` when the provider's value is unrecognised. */
export function normalizeLanguageCode(value, { fallback } = {}) {
  if (typeof value !== "string") return fallback ?? "und";
  const trimmed = value.trim();
  if (!trimmed) return fallback ?? "und";
  if (BCP47.test(trimmed)) return trimmed;
  const mapped = NAME_TO_CODE[trimmed.toLowerCase()];
  return mapped ?? fallback ?? "und";
}

export function isUndetermined(code) {
  return code === "und";
}
