/**
 * Browse Chapters.
 *
 * Every chapter is listed, including the empty ones. An empty chapter is real
 * information — it tells the student (and the team) that nothing has been
 * verified for this country in this area yet, which is far more useful than
 * silently omitting it and implying the manual is complete.
 */
import { useEffect, useState } from "react";
import { ScreenHeader, Scroll } from "../../components/shell";
import { Card, Skeleton } from "../../components/ui";
import { Icon } from "../../components/icons";
import { ChapterRow } from "../../components/greenbook/bits";
import { useNav } from "../../context/NavContext";
import { COUNTRIES, type CountryCode } from "../../data/countries";
import { CHAPTER_META, listChapters, type GreenbookChapter } from "../../lib/greenbook";

export function ChapterBrowse({ countryCode, onBack }: { countryCode: string; onBack: () => void }) {
  const nav = useNav();
  const [chapters, setChapters] = useState<GreenbookChapter[] | null>(null);
  const host = countryCode as CountryCode;

  useEffect(() => {
    let cancelled = false;
    setChapters(null);
    void listChapters(countryCode).then((result) => {
      if (!cancelled) setChapters(result);
    });
    return () => {
      cancelled = true;
    };
  }, [countryCode]);

  const withData = chapters?.filter((chapter) => chapter.factCount > 0).length ?? 0;

  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title={`${COUNTRIES[host]?.name ?? countryCode} chapters`} onBack={onBack} />
      <Scroll className="px-4 pb-8 pt-4">
        {chapters === null ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-16" />
            ))}
          </div>
        ) : (
          <>
            <Card className="mb-4 p-3.5">
              <p className="text-[13px] font-semibold text-ink">
                {withData} of {chapters.length} chapters have verified guidance
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-muted">
                Chapters without a number have no verified official source yet. They stay visible so nothing looks more complete than it is.
              </p>
            </Card>

            {chapters.map((chapter) => (
              <ChapterRow
                key={chapter.chapterId}
                title={chapter.title}
                purpose={chapter.purpose}
                factCount={chapter.factCount}
                icon={CHAPTER_META[chapter.chapterId]?.icon ?? "text"}
                onClick={() => nav.push("greenbookEntry", { entryId: `entry_${countryCode}_${chapter.chapterId}`, countryCode, chapterId: chapter.chapterId })}
              />
            ))}
          </>
        )}

        <div className="mt-4 flex items-start gap-2 text-[11px] leading-relaxed text-muted">
          <Icon name="info" size={14} />
          <span>Chapter names describe the student journey, not a topic menu. The same route in reverse can produce different guidance.</span>
        </div>
      </Scroll>
    </div>
  );
}

export default ChapterBrowse;
