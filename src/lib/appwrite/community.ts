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
  type AuthorSummary,
  type CommunityPost,
  type FeedFilter,
  type PostComment,
  type PostMedia,
  type PostType,
} from "../phase5/contract";

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

export const PAGE_SIZE = 20;

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
            isDemoSeed: bool(row.is_demo_seed),
          });
        }
      } catch {
        // A profile read failure must not blank the feed: fall through to the
        // synthesised author below, which still renders a name and initials.
      }
    }),
  );

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

function mapPost(row: Row, author: AuthorSummary, media: PostMedia[], viewer: { reacted: boolean; saved: boolean }): CommunityPost {
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
    tags: [...new Set(parseJson<string[]>(row.tags, []))],
    reactionCount: num(row.reaction_count),
    commentCount: num(row.comment_count),
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
      list.push({
        id: str(row.media_id),
        kind: "image",
        url: str(row.url),
        alt: str(row.alt_text, "Community photo"),
        attribution: str(row.attribution) || undefined,
        license: str(row.license) || undefined,
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
async function loadViewerState(postIds: string[], viewerId: string | null): Promise<Map<string, { reacted: boolean; saved: boolean }>> {
  const map = new Map<string, { reacted: boolean; saved: boolean }>();
  for (const id of postIds) map.set(id, { reacted: false, saved: false });
  if (!viewerId || !postIds.length) return map;

  const read = async (tableId: string, apply: (postId: string) => void) => {
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

  await read(REACTIONS, (postId) => {
    const entry = map.get(postId);
    if (entry) entry.reacted = true;
  });
  await read(SAVED_POSTS, (postId) => {
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
}

export interface FeedPage {
  posts: CommunityPost[];
  /** `null` means there is nothing more to load. */
  nextCursor: string | null;
}

export async function loadFeed(query: FeedQuery): Promise<Result<FeedPage>> {
  if (!APPWRITE_DATABASE_ID) return { ok: false, error: "unavailable", message: "Community is not configured." };
  const limit = query.limit ?? PAGE_SIZE;

  try {
    // `saved` is the viewer's own list, so it is resolved through their save rows
    // rather than by filtering the public feed.
    if (query.filter === "saved") return loadSavedFeed(query, limit);

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
    const rows = page.rows as Row[];
    const posts = await hydratePosts(rows, query.viewerId);
    return { ok: true, value: { posts, nextCursor: rows.length === limit ? str(rows[rows.length - 1].post_id) : null } };
  } catch (error) {
    return fail(error);
  }
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
  const [authors, media, viewer] = await Promise.all([
    loadAuthors(rows.map((row) => str(row.author_id))),
    loadMediaFor(ids),
    loadViewerState(ids, viewerId),
  ]);
  return rows.map((row) => {
    const authorId = str(row.author_id);
    return mapPost(
      row,
      authors.get(authorId) ?? { id: authorId, displayName: "Student", initials: "ST", color: colorFor(authorId), isDemoSeed: false },
      media.get(str(row.post_id)) ?? [],
      viewer.get(str(row.post_id)) ?? { reacted: false, saved: false },
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
  tags?: string[];
  file?: File | null;
}

export async function createPost(input: NewPostInput): Promise<Result<CommunityPost>> {
  const body = input.body.trim();
  if (!body) return { ok: false, error: "failed", message: "Write something before posting." };
  if (body.length > 4000) return { ok: false, error: "failed", message: "Posts are limited to 4000 characters." };

  try {
    const postId = ID.unique();
    const createdAt = new Date().toISOString();

    let media: PostMedia[] = [];
    if (input.file) {
      const upload = await uploadCommunityMedia(input.file, input.authorId);
      if (!upload.ok) return upload;
      media = [
        {
          id: `${postId}_m0`,
          kind: "image",
          url: upload.value.url,
          alt: "Photo shared by a student",
        },
      ];
    }

    await tablesDB.createRow({
      databaseId: requireDatabaseId(),
      tableId: POSTS,
      rowId: postId,
      data: {
        post_id: postId,
        author_id: input.authorId,
        country_code: input.countryCode,
        university_id: input.universityId,
        post_type: input.postType,
        body,
        place_id: input.placeId ?? "",
        tags: JSON.stringify(input.tags ?? [input.postType]),
        visibility: "public",
        is_demo_seed: 0,
        seed_origin: "user",
        verification: "unverified_user",
        reaction_count: 0,
        comment_count: 0,
        save_count: 0,
        media_count: media.length,
        created_at: createdAt,
        updated_at: createdAt,
      },
      permissions: publicRowPermissions(input.authorId),
    });

    for (const [index, item] of media.entries()) {
      await tablesDB.createRow({
        databaseId: requireDatabaseId(),
        tableId: POST_MEDIA,
        rowId: item.id,
        data: {
          media_id: item.id,
          post_id: postId,
          kind: "image",
          file_id: "",
          url: item.url,
          width: 0,
          height: 0,
          alt_text: item.alt,
          attribution: "",
          license: "",
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
    return fail(error);
  }
}

export async function deletePost(postId: string): Promise<Result<true>> {
  try {
    await tablesDB.deleteRow({ databaseId: requireDatabaseId(), tableId: POSTS, rowId: postId });
    return { ok: true, value: true };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Toggle a reaction.
 *
 * The post's `reaction_count` is updated in the same call so the number the
 * viewer sees is derived from a write that actually happened. The unique index on
 * (post_id, user_id) makes a double tap impossible to persist as two rows.
 */
export async function toggleReaction(postId: string, userId: string, currentCount: number, reacted: boolean): Promise<Result<{ reacted: boolean; count: number }>> {
  const nextCount = Math.max(0, currentCount + (reacted ? -1 : 1));
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
        permissions: ownerRowPermissions(userId),
      });
    }
    await tablesDB.updateRow({ databaseId: requireDatabaseId(), tableId: POSTS, rowId: postId, data: { reaction_count: nextCount } });
    return { ok: true, value: { reacted: !reacted, count: nextCount } };
  } catch (error) {
    return fail(error);
  }
}

export async function toggleSavePost(postId: string, userId: string, currentCount: number, saved: boolean): Promise<Result<{ saved: boolean; count: number }>> {
  const nextCount = Math.max(0, currentCount + (saved ? -1 : 1));
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
    await tablesDB.updateRow({ databaseId: requireDatabaseId(), tableId: POSTS, rowId: postId, data: { save_count: nextCount } });
    return { ok: true, value: { saved: !saved, count: nextCount } };
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

export async function addComment(postId: string, authorId: string, body: string, currentCount: number): Promise<Result<PostComment>> {
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
    await tablesDB.updateRow({ databaseId: requireDatabaseId(), tableId: POSTS, rowId: postId, data: { comment_count: currentCount + 1 } });
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

const MAX_UPLOAD_BYTES = 6_000_000;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];

export interface UploadedMedia {
  fileId: string;
  url: string;
}

/**
 * Upload a community photo.
 *
 * Validated before the request so an oversized or wrong-typed file produces a
 * sentence the student can act on instead of a 400 from the storage service. The
 * file itself is granted authenticated read: the post it belongs to is public to
 * signed-in students, so the image has to be readable by the same audience.
 */
export async function uploadCommunityMedia(file: File, ownerId: string): Promise<Result<UploadedMedia>> {
  if (!ALLOWED_TYPES.includes(file.type)) {
    return { ok: false, error: "failed", message: "Photos must be JPG, PNG or WebP." };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, error: "failed", message: `Photos must be under ${Math.round(MAX_UPLOAD_BYTES / 1_000_000)} MB.` };
  }
  if (!APPWRITE_COMMUNITY_MEDIA_BUCKET_ID) {
    return { ok: false, error: "unavailable", message: "Photo upload is not configured." };
  }

  try {
    const created = await storage.createFile({
      bucketId: APPWRITE_COMMUNITY_MEDIA_BUCKET_ID,
      fileId: ID.unique(),
      file,
      permissions: [Permission.read(Role.users()), Permission.update(Role.user(ownerId)), Permission.delete(Role.user(ownerId))],
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
