import { AppwriteException, ID, Permission, Query, Role, type Models } from "appwrite";
import { APPWRITE_DATABASE_ID, tablesDB } from "./client";

/**
 * Blocked students (Settings → Safety).
 *
 * Rows are private to the person who created them: only the blocker can read,
 * update or delete their own block list. Reporting flows arrive with Connect in
 * Phase 5 and will live in the same private-permission model.
 */

const TABLE_ID = "user_blocks";

export interface BlockedUser {
  rowId: string;
  blockedUserId: string;
  displayName: string;
  createdAt: string;
}

type Row = Models.Row & {
  user_id: string;
  blocked_user_id: string;
  display_name?: string;
  created_at?: string;
};

function ready(): boolean {
  return Boolean(APPWRITE_DATABASE_ID);
}

export async function listBlockedUsers(userId: string): Promise<BlockedUser[]> {
  if (!ready()) return [];
  try {
    const result = await tablesDB.listRows<Row>({
      databaseId: APPWRITE_DATABASE_ID!,
      tableId: TABLE_ID,
      queries: [Query.equal("user_id", userId), Query.limit(200)],
    });
    return result.rows.map((row) => ({
      rowId: row.$id,
      blockedUserId: row.blocked_user_id,
      displayName: row.display_name || "Student",
      createdAt: row.created_at ?? row.$createdAt,
    }));
  } catch (error) {
    if (error instanceof AppwriteException && error.code === 404) return [];
    console.error("[yapyep] listBlockedUsers failed", error);
    return [];
  }
}

export async function blockUser(userId: string, blockedUserId: string, displayName: string): Promise<boolean> {
  if (!ready() || userId === blockedUserId) return false;
  try {
    const existing = await tablesDB.listRows<Row>({
      databaseId: APPWRITE_DATABASE_ID!,
      tableId: TABLE_ID,
      queries: [Query.equal("user_id", userId), Query.equal("blocked_user_id", blockedUserId), Query.limit(1)],
    });
    if (existing.rows[0]) return true;

    await tablesDB.createRow({
      databaseId: APPWRITE_DATABASE_ID!,
      tableId: TABLE_ID,
      rowId: ID.unique(),
      data: { user_id: userId, blocked_user_id: blockedUserId, display_name: displayName, created_at: new Date().toISOString() },
      permissions: [Permission.read(Role.user(userId)), Permission.update(Role.user(userId)), Permission.delete(Role.user(userId))],
    });
    return true;
  } catch (error) {
    console.error("[yapyep] blockUser failed", error);
    return false;
  }
}

export async function unblockUser(rowId: string): Promise<boolean> {
  if (!ready()) return false;
  try {
    await tablesDB.deleteRow({ databaseId: APPWRITE_DATABASE_ID!, tableId: TABLE_ID, rowId });
    return true;
  } catch (error) {
    console.error("[yapyep] unblockUser failed", error);
    return false;
  }
}
