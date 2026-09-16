import { AppwriteException, Permission, Query, Role, type Models } from "appwrite";
import { APPWRITE_DATABASE_ID, tablesDB } from "./client";
import { deleteAvatar } from "./avatar";

/**
 * Profile persistence (Phase 2).
 *
 * Two strictly separated layers:
 *  - `student_profiles`   — private journey/student data. Owner-only rows.
 *    Never read by Connect or any other student.
 *  - `student_social_profiles` — the opt-in public card that Connect may read,
 *    and only while `discoverable` is on.
 */

export const PRIVATE_TABLE = "student_profiles";
export const SOCIAL_TABLE = "student_social_profiles";
const DNA_TABLE = "my_dna_profiles";
const JOURNEY_TABLE = "journeys";
const TASK_TABLE = "user_task_progress";
const PASSPORT_TABLE = "passport_progress";
const SKILL_TABLE = "skill_profiles";
const LENS_TABLE = "lens_sessions";
const PRACTICE_TABLE = "practice_sessions";
const BLOCKS_TABLE = "user_blocks";

export type StudentRole = "local" | "current_exchange" | "incoming" | "returned";

export const STUDENT_ROLES: { value: StudentRole; label: string; hint: string }[] = [
  { value: "local", label: "Local student", hint: "I live here and can help others settle in" },
  { value: "current_exchange", label: "Current exchange", hint: "I am on exchange here right now" },
  { value: "incoming", label: "Incoming", hint: "I am preparing to arrive" },
  { value: "returned", label: "Returned", hint: "I finished my exchange and came home" },
];

export interface PrivateProfile {
  displayName: string;
  home: string;
  host: string;
  city: string;
  university: string;
  languages: string[];
  interests: string[];
  goals: string[];
  concerns: string[];
  exchangeStage: string;
}

export interface SocialProfile {
  displayName: string;
  avatarFileId: string | null;
  role: StudentRole;
  currentCountry: string;
  city: string;
  university: string;
  major: string;
  bio: string;
  languages: string[];
  interests: string[];
  discoverable: boolean;
  localHelper: boolean;
}

type Row = Models.Row & Record<string, unknown>;

function ready(): boolean {
  return Boolean(APPWRITE_DATABASE_ID);
}

function ownerPermissions(userId: string) {
  return [Permission.read(Role.user(userId)), Permission.update(Role.user(userId)), Permission.delete(Role.user(userId))];
}

/**
 * The social card's permissions ARE the discoverability setting.
 *
 * `student_social_profiles` is row-secured with no table-level read grant, so a
 * row is visible to another student only if the row itself carries
 * `read("users")`. Writing the card with owner-only permissions — which this did
 * until Phase 5 — meant `discoverable: 1` changed nothing: the row existed, its
 * owner saw it, and every other student saw an empty People list with no error
 * anywhere to explain it. Opting in has to grant the read, and opting out has to
 * take it away, which is why permissions are passed on update as well as create.
 */
function socialPermissions(userId: string, discoverable: boolean) {
  const permissions = ownerPermissions(userId);
  if (discoverable) permissions.push(Permission.read(Role.users()));
  return permissions;
}

function jsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function readRow(tableId: string, rowId: string): Promise<Row | null> {
  if (!ready()) return null;
  try {
    return await tablesDB.getRow<Row>({ databaseId: APPWRITE_DATABASE_ID!, tableId, rowId });
  } catch (error) {
    if (error instanceof AppwriteException && error.code === 404) return null;
    throw error;
  }
}

async function writeRow(tableId: string, rowId: string, data: Record<string, unknown>, userId: string, permissions?: string[]): Promise<void> {
  const existing = await readRow(tableId, rowId);
  if (existing) {
    // Permissions are sent on update too, so revoking discoverability actually
    // revokes the read grant instead of leaving the old one in place.
    await tablesDB.updateRow({ databaseId: APPWRITE_DATABASE_ID!, tableId, rowId, data, ...(permissions ? { permissions } : {}) });
    return;
  }
  try {
    await tablesDB.createRow({ databaseId: APPWRITE_DATABASE_ID!, tableId, rowId, data, permissions: permissions ?? ownerPermissions(userId) });
  } catch (error) {
    // A concurrent writer created the row first — update it instead.
    if (error instanceof AppwriteException && error.code === 409) {
      await tablesDB.updateRow({ databaseId: APPWRITE_DATABASE_ID!, tableId, rowId, data, ...(permissions ? { permissions } : {}) });
      return;
    }
    throw error;
  }
}

/* ------------------------------ private profile ----------------------------- */

export async function loadPrivateProfile(userId: string): Promise<PrivateProfile | null> {
  const row = await readRow(PRIVATE_TABLE, userId);
  if (!row) return null;
  return {
    displayName: String(row.display_name ?? ""),
    home: String(row.home_country_code ?? ""),
    host: String(row.host_country_code ?? ""),
    city: String(row.host_city ?? ""),
    university: String(row.university_id ?? ""),
    languages: jsonArray(row.languages),
    interests: jsonArray(row.interests),
    goals: jsonArray(row.goals),
    concerns: jsonArray(row.concerns),
    exchangeStage: String(row.exchange_stage ?? ""),
  };
}

export async function savePrivateProfile(userId: string, profile: PrivateProfile): Promise<boolean> {
  if (!ready()) return false;
  const now = new Date().toISOString();
  try {
    await writeRow(
      PRIVATE_TABLE,
      userId,
      {
        user_id: userId,
        display_name: profile.displayName,
        home_country_code: profile.home,
        host_country_code: profile.host,
        host_city: profile.city,
        university_id: profile.university,
        languages: JSON.stringify(profile.languages),
        interests: JSON.stringify(profile.interests),
        goals: JSON.stringify(profile.goals),
        concerns: JSON.stringify(profile.concerns),
        exchange_stage: profile.exchangeStage || "studying",
        updated_at: now,
      },
      userId,
    );
    return true;
  } catch (error) {
    console.error("[yapyep] savePrivateProfile failed", error);
    return false;
  }
}

/* ------------------------------- social profile ----------------------------- */

export async function loadSocialProfile(userId: string): Promise<SocialProfile | null> {
  const row = await readRow(SOCIAL_TABLE, userId);
  if (!row) return null;
  return {
    displayName: String(row.display_name ?? ""),
    avatarFileId: (row.avatar_file_id as string) || null,
    role: (String(row.role ?? "incoming") as StudentRole) ?? "incoming",
    currentCountry: String(row.current_country ?? ""),
    city: String(row.city ?? ""),
    university: String(row.university_id ?? ""),
    major: String(row.major ?? ""),
    bio: String(row.bio ?? ""),
    languages: jsonArray(row.languages),
    interests: jsonArray(row.interests),
    discoverable: Number(row.discoverable ?? 0) === 1,
    localHelper: Number(row.local_helper ?? 0) === 1,
  };
}

export async function saveSocialProfile(userId: string, profile: SocialProfile): Promise<boolean> {
  if (!ready()) return false;
  try {
    await writeRow(
      SOCIAL_TABLE,
      userId,
      {
        user_id: userId,
        display_name: profile.displayName,
        avatar_file_id: profile.avatarFileId ?? "",
        role: profile.role,
        current_country: profile.currentCountry,
        city: profile.city,
        university_id: profile.university,
        major: profile.major,
        bio: profile.bio,
        languages: JSON.stringify(profile.languages),
        interests: JSON.stringify(profile.interests),
        exchange_history: JSON.stringify([]),
        local_helper: profile.localHelper ? 1 : 0,
        discoverable: profile.discoverable ? 1 : 0,
        updated_at: new Date().toISOString(),
      },
      userId,
      socialPermissions(userId, profile.discoverable),
    );
    return true;
  } catch (error) {
    console.error("[yapyep] saveSocialProfile failed", error);
    return false;
  }
}

/** Discoverable cards only — used by Connect in Phase 5. */
export async function listDiscoverableProfiles(limit = 24): Promise<SocialProfile[]> {
  if (!ready()) return [];
  try {
    const result = await tablesDB.listRows<Row>({
      databaseId: APPWRITE_DATABASE_ID!,
      tableId: SOCIAL_TABLE,
      queries: [Query.equal("discoverable", 1), Query.limit(limit)],
    });
    return result.rows.map((row) => ({
      displayName: String(row.display_name ?? ""),
      avatarFileId: (row.avatar_file_id as string) || null,
      role: (String(row.role ?? "incoming") as StudentRole) ?? "incoming",
      currentCountry: String(row.current_country ?? ""),
      city: String(row.city ?? ""),
      university: String(row.university_id ?? ""),
      major: String(row.major ?? ""),
      bio: String(row.bio ?? ""),
      languages: jsonArray(row.languages),
      interests: jsonArray(row.interests),
      discoverable: true,
      localHelper: Number(row.local_helper ?? 0) === 1,
    }));
  } catch (error) {
    console.error("[yapyep] listDiscoverableProfiles failed", error);
    return [];
  }
}

/* --------------------------- privacy: export & delete ----------------------- */

const OWNED_TABLES = [
  PRIVATE_TABLE,
  DNA_TABLE,
  JOURNEY_TABLE,
  TASK_TABLE,
  PASSPORT_TABLE,
  SKILL_TABLE,
  LENS_TABLE,
  PRACTICE_TABLE,
  SOCIAL_TABLE,
  BLOCKS_TABLE,
];

async function ownedRows(userId: string, tableId: string): Promise<Row[]> {
  if (!ready()) return [];
  try {
    const result = await tablesDB.listRows<Row>({
      databaseId: APPWRITE_DATABASE_ID!,
      tableId,
      queries: [Query.equal("user_id", userId), Query.limit(500)],
    });
    return result.rows;
  } catch (error) {
    if (error instanceof AppwriteException && error.code === 404) return [];
    console.error(`[yapyep] ownedRows(${tableId}) failed`, error);
    return [];
  }
}

export interface DataExport {
  exportedAt: string;
  userId: string;
  tables: Record<string, unknown[]>;
}

/** "Download my data" — everything YapYep stores about the signed-in student. */
export async function exportMyData(userId: string): Promise<DataExport> {
  const tables: Record<string, unknown[]> = {};
  for (const tableId of OWNED_TABLES) {
    tables[tableId] = await ownedRows(userId, tableId);
  }
  return { exportedAt: new Date().toISOString(), userId, tables };
}

/** Deletes every row YapYep owns for this user, plus their avatar file. */
export async function deleteMyData(userId: string): Promise<{ deleted: number; avatarDeleted: boolean }> {
  let deleted = 0;
  const social = await loadSocialProfile(userId);
  if (social?.avatarFileId) await deleteAvatar(social.avatarFileId);

  for (const tableId of OWNED_TABLES) {
    const rows = await ownedRows(userId, tableId);
    for (const row of rows) {
      try {
        await tablesDB.deleteRow({ databaseId: APPWRITE_DATABASE_ID!, tableId, rowId: row.$id });
        deleted += 1;
      } catch (error) {
        console.error(`[yapyep] deleteRow(${tableId}/${row.$id}) failed`, error);
      }
    }
  }
  return { deleted, avatarDeleted: Boolean(social?.avatarFileId) };
}

/** "Delete AI history" — clears Lens interpretation history only. */
export async function clearLensHistory(userId: string): Promise<number> {
  const rows = await ownedRows(userId, LENS_TABLE);
  let deleted = 0;
  for (const row of rows) {
    try {
      await tablesDB.deleteRow({ databaseId: APPWRITE_DATABASE_ID!, tableId: LENS_TABLE, rowId: row.$id });
      deleted += 1;
    } catch (error) {
      console.error("[yapyep] clearLensHistory failed", error);
    }
  }
  return deleted;
}
