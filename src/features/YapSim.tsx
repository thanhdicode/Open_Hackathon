import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useJourney } from "../context/JourneyContext";
import { ScreenHeader, Scroll } from "../components/shell";
import { Card, Button, Badge, ScoreBarRow, Notice } from "../components/ui";
import { Icon } from "../components/icons";
import { AiActivity, AiProvenance } from "../components/ai-activity";
import YepGuide from "../components/yep-guide";
import Mascot from "../components/mascot";
import { useAiActivity } from "../lib/ai/activity";
import { callAi } from "../lib/ai-contracts/client";
import { SIM_SCORE_DIMENSIONS, SimFeedbackSchema, SimScenarioSchema, SimTurnSchema, averageScore, type SimFeedback, type SimScenario } from "../lib/ai-contracts/sim";
import { TranscriptionResultSchema } from "../lib/ai-contracts/transcription";
import type { ScenarioDomain } from "../lib/ai-contracts/common";
import { fetchPracticeAttempts, savePracticeAttempt, updateSkillProfile, type PracticeAttempt } from "../lib/appwrite/practice";
import { prepareAudio } from "../lib/media";
import { LOCAL_LANGUAGE_SUGGESTIONS, loadPreferences, needsRomanization, type AiLanguageProfile } from "../lib/preferences";
import { startRecording, type ActiveRecording } from "./lens/capture";

/**
 * YapSim — a real practice simulator.
 *
 * There is no seeded transcript, no timer and no pre-baked score. Every turn is
 * a live model call, the feedback is derived from the transcript that actually
 * happened, and the attempt is persisted so a reload can prove it.
 */

type Phase = "setup" | "convo" | "feedback";

interface Turn {
  speaker: "persona" | "user";
  text: string;
  translation?: string;
  romanization?: string;
  hint?: string;
}

const DOMAINS: { value: ScenarioDomain; label: string }[] = [
  { value: "food", label: "Food" },
  { value: "transport", label: "Transport" },
  { value: "campus", label: "Campus" },
  { value: "professor", label: "Professor" },
  { value: "housing", label: "Housing" },
  { value: "health", label: "Health" },
  { value: "banking", label: "Banking" },
  { value: "police", label: "Police" },
];

/**
 * Context handed over from a Greenbook entry's "Practice this".
 *
 * The Greenbook knows which chapter the student is reading and which official
 * requirement prompted the practice, so the scenario can be aimed at that
 * instead of at a generic domain. Optional and additive — YapSim behaves exactly
 * as before when it is absent.
 */
export interface GreenbookPracticeContext {
  countryCode: string;
  chapterId: string;
  entryTitle: string;
  focus?: string;
  domain?: ScenarioDomain;
  hostLanguage?: string;
}

export default function YapSim({
  onBack,
  fromLens,
  incident,
  greenbook,
}: {
  onBack: () => void;
  fromLens?: boolean;
  incident?: string;
  greenbook?: GreenbookPracticeContext;
}) {
  const { journey } = useJourney();
  const [phase, setPhase] = useState<Phase>("setup");
  const [domain, setDomain] = useState<ScenarioDomain>(greenbook?.domain ?? "food");
  const [goal, setGoal] = useState("");
  const [scenario, setScenario] = useState<SimScenario | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [attemptNumber, setAttemptNumber] = useState(1);
  const [feedback, setFeedback] = useState<SimFeedback | null>(null);
  const [previous, setPrevious] = useState<PracticeAttempt | null>(null);
  const [attempts, setAttempts] = useState<PracticeAttempt[]>([]);
  const [persistNote, setPersistNote] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [userText, setUserText] = useState("");
  const [recording, setRecording] = useState<ActiveRecording | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [profile, setProfile] = useState<AiLanguageProfile | null>(null);
  const activity = useAiActivity();
  const startedAt = useRef<number>(Date.now());

  useEffect(() => {
    let cancelled = false;
    loadPreferences().then((preferences) => {
      if (!cancelled) setProfile(preferences.aiLanguage);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const userLanguage = profile?.explanationLanguage ?? "en";
  const targetLanguage = profile?.preferredLocalLanguages[0] ?? LOCAL_LANGUAGE_SUGGESTIONS[journey.host]?.[0] ?? "en";
  const level = profile?.level ?? "beginner";
  const showRomanization = profile?.showRomanization ?? "always";
  const beginner = level === "beginner";

  const context = useMemo(
    () => ({
      journey: { home: journey.home, host: journey.host, city: journey.city, university: journey.university },
      userLanguage,
      coachingLanguage: userLanguage,
      level,
    }),
    [journey, userLanguage, level],
  );

  const transcriptText = useCallback(
    () => turns.map((turn) => `${turn.speaker === "persona" ? "PERSONA" : "USER"}: ${turn.text}`).join("\n"),
    [turns],
  );

  /* ------------------------------- start ----------------------------------- */

  const start = useCallback(async () => {
    setNotice(null);
    setPersistNote(null);
    const generated = await activity.run({ label: `Setting up a ${domain.replace(/_/g, " ")} situation` }, async () => {
      const { data } = await callAi(
        "/sim/start",
        {
          ...context,
          targetLanguage,
          domain,
          ...(goal.trim() ? { goal: goal.trim() } : {}),
          ...(incident ? { incident } : {}),
          // The chapter and the requirement it came from, so the persona is set
          // up for the situation the student was just reading about.
          ...(greenbook
            ? {
                greenbook: {
                  countryCode: greenbook.countryCode,
                  chapterId: greenbook.chapterId,
                  entryTitle: greenbook.entryTitle,
                  focus: greenbook.focus ?? "",
                  hostLanguage: greenbook.hostLanguage ?? targetLanguage,
                },
              }
            : {}),
        },
        SimScenarioSchema,
      );
      return data;
    });
    if (!generated) return;

    setScenario(generated);
    setTurns([{ speaker: "persona", text: generated.openingLine.text, translation: generated.openingLine.translation, romanization: generated.openingLine.romanization }]);
    setFeedback(null);
    setRevealed(new Set());
    startedAt.current = Date.now();
    setPhase("convo");
    activity.finish();

    // Surface any previous attempts so a retry has something real to compare to.
    const history = await fetchPracticeAttempts(generated.title);
    setAttempts(history);
    setPrevious(history[history.length - 1] ?? null);
  }, [activity, context, domain, goal, incident, targetLanguage, greenbook]);

  /* ------------------------------- finish ---------------------------------- */

  const finish = useCallback(
    async (finalTurns: Turn[], currentScenario: SimScenario) => {
      const transcript = finalTurns.map((turn) => `${turn.speaker === "persona" ? "PERSONA" : "USER"}: ${turn.text}`).join("\n");
      const durationSeconds = Math.round((Date.now() - startedAt.current) / 1000);

      const result = await activity.run({ label: "Reviewing your turns" }, async () => {
        const { data } = await callAi(
          "/sim/finish",
          {
            ...context,
            scenario: currentScenario,
            transcript,
            isRetry: attemptNumber > 1,
            ...(previous?.feedback ? { previousFeedback: previous.feedback.priorityFeedback } : {}),
          },
          SimFeedbackSchema,
        );
        return data;
      });
      if (!result) return;

      setFeedback(result);
      setPhase("feedback");
      activity.finish();

      const saved = await savePracticeAttempt({
        scenarioId: currentScenario.title,
        attemptNumber,
        transcriptSummary: transcript,
        feedback: result,
        durationSeconds,
      });
      const skillSaved = await updateSkillProfile(result.scores);
      setPersistNote(
        saved && skillSaved
          ? `Attempt ${attemptNumber} saved to your practice history.`
          : "This attempt is shown here but could not be saved to your account yet.",
      );
      if (saved) setAttempts((list) => [...list, saved]);
    },
    [activity, attemptNumber, context, previous],
  );

  /* -------------------------------- turn ----------------------------------- */

  const advance = useCallback(
    async (nextTurns: Turn[], currentScenario: SimScenario) => {
      const transcript = nextTurns.map((turn) => `${turn.speaker === "persona" ? "PERSONA" : "USER"}: ${turn.text}`).join("\n");
      const userTurnCount = nextTurns.filter((turn) => turn.speaker === "user").length;

      const reaction = await activity.run({ label: `${currentScenario.persona.name} is responding` }, async () => {
        const { data } = await callAi(
          "/sim/turn",
          { ...context, scenario: currentScenario, transcript, turnIndex: userTurnCount },
          SimTurnSchema,
        );
        return data;
      });
      if (!reaction) return;

      const withReply: Turn[] = [
        ...nextTurns,
        { speaker: "persona", text: reaction.personaReply.text, translation: reaction.personaReply.translation, romanization: reaction.personaReply.romanization, hint: reaction.hint },
      ];
      setTurns(withReply);

      const reachedLimit = userTurnCount >= currentScenario.maxTurns;
      if (reaction.shouldEnd || reachedLimit || reaction.goalProgress === "complete") {
        await finish(withReply, currentScenario);
      } else {
        activity.finish();
      }
    },
    [activity, context, finish],
  );

  const sendUserTurn = useCallback(
    async (text: string) => {
      if (!scenario || !text.trim()) return;
      setNotice(null);
      const nextTurns: Turn[] = [...turns, { speaker: "user", text: text.trim() }];
      setTurns(nextTurns);
      setUserText("");
      await advance(nextTurns, scenario);
    },
    [advance, scenario, turns],
  );

  const handleAudio = useCallback(
    async (file: File) => {
      setNotice(null);
      const transcript = await activity.run({ label: "Transcribing what you said" }, async () => {
        const prepared = await prepareAudio(file);
        const { data } = await callAi("/transcribe", { ...context, mediaBase64: prepared.base64, mimeType: prepared.mimeType }, TranscriptionResultSchema);
        return data;
      });
      if (!transcript) return;
      await sendUserTurn(transcript.transcript);
    },
    [activity, context, sendUserTurn],
  );

  /* ------------------------------- recording ------------------------------- */

  const beginRecording = useCallback(async () => {
    setNotice(null);
    try {
      setRecording(await startRecording());
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Recording is unavailable. Type your reply instead.");
    }
  }, []);

  const endRecording = useCallback(async () => {
    if (!recording) return;
    setRecording(null);
    try {
      const captured = await recording.stop();
      await handleAudio(captured.file);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "That recording could not be used.");
    }
  }, [handleAudio, recording]);

  const busy = activity.isBusy;

  /* -------------------------------- setup ---------------------------------- */

  if (phase === "setup")
    return (
      <div className="flex h-full flex-col bg-canvas">
        <ScreenHeader title="YapSim · Practice" onBack={onBack} />
        <Scroll tourScreen="sim" className="px-5 py-4">
          <YepGuide screen="sim" title="Practise with Yep" pose="practice">Pick a situation and an optional goal. AI will play the conversation partner; we’ll review what you can try next.</YepGuide>
          {fromLens && <div className="mb-4"><Notice tone="primary" icon="lens" title="From your Lens result" body="This practice is built from the situation you just scanned." /></div>}
          {greenbook && (
            <div className="mb-4">
              <Notice
                tone="primary"
                icon="text"
                title={`From your Greenbook · ${greenbook.entryTitle}`}
                body={
                  greenbook.focus
                    ? `Practising the ${greenbook.chapterId.replace(/_/g, " ")} chapter for ${greenbook.countryCode}: ${greenbook.focus}`
                    : `Practising the ${greenbook.chapterId.replace(/_/g, " ")} chapter for ${greenbook.countryCode}.`
                }
              />
            </div>
          )}

          <Badge tone="muted">AI roleplay · real turns</Badge>
          <h1 className="mt-2 text-[22px] font-extrabold tracking-tight text-ink">Practise a real situation</h1>
          <p className="mt-1.5 text-[14px] leading-relaxed text-muted">
            {scenario?.persona.name ?? "A local person"} will speak {targetLanguage}. Your coaching stays in {userLanguage}. Every turn is generated live — nothing is scripted.
          </p>

          {activity.state.status === "error" && (
            <div className="mt-4">
              <Notice tone="error" icon="alert" title="Could not set up the practice" body={activity.state.error?.message ?? "Try again."} />
            </div>
          )}

          <div className="mt-5">
            <p data-yep="situation" className="mb-2 text-[13px] font-bold text-ink">Situation</p>
            <div className="flex flex-wrap gap-2">
              {DOMAINS.map((entry) => (
                <button
                  key={entry.value}
                  onClick={() => setDomain(entry.value)}
                  aria-pressed={domain === entry.value}
                  className={`min-h-[44px] rounded-full border px-3.5 py-2 text-[13px] font-semibold transition ${
                    domain === entry.value ? "border-ink bg-ink text-white" : "border-line bg-surface text-muted"
                  }`}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-5">
            <label className="text-[13px] font-bold text-ink" htmlFor="sim-goal">
              What do you want to achieve? (optional)
            </label>
            <textarea
              id="sim-goal"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="e.g. order two packs of nasi lemak, one not spicy"
              className="mt-1.5 h-20 w-full resize-none rounded-[12px] border border-line bg-surface p-3 text-[14px] outline-none focus:border-primary"
            />
          </div>

          {previous && (
            <div className="mt-4">
              <Notice
                tone="primary"
                icon="info"
                title={`You have practised this before (${attempts.length} attempt${attempts.length === 1 ? "" : "s"})`}
                body={`Last time the priority was: ${previous.feedback?.priorityFeedback ?? "not recorded"}`}
              />
            </div>
          )}

          <div data-yep="start" className="mt-6">
            <Button size="lg" full disabled={busy} onClick={start}>
              {busy ? "Setting up…" : "Start roleplay"}
            </Button>
          </div>
          <AiProvenance meta={activity.state.meta} />
        </Scroll>
      </div>
    );

  /* -------------------------------- convo ---------------------------------- */

  if (phase === "convo" && scenario)
    return (
      <div className="flex h-full flex-col bg-canvas">
        <ScreenHeader
          title={scenario.persona.name}
          onBack={onBack}
          right={
            <Badge tone="error">
              ● Live · turn {turns.filter((turn) => turn.speaker === "user").length}/{scenario.maxTurns}
            </Badge>
          }
        />
        <Scroll className="px-5 py-4">
          <Card className="mb-3 p-3">
            <p className="text-[12px] font-bold uppercase tracking-wide text-muted">Your goal</p>
            <p className="mt-1 text-[13px] leading-relaxed text-ink">{scenario.goal}</p>
          </Card>

          <div className="space-y-3">
            {turns.map((turn, index) => {
              const isUser = turn.speaker === "user";
              const showTranslation = beginner || revealed.has(index);
              const romanize = showRomanization === "always" || (showRomanization === "when_needed" && needsRomanization(targetLanguage));
              return (
                <div key={`${index}-${turn.text.slice(0, 12)}`} className={`yy-fade flex ${isUser ? "justify-end" : "justify-start"}`}>
                  <div className="max-w-[85%]">
                    <div className={`rounded-[12px] px-3.5 py-2.5 ${isUser ? "bg-ink text-white" : "border border-line bg-surface"}`}>
                      <p className={`text-[14px] leading-relaxed ${isUser ? "text-white" : "text-ink"}`}>{turn.text}</p>
                      {!isUser && romanize && turn.romanization && <p className="mt-1 text-[12px] italic text-muted">{turn.romanization}</p>}
                      {!isUser && showTranslation && turn.translation && (
                        <p className="mt-1.5 border-t border-line pt-1.5 text-[13px] leading-relaxed text-muted">{turn.translation}</p>
                      )}
                    </div>
                    {!isUser && !showTranslation && turn.translation && (
                      <button onClick={() => setRevealed((set) => new Set(set).add(index))} className="mt-1 min-h-[44px] text-[12px] font-semibold text-primary">
                        Show translation
                      </button>
                    )}
                    {!isUser && turn.hint && <p className="mt-1 px-1 text-[11px] italic text-muted">Hint: {turn.hint}</p>}
                  </div>
                </div>
              );
            })}
          </div>

          {activity.state.status === "error" && (
            <div className="mt-4">
              <Notice tone="error" icon="alert" title="That turn did not complete" body={activity.state.error?.message ?? "Try again."} />
            </div>
          )}
          {notice && (
            <div className="mt-4">
              <Notice tone="warning" icon="info" title="Another way to reply" body={notice} />
            </div>
          )}
        </Scroll>

        <div className="border-t border-line bg-surface px-5 py-4">
          <AiActivity state={activity.state} onCancel={activity.reset} />
          {!busy && (
            <>
              <div className="flex items-center gap-3">
                <button
                  onPointerDown={beginRecording}
                  onPointerUp={endRecording}
                  onPointerLeave={() => recording && endRecording()}
                  aria-label="Hold to speak your reply"
                  className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-white transition ${recording ? "bg-danger" : "bg-ink"}`}
                >
                  <Icon name="mic" size={22} />
                </button>
                <input
                  value={userText}
                  onChange={(event) => setUserText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void sendUserTurn(userText);
                  }}
                  placeholder={`Reply in ${userLanguage} or ${targetLanguage}…`}
                  className="h-11 min-w-0 flex-1 rounded-[12px] border border-line bg-surface px-3 text-[14px] outline-none focus:border-primary"
                />
                <Button onClick={() => sendUserTurn(userText)} disabled={!userText.trim()}>
                  Send
                </Button>
              </div>
              <button onClick={() => scenario && finish(turns, scenario)} className="mt-2 min-h-[44px] text-[12px] font-semibold text-muted">
                End and see feedback
              </button>
            </>
          )}
        </div>
      </div>
    );

  /* ------------------------------- feedback -------------------------------- */

  if (!feedback || !scenario) return null;

  const overall = averageScore(feedback.scores);
  const previousOverall = previous?.scores ? averageScore(previous.scores) : null;

  return (
    <div className="flex h-full flex-col bg-canvas">
      <ScreenHeader title="Your feedback" onBack={onBack} />
      <Scroll className="px-5 py-4">
        <div className="mb-3 flex items-center gap-2"><Mascot pose="celebrate" size={64} /><p className="text-[13px] text-muted">You gave it a try. Let’s find one thing to practise next.</p></div>
        <Card className="mb-4 flex items-center justify-between p-4">
          <div>
            <p className="text-[13px] text-muted">Attempt {attemptNumber} score</p>
            <p className="text-[30px] font-extrabold text-ink">{overall}</p>
          </div>
          {previousOverall !== null && (
            <div className="text-right">
              <p className="text-[12px] text-muted">Attempt {attemptNumber - 1}</p>
              <p className="text-[18px] font-extrabold text-ink">{previousOverall}</p>
              <p className="text-[11px] text-muted">A retry is a fresh attempt — it can go either way.</p>
            </div>
          )}
        </Card>

        {persistNote && (
          <div className="mb-4">
            <Notice tone={persistNote.includes("saved") ? "primary" : "warning"} icon="info" title="Practice history" body={persistNote} />
          </div>
        )}

        <p className="mb-2 text-[13px] font-bold text-ink">Score dimensions</p>
        <Card className="mb-4 space-y-3 p-4">
          {SIM_SCORE_DIMENSIONS.map((dimension) => (
            <ScoreBarRow
              key={dimension.key}
              label={dimension.label}
              value={feedback.scores[dimension.key]}
              delta={previous?.scores ? feedback.scores[dimension.key] - previous.scores[dimension.key] : undefined}
            />
          ))}
        </Card>

        <p className="mb-2 text-[13px] font-bold text-ink">Priority for next time</p>
        <Card className="mb-4 p-4">
          <p className="text-[14px] leading-relaxed text-ink">{feedback.priorityFeedback}</p>
        </Card>

        {feedback.strengths.length > 0 && (
          <>
            <p className="mb-2 text-[13px] font-bold text-ink">What worked</p>
            <Card className="mb-4 space-y-2 p-4">
              {feedback.strengths.map((item) => (
                <div key={item} className="flex items-start gap-2 text-[13px] leading-relaxed text-ink">
                  <span className="text-success">✓</span> {item}
                </div>
              ))}
            </Card>
          </>
        )}

        {feedback.examples && feedback.examples.length > 0 && (
          <>
            <p className="mb-2 text-[13px] font-bold text-ink">From your own words</p>
            <Card className="mb-4 space-y-3 p-4">
              {feedback.examples.map((example) => (
                <div key={example.userText}>
                  <p className="rounded-[10px] bg-canvas px-3 py-2 text-[13px] text-ink">"{example.userText}"</p>
                  <p className="mt-1 text-[12px] leading-relaxed text-muted">{example.feedback}</p>
                </div>
              ))}
            </Card>
          </>
        )}

        <Notice tone="primary" icon="info" title="Retry goal" body={feedback.retryGoal} />

        <div className="mt-6 space-y-2">
          <Button
            size="lg"
            full
            onClick={() => {
              setAttemptNumber((value) => value + 1);
              setPrevious({ id: "previous", scenarioId: scenario.title, attemptNumber, transcriptSummary: "", scores: feedback.scores, feedback, durationSeconds: null, completedAt: new Date().toISOString() });
              setFeedback(null);
              setTurns([{ speaker: "persona", text: scenario.openingLine.text, translation: scenario.openingLine.translation, romanization: scenario.openingLine.romanization }]);
              setRevealed(new Set());
              startedAt.current = Date.now();
              setPhase("convo");
            }}
          >
            Retry this situation
          </Button>
          <Button variant="soft" size="lg" full onClick={onBack}>
            Finish
          </Button>
        </div>
        <AiProvenance meta={activity.state.meta} />
      </Scroll>
    </div>
  );
}
