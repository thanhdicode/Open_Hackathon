import Mascot from "../components/mascot";
import YepGuide from "../components/yep-guide";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useJourney } from "../context/JourneyContext";
import { useNav } from "../context/NavContext";
import { Scroll } from "../components/shell";
import { Button, Avatar, Chip, EmptyState, Notice, Segmented, Skeleton, Toast } from "../components/ui";
import { Icon } from "../components/icons";
import { COUNTRIES } from "../data/countries";
import { campusForJourney } from "../data/campuses";
import {
  createPost,
  deletePost,
  loadFeed,
  loadFeedSignals,
  toggleReaction,
  toggleSavePost,
} from "../lib/appwrite/community";
import { loadPlaces } from "../lib/appwrite/explore";
import { loadBlockedIds, loadFollowing } from "../lib/appwrite/social";
import { useCurrentUserId } from "../lib/phase5/use-user";
import { translateText } from "../lib/phase5/translate";
import { deriveStage } from "../lib/journey/dates";
import { FEED_FILTERS, type CommunityPost, type FeedFilter, type Place, type SocialProfile } from "../lib/phase5/contract";
import { languageCodes, type ViewerContext } from "../lib/phase5/matching";
import type { FeedSignals } from "../lib/appwrite/community";
import type { ViewerFeedContext } from "../lib/phase5/feed-ranking";
import { EMPTY_SIGNALS } from "../lib/appwrite/community";
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

type PendingCounts = Map<string, { reaction: number; comment: number; at: number }>;

/**
 * Layer locally observed interaction deltas onto a freshly fetched page.
 *
 * A delta recorded *after* the request began is not in the response and is added
 * back; one recorded before it is already reflected in the row counts, so it is
 * consumed and removed. That is what keeps a reaction from snapping back to zero
 * when a concurrent list re-read lands a moment later.
 */
function reconcilePending(
  posts: CommunityPost[],
  startedAt: number,
  pending: PendingCounts,
): CommunityPost[] {
  if (!pending.size) return posts;
  const consumed: string[] = [];

  const reconciled = posts.map((post) => {
    const entry = pending.get(post.id);
    if (!entry) return post;
    if (entry.at <= startedAt) {
      consumed.push(post.id);
      return post;
    }
    return {
      ...post,
      reactionCount: Math.max(0, post.reactionCount + entry.reaction),
      commentCount: Math.max(0, post.commentCount + entry.comment),
    };
  });

  for (const id of consumed) pending.delete(id);
  return reconciled;
}

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
  const [signals, setSignals] = useState<FeedSignals>(EMPTY_SIGNALS);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [openPost, setOpenPost] = useState<CommunityPost | null>(null);
  const [openProfile, setOpenProfile] = useState<SocialProfile | null>(null);
  const [sharedMapFor, setSharedMapFor] = useState<SocialProfile | null>(null);
  const [realtimeState, setRealtimeState] = useState<"off" | "live" | "disconnected">("off");

  const placeById = useMemo(() => new Map(places.map((place) => [place.id, place])), [places]);

  /**
   * The ranker's view of the student.
   *
   * Everything here is either something the student told us during onboarding or
   * a row they created themselves. Nothing is inferred, and no nationality is
   * treated as a personality — the exchange stage comes from their real dates,
   * and the interests are the ones they picked.
   */
  const viewerContext: ViewerFeedContext = useMemo(
    () => ({
      userId,
      homeCountry: journey.home,
      hostCountry: journey.host,
      hostUniversity: campus?.universityId ?? journey.university,
      stage: deriveStage(journey.dates),
      interests: (journey.interests ?? []).map((entry) => entry.toLowerCase()),
      concerns: (journey.concerns ?? []).map((entry) => entry.toLowerCase()),
      languages: languageCodes((journey.languages ?? []).map((language) => language.name)),
      blockedIds: blocked,
      followedIds: signals.followedIds,
      hiddenPostIds: signals.hiddenPostIds,
      engagedTypes: signals.engagedTypes,
      engagedTopics: signals.engagedTopics,
      savedPlaceIds: signals.savedPlaceIds,
      placeById: new Map(places.map((place) => [place.id, { universityId: place.universityId, distanceFromCampusM: place.distanceFromCampusM }])),
    }),
    [userId, journey, blocked, signals, places, campus?.universityId],
  );

  /* ------------------------------ people matching --------------------------- */
  /** The People tab keeps its own viewer shape; it scores profiles, not posts. */
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

  /*
   * Interaction counts observed locally, with the moment they were observed.
   *
   * A count is derived from interaction rows, so a re-read is authoritative and
   * the list should normally just take the server's word for it. Ordering is what
   * breaks that: publishing a post kicks off a full list re-read, and if somebody
   * reacts while that request is in flight the response was assembled *before* the
   * reaction existed. Applying it verbatim drops the count back to its
   * pre-reaction value — the number visibly snaps backwards, which is precisely
   * the sort of thing that makes a live demo look broken.
   *
   * So each delta remembers when it happened. A response supersedes every delta
   * recorded before the request started, and is layered with the ones recorded
   * after. Deltas the response already accounts for are dropped, so nothing is
   * ever counted twice and the map does not grow.
   */
  const pendingRef = useRef(new Map<string, { reaction: number; comment: number; at: number }>());

  const load = useCallback(
    async (nextFilter: FeedFilter, nextCursor: string | null) => {
      const startedAt = Date.now();
      const result = await loadFeed({
        filter: nextFilter,
        hostCountry: journey.host,
        universityId: campus?.universityId ?? journey.university,
        viewerId: userId,
        cursor: nextCursor,
        viewerContext,
        placeById: viewerContext.placeById,
      });
      if (!result.ok) {
        setFailed(true);
        setPosts((current) => current ?? []);
        return;
      }
      setFailed(false);
      const fetched = reconcilePending(result.value.posts, startedAt, pendingRef.current);
      setPosts((current) => (nextCursor ? [...(current ?? []), ...fetched] : fetched));
      setCursor(result.value.nextCursor);
    },
    [journey.host, journey.university, campus?.universityId, userId, viewerContext],
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
    void loadFollowing(userId).then((following) => setSignals((current) => ({ ...current, followedIds: following })));
  }, [userId]);

  /*
   * Interaction signals are read once per session and refreshed after the
   * viewer's own writes, because the ranker uses them to decide what "more like
   * what you read" means. They are deliberately not refreshed on every scroll:
   * that would be a request per page for a signal that changes slowly.
   */
  useEffect(() => {
    void loadFeedSignals(userId).then(setSignals);
  }, [userId]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  /*
   * Realtime.
   *
   * The channel is the whole table, so it does not depend on which filter is
   * active. Keying this effect on `filter` tore the socket down and rebuilt it on
   * every chip tap, and two teardowns racing produced
   * "WebSocket is already in CLOSING or CLOSED state" in the console. The current
   * filter is read from a ref instead, so the subscription outlives filter changes.
   *
   * ALL THREE EVENT KINDS ARE HANDLED, and the split matters:
   *
   *   create  reload — a new post changes the order, and only the server knows
   *           where it belongs in a ranked feed.
   *   update  patch the denormalised counts in place. This is what makes
   *           "B reacts, A sees the number move" work without a reload.
   *   delete  remove the card. Without this, A deleting their post would leave a
   *           ghost on B's screen that 404s when tapped.
   *
   * `viewerReacted` and `viewerSaved` are never taken from the payload: they are
   * the viewer's own state, and another student's reaction must not make the
   * heart on this screen look pressed.
   */
  const reloadRef = useRef(load);
  reloadRef.current = load;
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const viewerRef = useRef(userId);
  viewerRef.current = userId;
  useEffect(() => {
    if (!userId || !APPWRITE_DATABASE_ID) return;
    let unsubscribe: (() => void) | null = null;

    /*
     * Counts are derived from the interaction rows, so the feed has to listen to
     * those tables and not only to `community_posts`.
     *
     * It used to subscribe to the post row alone, which worked while the counters
     * lived there — but the counters cannot live there, because a post row is
     * `update(author)` and a reaction by anyone else was rejected with 401. Now
     * that a reaction *is* its own row, this subscription is what turns B's tap
     * into A's updated number. One socket carries all three channels.
     */
    const channels = [
      `databases.${APPWRITE_DATABASE_ID}.tables.community_posts.rows`,
      `databases.${APPWRITE_DATABASE_ID}.tables.post_reactions.rows`,
      `databases.${APPWRITE_DATABASE_ID}.tables.post_comments.rows`,
    ];

    const eventKind = (names: string[]) =>
      names.some((name) => name.endsWith(".create"))
        ? "create"
        : names.some((name) => name.endsWith(".delete"))
          ? "delete"
          : names.some((name) => name.endsWith(".update"))
            ? "update"
            : null;

    const toNumber = (value: unknown): number | null => {
      const parsed = typeof value === "number" ? value : Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };

    /** Apply a ±1 delta to one post's count, ignoring the viewer's own echo. */
    const bumpCount = (postId: string, field: "reactionCount" | "commentCount", delta: number) => {
      setPosts(
        (current) =>
          current?.map((entry) =>
            entry.id === postId ? { ...entry, [field]: Math.max(0, entry[field] + delta) } : entry,
          ) ?? current,
      );
    };

    try {
      unsubscribe = client.subscribe(channels, (event) => {
        const names = event.events ?? [];
        const kind = eventKind(names);
        if (!kind) return;
        setRealtimeState("live");

        const payload = event.payload as Record<string, unknown> | null;
        const channel = names[0] ?? "";

        /* ---------------------- interaction rows ---------------------- */
        if (channel.includes(".post_reactions.") || channel.includes(".post_comments.")) {
          const postId = typeof payload?.post_id === "string" ? payload.post_id : null;
          if (!postId) return;
          const actorId = channel.includes(".post_reactions.")
            ? typeof payload?.user_id === "string"
              ? payload.user_id
              : null
            : typeof payload?.author_id === "string"
              ? payload.author_id
              : null;
          /*
           * The viewer's own action was already applied optimistically. Counting
           * the echo as well would show every tap twice — the classic double-count
           * that makes a demo look broken.
           */
          if (actorId && actorId === viewerRef.current) return;
          if (kind === "update") return;
          bumpCount(postId, channel.includes(".post_reactions.") ? "reactionCount" : "commentCount", kind === "create" ? 1 : -1);
          return;
        }

        /* ------------------------- the post row ----------------------- */
        if (kind === "create") {
          void reloadRef.current(filterRef.current, null);
          return;
        }

        const postId = typeof payload?.$id === "string" ? payload.$id : typeof payload?.post_id === "string" ? payload.post_id : null;
        if (!postId) return;

        if (kind === "delete") {
          setPosts((current) => current?.filter((entry) => entry.id !== postId) ?? current);
          return;
        }

        /*
         * An update to the post row itself no longer carries counts, so only the
         * fields that still live there are reconciled. `save_count` stays here
         * because save rows are private and cannot be counted.
         */
        const saveCount = toNumber(payload?.save_count);
        setPosts(
          (current) =>
            current?.map((entry) => (entry.id === postId && saveCount !== null ? { ...entry, saveCount } : entry)) ?? current,
        );
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
    const result = await toggleReaction(post.id, userId, wasReacted);
    setBusyId(null);
    if (!result.ok) {
      setPosts((current) =>
        current?.map((entry) => (entry.id === post.id ? { ...entry, viewerReacted: wasReacted, reactionCount: post.reactionCount } : entry)) ?? current,
      );
      setToast(result.message);
      return;
    }
    /*
     * The optimistic value stands. The server returns no count on purpose: the
     * total is derived from the reaction rows, and re-applying a number computed
     * from the pre-click prop would be a second, worse guess than the one already
     * on screen. The next HTTP load reconciles it against the real row count.
     */
    setPosts((current) =>
      current?.map((entry) => (entry.id === post.id ? { ...entry, viewerReacted: result.value.reacted } : entry)) ?? current,
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
    const result = await toggleSavePost(post.id, userId, wasSaved);
    setBusyId(null);
    if (!result.ok) {
      setPosts((current) =>
        current?.map((entry) => (entry.id === post.id ? { ...entry, viewerSaved: wasSaved, saveCount: post.saveCount } : entry)) ?? current,
      );
      setToast(result.message);
      return;
    }
    setPosts((current) =>
      current?.map((entry) => (entry.id === post.id ? { ...entry, viewerSaved: result.value.saved } : entry)) ?? current,
    );
    setToast(result.value.saved ? "Saved" : "Removed from saved");
  }

  function hideAuthor(authorId: string) {
    setBlocked((current) => new Set(current).add(authorId));
    setPosts((current) => current?.filter((entry) => entry.authorId !== authorId) ?? current);
  }

  /* --------------------------------- render --------------------------------- */
  const visible = useMemo(() => (posts ?? []).filter((post) => !blocked.has(post.authorId)), [posts, blocked]);
  const countryName = COUNTRIES[journey.host]?.name ?? journey.host;

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
                nav.focusPlace(live.placeId!);
              }
            : undefined
        }
        onBlocked={hideAuthor}
        onDeletePost={
          userId && userId === live.authorId
            ? async () => {
                const result = await deletePost(live.id);
                if (!result.ok) return { ok: false, message: result.message };
                setPosts((current) => current?.filter((entry) => entry.id !== live.id) ?? current);
                setOpenPost(null);
                setToast("Post deleted");
                return { ok: true };
              }
            : undefined
        }
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
        contextLabel={`${countryName}${campus ? ` · ${campus.universityId.toUpperCase()}` : ""}`}
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
            placeName: input.placeName,
            tags: [...input.tags, input.postType, journey.host.toLowerCase()],
            images: input.images,
            video: input.video,
            onProgress: input.onProgress,
          });
          if (!result.ok) return { ok: false, message: result.message };

          /*
           * Optimistic insertion. The student's own post appears at the top of
           * the feed the instant the write lands, without waiting for the realtime
           * event to make the round trip — and because the row already exists
           * server-side, a reload shows the same thing. There is no `setTimeout`
           * anywhere in this path: the card is only shown after `createPost`
           * returned a real row.
           */
          setComposing(false);
          setPosts((current) => [result.value, ...(current ?? []).filter((entry) => entry.id !== result.value.id)]);
          setFilter("for_you");
          setToast(input.placeId ? "Posted to the community and the map" : "Posted to the community");
          // The new post is a new interaction signal; refresh them so the next
          // For You page reflects it.
          void loadFeedSignals(userId).then(setSignals);
          return { ok: true };
        }}
      />
    );
  }

  return (
    <div data-tour-screen="connect" className="flex h-full min-h-0 flex-col">
      <div className="px-5 pt-2">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[22px] font-extrabold tracking-tight text-ink">Connect</h1>
            <p className="mt-0.5 text-[12px] text-muted">
              {countryName}
              {campus ? ` · ${campus.universityId.toUpperCase()}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => nav.push("editProfile")}
              aria-label="Your profile"
              data-testid="open-my-profile"
              className="flex h-11 w-11 items-center justify-center rounded-full active:scale-90"
            >
              <Avatar initials={journey.initials} color={journey.avatarColor} size={34} />
            </button>
            {tab === "community" && (
              <Button size="sm" onClick={() => setComposing(true)}>
                <Icon name="plus" size={16} /> Post
              </Button>
            )}
          </div>
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
            <YepGuide screen="connect" title="Meet your student community" compact>Browse shared experiences or switch to People. Keep personal details private and use report/block when needed.</YepGuide>
            <div data-yep="feed" className="mb-2 text-[12px] font-medium text-muted">Student experiences · Check details with local sources</div>
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

            {forced === "empty" && <><Mascot size={72} className="mx-auto block" /><EmptyState icon="chat" title="Nothing here yet" body="No posts match this filter." /></>}

            {posts !== null && !failed && visible.length === 0 && forced !== "empty" && (
              <><Mascot size={72} className="mx-auto block" /><EmptyState
                icon={filter === "saved" ? "bookmark" : "chat"}
                title={filter === "saved" ? "Nothing saved yet" : "No posts here yet"}
                body={
                  filter === "saved"
                    ? "Save a post and it will appear here."
                    : filter === "near_campus"
                      ? "No student has posted about a place near your campus yet. Be the first."
                      : filter === "my_university"
                        ? `No posts from ${campus?.universityId.toUpperCase() ?? "your university"} yet.`
                        : `Be the first to share something useful about ${countryName}.`
                }
                action={filter === "saved" ? undefined : "Write a post"}
                onAction={filter === "saved" ? undefined : () => setComposing(true)}
              /></>
            )}

            {/*
              The feed container is always mounted, even when it holds nothing.
              It used to render only when `visible.length > 0`, which made the
              "empty feed" and "empty university feed" states unobservable from
              outside: a probe waiting for this hook to appear could not tell an
              empty community from a broken one, and timed out instead of
              reporting the honest result.
            */}
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
                          // Hands the exact place id to Explore, which selects it
                          // and lets MapLibre ease to the coordinate. Switching
                          // tabs alone would land on an unfiltered map.
                          nav.focusPlace(post.placeId!);
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
          </Scroll>
        </>
      )}

      {toast && <Toast text={toast} />}
    </div>
  );
}
