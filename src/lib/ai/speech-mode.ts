/**
 * Speech fallback decision.
 *
 * Deliberately dependency-free so the ordering can be tested in Node without a
 * browser, a network, or the Appwrite client. `speech.ts` owns the I/O; this
 * file owns the rule.
 *
 * A failed voice must never block the conversation:
 *   provider TTS → the device's own voice → text only.
 */

export type SpeechMode = "provider" | "browser" | "text-only" | "unsupported";

export function decideSpeechMode({ providerOk, browserSupported, browserSpoke }: { providerOk: boolean; browserSupported: boolean; browserSpoke: boolean }): SpeechMode {
  if (providerOk) return "provider";
  if (!browserSupported) return "unsupported";
  return browserSpoke ? "browser" : "text-only";
}

/** User-facing explanation for a mode that produced no audio. */
export function speechFallbackReason(mode: SpeechMode, language: string, detail?: string): string | undefined {
  if (mode === "provider" || mode === "browser") return undefined;
  if (mode === "unsupported") return detail ?? "This browser cannot speak, so the text is shown instead.";
  return detail ?? `No voice is available for ${language} on this device. Show the text instead.`;
}
