/**
 * Phrase / Listen.
 *
 * Speech degrades through three states — provider audio, browser speech, text
 * only — and the screen always shows the text regardless. A student standing in
 * a shop with no network still needs to be able to point at the screen.
 *
 * Register and "when not to use" are shown with the same weight as the phrase
 * itself. A phrase list that only teaches the words, without teaching when they
 * are rude, is how a student gets a worse outcome than saying nothing.
 */
import { useEffect, useState } from "react";
import { ScreenHeader, Scroll } from "../../components/shell";
import { Badge, Button, Card, EmptyState, Skeleton } from "../../components/ui";
import { Icon } from "../../components/icons";
import { Section } from "../../components/greenbook/bits";
import { COUNTRIES, type CountryCode } from "../../data/countries";
import { listPhrases, type StudentPhrase } from "../../lib/greenbook";
import { speakWithFallback, stopBrowserSpeech } from "../../lib/ai/speech";

/** Country → the language code the phrase rows are stored under. */
const HOST_LANGUAGE: Record<string, string> = { MY: "ms", SG: "en", ID: "id", TH: "th", PH: "fil", VN: "vi", BN: "ms", KH: "km", LA: "lo", MM: "my", TL: "pt" };

export function Phrases({ countryCode, chapter, onBack }: { countryCode: string; chapter?: string | null; onBack: () => void }) {
  const [phrases, setPhrases] = useState<StudentPhrase[] | null>(null);
  const [speaking, setSpeaking] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(null);
  const host = countryCode as CountryCode;
  const language = HOST_LANGUAGE[countryCode] ?? "en";

  useEffect(() => {
    let cancelled = false;
    setPhrases(null);
    void listPhrases(countryCode, chapter ?? undefined).then((result) => {
      if (!cancelled) setPhrases(result);
    });
    return () => {
      cancelled = true;
      stopBrowserSpeech();
    };
  }, [countryCode, chapter]);

  async function listen(phrase: StudentPhrase) {
    setSpeaking(phrase.phraseId);
    setNotice(null);
    try {
      const outcome = await speakWithFallback({ text: phrase.localText, language: phrase.languageCode || language });
      if (outcome.mode === "provider" && outcome.audioUrl) {
        const audio = new Audio(outcome.audioUrl);
        audio.onended = () => URL.revokeObjectURL(outcome.audioUrl!);
        await audio.play();
      } else if (outcome.mode === "text-only" || outcome.mode === "unsupported") {
        // The phrase stays on screen; only the audio is unavailable.
        setNotice({ id: phrase.phraseId, text: outcome.reason ?? "Audio is not available here — read the phrase aloud instead." });
      }
    } catch {
      setNotice({ id: phrase.phraseId, text: "Audio is not available here — read the phrase aloud instead." });
    } finally {
      setSpeaking(null);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title={`${COUNTRIES[host]?.name ?? countryCode} phrases`} onBack={onBack} />
      <Scroll className="px-4 pb-8 pt-4">
        {phrases === null ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
        ) : phrases.length === 0 ? (
          <EmptyState
            icon="chat"
            title="No phrases stored yet"
            body={`No reviewed ${COUNTRIES[host]?.name ?? countryCode} phrases have been added. Rather than machine-translate something that might be wrong or rude, this stays empty.`}
          />
        ) : (
          <>
            <Card className="mb-4 p-3.5">
              <p className="text-[12px] leading-relaxed text-muted">
                Each phrase carries its register and its limits. Local usage varies by city and by generation — treat these as a starting point, not a script.
              </p>
            </Card>
            {phrases.map((phrase) => (
              <Card key={phrase.phraseId} className="mb-2 p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[16px] font-bold leading-snug text-ink">{phrase.localText}</p>
                    {phrase.romanization && <p className="mt-0.5 text-[12px] italic text-muted">{phrase.romanization}</p>}
                    <p className="mt-1.5 text-[13px] text-ink">{phrase.translation}</p>
                  </div>
                  <Button size="sm" variant="soft" onClick={() => void listen(phrase)} disabled={speaking === phrase.phraseId}>
                    <Icon name={speaking === phrase.phraseId ? "signal" : "mic"} size={15} />
                    {speaking === phrase.phraseId ? "…" : "Listen"}
                  </Button>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {phrase.register && <Badge tone="muted">{phrase.register}</Badge>}
                  {phrase.contextKey && <Badge tone="muted">{phrase.contextKey.replace(/_/g, " ")}</Badge>}
                </div>

                {phrase.whenToUse && <p className="mt-2 text-[11px] leading-relaxed text-muted">Use it when: {phrase.whenToUse}</p>}
                {phrase.whenNotToUse && <p className="mt-1 text-[11px] leading-relaxed text-warning">Not when: {phrase.whenNotToUse}</p>}

                {notice?.id === phrase.phraseId && (
                  <p className="mt-2 rounded-[8px] bg-canvas px-2.5 py-2 text-[11px] leading-relaxed text-muted">{notice.text}</p>
                )}
              </Card>
            ))}
          </>
        )}
      </Scroll>
    </div>
  );
}

export default Phrases;
