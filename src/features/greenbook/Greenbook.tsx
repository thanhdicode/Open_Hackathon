/**
 * Greenbook cover and "Today / Now".
 *
 * The home screen is the whole product's argument in one scroll: this is YOUR
 * manual, for YOUR route, and here is what matters this week. It deliberately
 * does not list ten chapters — that is the Browse screen's job. What it shows is
 * the cover, three things to do now, where you left off, and your progress.
 *
 * A sparse country is a first-class state, not an error. Every country in ASEAN
 * is selectable, and one with no verified facts yet says so plainly and shows
 * what is known instead of borrowing another country's guidance.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ScreenHeader, Scroll } from "../../components/shell";
import { Badge, Button, Card, ProgressRing, Skeleton, Toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { ChapterRow, Section } from "../../components/greenbook/bits";
import { useJourney } from "../../context/JourneyContext";
import { useNav } from "../../context/NavContext";
import { COUNTRIES, type CountryCode } from "../../data/countries";
import { currentUser } from "../../lib/appwrite/user";
import {
  CHAPTER_META,
  getProgress,
  listChapters,
  listMedia,
  listTasks,
  setProgress as saveProgress,
  type GreenbookChapter,
  type GreenbookTask,
  type MediaResource,
} from "../../lib/greenbook";

const CONTINUE_KEY = "yapyep.greenbook.continue";

export function journeyStageFor(dayCount: number): "before_arrival" | "arrival" | "first_week" | "settling" | "ongoing" {
  if (dayCount < 0) return "before_arrival";
  if (dayCount <= 1) return "arrival";
  if (dayCount <= 7) return "first_week";
  if (dayCount <= 30) return "settling";
  return "ongoing";
}

const STAGE_LABEL: Record<string, string> = {
  before_arrival: "Before arrival",
  arrival: "Arrival day",
  first_week: "First week",
  settling: "Settling in",
  ongoing: "Ongoing",
};

export function readContinue(): { countryCode: string; chapterId: string; title: string } | null {
  try {
    const raw = localStorage.getItem(CONTINUE_KEY);
    return raw ? (JSON.parse(raw) as { countryCode: string; chapterId: string; title: string }) : null;
  } catch {
    return null;
  }
}

export function writeContinue(value: { countryCode: string; chapterId: string; title: string }): void {
  try {
    localStorage.setItem(CONTINUE_KEY, JSON.stringify(value));
  } catch {
    // Storage disabled (private mode). Losing "continue reading" is acceptable.
  }
}

export function Greenbook({ onBack }: { onBack: () => void }) {
  const { journey, setRoute, savedTasks, toggleTask } = useJourney();
  const nav = useNav();
  const [chapters, setChapters] = useState<GreenbookChapter[] | null>(null);
  const [tasks, setTasks] = useState<GreenbookTask[]>([]);
  const [media, setMedia] = useState<MediaResource[]>([]);
  const [progress, setProgress] = useState<Record<string, boolean>>({});
  const [userId, setUserId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [offline, setOffline] = useState(typeof navigator !== "undefined" && navigator.onLine === false);

  const host = journey.host as CountryCode;
  const home = journey.home as CountryCode;
  const stage = journeyStageFor(journey.dayCount);

  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await currentUser();
      if (!cancelled && result.ok) setUserId(result.user.$id);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    const [chapterList, taskList, mediaList] = await Promise.all([listChapters(host), listTasks(host, stage), listMedia(host)]);
    setChapters(chapterList);
    setTasks(taskList);
    setMedia(mediaList);
    if (userId) setProgress(await getProgress(userId, host));
  }, [host, stage, userId]);

  useEffect(() => {
    setChapters(null);
    void load();
  }, [load]);

  const continueEntry = useMemo(() => {
    const stored = readContinue();
    return stored && stored.countryCode === host ? stored : null;
  }, [host]);

  /** Prefer real tasks; fall back to the chapter that matters most right now. */
  const todoNow = useMemo(() => {
    const open = tasks.filter((task) => !savedTasks[`gb:${task.taskId}`] && !progress[task.taskId]);
    return (open.length ? open : tasks).slice(0, 3);
  }, [tasks, savedTasks, progress]);

  const completed = useMemo(() => Object.values(progress).filter(Boolean).length, [progress]);
  const totalPoints = useMemo(() => (chapters ?? []).reduce((sum, chapter) => sum + chapter.factCount, 0), [chapters]);
  const loaded = chapters !== null;

  async function completeTask(task: GreenbookTask) {
    const next = !progress[task.taskId];
    setProgress((current) => ({ ...current, [task.taskId]: next }));
    toggleTask(`gb:${task.taskId}`);
    setToast(next ? "Marked done — saved to your account" : "Marked not done");
    window.setTimeout(() => setToast(null), 2200);
    if (userId) await saveProgress(userId, task.taskId, next, { chapterId: task.chapterId, countryCode: host });
    void load();
  }

  const openChapter = (chapterId: string) => {
    const title = CHAPTER_META[chapterId]?.title ?? chapterId;
    writeContinue({ countryCode: host, chapterId, title });
    nav.push("greenbookEntry", { entryId: `entry_${host}_${chapterId}`, countryCode: host, chapterId });
  };

  return (
    <div className="flex h-full flex-col">
      <ScreenHeader
        title="Greenbook"
        onBack={onBack}
        right={
          <button onClick={() => setSwitcherOpen(true)} className="flex min-h-[44px] items-center gap-1.5 rounded-full border border-line px-3 text-[13px] font-semibold text-ink">
            <span>{COUNTRIES[host].flag}</span>
            <Icon name="chevron" size={14} />
          </button>
        }
      />

      <Scroll className="px-4 pb-8 pt-4">
        {offline && (
          <div className="mb-3 flex items-center gap-2 rounded-[12px] bg-ink px-3 py-2.5 text-[12px] font-medium text-white">
            <Icon name="signal" size={15} /> Offline — showing what was already loaded
          </div>
        )}

        {/* ------------------------------- Cover ------------------------------- */}
        <Card tone="ink" className="mb-5 overflow-hidden p-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/50">Living Greenbook</p>
              <h1 className="mt-1 text-[22px] font-bold leading-tight text-white">
                {COUNTRIES[home].name.split(" ")[0]} → {COUNTRIES[host].name.split(" ")[0]}
              </h1>
              <p className="mt-1 text-[12px] text-white/70">{journey.university || "Your university"}</p>
              {journey.city && <p className="text-[12px] text-white/50">{journey.city}</p>}
            </div>
            <ProgressRing
              value={tasks.length ? Math.round((completed / Math.max(tasks.length, 1)) * 100) : 0}
              size={54}
              stroke={5}
              label={<span className="text-[11px] font-bold text-white">{tasks.length ? `${completed}/${tasks.length}` : "—"}</span>}
            />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-semibold text-white">{STAGE_LABEL[stage]}</span>
            <span className="rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-semibold text-white">Day {Math.max(journey.dayCount, 0)}</span>
            <span className="rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-semibold text-white">{COUNTRIES[host].languages[0]}</span>
            {loaded && <span className="rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-semibold text-white">{totalPoints} verified points</span>}
          </div>
        </Card>

        {/* ---------------------------- 3 things now ---------------------------- */}
        <Section title="Do this now">
          {!loaded ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
            </div>
          ) : todoNow.length === 0 ? (
            <Card className="p-3.5">
              <p className="text-[13px] text-muted">
                No verified task list for {COUNTRIES[host].name} yet. The chapters below show exactly what has been verified so far.
              </p>
            </Card>
          ) : (
            <div className="flex flex-col gap-2">
              {todoNow.map((task) => {
                const done = Boolean(progress[task.taskId]);
                return (
                  <Card key={task.taskId} className="p-3.5">
                    <div className="flex items-start gap-3">
                      <button
                        onClick={() => void completeTask(task)}
                        aria-label={done ? "Mark not done" : "Mark done"}
                        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition ${
                          done ? "border-ink bg-ink text-white" : "border-line bg-surface text-transparent"
                        }`}
                      >
                        <Icon name="check" size={13} />
                      </button>
                      <div className="min-w-0 flex-1">
                        <p className={`text-[14px] font-semibold leading-snug ${done ? "text-muted line-through" : "text-ink"}`}>{task.title}</p>
                        {task.detail && <p className="mt-0.5 text-[12px] leading-snug text-muted">{task.detail}</p>}
                        <button
                          onClick={() => openChapter(task.chapterId)}
                          className="mt-1.5 min-h-[32px] text-[12px] font-semibold text-primary"
                        >
                          Open {CHAPTER_META[task.chapterId]?.title ?? "chapter"} →
                        </button>
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </Section>

        {/* -------------------------- Continue reading -------------------------- */}
        {continueEntry && (
          <Section title="Continue reading">
            <Card onClick={() => openChapter(continueEntry.chapterId)} className="flex items-center gap-3 p-3.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-primary-soft text-primary">
                <Icon name={(CHAPTER_META[continueEntry.chapterId]?.icon ?? "text") as "text"} size={18} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-semibold text-ink">{continueEntry.title}</span>
                <span className="block text-[12px] text-muted">Pick up where you stopped</span>
              </span>
              <Icon name="chevron" size={16} />
            </Card>
          </Section>
        )}

        {/* ------------------------------- For you ------------------------------ */}
        {media.length > 0 && (
          <Section
            title="Student reality"
            action={
              <button onClick={() => nav.push("greenbookReality", { countryCode: host })} className="min-h-[44px] text-[12px] font-semibold text-primary">
                See all
              </button>
            }
          >
            <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-1">
              {media.slice(0, 4).map((item) => (
                <Card key={item.mediaId} onClick={() => nav.push("greenbookReality", { countryCode: host })} className="w-[190px] shrink-0 overflow-hidden">
                  <div className="flex h-[100px] items-center justify-center bg-canvas">
                    {item.thumbnailUrl ? (
                      <img src={item.thumbnailUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
                    ) : (
                      <Icon name="camera" size={22} />
                    )}
                  </div>
                  <div className="p-2.5">
                    <p className="line-clamp-2 text-[12px] font-semibold leading-snug text-ink">{item.title}</p>
                    <p className="mt-1 text-[11px] text-muted">{item.creator ?? item.platform}</p>
                    <span className="mt-1.5 inline-block">
                      <Badge tone={item.trustTier === "official" ? "success" : item.trustTier === "verified_student" ? "primary" : "muted"}>
                        {item.trustTier.replace(/_/g, " ")}
                      </Badge>
                    </span>
                  </div>
                </Card>
              ))}
            </div>
          </Section>
        )}

        {/* ------------------------------ Chapters ------------------------------ */}
        <Section
          title="Your chapters"
          action={
            <button onClick={() => nav.push("greenbookBrowse", { countryCode: host })} className="min-h-[44px] text-[12px] font-semibold text-primary">
              Browse all
            </button>
          }
        >
          {!loaded ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
            </div>
          ) : (
            chapters!
              .filter((chapter) => chapter.factCount > 0)
              .slice(0, 3)
              .map((chapter) => (
                <ChapterRow
                  key={chapter.chapterId}
                  title={chapter.title}
                  purpose={chapter.purpose}
                  factCount={chapter.factCount}
                  icon={CHAPTER_META[chapter.chapterId]?.icon ?? "text"}
                  onClick={() => openChapter(chapter.chapterId)}
                />
              ))
          )}
          {loaded && chapters!.every((chapter) => chapter.factCount === 0) && (
            <Card className="p-3.5">
              <p className="text-[13px] font-semibold text-ink">Nothing verified for {COUNTRIES[host].name} yet</p>
              <p className="mt-1 text-[12px] leading-relaxed text-muted">
                The ingestion pipeline only publishes guidance that traces to a registered official source. No source for this country has produced a verified
                fact yet — so there is nothing to show, rather than something invented.
              </p>
            </Card>
          )}
        </Section>

        <Button variant="outline" full onClick={() => nav.push("greenbookAsk", { countryCode: host, chapter: null })}>
          <Icon name="chat" size={16} /> Ask this Greenbook
        </Button>

        <p className="mt-4 text-[11px] leading-relaxed text-muted">
          Guidance here is contextual, not a rule about people. Administrative facts come from a Tier A or B official source and carry a last-checked date.
        </p>
      </Scroll>

      {toast && <Toast text={toast} />}

      {switcherOpen && (
        <CountrySwitcher
          host={host}
          onClose={() => setSwitcherOpen(false)}
          onPick={(code) => {
            setRoute(home, code);
            setSwitcherOpen(false);
          }}
        />
      )}
    </div>
  );
}

/* ----------------------------- Country switch ------------------------------ */

function CountrySwitcher({ host, onClose, onPick }: { host: CountryCode; onClose: () => void; onPick: (code: CountryCode) => void }) {
  const codes = Object.keys(COUNTRIES) as CountryCode[];
  return (
    <div className="absolute inset-0 z-50 flex items-end" onClick={onClose}>
      <div className="absolute inset-0 bg-ink/40" />
      <div className="yy-fade relative max-h-[70vh] w-full overflow-y-auto rounded-t-[14px] bg-surface p-5 pb-7" onClick={(event) => event.stopPropagation()}>
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-line" />
        <h3 className="mb-3 text-[16px] font-bold text-ink">Switch host country</h3>
        <p className="mb-3 text-[12px] text-muted">Your origin stays the same. Each country has its own verified facts, tasks and phrases.</p>
        {codes.map((code) => (
          <button
            key={code}
            data-testid={`country-option-${code}`}
            onClick={() => onPick(code)}
            className={`flex w-full min-h-[52px] items-center gap-3 border-b border-line px-1 text-left last:border-0 ${code === host ? "opacity-40" : ""}`}
          >
            <span className="text-[20px]">{COUNTRIES[code].flag}</span>
            <span className="flex-1">
              <span className="block text-[14px] font-semibold text-ink">{COUNTRIES[code].name}</span>
              <span className="block text-[11px] text-muted">{COUNTRIES[code].languages.join(" · ")}</span>
            </span>
            {code === host && <span className="text-[11px] font-semibold text-muted">current</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

export default Greenbook;
