import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useJourney } from "../context/JourneyContext";
import { useNav } from "../context/NavContext";
import { Scroll } from "../components/shell";
import { Button, Chip, EmptyState, Notice, Segmented, Skeleton, Toast } from "../components/ui";
import { Icon } from "../components/icons";
import { COUNTRIES } from "../data/countries";
import { campusForJourney } from "../data/campuses";
import {
  createPost,
  loadFeed,
  toggleReaction,
  toggleSavePost,
} from "../lib/appwrite/community";
import { loadPlaces } from "../lib/appwrite/explore";
import { loadBlockedIds } from "../lib/appwrite/social";
import { useCurrentUserId } from "../lib/phase5/use-user";
import { translateText } from "../lib/phase5/translate";
import { FEED_FILTERS, type CommunityPost, type FeedFilter, type Place, type SocialProfile } from "../lib/phase5/contract";
import { languageCodes, type ViewerContext } from "../lib/phase5/matching";
import { client, APPWRITE_DATABASE_ID } from "../lib/appwrite/client";
import { PostCard } from "./community/PostCard";
import { PostDetail } from "./community/PostDetail";
import { Composer } from "./community/Composer";
import { PeopleTab } from "./community/PeopleTab";
import { CommunityProfile } from "./community/CommunityProfile";
import { PlacesForAuthor } from "./community/PlacesForAuthor";

/**
 * Connect.
 *
 * The brief changes this tab's centre of gravity: it is no longer a random
 * people directory. Community is the default view and People is a second tab,
 * because the lived experience of students who were actually there is the thing
 * this product has that a knowledge base does not.
 *
 * Messaging is deliberately absent. The previous implementation had a chat screen
 * with scripted replies and a fake auto-translation notice; the brief puts
 * messaging out of scope for this sprint, so it is removed rather than left
 * looking functional.
 */

type ConnectTab = "community" | "people";

export function ConnectHome() {
  const { journey, forced } = useJourney();
  const nav = useNav();
  const { userId } = useCurrentUserId();
  const campus = campusForJourney(journey);

  const [tab, setTab] = useState<ConnectTab>("community");
  const [filter, setFilter] = useState<FeedFilter>("for_you");
  const [posts, setPosts] = useState<CommunityPost[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [places, setPlaces] = useState<Place[]>([]);
  const [blocked, setBlocked] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [openPost, setOpenPost] = useState<CommunityPost | null>(null);
  const [openProfile, setOpenProfile] = useState<SocialProfile | null>(null);
  const [sharedMapFor, setSharedMapFor] = useState<SocialProfile | null>(null);
  const [realtimeState, setRealtimeState] = useState<"off" | "live" | "disconnected">("off");

  const placeById = useMemo(() => new Map(places.map((place) => [place.id, place])), [places]);

  const viewer: ViewerContext = useMemo(
    () => ({
      userId,
      homeCountry: journey.home,
      hostCountry: journey.host,
      city: journey.city,
      university: journey.university,
      major: "",
      interests: journey.interests ?? [],
      // The journey stores display names ("Bahasa Indonesia"); a profile stores
      // ISO codes ("id"). Normalise here or the language reason never fires.
      languages: languageCodes((journey.languages ?? []).map((language) => language.name)),
      blockedIds: blocked,
    }),
    [userId, journey, blocked],
  );

  /* ------------------------------ feed loading ------------------------------ */
  const load = useCallback(
    async (nextFilter: FeedFilter, nextCursor: string | null) => {
      const result = await loadFeed({
        filter: nextFilter,
        hostCountry: journey.host,
        universityId: campus?.universityId ?? journey.university,
        viewerId: userId,
        cursor: nextCursor,
      });
      if (!result.ok) {
        setFailed(true);
        setPosts((current) => current ?? []);
        return;
      }
      setFailed(false);
      setPosts((current) => (nextCursor ? [...(current ?? []), ...result.value.posts] : result.value.posts));
      setCursor(result.value.nextCursor);
    },
    [journey.host, journey.university, campus?.universityId, userId],
  );

  useEffect(() => {
    setPosts(null);
    setCursor(null);
    void load(filter, null);
  }, [filter, load]);

  useEffect(() => {
    void loadPlaces({ countryCode: journey.host }).then((result) => {
      if (result.ok) setPlaces(result.value);
    });
  }, [journey.host]);

  useEffect(() => {
    if (!userId) return;
    void loadBlockedIds(userId).then(setBlocked);
  }, [userId]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  /*
   * Realtime: new posts appear without a refresh, and a dropped socket is
   * invisible because the HTTP query already produced the list. Subscribing only
   * after authentication is a requirement, not a nicety — an unauthenticated
   * socket is rejected by the server and would retry forever.
   *
   * The channel is the whole table, so it does not depend on which filter is
   * active. Keying this effect on `filter` tore the socket down and rebuilt it on
   * every chip tap, and two teardowns racing produced
   * "WebSocket is already in CLOSING or CLOSED state" in the console. The current
   * filter is read from a ref instead, so the subscription outlives filter changes.
   */
  const reloadRef = useRef(load);
  reloadRef.current = load;
  const filterRef = useRef(filter);
  filterRef.current = filter;
  useEffect(() => {
    if (!userId || !APPWRITE_DATABASE_ID) return;
    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = client.subscribe(`databases.${APPWRITE_DATABASE_ID}.tables.community_posts.rows`, (event) => {
        // Only a create changes what the top of the feed should show. An update
        // to a reaction count is already applied optimistically by the viewer.
        if (String(event.events?.some((name) => name.endsWith(".create")))) {
          setRealtimeState("live");
          void reloadRef.current(filterRef.current, null);
        }
      });
      setRealtimeState("live");
    } catch {
      setRealtimeState("disconnected");
    }
    return () => {
      // Unsubscribing a socket that is already closing throws inside the SDK; a
      // teardown during navigation is normal, so it must not surface as an error.
      try {
        unsubscribe?.();
      } catch {
        /* already torn down */
      }
    };
  }, [userId]);

  /* -------------------------------- mutations ------------------------------- */
  async function react(post: CommunityPost) {
    if (!userId) {
      setToast("Reacting needs a session");
      return;
    }
    const wasReacted = post.viewerReacted;
    setBusyId(post.id);
    // Optimistic, with a rollback that restores the exact previous number.
    setPosts((current) =>
      current?.map((entry) =>
        entry.id === post.id
          ? { ...entry, viewerReacted: !wasReacted, reactionCount: Math.max(0, entry.reactionCount + (wasReacted ? -1 : 1)) }
          : entry,
      ) ?? current,
    );
    const result = await toggleReaction(post.id, userId, post.reactionCount, wasReacted);
    setBusyId(null);
    if (!result.ok) {
      setPosts((current) =>
        current?.map((entry) => (entry.id === post.id ? { ...entry, viewerReacted: wasReacted, reactionCount: post.reactionCount } : entry)) ?? current,
      );
      setToast(result.message);
      return;
    }
    setPosts((current) =>
      current?.map((entry) => (entry.id === post.id ? { ...entry, viewerReacted: result.value.reacted, reactionCount: result.value.count } : entry)) ?? current,
    );
  }

  async function save(post: CommunityPost) {
    if (!userId) {
      setToast("Saving needs a session");
      return;
    }
    const wasSaved = post.viewerSaved;
    setBusyId(post.id);
    setPosts((current) =>
      current?.map((entry) =>
        entry.id === post.id
          ? { ...entry, viewerSaved: !wasSaved, saveCount: Math.max(0, entry.saveCount + (wasSaved ? -1 : 1)) }
          : entry,
      ) ?? current,
    );
    const result = await toggleSavePost(post.id, userId, post.saveCount, wasSaved);
    setBusyId(null);
    if (!result.ok) {
      setPosts((current) =>
        current?.map((entry) => (entry.id === post.id ? { ...entry, viewerSaved: wasSaved, saveCount: post.saveCount } : entry)) ?? current,
      );
      setToast(result.message);
      return;
    }
    setPosts((current) =>
      current?.map((entry) => (entry.id === post.id ? { ...entry, viewerSaved: result.value.saved, saveCount: result.value.count } : entry)) ?? current,
    );
    setToast(result.value.saved ? "Saved" : "Removed from saved");
  }

  function hideAuthor(authorId: string) {
    setBlocked((current) => new Set(current).add(authorId));
    setPosts((current) => current?.filter((entry) => entry.authorId !== authorId) ?? current);
  }

  /* --------------------------------- render --------------------------------- */
  const visible = useMemo(() => (posts ?? []).filter((post) => !blocked.has(post.authorId)), [posts, blocked]);

  if (openPost) {
    const live = posts?.find((entry) => entry.id === openPost.id) ?? openPost;
    return (
      <PostDetail
        post={live}
        userId={userId}
        placeName={live.placeId ? placeById.get(live.placeId)?.name : undefined}
        onBack={() => setOpenPost(null)}
        onToggleReaction={() => void react(live)}
        onToggleSave={() => void save(live)}
        onTranslate={() => translateText(live.body, journey)}
        onOpenOnMap={
          live.placeId
            ? () => {
                setOpenPost(null);
                nav.setTab("explore");
              }
            : undefined
        }
        onBlocked={hideAuthor}
      />
    );
  }

  if (openProfile) {
    return (
      <CommunityProfile
        profile={openProfile}
        viewer={viewer}
        onBack={() => setOpenProfile(null)}
        onOpenSharedMap={(profile) => {
          setOpenProfile(null);
          setSharedMapFor(profile);
        }}
        onBlocked={(id) => {
          hideAuthor(id);
          setOpenProfile(null);
        }}
      />
    );
  }

  if (sharedMapFor) {
    return (
      <PlacesForAuthor
        profile={sharedMapFor}
        places={places}
        onBack={() => setSharedMapFor(null)}
        onOpenOnMap={() => {
          setSharedMapFor(null);
          nav.setTab("explore");
        }}
      />
    );
  }

  if (composing) {
    return (
      <Composer
        authorName={journey.name}
        authorInitials={journey.initials}
        authorColor={journey.avatarColor}
        places={places}
        onCancel={() => setComposing(false)}
        onCreate={async (input) => {
          if (!userId) return { ok: false, message: "Posting needs a session." };
          const result = await createPost({
            authorId: userId,
            countryCode: journey.host,
            universityId: campus?.universityId ?? journey.university,
            postType: input.postType,
            body: input.body,
            placeId: input.placeId,
            tags: [input.postType, journey.host.toLowerCase()],
            file: input.file,
          });
          if (!result.ok) return { ok: false, message: result.message };
          setComposing(false);
          setFilter("for_you");
          await load("for_you", null);
          setToast("Posted to the community");
          return { ok: true };
        }}
      />
    );
  }

  const countryName = COUNTRIES[journey.host]?.name ?? journey.host;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-5 pt-2">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[22px] font-extrabold tracking-tight text-ink">Connect</h1>
            <p className="mt-0.5 text-[12px] text-muted">
              {countryName}
              {campus ? ` · ${campus.universityId.toUpperCase()}` : ""}
            </p>
          </div>
          {tab === "community" && (
            <Button size="sm" onClick={() => setComposing(true)}>
              <Icon name="plus" size={16} /> Post
            </Button>
          )}
        </div>
        <div className="mt-3">
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: "community" as const, label: "Community" },
              { value: "people" as const, label: "People" },
            ]}
          />
        </div>
      </div>

      {tab === "people" ? (
        <PeopleTab viewer={viewer} onOpenProfile={setOpenProfile} />
      ) : (
        <>
          <div className="mt-3 flex gap-2 overflow-x-auto scroll-area px-5 pb-2">
            {FEED_FILTERS.map((entry) => (
              <Chip key={entry.key} tone="primary" active={filter === entry.key} onClick={() => setFilter(entry.key)}>
                {entry.label}
              </Chip>
            ))}
          </div>

          {realtimeState === "disconnected" && (
            <div className="px-5 pb-2">
              <Notice tone="warning" icon="signal" title="Live updates paused" body="The feed still works — pull a filter to refresh." />
            </div>
          )}

          <Scroll className="px-5 pb-6">
            {posts === null && (
              <div className="space-y-3">
                {[0, 1, 2].map((key) => (
                  <Skeleton key={key} className="h-[180px] w-full" />
                ))}
              </div>
            )}

            {failed && posts !== null && posts.length === 0 && (
              <EmptyState icon="alert" title="The feed did not load" body="Check your connection and try another filter." action="Retry" onAction={() => void load(filter, null)} />
            )}

            {forced === "empty" && <EmptyState icon="chat" title="Nothing here yet" body="No posts match this filter." />}

            {posts !== null && !failed && visible.length === 0 && forced !== "empty" && (
              <EmptyState
                icon={filter === "saved" ? "bookmark" : "chat"}
                title={filter === "saved" ? "Nothing saved yet" : "No posts here yet"}
                body={
                  filter === "saved"
                    ? "Save a post and it will appear here."
                    : `Be the first to share something useful about ${countryName}.`
                }
                action={filter === "saved" ? undefined : "Write a post"}
                onAction={filter === "saved" ? undefined : () => setComposing(true)}
              />
            )}

            {visible.length > 0 && (
              <div data-testid="community-feed" className="space-y-3">
                {visible.map((post) => (
                  <PostCard
                    key={post.id}
                    post={post}
                    placeName={post.placeId ? placeById.get(post.placeId)?.name : undefined}
                    onOpen={() => setOpenPost(post)}
                    onToggleReaction={() => void react(post)}
                    onToggleSave={() => void save(post)}
                    onTranslate={() => translateText(post.body, journey)}
                    onOpenOnMap={
                      post.placeId
                        ? () => {
                            nav.setTab("explore");
                          }
                        : undefined
                    }
                    busy={busyId === post.id}
                  />
                ))}

                {cursor && (
                  <Button
                    variant="outline"
                    full
                    disabled={loadingMore}
                    onClick={async () => {
                      setLoadingMore(true);
                      await load(filter, cursor);
                      setLoadingMore(false);
                    }}
                  >
                    {loadingMore ? "Loading…" : "Load more"}
                  </Button>
                )}
              </div>
            )}
          </Scroll>
        </>
      )}

      {toast && <Toast text={toast} />}
    </div>
  );
}
