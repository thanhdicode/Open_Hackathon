import { ID, Permission, Query, Role, type Models } from "appwrite";
import { APPWRITE_DATABASE_ID, tablesDB } from "./client";

/** Table id is frozen in docs/06_APPWRITE_SCHEMA.md #10 user_task_progress. */
const TABLE_ID = "user_task_progress";

export type TaskProgressRow = Models.Row & {
  user_id: string;
  task_id: string;
  status: "done" | "pending";
  completed_at: string | null;
  saved: number;
};

function ready(): boolean {
  return Boolean(APPWRITE_DATABASE_ID);
}

export async function fetchTaskProgress(userId: string): Promise<Record<string, boolean>> {
  if (!ready()) return {};
  try {
    const res = await tablesDB.listRows<TaskProgressRow>({
      databaseId: APPWRITE_DATABASE_ID!,
      tableId: TABLE_ID,
      queries: [Query.equal("user_id", userId), Query.limit(200)],
    });
    return Object.fromEntries(res.rows.map((row) => [row.task_id, row.status === "done"]));
  } catch (error) {
    // Table not provisioned yet, or the user has no rows — fail closed to local-only state.
    console.error("[yapyep] fetchTaskProgress failed", error);
    return {};
  }
}

export async function setTaskProgress(userId: string, taskId: string, done: boolean): Promise<boolean> {
  if (!ready()) return false;
  try {
    const existing = await tablesDB.listRows<TaskProgressRow>({
      databaseId: APPWRITE_DATABASE_ID!,
      tableId: TABLE_ID,
      queries: [Query.equal("user_id", userId), Query.equal("task_id", taskId), Query.limit(1)],
    });
    const data = { user_id: userId, task_id: taskId, status: done ? "done" : "pending", completed_at: done ? new Date().toISOString() : null, saved: done ? 1 : 0, updated_at: new Date().toISOString() };
    if (existing.rows[0]) {
      await tablesDB.updateRow({ databaseId: APPWRITE_DATABASE_ID!, tableId: TABLE_ID, rowId: existing.rows[0].$id, data });
    } else {
      await tablesDB.createRow({ databaseId: APPWRITE_DATABASE_ID!, tableId: TABLE_ID, rowId: ID.unique(), data, permissions: [Permission.read(Role.user(userId)), Permission.update(Role.user(userId)), Permission.delete(Role.user(userId))] });
    }
    return true;
  } catch (error) {
    // Best-effort persistence; local optimistic state already reflects the toggle.
    console.error("[yapyep] setTaskProgress failed", error);
    return false;
  }
}
