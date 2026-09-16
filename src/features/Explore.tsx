import { useCallback, useEffect, useMemo, useState } from "react";
import { useJourney } from "../context/JourneyContext";
import { useNav } from "../context/NavContext";
import { Scroll } from "../components/shell";
import { Badge, BottomSheet, Button, Card, Chip, EmptyState, ErrorState, Notice, Skeleton, Toast } from "../components/ui";
import { Icon } from "../components/icons";
import { COUNTRIES } from "../data/countries";
import { campusForJourney, CAMPUSES } from "../data/campuses";
import { formatDistance, loadPlaces, loadSavedPlaceIds, searchPlaces, togglePlaceSave, haversineMeters } from "../lib/appwrite/explore";
import { useCurrentUserId } from "../lib/phase5/use-user";
import { permissionLabel, useLocationPermission, useReducedMotion } from "../lib/phase5/location";
import { EXPLORE_CATEGORIES, EXPLORE_SCOPES, type ExploreCategory, type ExploreScope, type Place } from "../lib/phase5/contract";
import { ExploreMap } from "./explore/ExploreMap";
import { PlaceSheet } from "./explore/PlaceSheet";

/**
 * Explore — the real map.
 *
 * This replaces the previous implementation entirely. That version drew a
 * decorative SVG grid and positioned pins at hand-written percentages, with a
 * `genericPlaces(city)` generator producing names like "Campus Food Court" and
 * "Student Bank Branch". Nothing on it corresponded to a real coordinate, and the
 * quality gate calls that out specifically: no fake SVG map and no generated fake
 * POI may exist in the production path.
 *
 * Everything shown now comes from the `places` table, which is populated from
 * OpenStreetMap via Overpass, plus the reviewed anchors from the seed pack.
 */

export function Explore({ initialCategory }: { initialCategory?: ExploreCategory }) {
  const { journey, forced } = useJourney();
  const nav = useNav();
  const { userId } = useCurrentUserId();
  const location = useLocationPermission();
  const reducedMotion = useReducedMotion();

  const [places, setPlaces] = useState<Place[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [category, setCategory] = useState<ExploreCategory>(initialCategory ?? "all");
  const [scope, setScope] = useState<ExploreScope>("for_you");
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Place | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const campus = campusForJourney(journey);
  const countryName = COUNTRIES[journey.host]?.name ?? journey.host;

  /* -------------------------------- loading -------------------------------- */
  const load = useCallback(async () => {
    setLoadError(false);
    setPlaces(null);
    const result = await loadPlaces({ countryCode: journey.host, force: true });
    if (result.ok) setPlaces(result.value);
    else {
      setLoadError(true);
      setPlaces([]);
    }
  }, [journey.host]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!userId) return;
    void loadSavedPlaceIds(userId).then((result) => {
      if (result.ok) setSavedIds(result.value);
    });
  }, [userId]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  /* ------------------------------- filtering ------------------------------- */
  const visible = useMemo(() => {
    if (!places) return [];
    let list = places;

    if (category !== "all") list = list.filter((place) => place.category === category);

    if (scope === "students_recommend") list = list.filter((place) => place.studentStories > 0 || place.studentSaves > 0);
    if (scope === "saved") list = list.filter((place) => savedIds.has(place.id));

    list = searchPlaces(list, search);

    // Nearest first: the map is bounded to the campus radius, so distance from
    // the campus is the only ordering that is always available.
    return [...list].sort((a, b) => {
      const da = Number.isFinite(a.distanceFromCampusM) ? a.distanceFromCampusM : Number.MAX_SAFE_INTEGER;
      const db = Number.isFinite(b.distanceFromCampusM) ? b.distanceFromCampusM : Number.MAX_SAFE_INTEGER;
      return da - db;
    });
  }, [places, category, scope, savedIds, search]);

  const mapCenter = campus?.center ?? { lat: 3.1209, lng: 101.6538 };

  const viewerDistance = useCallback(
    (place: Place) => (location.position ? haversineMeters(location.position, { lat: place.lat, lng: place.lng }) : null),
    [location.position],
  );

  async function onSave(place: Place) {
    if (!userId) {
      setToast("Saving needs a session");
      return;
    }
    const wasSaved = savedIds.has(place.id);
    // Optimistic: the bookmark flips immediately and rolls back if the write fails.
    setSavedIds((current) => {
      const next = new Set(current);
      if (wasSaved) next.delete(place.id);
      else next.add(place.id);
      return next;
    });
    setSavingId(place.id);
    const result = await togglePlaceSave(place.id, userId, wasSaved);
    setSavingId(null);
    if (!result.ok) {
      setSavedIds((current) => {
        const next = new Set(current);
        if (wasSaved) next.add(place.id);
        else next.delete(place.id);
        return next;
      });
      setToast(result.message);
      return;
    }
    setPlaces((current) =>
      current ? current.map((entry) => (entry.id === place.id ? { ...entry, studentSaves: result.value.count } : entry)) : current,
    );
    setToast(result.value.saved ? "Saved to your places" : "Removed from saved");
  }

  /* ------------------------------ state matrix ----------------------------- */
  const showEmpty = forced === "empty" || (places !== null && !loadError && visible.length === 0);
  const showLoading = places === null && !loadError;
  const showError = loadError || forced === "error";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ------------------------------ header ------------------------------ */}
      <div className="px-5 pt-2">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-[22px] font-extrabold tracking-tight text-ink">Explore</h1>
            <p className="mt-0.5 truncate text-[12px] text-muted">
              {journey.city}, {countryName} · {campus ? campus.universityName : "places near you"}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setSearchOpen((open) => !open)}
              aria-label="Search places"
              aria-pressed={searchOpen}
              className="flex h-11 w-11 items-center justify-center rounded-full border border-line bg-surface text-ink"
            >
              <Icon name="search" size={18} />
            </button>
            <button
              onClick={() => (location.permission === "granted" ? undefined : location.request())}
              aria-label="Use my location"
              className={`flex h-11 w-11 items-center justify-center rounded-full border ${
                location.permission === "granted" ? "border-ink bg-ink text-white" : "border-line bg-surface text-ink"
              }`}
            >
              <Icon name="location" size={18} />
            </button>
          </div>
        </div>

        {searchOpen && (
          <div className="mt-3 flex items-center gap-2 rounded-[12px] border border-line bg-surface px-3">
            <Icon name="search" size={16} />
            <input
              autoFocus
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search saved places and categories"
              aria-label="Search places"
              className="min-h-[44px] flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-muted"
            />
            {search && (
              <button onClick={() => setSearch("")} aria-label="Clear search" className="text-muted">
                <Icon name="close" size={16} />
              </button>
            )}
          </div>
        )}

        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted">
          <Icon name="info" size={12} /> {permissionLabel(location.permission)}
        </p>
      </div>

      {/* ----------------------------- filters ------------------------------ */}
      <div className="mt-2 flex gap-2 overflow-x-auto scroll-area px-5 pb-2">
        {EXPLORE_CATEGORIES.map((entry) => (
          <Chip key={entry.key} tone="primary" active={category === entry.key} onClick={() => setCategory(entry.key)}>
            {entry.label}
          </Chip>
        ))}
      </div>
      <div className="flex gap-2 overflow-x-auto scroll-area px-5 pb-2">
        {EXPLORE_SCOPES.map((entry) => (
          <Chip key={entry.key} active={scope === entry.key} onClick={() => setScope(entry.key)}>
            {entry.label}
            {entry.key === "saved" && savedIds.size > 0 ? ` ${savedIds.size}` : ""}
          </Chip>
        ))}
      </div>

      {location.error && (
        <div className="px-5 pb-2">
          <Notice tone="warning" icon="info" title="Location off" body={location.error} />
        </div>
      )}

      {/* -------------------------------- map -------------------------------- */}
      <div className="mx-5 mb-3 h-[38vh] min-h-[220px] overflow-hidden rounded-[12px] border border-line">
        {showError ? (
          <div className="flex h-full items-center justify-center px-8">
            <EmptyState icon="alert" title="Places did not load" body="Check your connection and try again." action="Retry" onAction={() => void load()} />
          </div>
        ) : (
          <ExploreMap
            places={visible}
            savedIds={savedIds}
            selectedId={selected?.id ?? null}
            center={mapCenter}
            onSelect={setSelected}
            onClearSelection={() => setSelected(null)}
            userLocation={location.position}
            reducedMotion={reducedMotion}
          />
        )}
      </div>

      {/* -------------------------------- list ------------------------------- */}
      <Scroll className="px-5 pb-6">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-[15px] font-bold text-ink">
            {scope === "saved" ? "Your saved places" : `Places around ${campus?.universityId.toUpperCase() ?? journey.city}`}
          </h2>
          {places !== null && <span className="text-[12px] text-muted">{visible.length} shown</span>}
        </div>

        {showLoading && (
          <div className="space-y-3">
            {[0, 1, 2, 3].map((key) => (
              <Skeleton key={key} className="h-[76px] w-full" />
            ))}
          </div>
        )}

        {showEmpty && !showLoading && !showError && (
          <EmptyState
            icon="explore"
            title={scope === "saved" ? "Nothing saved yet" : "No places match"}
            body={
              scope === "saved"
                ? "Save a place from the map and it will appear here."
                : `Try another category, or switch to ${CAMPUSES.find((entry) => entry.country !== journey.host)?.universityName ?? "another campus"} in your journey.`
            }
            action={scope === "saved" ? undefined : "Show all"}
            onAction={scope === "saved" ? undefined : () => { setCategory("all"); setScope("for_you"); setSearch(""); }}
          />
        )}

        {!showLoading && !showError && !showEmpty && (
          <div className="space-y-3">
            {visible.slice(0, 40).map((place) => (
              <PlaceListCard key={place.id} place={place} saved={savedIds.has(place.id)} onOpen={() => setSelected(place)} />
            ))}
            {visible.length > 40 && <p className="pt-1 text-center text-[11px] text-muted">{visible.length - 40} more on the map</p>}
          </div>
        )}
      </Scroll>

      {/* ------------------------------- sheet ------------------------------- */}
      {selected && (
        <BottomSheet open onClose={() => setSelected(null)}>
          <PlaceSheet
            place={selected}
            saved={savedIds.has(selected.id)}
            busy={savingId === selected.id}
            onSave={() => void onSave(selected)}
            onClose={() => setSelected(null)}
            onAddExperience={() => {
              const place = selected;
              setSelected(null);
              nav.push("addExperience", { place });
            }}
            onAskYapYep={() => {
              const place = selected;
              setSelected(null);
              nav.push("greenbookAsk", { countryCode: journey.host, chapter: null, question: `What should I know about ${place.name}?` });
            }}
            onOpenOnGreenbook={() => {
              setSelected(null);
              nav.push("greenbook", {});
            }}
            viewerDistanceM={viewerDistance(selected)}
          />
        </BottomSheet>
      )}

      {toast && <Toast text={toast} />}
    </div>
  );
}

function PlaceListCard({ place, saved, onOpen }: { place: Place; saved: boolean; onOpen: () => void }) {
  const label = EXPLORE_CATEGORIES.find((entry) => entry.key === place.category)?.label ?? place.category;
  return (
    <Card className="p-4" onClick={onOpen}>
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] bg-canvas text-[14px] font-extrabold text-ink">
          {label.slice(0, 1)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[15px] font-bold text-ink">{place.name}</h3>
            {place.source === "seed_pack_researched" && <Badge tone="muted">Anchor</Badge>}
            {saved && <Icon name="bookmark" size={14} filled />}
          </div>
          <p className="mt-0.5 truncate text-[12px] text-muted">
            {label}
            {Number.isFinite(place.distanceFromCampusM) ? ` · ${formatDistance(place.distanceFromCampusM)} from campus` : ""}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {place.studentStories > 0 && <Badge tone="primary">{place.studentStories} student {place.studentStories === 1 ? "story" : "stories"}</Badge>}
            {place.studentSaves > 0 && <Badge tone="muted">{place.studentSaves} saved</Badge>}
            {place.communityTags.slice(0, 2).map((tag) => (
              <Badge key={tag.key} tone="muted">
                {tag.key.replace(/_/g, " ")}
              </Badge>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}
