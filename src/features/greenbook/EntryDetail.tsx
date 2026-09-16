/**
 * Entry Detail — the field-notebook page.
 *
 * One chapter for one country, read top to bottom in the order a student
 * actually needs it: what to know, what to do, what to say, what to watch, ask a
 * question, practise it, then the sources that back all of it.
 *
 * Every fact carries its own trust state. That is deliberate: a single chapter
 * can legitimately mix a Tier A immigration rule with a community tip, and
 * flattening them into one badge would make the community tip look official.
 */
import { useEffect, useMemo, useState } from "react";
import { ScreenHeader, Scroll } from "../../components/shell";
import { Badge, Button, Card, EmptyState, Skeleton } from "../../components/ui";
import { Icon } from "../../components/icons";
import { Section, SourcesDrawer, TrustBadge, formatDate, trustText } from "../../components/greenbook/bits";
import { useJourney } from "../../context/JourneyContext";
import { useNav } from "../../context/NavContext";
import { COUNTRIES, type CountryCode } from "../../data/countries";
import {
  CHAPTER_META,
  getEntry,
  listFacts,
  listMedia,
  listPhrases,
  trustStateOf,
  type GreenbookEntry,
  type GreenbookFact,
  type GreenbookSource,
  type MediaResource,
  type StudentPhrase,
} from "../../lib/greenbook";
import { writeContinue } from "./Greenbook";

/** Chapter → the YapSim scenario domain that best rehearses it. */
const CHAPTER_DOMAIN: Record<string, string> = {
  get_ready: "campus",
  land_and_settle: "transport",
  study_here: "professor",
  speak_and_understand: "food",
  money_and_pay: "banking",
  live_here: "housing",
  move_around: "transport",
  stay_safe_and_healthy: "health",
  culture_and_people: "food",
  student_reality: "food",
};

export function EntryDetail({ entryId, onBack }: { entryId: string; onBack: () => void }) {
  const nav = useNav();
  const { journey } = useJourney();
  const [entry, setEntry] = useState<GreenbookEntry | null>(null);
  const [facts, setFacts] = useState<GreenbookFact[]>([]);
  const [sources, setSources] = useState<GreenbookSource[]>([]);
  const [phrases, setPhrases] = useState<StudentPhrase[]>([]);
  const [media, setMedia] = useState<MediaResource[]>([]);
  const [loading, setLoading] = useState(true);
  const [sourcesOpen, setSourcesOpen] = useState(false);

  const countryCode = entry?.countryCode ?? (entryId.split("_")[1] as CountryCode) ?? (journey.host as CountryCode);
  const chapterId = entry?.chapterId ?? entryId.split("_").slice(2).join("_");
  const title = CHAPTER_META[chapterId]?.title ?? entry?.title ?? "Chapter";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const [loadedEntry, phraseList, mediaList] = await Promise.all([getEntry(entryId), listPhrases(countryCode, chapterId), listMedia(countryCode, chapterId)]);
      if (cancelled) return;
      setEntry(loadedEntry);
      setPhrases(phraseList);
      setMedia(mediaList);
      if (loadedEntry) {
        // The entry carries source ids; the facts carry the trust states.
        const chapterFacts = await listFacts({ countryCode, chapter: chapterId, limit: 100 });
        if (cancelled) return;
        setFacts(chapterFacts);
        setSources(loadedEntry.sources);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [entryId, countryCode, chapterId]);

  useEffect(() => {
    if (entry) writeContinue({ countryCode, chapterId, title });
  }, [entry, countryCode, chapterId, title]);

  const grouped = useMemo(() => {
    const byChapter = new Map<string, GreenbookFact[]>();
    for (const fact of facts) {
      const list = byChapter.get(fact.chapter) ?? [];
      list.push(fact);
      byChapter.set(fact.chapter, list);
    }
    return byChapter;
  }, [facts]);

  const staleCount = facts.filter((fact) => trustStateOf(fact) === "stale").length;
  const lastChecked = facts.map((fact) => fact.checkedAt).filter(Boolean).sort().at(-1) ?? entry?.lastVerifiedAt ?? null;

  function practiceThis() {
    nav.push("sim", {
      fromGreenbook: true,
      greenbook: {
        countryCode,
        chapterId,
        entryTitle: title,
        focus: facts[0]?.claim ?? "",
        domain: CHAPTER_DOMAIN[chapterId] ?? "campus",
        hostLanguage: COUNTRIES[countryCode as CountryCode]?.languages[0] ?? "the local language",
      },
    });
  }

  return (
    <div className="flex h-full flex-col">
      <ScreenHeader
        title={title}
        onBack={onBack}
        right={
          <button onClick={() => setSourcesOpen(true)} className="flex min-h-[44px] items-center gap-1.5 rounded-full border border-line px-3 text-[12px] font-semibold text-ink">
            <Icon name="info" size={14} /> {sources.length}
          </button>
        }
      />

      <Scroll className="px-4 pb-8 pt-4">
        {loading ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-20" />
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
          </div>
        ) : facts.length === 0 ? (
          <EmptyState
            icon="info"
            title={`Nothing verified for ${COUNTRIES[countryCode as CountryCode]?.name ?? countryCode} here yet`}
            body="No registered official source has produced a verified fact for this chapter. Rather than fill the gap with something plausible, the Greenbook shows nothing."
          />
        ) : (
          <>
            {/* --------------------------- What to know --------------------------- */}
            <Section title="What to know">
              {facts.map((fact) => (
                <Card key={fact.factId} className="mb-2 p-3.5">
                  <div className="mb-1.5 flex items-center gap-2">
                    <TrustBadge state={trustStateOf(fact)} />
                    <span className="text-[11px] text-muted">Tier {fact.authorityLevel}</span>
                  </div>
                  <p className="text-[14px] leading-relaxed text-ink">{fact.claim}</p>
                  {fact.evidenceQuote && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[11px] font-semibold text-primary">Show the source sentence</summary>
                      <p className="mt-1.5 border-l-2 border-line pl-2.5 text-[12px] italic leading-relaxed text-muted">{fact.evidenceQuote}</p>
                    </details>
                  )}
                </Card>
              ))}
            </Section>

            {/* ----------------------------- Do this ------------------------------ */}
            {facts.some((fact) => fact.action) && (
              <Section title="Do this">
                <Card className="p-3.5">
                  {facts
                    .filter((fact) => fact.action)
                    .map((fact) => (
                      <div key={fact.factId} className="flex items-start gap-2.5 border-b border-line py-2.5 first:pt-0 last:border-0 last:pb-0">
                        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-canvas text-muted">
                          <Icon name="check" size={12} />
                        </span>
                        <p className="text-[13px] leading-relaxed text-ink">{fact.action}</p>
                      </div>
                    ))}
                </Card>
              </Section>
            )}

            {/* ----------------------------- Say this ----------------------------- */}
            {phrases.length > 0 && (
              <Section title="Say this" action={<button onClick={() => nav.push("greenbookPhrases", { countryCode, chapter: chapterId })} className="min-h-[44px] text-[12px] font-semibold text-primary">Practise</button>}>
                {phrases.slice(0, 3).map((phrase) => (
                  <Card key={phrase.phraseId} className="mb-2 p-3.5">
                    <p className="text-[15px] font-semibold text-ink">{phrase.localText}</p>
                    {phrase.romanization && <p className="mt-0.5 text-[12px] italic text-muted">{phrase.romanization}</p>}
                    <p className="mt-1 text-[13px] text-ink">{phrase.translation}</p>
                    {phrase.whenToUse && <p className="mt-1.5 text-[11px] leading-relaxed text-muted">Use it when: {phrase.whenToUse}</p>}
                    {phrase.whenNotToUse && <p className="text-[11px] leading-relaxed text-warning">Not when: {phrase.whenNotToUse}</p>}
                    {phrase.register && (
                      <span className="mt-1.5 inline-block">
                        <Badge tone="muted">{phrase.register}</Badge>
                      </span>
                    )}
                  </Card>
                ))}
              </Section>
            )}

            {/* ------------------------------ Watch ------------------------------- */}
            {media.length > 0 && (
              <Section title="Watch">
                {media.slice(0, 2).map((item) => (
                  <Card key={item.mediaId} className="mb-2 overflow-hidden">
                    {item.embedAllowed && item.platform === "youtube" && item.externalId ? (
                      <div className="aspect-video w-full">
                        <iframe
                          title={item.title}
                          src={`https://www.youtube-nocookie.com/embed/${item.externalId}`}
                          className="h-full w-full"
                          loading="lazy"
                          allowFullScreen
                        />
                      </div>
                    ) : (
                      <a href={item.url} target="_blank" rel="noreferrer noopener" className="flex items-center gap-3 p-3.5">
                        <span className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-canvas">
                          <Icon name="camera" size={18} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] font-semibold text-ink">{item.title}</span>
                          <span className="block text-[11px] text-muted">{item.creator ?? item.platform}</span>
                        </span>
                        <Icon name="chevron" size={16} />
                      </a>
                    )}
                    <div className="flex items-center gap-2 border-t border-line px-3.5 py-2">
                      <Badge tone={item.trustTier === "official" ? "success" : item.trustTier === "verified_student" ? "primary" : "muted"}>
                        {item.trustTier.replace(/_/g, " ")}
                      </Badge>
                      {item.trustTier !== "official" && <span className="text-[11px] text-muted">A student view — it never overrides an official rule.</span>}
                    </div>
                  </Card>
                ))}
              </Section>
            )}

            {/* --------------------------- Ask / Practice -------------------------- */}
            <Section title="Go further">
              <div className="flex flex-col gap-2">
                <Button variant="outline" full onClick={() => nav.push("greenbookAsk", { countryCode, chapter: chapterId })}>
                  <Icon name="chat" size={16} /> Ask YapYep about this
                </Button>
                <Button variant="soft" full onClick={practiceThis}>
                  <Icon name="practice" size={16} /> Practice this
                </Button>
              </div>
            </Section>

            {/* ------------------------------ Sources ----------------------------- */}
            <Section title="Sources & freshness">
              <Card className="p-3.5">
                <button onClick={() => setSourcesOpen(true)} className="flex w-full items-center justify-between text-left">
                  <span>
                    <span className="block text-[13px] font-semibold text-ink">{sources.length} official source{sources.length === 1 ? "" : "s"}</span>
                    <span className="mt-0.5 block text-[11px] text-muted">Last checked {formatDate(lastChecked)}</span>
                  </span>
                  <Icon name="chevron" size={16} />
                </button>
                {staleCount > 0 && (
                  <p className="mt-2 border-t border-line pt-2 text-[11px] text-error">
                    {staleCount} point{staleCount === 1 ? "" : "s"} in this chapter may be out of date.
                  </p>
                )}
              </Card>
            </Section>

            <p className="mt-2 text-[11px] leading-relaxed text-muted">
              Trust states: {["official", "university", "community", "stale", "needs_review"].map((state) => trustText(state as "official")).join(" · ")}. Cultural
              guidance is contextual and probabilistic — it is never a claim about what a nationality is like.
            </p>
          </>
        )}
      </Scroll>

      <SourcesDrawer open={sourcesOpen} onClose={() => setSourcesOpen(false)} sources={sources} />
    </div>
  );
}

export default EntryDetail;
