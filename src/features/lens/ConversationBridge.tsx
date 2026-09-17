import YepGuide from "../../components/yep-guide";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Card, Notice } from "../../components/ui";
import { Icon } from "../../components/icons";
import { AiActivity, AiProvenance } from "../../components/ai-activity";
import { useAiActivity } from "../../lib/ai/activity";
import { callAi } from "../../lib/ai-contracts/client";
import { CoachInsightSchema, type CoachInsight, type ConversationTurn } from "../../lib/ai-contracts/conversation";
import { ReplyResultSchema, type ReplyResult } from "../../lib/ai-contracts/reply";
import { speakWithFallback, stopBrowserSpeech, type SpeechMode } from "../../lib/ai/speech";
import { TranscriptionResultSchema } from "../../lib/ai-contracts/transcription";
import { TranslationTurnSchema } from "../../lib/ai-contracts/translation";
import type { LanguageLevel } from "../../lib/preferences";
import { startRecording, type ActiveRecording } from "./capture";

/**
 * Conversation Bridge.
 *
 * Two lanes on purpose: translation (what the other person actually said) and
 * coaching (what it means for the student). The coach never speaks for the
 * student and never decides for them — it asks, and the student chooses or
 * answers in their own words.
 */

interface Props {
  journey: { home: string; host: string; city?: string; university?: string };
  userLanguage: string;
  localLanguage: string;
  level: LanguageLevel;
  voiceEnabled: boolean;
  onPractice: (incident: string) => void;
}

type Stage = "waiting_local" | "coaching" | "replying" | "speaking";

export function ConversationBridge({ journey, userLanguage, localLanguage, level, voiceEnabled, onPractice }: Props) {
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [coach, setCoach] = useState<CoachInsight | null>(null);
  const [reply, setReply] = useState<ReplyResult | null>(null);
  const [stage, setStage] = useState<Stage>("waiting_local");
  const [userText, setUserText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [recording, setRecording] = useState<ActiveRecording | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [speechMode, setSpeechMode] = useState<SpeechMode | null>(null);
  const activity = useAiActivity();
  const audioRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (audioRef.current) URL.revokeObjectURL(audioRef.current);
      // Browser speech outlives the component otherwise, and would keep
      // talking over the next turn.
      stopBrowserSpeech();
    },
    [],
  );

  const context = { journey, userLanguage, coachingLanguage: userLanguage, level };

  const transcriptText = useCallback(
    (extra?: string) =>
      [...turns.map((turn) => `${turn.speaker === "local" ? "LOCAL" : "STUDENT"}: ${turn.originalText}`), ...(extra ? [extra] : [])].join("\n"),
    [turns],
  );

  const appendTurn = useCallback((turn: ConversationTurn) => setTurns((previous) => [...previous, turn]), []);

  /* ---------------------- Lane 1 + 2: local person speaks ------------------- */

  const handleLocalAudio = useCallback(
    async (file: File) => {
      setNotice(null);
      const transcript = await activity.run({ label: `Transcribing ${localLanguage}` }, async () => {
        const { data } = await callAi(
          "/transcribe",
          { ...context, mediaBase64: await base64Of(file), mimeType: file.type || "audio/webm", languageHint: localLanguage },
          TranscriptionResultSchema,
        );
        return data;
      });
      if (!transcript) return;

      const translation = await activity.run({ label: "Translating" }, async () => {
        const { data } = await callAi(
          "/translate",
          { ...context, sourceLanguage: transcript.primaryLanguage === "und" ? localLanguage : transcript.primaryLanguage, targetLanguage: userLanguage, text: transcript.transcript },
          TranslationTurnSchema,
        );
        return data;
      });
      if (!translation) return;

      appendTurn({
        id: `local-${Date.now()}`,
        index: turns.length,
        speaker: "local",
        sourceLanguage: translation.sourceLanguage,
        targetLanguage: translation.targetLanguage,
        originalText: translation.originalText,
        translatedText: translation.translatedText,
        ...(translation.romanization ? { romanization: translation.romanization } : {}),
        createdAt: new Date().toISOString(),
      });

      // Lane 2 runs on the transcript, separately from translation.
      const insight = await activity.run({ label: "Working out what they want" }, async () => {
        const { data } = await callAi(
          "/coach",
          { ...context, localLanguage, transcript: transcriptText(`LOCAL: ${translation.originalText}`) },
          CoachInsightSchema,
        );
        return data;
      });
      if (!insight) return;
      setCoach(insight);
      setStage("coaching");
      activity.finish();
    },
    [activity, appendTurn, context, localLanguage, transcriptText, turns.length, userLanguage],
  );

  const recordLocal = useCallback(async () => {
    try {
      setRecording(await startRecording());
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Recording is unavailable. Upload an audio file instead.");
    }
  }, []);

  const stopRecording = useCallback(async () => {
    if (!recording) return;
    setRecording(null);
    try {
      const captured = await recording.stop();
      await handleLocalAudio(captured.file);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Recording failed.");
    }
  }, [handleLocalAudio, recording]);

  /* ----------------------------- Lane 3: reply ----------------------------- */

  const sendReply = useCallback(
    async (intent: string) => {
      if (!intent.trim()) return;
      setNotice(null);
      // A new turn must not be spoken over by the previous one.
      stopBrowserSpeech();
      setSpeechMode(null);
      setAudioUrl(null);
      const generated = await activity.run({ label: `Writing this in ${localLanguage}` }, async () => {
        const { data, meta } = await callAi(
          "/reply",
          { ...context, targetLanguage: localLanguage, localLanguage, userIntent: intent, situation: coach?.whatUserNeedsToDecide, confirmRequired: false },
          ReplyResultSchema,
        );
        return { data, meta };
      });
      if (!generated) return;

      setReply(generated.data);
      setStage("replying");
      appendTurn({
        id: `user-${Date.now()}`,
        index: turns.length + 1,
        speaker: "user",
        sourceLanguage: userLanguage,
        targetLanguage: localLanguage,
        originalText: intent,
        translatedText: generated.data.variants[0].text,
        ...(generated.data.variants[0].romanization ? { romanization: generated.data.variants[0].romanization } : {}),
        ...(coach ? { coach } : {}),
        decision: { question: coach?.whatUserNeedsToDecide ?? "", options: coach?.safeReplyOptions.map((option) => option.text) ?? [], chosen: intent },
        createdAt: new Date().toISOString(),
      });
      setUserText("");
      activity.finish();
    },
    [activity, appendTurn, coach, context, localLanguage, turns.length, userLanguage],
  );

  const speak = useCallback(
    async (text: string) => {
      if (!voiceEnabled) {
        setNotice("Voice output is off in your language profile. Turn it on in Settings to speak this aloud.");
        return;
      }
      setNotice(null);
      setSpeechMode(null);
      // A failed voice must never block the conversation: provider TTS, then
      // the browser's own voice, then a text-only card.
      const outcome = await speakWithFallback({ text, language: localLanguage, journey, userLanguage, level });
      setSpeechMode(outcome.mode);
      if (outcome.mode === "provider" && outcome.audioUrl) {
        if (audioRef.current) URL.revokeObjectURL(audioRef.current);
        audioRef.current = outcome.audioUrl;
        setAudioUrl(outcome.audioUrl);
        setStage("speaking");
        void new Audio(outcome.audioUrl).play().catch(() => setNotice("Your browser blocked audio playback. Tap play to hear it."));
      } else if (outcome.mode === "browser") {
        setStage("speaking");
      } else {
        setNotice(outcome.reason ?? "No voice is available for this language. The text is shown below — read it aloud or show your screen.");
      }
    },
    [journey, level, localLanguage, userLanguage, voiceEnabled],
  );

  /* --------------------------------- render -------------------------------- */

  const busy = activity.state.status === "working" || activity.state.status === "validating";

  return (
    <div data-tour-screen="conversation" className="flex h-full flex-col">
      <div className="px-5 pb-2">
        <Card className="p-3">
          <div className="flex items-center justify-between text-[12px]">
            <span className="font-semibold text-ink">You: {userLanguage}</span>
            <span className="text-muted">Two lanes: translation, then coaching</span>
            <span className="font-semibold text-ink">Them: {localLanguage}</span>
          </div>
        </Card>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
        {turns.length === 0 && (
          <YepGuide screen="conversation" title="Listen, understand, then reply" pose="practice">Hold to record or type what was said. Read the translation and coaching, choose your response, then confirm before speaking it to the other person.</YepGuide>
        )}

        <div className="mt-3 space-y-3">
          {turns.map((turn) => (
            <div key={turn.id} className={`flex ${turn.speaker === "user" ? "justify-end" : "justify-start"}`}>
              <div className="max-w-[85%] space-y-1">
                <div className={`rounded-[12px] px-3.5 py-2.5 ${turn.speaker === "user" ? "bg-ink text-white" : "border border-line bg-surface"}`}>
                  <p className={`text-[14px] leading-relaxed ${turn.speaker === "user" ? "text-white" : "text-ink"}`}>{turn.originalText}</p>
                  {turn.translatedText && turn.translatedText !== turn.originalText && (
                    <p className={`mt-1.5 border-t pt-1.5 text-[13px] leading-relaxed ${turn.speaker === "user" ? "border-white/20 text-white/85" : "border-line text-muted"}`}>
                      {turn.translatedText}
                    </p>
                  )}
                  {turn.romanization && <p className={`mt-1 text-[12px] italic ${turn.speaker === "user" ? "text-white/70" : "text-muted"}`}>{turn.romanization}</p>}
                </div>
                {turn.speaker === "user" && (
                  <button onClick={() => speak(turn.translatedText)} className="ml-auto flex min-h-[44px] items-center gap-1.5 px-1 text-[13px] font-semibold text-primary">
                    <Icon name="signal" size={15} /> Speak to them
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {coach && stage === "coaching" && (
          <Card className="mt-4 p-4">
            <div className="flex items-center justify-between">
              <p className="text-[12px] font-bold uppercase tracking-wide text-primary">What they need from you</p>
              <Badge tone={coach.confidence.label === "high" ? "success" : "muted"}>{coach.confidence.label}</Badge>
            </div>
            <p className="mt-2 text-[15px] font-semibold text-ink">{coach.whatUserNeedsToDecide}</p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{coach.likelyIntent}</p>
            {coach.missingInformation.length > 0 && (
              <ul className="mt-2 space-y-1">
                {coach.missingInformation.map((item) => (
                  <li key={item} className="text-[13px] text-ink">
                    · {item}
                  </li>
                ))}
              </ul>
            )}

            <p className="mt-3 text-[12px] font-bold uppercase tracking-wide text-muted">You can answer</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {coach.safeReplyOptions.map((option) => (
                <button
                  key={option.text}
                  onClick={() => sendReply(option.text)}
                  disabled={busy}
                  className="min-h-[44px] rounded-full border border-line bg-surface px-3.5 py-2 text-left text-[13px] font-semibold text-ink disabled:opacity-50"
                >
                  {option.text}
                </button>
              ))}
            </div>

            <div className="mt-3">
              <label className="text-[12px] font-bold uppercase tracking-wide text-muted" htmlFor="bridge-reply">
                Or answer in your own words
              </label>
              <textarea
                id="bridge-reply"
                value={userText}
                onChange={(event) => setUserText(event.target.value)}
                placeholder={`Type in ${userLanguage} — YapYep will write it in ${localLanguage}`}
                className="mt-1.5 h-20 w-full resize-none rounded-[12px] border border-line bg-surface p-3 text-[14px] outline-none focus:border-primary"
              />
              <div className="mt-2">
                <Button full disabled={!userText.trim() || busy} onClick={() => sendReply(userText)}>
                  Say this in {localLanguage}
                </Button>
              </div>
            </div>

            {coach.clarificationQuestion && (
              <button onClick={() => setUserText(coach.clarificationQuestion ?? "")} className="mt-3 min-h-[44px] text-left text-[13px] font-medium text-primary">
                Not sure? Ask: “{coach.clarificationQuestion}”
              </button>
            )}
            <p className="mt-3 text-[11px] text-muted">{coach.caveat}</p>

            {/* What the assistant believes it knows. Shown so the student can
                correct it rather than discovering a wrong assumption later. */}
            {coach.memory && (
              <div className="mt-3 rounded-[10px] border border-line bg-canvas p-3">
                <p className="text-[11px] font-bold uppercase tracking-wide text-muted">Conversation memory</p>
                <ul className="mt-1.5 space-y-1 text-[12px] text-ink">
                  {coach.memory.topic && <li>Topic: {coach.memory.topic}</li>}
                  {coach.memory.entities.length > 0 && <li>Order: {coach.memory.entities.join(", ")}</li>}
                  {coach.memory.quantity && <li>Quantity: {coach.memory.quantity}</li>}
                  {coach.memory.location && <li>Place: {coach.memory.location}</li>}
                  {coach.memory.price && <li>Price: {coach.memory.price}</li>}
                  {coach.memory.resolvedFacts.map((fact) => (
                    <li key={fact}>✓ {fact}</li>
                  ))}
                  {coach.memory.openQuestions.map((question) => (
                    <li key={question} className="text-warning">Still open: {question}</li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
        )}

        {reply && stage !== "coaching" && (
          <Card className="mt-4 p-4">
            <p className="text-[12px] font-bold uppercase tracking-wide text-muted">In {localLanguage}</p>
            <p className="mt-1.5 text-[16px] font-semibold text-ink">{reply.variants[0].text}</p>
            {reply.variants[0].romanization && <p className="mt-1 text-[13px] italic text-muted">{reply.variants[0].romanization}</p>}
            <p className="mt-2 text-[13px] text-muted">Back in your language: {reply.variants[0].backTranslation}</p>
            <div className="mt-3 flex gap-2">
              <Button variant="soft" full onClick={() => speak(reply.variants[0].text)}>
                <Icon name="signal" size={16} /> Speak it
              </Button>
              <Button variant="soft" full onClick={() => setStage("waiting_local")}>
                Next turn
              </Button>
            </div>
            {audioUrl && <audio controls src={audioUrl} className="mt-3 w-full" />}
            {speechMode === "browser" && <p className="mt-2 text-[11px] text-muted">Spoken with your device's own voice — the AI voice was unavailable.</p>}
            {(speechMode === "text-only" || speechMode === "unsupported") && (
              <p className="mt-2 text-[11px] text-muted">No voice is available for {localLanguage} on this device. Show this screen to the other person, or read it aloud.</p>
            )}
          </Card>
        )}

        {activity.state.status === "error" && (
          <div className="mt-4">
            <Notice tone="error" icon="alert" title="That turn did not complete" body={activity.state.error?.message ?? "Please try again."} />
          </div>
        )}
        {notice && (
          <div className="mt-4">
            <Notice tone="warning" icon="info" title="Fallback in use" body={notice} />
          </div>
        )}
      </div>

      <div className="border-t border-line bg-surface px-5 py-4">
        <AiActivity state={activity.state} onCancel={activity.reset} />
        {!busy && (
          <div data-yep="controls" className="flex items-center gap-3">
            {voiceEnabled ? (
              <button
                onPointerDown={recordLocal}
                onPointerUp={stopRecording}
                onPointerLeave={() => recording && stopRecording()}
                aria-label="Hold to capture what the other person said"
                className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-full text-white transition ${recording ? "bg-danger" : "bg-ink"}`}
              >
                <Icon name="mic" size={24} />
              </button>
            ) : (
              <label className="flex h-16 shrink-0 items-center rounded-full border border-line px-4 text-[13px] font-semibold text-ink">
                Upload audio
                <input
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (file) await handleLocalAudio(file);
                  }}
                />
              </label>
            )}
            <p className="text-[13px] font-medium text-muted">
              {recording ? "Recording — release to translate" : stage === "coaching" ? "Answer above, or hold to record them again" : "Hold when they speak"}
            </p>
          </div>
        )}
        <AiProvenance meta={activity.state.meta} />
        {turns.length >= 2 && (
          <button
            onClick={() => onPractice(transcriptText())}
            className="mt-3 min-h-[44px] text-[13px] font-semibold text-primary"
          >
            Practice this conversation
          </button>
        )}
      </div>
    </div>
  );
}

async function base64Of(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  return btoa(binary);
}
