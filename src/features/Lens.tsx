import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useJourney } from "../context/JourneyContext";
import { useNav } from "../context/NavContext";
import { Scroll, useContextPanel, useContextPanelClaim } from "../components/shell";
import { Card, Button, Segmented, RiskBadge, ConfidenceBadge, Badge, Notice, Toast } from "../components/ui";
import { Icon, type IconName } from "../components/icons";
import { AiActivity, AiProvenance } from "../components/ai-activity";
import YepGuide from "../components/yep-guide";
import { LENS_SAMPLES, type ReplyTone } from "../data/lens";
import { COUNTRIES } from "../data/countries";
import { useAiActivity } from "../lib/ai/activity";
import { callAi } from "../lib/ai-contracts/client";
import { LensResultSchema, type LensResult } from "../lib/ai-contracts/lens";
import { SceneResultSchema, type SceneResult, type VisualEvidence } from "../lib/ai-contracts/scene";
import { TranscriptionResultSchema, type TranscriptionResult } from "../lib/ai-contracts/transcription";
import { MediaError, prepareAudio, prepareImage } from "../lib/media";
import { evidenceFromLocalOcr, runLocalOcr } from "../lib/local-ocr";
import { LOCAL_LANGUAGE_SUGGESTIONS, loadPreferences, type AiLanguageProfile } from "../lib/preferences";
import { EvidenceOverlay, SceneOverlay } from "./lens/SceneOverlay";
import { ConversationBridge } from "./lens/ConversationBridge";
import { CaptureError, pickAudio, pickImage, startRecording, type ActiveRecording } from "./lens/capture";

type Mode = "text" | "screenshot" | "camera" | "voice" | "conversation";

const MODE_ICON: Record<Mode, IconName> = {
  text: "text",
  screenshot: "image",
  camera: "camera",
  voice: "mic",
  conversation: "chat",
};

/**
 * Scene state is a two-step ladder.
 *
 * `evidence` is what the device saw on its own — it appears within a second and
 * is the last line of defence. `result` replaces it once the AI has enriched
 * that evidence with meaning, translations and advice.
 */
type SceneState =
  | { kind: "evidence"; evidence: VisualEvidence; imageUrl: string; note: string }
  | { kind: "result"; result: SceneResult; imageUrl: string };

export default function Lens() {
  const { journey, forced } = useJourney();
  const nav = useNav();
  const [mode, setMode] = useState<Mode>("screenshot");
  const [text, setText] = useState("");
  const [textResult, setTextResult] = useState<LensResult | null>(null);
  const [scene, setScene] = useState<SceneState | null>(null);
  const [ocrProgress, setOcrProgress] = useState<number | null>(null);
  const [transcript, setTranscript] = useState<TranscriptionResult | null>(null);
  const [recording, setRecording] = useState<ActiveRecording | null>(null);
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);
  const [profile, setProfile] = useState<AiLanguageProfile | null>(null);
  const activity = useAiActivity();
  const sceneUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadPreferences().then((preferences) => {
      if (!cancelled) setProfile(preferences.aiLanguage);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Raw media lives in memory for this session only and is revoked when the
  // result is cleared or the view unmounts. It is never uploaded to storage.
  const clearScene = useCallback(() => {
    if (sceneUrlRef.current) URL.revokeObjectURL(sceneUrlRef.current);
    sceneUrlRef.current = null;
    setScene(null);
  }, []);

  useEffect(
    () => () => {
      if (sceneUrlRef.current) URL.revokeObjectURL(sceneUrlRef.current);
    },
    [],
  );

  const userLanguage = profile?.explanationLanguage ?? "en";
  // The host country only supplies a default. The student's own choice wins.
  const localLanguage = profile?.preferredLocalLanguages[0] ?? LOCAL_LANGUAGE_SUGGESTIONS[journey.host]?.[0] ?? "en";
  const level = profile?.level ?? "beginner";

  const aiContext = useMemo(
    () => ({
      journey: { home: journey.home, host: journey.host, city: journey.city, university: journey.university },
      userLanguage,
      coachingLanguage: userLanguage,
      level,
    }),
    [journey, userLanguage, level],
  );

  const permissionDenied = forced === "permission";

  /* ------------------------------- text mode -------------------------------- */

  const runText = useCallback(
    async (value: string) => {
      setFallbackNotice(null);
      const result = await activity.run({ label: "Reading the message and its context" }, async () => {
        const { data } = await callAi("/lens/text", { ...aiContext, text: value, contextKey: "social" }, LensResultSchema);
        return data;
      });
      if (result) {
        setTextResult(result);
        activity.finish();
      }
    },
    [activity, aiContext],
  );

  /* ------------------------------ scene mode -------------------------------- */

  const runScene = useCallback(
    async (file: File, source: "camera" | "upload" | "screenshot") => {
      setFallbackNotice(null);
      setOcrProgress(null);

      const prepared = await activity.run({ label: "Preparing the photo", validatingLabel: "Preparing the photo" }, async () => prepareImage(file));
      if (!prepared) return;

      if (sceneUrlRef.current) URL.revokeObjectURL(sceneUrlRef.current);
      const url = URL.createObjectURL(file);
      sceneUrlRef.current = url;

      /*
       * Tier 0 — on-device OCR.
       *
       * Runs first and is shown immediately, so the photo is useful within a
       * second and stays useful even if every remote provider is unavailable.
       * It also feeds the remote stage, which improves its accuracy.
       */
      const ocr = await runLocalOcr(file, {
        languages: [localLanguage, userLanguage],
        onProgress: (progress) => setOcrProgress(progress),
      });
      setOcrProgress(null);

      const deviceEvidence = evidenceFromLocalOcr(ocr);
      if (deviceEvidence) {
        setScene({
          kind: "evidence",
          evidence: deviceEvidence,
          imageUrl: url,
          note: `Read on this device in ${(ocr.durationMs / 1000).toFixed(1)}s — now working out what it means.`,
        });
      } else if (ocr.unavailable) {
        // Say why rather than failing silently: a student who sees nothing
        // happening cannot tell a slow download from a broken photo.
        setFallbackNotice(`On-device reading is unavailable (${ocr.reason ?? "unknown"}). Continuing with the AI service instead.`);
      }

      /* Tier 1/2 — remote enrichment. */
      const result = await activity.run({ label: "Working out what this means for you" }, async () => {
        const { data } = await callAi(
          "/lens/scene",
          {
            ...aiContext,
            mediaBase64: prepared.base64,
            mimeType: prepared.mimeType,
            localLanguage,
            captureSource: source,
            ...(ocr.fullText ? { deviceOcr: ocr.fullText.slice(0, 6000) } : {}),
            ...(deviceEvidence ? { deviceEvidence } : {}),
          },
          SceneResultSchema,
        );
        return data;
      });

      // Keep the on-device overlay if enrichment failed: a partial answer the
      // student can still tap beats an error screen.
      if (!result) {
        // Only add the generic message when the device had nothing to say.
        // Overwriting the specific on-device reason would hide the useful one.
        if (!deviceEvidence && !ocr.unavailable) setFallbackNotice("Nothing could read this photo right now. Your image was not changed.");
        activity.reset();
        return;
      }

      setScene({ kind: "result", result, imageUrl: url });
      activity.finish();
    },
    [activity, aiContext, localLanguage, userLanguage],
  );

  const captureImage = useCallback(
    async (preferCamera: boolean) => {
      try {
        const captured = await pickImage({ preferCamera: !permissionDenied && preferCamera });
        if (!captured) return;
        await runScene(captured.file, captured.source === "camera" ? "camera" : preferCamera ? "camera" : "screenshot");
      } catch (cause) {
        setFallbackNotice(cause instanceof CaptureError || cause instanceof MediaError ? cause.message : "That photo could not be used. Try another one.");
      }
    },
    [permissionDenied, runScene],
  );

  /* ------------------------------ voice mode -------------------------------- */

  const runAudio = useCallback(
    async (file: File) => {
      setFallbackNotice(null);
      const result = await activity.run({ label: "Listening and transcribing" }, async () => {
        const prepared = await prepareAudio(file);
        const { data } = await callAi(
          "/transcribe",
          { ...aiContext, mediaBase64: prepared.base64, mimeType: prepared.mimeType },
          TranscriptionResultSchema,
        );
        return data;
      });
      if (!result) return;
      setTranscript(result);
      activity.finish();
      await runText(result.transcript);
    },
    [activity, aiContext, runText],
  );

  const beginRecording = useCallback(async () => {
    setFallbackNotice(null);
    try {
      setRecording(await startRecording());
    } catch (cause) {
      setFallbackNotice(cause instanceof CaptureError ? cause.message : "Recording is unavailable. Upload an audio file instead.");
    }
  }, []);

  const endRecording = useCallback(async () => {
    if (!recording) return;
    setRecording(null);
    try {
      const captured = await recording.stop();
      await runAudio(captured.file);
    } catch (cause) {
      setFallbackNotice(cause instanceof CaptureError ? cause.message : "That recording could not be used.");
    }
  }, [recording, runAudio]);

  /* --------------------------------- render -------------------------------- */

  const reset = useCallback(() => {
    setTextResult(null);
    setTranscript(null);
    setFallbackNotice(null);
    clearScene();
    activity.reset();
  }, [activity, clearScene]);

  const busy = activity.isBusy;

  return (
    <div data-tour-screen="lens" className="flex h-full flex-col">
      <div className="px-5 pt-2">
        <h1 className="mb-3 text-[22px] font-extrabold tracking-tight text-ink">YapLens</h1>
        <div data-yep="modes"><Segmented<Mode>
          value={mode}
          onChange={(next) => {
            reset();
            setMode(next);
          }}
          options={(["text", "screenshot", "camera", "voice", "conversation"] as Mode[]).map((value) => ({
            value,
            label: <Icon name={MODE_ICON[value]} size={18} />,
          }))}
        /></div>
      </div>

      {mode === "conversation" ? (
        <div className="min-h-0 flex-1">
          <ConversationBridge
            journey={{ home: journey.home, host: journey.host, city: journey.city, university: journey.university }}
            userLanguage={userLanguage}
            localLanguage={localLanguage}
            level={level}
            voiceEnabled={profile?.voiceEnabled ?? true}
            onPractice={(incident) => nav.push("sim", { fromLens: true, incident })}
          />
        </div>
      ) : (
        <Scroll className="px-5 pb-6 pt-3">
          {busy && (
            <div className="mb-4">
              <AiActivity state={activity.state} onCancel={activity.reset} />
            </div>
          )}

          {activity.state.status === "error" && !busy && (
            <div className="mb-4">
              <Notice tone="error" icon="alert" title="That did not complete" body={activity.state.error?.message ?? "Please try again."} />
            </div>
          )}

          {fallbackNotice && (
            <div className="mb-4">
              <Notice tone="warning" icon="info" title="Another way to do this" body={fallbackNotice} />
            </div>
          )}

          {scene?.kind === "evidence" && <EvidenceOverlay evidence={scene.evidence} imageUrl={scene.imageUrl} note={scene.note} />}
          {scene?.kind === "result" && <SceneOverlay result={scene.result} imageUrl={scene.imageUrl} />}

          {textResult && !scene && (
            <LensTextResult result={textResult} transcript={transcript} onReset={reset} onPractice={(incident) => nav.push("sim", { fromLens: true, incident })} />
          )}

          {!scene && !textResult && !busy && (
            <div data-yep="input">
            {!recording && <YepGuide key={mode} screen="lens" title="Let’s understand it together" pose={mode === "voice" ? "practice" : "think"}>{mode === "text" ? "Paste a message, then interpret it. I’ll help explain likely intent; you choose what to do next." : mode === "voice" ? "Hold to record, or upload audio. Read the interpretation before replying; microphone permission is optional." : "Choose a screenshot or photo. Review what was read and the AI’s confidence before following its suggestions."}</YepGuide>}
            <InputPanel
              mode={mode}
              text={text}
              setText={setText}
              hostName={COUNTRIES[journey.host].name}
              permissionDenied={permissionDenied}
              recording={Boolean(recording)}
              onBeginRecording={beginRecording}
              onEndRecording={endRecording}
              onUploadAudio={async () => {
                const captured = await pickAudio();
                if (captured) await runAudio(captured.file);
              }}
              onCapture={captureImage}
              onRunText={() => runText(text)}
              onUseSample={() => setText(LENS_SAMPLES[journey.host].original)}
            /></div>
          )}

          {ocrProgress !== null && (
            <div className="mb-4">
              <Notice tone="primary" icon="info" title="Reading the photo on this device" body={`Working offline — ${Math.round(ocrProgress * 100)}%. Your photo never leaves the device for this step.`} />
            </div>
          )}

          {!busy && <AiProvenance meta={activity.state.meta} />}
          {scene && (
            <button onClick={reset} className="mt-4 min-h-[44px] text-[13px] font-semibold text-primary">
              ← Scan something else
            </button>
          )}
        </Scroll>
      )}
    </div>
  );
}

function InputPanel({
  mode,
  text,
  setText,
  hostName,
  permissionDenied,
  recording,
  onBeginRecording,
  onEndRecording,
  onUploadAudio,
  onCapture,
  onRunText,
  onUseSample,
}: {
  mode: Mode;
  text: string;
  setText: (value: string) => void;
  hostName: string;
  permissionDenied: boolean;
  recording: boolean;
  onBeginRecording: () => void;
  onEndRecording: () => void;
  onUploadAudio: () => void;
  onCapture: (preferCamera: boolean) => void;
  onRunText: () => void;
  onUseSample: () => void;
}) {
  if (mode === "text") {
    return (
      <>
        <p className="mb-3 text-[13px] text-muted">
          Understand what someone <span className="font-semibold text-ink">really means</span> in {hostName} — with local context.
        </p>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Paste a message, sentence or phrase…"
          className="h-40 w-full resize-none rounded-[12px] border border-line bg-surface p-4 text-[15px] outline-none focus:border-primary"
        />
        <div className="mt-4">
          <Button size="lg" full disabled={!text.trim()} onClick={onRunText}>
            Interpret
          </Button>
          <button className="mt-3 min-h-[44px] w-full text-[13px] font-medium text-primary" onClick={onUseSample}>
            Use sample
          </button>
        </div>
      </>
    );
  }

  if (mode === "voice") {
    return (
      <div className="flex flex-col items-center gap-4 rounded-[12px] border border-line bg-surface p-6">
        <button
          onPointerDown={onBeginRecording}
          onPointerUp={onEndRecording}
          onPointerLeave={() => recording && onEndRecording()}
          aria-label="Hold to record"
          className={`relative flex h-20 w-20 items-center justify-center rounded-full text-white transition ${recording ? "bg-danger" : "bg-ink"}`}
        >
          <div className={`yy-ring absolute inset-0 ${recording ? "" : "motion-reduce:hidden"}`} />
          <Icon name="mic" size={26} />
        </button>
        <span className="text-[13px] font-medium text-muted">{recording ? "Recording — release to transcribe" : "Hold to speak — we'll transcribe and interpret"}</span>
        <button onClick={onUploadAudio} className="min-h-[44px] text-[13px] font-semibold text-primary">
          No microphone? Upload an audio file
        </button>
      </div>
    );
  }

  const isCamera = mode === "camera";
  return (
    <>
      <p className="mb-3 text-[13px] text-muted">
        {isCamera ? "Point at a menu, sign or notice." : "Upload a photo of a menu, sign or notice."} YapYep reads the text and marks up{" "}
        <span className="font-semibold text-ink">your original photo</span> — it never redraws it.
      </p>
      <button
        onClick={() => onCapture(isCamera)}
        className="flex h-56 w-full flex-col items-center justify-center gap-3 rounded-[12px] border-2 border-dashed border-line bg-surface active:scale-[.99]"
      >
        <span className="text-muted">
          <Icon name={isCamera ? "camera" : "image"} size={34} />
        </span>
        <span className="text-[14px] font-semibold text-ink">{isCamera ? "Take a photo" : "Choose a photo"}</span>
        <span className="text-[12px] text-muted">e.g. a stall menu or a campus notice</span>
      </button>
      {isCamera && permissionDenied && (
        <div className="mt-3">
          <Notice tone="warning" icon="camera" title="Camera is blocked in this browser" body="You can still upload a photo from your device — the result is identical." />
        </div>
      )}
      {!isCamera && (
        <button onClick={() => onCapture(true)} className="mt-3 min-h-[44px] w-full text-[13px] font-medium text-primary">
          Or use the camera
        </button>
      )}
    </>
  );
}

function LensTextResult({ result, transcript, onReset, onPractice }: { result: LensResult; transcript: TranscriptionResult | null; onReset: () => void; onPractice: (incident: string) => void }) {
  const { journey, toggleSave, isSaved } = useJourney();
  useContextPanelClaim();
  const panel = useContextPanel();
  const [tone, setTone] = useState<ReplyTone>("Neutral");
  const [toast, setToast] = useState(false);

  const confidence = result.confidence.label === "high" ? 85 : result.confidence.label === "medium" ? 60 : 35;
  const risk = result.misunderstandingRisk === "high" ? 75 : result.misunderstandingRisk === "medium" ? 50 : 25;
  const replies = result.suggestedReplies.map((entry) => ({
    tone: (entry.mode === "very_respectful" ? "Very Respectful" : ((entry.mode[0].toUpperCase() + entry.mode.slice(1)) as ReplyTone)) as ReplyTone,
    text: entry.text,
  }));
  const reply = replies.find((entry) => entry.tone === tone) ?? replies[0];
  const insightId = `insight-${journey.host}-${result.detectedLanguage}-${result.recommendedAction.slice(0, 24)}`;
  const saved = isSaved(insightId);

  const evidence = (
    <div>
      <p className="text-[12px] font-bold text-muted">EVIDENCE & SOURCES</p>
      <div className="mt-2 space-y-1.5">
        {result.sources.map((entry) => (
          <div key={entry.sourceId} className="flex items-center gap-2 text-[13px] text-ink">
            <Badge tone="primary">Tier {entry.authorityLevel}</Badge> {entry.title}
          </div>
        ))}
        {result.sources.length === 0 && <p className="text-[12px] text-muted">No authoritative source was retrieved for this context.</p>}
      </div>
    </div>
  );

  return (
    <div>
      {toast && <Toast text="Saved to your insights" />}
      <button onClick={onReset} className="mb-3 min-h-[44px] text-[13px] font-semibold text-primary">
        ← New scan
      </button>

      <Card className="mb-4 p-4">
        <div className="flex items-center justify-between">
          <Badge tone="muted">YapLens interpretation</Badge>
          <span className="text-[11px] text-muted">{result.detectedLanguage}</span>
        </div>
        <p className="mt-2.5 rounded-[10px] bg-canvas px-3 py-2.5 text-[15px] font-medium text-ink">"{transcript?.transcript ?? "Your submitted message"}"</p>
      </Card>

      <div className="space-y-3">
        <ResultRow label="Literal translation" body={result.literalMeaning} />
        <ResultRow label="Likely intention" body={result.likelyIntents.map((entry) => entry.explanation).join(" ")} accent />
        <ResultRow label="Contextual interpretation" body={result.contextExplanation} />
        <ResultRow label="What they may expect" body={result.expectedNextAction} />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <RiskBadge value={risk} />
        <ConfidenceBadge value={confidence} />
      </div>

      {panel
        ? createPortal(
            <div className="space-y-5">
              {evidence}
              <div>
                <p className="text-[12px] font-bold text-muted">CONFIDENCE</p>
                <div className="mt-2 space-y-1.5 text-[13px]">
                  <div className="flex items-center justify-between">
                    <span className="text-muted">Interpretation</span>
                    <span className="text-ink">{confidence}%</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted">Misunderstanding risk</span>
                    <span className="text-ink">{risk}%</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted">Detected language</span>
                    <span className="text-ink">{result.detectedLanguage}</span>
                  </div>
                </div>
              </div>
            </div>,
            panel,
          )
        : <Card className="mt-4 p-4">{evidence}</Card>}

      <Notice tone="primary" icon="info" title="Recommended action" body={result.recommendedAction} />

      <div className="mt-5">
        <p className="mb-2 text-[15px] font-bold text-ink">Your reply</p>
        <div className="scroll-area mb-3 flex gap-2 overflow-x-auto">
          {(["Casual", "Neutral", "Academic", "Very Respectful"] as ReplyTone[]).map((entry) => (
            <button
              key={entry}
              onClick={() => setTone(entry)}
              className={`min-h-[44px] shrink-0 rounded-full border px-3.5 py-2 text-[13px] font-semibold transition ${tone === entry ? "border-ink bg-ink text-white" : "border-line bg-surface text-muted"}`}
            >
              {entry}
            </button>
          ))}
        </div>
        <Card className="p-4">
          <p className="text-[14px] leading-relaxed text-ink">{reply.text}</p>
        </Card>
      </div>

      <div className="mt-5 flex gap-2">
        <Button
          variant="soft"
          full
          onClick={() => {
            toggleSave({ id: insightId, kind: "insight", title: "YapLens interpretation", subtitle: `"${transcript?.transcript ?? result.literalMeaning.slice(0, 40)}"`, icon: "insight" });
            if (!saved) {
              setToast(true);
              setTimeout(() => setToast(false), 1600);
            }
          }}
        >
          {saved ? "Saved ✓" : "Save insight"}
        </Button>
        <Button variant="primary" full onClick={() => onPractice(result.expectedNextAction)}>
          <Icon name="practice" size={17} /> Practice this
        </Button>
      </div>
    </div>
  );
}

function ResultRow({ label, body, accent }: { label: string; body: string; accent?: boolean }) {
  return (
    <div className={`rounded-[12px] border px-4 py-3 ${accent ? "border-primary/20 bg-primary-soft" : "border-line bg-surface"}`}>
      <p className={`text-[11px] font-bold uppercase tracking-wide ${accent ? "text-primary" : "text-muted"}`}>{label}</p>
      <p className="mt-1 text-[14px] leading-relaxed text-ink">{body}</p>
    </div>
  );
}
