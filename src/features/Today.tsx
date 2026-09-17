import { useEffect, useState } from "react";
import { useJourney } from "../context/JourneyContext";
import { useNav } from "../context/NavContext";
import YepGuide from "../components/yep-guide";
import { Scroll } from "../components/shell";
import { Card, ProgressRing, Button, Badge, SectionHeader, OfflineBanner, Skeleton, ErrorState, EmptyState, Notice } from "../components/ui";
import { Icon, type IconName } from "../components/icons";
import { COUNTRIES } from "../data/countries";
import { dayOfExchange, deriveStage, exchangeLengthDays, stageLabel } from "../lib/journey/dates";
import { listChapters } from "../lib/greenbook";

/**
 * The Living Greenbook entry point.
 *
 * Deliberately not a new bottom-nav tab — the tab set is frozen (Today,
 * Passport, Lens, Explore, Connect) and the Greenbook is a contextual overlay.
 * The count is real: it is the number of verified points currently stored for
 * the host country, so the card never advertises content that is not there.
 */
function GreenbookCard() {
  const { journey } = useJourney();
  const nav = useNav();
  const [count, setCount] = useState<number | null>(null);
  const host = COUNTRIES[journey.host];

  useEffect(() => {
    let cancelled = false;
    void listChapters(journey.host).then((chapters) => {
      if (!cancelled) setCount(chapters.reduce((sum, chapter) => sum + chapter.factCount, 0));
    });
    return () => {
      cancelled = true;
    };
  }, [journey.host]);

  return (
    <Card tone="ink" className="mb-4 p-4" onClick={() => nav.push("greenbook")}>
      <div className="flex items-center gap-2 text-[12px] font-semibold text-white/70">
        <Icon name="text" size={15} /> Living Greenbook
      </div>
      <h3 className="mt-1.5 text-[16px] font-bold leading-snug text-white">
        {host.flag} Your {host.name.split(" ")[0]} field manual
      </h3>
      <p className="mt-1 text-[12px] leading-relaxed text-white/70">
        {count === null
          ? "Loading verified guidance…"
          : count > 0
            ? `${count} verified point${count === 1 ? "" : "s"} from official sources, with tasks and phrases for your first weeks.`
            : "No verified official guidance for this country yet — the manual says so rather than inventing content."}
      </p>
      <div className="mt-3">
        <span className="inline-flex items-center gap-1 rounded-full bg-white/15 px-3 py-1.5 text-[13px] font-semibold text-white">Open Greenbook →</span>
      </div>
    </Card>
  );
}

export default function Today() {
  const { journey, pair, forced, savedTasks, toggleTask } = useJourney();
  const nav = useNav();
  const host = COUNTRIES[journey.host];

  if (forced === "loading")
    return (
      <Scroll className="px-5 py-4">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="mt-4 h-40 w-full" />
        <Skeleton className="mt-4 h-24 w-full" />
      </Scroll>
    );
  if (forced === "error") return <Scroll className="px-5"><ErrorState /></Scroll>;

  const bankDone = savedTasks[journey.primaryTask.id];
  /**
   * The journey's phase, derived from the student's own dates.
   *
   * `primaryTask.phase` is seed copy ("First Week") and `dayCount`/`totalDays`
   * are seed numbers, so both were wrong for anyone who onboarded with their own
   * timeline. These are computed instead, and fall back to the seed copy only
   * when a timeline is genuinely absent.
   */
  const stage = deriveStage(journey.dates);
  const dayNumber = dayOfExchange(journey.dates);
  const totalDays = exchangeLengthDays(journey.dates);

  return (
    <Scroll tourScreen="today" className="px-5 pb-6 pt-1">
      {forced === "offline" && <div className="mb-4"><OfflineBanner /></div>}
      {forced === "stale" && <div className="mb-4"><Notice tone="warning" icon="info" title="Working from saved data" body="Some cards may be out of date until we can refresh from official sources." /></div>}

      {/* Greeting */}
      <YepGuide screen="today" autoStart title="One step at a time">I’m Yep, your student-life buddy. Let’s find today’s useful task, then practise a conversation before you go.</YepGuide>
      <div className="mb-4">
        <p className="text-[14px] text-muted">Good morning,</p>
        <h1 className="text-[26px] font-extrabold tracking-tight text-ink">{journey.name}</h1>
        <div className="mt-1.5 flex items-center gap-2 text-[13px] font-medium text-muted">
          {/*
            * `today-route` exists because the shell header also renders a route
            * chip ("🇻🇳 → 🇸🇬 Singapore"), and it is present behind the onboarding
            * overlay too. A whole-page text search for the host country therefore
            * passes while the student is still onboarding. This hook scopes the
            * claim "Today shows this corridor's route" to Today itself.
            */}
          <span data-testid="today-route">{COUNTRIES[journey.home].flag} → {host.flag} {host.name}</span>
          <span className="text-line">·</span>
          {/*
            * The derived stage is always on screen, but which element carries it
            * depends on the timeline: an arrived student sees "Day N of M" here
            * plus the stage underneath, a pre-departure student sees the stage
            * here only. The test hook follows the stage so that exactly one
            * `today-stage` node exists in both cases — a hook that disappears
            * before arrival cannot verify the state it exists to verify.
            */}
          {dayNumber > 0 && totalDays !== null ? (
            <span>Day {dayNumber} of {totalDays}</span>
          ) : (
            <span data-testid="today-stage">{stageLabel(stage)}</span>
          )}
        </div>
        {dayNumber > 0 && totalDays !== null && (
          <p className="mt-1 text-[12px] text-muted" data-testid="today-stage">{stageLabel(stage)}</p>
        )}
      </div>

      {/* Quick actions */}
      <div className="mb-5 grid grid-cols-4 gap-2">
        {([
          { icon: "lens", label: "Scan", onClick: () => nav.setTab("lens") },
          { icon: "chat", label: "Ask", onClick: () => nav.push("greenbookAsk", { countryCode: journey.host, chapter: null }) },
          { icon: "connect", label: "Message", onClick: () => nav.setTab("connect") },
          { icon: "practice", label: "Practice", onClick: () => nav.push("sim") },
        ] as { icon: IconName; label: string; onClick: () => void }[]).map((a) => (
          <button
            key={a.label}
            onClick={a.onClick}
            className="flex min-h-[76px] flex-col items-center justify-center gap-1.5 rounded-[12px] border border-line bg-surface py-3 active:scale-95"
          >
            <span className="text-ink"><Icon name={a.icon} size={22} /></span>
            <span className="text-[11px] font-semibold text-ink">{a.label}</span>
          </button>
        ))}
      </div>

      {/* Living Greenbook */}
      <button className="mb-3 min-h-[44px] text-[13px] font-semibold text-primary" onClick={() => nav.push("study")}>Study support examples</button>
      <GreenbookCard />

      {/* Primary task */}
      <SectionHeader title="Your focus today" />
      <Card className="mb-4 overflow-hidden">
        <div className="flex items-start gap-3 p-4">
          <div className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] bg-primary-soft text-primary"><Icon name="passport" size={20} /></div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <Badge tone="primary">{journey.primaryTask.phase}</Badge>
              {bankDone && <Badge tone="success">Done ✓</Badge>}
            </div>
            <h3 data-yep="focus" className="mt-1.5 text-[16px] font-bold text-ink">{journey.primaryTask.title}</h3>
            <p className="mt-0.5 text-[13px] text-muted">{journey.primaryTask.meta}</p>
          </div>
        </div>
        <div className="flex gap-2 border-t border-line px-4 py-3">
          <Button size="sm" variant="soft" onClick={() => nav.push(journey.id === "custom" ? "greenbook" : "passportSection", { sectionId: "money" })}>Open guide</Button>
          <Button size="sm" variant={bankDone ? "outline" : "primary"} onClick={() => toggleTask(journey.primaryTask.id)}>
            {bankDone ? "Mark undone" : "Mark done"}
          </Button>
        </div>
      </Card>

      {/* Practice mission */}
      <SectionHeader title="Today's practice" action="All" onAction={() => nav.push("sim")} />
      <Card tone="ink" className="mb-4 p-4" onClick={() => nav.push("sim")}>
        <div className="flex items-center gap-2 text-[12px] font-semibold text-white/70">
          <Icon name="practice" size={15} /> AI roleplay · 3 min
        </div>
        <h3 data-yep="practice" className="mt-1.5 text-[16px] font-bold leading-snug">{journey.practiceMission.title}</h3>
        <p className="mt-1 text-[12px] leading-relaxed text-white/70">{journey.practiceMission.reason}</p>
        <div className="mt-3"><span className="inline-flex items-center gap-1 rounded-full bg-white/15 px-3 py-1.5 text-[13px] font-semibold">Start practice →</span></div>
      </Card>

      {/* Adaptation snapshot */}
      <SectionHeader title="Your adaptation map" action="Details" onAction={() => nav.push("profile")} />
      <Card className="mb-4 flex items-center gap-4 p-4" onClick={() => nav.push("profile")}>
        {journey.myDnaAssessed !== false && <ProgressRing value={pair.readiness} size={58} />}
        <div className="flex-1">
          <p className="text-[13px] font-bold text-ink">{journey.myDnaAssessed === false ? "Personalize your practice" : `${pair.readiness}% prepared`}</p>
          <p className="mt-0.5 text-[12px] text-muted">{journey.myDnaAssessed === false ? "Add your communication preferences in Profile whenever you’re ready." : `Worth practising: ${pair.biggestGaps[0].label}`}</p>
        </div>
      </Card>

      {/* Reminder + culture tip */}
      <SectionHeader title="Coming up" />
      <Card className="mb-3 flex items-center gap-3 p-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-canvas text-ink"><Icon name="calendar" size={20} /></div>
        <div className="flex-1">
          <p className="text-[14px] font-semibold text-ink">{journey.reminder.title}</p>
          <p className="text-[12px] text-muted">{journey.reminder.when}</p>
        </div>
      </Card>

      <Notice tone="primary" icon="info" title={journey.cultureTip.title} body={journey.cultureTip.body} />

      {forced === "empty" && (
        <div className="mt-4"><EmptyState icon="check" title="All caught up!" body="No tasks left for today. Explore your Passport or connect with a local." /></div>
      )}
    </Scroll>
  );
}
