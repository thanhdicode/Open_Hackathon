import { callAi, AiError } from "../ai-contracts/client";
import { SpeechResultSchema, speechToObjectUrl } from "../ai-contracts/speech";
import { decideSpeechMode, speechFallbackReason, type SpeechMode } from "./speech-mode";

export type { SpeechMode };

export interface SpeakOutcome {
  mode: SpeechMode;
  /** Object URL when `mode === "provider"`. The caller must revoke it. */
  audioUrl?: string;
  /** Populated for every mode so the UI can always show the text. */
  text: string;
  /** Why no audio was produced, when that is the case. */
  reason?: string;
}

const BCP47_TO_SPEECH: Record<string, string> = {
  vi: "vi-VN",
  ms: "ms-MY",
  id: "id-ID",
  th: "th-TH",
  fil: "fil-PH",
  km: "km-KH",
  lo: "lo-LA",
  my: "my-MM",
  ta: "ta-IN",
  "zh-Hans": "zh-CN",
  "zh-Hant": "zh-TW",
  "pt-PT": "pt-PT",
  en: "en-US",
};

export function browserSpeechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

/** Find a voice matching the language, preferring an exact locale match. */
function findVoice(language: string): SpeechSynthesisVoice | null {
  if (!browserSpeechSupported()) return null;
  const target = BCP47_TO_SPEECH[language] ?? language;
  const base = target.split("-")[0].toLowerCase();
  const voices = window.speechSynthesis.getVoices();
  return (
    voices.find((voice) => voice.lang?.toLowerCase() === target.toLowerCase()) ??
    voices.find((voice) => voice.lang?.toLowerCase().startsWith(base)) ??
    null
  );
}

/** Speak through the browser. Resolves when playback finishes or fails. */
function speakWithBrowser(text: string, language: string): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    if (!browserSpeechSupported()) {
      resolve({ ok: false, reason: "This browser has no speech synthesis." });
      return;
    }
    const voice = findVoice(language);
    if (!voice) {
      resolve({ ok: false, reason: `No ${language} voice is installed in this browser.` });
      return;
    }
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.voice = voice;
      utterance.lang = voice.lang;
      utterance.onend = () => resolve({ ok: true });
      utterance.onerror = () => resolve({ ok: false, reason: "The browser could not play the voice." });
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    } catch {
      resolve({ ok: false, reason: "The browser could not play the voice." });
    }
  });
}

/**
 * Speak `text` in `language`, degrading rather than failing.
 * Never throws: the worst case is `mode: "text-only"`.
 */
export async function speakWithFallback({
  text,
  language,
  voiceName,
  journey,
  userLanguage,
  level,
}: {
  text: string;
  language: string;
  voiceName?: string;
  journey?: { home: string; host: string };
  userLanguage?: string;
  level?: string;
}): Promise<SpeakOutcome> {
  let providerOk = false;
  let audioUrl: string | undefined;
  let providerReason: string | undefined;

  try {
    const { data } = await callAi(
      "/tts",
      { text, language, ...(voiceName ? { voiceName } : {}), ...(journey ? { journey } : {}), ...(userLanguage ? { userLanguage } : {}), ...(level ? { level } : {}) },
      SpeechResultSchema,
    );
    providerOk = true;
    audioUrl = speechToObjectUrl(data);
  } catch (cause) {
    providerReason = cause instanceof AiError ? cause.message : "Voice generation is unavailable.";
  }

  const browserSupported = browserSpeechSupported();
  const browser = providerOk || !browserSupported ? { ok: false as const } : await speakWithBrowser(text, language);

  const mode = decideSpeechMode({ providerOk, browserSupported, browserSpoke: browser.ok });
  if (mode === "provider") return { mode, audioUrl, text };
  return { mode, text, reason: speechFallbackReason(mode, language, browser.reason ?? providerReason) };
}

/** Stop any browser speech still playing (e.g. when a turn is replaced). */
export function stopBrowserSpeech(): void {
  if (browserSpeechSupported()) window.speechSynthesis.cancel();
}
