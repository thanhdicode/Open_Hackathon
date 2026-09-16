import { useMemo, useState } from "react";
import { COUNTRY_LIST, COUNTRIES, type CountryCode } from "../data/countries";
import { ASSESSMENT, deriveMyDna } from "../data/assessment";
import { DNA_DIMENSIONS } from "../data/dna";
import { computePairDNA } from "../data/pairDNA";
import { Button, Card, Chip, DnaBar, CultureGapMeter, ProgressRing, Notice } from "../components/ui";
import { Icon } from "../components/icons";
import {
  EMPTY_JOURNEY_DATES,
  type JourneyDates,
  deriveStage,
  exchangeLengthDays,
  stageLabel,
  timelineProblems,
} from "../lib/journey/dates";
import { SaveJourneyCard } from "./Settings";
import { completeEmailUpgrade, friendlyAuthError, requestEmailUpgradeCode, startGoogleUpgrade } from "../lib/appwrite/auth";
import { account } from "../lib/appwrite/client";

type Step =
  | "welcome"
  | "signin"
  | "home"
  | "host"
  | "place"
  | "dates"
  | "languages"
  | "goals"
  | "interests"
  | "assess"
  | "mydna"
  | "gap"
  | "generate"
  | "save";

const GOALS = ["Speak with confidence", "Understand the culture", "Do well academically", "Make local friends", "Settle in smoothly"];
const INTERESTS = ["AI", "Coffee", "Football", "Photography", "K-pop", "Startups", "Film", "Fashion", "Food", "Travel", "Gaming", "Music"];
const LANG_LEVELS = ["A1", "A2", "B1", "B2", "C1", "Native"];

const DAY_MS = 86_400_000;

/** A `YYYY-MM-DD` day, `offset` days from today, in UTC. */
function dayFromToday(offset: number): string {
  const now = new Date();
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(base + offset * DAY_MS).toISOString().slice(0, 10);
}

/**
 * A suggested semester, not a silent default.
 *
 * The dates step used to render a hardcoded "Aug 2026 / Dec 2026" card that
 * collected nothing and wrote nothing, so every student was stored as
 * `exchange_stage: "studying"` regardless of their real timeline. This is a real
 * starting point the student can edit, and the stage it implies is shown live
 * underneath so the suggestion is never mistaken for a decision.
 */
function suggestedTimeline(): JourneyDates {
  return {
    ...EMPTY_JOURNEY_DATES,
    departureDate: dayFromToday(28),
    arrivalDate: dayFromToday(30),
    programStartDate: dayFromToday(35),
    programEndDate: dayFromToday(148),
    returnDate: dayFromToday(157),
  };
}

/** A labelled native date input, so the value is a plain calendar day. */
function DateField({ label, value, onChange, required = false }: { label: string; value: string | null; onChange: (value: string | null) => void; required?: boolean }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[13px] font-medium text-ink">
        {label}
        {required && <span className="ml-1 text-muted">required</span>}
      </span>
      <input
        type="date"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
        className="w-full rounded-[14px] border border-line bg-surface px-4 py-3 text-[15px] text-ink outline-none focus:border-primary"
      />
    </label>
  );
}

export default function Onboarding({ onComplete, onStart }: { onComplete: (data: { home: CountryCode; host: CountryCode; city: string; university: string; dates: JourneyDates; myDna: ReturnType<typeof deriveMyDna> }) => void; onStart: () => Promise<{ ok: boolean; message?: string }> }) {
  const [step, setStep] = useState<Step>("welcome");
  const [home, setHome] = useState<CountryCode | null>(null);
  const [host, setHost] = useState<CountryCode | null>(null);
  const [city, setCity] = useState("");
  const [university, setUniversity] = useState("");
  const [goals, setGoals] = useState<string[]>([]);
  const [interests, setInterests] = useState<string[]>([]);
  const [langLevel, setLangLevel] = useState("B1");
  /**
   * The canonical timeline.
   *
   * Seeded with a suggested semester rather than left blank, because an empty
   * required field cannot be stepped past and a student would have to invent
   * dates before they know them. The suggestion is derived from today and the
   * resulting stage is shown live underneath, so the student sees exactly what
   * the dates mean — and can change either one.
   */
  const [dates, setDates] = useState<JourneyDates>(() => suggestedTimeline());
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [qIdx, setQIdx] = useState(0);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [otpUserId, setOtpUserId] = useState<string | null>(null);
  const [otpCooldown, setOtpCooldown] = useState(0);

  const myDna = useMemo(() => deriveMyDna(answers), [answers]);
  const pair = useMemo(() => (home && host ? computePairDNA(home, host, myDna) : null), [home, host, myDna]);

  /**
   * The date rules, the derived stage and the length all come from the same
   * module the rest of the app reads. The form does not re-implement validation:
   * it renders whatever `timelineProblems` reports, so the form and the
   * persistence layer cannot disagree about what a valid timeline is.
   */
  const problems = useMemo(() => timelineProblems(dates), [dates]);
  const stage = useMemo(() => deriveStage(dates), [dates]);
  const lengthDays = useMemo(() => exchangeLengthDays(dates), [dates]);

  const toggle = (arr: string[], set: (v: string[]) => void, v: string) =>
    set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  function finish() {
    if (home && host) onComplete({ home, host, city: city || COUNTRIES[host].name, university: university || "Host University", dates, myDna });
  }

  async function startGuestJourney() {
    setStartError(null);
    setStarting(true);
    const result = await onStart();
    setStarting(false);
    if (result.ok) setStep("home");
    else setStartError(result.message ?? "We could not start your secure session. Please try again.");
  }

  async function sendOtp() {
    setStartError(null);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email.trim())) return setStartError("Enter a valid email address.");
    setStarting(true);
    try {
      const ticket = await requestEmailUpgradeCode((await account.get()).$id, email);
      setOtpUserId(ticket.userId); setOtpCooldown(30); setStep("signin");
      const timer = window.setInterval(() => setOtpCooldown((value) => { if (value <= 1) { window.clearInterval(timer); return 0; } return value - 1; }), 1000);
    } catch (cause) { setStartError(friendlyAuthError(cause)); } finally { setStarting(false); }
  }

  async function verifyOtp() {
    if (!otpUserId || otp.length !== 6) return;
    setStarting(true); setStartError(null);
    try { await completeEmailUpgrade(otpUserId, otp); setStep("home"); }
    catch (cause) { setStartError(friendlyAuthError(cause)); } finally { setStarting(false); }
  }

  /* --------------------------------- Welcome -------------------------------- */
  if (step === "welcome")
    return (
      <div data-testid="onboarding" className="flex h-full flex-col bg-ink px-7 pb-9 pt-16 text-white">
        <div className="mx-auto flex w-full max-w-[560px] flex-1 flex-col justify-center">
          <div className="mb-5 inline-flex w-fit items-center gap-2 rounded-full bg-white/15 px-3 py-1.5 text-[12px] font-semibold">
            <Icon name="globe" size={14} /> 11 ASEAN countries · 110 journeys
          </div>
          <h1 className="text-[34px] font-extrabold leading-[1.1] tracking-tight text-white/70">
            Understand the culture.<br />Speak with confidence.<br /><span className="text-white">Live like a local.</span>
          </h1>
          <p className="mt-4 max-w-[300px] text-[15px] leading-relaxed text-white/80">
            YapYep helps exchange students adapt to any ASEAN country — personalized to who you are and where you're going.
          </p>
        </div>
        <div className="mx-auto w-full max-w-[560px] space-y-3">
          {startError && <p role="alert" className="rounded-card bg-white/15 px-4 py-3 text-center text-[13px] leading-relaxed text-white">{startError}</p>}
          <Button variant="inverse" size="lg" full disabled={starting} onClick={startGuestJourney}>{starting ? "Starting securely…" : "Try YapYep"}</Button>
          <button className="min-h-[44px] w-full text-center text-[13px] font-semibold text-white/85" onClick={() => setStep("signin")}>Sign in or save an existing journey</button>
          <p className="text-center text-[12px] leading-relaxed text-white/75">Start securely as a guest. You can create an account to save your progress later.</p>
        </div>
      </div>
    );

  /* --------------------------------- Sign in -------------------------------- */
  if (step === "signin")
    return (
      <OnbFrame title="Sign in" onBack={() => setStep("welcome")} progress={5}>
        <div className="space-y-3">
          {startError && <Notice tone="error" icon="close" title="Sign-in problem" body={startError} />}
          <Button variant="outline" size="lg" full disabled={starting} onClick={async () => { try { await startGoogleUpgrade(); } catch (cause) { setStartError(friendlyAuthError(cause)); } }}>
            Continue with Google
          </Button>
          <input className="w-full rounded-[12px] border border-line bg-surface px-3.5 py-3 text-[15px] text-ink" type="email" inputMode="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@gmail.com" />
          {otpUserId ? <>
            <input className="w-full rounded-[12px] border border-line bg-surface px-3.5 py-3 text-center font-mono text-[20px] tracking-[0.35em] text-ink" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="000000" />
            <Button size="lg" full disabled={starting || otp.length !== 6} onClick={verifyOtp}>{starting ? "Checking…" : "Confirm code"}</Button>
          </> : <Button size="lg" full disabled={starting} onClick={sendOtp}>{starting ? "Sending…" : "Send email code"}</Button>}
          {otpUserId && <button className="min-h-[44px] w-full text-[13px] font-semibold text-primary disabled:text-muted" disabled={otpCooldown > 0 || starting} onClick={sendOtp}>{otpCooldown > 0 ? `Resend in ${otpCooldown}s` : "Resend code"}</button>}
        </div>
        <p className="mt-5 text-center text-[12px] leading-relaxed text-muted">
          Your answers shape your experience. We never assume your culture from your nationality.
        </p>
      </OnbFrame>
    );

  /* -------------------------- ASEAN Compass: home --------------------------- */
  if (step === "home")
    return (
      <OnbFrame title="Where are you from?" subtitle="Your home country" onBack={() => setStep("signin")} progress={15}>
        <CountryGrid selected={home} onSelect={setHome} />
        <StickyNext disabled={!home} onNext={() => setStep("host")} />
      </OnbFrame>
    );

  /* -------------------------- ASEAN Compass: host --------------------------- */
  if (step === "host")
    return (
      <OnbFrame title="Where are you going?" subtitle="Your host country" onBack={() => setStep("home")} progress={22}>
        {home && (
          <div className="mb-4 flex items-center justify-center gap-2 rounded-[12px] bg-primary-soft py-3 text-[14px] font-semibold text-primary">
            {COUNTRIES[home].flag} {COUNTRIES[home].name} <span className="text-muted">→</span> {host ? `${COUNTRIES[host].flag} ${COUNTRIES[host].name}` : "…"}
          </div>
        )}
        <CountryGrid selected={host} onSelect={setHost} disabled={home ?? undefined} />
        <StickyNext disabled={!host} onNext={() => setStep("place")} />
      </OnbFrame>
    );

  /* ------------------------------ City / uni -------------------------------- */
  if (step === "place")
    return (
      <OnbFrame title="Your host university" subtitle={host ? `In ${COUNTRIES[host].name}` : ""} onBack={() => setStep("host")} progress={30}>
        <label className="mb-1 block text-[13px] font-medium text-muted">City</label>
        <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="e.g. Singapore" className="mb-4 w-full rounded-[14px] border border-line bg-surface px-4 py-3 text-[15px] outline-none focus:border-primary" />
        <label className="mb-1 block text-[13px] font-medium text-muted">University</label>
        <input value={university} onChange={(e) => setUniversity(e.target.value)} placeholder="e.g. National University of Singapore" className="w-full rounded-[14px] border border-line bg-surface px-4 py-3 text-[15px] outline-none focus:border-primary" />
        <StickyNext onNext={() => setStep("dates")} />
      </OnbFrame>
    );

  /* -------------------------------- Dates ----------------------------------- */
  if (step === "dates")
    return (
      <OnbFrame title="Your exchange period" subtitle="We phase your journey from these dates" onBack={() => setStep("place")} progress={38}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <DateField label="Arrival in the host country" required value={dates.arrivalDate} onChange={(value) => setDates((current) => ({ ...current, arrivalDate: value }))} />
          <DateField label="Return home" required value={dates.returnDate} onChange={(value) => setDates((current) => ({ ...current, returnDate: value }))} />
          <DateField label="Departure from home" value={dates.departureDate} onChange={(value) => setDates((current) => ({ ...current, departureDate: value }))} />
          <DateField label="Programme starts" value={dates.programStartDate} onChange={(value) => setDates((current) => ({ ...current, programStartDate: value }))} />
          <DateField label="Programme ends" value={dates.programEndDate} onChange={(value) => setDates((current) => ({ ...current, programEndDate: value }))} />
        </div>

        {problems.length > 0 && (
          <div className="mt-3">
            <Notice tone="warning" icon="alert" title="Check these dates" body={problems.join(" ")} />
          </div>
        )}

        {problems.length === 0 && lengthDays !== null && (
          <Card className="mt-3 p-4">
            <p className="text-[13px] font-semibold text-ink">
              {stageLabel(stage)} · ~{lengthDays} days
            </p>
            <p className="mt-1 text-[12px] text-muted">
              We phase your journey from these dates: Before departure → Arriving soon → First 24 hours → First week → Settling in → Studying → Returning home. Today, the Greenbook and every AI answer follow that stage, so you never set it by hand.
            </p>
          </Card>
        )}

        <StickyNext disabled={problems.length > 0} onNext={() => setStep("languages")} />
      </OnbFrame>
    );

  /* ------------------------------ Languages --------------------------------- */
  if (step === "languages")
    return (
      <OnbFrame title="Your languages" subtitle="How's your host-language & English?" onBack={() => setStep("dates")} progress={46}>
        <p className="mb-2 text-[13px] font-medium text-ink">English level</p>
        <div className="flex flex-wrap gap-2">
          {LANG_LEVELS.map((l) => (
            <Chip key={l} tone="primary" active={langLevel === l} onClick={() => setLangLevel(l)}>{l}</Chip>
          ))}
        </div>
        {host && (
          <Notice tone="primary" icon="chat" title={`${COUNTRIES[host].languages[0]} basics`} body={`You'll pick up survival ${COUNTRIES[host].languages[0]} through daily situations and practice.`} />
        )}
        <StickyNext onNext={() => setStep("goals")} />
      </OnbFrame>
    );

  /* -------------------------------- Goals ----------------------------------- */
  if (step === "goals")
    return (
      <OnbFrame title="What matters most?" subtitle="Pick your goals & concerns" onBack={() => setStep("languages")} progress={54}>
        <div className="flex flex-wrap gap-2">
          {GOALS.map((g) => (
            <Chip key={g} tone="primary" active={goals.includes(g)} onClick={() => toggle(goals, setGoals, g)}>{g}</Chip>
          ))}
        </div>
        <StickyNext disabled={goals.length === 0} onNext={() => setStep("interests")} />
      </OnbFrame>
    );

  /* ------------------------------ Interests --------------------------------- */
  if (step === "interests")
    return (
      <OnbFrame title="Your interests" subtitle="Helps us connect you with the right people" onBack={() => setStep("goals")} progress={62}>
        <div className="flex flex-wrap gap-2">
          {INTERESTS.map((g) => (
            <Chip key={g} tone="primary" active={interests.includes(g)} onClick={() => toggle(interests, setInterests, g)}>{g}</Chip>
          ))}
        </div>
        <StickyNext disabled={interests.length === 0} onNext={() => setStep("assess")} />
      </OnbFrame>
    );

  /* ---------------------------- MyDNA assessment ---------------------------- */
  if (step === "assess") {
    const q = ASSESSMENT[qIdx];
    return (
      <OnbFrame title="Communication style" subtitle={`${qIdx + 1} of ${ASSESSMENT.length}`} onBack={() => (qIdx === 0 ? setStep("interests") : setQIdx(qIdx - 1))} progress={62 + (qIdx / ASSESSMENT.length) * 20}>
        <div className="mb-2 w-fit rounded-full bg-primary-soft px-3 py-1 text-[11px] font-semibold text-primary">Derived from your answers, not your nationality</div>
        <h2 className="mb-5 mt-2 text-[19px] font-bold leading-snug text-ink">{q.prompt}</h2>
        <div className="space-y-2.5">
          {q.options.map((o, i) => {
            const sel = answers[q.id] === i;
            return (
              <button
                key={i}
                onClick={() => {
                  setAnswers((a) => ({ ...a, [q.id]: i }));
                  setTimeout(() => {
                    if (qIdx < ASSESSMENT.length - 1) setQIdx(qIdx + 1);
                    else setStep("mydna");
                  }, 180);
                }}
                className={`flex w-full items-center gap-3 rounded-[12px] border px-4 py-3.5 text-left text-[14px] font-medium transition active:scale-[.99] ${sel ? "border-primary bg-primary-soft text-primary" : "border-line bg-surface text-ink"}`}
              >
                <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${sel ? "border-primary bg-primary text-white" : "border-line"}`}>
                  {sel && <Icon name="check" size={13} />}
                </span>
                {o.label}
              </button>
            );
          })}
        </div>
      </OnbFrame>
    );
  }

  /* ------------------------------- MyDNA result ----------------------------- */
  if (step === "mydna")
    return (
      <OnbFrame title="Your MyDNA" subtitle="How you tend to communicate" onBack={() => setStep("assess")} progress={84}>
        <div className="space-y-3.5">
          {DNA_DIMENSIONS.map((d) => (
            <DnaBar key={d.key} label={d.label} value={myDna[d.key]} />
          ))}
        </div>
        <StickyNext label="See your adaptation map" onNext={() => setStep("gap")} />
      </OnbFrame>
    );

  /* ------------------------------- PairDNA gap ------------------------------ */
  if (step === "gap" && pair && home && host)
    return (
      <OnbFrame title="Your adaptation map" subtitle={`${COUNTRIES[home].flag} ${COUNTRIES[home].name} → ${COUNTRIES[host].flag} ${COUNTRIES[host].name}`} onBack={() => setStep("mydna")} progress={92}>
        <Card className="mb-4 flex items-center gap-4 p-4">
          <ProgressRing value={pair.readiness} size={64} />
          <div>
            <p className="text-[13px] font-semibold text-ink">Readiness</p>
            <p className="mt-0.5 text-[12px] leading-relaxed text-muted">Based on the gap between your MyDNA and typical {COUNTRIES[host].name} student contexts.</p>
          </div>
        </Card>
        <div className="mb-4 flex items-center justify-between text-[11px] font-semibold text-muted">
          <span>● You</span><span>○ {COUNTRIES[host].name} context</span>
        </div>
        <div className="space-y-4">
          {pair.meters.slice(0, 6).map((m) => (
            <CultureGapMeter key={m.key} label={m.label} you={m.you} host={m.host} verdict={m.verdict} tone={m.tone} />
          ))}
        </div>
        <Card className="mt-4 p-4">
          <p className="text-[13px] font-bold text-ink">3 situations that may feel unfamiliar</p>
          <ul className="mt-2 space-y-1.5">
            {pair.unfamiliarSituations.map((s) => (
              <li key={s} className="flex items-start gap-2 text-[13px] text-muted"><span className="text-muted">◆</span> {s}</li>
            ))}
          </ul>
          <p className="mt-3 text-[12px] italic leading-relaxed text-muted">
            These are contextual tendencies you may meet — not stereotypes about everyone in {COUNTRIES[host].name}.
          </p>
        </Card>
        <StickyNext label="Generate my Passport" onNext={() => setStep("generate")} />
      </OnbFrame>
    );

  /* ------------------------- Save the journey (account) --------------------- */
  if (step === "save")
    return (
      <OnbFrame title="Save your journey" subtitle="Keep your Passport, practice history and progress" onBack={() => setStep("generate")} progress={98}>
        <SaveJourneyCard />
        <div className="mt-4">
          <Button size="lg" full onClick={finish}>Continue as guest</Button>
          <p className="mt-3 text-center text-[12px] leading-relaxed text-muted">
            You can always add an email later in Settings → Email &amp; accounts.
          </p>
        </div>
      </OnbFrame>
    );

  /* ------------------------------- Generate --------------------------------- */
  return (
    <div data-testid="onboarding" className="flex h-full flex-col items-center justify-center bg-ink px-8 text-center text-white">
      <div className="mx-auto flex w-full max-w-[420px] flex-col items-center">
      <div className="relative mb-6">
        <div className="relative h-24 w-24">
          <div className="yy-ring absolute inset-0" />
          <div className="flex h-24 w-24 items-center justify-center rounded-full bg-white/15 text-white"><Icon name="passport" size={40} /></div>
        </div>
      </div>
      <h2 className="text-[24px] font-extrabold tracking-tight">Your {host ? COUNTRIES[host].name : ""} Passport is ready</h2>
      <p className="mt-2 max-w-[280px] text-[14px] leading-relaxed text-white/80">
        Personalized to your MyDNA, your journey and your city. Everything adapts around you.
      </p>
      <div className="mt-8 w-full">
        <Button variant="inverse" size="lg" full onClick={() => setStep("save")}>Enter YapYep</Button>
      </div>
      </div>
    </div>
  );
}

/* ------------------------------ Sub-components ------------------------------ */

function OnbFrame({ title, subtitle, children, onBack, progress }: { title: string; subtitle?: string; children: React.ReactNode; onBack: () => void; progress: number }) {
  return (
    <div data-testid="onboarding" className="flex h-full flex-col bg-canvas">
      <div className="mx-auto w-full max-w-[560px] px-5 pt-4">
        <div className="mb-4 flex items-center gap-3">
          <button onClick={onBack} aria-label="Back" className="flex h-11 w-11 items-center justify-center rounded-full border border-line bg-surface active:scale-90"><Icon name="back" size={20} /></button>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
            <div className="h-full rounded-full bg-ink transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>
        <h1 className="text-[24px] font-extrabold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-0.5 text-[14px] text-muted">{subtitle}</p>}
      </div>
      <div className="scroll-area mx-auto w-full max-w-[560px] flex-1 overflow-y-auto px-5 py-5">{children}</div>
    </div>
  );
}

function CountryGrid({ selected, onSelect, disabled }: { selected: CountryCode | null; onSelect: (c: CountryCode) => void; disabled?: CountryCode }) {
  return (
    <div className="grid grid-cols-2 gap-2.5">
      {COUNTRY_LIST.map((c) => {
        const isDisabled = disabled === c.code;
        const sel = selected === c.code;
        return (
          <button
            key={c.code}
            disabled={isDisabled}
            onClick={() => onSelect(c.code)}
            className={`flex items-center gap-2.5 rounded-[12px] border px-3 py-3 text-left transition active:scale-[.98] disabled:opacity-30 ${sel ? "border-primary bg-primary-soft" : "border-line bg-surface"}`}
          >
            <span className="text-[22px]">{c.flag}</span>
            <span className={`text-[13px] font-semibold leading-tight ${sel ? "text-primary" : "text-ink"}`}>{c.name}</span>
          </button>
        );
      })}
    </div>
  );
}

function StickyNext({ onNext, disabled, label = "Continue" }: { onNext: () => void; disabled?: boolean; label?: string }) {
  return (
    <div className="sticky bottom-0 -mx-5 mt-6 border-t border-line bg-canvas px-5 pb-4 pt-3">
      <Button size="lg" full disabled={disabled} onClick={onNext}>{label}</Button>
    </div>
  );
}
