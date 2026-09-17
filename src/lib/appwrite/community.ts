import { ID, Permission, Query, Role, type Models } from "appwrite";
import {
  APPWRITE_DATABASE_ID,
  APPWRITE_COMMUNITY_MEDIA_BUCKET_ID,
  requireDatabaseId,
  storage,
  tablesDB,
} from "./client";
import { appError, appErrorMessage, type AppError } from "./errors";
import {
  FILTER_TYPES,
  MEDIA_LIMITS,
  mediaKindFor,
  type AuthorSummary,
  type CommunityPost,
  type FeedFilter,
  type MediaKind,
  type PostComment,
  type PostMedia,
  type PostType,
} from "../phase5/contract";
import { deriveMetadata } from "../phase5/enrichment";
import { rankFeed, withReasons, type ViewerFeedContext } from "../phase5/feed-ranking";
import { languageCode } from "../phase5/matching";
import type { ExchangeStage } from "../journey/dates";

/**
 * Community reads and writes.
 *
 * TWO THINGS WORTH KNOWING BEFORE EDITING THIS FILE
 *
 * 1. Rows are readable because of a ROW permission, not a table permission.
 *    `community_posts` is an owner table with `rowSecurity: true` and only a
 *    `create("users")` table grant. A row is visible to other students purely
 *    because the writer stamped `read("users")` on it. If a write forgets that
 *    permission the row exists, the author sees it, and everyone else silently
 *    sees an empty feed — no error anywhere. Every insert below goes through
 *    `publicRowPermissions()` for that reason.
 *
 * 2. Counts on a post are denormalised aggregates, not a live count. They are
 *    mutated optimistically by the UI and reconciled from the mutation result, so
 *    a failed write rolls the number back rather than leaving it wrong.
 */

const POSTS = "community_posts";
const POST_MEDIA = "post_media";
const REACTIONS = "post_reactions";
const COMMENTS = "post_comments";
const SAVED_POSTS = "saved_posts";
const PROFILES = "student_social_profiles";
/** The onboarding profile. Read only as a display-name fallback for post authors. */
const STUDENT_PROFILES = "student_profiles";
const FOLLOWS = "follows";
const SAVED_PLACES = "place_saves";
const REPORTS = "reports";

export const PAGE_SIZE = 20;

/**
 * How many posts the For You ranker considers before it picks a page.
 *
 * Ranking only the first page would be ranking the twenty newest posts, which
 * is `latest` with extra steps. Three pages is the smallest window that can
 * actually surface something older and better, and it is still one bounded set
 * of rows rather than a scan of the table.
 */
export const RANK_CANDIDATE_WINDOW = 60;

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError; message: string };

function fail(error: unknown): Result<never> {
  const code = appError(error);
  return { ok: false, error: code, message: appErrorMessage(code) };
}

/* ------------------------------ small helpers ----------------------------- */

type Row = Models.Row & Record<string, unknown>;

const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const num = (value: unknown, fallback = 0): number => (typeof value === "number" ? value : Number(value ?? fallback) || fallback);
const bool = (value: unknown): boolean => value === true || value === 1 || value === "1";

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Avatar colours are derived from the user id so the same person keeps the same
 * colour across the feed, the map and the profile without storing one.
 */
const AVATAR_COLORS = ["#111111", "#3157D5", "#1F7A5C", "#8A4B10", "#5B3FA8", "#0F6C7B", "#8C2F39", "#4A5568"];

export function colorFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** FNV-1a, 32-bit. Small, dependency-free and stable across runs. */
function fnv1a(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A deterministic, short row id for a (user, target) pair.
 *
 * Appwrite rejects row ids longer than 36 characters. The obvious
 * `${targetId}_ps_${userId}` overflows that for every real value — an OSM place id
 * runs to ~18 characters and a user id is 20 — so saving a place or a post failed
 * outright rather than merely looking untidy.
 *
 * Uniqueness is already guaranteed by each table's unique index on
 * (user_id, target_id); this id only has to be *stable*, so that a second save
 * updates rather than duplicates. Two FNV-1a passes give ~64 bits, rendered in
 * base36, keeping the id to about 16 characters.
 */
export function pairRowId(prefix: string, a: string, b: string): string {
  const seed = `${a}\u0000${b}`;
  return `${prefix}${fnv1a(seed, 0x811c9dc5).toString(36)}${fnv1a(seed, 0x01000193).toString(36)}`;
}

/** The only permission set that makes a row visible to other students. */
export function publicRowPermissions(authorId?: string): string[] {
  const permissions = [Permission.read(Role.users())];
  if (authorId) permissions.push(Permission.update(Role.user(authorId)), Permission.delete(Role.user(authorId)));
  return permissions;
}

export function ownerRowPermissions(userId: string): string[] {
  return [
    Permission.read(Role.user(userId)),
    Permission.update(Role.user(userId)),
    Permission.delete(Role.user(userId)),
  ];
}

/* --------------------------- author resolution ---------------------------- */

/**
 * Authors come from two populations: seeded demo profiles (whose `user_id` is the
 * seed id) and real accounts (whose `user_id` is the Appwrite user id). They live
 * in the same table, so one batched read covers both.
 */
async function loadAuthors(ids: string[]): Promise<Map<string, AuthorSummary>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const map = new Map<string, AuthorSummary>();
  if (!unique.length) return map;

  // Appwrite caps `Query.equal` list length, so chunk defensively.
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += 50) chunks.push(unique.slice(i, i + 50));

  await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const page = await tablesDB.listRows({
          databaseId: requireDatabaseId(),
          tableId: PROFILES,
          queries: [Query.equal("user_id", chunk), Query.limit(chunk.length)],
        });
        for (const row of page.rows as Row[]) {
          const userId = str(row.user_id);
          map.set(userId, {
            id: userId,
            displayName: str(row.display_name, "Student"),
            initials: initialsFor(str(row.display_name, "Student")),
            color: colorFor(userId),
            homeCountry: str(row.home_country_code) || undefined,
            hostCountry: str(row.host_country_code) || undefined,
            universityId: str(row.university_id) || undefined,
            // Normalised through `languageCode` because the seed pack stores ISO
            // codes and a real profile may store a display name; the ranker
            // compares these against the viewer's own codes.
            languages: parseJson<string[]>(row.languages, []).map(languageCode).filter(Boolean),
            isDemoSeed: bool(row.is_demo_seed),
          });
        }
      } catch {
        // A profile read failure must not blank the feed: fall through to the
        // synthesised author below, which still renders a name and initials.
      }
    }),
  );

  /*
   * Second pass: authors with no social profile.
   *
   * A social profile is opt-in — it is created when a student edits their community
   * profile — but every signed-in student has a journey profile from onboarding.
   * Without this pass, a student who simply writes a post renders as "Student" to
   * everyone else, including in the live demo where the whole point is that a real
   * person's contribution appears next to the seeded ones. The journey profile is
   * the honest source for a display name, and it is already public to signed-in
   * students.
   */
  const missing = unique.filter((id) => !map.has(id));
  if (missing.length) {
    for (let i = 0; i < missing.length; i += 50) {
      const chunk = missing.slice(i, i + 50);
      try {
        const page = await tablesDB.listRows({
          databaseId: requireDatabaseId(),
          tableId: STUDENT_PROFILES,
          queries: [Query.equal("user_id", chunk), Query.limit(chunk.length)],
        });
        for (const row of page.rows as Row[]) {
          const userId = str(row.user_id);
          const name = str(row.display_name);
          if (!name) continue;
          map.set(userId, {
            id: userId,
            displayName: name,
            initials: initialsFor(name),
            color: colorFor(userId),
            homeCountry: str(row.home_country_code) || undefined,
            hostCountry: str(row.host_country_code) || undefined,
            universityId: str(row.university_id) || undefined,
            languages: parseJson<string[]>(row.languages, []).map(languageCode).filter(Boolean),
            isDemoSeed: false,
          });
        }
      } catch {
        // Same rule as above: a read failure degrades the name, never the feed.
      }
    }
  }

  for (const id of unique) {
    if (map.has(id)) continue;
    map.set(id, {
      id,
      displayName: "Student",
      initials: "ST",
      color: colorFor(id),
      isDemoSeed: false,
    });
  }
  return map;
}

/* -------------------------------- mapping -------------------------------- */

function mapPost(row: Row, author: AuthorSummary, media: PostMedia[], viewer: PostInteractionState): CommunityPost {
  /*
   * Topics are stored in their own column when enrichment has run, and derived
   * from the tags when it has not. Falling back rather than defaulting to an
   * empty array matters: a post with no topics is invisible to the interest and
   * concern components of the ranker, so a missing enrichment would quietly
   * demote every post written before the column existed.
   */
  const storedTopics = parseJson<string[]>(row.topics, []);
  const tags = [...new Set(parseJson<string[]>(row.tags, []))];
  const journeyStage = str(row.journey_stage) || undefined;

  return {
    id: str(row.post_id),
    authorId: str(row.author_id),
    author,
    countryCode: str(row.country_code),
    universityId: str(row.university_id),
    postType: (str(row.post_type, "moment") as PostType) ?? "moment",
    body: str(row.body),
    placeId: str(row.place_id) || undefined,
    /*
     * Deduplicated because a tag is also a React key. A place-type post that links
     * to a place legitimately derives both its type and its "place" tag, so the
     * stored array can repeat a value — and a repeated key makes React drop or
     * duplicate the chip. Normalising here fixes every consumer at once and also
     * repairs rows already written with the duplicate.
     */
    tags,
    topics: storedTopics.length ? storedTopics : tags,
    journeyStage: (journeyStage as ExchangeStage | undefined) ?? undefined,
    reactionCount: viewer.reactionCount ?? num(row.reaction_count),
    commentCount: viewer.commentCount ?? num(row.comment_count),
    /*
     * Saves stay on the stored column because the rows behind them are private.
     * The card renders the viewer's own save state and no public total, so this
     * value is only ever an engagement signal for the ranker.
     */
    saveCount: num(row.save_count),
    media,
    isDemoSeed: bool(row.is_demo_seed),
    verification: str(row.verification) || undefined,
    createdAt: str(row.created_at),
    viewerReacted: viewer.reacted,
    viewerSaved: viewer.saved,
  };
}

async function loadMediaFor(postIds: string[]): Promise<Map<string, PostMedia[]>> {
  const map = new Map<string, PostMedia[]>();
  if (!postIds.length) return map;
  try {
    const page = await tablesDB.listRows({
      databaseId: requireDatabaseId(),
      tableId: POST_MEDIA,
      queries: [Query.equal("post_id", postIds), Query.orderAsc("order_index"), Query.limit(200)],
    });
    for (const row of page.rows as Row[]) {
      const postId = str(row.post_id);
      const list = map.get(postId) ?? [];
      const kind: MediaKind = str(row.kind) === "video" ? "video" : "image";
      list.push({
        id: str(row.media_id),
        kind,
        url: str(row.url),
        alt: str(row.alt_text, kind === "video" ? "Community video" : "Community photo"),
        attribution: str(row.attribution) || undefined,
        license: str(row.license) || undefined,
        durationS: num(row.duration_s) || undefined,
      });
      map.set(postId, list);
    }
  } catch {
    // Media is additive; a failure degrades to a text post rather than an error.
  }
  return map;
}

/**
 * The viewer's own reactions and saves for the posts on screen.
 *
 * These rows are owner-only, so this query can only ever return the viewer's own
 * rows — which is exactly what the heart and bookmark state need.
 */
/**
 * Viewer state *and* public counts for a page of posts, in one pass.
 *
 * WHY COUNTS ARE MEASURED RATHER THAN READ OFF THE POST ROW
 *
 * Phase 5 denormalised `reaction_count` / `comment_count` / `save_count` onto the
 * post row and had `toggleReaction` increment them there. That cannot work under
 * Appwrite's row permissions: a post row is `read(users)` but `update(author)`, so
 * a student reacting to someone else's post got a 401 on the counter write and
 * their reaction silently rolled back. Measured against the live API — reacting to
 * a seeded post returns `401 user_unauthorized` — so reactions were broken for
 * every post the reactor did not author, which is every post that matters.
 *
 * The fix is to stop storing the aggregate. Reactions and comments are public
 * acts on a public post, their rows are readable by signed-in students, and a
 * count is just how many of those rows exist. Nothing needs write access to
 * anybody else's content, and the number can never drift out of sync with the
 * rows it claims to summarise.
 *
 * Saves are the exception and are deliberately *not* counted here: a saved-post
 * row is private to the saver, so a public total cannot be derived without
 * exposing who saved what. The UI therefore shows the viewer's own save state and
 * no public number, which is the honest rendering of private data.
 *
 * A page's counts are one query per table with `post_id IN (…)`, paginated. If
 * that read fails, the stored column is used as a fallback so a degraded feed
 * shows a stale number rather than zero.
 */
interface PostInteractionState {
  reacted: boolean;
  saved: boolean;
  /** `null` means "not measured" — the caller falls back to the stored column. */
  reactionCount: number | null;
  commentCount: number | null;
}

/** Safety valve: stop paging and fall back rather than issuing unbounded reads. */
const COUNT_PAGE_LIMIT = 500;
const COUNT_MAX_PAGES = 8;

async function countByPost(tableId: string, postIds: string[]): Promise<Map<string, number> | null> {
  const counts = new Map<string, number>();
  let cursor: string | null = null;
  try {
    for (let page = 0; page < COUNT_MAX_PAGES; page += 1) {
      const queries = [Query.equal("post_id", postIds), Query.limit(COUNT_PAGE_LIMIT)];
      if (cursor) queries.push(Query.cursorAfter(cursor));
      const result = await tablesDB.listRows({ databaseId: requireDatabaseId(), tableId, queries });
      const rows = result.rows as Row[];
      for (const row of rows) {
        const postId = str(row.post_id);
        counts.set(postId, (counts.get(postId) ?? 0) + 1);
      }
      if (rows.length < COUNT_PAGE_LIMIT) return counts;
      cursor = rows[rows.length - 1].$id;
    }
  } catch {
    // Unreadable table: report "not measured" so the caller degrades explicitly.
    return null;
  }
  // The cap was reached, so the totals are incomplete and must not be shown.
  return null;
}

async function loadViewerState(postIds: string[], viewerId: string | null): Promise<Map<string, PostInteractionState>> {
  const map = new Map<string, PostInteractionState>();
  for (const id of postIds) map.set(id, { reacted: false, saved: false, reactionCount: null, commentCount: null });
  if (!postIds.length) return map;

  const [reactionCounts, commentCounts] = await Promise.all([
    countByPost(REACTIONS, postIds),
    countByPost(COMMENTS, postIds),
  ]);

  for (const [postId, count] of reactionCounts ?? []) {
    const entry = map.get(postId);
    if (entry) entry.reactionCount = count;
  }
  for (const [postId, count] of commentCounts ?? []) {
    const entry = map.get(postId);
    if (entry) entry.commentCount = count;
  }

  if (!viewerId) return map;

  /*
   * The viewer's own rows, read privately. Their reaction row is also what makes
   * the reaction button show as pressed, and their save row is the only thing the
   * save button can honestly reflect.
   */
  const readOwn = async (tableId: string, apply: (postId: string) => void) => {
    try {
      const page = await tablesDB.listRows({
        databaseId: requireDatabaseId(),
        tableId,
        queries: [Query.equal("user_id", viewerId), Query.equal("post_id", postIds), Query.limit(200)],
      });
      for (const row of page.rows as Row[]) apply(str(row.post_id));
    } catch {
      // Degrade to "not reacted": an optimistic toggle will still work.
    }
  };

  await readOwn(REACTIONS, (postId) => {
    const entry = map.get(postId);
    if (entry) entry.reacted = true;
  });
  await readOwn(SAVED_POSTS, (postId) => {
    const entry = map.get(postId);
    if (entry) entry.saved = true;
  });
  return map;
}

/* --------------------------------- feed ---------------------------------- */

export interface FeedQuery {
  filter: FeedFilter;
  hostCountry: string;
  universityId: string;
  viewerId: string | null;
  cursor?: string | null;
  limit?: number;
  /**
   * Required for `for_you`. Absent context does not error — it degrades to
   * chronological order, because a feed that fails to load is worse than a feed
   * that is not personalised yet.
   */
  viewerContext?: ViewerFeedContext;
  /** Required for `near_campus`: place id -> campus distance, in metres. */
  placeById?: Map<string, { universityId: string; distanceFromCampusM: number }>;
  campusRadiusM?: number;
}

export interface FeedPage {
  posts: CommunityPost[];
  /** `null` means there is nothing more to load. */
  nextCursor: string | null;
  /** True when the page was ordered by the ranker rather than by time. */
  ranked?: boolean;
}

const DEFAULT_CAMPUS_RADIUS_M = 2_500;

export async function loadFeed(query: FeedQuery): Promise<Result<FeedPage>> {
  if (!APPWRITE_DATABASE_ID) return { ok: false, error: "unavailable", message: "Community is not configured." };
  const limit = query.limit ?? PAGE_SIZE;

  try {
    // `saved` is the viewer's own list, so it is resolved through their save rows
    // rather than by filtering the public feed.
    if (query.filter === "saved") return loadSavedFeed(query, limit);

    /*
     * For You ranks, so it needs a candidate window wider than one page. The
     * window is bounded and the ranking itself is pure computation over rows
     * already fetched — there is no inference on the scroll path.
     */
    if (query.filter === "for_you") return loadRankedFeed(query, limit);

    const queries = [Query.orderDesc("created_at"), Query.limit(limit)];
    if (query.cursor) queries.push(Query.cursorAfter(query.cursor));

    if (query.filter === "host_country") queries.push(Query.equal("country_code", query.hostCountry));
    if (query.filter === "my_university") {
      // Seeded posts store the short code and real posts store the display name,
      // so both spellings are queried. The campus registry is the only place that
      // knows they mean the same university.
      queries.push(Query.equal("university_id", [query.universityId, query.universityId.toUpperCase()]));
    }

    const types = FILTER_TYPES[query.filter];
    if (types) queries.push(Query.equal("post_type", types));

    const page = await tablesDB.listRows({ databaseId: requireDatabaseId(), tableId: POSTS, queries });
    let rows = page.rows as Row[];

    /*
     * Near Campus is a place scope, so it filters on the place layer rather than
     * on the post row: `community_posts` has no coordinates and should not gain
     * any. A post is near campus when its tagged place is, which keeps the
     * objective map data and the community layer separate.
     */
    if (query.filter === "near_campus") {
      const radius = query.campusRadiusM ?? DEFAULT_CAMPUS_RADIUS_M;
      const placeById = query.placeById ?? new Map();
      rows = rows.filter((row) => {
        const placeId = str(row.place_id);
        if (!placeId) return false;
        const place = placeById.get(placeId);
        return Boolean(place) && place!.distanceFromCampusM <= radius;
      });
    }

    const posts = await hydratePosts(rows, query.viewerId);
    return { ok: true, value: { posts, nextCursor: rows.length === limit ? str(rows[rows.length - 1].post_id) : null } };
  } catch (error) {
    return fail(error);
  }
}

/**
 * For You: retrieve a bounded candidate window, rank it, return one page.
 *
 * The next cursor is the last post *of the returned page* rather than of the
 * candidate window. Paging a ranked list is inherently approximate — the same
 * caveat every ranked feed carries — but using the page boundary means "load
 * more" continues from what the student actually saw instead of skipping the
 * posts the ranker placed just past the fold.
 */
async function loadRankedFeed(query: FeedQuery, limit: number): Promise<Result<FeedPage>> {
  const window = Math.max(RANK_CANDIDATE_WINDOW, limit);
  const queries = [Query.orderDesc("created_at"), Query.limit(window)];
  if (query.cursor) queries.push(Query.cursorAfter(query.cursor));

  const page = await tablesDB.listRows({ databaseId: requireDatabaseId(), tableId: POSTS, queries });
  const rows = page.rows as Row[];
  const posts = await hydratePosts(rows, query.viewerId);

  const context = query.viewerContext;
  if (!context) {
    // No viewer context yet (a brand-new session, or a failed signal read).
    // Chronological is a valid feed; an error is not.
    const slice = posts.slice(0, limit);
    return { ok: true, value: { posts: slice, nextCursor: slice.length ? slice[slice.length - 1].id : null, ranked: false } };
  }

  const ranked = withReasons(rankFeed(posts, { viewer: context, limit }));
  return { ok: true, value: { posts: ranked, nextCursor: ranked.length ? ranked[ranked.length - 1].id : null, ranked: true } };
}

async function loadSavedFeed(query: FeedQuery, limit: number): Promise<Result<FeedPage>> {
  if (!query.viewerId) return { ok: true, value: { posts: [], nextCursor: null } };
  try {
    const saves = await tablesDB.listRows({
      databaseId: requireDatabaseId(),
      tableId: SAVED_POSTS,
      queries: [Query.equal("user_id", query.viewerId), Query.orderDesc("created_at"), Query.limit(limit)],
    });
    const ids = (saves.rows as Row[]).map((row) => str(row.post_id));
    if (!ids.length) return { ok: true, value: { posts: [], nextCursor: null } };

    const page = await tablesDB.listRows({
      databaseId: requireDatabaseId(),
      tableId: POSTS,
      queries: [Query.equal("post_id", ids), Query.limit(limit)],
    });
    const order = new Map(ids.map((id, index) => [id, index]));
    const rows = (page.rows as Row[]).sort((a, b) => (order.get(str(a.post_id)) ?? 0) - (order.get(str(b.post_id)) ?? 0));
    const posts = await hydratePosts(rows, query.viewerId);
    return { ok: true, value: { posts, nextCursor: ids.length === limit ? ids[ids.length - 1] : null } };
  } catch (error) {
    return fail(error);
  }
}

/** Shared post hydration: authors, media and the viewer's own state, batched. */
export async function hydratePosts(rows: Row[], viewerId: string | null): Promise<CommunityPost[]> {
  const ids = rows.map((row) => str(row.post_id));
  const [authors, media, state] = await Promise.all([
    loadAuthors(rows.map((row) => str(row.author_id))),
    loadMediaFor(ids),
    loadViewerState(ids, viewerId),
  ]);
  return rows.map((row) => {
    const authorId = str(row.author_id);
    const postId = str(row.post_id);
    return mapPost(
      row,
      authors.get(authorId) ?? { id: authorId, displayName: "Student", initials: "ST", color: colorFor(authorId), isDemoSeed: false },
      media.get(postId) ?? [],
      state.get(postId) ?? { reacted: false, saved: false, reactionCount: null, commentCount: null },
    );
  });
}

export async function loadPost(postId: string, viewerId: string | null): Promise<Result<CommunityPost>> {
  try {
    const row = await tablesDB.getRow({ databaseId: requireDatabaseId(), tableId: POSTS, rowId: postId });
    const [post] = await hydratePosts([row as Row], viewerId);
    return { ok: true, value: post };
  } catch (error) {
    return fail(error);
  }
}

/** Posts attached to one place — the Explore half of the feed↔place bridge. */
export async function loadPostsForPlace(placeId: string, viewerId: string | null): Promise<Result<CommunityPost[]>> {
  try {
    const page = await tablesDB.listRows({
      databaseId: requireDatabaseId(),
      tableId: POSTS,
      queries: [Query.equal("place_id", placeId), Query.orderDesc("created_at"), Query.limit(20)],
    });
    return { ok: true, value: await hydratePosts(page.rows as Row[], viewerId) };
  } catch (error) {
    return fail(error);
  }
}

/* -------------------------------- writes --------------------------------- */

export interface NewPostInput {
  authorId: string;
  countryCode: string;
  universityId: string;
  postType: PostType;
  body: string;
  placeId?: string | null;
  /** The pinned place's name, used as enrichment's place context. */
  placeName?: string | null;
  tags?: string[];
  images?: File[];
  video?: File | null;
  onProgress?: (update: UploadProgress) => void;
}

/**
 * Upload progress for one file.
 *
 * `percent` is null when the SDK cannot report one. Appwrite only emits progress
 * callbacks for files above its 5 MB chunk threshold, so a small photo uploads
 * in a single request with no intermediate events. Reporting `null` and letting
 * the UI show an indeterminate bar is the honest option — inventing a synthetic
 * percentage that ticks on a timer is exactly the kind of fake progress this
 * project has already had to rip out once.
 */
export interface UploadProgress {
  percent: number | null;
  index: number;
  total: number;
  label: string;
}

export interface MediaValidationError {
  ok: false;
  error: AppError;
  message: string;
}

/** Validate the attachment set before a single byte leaves the device. */
export function validateMedia(images: File[], video: File | null): MediaValidationError | null {
  if (images.length > MEDIA_LIMITS.maxImagesPerPost) {
    return { ok: false, error: "failed", message: `You can attach up to ${MEDIA_LIMITS.maxImagesPerPost} photos.` };
  }
  for (const image of images) {
    if (mediaKindFor(image.type) !== "image") {
      return { ok: false, error: "failed", message: "Photos must be JPG, PNG or WebP." };
    }
    if (image.size > MEDIA_LIMITS.maxImageBytes) {
      return { ok: false, error: "failed", message: `Each photo must be under ${Math.round(MEDIA_LIMITS.maxImageBytes / 1_000_000)} MB.` };
    }
  }
  if (video) {
    if (mediaKindFor(video.type) !== "video") {
      return { ok: false, error: "failed", message: "Video must be MP4 or WebM." };
    }
    if (video.size > MEDIA_LIMITS.maxVideoBytes) {
      return { ok: false, error: "failed", message: `Video must be under ${Math.round(MEDIA_LIMITS.maxVideoBytes / 1_000_000)} MB.` };
    }
  }
  return null;
}

/**
 * Read a video's duration in the browser.
 *
 * Returns null rather than throwing when the browser cannot decode the file:
 * duration is decoration on the card, and a codec the browser cannot read must
 * not be the reason a student cannot post.
 */
export async function readVideoDuration(file: File): Promise<number | null> {
  if (typeof document === "undefined") return null;
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const element = document.createElement("video");
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(value);
    };
    element.preload = "metadata";
    element.onloadedmetadata = () => finish(Number.isFinite(element.duration) ? Math.round(element.duration) : null);
    element.onerror = () => finish(null);
    window.setTimeout(() => finish(null), 5000);
    element.src = url;
  });
}

export async function createPost(input: NewPostInput): Promise<Result<CommunityPost>> {
  const body = input.body.trim();
  if (!body) return { ok: false, error: "failed", message: "Write something before posting." };
  if (body.length > 4000) return { ok: false, error: "failed", message: "Posts are limited to 4000 characters." };

  const images = input.images ?? [];
  const video = input.video ?? null;
  const invalid = validateMedia(images, video);
  if (invalid) return invalid;

  const files: { file: File; kind: MediaKind }[] = [
    ...images.map((file) => ({ file, kind: "image" as const })),
    ...(video ? [{ file: video, kind: "video" as const }] : []),
  ];

  /*
   * Enrichment runs BEFORE any network call and cannot fail: `deriveMetadata` is
   * a pure function over the caption. That ordering is deliberate — it is what
   * makes "publish works with the AI gateway down" a property of the code rather
   * than a promise.
   */
  const metadata = deriveMetadata({ body, postType: input.postType, placeName: input.placeName ?? null, explicitTags: input.tags });
  const durationS = video ? await readVideoDuration(video) : null;

  const uploaded: { fileId: string; url: string; kind: MediaKind; durationS?: number }[] = [];
  const postId = ID.unique();
  const createdAt = new Date().toISOString();

  try {
    for (const [index, entry] of files.entries()) {
      const upload = await uploadCommunityMedia(entry.file, input.authorId, (percent) => {
        input.onProgress?.({
          percent,
          index,
          total: files.length,
          label: entry.kind === "video" ? "Uploading video" : "Uploading photo",
        });
      });
      if (!upload.ok) {
        // A partial upload must not leave files behind for a post that will
        // never exist.
        await discardUploads(uploaded.map((item) => item.fileId));
        return upload;
      }
      uploaded.push({ ...upload.value, kind: entry.kind, durationS: entry.kind === "video" ? (durationS ?? undefined) : undefined });
    }

    await tablesDB.createRow({
      databaseId: requireDatabaseId(),
      tableId: POSTS,
      rowId: postId,
      data: {
        post_id: postId,
        author_id: input.authorId,
        country_code: input.countryCode,
        /*
         * Stored upper-case so a post written by the app and a seeded post share one
         * spelling. The seeded corpus uses the short code ("NUS") while the campus
         * registry returns it lower-cased ("nus"), and the mismatch is visible
         * wherever the raw value is displayed — it produced both "Students at nus"
         * and "Students at NUS" in the same feed.
         */
        university_id: input.universityId.toUpperCase(),
        post_type: input.postType,
        body,
        place_id: input.placeId ?? "",
        tags: JSON.stringify(input.tags ?? [input.postType]),
        topics: JSON.stringify(metadata.topics),
        journey_stage: metadata.journeyStage ?? "",
        visibility: "public",
        is_demo_seed: 0,
        seed_origin: "user",
        verification: "unverified_user",
        reaction_count: 0,
        comment_count: 0,
        save_count: 0,
        media_count: uploaded.length,
        created_at: createdAt,
        updated_at: createdAt,
      },
      permissions: publicRowPermissions(input.authorId),
    });

    const media: PostMedia[] = [];
    for (const [index, item] of uploaded.entries()) {
      const mediaId = `${postId}_m${index}`;
      const entry: PostMedia = {
        id: mediaId,
        kind: item.kind,
        url: item.url,
        alt: item.kind === "video" ? "Video shared by a student" : "Photo shared by a student",
        durationS: item.durationS,
      };
      media.push(entry);
      await tablesDB.createRow({
        databaseId: requireDatabaseId(),
        tableId: POST_MEDIA,
        rowId: mediaId,
        data: {
          media_id: mediaId,
          post_id: postId,
          kind: item.kind,
          file_id: item.fileId,
          url: item.url,
          width: 0,
          height: 0,
          alt_text: entry.alt,
          attribution: "",
          license: "",
          duration_s: item.durationS ?? 0,
          order_index: index,
          created_at: createdAt,
        },
        permissions: publicRowPermissions(input.authorId),
      });
    }

    return {
      ok: true,
      value: {
        id: postId,
        authorId: input.authorId,
        author: { id: input.authorId, displayName: "You", initials: "YO", color: colorFor(input.authorId), isDemoSeed: false },
        countryCode: input.countryCode,
        universityId: input.universityId,
        postType: input.postType,
        body,
        placeId: input.placeId ?? undefined,
        tags: input.tags ?? [input.postType],
        topics: metadata.topics,
        journeyStage: metadata.journeyStage ?? undefined,
        reactionCount: 0,
        commentCount: 0,
        saveCount: 0,
        media,
        isDemoSeed: false,
        createdAt,
        viewerReacted: false,
        viewerSaved: false,
      },
    };
  } catch (error) {
    // The post row failed after the files landed: clean up, then report.
    await discardUploads(uploaded.map((item) => item.fileId));
    return fail(error);
  }
}

/** Best-effort removal of files uploaded for a write that did not complete. */
async function discardUploads(fileIds: string[]): Promise<void> {
  if (!APPWRITE_COMMUNITY_MEDIA_BUCKET_ID) return;
  await Promise.all(
    fileIds.map(async (fileId) => {
      try {
        await storage.deleteFile({ bucketId: APPWRITE_COMMUNITY_MEDIA_BUCKET_ID, fileId });
      } catch {
        // A file that cannot be removed is reported by the orphan audit rather
        // than failing the student's action.
      }
    }),
  );
}

/**
 * Delete a post and everything that belonged to it.
 *
 * Media rows and their storage files are removed first and best-effort: a
 * deleted post whose images are still downloadable is a privacy bug, and an
 * orphaned file is a bill. Failures here are swallowed deliberately — refusing
 * to delete the post because a file could not be removed would leave the
 * content the student asked to remove exactly where it was.
 */
export async function deletePost(postId: string): Promise<Result<true>> {
  try {
    await deletePostMedia(postId);
    await tablesDB.deleteRow({ databaseId: requireDatabaseId(), tableId: POSTS, rowId: postId });
    return { ok: true, value: true };
  } catch (error) {
    return fail(error);
  }
}

async function deletePostMedia(postId: string): Promise<void> {
  let rows: Row[] = [];
  try {
    const page = await tablesDB.listRows({
      databaseId: requireDatabaseId(),
      tableId: POST_MEDIA,
      queries: [Query.equal("post_id", postId), Query.limit(50)],
    });
    rows = page.rows as Row[];
  } catch {
    return;
  }

  const fileIds = rows.map((row) => str(row.file_id)).filter(Boolean);
  await discardUploads(fileIds);

  await Promise.all(
    rows.map(async (row) => {
      try {
        await tablesDB.deleteRow({ databaseId: requireDatabaseId(), tableId: POST_MEDIA, rowId: str(row.media_id) });
      } catch {
        /* a media row that cannot be removed must not block the post deletion */
      }
    }),
  );
}

/**
 * Delete one of the viewer's own comments.
 *
 * The row *is* the count: removing it is the decrement, and the next hydration
 * reads the true total back from the table. Nothing is written to the post row,
 * which is what made the previous version fail with 401 for anyone removing a
 * comment on a post they did not author.
 */
export async function deleteComment(commentId: string): Promise<Result<true>> {
  try {
    await tablesDB.deleteRow({ databaseId: requireDatabaseId(), tableId: COMMENTS, rowId: commentId });
    return { ok: true, value: true };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Add or remove the viewer's reaction.
 *
 * The reaction row *is* the reaction. There is no counter to keep in step: the
 * displayed total is the number of these rows, counted at read time. An earlier
 * version also wrote `reaction_count` back onto the post row, which failed with
 * 401 for every reactor who was not the post's author — the counter was only ever
 * correct for the one person who could not meaningfully react to themselves.
 *
 * The return value deliberately carries no count. Returning one would let the UI
 * overwrite the value it just optimistically computed with a number derived from a
 * stale prop, and the two only agree by luck.
 */
export async function toggleReaction(postId: string, userId: string, reacted: boolean): Promise<Result<{ reacted: boolean }>> {
  const rowId = pairRowId("sr_", postId, userId);
  try {
    if (reacted) {
      await tablesDB.deleteRow({ databaseId: requireDatabaseId(), tableId: REACTIONS, rowId });
    } else {
      await tablesDB.createRow({
        databaseId: requireDatabaseId(),
        tableId: REACTIONS,
        rowId,
        data: { reaction_id: rowId, post_id: postId, user_id: userId, kind: "like", created_at: new Date().toISOString() },
        /*
         * Readable by signed-in students, deletable only by the reactor.
         *
         * A reaction on a public post is a public act, and the aggregate count is
         * derived from these rows — an owner-only read permission would make every
         * count private to the person who cast it, so a feed would show each
         * viewer a different number. Delete stays with the owner: nobody else may
         * take back a reaction that is not theirs.
         */
        permissions: [Permission.read(Role.users()), Permission.delete(Role.user(userId))],
      });
    }
    return { ok: true, value: { reacted: !reacted } };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Add or remove the viewer's save.
 *
 * Save rows are private to the saver — who saved what is exactly the kind of
 * signal the brief forbids exposing — so unlike a reaction there is no public
 * aggregate to display and no count in the return value.
 */
export async function toggleSavePost(postId: string, userId: string, saved: boolean): Promise<Result<{ saved: boolean }>> {
  const rowId = pairRowId("sp_", postId, userId);
  try {
    if (saved) {
      await tablesDB.deleteRow({ databaseId: requireDatabaseId(), tableId: SAVED_POSTS, rowId });
    } else {
      await tablesDB.createRow({
        databaseId: requireDatabaseId(),
        tableId: SAVED_POSTS,
        rowId,
        data: { save_id: rowId, post_id: postId, user_id: userId, created_at: new Date().toISOString() },
        permissions: ownerRowPermissions(userId),
      });
    }
    return { ok: true, value: { saved: !saved } };
  } catch (error) {
    return fail(error);
  }
}

export async function loadComments(postId: string): Promise<Result<PostComment[]>> {
  try {
    const page = await tablesDB.listRows({
      databaseId: requireDatabaseId(),
      tableId: COMMENTS,
      queries: [Query.equal("post_id", postId), Query.orderAsc("created_at"), Query.limit(100)],
    });
    const rows = page.rows as Row[];
    const authors = await loadAuthors(rows.map((row) => str(row.author_id)));
    return {
      ok: true,
      value: rows.map((row) => {
        const authorId = str(row.author_id);
        return {
          id: str(row.comment_id),
          postId: str(row.post_id),
          authorId,
          author: authors.get(authorId) ?? { id: authorId, displayName: "Student", initials: "ST", color: colorFor(authorId), isDemoSeed: false },
          body: str(row.body),
          isDemoSeed: bool(row.is_demo_seed),
          createdAt: str(row.created_at),
        };
      }),
    };
  } catch (error) {
    return fail(error);
  }
}

export async function addComment(postId: string, authorId: string, body: string): Promise<Result<PostComment>> {
  const text = body.trim();
  if (!text) return { ok: false, error: "failed", message: "Write a comment first." };
  try {
    const commentId = ID.unique();
    const createdAt = new Date().toISOString();
    await tablesDB.createRow({
      databaseId: requireDatabaseId(),
      tableId: COMMENTS,
      rowId: commentId,
      data: { comment_id: commentId, post_id: postId, author_id: authorId, body: text, is_demo_seed: 0, created_at: createdAt },
      permissions: publicRowPermissions(authorId),
    });
    /*
     * No counter write. Comment rows are `read(users)`, so the count is derived
     * from them at hydration time; writing `comment_count` onto the post row would
     * 401 for anyone commenting on a post they did not author — which is every
     * comment on someone else's post, i.e. the entire point of a comment.
     */
    return {
      ok: true,
      value: {
        id: commentId,
        postId,
        authorId,
        author: { id: authorId, displayName: "You", initials: "YO", color: colorFor(authorId), isDemoSeed: false },
        body: text,
        isDemoSeed: false,
        createdAt,
      },
    };
  } catch (error) {
    return fail(error);
  }
}

/* -------------------------------- uploads -------------------------------- */

export interface UploadedMedia {
  fileId: string;
  url: string;
}

/**
 * Upload one community file.
 *
 * Validated before the request so an oversized or wrong-typed file produces a
 * sentence the student can act on instead of a 400 from the storage service. The
 * file itself is granted authenticated read: the post it belongs to is public to
 * signed-in students, so the image has to be readable by the same audience.
 *
 * `onProgress` is forwarded to the SDK's chunked uploader. Appwrite only emits
 * callbacks above its 5 MB chunk threshold, so a small file reports `null` and
 * the UI shows an indeterminate bar rather than a fabricated percentage.
 */
export async function uploadCommunityMedia(file: File, ownerId: string, onProgress?: (percent: number | null) => void): Promise<Result<UploadedMedia>> {
  const kind = mediaKindFor(file.type);
  if (!kind) {
    return { ok: false, error: "failed", message: "Attachments must be JPG, PNG, WebP, MP4 or WebM." };
  }
  const cap = kind === "video" ? MEDIA_LIMITS.maxVideoBytes : MEDIA_LIMITS.maxImageBytes;
  if (file.size > cap) {
    return { ok: false, error: "failed", message: `That file must be under ${Math.round(cap / 1_000_000)} MB.` };
  }
  if (!APPWRITE_COMMUNITY_MEDIA_BUCKET_ID) {
    return { ok: false, error: "unavailable", message: "Media upload is not configured." };
  }

  try {
    const created = await storage.createFile({
      bucketId: APPWRITE_COMMUNITY_MEDIA_BUCKET_ID,
      fileId: ID.unique(),
      file,
      permissions: [Permission.read(Role.users()), Permission.update(Role.user(ownerId)), Permission.delete(Role.user(ownerId))],
      onProgress: (event: { progress: number }) => onProgress?.(event?.progress ?? null),
    });
    const url = storage.getFileView({ bucketId: APPWRITE_COMMUNITY_MEDIA_BUCKET_ID, fileId: created.$id }).toString();
    return { ok: true, value: { fileId: created.$id, url } };
  } catch (error) {
    return fail(error);
  }
}

/** Downscale in the browser so a phone photo is not uploaded at 12 MP. */
export async function downscaleImage(file: File, maxEdge = 1600, quality = 0.82): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.\w+$/, ".jpg"), { type: "image/jpeg" });
  } catch {
    // A browser without createImageBitmap still uploads the original.
    return file;
  }
}

/* ----------------------------- viewer signals ---------------------------- */

export interface FeedSignals {
  followedIds: Set<string>;
  savedPlaceIds: Set<string>;
  engagedTypes: Set<PostType>;
  engagedTopics: Set<string>;
  hiddenPostIds: Set<string>;
}

export const EMPTY_SIGNALS: FeedSignals = {
  followedIds: new Set(),
  savedPlaceIds: new Set(),
  engagedTypes: new Set(),
  engagedTopics: new Set(),
  hiddenPostIds: new Set(),
};

/**
 * Everything the ranker needs to know about the viewer's own behaviour.
 *
 * Each block is independently failure-tolerant. A signal that cannot be read
 * leaves its set empty, which makes the ranker slightly less personalised — the
 * correct degradation. The alternative, failing the whole call, would empty the
 * feed because one auxiliary query timed out.
 */
export async function loadFeedSignals(userId: string | null): Promise<FeedSignals> {
  if (!userId || !APPWRITE_DATABASE_ID) return EMPTY_SIGNALS;

  const readRows = async (tableId: string, queries: unknown[]): Promise<Row[]> => {
    try {
      const page = await tablesDB.listRows({ databaseId: requireDatabaseId(), tableId, queries: queries as never[] });
      return page.rows as Row[];
    } catch {
      return [];
    }
  };

  const [followRows, saveRows, reactionRows, savedPostRows, commentRows, reportRows] = await Promise.all([
    readRows(FOLLOWS, [Query.equal("follower_id", userId), Query.limit(500)]),
    readRows(SAVED_PLACES, [Query.equal("user_id", userId), Query.limit(500)]),
    readRows(REACTIONS, [Query.equal("user_id", userId), Query.orderDesc("created_at"), Query.limit(200)]),
    readRows(SAVED_POSTS, [Query.equal("user_id", userId), Query.orderDesc("created_at"), Query.limit(200)]),
    readRows(COMMENTS, [Query.equal("author_id", userId), Query.orderDesc("created_at"), Query.limit(200)]),
    readRows(REPORTS, [Query.equal("reporter_id", userId), Query.limit(200)]),
  ]);

  const engagedPostIds = [
    ...new Set([
      ...reactionRows.map((row) => str(row.post_id)),
      ...savedPostRows.map((row) => str(row.post_id)),
      ...commentRows.map((row) => str(row.post_id)),
    ]),
  ].filter(Boolean);

  const engagedTypes = new Set<PostType>();
  const engagedTopics = new Set<string>();

  // One batched read of the engaged posts gives both the type affinity and the
  // topic affinity. Without it the ranker would have to treat "reacted to
  // something" as an opaque signal, which is not explainable to a student.
  if (engagedPostIds.length) {
    for (let index = 0; index < engagedPostIds.length; index += 50) {
      const chunk = engagedPostIds.slice(index, index + 50);
      const rows = await readRows(POSTS, [Query.equal("post_id", chunk), Query.limit(chunk.length)]);
      for (const row of rows) {
        const type = str(row.post_type) as PostType;
        if (type) engagedTypes.add(type);
        const topics = parseJson<string[]>(row.topics, []);
        const tags = parseJson<string[]>(row.tags, []);
        for (const topic of topics.length ? topics : tags) engagedTopics.add(topic);
      }
    }
  }

  return {
    followedIds: new Set(followRows.map((row) => str(row.following_id)).filter(Boolean)),
    savedPlaceIds: new Set(saveRows.map((row) => str(row.place_id)).filter(Boolean)),
    engagedTypes,
    engagedTopics,
    hiddenPostIds: new Set(
      reportRows.filter((row) => str(row.target_type) === "post").map((row) => str(row.target_id)).filter(Boolean),
    ),
  };
}
