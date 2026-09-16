import { useEffect, useMemo, useState } from "react";
import { Scroll } from "../../components/shell";
import { Avatar, Badge, Card, Chip, EmptyState, Skeleton } from "../../components/ui";
import { Icon } from "../../components/icons";
import { loadDiscoverableProfiles, loadBlockedIds } from "../../lib/appwrite/social";
import { rankProfiles, bandFor, matchSummary } from "../../lib/phase5/matching";
import { ROLE_LABELS, type ExchangeRole, type ScoredProfile, type SocialProfile } from "../../lib/phase5/contract";
import { COUNTRIES } from "../../data/countries";
import { campusFor } from "../../data/campuses";
import type { ViewerContext } from "../../lib/phase5/matching";

/**
 * People discovery.
 *
 * The ranking is deterministic and every reason shown is a fact about the two
 * profiles — "Also at UM", "Speaks Vietnamese", "Shared 3 places". There is no
 * opaque compatibility percentage, because a number nobody can audit is not a
 * good basis for deciding who to trust in a new country.
 *
 * A profile only appears here if its owner turned discoverability on, which is
 * what grants the row its authenticated-read permission in the first place.
 */

export interface PeopleTabProps {
  viewer: ViewerContext;
  onOpenProfile: (profile: SocialProfile) => void;
}

const ROLE_FILTERS: { key: ExchangeRole | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "local", label: "Local" },
  { key: "current_exchange", label: "Exchange" },
  { key: "incoming", label: "Incoming" },
  { key: "returned", label: "Returned" },
];

export function PeopleTab({ viewer, onOpenProfile }: PeopleTabProps) {
  const [profiles, setProfiles] = useState<SocialProfile[] | null>(null);
  const [blocked, setBlocked] = useState<Set<string>>(new Set());
  const [role, setRole] = useState<ExchangeRole | "all">("all");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setProfiles(null);
    setFailed(false);
    void (async () => {
      const [profileResult, blockedIds] = await Promise.all([
        loadDiscoverableProfiles({ hostCountry: viewer.hostCountry, viewerId: viewer.userId }),
        viewer.userId ? loadBlockedIds(viewer.userId) : Promise.resolve(new Set<string>()),
      ]);
      if (cancelled) return;
      if (!profileResult.ok) {
        setFailed(true);
        setProfiles([]);
        return;
      }
      setBlocked(blockedIds);
      setProfiles(profileResult.value);
    })();
    return () => {
      cancelled = true;
    };
  }, [viewer.hostCountry, viewer.userId]);

  const ranked: ScoredProfile[] = useMemo(() => {
    if (!profiles) return [];
    const filtered = role === "all" ? profiles : profiles.filter((profile) => profile.role === role);
    return rankProfiles(filtered, { viewer: { ...viewer, blockedIds: blocked } });
  }, [profiles, role, viewer, blocked]);

  return (
    <>
      <div className="mt-3 flex gap-2 overflow-x-auto scroll-area px-5 pb-2">
        {ROLE_FILTERS.map((entry) => (
          <Chip key={entry.key} tone="primary" active={role === entry.key} onClick={() => setRole(entry.key)}>
            {entry.label}
          </Chip>
        ))}
      </div>

      <Scroll className="px-5 pb-6">
        <p className="mb-3 text-[12px] text-muted">
          Matched on university, city, field, interests, languages and the journey you share. Every reason is listed — nothing is scored by a black box.
        </p>

        {profiles === null && (
          <div className="space-y-3">
            {[0, 1, 2].map((key) => (
              <Skeleton key={key} className="h-[92px] w-full" />
            ))}
          </div>
        )}

        {failed && <EmptyState icon="alert" title="Could not load students" body="Check your connection and try again." />}

        {profiles !== null && !failed && ranked.length === 0 && (
          <EmptyState
            icon="users"
            title={role === "all" ? "No students here yet" : "Nobody in this group"}
            body={
              role === "all"
                ? "Students appear once they turn discoverability on. You can still read the community feed."
                : "Try a different filter."
            }
          />
        )}

        {ranked.length > 0 && (
          <div className="space-y-3">
            {ranked.map((entry) => (
              <PersonCard key={entry.profile.userId} scored={entry} onOpen={() => onOpenProfile(entry.profile)} />
            ))}
          </div>
        )}
      </Scroll>
    </>
  );
}

function PersonCard({ scored, onOpen }: { scored: ScoredProfile; onOpen: () => void }) {
  const { profile, score, reasons } = scored;
  const campus = campusFor(profile.universityId);
  const homeFlag = profile.homeCountry ? COUNTRIES[profile.homeCountry as keyof typeof COUNTRIES]?.flag : "";
  const hostFlag = profile.hostCountry ? COUNTRIES[profile.hostCountry as keyof typeof COUNTRIES]?.flag : "";

  return (
    <Card className="p-4" onClick={onOpen}>
      <div className="flex items-start gap-3">
        <Avatar initials={profile.initials} color={profile.color} size={48} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="text-[15px] font-bold text-ink">{profile.displayName}</h3>
            {profile.isDemoSeed && <Badge tone="muted">Demo</Badge>}
            {profile.localHelper && <Badge tone="success">Local</Badge>}
          </div>
          <p className="mt-0.5 truncate text-[12px] text-muted">
            {homeFlag} {profile.homeCountry} → {hostFlag} {profile.hostCountry}
            {campus ? ` · ${campus.universityId.toUpperCase()}` : profile.universityId ? ` · ${profile.universityId}` : ""}
          </p>
          {profile.major && <p className="text-[12px] text-muted">{profile.major}</p>}

          <div className="mt-2 flex flex-wrap gap-1.5">
            {reasons.slice(0, 3).map((reason) => (
              <Badge key={reason.label} tone="primary">
                {reason.label}
              </Badge>
            ))}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[11px] font-semibold text-muted">{bandFor(score)}</p>
          <Icon name="chevron" size={16} />
        </div>
      </div>
    </Card>
  );
}

export { matchSummary, ROLE_LABELS };
