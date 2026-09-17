import { useState } from "react";
import { ASSESSMENT, deriveMyDna } from "../data/assessment";
import { DNA_DIMENSIONS } from "../data/dna";
import { useAccount } from "../context/AccountContext";
import { useJourney } from "../context/JourneyContext";
import { saveJourney } from "../lib/appwrite/journeyPersistence";
import { ScreenHeader, Scroll } from "../components/shell";
import { Button, DnaBar, Notice } from "../components/ui";

/** The existing MyDNA questions are optional after first value, not discarded. */
export default function MyDnaAssessment({ onBack }: { onBack: () => void }) {
  const { account } = useAccount();
  const { journey, hydrate, savedTasks } = useJourney();
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [index, setIndex] = useState(0);
  const [review, setReview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const question = ASSESSMENT[index];
  const scores = deriveMyDna(answers);
  async function save() {
    if (!account) { setError("Reconnect to save your preferences."); return; }
    setSaving(true); setError("");
    const next = { ...journey, myDna: scores, myDnaAssessed: true };
    if (await saveJourney(account.userId, next)) { hydrate(account.userId, next, savedTasks); onBack(); }
    else { setError("Your preferences couldn’t be saved. Your answers are kept — please try again."); setSaving(false); }
  }
  return <div className="flex h-full flex-col bg-canvas"><ScreenHeader title="MyDNA · Your communication preferences" onBack={onBack} /><Scroll className="px-5 py-4">
    <p className="mb-4 text-[13px] leading-relaxed text-muted">These are your preferences, not a nationality label. You can change them later.</p>
    {review ? <><div className="space-y-4">{DNA_DIMENSIONS.map((dimension) => <DnaBar key={dimension.key} label={dimension.label} value={scores[dimension.key]} />)}</div><div className="mt-5"><Button size="lg" full disabled={saving} onClick={save}>{saving ? "Saving…" : "Save my preferences"}</Button></div><button disabled={saving} onClick={() => setReview(false)} className="mt-2 min-h-[44px] text-[13px] text-primary">Review my last answer</button></> : <><p className="text-[12px] text-muted">Question {index + 1} / {ASSESSMENT.length}</p><h2 className="my-3 text-[20px] font-bold leading-snug">{question.prompt}</h2><div className="space-y-2">{question.options.map((option, choice) => <button key={choice} onClick={() => { setAnswers((current) => ({ ...current, [question.id]: choice })); if (index + 1 < ASSESSMENT.length) setIndex(index + 1); else setReview(true); }} className="min-h-[48px] w-full rounded-[12px] border border-line bg-surface px-4 py-3 text-left text-[14px]">{option.label}</button>)}</div>{index > 0 && <button onClick={() => setIndex(index - 1)} className="mt-3 min-h-[44px] text-[13px] text-primary">Previous question</button>}</>}
    {error && <div className="mt-3"><Notice tone="error" icon="alert" title="Could not save" body={error} /></div>}
  </Scroll></div>;
}
