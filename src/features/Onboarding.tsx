import { useEffect, useState } from "react";
import { COUNTRY_LIST, COUNTRIES, type CountryCode } from "../data/countries";
import { deriveMyDna } from "../data/assessment";
import { Button, Card, Notice } from "../components/ui";
import { Icon } from "../components/icons";
import Mascot from "../components/mascot";
import { EMPTY_JOURNEY_DATES, type JourneyDates, deriveStage, stageLabel, timelineProblems } from "../lib/journey/dates";
import { completeEmailUpgrade, friendlyAuthError, requestEmailUpgradeCode, startGoogleUpgrade } from "../lib/appwrite/auth";
import { account } from "../lib/appwrite/client";

type Step = "welcome" | "signin" | "home" | "host" | "dates";
type JourneyInput = { home: CountryCode; host: CountryCode; city: string; university: string; dates: JourneyDates; myDna: ReturnType<typeof deriveMyDna> };

export default function Onboarding({ onComplete, onStart }: { onComplete: (data: JourneyInput) => Promise<void>; onStart: () => Promise<{ ok: boolean; message?: string }> }) {
  const [step, setStep] = useState<Step>("welcome");
  const [home, setHome] = useState<CountryCode | null>(null);
  const [host, setHost] = useState<CountryCode | null>(null);
  const [dates, setDates] = useState<JourneyDates>({ ...EMPTY_JOURNEY_DATES });
  const [unknownReturn, setUnknownReturn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [otpUserId, setOtpUserId] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => {
    if (!cooldown) return;
    const timer = window.setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  async function start() {
    setBusy(true); setError("");
    try { const result = await onStart(); if (result.ok) setStep("home"); else setError(result.message || "We couldn’t start your journey. Please try again."); }
    catch { setError("We couldn’t connect. Check your connection and try again."); }
    finally { setBusy(false); }
  }
  async function sendCode() {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email.trim())) { setError("Enter a valid email address."); return; }
    setBusy(true); setError("");
    try { const ticket = await requestEmailUpgradeCode((await account.get()).$id, email); setOtpUserId(ticket.userId); setCooldown(30); }
    catch (cause) { setError(friendlyAuthError(cause)); }
    finally { setBusy(false); }
  }
  async function verify() {
    if (!otpUserId || otp.length !== 6) return;
    setBusy(true); setError("");
    try { await completeEmailUpgrade(otpUserId, otp); window.location.reload(); }
    catch (cause) { setError(friendlyAuthError(cause)); setBusy(false); }
  }
  async function finish() {
    if (!home || !host || timelineProblems(dates).length) return;
    setBusy(true); setError("");
    try { await onComplete({ home, host, city: "", university: "", dates, myDna: deriveMyDna({}) }); }
    catch { setError("Your journey couldn’t be saved. Your answers are kept — check your connection and try again."); setBusy(false); }
  }
  const alert = error && <p role="alert" className="my-3 rounded-[12px] border border-error/30 bg-error-soft px-3 py-2 text-[13px] leading-relaxed text-error">{error}</p>;

  if (step === "welcome") return <div data-testid="onboarding" className="scroll-area h-full overflow-y-auto bg-ink px-6 py-6 text-white">
    <div className="mx-auto flex min-h-full w-full max-w-[560px] flex-col justify-center">
      <p className="mb-3 text-[13px] font-bold text-white/70">YapYep · For ASEAN exchange students</p>
      <h1 className="max-w-[420px] text-[34px] font-extrabold leading-[1.12] tracking-tight">Feel at home,<br />away from home.</h1>
      <p className="mt-3 max-w-[400px] text-[15px] leading-relaxed text-white/80">Understand local life and practise the conversations that help you settle in.</p>
      <Card className="my-5 overflow-hidden p-4">
        <div className="flex items-center justify-between gap-3"><div><p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Example journey</p><p className="mt-1 text-[15px] font-bold text-ink">{COUNTRIES.VN.flag} Viet Nam → {COUNTRIES.SG.flag} Singapore</p><p className="mt-2 text-[20px] font-extrabold text-ink">Your ASEAN Passport</p></div><Mascot size={80} /></div>
        <div className="mt-3 space-y-2">
          {([{ icon: "passport", text: "Prepare your arrival" }, { icon: "lens", text: "Understand a message" }, { icon: "practice", text: "Practise a conversation" }] as const).map((item) => <div key={item.text} className="flex items-center gap-2.5 rounded-[10px] bg-canvas px-3 py-2.5 text-[13px] font-semibold text-ink"><Icon name={item.icon} size={18} /><span>{item.text}</span></div>)}
        </div>
      </Card>
      {alert}
      <Button variant="inverse" size="lg" full disabled={busy} onClick={start}>{busy ? "Starting…" : "Start my journey"}</Button>
      <button type="button" onClick={() => { setError(""); setStep("signin"); }} className="mt-1 min-h-[44px] text-[14px] font-semibold text-white/85">Sign in</button>
      <p className="mt-2 text-center text-[11px] text-white/60">11 ASEAN countries · 110 directions to explore</p>
    </div>
  </div>;

  if (step === "signin") return <Frame title="Sign in" onBack={() => { setError(""); setStep("welcome"); }}>
    <div className="mb-4 flex items-center gap-3"><Mascot size={56} /><p className="text-[13px] text-muted">Welcome back. Continue your journey.</p></div>
    {alert}
    <Button variant="outline" size="lg" full disabled={busy} onClick={async () => { setBusy(true); setError(""); try { await startGoogleUpgrade(); } catch (cause) { setError(friendlyAuthError(cause)); setBusy(false); } }}>Continue with Google</Button>
    <label className="mt-4 block text-[13px] font-medium text-ink">Email<input type="email" inputMode="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@university.edu" className="mt-1 min-h-[48px] w-full rounded-[12px] border border-line bg-surface px-3 text-[16px]" /></label>
    {otpUserId ? <><label className="mt-3 block text-[13px] font-medium">Verification code<input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))} className="mt-1 min-h-[48px] w-full rounded-[12px] border border-line bg-surface px-3 text-[18px] tracking-widest" /></label><div className="mt-4"><Button full size="lg" disabled={busy || otp.length !== 6} onClick={verify}>{busy ? "Signing in…" : "Verify & sign in"}</Button></div><button disabled={busy || cooldown > 0} onClick={sendCode} className="mt-2 min-h-[44px] text-[13px] text-primary">{cooldown ? `Resend in ${cooldown}s` : "Resend code"}</button></> : <div className="mt-4"><Button size="lg" full disabled={busy || !email.trim()} onClick={sendCode}>{busy ? "Sending…" : "Continue with email"}</Button></div>}
  </Frame>;

  if (step === "home") return <Frame title="Where are you from?" step={1} onBack={() => setStep("welcome")}>
    <CountryGrid selected={home} onSelect={(code) => { setHome(code); if (host === code) setHost(null); }} />
    <Next disabled={!home} onNext={() => setStep("host")} />
  </Frame>;
  if (step === "host") return <Frame title="Where are you going?" step={2} onBack={() => setStep("home")}>
    {home && <p className="mb-3 text-[13px] text-muted">From {COUNTRIES[home].flag} {COUNTRIES[home].name}</p>}
    <CountryGrid selected={host} disabled={home} onSelect={setHost} />
    <Next disabled={!host} onNext={() => setStep("dates")} />
  </Frame>;
  const problems = timelineProblems(dates);
  return <Frame title="When are you arriving?" step={3} onBack={() => { setError(""); setStep("host"); }}>
    <label className="block text-[14px] font-semibold">Arrival date<input aria-label="Arrival date" type="date" required value={dates.arrivalDate ?? ""} onChange={(event) => setDates((current) => ({ ...current, arrivalDate: event.target.value || null }))} className="mt-2 min-h-[48px] w-full rounded-[12px] border border-line bg-surface px-4 text-[16px]" /></label>
    <label className="mt-4 flex min-h-[44px] items-center gap-2 text-[13px]"><input type="checkbox" checked={unknownReturn} onChange={(event) => { setUnknownReturn(event.target.checked); if (event.target.checked) setDates((current) => ({ ...current, returnDate: null })); }} className="h-5 w-5 accent-primary" />I don’t know my return date yet</label>
    {!unknownReturn && <label className="mt-3 block text-[14px] font-semibold">Return date (optional)<input aria-label="Return date" type="date" min={dates.arrivalDate ?? undefined} value={dates.returnDate ?? ""} onChange={(event) => setDates((current) => ({ ...current, returnDate: event.target.value || null }))} className="mt-2 min-h-[48px] w-full rounded-[12px] border border-line bg-surface px-4 text-[16px]" /></label>}
    {dates.arrivalDate && <p className="mt-4 text-[13px] text-muted">{stageLabel(deriveStage(dates))} · {home && host ? `${COUNTRIES[home].name} → ${COUNTRIES[host].name}` : ""}</p>}
    {dates.arrivalDate && problems.length > 0 && <div className="mt-3"><Notice tone="warning" icon="alert" title="Check your dates" body={problems.join(" ")} /></div>}
    {alert}
    <Next disabled={busy || problems.length > 0} label={busy ? "Saving your journey…" : "Create my Passport"} onNext={finish} />
  </Frame>;
}

function Frame({ title, children, onBack, step }: { title: string; children: React.ReactNode; onBack: () => void; step?: number }) {
  return <div data-testid="onboarding" className="flex h-full min-h-0 flex-col bg-canvas"><div className="mx-auto w-full max-w-[560px] px-5 pt-4"><div className="mb-5 flex items-center justify-between"><button type="button" onClick={onBack} aria-label="Back" className="flex h-11 w-11 items-center justify-center rounded-full border border-line bg-surface"><Icon name="back" size={20} /></button>{step && <span className="text-[12px] font-semibold text-muted">{step} / 3</span>}</div><h1 className="mb-4 text-[26px] font-extrabold leading-tight tracking-tight">{title}</h1></div><div className="scroll-area mx-auto min-h-0 w-full max-w-[560px] flex-1 overflow-y-auto px-5 pb-4">{children}</div></div>;
}
function CountryGrid({ selected, disabled, onSelect }: { selected: CountryCode | null; disabled?: CountryCode | null; onSelect: (code: CountryCode) => void }) {
  return <div className="grid grid-cols-2 gap-2.5">{COUNTRY_LIST.map((country) => <button type="button" key={country.code} disabled={country.code === disabled} aria-pressed={country.code === selected} onClick={() => onSelect(country.code)} className={`flex min-h-[48px] items-center gap-2 rounded-[12px] border px-3 py-3 text-left text-[13px] font-semibold disabled:opacity-35 ${country.code === selected ? "border-ink bg-ink text-white" : "border-line bg-surface text-ink"}`}><span className="text-[20px]">{country.flag}</span>{country.name}</button>)}</div>;
}
function Next({ disabled, onNext, label = "Continue" }: { disabled?: boolean; onNext: () => void; label?: string }) {
  return <div className="sticky bottom-0 -mx-5 mt-5 border-t border-line bg-canvas px-5 pb-4 pt-3"><Button size="lg" full disabled={disabled} onClick={onNext}>{label}</Button></div>;
}
