import { useEffect, useState } from "react";
import { ScreenHeader, Scroll } from "../../components/shell";
import { Avatar, Badge, Button, Card, EmptyState, Notice, Skeleton } from "../../components/ui";
import { Icon } from "../../components/icons";
import { formatDistance } from "../../lib/appwrite/explore";
import { loadAuthorCounts } from "../../lib/appwrite/social";
import { COUNTRIES } from "../../data/countries";
import { campusFor } from "../../data/campuses";
import type { Place, SocialProfile } from "../../lib/phase5/contract";

/**
 * "View shared map" — a student's contributed places.
 *
 * This is the safe form of a people map. It shows places the student chose to
 * write about, in the order they are near the campus — it is not a location
 * history and it cannot be turned into one, because a contribution only records
 * the place it is about, never where the author was standing.
 *
 * The distinction the brief insists on, made concrete: a shared place is a
 * contribution, not a trace.
 */

export interface PlacesForAuthorProps {
  profile: SocialProfile;
  places: Place[];
  onBack: () => void;
  onOpenOnMap: () => void;
}

export function PlacesForAuthor({ profile, places, onBack, onOpenOnMap }: PlacesForAuthorProps) {
  const [sharedCount, setSharedCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadAuthorCounts([profile.userId]).then((counts) => {
      if (!cancelled) setSharedCount(counts.get(profile.userId)?.placesShared ?? 0);
    });
    return () => {
      cancelled = true;
    };
  }, [profile.userId]);

  const campus = campusFor(profile.universityId);
  const homeFlag = profile.homeCountry ? COUNTRIES[profile.homeCountry as keyof typeof COUNTRIES]?.flag : "";
  const hostFlag = profile.hostCountry ? COUNTRIES[profile.hostCountry as keyof typeof COUNTRIES]?.flag : "";

  // Seeded contributions point at reviewed anchors; show those the student's
  // university actually covers, nearest first.
  const candidate = places
    .filter((place) => !campus || place.campusId === campus.campusId || place.universityId === profile.universityId)
    .filter((place) => place.isDemoSeed && (place.studentStories > 0 || place.source === "seed_pack_researched"))
    .sort((a, b) => a.distanceFromCampusM - b.distanceFromCampusM)
    .slice(0, 8);

  return (
    <div className="flex h-full flex-col bg-canvas">
      <ScreenHeader title="Shared places" onBack={onBack} />
      <Scroll className="px-5 py-4">
        <div className="flex items-center gap-3">
          <Avatar initials={profile.initials} color={profile.color} size={48} />
          <div className="min-w-0">
            <p className="text-[15px] font-bold text-ink">{profile.displayName}</p>
            <p className="text-[12px] text-muted">
              {homeFlag} {profile.homeCountry} → {hostFlag} {profile.hostCountry}
              {campus ? ` · ${campus.universityId.toUpperCase()}` : ""}
            </p>
          </div>
        </div>

        <div className="mt-4">
          <Notice
            tone="primary"
            icon="info"
            title="Places they wrote about"
            body="This is a list of contributions, not a location history. YapYep does not record where anyone has been."
          />
        </div>

        <div className="mt-4 flex items-baseline justify-between">
          <h2 className="text-[15px] font-bold text-ink">Places near {campus?.universityId.toUpperCase() ?? profile.city}</h2>
          {sharedCount !== null && <span className="text-[12px] text-muted">{sharedCount} shared</span>}
        </div>

        {sharedCount === null && (
          <div className="mt-3 space-y-3">
            {[0, 1, 2].map((key) => (
              <Skeleton key={key} className="h-[72px] w-full" />
            ))}
          </div>
        )}

        {sharedCount !== null && candidate.length === 0 && (
          <EmptyState icon="map" title="No shared places yet" body="They have not pinned a place in this city." />
        )}

        {candidate.length > 0 && (
          <div className="mt-3 space-y-3">
            {candidate.map((place) => (
              <Card key={place.id} className="p-4">
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-canvas text-[13px] font-extrabold text-ink">
                    {place.name.slice(0, 1)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-bold text-ink">{place.name}</p>
                    <p className="mt-0.5 text-[12px] text-muted">
                      {place.category} · {formatDistance(place.distanceFromCampusM)} from campus
                    </p>
                  </div>
                  {place.studentStories > 0 && <Badge tone="primary">{place.studentStories}</Badge>}
                </div>
              </Card>
            ))}
          </div>
        )}

        <div className="mt-5">
          <Button variant="outline" full onClick={onOpenOnMap}>
            <Icon name="map" size={16} /> Open Explore
          </Button>
        </div>
      </Scroll>
    </div>
  );
}
