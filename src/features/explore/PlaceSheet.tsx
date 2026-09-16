import { useEffect, useState } from "react";
import { Avatar, Badge, Button, Card, EmptyState, Notice, Skeleton } from "../../components/ui";
import { Icon } from "../../components/icons";
import { loadContributions, formatDistance } from "../../lib/appwrite/explore";
import { EXPLORE_CATEGORIES, type Place, type PlaceContribution } from "../../lib/phase5/contract";
import { campusFor } from "../../data/campuses";

/**
 * The place bottom sheet — where Explore and Connect actually meet.
 *
 * The two layers are rendered as two clearly separated blocks on purpose:
 *
 *   What OpenStreetMap records   → objective: name, address, category, position
 *   What students experienced    → community: notes, photos, visit context
 *
 * A community note never appears above the objective facts and never overrides
 * them, and the source line says which is which. That separation is the same rule
 * the Greenbook gate enforces server-side; this is its UI half.
 */

export interface PlaceSheetProps {
  place: Place;
  saved: boolean;
  busy: boolean;
  onSave: () => void;
  onClose: () => void;
  onAddExperience: () => void;
  onAskYapYep: () => void;
  onOpenOnGreenbook: (() => void) | null;
  /** Only set when the student granted location this session. */
  viewerDistanceM: number | null;
}

export function PlaceSheet({
  place,
  saved,
  busy,
  onSave,
  onClose,
  onAddExperience,
  onAskYapYep,
  onOpenOnGreenbook,
  viewerDistanceM,
}: PlaceSheetProps) {
  const [contributions, setContributions] = useState<PlaceContribution[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setContributions(null);
    setFailed(false);
    loadContributions(place.id).then((result) => {
      if (cancelled) return;
      if (result.ok) setContributions(result.value);
      else {
        setFailed(true);
        setContributions([]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [place.id]);

  const categoryLabel = EXPLORE_CATEGORIES.find((entry) => entry.key === place.category)?.label ?? place.category;
  const campus = campusFor(place.universityId);
  const photo = contributions?.find((entry) => entry.mediaUrl)?.mediaUrl;

  return (
    <div data-testid="place-sheet" className="flex max-h-[78vh] flex-col">
      {/* ---- header ---- */}
      <div className="flex items-start gap-3 px-5 pt-1">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[12px] bg-canvas text-[15px] font-extrabold text-ink">
          {categoryLabel.slice(0, 1)}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[17px] font-bold leading-tight text-ink">{place.name}</h2>
          <p className="mt-0.5 text-[12px] text-muted">
            {categoryLabel}
            {place.distanceFromCampusM ? ` · ${formatDistance(place.distanceFromCampusM)} from campus` : ""}
            {viewerDistanceM != null ? ` · ${formatDistance(viewerDistanceM)} from you` : ""}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {place.studentStories > 0 && (
              <Badge tone="primary">
                <Icon name="chat" size={11} /> {place.studentStories} student {place.studentStories === 1 ? "story" : "stories"}
              </Badge>
            )}
            {place.studentSaves > 0 && (
              <Badge tone="muted">
                <Icon name="bookmark" size={11} /> {place.studentSaves} saved
              </Badge>
            )}
            {place.isDemoSeed && <Badge tone="muted">Demo anchor</Badge>}
          </div>
        </div>
        <button onClick={onClose} aria-label="Close" className="flex h-11 w-11 items-center justify-center rounded-full text-muted">
          <Icon name="close" size={18} />
        </button>
      </div>

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto scroll-area px-5 pb-4">
        {photo && (
          <img
            src={photo}
            alt={`Photo shared by a student at ${place.name}`}
            loading="lazy"
            decoding="async"
            className="mb-3 h-44 w-full rounded-[12px] border border-line object-cover"
          />
        )}

        {/* ---- objective layer ---- */}
        <Card className="p-4">
          <div className="flex items-center gap-2">
            <p className="text-[12px] font-bold uppercase tracking-wide text-muted">Map record</p>
            <Badge tone="muted">{place.source === "seed_pack_researched" ? "Reviewed anchor" : "OpenStreetMap"}</Badge>
          </div>
          {place.address ? (
            <p className="mt-2 text-[13px] leading-relaxed text-ink">{place.address}</p>
          ) : (
            <p className="mt-2 text-[13px] text-muted">No address recorded in the map data.</p>
          )}
          {place.description && <p className="mt-1.5 text-[12px] text-muted">{place.description}</p>}
          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted">
            <Icon name="info" size={12} />
            {campus ? `${campus.universityName} area` : "Nearby"} · map data, not official guidance
          </p>
        </Card>

        {/* ---- community layer ---- */}
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[12px] font-bold uppercase tracking-wide text-muted">What students experienced</p>
            {contributions && contributions.length > 0 && <span className="text-[11px] text-muted">{contributions.length}</span>}
          </div>

          {contributions === null && (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          )}

          {failed && <Notice tone="warning" icon="alert" title="Student notes did not load" body="The map record above is still accurate. Try again in a moment." />}

          {contributions !== null && contributions.length === 0 && !failed && (
            <EmptyState
              icon="chat"
              title="No student stories yet"
              body="Be the first to say what this place is actually like."
              action="Add experience"
              onAction={onAddExperience}
            />
          )}

          {contributions !== null && contributions.length > 0 && (
            <div className="space-y-2.5">
              {contributions.slice(0, 6).map((entry) => (
                <Card key={entry.id} className="p-3.5">
                  <div className="flex items-start gap-2.5">
                    <Avatar initials={entry.author.initials} color={entry.author.color} size={32} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[13px] font-semibold text-ink">{entry.author.displayName}</span>
                        {entry.author.isDemoSeed && <Badge tone="muted">Demo</Badge>}
                        {entry.visitContext && <span className="text-[11px] text-muted">{entry.visitContext.replace(/_/g, " ")}</span>}
                      </div>
                      <p className="mt-1 text-[13px] leading-relaxed text-ink">{entry.note}</p>
                      {entry.tags.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {entry.tags.slice(0, 5).map((tag) => (
                            <span key={tag.key} className="rounded-full bg-canvas px-2 py-0.5 text-[10px] font-medium text-muted">
                              {tag.key.replace(/_/g, " ")}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </Card>
              ))}
              {contributions.length > 6 && <p className="pt-1 text-center text-[11px] text-muted">+{contributions.length - 6} more student notes</p>}
            </div>
          )}
        </div>

        {onOpenOnGreenbook && (
          <button onClick={onOpenOnGreenbook} className="mt-4 flex w-full items-center gap-2.5 rounded-[12px] border border-line bg-surface px-3.5 py-3 text-left active:scale-[.99]">
            <Icon name="text" size={16} />
            <span className="flex-1 text-[13px] font-semibold text-ink">Official guidance for this country</span>
            <Icon name="chevron" size={16} />
          </button>
        )}
      </div>

      {/* ---- actions ---- */}
      <div className="flex gap-2 border-t border-line bg-surface px-5 py-3">
        <Button variant={saved ? "outline" : "soft"} size="sm" onClick={onSave} disabled={busy}>
          <Icon name="bookmark" size={15} filled={saved} /> {saved ? "Saved" : "Save"}
        </Button>
        <Button variant="outline" size="sm" onClick={onAddExperience}>
          <Icon name="plus" size={15} /> Experience
        </Button>
        <Button variant="primary" size="sm" className="flex-1" onClick={onAskYapYep}>
          Ask YapYep
        </Button>
      </div>
    </div>
  );
}
