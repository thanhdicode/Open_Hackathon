import { useMemo } from "react";
import { useJourney } from "../context/JourneyContext";
import { useNav } from "../context/NavContext";
import { Scroll, ScreenHeader } from "../components/shell";
import { Card, ProgressRing, ProgressBar, Button, Badge, FreshnessBadge, SourceBadge, Notice, Skeleton, ErrorState, SectionHeader } from "../components/ui";
import { Icon } from "../components/icons";
import { COUNTRIES } from "../data/countries";
import { buildPassport, type PassportCard } from "../data/passports";
import { COUNTRY_DNA } from "../data/dna";
import YepGuide from "../components/yep-guide";
import Mascot from "../components/mascot";

export function PassportHome() {
  const { journey, pair, forced } = useJourney();
  const nav = useNav();
  const sections = useMemo(() => buildPassport(journey.host), [journey.host]);
  const host = COUNTRIES[journey.host];

  if (forced === "loading")
    return <Scroll className="px-5 py-4"><Skeleton className="h-32 w-full" /><div className="mt-4 grid grid-cols-2 gap-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div></Scroll>;
  if (forced === "error") return <Scroll className="px-5"><ErrorState /></Scroll>;

  return (
    <Scroll tourScreen="passport" className="px-5 pb-6 pt-1">
      {forced === "stale" && (
        <div className="mb-3 mt-2"><Notice tone="warning" icon="info" title="Some guidance may be out of date" body="We haven't been able to re-verify a few sources recently. Check official links before relying on requirements." /></div>
      )}
      <div className="mb-1 flex items-center gap-2 text-[13px] font-semibold text-muted">
        {COUNTRIES[journey.home].flag} <span>→</span> {host.flag} {host.name}
      </div>
      <h1 className="text-[24px] font-extrabold tracking-tight text-ink">{journey.name === "You" ? "Your" : `${journey.name}'s`} {host.name.split(" ")[0]} Passport</h1>
      <p className="mt-0.5 text-[13px] text-muted">{[journey.university, journey.arrival !== "Not set" ? `Arrival ${journey.arrival}` : "Arrival not set", journey.departure !== "Not set" ? `Return ${journey.departure}` : "Return date open"].filter(Boolean).join(" · ")}</p>
      <YepGuide key={journey.host} screen="passport" title={`Let’s settle into ${host.name}`} country={journey.host}>My outfit is inspired by one local clothing tradition; styles vary across communities. Your guidance follows your own journey.</YepGuide>

      <Card className="my-4 flex items-center gap-4 p-4">
        {journey.myDnaAssessed !== false && <ProgressRing value={pair.readiness} size={64} label={<div><div className="text-[15px] font-bold text-ink">{pair.readiness}%</div></div>} />}
        <div className="flex-1">
          <p className="text-[13px] font-bold text-ink">{journey.myDnaAssessed === false ? "Make it yours" : "Communication preparation"}</p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{journey.myDnaAssessed === false ? "Add your communication preferences in Profile when you’re ready." : "A starting point from your communication preferences, not a checklist completion score."}</p>
        </div>
      </Card>

      {/* CountryDNA quick access */}
      <SectionHeader title={`${host.name.split(" ")[0]} DNA`} />
      <div className="mb-5 flex gap-2 overflow-x-auto scroll-area pb-1">
        {COUNTRY_DNA[journey.host].map((p) => (
          <div key={p.key} className="w-[150px] shrink-0 rounded-[12px] border border-line bg-surface p-3">
            <div className="text-[20px]">{p.icon}</div>
            <p className="mt-1 text-[13px] font-bold text-ink">{p.title}</p>
            <p className="mt-1 text-[11px] leading-snug text-muted line-clamp-3">{p.points[0]}</p>
          </div>
        ))}
      </div>

      <div data-yep="sections"><SectionHeader title="Sections" /></div>
      <div className="grid grid-cols-2 gap-3">
        {sections.map((s) => (
          <Card key={s.id} className="p-3.5" onClick={() => nav.push("passportSection", { sectionId: s.id })}>
            <div className="flex items-center justify-between">
              <span className="text-[22px]">{s.icon}</span>
              {journey.id !== "custom" && <span className="text-[11px] font-bold text-muted">{s.progress}%</span>}
            </div>
            <p className="mt-2 text-[14px] font-bold leading-tight text-ink">{s.title}</p>
            <p className="mt-0.5 text-[11px] leading-snug text-muted line-clamp-2">{s.blurb}</p>
            {journey.id !== "custom" && <div className="mt-2"><ProgressBar value={s.progress} tone={s.progress === 100 ? "success" : "primary"} /></div>}
          </Card>
        ))}
      </div>
    </Scroll>
  );
}

export function PassportSection({ sectionId, onBack }: { sectionId: string; onBack: () => void }) {
  const { journey } = useJourney();
  const nav = useNav();
  const section = useMemo(() => buildPassport(journey.host).find((s) => s.id === sectionId)!, [journey.host, sectionId]);

  return (
    <div className="flex h-full flex-col bg-canvas">
      <ScreenHeader title={section.title} onBack={onBack} />
      <Scroll className="px-5 py-4">
        <p className="mb-4 text-[13px] text-muted">{section.blurb}</p>
        <div className="space-y-3">
          {section.cards.map((c) => (
            <PassportCardView key={c.id} card={c} onOpen={() => nav.push(c.id.includes("bank") ? "bankFlow" : "passportCard", { card: c })} />
          ))}
        </div>
        {section.cards.length === 0 && <div className="flex items-start gap-2"><Mascot pose="think" size={56} /><Notice tone="primary" icon="info" title="Coming soon" body="Detailed guidance for this section is being reviewed by local students." /></div>}
      </Scroll>
    </div>
  );
}

function PassportCardView({ card, onOpen }: { card: PassportCard; onOpen: () => void }) {
  return (
    <Card className="p-4" onClick={onOpen}>
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-[15px] font-bold text-ink">{card.title}</h3>
        <Icon name="chevron" size={18} />
      </div>
      <p className="mt-1 text-[13px] leading-relaxed text-muted">{card.summary}</p>
      <div className="mt-3">
        <FreshnessBadge reviewed={card.lastReviewed} status={card.verification} />
      </div>
    </Card>
  );
}

export function PassportCardDetail({ card, onBack }: { card: PassportCard; onBack: () => void }) {
  return (
    <div className="flex h-full flex-col bg-canvas">
      <ScreenHeader title={card.title} onBack={onBack} />
      <Scroll className="px-5 py-4">
        <p className="text-[15px] leading-relaxed text-ink">{card.summary}</p>
        {card.requirements && (
          <Card className="mt-4 p-4">
            <p className="text-[13px] font-bold text-ink">Requirements</p>
            <ul className="mt-2 space-y-2">
              {card.requirements.map((r) => (
                <li key={r} className="flex items-center gap-2 text-[14px] text-ink"><span className="text-success">✓</span> {r}</li>
              ))}
            </ul>
          </Card>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <SourceBadge source={card.officialSource} />
          <FreshnessBadge reviewed={card.lastReviewed} status={card.verification} />
        </div>
        {card.verification === "outdated" && (
          <div className="mt-4"><Notice tone="warning" icon="info" title="This may be out of date" body="This card was last reviewed a while ago. Confirm with an official source or Ask a Local before relying on it." /></div>
        )}
        <div className="mt-6 flex gap-2">
          <Button variant="soft" full>Save</Button>
          <Button variant="outline" full>Ask a Local</Button>
        </div>
      </Scroll>
    </div>
  );
}
