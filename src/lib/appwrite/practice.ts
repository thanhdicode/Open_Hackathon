import { ID, Permission, Query, Role, type Models } from "appwrite";
import { APPWRITE_DATABASE_ID, tablesDB } from "./client";
import { ensureAnonymousSession } from "./session";
import type { SimFeedback, SimScoreKey } from "../ai-contracts/sim";

/**
 * YapSim persistence.
 *
 * Table ids are frozen in docs/06_APPWRITE_SCHEMA.md: `practice_sessions` and
 * `skill_profiles`. Both are owner-scoped, so every row is written with
 * per-user permissions and never read across users.
 */

const PRACTICE_TABLE = "practice_sessions";
const SKILL_TABLE = "skill_profiles";

export interface PracticeAttemptRow extends Models.Row {
  session_id: string;
  user_id: string;
  scenario_id: string;
  attempt_number: number;
  transcript_summary: string | null;
  score_json: string | null;
  feedback_json: string | null;
  duration_seconds: number | null;
  completed_at: string | null;
}

export interface SkillProfileRow extends Models.Row {
  user_id: string;
  language_clarity: number;
  tone: number;
  intent_recognition: number;
  context_awareness: number;
  adaptability: number;
  confidence: number;
  updated_at: string;
}

export interface PracticeAttempt {
  id: string;
  scenarioId: string;
  attemptNumber: number;
  transcriptSummary: string;
  scores: SimFeedback["scores"] | null;
  feedback: SimFeedback | null;
  durationSeconds: number | null;
  completedAt: string;
}

function ready(): boolean {
  return Boolean(APPWRITE_DATABASE_ID);
}

/** JSON columns are text in Appwrite; a malformed value must not break the UI. */
function parseJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function resolveUserId(): Promise<string | null> {
  const session = await ensureAnonymousSession();
  return session.ok ? session.user.$id : null;
}

export async function fetchPracticeAttempts(scenarioId: string): Promise<PracticeAttempt[]> {
  if (!ready()) return [];
  try {
    const userId = await resolveUserId();
    if (!userId) return [];
    const res = await tablesDB.listRows<PracticeAttemptRow>({
      databaseId: APPWRITE_DATABASE_ID!,
      tableId: PRACTICE_TABLE,
      queries: [Query.equal("user_id", userId), Query.equal("scenario_id", scenarioId), Query.orderAsc("attempt_number"), Query.limit(50)],
    });
    return res.rows.map((row) => ({
      id: row.$id,
      scenarioId: row.scenario_id,
      attemptNumber: row.attempt_number,
      transcriptSummary: row.transcript_summary ?? "",
      scores: parseJson<SimFeedback["scores"]>(row.score_json),
      feedback: parseJson<SimFeedback>(row.feedback_json),
      durationSeconds: row.duration_seconds,
      completedAt: row.completed_at ?? row.$createdAt,
    }));
  } catch (error) {
    // Not provisioned, or no attempts yet — the session still works in memory.
    console.error("[yapyep] fetchPracticeAttempts failed", error);
    return [];
  }
}

export interface SaveAttemptInput {
  scenarioId: string;
  attemptNumber: number;
  transcriptSummary: string;
  feedback: SimFeedback;
  durationSeconds: number;
}

export async function savePracticeAttempt(input: SaveAttemptInput): Promise<PracticeAttempt | null> {
  if (!ready()) return null;
  try {
    const userId = await resolveUserId();
    if (!userId) return null;
    const rowId = ID.unique();
    const data = {
      session_id: rowId,
      user_id: userId,
      scenario_id: input.scenarioId,
      attempt_number: input.attemptNumber,
      transcript_summary: input.transcriptSummary.slice(0, 4000),
      score_json: JSON.stringify(input.feedback.scores),
      feedback_json: JSON.stringify(input.feedback),
      duration_seconds: input.durationSeconds,
      completed_at: new Date().toISOString(),
    };
    const row = await tablesDB.createRow<PracticeAttemptRow>({
      databaseId: APPWRITE_DATABASE_ID!,
      tableId: PRACTICE_TABLE,
      rowId,
      data,
      permissions: [Permission.read(Role.user(userId)), Permission.update(Role.user(userId)), Permission.delete(Role.user(userId))],
    });
    return {
      id: row.$id,
      scenarioId: row.scenario_id,
      attemptNumber: row.attempt_number,
      transcriptSummary: row.transcript_summary ?? "",
      scores: input.feedback.scores,
      feedback: input.feedback,
      durationSeconds: row.duration_seconds,
      completedAt: row.completed_at ?? new Date().toISOString(),
    };
  } catch (error) {
    console.error("[yapyep] savePracticeAttempt failed", error);
    return null;
  }
}

const SKILL_COLUMN: Record<SimScoreKey, string> = {
  languageClarity: "language_clarity",
  tone: "tone",
  intentRecognition: "intent_recognition",
  contextAwareness: "context_awareness",
  adaptability: "adaptability",
  confidence: "confidence",
};

/**
 * The skill profile holds the most recent measured level per dimension.
 * One rule, no hidden smoothing — the full attempt history lives in
 * practice_sessions, so a future trend view can derive whatever it needs.
 */
export async function updateSkillProfile(scores: SimFeedback["scores"]): Promise<boolean> {
  if (!ready()) return false;
  try {
    const userId = await resolveUserId();
    if (!userId) return false;
    const data: Record<string, unknown> = { user_id: userId, updated_at: new Date().toISOString() };
    for (const [key, column] of Object.entries(SKILL_COLUMN)) data[column] = scores[key as SimScoreKey];

    const existing = await tablesDB.listRows<SkillProfileRow>({
      databaseId: APPWRITE_DATABASE_ID!,
      tableId: SKILL_TABLE,
      queries: [Query.equal("user_id", userId), Query.limit(1)],
    });
    if (existing.rows[0]) {
      await tablesDB.updateRow({ databaseId: APPWRITE_DATABASE_ID!, tableId: SKILL_TABLE, rowId: existing.rows[0].$id, data });
    } else {
      await tablesDB.createRow({
        databaseId: APPWRITE_DATABASE_ID!,
        tableId: SKILL_TABLE,
        rowId: ID.unique(),
        data,
        permissions: [Permission.read(Role.user(userId)), Permission.update(Role.user(userId)), Permission.delete(Role.user(userId))],
      });
    }
    return true;
  } catch (error) {
    console.error("[yapyep] updateSkillProfile failed", error);
    return false;
  }
}

export async function fetchSkillProfile(): Promise<SimFeedback["scores"] | null> {
  if (!ready()) return null;
  try {
    const userId = await resolveUserId();
    if (!userId) return null;
    const res = await tablesDB.listRows<SkillProfileRow>({
      databaseId: APPWRITE_DATABASE_ID!,
      tableId: SKILL_TABLE,
      queries: [Query.equal("user_id", userId), Query.limit(1)],
    });
    const row = res.rows[0];
    if (!row) return null;
    return {
      languageClarity: row.language_clarity,
      tone: row.tone,
      intentRecognition: row.intent_recognition,
      contextAwareness: row.context_awareness,
      adaptability: row.adaptability,
      confidence: row.confidence,
    };
  } catch (error) {
    console.error("[yapyep] fetchSkillProfile failed", error);
    return null;
  }
}
