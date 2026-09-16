import { useEffect, useState } from "react";
import { useJourney } from "../context/JourneyContext";
import { useNav } from "../context/NavContext";
import { useAccount } from "../context/AccountContext";
import { ScreenHeader, Scroll } from "../components/shell";
import { Card, Button, Avatar, Badge, DnaBar, ScoreBarRow, Segmented, EmptyState } from "../components/ui";
import { Icon } from "../components/icons";
import { DNA_DIMENSIONS } from "../data/dna";
import { COUNTRIES, COUNTRY_LIST, type CountryCode } from "../data/countries";
import { JOURNEYS } from "../data/journeys";
import { aseanPassportFor } from "../data/achievements";
import { loadSocialProfile, STUDENT_ROLES, type SocialProfile } from "../lib/appwrite/profiles";
import { avatarPreviewUrl } from "../lib/appwrite/avatar";

type Tab = "mydna" | "skills" | "passport" | "saved";

export function Profile({ onBack }: { onBack: () => void }) {
  const { journey, pair, saved, toggleSave } = useJourney();
  const { account, isGuest } = useAccount();
  const nav = useNav();
  const [tab, setTab] = useState<Tab>("mydna");
  const [social, setSocial] = useState<SocialProfile | null>(null);
  const asean = aseanPassportFor(journey.home, journey.host);

  useEffect(() => {
    void (async () => {
      if (!account) return;
      setSocial(await loadSocialProfile(account.userId));
    })();
  }, [account]);

  const avatarUrl = avatarPreviewUrl(social?.avatarFileId, 160);
  const displayName = social?.displayName || journey.name;
  const roleLabel = STUDENT_ROLES.find((r) => r.value === social?.role)?.label;

  return (
    <div className="flex h-full flex-col bg-canvas">
      <ScreenHeader title="Profile" onBack={onBack} right={<button onClick={() => nav.push("settings")} aria-label="Settings" className="flex h-11 w-11 items-center justify-center rounded-full text-ink"><Icon name="settings" size={20} /></button>} />
      <Scroll className="px-5 py-4">
        <div className="flex items-center gap-3">
          {avatarUrl ? (
            <img src={avatarUrl} alt="" className="h-[60px] w-[60px] rounded-full border border-line object-cover" />
          ) : (
            <Avatar initials={journey.initials} color={journey.avatarColor} size={60} />
          )}
          <div className="min-w-0 flex-1">
            <h2 className="text-[19px] font-bold text-ink">{displayName}, {journey.age}</h2>
            <p className="text-[13px] text-muted">{COUNTRIES[journey.home].flag} {COUNTRIES[journey.home].name} → {COUNTRIES[journey.host].flag} {COUNTRIES[journey.host].name}</p>
            <p className="text-[12px] text-muted">{journey.university}</p>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {roleLabel && <Badge tone="muted">{roleLabel}</Badge>}
          {social?.major && <Badge tone="muted">{social.major}</Badge>}
          <Badge tone={social?.discoverable ? "primary" : "muted"}>{social?.discoverable ? "Discoverable" : "Private profile"}</Badge>
          {isGuest && <Badge tone="warning">Guest session</Badge>}
        </div>

        {social?.bio && <p className="mt-3 text-[13px] leading-relaxed text-muted">{social.bio}</p>}

        <div className="mt-4"><Button variant="outline" full onClick={() => nav.push("editProfile")}>Edit profile</Button></div>

        <div className="my-4"><Segmented value={tab} onChange={setTab} options={[{ value: "mydna" as const, label: "MyDNA" }, { value: "skills" as const, label: "Skills" }, { value: "passport" as const, label: "ASEAN" }, { value: "saved" as const, label: "Saved" }]} /></div>

        {tab === "mydna" && (
          <div className="space-y-3.5">
            <p className="text-[12px] italic text-muted">Derived from your assessment answers — never your nationality.</p>
            {DNA_DIMENSIONS.map((d) => <DnaBar key={d.key} label={d.label} value={journey.myDna[d.key]} />)}
            <Card className="mt-2 p-4">
              <p className="text-[13px] font-bold text-ink">Your host gap</p>
              <p className="mt-1 text-[12px] text-muted">Biggest: <b className="text-ink">{pair.biggestGaps[0].label}</b> · Strongest: <b className="text-success">{pair.strongestTransfer.label}</b></p>
            </Card>
          </div>
        )}

        {tab === "skills" && (
          <Card className="space-y-3 p-4">
            <p className="text-[13px] font-bold text-ink">Skill growth across your exchange</p>
            {asean.skills.map((s) => <ScoreBarRow key={s.key} label={s.label} value={s.value} />)}
          </Card>
        )}

        {tab === "passport" && <AseanPassportView asean={asean} />}

        {tab === "saved" && (
          saved.length === 0 ? (
            <EmptyState icon="star" title="Nothing saved yet" body="Save places, Lens insights and phrases and they'll collect here for offline reference." />
          ) : (
            <div className="space-y-2">
              {saved.map((s) => (
                <div key={s.id} className="flex items-center gap-3 rounded-[12px] border border-line bg-surface px-4 py-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-canvas text-muted"><Icon name="star" size={16} /></span>
                  <div className="flex-1">
                    <p className="text-[13px] font-semibold text-ink">{s.title}</p>
                    {s.subtitle && <p className="text-[11px] text-muted">{s.subtitle}</p>}
                  </div>
                  <button onClick={() => toggleSave(s)} className="text-[12px] font-semibold text-muted active:scale-95">Remove</button>
                </div>
              ))}
            </div>
          )
        )}
      </Scroll>
    </div>
  );
}

function AseanPassportView({ asean }: { asean: ReturnType<typeof aseanPassportFor> }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        <Stat value={asean.countriesExperienced.length} label="Countries" />
        <Stat value={`${asean.situationsMastered}/${asean.situationsTotal}`} label="Situations" />
        <Stat value={asean.verifiedInteractions} label="Verified" />
      </div>

      <Card className="p-4">
        <p className="mb-2 text-[13px] font-bold text-ink">Countries experienced</p>
        <div className="flex gap-2">
          {asean.stamps.map((s) => (
            <div key={s.code} className="flex flex-col items-center rounded-[12px] border border-dashed border-primary/30 bg-primary-soft/40 px-4 py-3">
              <span className="text-[26px]">{COUNTRIES[s.code].flag}</span>
              <span className="mt-1 text-[10px] font-semibold text-muted">{s.label}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-4">
        <p className="mb-2 text-[13px] font-bold text-ink">Language practice</p>
        {asean.languagePractice.map((l) => (
          <div key={l.language} className="flex items-center justify-between py-1 text-[13px]"><span className="text-ink">{l.language}</span><span className="font-mono text-muted">{l.minutes} min</span></div>
        ))}
      </Card>

      <Card className="p-4">
        <p className="mb-3 text-[13px] font-bold text-ink">Culture Quests</p>
        <div className="space-y-2">
          {asean.quests.map((q) => (
            <div key={q.id} className="flex items-start gap-2.5">
              <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${q.done ? "bg-success text-white" : "border border-line"}`}>{q.done && <Icon name="check" size={12} />}</span>
              <div>
                <p className={`text-[13px] ${q.done ? "text-muted line-through" : "font-medium text-ink"}`}>{q.title}</p>
                {q.reflection && <p className="text-[11px] italic text-muted">"{q.reflection}"</p>}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function Stat({ value, label }: { value: string | number; label: string }) {
  return (
    <Card className="flex flex-col items-center py-3">
      <span className="text-[20px] font-extrabold text-primary">{value}</span>
      <span className="text-[11px] font-semibold text-muted">{label}</span>
    </Card>
  );
}

/* ------------------------------ ASEAN Compass ------------------------------ */

export function Compass({ onBack, onReonboard }: { onBack: () => void; onReonboard?: () => void }) {
  const { journey, setJourneyId, setRoute, pair } = useJourney();
  const [pick, setPick] = useState<"home" | "host">("host");

  function choose(code: CountryCode) {
    if (pick === "home") {
      // avoid home === host
      setRoute(code === journey.host ? journey.home : code, journey.host);
    } else {
      setRoute(journey.home, code === journey.home ? journey.host : code);
    }
  }

  return (
    <div className="flex h-full flex-col bg-canvas">
      <ScreenHeader title="ASEAN Compass" onBack={onBack} />
      <Scroll className="px-5 py-4">
        <p className="mb-3 text-[13px] text-muted">Pick any origin and destination across all 11 ASEAN states. Direction matters — Vietnam→Singapore differs from Singapore→Vietnam.</p>

        {/* Directional route selector */}
        <Card className="p-4">
          <div className="flex items-center justify-between gap-2">
            <button onClick={() => setPick("home")} className={`flex flex-1 flex-col items-center rounded-[12px] border-2 py-3 active:scale-[.98] ${pick === "home" ? "border-primary bg-primary-soft" : "border-line bg-surface"}`}>
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">From</span>
              <span className="mt-1 text-[28px]">{COUNTRIES[journey.home].flag}</span>
              <span className="text-[12px] font-bold text-ink">{COUNTRIES[journey.home].name}</span>
            </button>
            <span className="text-[22px] text-primary">→</span>
            <button onClick={() => setPick("host")} className={`flex flex-1 flex-col items-center rounded-[12px] border-2 py-3 active:scale-[.98] ${pick === "host" ? "border-primary bg-primary-soft" : "border-line bg-surface"}`}>
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">To</span>
              <span className="mt-1 text-[28px]">{COUNTRIES[journey.host].flag}</span>
              <span className="text-[12px] font-bold text-ink">{COUNTRIES[journey.host].name}</span>
            </button>
          </div>
          <div className="mt-3 flex items-center justify-between rounded-[12px] bg-canvas px-3 py-2">
            <span className="text-[12px] font-semibold text-muted">Readiness for this route</span>
            <span className="text-[15px] font-extrabold text-primary">{pair.readiness}%</span>
          </div>
        </Card>

        <p className="mb-2 mt-5 text-[12px] font-bold uppercase tracking-wide text-muted">Choose your {pick === "home" ? "origin" : "destination"}</p>
        <div className="grid grid-cols-4 gap-2">
          {COUNTRY_LIST.map((c) => {
            const active = (pick === "home" ? journey.home : journey.host) === c.code;
            return (
              <button key={c.code} onClick={() => choose(c.code)} className={`flex flex-col items-center rounded-[14px] border py-3 active:scale-95 ${active ? "border-primary bg-primary-soft" : "border-line bg-surface"}`}>
                <span className="text-[22px]">{c.flag}</span>
                <span className="mt-1 text-[10px] font-semibold leading-tight text-muted text-center">{c.name.split(" ")[0]}</span>
              </button>
            );
          })}
        </div>

        <p className="mb-2 mt-6 text-[12px] font-bold uppercase tracking-wide text-muted">Seeded sample journeys</p>
        <div className="space-y-2.5">
          {JOURNEYS.map((j) => {
            const active = journey.id === j.id && journey.home === j.home && journey.host === j.host;
            return (
              <button key={j.id} onClick={() => { setJourneyId(j.id); onBack(); }} className={`flex w-full items-center gap-3 rounded-[12px] border px-4 py-3 text-left active:scale-[.99] ${active ? "border-primary bg-primary-soft" : "border-line bg-surface"}`}>
                <Avatar initials={j.initials} color={j.avatarColor} size={40} />
                <div className="flex-1">
                  <p className="text-[14px] font-bold text-ink">{j.name} · {COUNTRIES[j.home].flag}→{COUNTRIES[j.host].flag}</p>
                  <p className="text-[12px] text-muted">{COUNTRIES[j.home].name} → {COUNTRIES[j.host].name} · {j.city}</p>
                </div>
                {active && <Badge tone="primary">Active</Badge>}
                {j.deep && !active && <Badge tone="primary">Deep</Badge>}
              </button>
            );
          })}
        </div>

        <div className="mt-4"><Button variant="soft" full onClick={() => (onReonboard ? onReonboard() : onBack())}>Re-run onboarding to set a custom journey</Button></div>
      </Scroll>
    </div>
  );
}
