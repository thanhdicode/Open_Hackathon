/**
 * Greenbook persistence.
 *
 * Writes validated facts to Appwrite using the TablesDB API. The ingestion
 * worker runs server-side with an API key, so this uses the Node SDK rather than
 * the browser client.
 *
 * Two invariants it enforces, because they are the difference between a field
 * manual and a wiki:
 *   - A fact may only be written with a verification status the validator
 *     produced. Nothing here can promote a fact.
 *   - Writes are idempotent by construction: every row id is derived from the
 *     content it represents, so `upsertRow` makes a re-run a no-op instead of a
 *     duplicate. No read-before-write is needed to be safe.
 *
 * Note the limit of that second invariant, measured 2026-09-16: content-addressed
 * row ids stop the *same wording* from being written twice, but extraction is
 * nondeterministic, so the same rule phrased differently is a different row. The
 * layer that actually makes a re-run a no-op is `getSourceState` — an unchanged
 * page is never re-extracted.
 */
import { Client, ID, Permission, Query, Role, Storage, TablesDB } from "node-appwrite";

/** Appwrite row ids are limited to 36 characters. */
const MAX_ROW_ID = 36;
const ROW_ID_PATTERN = /[^a-zA-Z0-9._-]/g;

/**
 * The read permission a fact may carry, decided by its verification status.
 *
 * WHY THIS IS HERE AND NOT IN A SEPARATE PUBLISH STEP
 *
 * The tables are `access: "server"`, so a browser client can read nothing by
 * default and access is decided per row. That permission used to be applied
 * afterwards, by scripts/greenbook/publish.mjs.
 *
 * Measured 2026-09-16: a re-ingestion that deleted and recreated rows dropped
 * every grant, and the Greenbook silently rendered "0 verified points" for a
 * country whose facts were sitting in the database. A two-step publish is a
 * correctness bug waiting for a reset, so the permission is now written with the
 * row, at the moment the row is created. `publish.mjs` remains as a repair and
 * audit tool for rows that predate this.
 *
 * Non-published facts get NO permission: candidate, needs_review, conflict,
 * rejected and unverified rows are never readable by a student.
 */
const PUBLISHED_STATUSES = ["official_verified", "university_verified", "community_verified", "stale"];

function publishPermissions(verificationStatus) {
  return PUBLISHED_STATUSES.includes(verificationStatus) ? [Permission.read(Role.any())] : [];
}

function rowId(prefix, seed) {
  const safe = String(seed).replace(ROW_ID_PATTERN, "_");
  return `${prefix}_${safe}`.slice(0, MAX_ROW_ID);
}

export function createAdminClient() {
  const endpoint = process.env.VITE_APPWRITE_ENDPOINT;
  const projectId = process.env.VITE_APPWRITE_PROJECT_ID;
  const apiKey = process.env.APPWRITE_API_KEY;
  if (!endpoint || !projectId || !apiKey) throw new Error("Appwrite admin credentials are not configured");

  const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
  return {
    tables: new TablesDB(client),
    storage: new Storage(client),
    databaseId: process.env.VITE_APPWRITE_DATABASE_ID,
    snapshotBucketId: process.env.GREENBOOK_SNAPSHOT_BUCKET_ID || "greenbook_snapshots",
  };
}

const FACTS = "knowledge_facts";
const SOURCES = "knowledge_sources";
const SNAPSHOTS = "source_snapshots";
const EVENTS = "verification_events";

function toIso(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** Appwrite rejects empty strings on optional columns; null is the absence. */
function orNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Confidence is a label in the frozen schema, derived from the numeric value. */
function confidenceLabel(value) {
  if (typeof value !== "number") return "low";
  if (value >= 0.8) return "high";
  if (value >= 0.5) return "medium";
  return "low";
}

export async function upsertSource(admin, source, { contentHash, checkedAt } = {}) {
  const { tables, databaseId } = admin;
  const data = {
    source_id: source.id,
    country_code: source.country,
    city: orNull(source.city),
    university_id: orNull(source.university),
    title: source.agency,
    url: source.url,
    source_type: source.source_type,
    authority_level: source.authority,
    language: orNull(source.language),
    published_at: null,
    checked_at: toIso(checkedAt) ?? new Date().toISOString(),
    valid_until: null,
    content_hash: contentHash ?? "unfetched",
    status: source.status,
  };
  // Sources are citation targets, so they are readable wherever they are cited.
  const row = await tables.upsertRow({ databaseId, tableId: SOURCES, rowId: rowId("src", source.id), data, permissions: [Permission.read(Role.any())] });
  return { rowId: row.$id };
}

/**
 * Record a snapshot's metadata. The bytes live in Storage; this is the pointer
 * plus the hash that makes re-ingestion idempotent — the same source with the
 * same bytes collapses onto the same row.
 */
export async function recordSnapshot(admin, { source, contentHash, bytes, contentType, storageKey, storeKind }) {
  const { tables, databaseId } = admin;
  if (!contentHash) return null;

  const data = {
    snapshot_id: `${source.id}-${contentHash.slice(0, 16)}`,
    source_id: source.id,
    country_code: source.country,
    storage_key: storageKey ?? "local",
    storage_bucket: admin.snapshotBucketId,
    content_hash: contentHash,
    bytes: bytes ?? 0,
    content_type: orNull(contentType),
    snapshot_store: storeKind ?? "local",
    fetched_at: new Date().toISOString(),
    processed_at: new Date().toISOString(),
    status: "archived",
  };
  const row = await tables.upsertRow({ databaseId, tableId: SNAPSHOTS, rowId: rowId("snap", `${source.id}_${contentHash.slice(0, 10)}`), data });
  return { rowId: row.$id };
}

/**
 * Write validated facts.
 *
 * Every fact is keyed by its own content hash, so re-running the pipeline
 * updates the same row rather than adding a second copy of the same
 * requirement.
 *
 * This reads before it writes, which the earlier version avoided. The reason is
 * reporting, not safety: `upsertRow` cannot tell you whether it inserted or
 * updated, so every re-run reported "15 facts written, 0 already present" even
 * when it had changed nothing. That message is the only evidence an operator
 * has that a scheduled run was a no-op, so it has to be true. The read also
 * stops the audit trail from filling with duplicate events on every re-run —
 * an event now means something actually changed.
 */
export async function writeFacts(admin, facts) {
  const { tables, databaseId } = admin;
  const written = [];
  const skipped = [];
  const unchanged = [];

  for (const fact of facts) {
    if (!fact.factHash) {
      skipped.push({ claim: fact.claim, reason: "no fact hash" });
      continue;
    }

    const factId = fact.factHash.slice(0, 32);
    const notes = fact.validationNotes?.length ? fact.validationNotes.join("; ") : null;
    const id = rowId("fact", factId);

    const data = {
      fact_id: factId,
      source_id: fact.sourceId,
      country_code: fact.country,
      city: orNull(fact.city),
      university_id: orNull(fact.university),
      category: fact.chapter,
      context_key: fact.journeyStage,
      claim: fact.claim,
      actionable_advice: orNull(fact.action),
      authority_level: fact.authorityLevel,
      confidence_label: confidenceLabel(fact.confidence),
      checked_at: toIso(fact.checkedAt) ?? new Date().toISOString(),
      valid_until: toIso(fact.validUntil),
      verification_status: fact.verificationStatus,
      fact_hash: fact.factHash,
      chapter: fact.chapter,
      journey_stage: fact.journeyStage,
      evidence_quote: orNull(fact.evidenceQuote),
      origin: fact.origin ?? "crawler",
      validation_notes: notes,
      effective_from: toIso(fact.effectiveFrom),
    };

    let existing = null;
    try {
      existing = await tables.getRow({ databaseId, tableId: FACTS, rowId: id });
    } catch (error) {
      if (error?.code !== 404) throw error;
    }

    if (!existing) {
      await tables.createRow({ databaseId, tableId: FACTS, rowId: id, data, permissions: publishPermissions(fact.verificationStatus) });
      written.push({ factId, status: fact.verificationStatus, claim: fact.claim.slice(0, 120), action: "created" });
    } else {
      const statusChanged = existing.verification_status !== fact.verificationStatus;
      // Permissions are re-applied on update too: a fact that moves from
      // needs_review to official_verified must become readable, and one that
      // moves back must stop being readable.
      await tables.updateRow({ databaseId, tableId: FACTS, rowId: id, data, permissions: publishPermissions(fact.verificationStatus) });
      if (statusChanged) {
        written.push({ factId, status: fact.verificationStatus, claim: fact.claim.slice(0, 120), action: "status changed" });
      } else {
        // The row already described this requirement. Nothing about the
        // student-facing guidance changed, so it is not a write.
        unchanged.push({ factId, status: fact.verificationStatus, claim: fact.claim.slice(0, 120) });
        continue;
      }
    }

    /*
     * An event is an audit record of a transition, so it is emitted only when
     * the fact appeared or its verification status moved. Re-running the
     * pipeline over an unchanged page produces no events at all.
     */
    await tables.createRow({
      databaseId,
      tableId: EVENTS,
      rowId: ID.unique(),
      data: {
        event_id: `${factId}-${Date.now()}`,
        fact_id: factId,
        source_id: fact.sourceId,
        from_status: existing?.verification_status ?? null,
        to_status: fact.verificationStatus,
        reason: notes ? notes.slice(0, 500) : "passed all deterministic checks",
        actor: "validator",
        created_at: new Date().toISOString(),
      },
    });
  }

  return { written, skipped, unchanged };
}

/**
 * Read a source's stored state so ingestion can tell whether the page changed.
 *
 * This is the real idempotency boundary, and it exists because of a measured
 * failure rather than a theory. Row ids are derived from `factHash`, which
 * normalises case and punctuation — but nothing normalises a *paraphrase*.
 * Measured 2026-09-16: re-running extraction over an unchanged page (identical
 * content hash) turned 15 facts into 29 rows with **zero** hash collisions,
 * because the model phrased the same rules differently:
 *
 *   "Higher education student pass applications must be submitted while the
 *    applicant is outside Malaysia."
 *   "Applicants for a Student Pass must be outside Malaysia when submitting
 *    their application."
 *
 * The page hash is the only deterministic signal in the pipeline, so an
 * unchanged page must not be sent to the model at all. This also makes a
 * scheduled re-run cheap: no tokens spent on a page we have already read.
 */
export async function getSourceState(admin, sourceId) {
  const { tables, databaseId } = admin;
  try {
    const row = await tables.getRow({ databaseId, tableId: SOURCES, rowId: rowId("src", sourceId) });
    return { contentHash: row.content_hash ?? null, checkedAt: row.checked_at ?? null };
  } catch (error) {
    // 404 simply means we have never ingested this source.
    if (error?.code === 404) return null;
    throw error;
  }
}

/** Read facts for a country, optionally narrowed by chapter, stage or status. */
export async function listFacts(admin, { country, chapter, journeyStage, statuses, limit = 50 }) {
  const { tables, databaseId } = admin;
  const queries = [Query.equal("country_code", country), Query.limit(limit)];
  if (chapter) queries.push(Query.equal("chapter", chapter));
  if (journeyStage) queries.push(Query.equal("journey_stage", journeyStage));
  if (statuses?.length) queries.push(Query.equal("verification_status", statuses));

  const result = await tables.listRows({ databaseId, tableId: FACTS, queries });
  return result.rows;
}
