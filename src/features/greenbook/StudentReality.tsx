/**
 * Student Reality — curated media.
 *
 * The trust tier is the point of this screen, not the video. A student vlog and
 * a ministry video look identical in a player, so each card states which it is
 * and the screen states the precedence rule once, plainly: a student video never
 * overrides an official rule.
 *
 * Videos are embedded from the original platform and never mirrored. Anything
 * that is not explicitly embeddable is a link out, not a re-host.
 */
import { useEffect, useState } from "react";
import { ScreenHeader, Scroll } from "../../components/shell";
import { Badge, Card, EmptyState, Skeleton } from "../../components/ui";
import { Icon } from "../../components/icons";
import { formatDate } from "../../components/greenbook/bits";
import { COUNTRIES, type CountryCode } from "../../data/countries";
import { listMedia, type MediaResource } from "../../lib/greenbook";

const TIER_TONE: Record<string, "success" | "primary" | "warning" | "muted"> = {
  official: "success",
  verified_student: "primary",
  community_recommended: "warning",
  curated_public: "muted",
  unverified: "muted",
};

const TIER_MEANING: Record<string, string> = {
  official: "Published by the university or a government body.",
  verified_student: "A student account we could confirm belongs to a student here.",
  community_recommended: "Suggested by students, not independently checked.",
  curated_public: "Publicly available and relevant, but not endorsed.",
  unverified: "No verification. Treat as a lead, not a fact.",
};

export function StudentReality({ countryCode, onBack }: { countryCode: string; onBack: () => void }) {
  const [media, setMedia] = useState<MediaResource[] | null>(null);
  const host = countryCode as CountryCode;

  useEffect(() => {
    let cancelled = false;
    setMedia(null);
    void listMedia(countryCode).then((result) => {
      if (!cancelled) setMedia(result);
    });
    return () => {
      cancelled = true;
    };
  }, [countryCode]);

  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title="Student reality" onBack={onBack} />
      <Scroll className="px-4 pb-8 pt-4">
        <Card className="mb-4 p-3.5">
          <p className="text-[12px] leading-relaxed text-muted">
            What students actually filmed. A student video is useful context and it never overrides an official rule — when they disagree, the official source
            wins and the Greenbook says so.
          </p>
        </Card>

        {media === null ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-48" />
            <Skeleton className="h-48" />
          </div>
        ) : media.length === 0 ? (
          <EmptyState
            icon="camera"
            title="No student media curated yet"
            body={`Nothing has been reviewed for ${COUNTRIES[host]?.name ?? countryCode}. Videos are only listed when their creator and source can be named.`}
          />
        ) : (
          media.map((item) => {
            const embeddable = item.embedAllowed && item.platform === "youtube" && item.externalId;
            return (
              <Card key={item.mediaId} className="mb-3 overflow-hidden">
                {embeddable ? (
                  <div className="aspect-video w-full bg-canvas">
                    <iframe
                      title={item.title}
                      src={`https://www.youtube-nocookie.com/embed/${item.externalId}`}
                      className="h-full w-full"
                      loading="lazy"
                      allowFullScreen
                    />
                  </div>
                ) : (
                  <a href={item.url} target="_blank" rel="noreferrer noopener" className="flex h-[120px] items-center justify-center gap-2 bg-canvas text-muted">
                    <Icon name="camera" size={20} />
                    <span className="text-[12px] font-medium">Open on {item.platform}</span>
                  </a>
                )}

                <div className="p-3.5">
                  <p className="text-[14px] font-semibold leading-snug text-ink">{item.title}</p>
                  <p className="mt-0.5 text-[12px] text-muted">
                    {item.creator ?? "Unknown creator"}
                    {item.language ? ` · ${item.language}` : ""}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <Badge tone={TIER_TONE[item.trustTier] ?? "muted"}>{item.trustTier.replace(/_/g, " ")}</Badge>
                    {item.chapter && <Badge tone="muted">{item.chapter.replace(/_/g, " ")}</Badge>}
                  </div>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-muted">{TIER_MEANING[item.trustTier] ?? "Provenance not stated."}</p>
                </div>
              </Card>
            );
          })
        )}
      </Scroll>
    </div>
  );
}

export default StudentReality;
