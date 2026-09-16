import { account } from "./appwrite/client";

/**
 * App preferences (language, notifications, retention, cookie categories).
 *
 * Stored in the Appwrite Account `prefs` JSON object (64 kB limit), so they
 * follow the account across devices and work for guests too. Appwrite replaces
 * the whole prefs object on write, so every save merges first.
 */

export type RetentionPolicy = "immediate" | "7d" | "keep";

export interface NotificationPreferences {
  practiceReminders: boolean;
  journeyUpdates: boolean;
  communityReplies: boolean;
}

export interface RetentionPreferences {
  /** Raw Lens screenshots/photos. Default: never persisted. */
  screenshots: RetentionPolicy;
  /** Raw voice recordings. Default: never persisted. */
  voice: RetentionPolicy;
}

export type LanguageLevel = "beginner" | "intermediate" | "advanced";
export type ShowWhen = "always" | "when_needed" | "never";
export type AutoSpeakMode = "ask" | "automatic" | "never";
export type SpeechSpeed = "slow" | "normal" | "natural";
export type ConversationMode = "push_to_talk" | "auto_listen";
export type TranscriptRetention = "never" | "session" | "ask";

/**
 * AI Language Profile.
 *
 * Country never decides language (docs/00_PRODUCT_BRIEF.md): the host country
 * only *suggests* a default local language, and every field here is an explicit
 * user choice that overrides that suggestion.
 */
export interface AiLanguageProfile {
  /** "I understand explanations in" — the coaching/explanation language. */
  explanationLanguage: string;
  /** The student's own first language. Distinct from the interface language. */
  nativeLanguage: string;
  /** Preferred languages when speaking to local people, in priority order. */
  preferredLocalLanguages: string[];
  /** Self-assessed level in the primary local language. */
  level: LanguageLevel;
  showTranslation: ShowWhen;
  showRomanization: ShowWhen;
  /** Whether spoken output is offered at all. */
  voiceEnabled: boolean;
  autoSpeak: AutoSpeakMode;
  speechSpeed: SpeechSpeed;
  conversationMode: ConversationMode;
  saveTranscripts: TranscriptRetention;
  /** Translate what the other person says without being asked. */
  autoTranslateIncoming: boolean;
}

export const DEFAULT_AI_LANGUAGE_PROFILE: AiLanguageProfile = {
  explanationLanguage: "en",
  nativeLanguage: "en",
  preferredLocalLanguages: [],
  level: "beginner",
  showTranslation: "always",
  showRomanization: "always",
  voiceEnabled: true,
  autoSpeak: "ask",
  speechSpeed: "normal",
  conversationMode: "push_to_talk",
  saveTranscripts: "session",
  autoTranslateIncoming: true,
};

/** Local-language suggestions per host country. Suggestions only — never applied silently. */
export const LOCAL_LANGUAGE_SUGGESTIONS: Record<string, string[]> = {
  BN: ["ms", "en"],
  KH: ["km", "en"],
  ID: ["id", "en"],
  LA: ["lo", "en"],
  MY: ["ms", "en"],
  MM: ["my", "en"],
  PH: ["fil", "en"],
  SG: ["en", "zh-Hans", "ms", "ta"],
  TH: ["th", "en"],
  TL: ["pt-PT", "en"],
  VN: ["vi", "en"],
};

/**
 * A starting point offered in onboarding. The user can override every field,
 * and nothing here is written to preferences without an explicit confirmation.
 */
export function suggestLanguageProfile(hostCountry: string, explanationLanguage = "en"): AiLanguageProfile {
  const local = LOCAL_LANGUAGE_SUGGESTIONS[hostCountry] ?? ["en"];
  return {
    ...DEFAULT_AI_LANGUAGE_PROFILE,
    explanationLanguage,
    nativeLanguage: explanationLanguage,
    preferredLocalLanguages: local.filter((code) => code !== explanationLanguage).slice(0, 2),
  };
}

export interface AppPreferences {
  language: string;
  theme: "light" | "system";
  notifications: NotificationPreferences;
  retention: RetentionPreferences;
  /** Keep Lens/AI history for personalisation. */
  lensHistory: boolean;
  cookies: { analytics: boolean; marketing: boolean };
  aiLanguage: AiLanguageProfile;
  updatedAt: string | null;
}

export const PREFERENCES_KEY = "yapyep";

export const DEFAULT_PREFERENCES: AppPreferences = {
  language: "en",
  theme: "light",
  notifications: { practiceReminders: true, journeyUpdates: true, communityReplies: false },
  retention: { screenshots: "immediate", voice: "immediate" },
  lensHistory: true,
  cookies: { analytics: false, marketing: false },
  aiLanguage: DEFAULT_AI_LANGUAGE_PROFILE,
  updatedAt: null,
};

export const LANGUAGES: { code: string; label: string }[] = [
  { code: "en", label: "English" },
  { code: "vi", label: "Tiếng Việt" },
  { code: "th", label: "ไทย" },
  { code: "id", label: "Bahasa Indonesia" },
  { code: "ms", label: "Bahasa Melayu" },
  { code: "fil", label: "Filipino" },
  { code: "km", label: "ភាសាខ្មែរ" },
  { code: "lo", label: "ລາວ" },
  { code: "my", label: "မြန်မာ" },
  { code: "ta", label: "தமிழ்" },
  { code: "zh-Hans", label: "简体中文" },
  { code: "pt-PT", label: "Português" },
];

export const LANGUAGE_LABELS: Record<string, string> = Object.fromEntries(LANGUAGES.map((entry) => [entry.code, entry.label]));

export function languageLabel(code: string | undefined): string {
  if (!code) return "Not set";
  return LANGUAGE_LABELS[code] ?? code;
}

/** Scripts that need romanization for a beginner to be able to say the phrase. */
const NON_LATIN = new Set(["th", "km", "lo", "my", "ta", "zh-Hans", "zh-Hant", "ar", "he", "ka", "hy", "bn", "hi", "ur", "si"]);

export function needsRomanization(code: string | undefined): boolean {
  if (!code) return false;
  return NON_LATIN.has(code) || NON_LATIN.has(code.split("-")[0]);
}

function mergeAiLanguage(stored: unknown): AiLanguageProfile {
  if (!stored || typeof stored !== "object") return { ...DEFAULT_AI_LANGUAGE_PROFILE };
  const value = stored as Partial<AiLanguageProfile>;
  return {
    ...DEFAULT_AI_LANGUAGE_PROFILE,
    ...value,
    preferredLocalLanguages: Array.isArray(value.preferredLocalLanguages)
      ? value.preferredLocalLanguages.filter((code): code is string => typeof code === "string")
      : [],
  };
}

function merge(stored: unknown): AppPreferences {
  if (!stored || typeof stored !== "object") return { ...DEFAULT_PREFERENCES };
  const value = stored as Partial<AppPreferences>;
  return {
    ...DEFAULT_PREFERENCES,
    ...value,
    notifications: { ...DEFAULT_PREFERENCES.notifications, ...(value.notifications ?? {}) },
    retention: { ...DEFAULT_PREFERENCES.retention, ...(value.retention ?? {}) },
    cookies: { ...DEFAULT_PREFERENCES.cookies, ...(value.cookies ?? {}) },
    aiLanguage: mergeAiLanguage(value.aiLanguage),
  };
}

export async function loadPreferences(): Promise<AppPreferences> {
  try {
    const prefs = (await account.getPrefs()) as Record<string, unknown>;
    return merge(prefs?.[PREFERENCES_KEY]);
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export async function savePreferences(patch: Partial<AppPreferences>): Promise<AppPreferences> {
  const current = await loadPreferences();
  const next: AppPreferences = {
    ...current,
    ...patch,
    notifications: { ...current.notifications, ...(patch.notifications ?? {}) },
    retention: { ...current.retention, ...(patch.retention ?? {}) },
    cookies: { ...current.cookies, ...(patch.cookies ?? {}) },
    aiLanguage: { ...current.aiLanguage, ...(patch.aiLanguage ?? {}) },
    updatedAt: new Date().toISOString(),
  };
  const prefs = (await account.getPrefs()) as Record<string, unknown>;
  await account.updatePrefs({ prefs: { ...prefs, [PREFERENCES_KEY]: next } });
  return next;
}
