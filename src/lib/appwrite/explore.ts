import { ID, Query, type Models } from "appwrite";
import { APPWRITE_DATABASE_ID, requireDatabaseId, tablesDB } from "./client";
import { appError, appErrorMessage, type AppError } from "./errors";
import {
  colorFor,
  downscaleImage,
  initialsFor,
  ownerRowPermissions,
  pairRowId,
  publicRowPermissions,
  uploadCommunityMedia,
} from "./community";
import type { AuthorSummary, Place, PlaceContribution } from "../phase5/contract";
import { campusById, CAMPUSES } from "../../data/campuses";

/**
 * Explore reads and writes.
 *
 * The map needs every place in the active country, and Appwrite returns at most
 * 100 rows per request, so this paginates to a hard cap rather than pretending a
 * single call is enough. The result is cached per country for the session: the
 * map is opened and closed constantly and re-paging 1,000 rows on every tab
 * switch would make Explore feel broken.
 */

const PLACES = "places";
const CONTRIBUTIONS = "place_contributions";
const PLACE_SAVES = "place_saves";

/**
 * Measured, not assumed: Appwrite returns up to 5,000 rows for `places` in one
 * request (`scripts/explore/probe-page-size.mjs`). The largest corridor is 3,056
 * rows, so one request per country is enough and the pagination loop below is a
 * safety net for a corridor that grows, not the normal path.
 */
const PAGE = 2000;
/** Beyond this the map is unreadable anyway, and clustering hides the rest. */
const MAX_PLACES = 8000;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Only the columns the map, the list and the bottom sheet actually read.
 * Without this the response carries every text column for every pin, which for
 * Bangkok's 3,056 places is megabytes of payload the client throws away.
 */
const PLACE_COLUMNS = [
  "place_id",
  "name",
  "category",
  "description",
  "address",
  "latitude",
  "longitude",
  "city",
  "country_code",
  "university_id",
  "campus_id",
  "osm_type",
  "osm_id",
  "source",
  "authority_level",
  "is_demo_seed",
  "student_saves",
  "student_stories",
  "tags",
  "status",
];

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

/** Metres between two points. Used for "near campus", never for user distance. */
export function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function formatDistance(metres: number): string {
  if (!Number.isFinite(metres)) return "";
  if (metres < 950) return `${Math.round(metres / 10) * 10} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

function mapPlace(row: Row): Place {
  const campus = campusById(str(row.campus_id)) ?? CAMPUSES.find((c) => c.universityId === str(row.university_id)) ?? null;
  const lat = Number(str(row.latitude));
  const lng = Number(str(row.longitude));
  return {
    id: str(row.place_id),
    name: str(row.name, "Unnamed place"),
    category: (str(row.category, "studentlife") as Place["category"]) ?? "studentlife",
    description: str(row.description),
    address: str(row.address),
    lat,
    lng,
    city: str(row.city),
    countryCode: str(row.country_code),
    universityId: str(row.university_id),
    campusId: str(row.campus_id) || undefined,
    osmType: str(row.osm_type) || undefined,
    osmId: str(row.osm_id) || undefined,
    source: str(row.source, "osm_overpass"),
    authorityLevel: str(row.authority_level, "D"),
    isDemoSeed: bool(row.is_demo_seed),
    studentSaves: num(row.student_saves),
    studentStories: num(row.student_stories),
    communityTags: parseJson<{ key: string; value: string }[]>(row.tags, []),
    distanceFromCampusM: campus && Number.isFinite(lat) ? haversineMeters(campus.center, { lat, lng }) : Number.NaN,
  };
}

/* --------------------------------- cache --------------------------------- */

interface CacheEntry {
  at: number;
  places: Place[];
}

const placeCache = new Map<string, CacheEntry>();

export function invalidatePlaceCache(countryCode?: string): void {
  if (countryCode) placeCache.delete(countryCode);
  else placeCache.clear();
}

/* --------------------------------- reads --------------------------------- */

export interface LoadPlacesOptions {
  countryCode: string;
  /** Restrict to one campus. Used when the student's university is known. */
  campusId?: string | null;
  force?: boolean;
}

export async function loadPlaces(options: LoadPlacesOptions): Promise<Result<Place[]>> {
  if (!APPWRITE_DATABASE_ID) return { ok: false, error: "unavailable", message: "Explore is not configured." };
  const key = options.countryCode;

  const cached = placeCache.get(key);
  if (!options.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { ok: true, value: cached.places };
  }

  try {
    const places: Place[] = [];
    let cursor: string | null = null;
    while (places.length < MAX_PLACES) {
      const queries = [
        Query.equal("country_code", options.countryCode),
        Query.equal("status", "published"),
        Query.orderAsc("place_id"),
        Query.select(PLACE_COLUMNS),
        Query.limit(PAGE),
      ];
      if (cursor) queries.push(Query.cursorAfter(cursor));
      const page = await tablesDB.listRows({ databaseId: requireDatabaseId(), tableId: PLACES, queries });
      const rows = page.rows as Row[];
      for (const row of rows) places.push(mapPlace(row));
      if (rows.length < PAGE) break;
      cursor = str(rows[rows.length - 1].place_id);
    }
    placeCache.set(key, { at: Date.now(), places });
    return { ok: true, value: places };
  } catch (error) {
    return fail(error);
  }
}

export async function loadPlace(placeId: string): Promise<Result<Place>> {
  try {
    const row = await tablesDB.getRow({ databaseId: requireDatabaseId(), tableId: PLACES, rowId: placeId });
    return { ok: true, value: mapPlace(row as Row) };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Contribution tags arrive in two shapes, and the reader must accept both.
 *
 * The column is `json`, the seed writes plain strings (`"food"`, `"cheap"`), and
 * the contract declares `{ key, value }`. The previous reader cast the parsed
 * value to the contract without looking at it, which crashed the place sheet with
 * `Cannot read properties of undefined (reading 'replace')` the first time a real
 * contribution carried a tag — and because the throw happened during render, it
 * took the whole map down rather than degrading one card.
 *
 * Normalising at the boundary means every consumer sees one shape and neither
 * writer has to change. An entry that is neither a string nor an object with a
 * key is dropped: a tag nobody can render is not worth a crash.
 */
function contributionTags(value: unknown): { key: string; value: string }[] {
  const parsed = typeof value === "string" ? parseJson<unknown[]>(value, []) : Array.isArray(value) ? value : [];
  const tags: { key: string; value: string }[] = [];
  for (const entry of parsed) {
    if (typeof entry === "string" && entry) {
      tags.push({ key: entry, value: entry });
      continue;
    }
    if (entry && typeof entry === "object") {
      const key = str((entry as Row).key);
      if (key) tags.push({ key, value: str((entry as Row).value) || key });
    }
  }
  return tags;
}

/** The community layer for one place: what students actually said. */
export async function loadContributions(placeId: string): Promise<Result<PlaceContribution[]>> {
  try {
    const page = await tablesDB.listRows({
      databaseId: requireDatabaseId(),
      tableId: CONTRIBUTIONS,
      queries: [Query.equal("place_id", placeId), Query.orderDesc("created_at"), Query.limit(50)],
    });
    const rows = page.rows as Row[];
    const authorIds = [...new Set(rows.map((row) => str(row.author_id)))];
    const authors = new Map<string, AuthorSummary>();
    if (authorIds.length) {
      try {
        const profiles = await tablesDB.listRows({
          databaseId: requireDatabaseId(),
          tableId: "student_social_profiles",
          queries: [Query.equal("user_id", authorIds), Query.limit(authorIds.length)],
        });
        for (const profile of profiles.rows as Row[]) {
          const id = str(profile.user_id);
          authors.set(id, {
            id,
            displayName: str(profile.display_name, "Student"),
            initials: initialsFor(str(profile.display_name, "Student")),
            color: colorFor(id),
            homeCountry: str(profile.home_country_code) || undefined,
            hostCountry: str(profile.host_country_code) || undefined,
            universityId: str(profile.university_id) || undefined,
            isDemoSeed: bool(profile.is_demo_seed),
          });
        }
      } catch {
        // Falls back to a synthesised author below.
      }
    }
    return {
      ok: true,
      value: rows.map((row) => {
        const authorId = str(row.author_id);
        return {
          id: str(row.contribution_id),
          placeId: str(row.place_id),
          authorId,
          author: authors.get(authorId) ?? { id: authorId, displayName: "Student", initials: "ST", color: colorFor(authorId), isDemoSeed: false },
          note: str(row.note),
          mediaUrl: str(row.media_url) || undefined,
          tags: contributionTags(row.tags),
          visitContext: str(row.visit_context) || undefined,
          isDemoSeed: bool(row.is_demo_seed),
          createdAt: str(row.created_at),
        };
      }),
    };
  } catch (error) {
    return fail(error);
  }
}

export async function loadSavedPlaceIds(userId: string | null): Promise<Result<Set<string>>> {
  if (!userId) return { ok: true, value: new Set() };
  try {
    const page = await tablesDB.listRows({
      databaseId: requireDatabaseId(),
      tableId: PLACE_SAVES,
      queries: [Query.equal("user_id", userId), Query.limit(500)],
    });
    return { ok: true, value: new Set((page.rows as Row[]).map((row) => str(row.place_id))) };
  } catch (error) {
    return fail(error);
  }
}

/* --------------------------------- writes -------------------------------- */

export interface NewContributionInput {
  placeId: string;
  authorId: string;
  note: string;
  countryCode: string;
  universityId: string;
  tags?: string[];
  visitContext?: string;
  file?: File | null;
}

/**
 * Add a student experience to a place.
 *
 * This writes to `place_contributions` and bumps the place's story counter. It
 * never touches the base place row's objective fields, because a student note is
 * not map data — mixing them is how a community opinion becomes an official fact.
 */
export async function addContribution(input: NewContributionInput): Promise<Result<PlaceContribution>> {
  const note = input.note.trim();
  if (!note) return { ok: false, error: "failed", message: "Add a short note about this place." };
  if (note.length > 1200) return { ok: false, error: "failed", message: "Keep your note under 1200 characters." };

  try {
    const contributionId = ID.unique();
    const createdAt = new Date().toISOString();
    let mediaUrl = "";
    if (input.file) {
      const scaled = await downscaleImage(input.file);
      const upload = await uploadCommunityMedia(scaled, input.authorId);
      if (!upload.ok) return upload;
      mediaUrl = upload.value.url;
    }

    await tablesDB.createRow({
      databaseId: requireDatabaseId(),
      tableId: CONTRIBUTIONS,
      rowId: contributionId,
      data: {
        contribution_id: contributionId,
        place_id: input.placeId,
        author_id: input.authorId,
        note,
        media_file_id: "",
        media_url: mediaUrl,
        tags: JSON.stringify((input.tags ?? []).map((key) => ({ key, value: "yes" }))),
        visit_context: input.visitContext ?? "",
        country_code: input.countryCode,
        university_id: input.universityId,
        is_demo_seed: 0,
        visibility: "public",
        created_at: createdAt,
      },
      permissions: publicRowPermissions(input.authorId),
    });

    // Keep the place's counter honest: read the current value, write +1.
    try {
      const place = await tablesDB.getRow({ databaseId: requireDatabaseId(), tableId: PLACES, rowId: input.placeId });
      const stories = num((place as Row).student_stories) + 1;
      await tablesDB.updateRow({ databaseId: requireDatabaseId(), tableId: PLACES, rowId: input.placeId, data: { student_stories: stories } });
      const cached = placeCache.get(input.countryCode);
      if (cached) {
        const target = cached.places.find((place) => place.id === input.placeId);
        if (target) target.studentStories = stories;
      }
    } catch {
      // The contribution is saved; a stale counter is a cosmetic drift, not a loss.
    }

    return {
      ok: true,
      value: {
        id: contributionId,
        placeId: input.placeId,
        authorId: input.authorId,
        author: { id: input.authorId, displayName: "You", initials: "YO", color: colorFor(input.authorId), isDemoSeed: false },
        note,
        mediaUrl: mediaUrl || undefined,
        tags: (input.tags ?? []).map((key) => ({ key, value: "yes" })),
        visitContext: input.visitContext,
        isDemoSeed: false,
        createdAt,
      },
    };
  } catch (error) {
    return fail(error);
  }
}

export async function togglePlaceSave(placeId: string, userId: string, saved: boolean): Promise<Result<{ saved: boolean; count: number }>> {
  const rowId = pairRowId("ps_", placeId, userId);
  try {
    if (saved) {
      await tablesDB.deleteRow({ databaseId: requireDatabaseId(), tableId: PLACE_SAVES, rowId });
    } else {
      await tablesDB.createRow({
        databaseId: requireDatabaseId(),
        tableId: PLACE_SAVES,
        rowId,
        data: { save_id: rowId, place_id: placeId, user_id: userId, created_at: new Date().toISOString() },
        permissions: ownerRowPermissions(userId),
      });
    }

    let count = 0;
    try {
      const place = await tablesDB.getRow({ databaseId: requireDatabaseId(), tableId: PLACES, rowId: placeId });
      count = Math.max(0, num((place as Row).student_saves) + (saved ? -1 : 1));
      await tablesDB.updateRow({ databaseId: requireDatabaseId(), tableId: PLACES, rowId: placeId, data: { student_saves: count } });
      for (const cached of placeCache.values()) {
        const target = cached.places.find((entry) => entry.id === placeId);
        if (target) target.studentSaves = count;
      }
    } catch {
      // Same reasoning as above: the save itself succeeded.
    }
    return { ok: true, value: { saved: !saved, count } };
  } catch (error) {
    return fail(error);
  }
}

/** Client-side search over persisted names, categories and addresses. */
export function searchPlaces(places: Place[], term: string): Place[] {
  const needle = term.trim().toLowerCase();
  if (!needle) return places;
  return places.filter((place) =>
    [place.name, place.category, place.address, place.city].some((field) => field.toLowerCase().includes(needle)),
  );
}
