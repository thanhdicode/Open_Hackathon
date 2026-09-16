import { ID, Query, type Models } from "appwrite";
import { APPWRITE_DATABASE_ID, requireDatabaseId, tablesDB } from "./client";
import { appError, appErrorMessage, type AppError } from "./errors";
import { colorFor, initialsFor, pairRowId } from "./community";
import { listBlockedUsers } from "./blocks";
import type { ExchangeRole, SocialProfile } from "../phase5/contract";

/**
 * Connect People — profile reads, follows and reports.
 *
 * Reads rely on row-level permissions: a `student_social_profiles` row is visible
 * to another student only when its owner turned discoverability on, which is what
 * stamps `read("users")` on it. `saveSocialProfile` in `profiles.ts` writes that
 * grant, so turning the setting off genuinely removes the row from everyone
 * else's People list.
 *
 * Blocks reuse the Phase 2 `user_blocks` table rather than a Phase 5 duplicate.
 */

const PROFILES = "student_social_profiles";
const FOLLOWS = "follows";
const REPORTS = "reports";
const CONTRIBUTIONS = "place_contributions";
const POSTS = "community_posts";

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError; message: string };

function fail(error: unknown): Result<never> {
  const code = appError(error);
  return { ok: false, error: code, message: appErrorMessage(code) };
}

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

const ROLES: ExchangeRole[] = ["local", "current_exchange", "incoming", "returned"];

function mapProfile(row: Row, counts?: Partial<SocialProfile["counts"]>): SocialProfile {
  const userId = str(row.user_id);
  const displayName = str(row.display_name, "Student");
  const role = ROLES.includes(str(row.role) as ExchangeRole) ? (str(row.role) as ExchangeRole) : "incoming";
  return {
    userId,
    displayName,
    initials: initialsFor(displayName),
    color: colorFor(userId),
    role,
    homeCountry: str(row.home_country_code) || str(row.current_country) || undefined,
    hostCountry: str(row.host_country_code) || undefined,
    city: str(row.city),
    universityId: str(row.university_id),
    major: str(row.major),
    bio: str(row.bio),
    languages: parseJson<string[]>(row.languages, []),
    interests: parseJson<string[]>(row.interests, []),
    discoverable: bool(row.discoverable),
    localHelper: bool(row.local_helper),
    isDemoSeed: bool(row.is_demo_seed),
    verification: str(row.verification) || undefined,
    joinedAt: str(row.joined_at) || undefined,
    // Read from the row rather than assumed: if a future write ever set this, the
    // UI's "we never share your live location" line would be false, and a test
    // that reads the stored value is the only way to catch that.
    liveLocationShared: bool(row.live_location_shared),
    counts: { posts: 0, tips: 0, placesShared: 0, helpfulAnswers: 0, ...counts },
  };
}

/* --------------------------------- reads --------------------------------- */

export interface LoadProfilesOptions {
  hostCountry?: string;
  viewerId?: string | null;
  limit?: number;
}

export async function loadDiscoverableProfiles(options: LoadProfilesOptions = {}): Promise<Result<SocialProfile[]>> {
  if (!APPWRITE_DATABASE_ID) return { ok: false, error: "unavailable", message: "Connect is not configured." };
  try {
    const queries = [Query.equal("discoverable", 1), Query.limit(options.limit ?? 60)];
    if (options.hostCountry) queries.unshift(Query.equal("host_country_code", options.hostCountry));

    let rows: Row[];
    try {
      const page = await tablesDB.listRows({ databaseId: requireDatabaseId(), tableId: PROFILES, queries });
      rows = page.rows as Row[];
    } catch (error) {
      // A missing index on host_country_code would fail the filtered query; fall
      // back to the unfiltered list so People still works rather than erroring.
      if (options.hostCountry) {
        const page = await tablesDB.listRows({
          databaseId: requireDatabaseId(),
          tableId: PROFILES,
          queries: [Query.equal("discoverable", 1), Query.limit(options.limit ?? 60)],
        });
        rows = page.rows as Row[];
      } else {
        throw error;
      }
    }

    const profiles = rows.map((row) => mapProfile(row));
    if (!profiles.length) return { ok: true, value: [] };

    const [counts, blocked] = await Promise.all([
      loadAuthorCounts(profiles.map((profile) => profile.userId)),
      options.viewerId ? loadBlockedIds(options.viewerId) : Promise.resolve(new Set<string>()),
    ]);

    return {
      ok: true,
      value: profiles
        .filter((profile) => !blocked.has(profile.userId))
        .map((profile) => ({ ...profile, counts: { ...profile.counts, ...(counts.get(profile.userId) ?? {}) } })),
    };
  } catch (error) {
    return fail(error);
  }
}

export async function loadProfile(userId: string): Promise<Result<SocialProfile>> {
  try {
    const row = await tablesDB.getRow({ databaseId: requireDatabaseId(), tableId: PROFILES, rowId: userId });
    const counts = await loadAuthorCounts([userId]);
    return { ok: true, value: mapProfile(row as Row, counts.get(userId)) };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Real counts for a profile: posts written, tips written, places shared and
 * answers given. Computed from the rows that exist rather than stored on the
 * profile, because a stored counter drifts the moment anything is deleted.
 */
export async function loadAuthorCounts(userIds: string[]): Promise<Map<string, SocialProfile["counts"]>> {
  const map = new Map<string, SocialProfile["counts"]>();
  const unique = [...new Set(userIds.filter(Boolean))];
  if (!unique.length) return map;
  for (const id of unique) map.set(id, { posts: 0, tips: 0, placesShared: 0, helpfulAnswers: 0 });

  const countRows = async (tableId: string, apply: (authorId: string, postType: string) => void) => {
    try {
      const page = await tablesDB.listRows({
        databaseId: requireDatabaseId(),
        tableId,
        queries: [Query.equal("author_id", unique), Query.limit(500)],
      });
      for (const row of page.rows as Row[]) apply(str(row.author_id), str(row.post_type));
    } catch {
      // A count that cannot be read stays zero rather than failing the profile.
    }
  };

  await countRows(POSTS, (authorId, postType) => {
    const entry = map.get(authorId);
    if (!entry) return;
    entry.posts += 1;
    if (postType === "tip" || postType === "guide") entry.tips += 1;
    if (postType === "question") entry.helpfulAnswers += 1;
  });
  await countRows(CONTRIBUTIONS, (authorId) => {
    const entry = map.get(authorId);
    if (entry) entry.placesShared += 1;
  });

  return map;
}

export async function loadBlockedIds(userId: string): Promise<Set<string>> {
  const blocked = await listBlockedUsers(userId);
  return new Set(blocked.map((entry) => entry.blockedUserId));
}

/* -------------------------------- follows -------------------------------- */

export async function loadFollowing(userId: string | null): Promise<Set<string>> {
  if (!userId) return new Set();
  try {
    const page = await tablesDB.listRows({
      databaseId: requireDatabaseId(),
      tableId: FOLLOWS,
      queries: [Query.equal("follower_id", userId), Query.limit(500)],
    });
    return new Set((page.rows as Row[]).map((row) => str(row.following_id)));
  } catch {
    return new Set();
  }
}

export async function toggleFollow(followerId: string, followingId: string, following: boolean): Promise<Result<boolean>> {
  // Two user ids concatenated exceed Appwrite's 36-character row id limit; the
  // follow table's unique index on (follower_id, following_id) is the real guard.
  const rowId = pairRowId("fl_", followerId, followingId);
  try {
    if (following) {
      await tablesDB.deleteRow({ databaseId: requireDatabaseId(), tableId: FOLLOWS, rowId });
    } else {
      await tablesDB.createRow({
        databaseId: requireDatabaseId(),
        tableId: FOLLOWS,
        rowId,
        data: {
          follow_id: rowId,
          follower_id: followerId,
          following_id: followingId,
          created_at: new Date().toISOString(),
        },
        permissions: [
          `read("user:${followerId}")`,
          `update("user:${followerId}")`,
          `delete("user:${followerId}")`,
        ],
      });
    }
    return { ok: true, value: !following };
  } catch (error) {
    return fail(error);
  }
}

/* -------------------------------- reports -------------------------------- */

export interface ReportInput {
  reporterId: string;
  targetType: "post" | "comment" | "profile" | "contribution";
  targetId: string;
  reason: string;
  detail?: string;
}

/**
 * File a report.
 *
 * The row is readable only by its author and the server. A report that other
 * students could read would be a way to profile who reports whom, which is worse
 * than the content being reported.
 */
export async function reportContent(input: ReportInput): Promise<Result<true>> {
  try {
    const reportId = ID.unique();
    await tablesDB.createRow({
      databaseId: requireDatabaseId(),
      tableId: REPORTS,
      rowId: reportId,
      data: {
        report_id: reportId,
        reporter_id: input.reporterId,
        target_type: input.targetType,
        target_id: input.targetId,
        reason: input.reason,
        detail: input.detail ?? "",
        status: "open",
        created_at: new Date().toISOString(),
      },
      permissions: [`read("user:${input.reporterId}")`],
    });
    return { ok: true, value: true };
  } catch (error) {
    return fail(error);
  }
}
