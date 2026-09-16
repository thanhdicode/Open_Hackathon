/**
 * Greenbook read layer.
 *
 * Everything the UI needs, read from Appwrite and shaped into the frozen
 * contract types. Three deliberate design decisions, each forced by a measured
 * property of the live database rather than by preference:
 *
 * 1. CHAPTERS AND ENTRIES ARE DERIVED, NOT FETCHED.
 *    `greenbook_chapters` and `greenbook_entries` exist in the schema but are
 *    empty. The facts are the source of truth. So a chapter is "the set of facts
 *    for this country in this chapter", and an entry is the readable view of
 *    that set. If those tables are ever populated, `listEntries` prefers the
 *    stored rows and falls back to derivation — the UI does not change.
 *
 * 2. EVERY READ FAILS CLOSED TO AN EMPTY RESULT, NEVER AN EXCEPTION.
 *    A student on a flaky connection must see a source-aware empty state, not a
 *    white screen. The brief is explicit that there is no acceptable crash path.
 *
 * 3. PUBLIC DATA IS CACHED, PRIVATE DATA IS NOT.
 *    Country summaries, chapter tables of contents, phrases and media metadata
 *    are the same for every student, so they get a short TTL cache. Progress is
 *    per-user and is never cached — serving one student another's completion
 *    state would be a privacy failure, not a performance win.
 */
import { ID, Permission, Query, Role, type Models } from "appwrite";
import { APPWRITE_DATABASE_ID, isAppwriteConfigured, tablesDB } from "../appwrite/client";
import { trustStateOf } from "./no-llm";
import type {
  AuthorityLevel,
  ConfidenceLabel,
  GreenbookChapter,
  GreenbookEntry,
  GreenbookFact,
  GreenbookSource,
  GreenbookTask,
  MediaResource,
  StudentPhrase,
  TrustState,
  VerificationStatus,
} from "./contract";

/**
 * Re-exported so the trust judgement lives in exactly one place.
 *
 * The implementation moved to ./no-llm (a module with no Appwrite dependency, so
 * the reliability fallback can be tested in Node). Every existing import path
 * keeps working, and the UI and the fallback cannot drift apart.
 */
export { trustStateOf };

const FACTS = "knowledge_facts";
const SOURCES = "knowledge_sources";
const PHRASES = "student_phrases";
const MEDIA = "media_resources";
const TASKS = "greenbook_tasks";
const ENTRIES = "greenbook_entries";
const CHAPTERS = "greenbook_chapters";
const PROGRESS = "greenbook_progress";

/**
 * The manual's table of contents.
 *
 * This is product copy — the name and purpose of each chapter — not a factual
 * claim about any country, so it is safe to define here. The chapter IDS must
 * match `CHAPTERS` in scripts/greenbook/extract.mjs, because that enum is what
 * the extraction contract restricts the model to.
 */
export const CHAPTER_META: Record<string, { title: string; purpose: string; orderIndex: number; icon: string }> = {
  get_ready: { title: "Before you go", purpose: "Documents, money and decisions to settle before you fly.", orderIndex: 1, icon: "passport" },
  land_and_settle: { title: "Landing and settling in", purpose: "What happens at the border and in your first days.", orderIndex: 2, icon: "globe" },
  study_here: { title: "Studying here", purpose: "How your university works, enrols and examines you.", orderIndex: 3, icon: "text" },
  speak_and_understand: { title: "Speaking and understanding", purpose: "The phrases and habits that get you through a day.", orderIndex: 4, icon: "chat" },
  money_and_pay: { title: "Money and paying", purpose: "Bank accounts, cards, transfers and what things cost.", orderIndex: 5, icon: "star" },
  live_here: { title: "Living here", purpose: "SIM cards, housing, utilities and everyday admin.", orderIndex: 6, icon: "settings" },
  move_around: { title: "Getting around", purpose: "Transport, tickets, apps and staying on time.", orderIndex: 7, icon: "pin" },
  stay_safe_and_healthy: { title: "Staying safe and healthy", purpose: "Clinics, insurance, emergencies and who to call.", orderIndex: 8, icon: "alert" },
  culture_and_people: { title: "Culture and people", purpose: "Local norms, courtesy and reading the room.", orderIndex: 9, icon: "connect" },
  student_reality: { title: "Student reality", purpose: "What students actually say about living here.", orderIndex: 10, icon: "camera" },
};

export const CHAPTER_ORDER = Object.entries(CHAPTER_META)
  .sort((a, b) => a[1].orderIndex - b[1].orderIndex)
  .map(([id]) => id);

function chapterTitle(id: string): string {
  if (CHAPTER_META[id]) return CHAPTER_META[id].title;
  // An unknown chapter id is a real gap, not something to hide — render it
  // readably rather than dropping the facts that live in it.
  return id.replace(/_/g, " ").replace(/^./, (char) => char.toUpperCase());
}

// ---------------------------------------------------------------------------
// Public-data cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Exposed for tests and for the "refresh" affordance. */
export function clearGreenbookCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

type Row = Models.Row & Record<string, unknown>;

function rowToFact(row: Row): GreenbookFact {
  return {
    factId: String(row.fact_id ?? row.$id),
    sourceId: String(row.source_id ?? ""),
    countryCode: String(row.country_code ?? ""),
    city: str(row.city),
    universityId: str(row.university_id),
    chapter: String(row.chapter ?? ""),
    journeyStage: String(row.journey_stage ?? ""),
    claim: String(row.claim ?? ""),
    action: str(row.actionable_advice),
    evidenceQuote: str(row.evidence_quote),
    authorityLevel: (str(row.authority_level) ?? "C") as AuthorityLevel,
    verificationStatus: (str(row.verification_status) ?? "unverified") as VerificationStatus,
    confidenceLabel: (str(row.confidence_label) ?? "low") as ConfidenceLabel,
    checkedAt: String(row.checked_at ?? ""),
    validUntil: str(row.valid_until),
  };
}

function rowToSource(row: Row): GreenbookSource {
  return {
    sourceId: String(row.source_id ?? row.$id),
    countryCode: String(row.country_code ?? ""),
    title: String(row.title ?? ""),
    url: String(row.url ?? ""),
    authorityLevel: String(row.authority_level ?? ""),
    sourceType: String(row.source_type ?? ""),
    language: str(row.language),
    checkedAt: String(row.checked_at ?? ""),
    contentHash: String(row.content_hash ?? ""),
    status: String(row.status ?? ""),
  };
}

function rowToPhrase(row: Row): StudentPhrase {
  return {
    phraseId: String(row.phrase_id ?? row.$id),
    countryCode: String(row.country_code ?? ""),
    languageCode: String(row.language_code ?? ""),
    localText: String(row.local_text ?? ""),
    romanization: str(row.romanization),
    translation: str(row.translation),
    contextKey: String(row.context_key ?? ""),
    chapter: str(row.chapter),
    register: str(row.register),
    whenToUse: str(row.when_to_use),
    whenNotToUse: str(row.when_not_to_use),
  };
}

function rowToMedia(row: Row): MediaResource {
  return {
    mediaId: String(row.media_id ?? row.$id),
    platform: String(row.platform ?? ""),
    url: String(row.url ?? ""),
    externalId: str(row.external_id),
    title: String(row.title ?? ""),
    creator: str(row.creator),
    thumbnailUrl: str(row.thumbnail_url),
    countryCode: String(row.country_code ?? ""),
    chapter: str(row.chapter),
    trustTier: String(row.trust_tier ?? "unverified"),
    embedAllowed: Number(row.embed_allowed ?? 0) === 1,
    language: str(row.language),
  };
}

function rowToTask(row: Row): GreenbookTask {
  let factIds: string[] = [];
  try {
    const parsed = JSON.parse(String(row.fact_ids ?? "[]"));
    if (Array.isArray(parsed)) factIds = parsed.map(String);
  } catch {
    factIds = [];
  }
  return {
    taskId: String(row.task_id ?? row.$id),
    countryCode: String(row.country_code ?? ""),
    chapterId: String(row.chapter_id ?? ""),
    journeyStage: String(row.journey_stage ?? ""),
    title: String(row.title ?? ""),
    detail: str(row.detail),
    orderIndex: Number(row.order_index ?? 0),
    factIds,
  };
}

// ---------------------------------------------------------------------------
// Trust
// ---------------------------------------------------------------------------

/**
 * Map a stored fact to what the student is shown.
 *
 * Authority and freshness are separate axes and both matter: an official fact
 * whose validity window has closed is STALE, not OFFICIAL, because presenting it
 * as current is exactly the failure the trust model exists to prevent.
 */
export function trustLabel(state: TrustState): string {
  switch (state) {
    case "official":
      return "Official";
    case "university":
      return "University";
    case "community":
      return "Community";
    case "stale":
      return "Stale";
    case "needs_review":
      return "Needs review";
    case "source_unavailable":
      return "Source unavailable";
    default:
      return "Fresh";
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function ready(): boolean {
  return Boolean(isAppwriteConfigured && APPWRITE_DATABASE_ID);
}

async function listAll<T>(tableId: string, queries: string[], map: (row: Row) => T, cap = 300): Promise<T[]> {
  if (!ready()) return [];
  const rows: Row[] = [];
  try {
    for (let offset = 0; offset < cap; offset += 100) {
      const page = await tablesDB.listRows<Row>({
        databaseId: APPWRITE_DATABASE_ID!,
        tableId,
        queries: [...queries, Query.limit(100), Query.offset(offset)],
      });
      rows.push(...page.rows);
      if (rows.length >= page.total || page.rows.length === 0) break;
    }
  } catch (error) {
    // 404 = table not provisioned, 401 = not permitted. Both mean "no data yet"
    // to the UI, which renders a source-aware empty state rather than crashing.
    console.warn(`[greenbook] read failed for ${tableId}`, error);
    return [];
  }
  return rows.map(map);
}

/**
 * Facts for a query, ordered by how much a newly arriving student needs them.
 *
 * Journey-stage proximity first, then authority, then recency. This is the
 * "rerank" step of the retrieval order in the brief, and it is deliberately
 * deterministic — a ranking that changes between identical requests makes the
 * citation list unstable, which is worse than a slightly worse ordering.
 */
const STAGE_ORDER = ["before_arrival", "arrival", "first_week", "settling", "ongoing"];

function rankFacts(facts: GreenbookFact[], stage?: string | null): GreenbookFact[] {
  const target = stage ? STAGE_ORDER.indexOf(stage) : -1;
  const authority = (fact: GreenbookFact) => (fact.authorityLevel === "A" ? 0 : fact.authorityLevel === "B" ? 1 : fact.authorityLevel === "C" ? 2 : 3);
  return [...facts].sort((a, b) => {
    if (target >= 0) {
      const da = Math.abs(STAGE_ORDER.indexOf(a.journeyStage) - target);
      const db = Math.abs(STAGE_ORDER.indexOf(b.journeyStage) - target);
      if (da !== db) return da - db;
    }
    const aa = authority(a);
    const ab = authority(b);
    if (aa !== ab) return aa - ab;
    return String(b.checkedAt).localeCompare(String(a.checkedAt));
  });
}

export async function listFacts(query: {
  countryCode: string;
  chapter?: string | null;
  journeyStage?: string | null;
  universityId?: string | null;
  city?: string | null;
  limit?: number;
}): Promise<GreenbookFact[]> {
  const { countryCode, chapter, journeyStage, limit = 200 } = query;
  if (!countryCode) return [];
  const key = `facts:${countryCode}:${chapter ?? ""}:${journeyStage ?? ""}`;
  const facts = await cached(key, async () => {
    const queries = [Query.equal("country_code", countryCode)];
    if (chapter) queries.push(Query.equal("chapter", chapter));
    if (journeyStage) queries.push(Query.equal("journey_stage", journeyStage));
    return listAll(FACTS, queries, rowToFact);
  });

  // University and city are filtered in memory rather than by index: they are
  // mostly null on the corpus today, and an extra compound index that matches
  // nothing is worse than a small client-side filter.
  const filtered = facts.filter((fact) => {
    if (query.universityId && fact.universityId && fact.universityId !== query.universityId) return false;
    if (query.city && fact.city && fact.city !== query.city) return false;
    return true;
  });

  return rankFacts(filtered, journeyStage).slice(0, limit);
}

export async function listSources(countryCode: string): Promise<GreenbookSource[]> {
  if (!countryCode) return [];
  return cached(`sources:${countryCode}`, () => listAll(SOURCES, [Query.equal("country_code", countryCode)], rowToSource));
}

export async function sourcesByIds(ids: string[]): Promise<GreenbookSource[]> {
  if (!ids.length || !ready()) return [];
  const unique = [...new Set(ids)].slice(0, 100);
  try {
    const page = await tablesDB.listRows<Row>({
      databaseId: APPWRITE_DATABASE_ID!,
      tableId: SOURCES,
      queries: [Query.equal("source_id", unique), Query.limit(100)],
    });
    return page.rows.map(rowToSource);
  } catch (error) {
    console.warn("[greenbook] source lookup failed", error);
    return [];
  }
}

/**
 * The chapter table of contents for a country.
 *
 * Chapters with zero facts are INCLUDED, because an empty chapter is a real
 * answer — "nothing verified for this yet" — and hiding it would make the manual
 * look more complete than it is.
 */
export async function listChapters(countryCode: string): Promise<GreenbookChapter[]> {
  const facts = await listFacts({ countryCode, limit: 500 });
  const counts = new Map<string, number>();
  for (const fact of facts) {
    if (!fact.chapter) continue;
    counts.set(fact.chapter, (counts.get(fact.chapter) ?? 0) + 1);
  }

  const ids = new Set<string>([...CHAPTER_ORDER, ...counts.keys()]);
  return [...ids]
    .map((chapterId) => ({
      chapterId,
      countryCode,
      title: chapterTitle(chapterId),
      purpose: CHAPTER_META[chapterId]?.purpose ?? "",
      orderIndex: CHAPTER_META[chapterId]?.orderIndex ?? 99,
      factCount: counts.get(chapterId) ?? 0,
    }))
    .sort((a, b) => a.orderIndex - b.orderIndex || a.chapterId.localeCompare(b.chapterId));
}

function buildEntry(countryCode: string, chapterId: string, facts: GreenbookFact[], sources: GreenbookSource[]): GreenbookEntry {
  const byId = new Map(sources.map((source) => [source.sourceId, source]));
  const usedSources = [...new Set(facts.map((fact) => fact.sourceId))]
    .map((id) => byId.get(id))
    .filter((source): source is GreenbookSource => Boolean(source));

  const lastVerified = facts
    .map((fact) => fact.checkedAt)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;

  const anyStale = facts.some((fact) => trustStateOf(fact) === "stale");

  return {
    entryId: `entry_${countryCode}_${chapterId}`,
    countryCode,
    chapterId,
    city: null,
    universityId: null,
    title: chapterTitle(chapterId),
    whatToKnow: facts.map((fact) => fact.claim).join(" "),
    whatToDo: facts.map((fact) => fact.action).filter((action): action is string => Boolean(action)),
    phraseIds: [],
    mediaIds: [],
    factIds: facts.map((fact) => fact.factId),
    sources: usedSources,
    freshnessLabel: anyStale ? "Some guidance may be out of date" : "Checked from official sources",
    lastVerifiedAt: lastVerified,
    status: facts.length ? "published" : "empty",
  };
}

/**
 * Entries for a chapter.
 *
 * Prefers stored `greenbook_entries` rows when they exist, and otherwise derives
 * one entry from the chapter's facts. The fallback is not a placeholder — it is
 * the same content the stored row would hold, computed from the facts that
 * actually exist.
 */
export async function listEntries(countryCode: string, chapterId: string): Promise<GreenbookEntry[]> {
  const stored = await cached(`entries:${countryCode}:${chapterId}`, () =>
    listAll<GreenbookEntry>(ENTRIES, [Query.equal("country_code", countryCode), Query.equal("chapter_id", chapterId)], (row) => ({
      entryId: String(row.entry_id ?? row.$id),
      countryCode: String(row.country_code ?? ""),
      chapterId: String(row.chapter_id ?? ""),
      city: str(row.city),
      universityId: str(row.university_id),
      title: String(row.title ?? ""),
      whatToKnow: String(row.what_to_know ?? ""),
      whatToDo: parseStringArray(row.what_to_do),
      phraseIds: parseStringArray(row.phrase_ids),
      mediaIds: parseStringArray(row.media_ids),
      factIds: parseStringArray(row.fact_ids),
      sources: [],
      freshnessLabel: String(row.freshness_label ?? ""),
      lastVerifiedAt: str(row.last_verified_at),
      status: String(row.status ?? "published"),
    })),
  );
  if (stored.length) return stored;

  const [facts, sources] = await Promise.all([listFacts({ countryCode, chapter: chapterId, limit: 200 }), listSources(countryCode)]);
  return [buildEntry(countryCode, chapterId, facts, sources)];
}

export async function getEntry(entryId: string): Promise<GreenbookEntry | null> {
  // entry_<CC>_<chapter>
  const match = /^entry_([A-Z]{2})_(.+)$/.exec(entryId);
  if (!match) return null;
  const [, countryCode, chapterId] = match;
  const entries = await listEntries(countryCode, chapterId);
  return entries[0] ?? null;
}

export async function listPhrases(countryCode: string, chapter?: string): Promise<StudentPhrase[]> {
  if (!countryCode) return [];
  return cached(`phrases:${countryCode}:${chapter ?? ""}`, () =>
    listAll(PHRASES, chapter ? [Query.equal("country_code", countryCode), Query.equal("chapter", chapter)] : [Query.equal("country_code", countryCode)], rowToPhrase),
  );
}

export async function listMedia(countryCode: string, chapter?: string): Promise<MediaResource[]> {
  if (!countryCode) return [];
  return cached(`media:${countryCode}:${chapter ?? ""}`, () =>
    listAll(MEDIA, chapter ? [Query.equal("country_code", countryCode), Query.equal("chapter", chapter)] : [Query.equal("country_code", countryCode)], rowToMedia),
  );
}

export async function listTasks(countryCode: string, journeyStage?: string): Promise<GreenbookTask[]> {
  if (!countryCode) return [];
  const tasks = await cached(`tasks:${countryCode}:${journeyStage ?? ""}`, () =>
    listAll(TASKS, journeyStage ? [Query.equal("country_code", countryCode), Query.equal("journey_stage", journeyStage)] : [Query.equal("country_code", countryCode)], rowToTask),
  );
  return [...tasks].sort((a, b) => a.orderIndex - b.orderIndex);
}

// ---------------------------------------------------------------------------
// Progress — owner-scoped, never cached
// ---------------------------------------------------------------------------

export async function getProgress(userId: string, countryCode: string): Promise<Record<string, boolean>> {
  if (!ready() || !userId) return {};
  try {
    const page = await tablesDB.listRows<Row>({
      databaseId: APPWRITE_DATABASE_ID!,
      tableId: PROGRESS,
      queries: [Query.equal("user_id", userId), Query.equal("country_code", countryCode), Query.limit(200)],
    });
    return Object.fromEntries(page.rows.map((row) => [String(row.task_id), String(row.status) === "done"]));
  } catch (error) {
    console.warn("[greenbook] progress read failed", error);
    return {};
  }
}

export async function setProgress(
  userId: string,
  taskId: string,
  done: boolean,
  meta?: { chapterId?: string; entryId?: string; countryCode?: string },
): Promise<boolean> {
  if (!ready() || !userId) return false;
  try {
    const existing = await tablesDB.listRows<Row>({
      databaseId: APPWRITE_DATABASE_ID!,
      tableId: PROGRESS,
      queries: [Query.equal("user_id", userId), Query.equal("task_id", taskId), Query.limit(1)],
    });
    const data = {
      user_id: userId,
      country_code: meta?.countryCode ?? "",
      chapter_id: meta?.chapterId ?? "",
      entry_id: meta?.entryId ?? null,
      task_id: taskId,
      status: done ? "done" : "pending",
      completed_at: done ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    };
    if (existing.rows[0]) {
      await tablesDB.updateRow({ databaseId: APPWRITE_DATABASE_ID!, tableId: PROGRESS, rowId: existing.rows[0].$id, data });
    } else {
      await tablesDB.createRow({
        databaseId: APPWRITE_DATABASE_ID!,
        tableId: PROGRESS,
        rowId: ID.unique(),
        data,
        permissions: [Permission.read(Role.user(userId)), Permission.update(Role.user(userId)), Permission.delete(Role.user(userId))],
      });
    }
    return true;
  } catch (error) {
    // Best-effort: the optimistic UI already reflects the toggle, and the next
    // successful write reconciles it. Losing a checkbox is better than a crash.
    console.warn("[greenbook] progress write failed", error);
    return false;
  }
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
