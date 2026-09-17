const string = (key, required = false, size = 255) => ({ key, type: "string", size, required });
const text = (key, required = false) => ({ key, type: "text", required });
const integer = (key, required = false) => ({ key, type: "integer", required });
const datetime = (key, required = false) => ({ key, type: "datetime", required });
const json = (key, required = false) => text(key, required);

const owner = (id, columns, indexes = []) => ({ id, name: id, rowSecurity: true, columns, indexes, access: "owner" });
const server = (id, columns, indexes = []) => ({ id, name: id, rowSecurity: true, columns, indexes, access: "server" });

export const P0_TABLES = [
  // `journey_dates` holds the canonical timeline as JSON (departure / arrival /
  // programme start / programme end / return). It is a JSON column rather than
  // five datetime columns because the set is a product concept the client owns
  // and will grow; `exchange_start` and `exchange_end` are kept and populated
  // from it (arrival and return) so anything already reading those stays right.
  // `journey_role` is DERIVED from the timeline, never chosen by the student.
  owner("student_profiles", [string("user_id", true, 36), string("display_name"), string("home_country_code", true, 2), string("host_country_code", true, 2), string("host_city"), string("university_id"), datetime("exchange_start"), datetime("exchange_end"), json("languages"), json("interests"), json("goals"), json("concerns"), string("exchange_stage"), json("journey_dates"), string("journey_role", false, 24), datetime("created_at", true), datetime("updated_at", true)], [{ key: "user_id_unique", type: "unique", attributes: ["user_id"] }]),
  owner("journeys", [string("journey_id", true, 36), string("user_id", true, 36), string("home_country_code", true, 2), string("host_country_code", true, 2), string("city"), string("university_id"), datetime("start_date"), datetime("end_date"), string("status", true), integer("is_current", true), datetime("updated_at", true)], [{ key: "journey_id_unique", type: "unique", attributes: ["journey_id"] }, { key: "user_current", type: "key", attributes: ["user_id", "is_current"] }]),
  owner("my_dna_profiles", [string("user_id", true, 36), integer("explicitness", true), integer("formality", true), integer("hierarchy_sensitivity", true), integer("conflict_openness", true), integer("relationship_orientation", true), integer("time_structure", true), integer("participation_confidence", true), integer("uncertainty_tolerance", true), string("assessment_version", true), datetime("updated_at", true)], [{ key: "user_id_unique", type: "unique", attributes: ["user_id"] }]),
  owner("user_task_progress", [string("user_id", true, 36), string("task_id", true), string("status", true), datetime("completed_at"), integer("saved", true), datetime("updated_at", true)], [{ key: "user_task_unique", type: "unique", attributes: ["user_id", "task_id"] }]),
  owner("skill_profiles", [string("user_id", true, 36), integer("language_clarity", true), integer("tone", true), integer("intent_recognition", true), integer("context_awareness", true), integer("adaptability", true), integer("confidence", true), datetime("updated_at", true)], [{ key: "user_id_unique", type: "unique", attributes: ["user_id"] }]),
  owner("lens_sessions", [string("session_id", true, 36), string("user_id", true, 36), string("journey_id"), string("input_type", true), string("context_key", true), string("detected_language"), text("literal_meaning"), json("likely_intents"), string("risk_level"), text("recommended_action"), string("confidence_label"), json("source_ids"), datetime("created_at", true)], [{ key: "session_id_unique", type: "unique", attributes: ["session_id"] }]),
  owner("practice_sessions", [string("session_id", true, 36), string("user_id", true, 36), string("scenario_id", true), integer("attempt_number", true), text("transcript_summary"), json("score_json"), json("feedback_json"), integer("duration_seconds"), datetime("completed_at")], [{ key: "session_id_unique", type: "unique", attributes: ["session_id"] }]),
  server("knowledge_sources", [string("source_id", true, 64), string("country_code", true, 2), string("city"), string("university_id"), string("title", true), string("url", true, 2048), string("source_type", true), string("authority_level", true, 1), string("language"), datetime("published_at"), datetime("checked_at", true), datetime("valid_until"), string("content_hash", true, 128), string("status", true)], [{ key: "source_id_unique", type: "unique", attributes: ["source_id"] }]),
  server("knowledge_facts", [string("fact_id", true, 64), string("source_id", true, 64), string("country_code", true, 2), string("city"), string("university_id"), string("category", true), string("context_key", true), text("claim", true), text("actionable_advice"), string("authority_level", true, 1), string("confidence_label", true), datetime("checked_at", true), datetime("valid_until"), string("verification_status", true), string("fact_hash", false, 64), string("chapter", false, 40), string("journey_stage", false, 24), text("evidence_quote", false), string("origin", false, 16), text("validation_notes", false), datetime("effective_from")], [{ key: "fact_id_unique", type: "unique", attributes: ["fact_id"] }, { key: "retrieval", type: "key", attributes: ["country_code", "category", "context_key"] }]),
  owner("passport_progress", [string("user_id", true, 36), json("countries_experienced", true), integer("situations_mastered", true), integer("situations_total", true), json("language_practice", true), integer("verified_interactions", true), json("skills", true), json("quests", true), json("stamps", true), datetime("updated_at", true)], [{ key: "user_id_unique", type: "unique", attributes: ["user_id"] }]),
  // Extended in Phase 5 (additively) so the same row serves Connect People
  // discovery. `discoverable` is the opt-in gate: a row is only granted
  // authenticated read when the student turned discoverability ON, and
  // `live_location_shared` exists purely so the "we do not track you" claim is
  // a stored, testable fact rather than a UI promise.
  owner("student_social_profiles", [string("user_id", true, 36), string("display_name", true), string("avatar_file_id"), string("role", true), string("current_country", true, 2), string("city"), string("university_id"), string("major"), text("bio"), json("interests"), json("languages"), json("exchange_history"), integer("local_helper", true), integer("discoverable", true), datetime("updated_at", true), string("home_country_code", false, 2), string("host_country_code", false, 2), integer("is_demo_seed"), string("seed_origin", false, 16), string("verification", false, 24), datetime("joined_at"), integer("live_location_shared")], [{ key: "user_id_unique", type: "unique", attributes: ["user_id"] }, { key: "social_discovery", type: "key", attributes: ["discoverable", "host_country_code"] }]),
  owner("conversations", [string("conversation_id", true, 36), json("member_ids", true), datetime("created_at", true), datetime("updated_at", true)], [{ key: "conversation_id_unique", type: "unique", attributes: ["conversation_id"] }]),
  owner("messages", [string("message_id", true, 36), string("conversation_id", true, 36), string("sender_id", true, 36), text("content", true), text("translated_content"), datetime("created_at", true), datetime("deleted_at")], [{ key: "message_id_unique", type: "unique", attributes: ["message_id"] }, { key: "conversation_created", type: "key", attributes: ["conversation_id", "created_at"] }]),
  // Phase 2 — Settings → Safety. Private to the student who created the block.
  owner("user_blocks", [string("user_id", true, 36), string("blocked_user_id", true, 36), string("display_name"), datetime("created_at", true)], [{ key: "block_pair_unique", type: "unique", attributes: ["user_id", "blocked_user_id"] }]),
];

/**
 * Phase 4 — Living Greenbook.
 *
 * Split by ownership, which is also the privacy boundary:
 *
 *   server  published knowledge. Written only by the ingestion worker; readable
 *           by any signed-in student. Contains no personal data.
 *   owner   a student's own reading position and completed tasks.
 *
 * Raw source snapshots deliberately do NOT live here — they are blobs and go to
 * Storage. `source_snapshots` holds only the metadata and the storage reference.
 */
export const GREENBOOK_TABLES = [
  server("greenbook_countries", [string("country_code", true, 2), string("name", true), string("student_edition_label"), text("summary"), json("chapters", true), integer("facts_verified", true), datetime("last_verified_at"), string("status", true)], [{ key: "country_unique", type: "unique", attributes: ["country_code"] }]),

  server("greenbook_chapters", [string("chapter_id", true, 40), string("country_code", true, 2), string("title", true), text("purpose"), integer("order_index", true), string("icon")], [{ key: "chapter_unique", type: "unique", attributes: ["country_code", "chapter_id"] }]),

  server("greenbook_entries", [string("entry_id", true, 64), string("country_code", true, 2), string("chapter_id", true, 40), string("city"), string("university_id"), string("title", true), text("what_to_know"), json("what_to_do", true), json("phrase_ids"), json("media_ids"), json("fact_ids", true), string("freshness_label"), datetime("last_verified_at"), string("status", true)], [{ key: "entry_unique", type: "unique", attributes: ["entry_id"] }, { key: "entry_lookup", type: "key", attributes: ["country_code", "chapter_id", "status"] }]),

  // Metadata only. The bytes live in Storage under a deterministic key.
  server("source_snapshots", [string("snapshot_id", true, 64), string("source_id", true, 64), string("country_code", true, 2), string("storage_key", true, 512), string("storage_bucket", true, 64), string("content_hash", true, 64), integer("bytes", true), string("content_type"), string("snapshot_store", true, 16), datetime("fetched_at", true), datetime("processed_at"), string("status", true)], [{ key: "snapshot_unique", type: "unique", attributes: ["source_id", "content_hash"] }]),

  server("knowledge_chunks", [string("chunk_id", true, 64), string("fact_id", true, 64), string("source_id", true, 64), string("country_code", true, 2), string("chapter", false, 40), text("chunk_text", true), integer("chunk_index", true), string("embedding_model"), json("embedding"), datetime("created_at", true)], [{ key: "chunk_unique", type: "unique", attributes: ["chunk_id"] }, { key: "chunk_lookup", type: "key", attributes: ["country_code", "chapter"] }]),

  server("universities", [string("university_id", true, 64), string("country_code", true, 2), string("name", true), string("city"), string("international_office_url", false, 2048), string("student_pass_notes"), json("resources", true), datetime("checked_at")], [{ key: "university_unique", type: "unique", attributes: ["university_id"] }]),

  server("university_resources", [string("resource_id", true, 64), string("university_id", true, 64), string("title", true), string("url", true, 2048), string("kind", true, 32), text("summary"), string("authority_level", true, 1), datetime("checked_at")], [{ key: "university_resource_unique", type: "unique", attributes: ["resource_id"] }]),

  server("student_phrases", [string("phrase_id", true, 64), string("country_code", true, 2), string("language_code", true, 8), text("local_text", true), string("romanization"), text("translation"), string("context_key", true), string("chapter", false, 40), string("register", false, 24), string("audio_file_id"), datetime("checked_at")], [{ key: "phrase_unique", type: "unique", attributes: ["phrase_id"] }, { key: "phrase_lookup", type: "key", attributes: ["country_code", "context_key"] }]),

  // Extended in Phase 5 with the OSM identity and the denormalised community
  // counters the Explore map and its bottom sheet read. The base place stays
  // objective map data; everything a student contributes lives in
  // `place_contributions`, so one physical place can carry many experiences
  // without the two layers ever being written into the same row.
  server("places", [string("place_id", true, 64), string("country_code", true, 2), string("city"), string("name", true), string("category", true), text("description"), string("address"), string("latitude"), string("longitude"), string("what_to_say_phrase_id"), string("source_url", false, 2048), string("authority_level", true, 1), datetime("checked_at"), string("osm_type", false, 8), string("osm_id", false, 32), string("university_id", false, 64), string("campus_id", false, 40), string("source", false, 32), datetime("source_updated_at"), json("tags"), integer("student_saves"), integer("student_stories"), integer("is_demo_seed"), string("status", false, 16), text("search_text")], [{ key: "place_unique", type: "unique", attributes: ["place_id"] }, { key: "place_map", type: "key", attributes: ["country_code", "category", "status"] }]),

  server("media_resources", [string("media_id", true, 64), string("platform", true, 24), string("url", true, 2048), string("external_id"), string("title"), string("creator"), string("thumbnail_url", false, 2048), string("country_code", true, 2), string("chapter", false, 40), string("city"), string("university_id"), string("trust_tier", true, 24), integer("embed_allowed", true), integer("mirror_allowed", true), string("language"), datetime("analysis_date"), datetime("checked_at")], [{ key: "media_unique", type: "unique", attributes: ["media_id"] }, { key: "media_lookup", type: "key", attributes: ["country_code", "chapter", "trust_tier"] }]),

  server("media_insights", [string("insight_id", true, 64), string("media_id", true, 64), text("summary", true), json("key_points", true), json("timestamps"), string("student_stage", false, 24), json("practice_ideas"), string("derived_by", true, 64), datetime("created_at", true)], [{ key: "media_insight_unique", type: "unique", attributes: ["insight_id"] }]),

  server("greenbook_tasks", [string("task_id", true, 64), string("country_code", true, 2), string("chapter_id", true, 40), string("journey_stage", true, 24), string("title", true), text("detail"), integer("order_index", true), json("fact_ids", true)], [{ key: "task_unique", type: "unique", attributes: ["task_id"] }, { key: "task_lookup", type: "key", attributes: ["country_code", "chapter_id", "journey_stage"] }]),

  server("verification_events", [string("event_id", true, 64), string("fact_id", true, 64), string("source_id", true, 64), string("from_status"), string("to_status", true), string("reason"), string("actor", true, 32), datetime("created_at", true)], [{ key: "verification_event_unique", type: "unique", attributes: ["event_id"] }]),

  owner("greenbook_progress", [string("user_id", true, 36), string("country_code", true, 2), string("chapter_id", true, 40), string("entry_id"), string("task_id", true), string("status", true, 16), datetime("completed_at"), datetime("updated_at", true)], [{ key: "greenbook_progress_unique", type: "unique", attributes: ["user_id", "task_id"] }, { key: "greenbook_progress_lookup", type: "key", attributes: ["user_id", "country_code"] }]),
];

/**
 * Phase 5 — Connect + Explore.
 *
 * Reuse before create. Three logical entities the Phase 5 brief names already
 * exist and are extended in place rather than duplicated:
 *
 *   student_social_profiles  the student's social row (P0)      -> Connect People
 *   places                   the objective base place (Phase 4) -> Explore map
 *   user_blocks              the block list (Phase 2)           -> Safety
 *
 * Everything below is genuinely new. The ownership split is also the privacy
 * split, and it is the whole reason each row is stamped at write time:
 *
 *   feed content      rows carry an authenticated-read grant so other students
 *                     can read them, but update/delete stays owner-only. A user
 *                     can never write to another user's row.
 *   personal state    reactions, saves, follows, collections. Owner-only. These
 *                     are never granted to anyone else; the public numbers
 *                     (reaction_count, save_count) are denormalised onto the
 *                     parent row instead of exposing who reacted.
 *   moderation        reports. Owner + server. Deliberately unreadable by other
 *                     users so a report cannot be used to profile a reporter.
 */
export const PHASE5_TABLES = [
  // `topics` and `journey_stage` are the enrichment columns. They are additive:
  // a post written before they existed reads back with empty topics, and
  // `mapPost` falls back to the author's own tags rather than treating the post
  // as topic-less. `journey_stage` is derived, never chosen by the author.
  owner("community_posts", [string("post_id", true, 64), string("author_id", true, 36), string("country_code", true, 2), string("university_id", false, 64), string("post_type", true, 24), text("body", true), string("place_id", false, 64), json("tags"), json("topics"), string("journey_stage", false, 24), string("visibility", true, 24), integer("is_demo_seed"), string("seed_origin", false, 16), string("verification", false, 24), integer("reaction_count"), integer("comment_count"), integer("save_count"), integer("media_count"), datetime("created_at", true), datetime("updated_at"), datetime("deleted_at")], [{ key: "post_unique", type: "unique", attributes: ["post_id"] }, { key: "post_feed", type: "key", attributes: ["country_code", "created_at"] }, { key: "post_university", type: "key", attributes: ["university_id", "created_at"] }, { key: "post_type_lookup", type: "key", attributes: ["post_type", "created_at"] }, { key: "post_place", type: "key", attributes: ["place_id"] }]),

  // `kind` distinguishes image from video. `duration_s` is read from the file in
  // the browser and stored so the card can show a length without loading the
  // media; it is 0 for images and for any video the browser could not decode.
  owner("post_media", [string("media_id", true, 64), string("post_id", true, 64), string("kind", true, 16), string("file_id", false, 64), string("url", false, 2048), integer("width"), integer("height"), string("alt_text"), string("attribution"), string("license", false, 64), integer("duration_s"), integer("order_index", true), datetime("created_at", true)], [{ key: "post_media_unique", type: "unique", attributes: ["media_id"] }, { key: "post_media_post", type: "key", attributes: ["post_id", "order_index"] }]),

  owner("post_reactions", [string("reaction_id", true, 64), string("post_id", true, 64), string("user_id", true, 36), string("kind", true, 16), datetime("created_at", true)], [{ key: "reaction_unique", type: "unique", attributes: ["post_id", "user_id"] }, { key: "reaction_post", type: "key", attributes: ["post_id"] }]),

  owner("post_comments", [string("comment_id", true, 64), string("post_id", true, 64), string("author_id", true, 36), text("body", true), integer("is_demo_seed"), datetime("created_at", true), datetime("deleted_at")], [{ key: "comment_unique", type: "unique", attributes: ["comment_id"] }, { key: "comment_post", type: "key", attributes: ["post_id", "created_at"] }]),

  owner("saved_posts", [string("save_id", true, 64), string("post_id", true, 64), string("user_id", true, 36), datetime("created_at", true)], [{ key: "saved_post_unique", type: "unique", attributes: ["user_id", "post_id"] }, { key: "saved_post_user", type: "key", attributes: ["user_id", "created_at"] }]),

  owner("place_contributions", [string("contribution_id", true, 64), string("place_id", true, 64), string("author_id", true, 36), text("note", true), string("media_file_id", false, 64), string("media_url", false, 2048), json("tags"), string("visit_context", false, 32), string("country_code", true, 2), string("university_id", false, 64), integer("is_demo_seed"), string("visibility", true, 24), datetime("created_at", true)], [{ key: "contribution_unique", type: "unique", attributes: ["contribution_id"] }, { key: "contribution_place", type: "key", attributes: ["place_id", "created_at"] }, { key: "contribution_author", type: "key", attributes: ["author_id", "created_at"] }]),

  owner("place_saves", [string("save_id", true, 64), string("place_id", true, 64), string("user_id", true, 36), datetime("created_at", true)], [{ key: "place_save_unique", type: "unique", attributes: ["user_id", "place_id"] }, { key: "place_save_place", type: "key", attributes: ["place_id"] }]),

  owner("place_collections", [string("collection_id", true, 64), string("user_id", true, 36), string("name", true, 120), json("place_ids", true), datetime("created_at", true), datetime("updated_at")], [{ key: "collection_unique", type: "unique", attributes: ["collection_id"] }, { key: "collection_user", type: "key", attributes: ["user_id"] }]),

  owner("follows", [string("follow_id", true, 64), string("follower_id", true, 36), string("following_id", true, 36), datetime("created_at", true)], [{ key: "follow_unique", type: "unique", attributes: ["follower_id", "following_id"] }, { key: "follow_following", type: "key", attributes: ["following_id"] }]),

  // Moderated, never published. Only the reporter and the server can read a
  // report; a block is the reporter's own row and lives in `user_blocks`.
  owner("reports", [string("report_id", true, 64), string("reporter_id", true, 36), string("target_type", true, 24), string("target_id", true, 64), string("reason", true, 48), text("detail"), string("status", true, 24), datetime("created_at", true)], [{ key: "report_unique", type: "unique", attributes: ["report_id"] }, { key: "report_target", type: "key", attributes: ["target_type", "target_id"] }]),
];

export function privateRowPermissions(userId) {
  return [`read(\"user:${userId}\")`, `update(\"user:${userId}\")`, `delete(\"user:${userId}\")`];
}

export function tablePermissions(table) {
  return table.access === "owner" ? ['create("users")'] : [];
}

/**
 * User-media buckets, governed by the media-privacy rules in
 * docs/03_TECH_ARCHITECTURE.md §6 and the Phase 2 profile requirements in
 * docs/06_APPWRITE_SCHEMA.md §15.
 *
 * `profile_media` holds opt-in social avatars: file-level security so each
 * avatar carries its own permissions, images only, small size cap.
 *
 * Deliberately separate from SOURCE_BUCKETS. The two have opposite privacy
 * models — user media is per-file private, source archives are worker-only —
 * and holding them in one list invited exactly the mistake of applying one
 * model to the other.
 */
export const MEDIA_BUCKETS = [
  {
    id: "profile_media",
    name: "profile_media",
    purpose: "opt-in social profile avatars",
    fileSecurity: true,
    maximumFileSize: 2_000_000,
    allowedFileExtensions: ["jpg", "jpeg", "png", "webp"],
    permissions: ['create("users")'],
    compression: "none",
  },
  {
    id: "community_media",
    name: "community_media",
    purpose: "student-uploaded photos and short videos attached to community posts and place experiences",
    fileSecurity: true,
    // 20 MB is the video ceiling the composer enforces. The bucket cap and the
    // client cap are the same number on purpose: a bucket that accepts more than
    // the UI allows is a hole, and a UI that allows more than the bucket accepts
    // is a confusing 400.
    maximumFileSize: 20_000_000,
    /*
     * An allowlist, not a denylist. `svg` is deliberately absent — an SVG is a
     * script host, and serving one from the media origin would be stored XSS
     * with a "photo" label. `html`, `pdf` and every document format are absent
     * for the same reason: this bucket is for media a student looks at, not
     * files a browser might execute or a viewer might open.
     */
    allowedFileExtensions: ["jpg", "jpeg", "png", "webp", "mp4", "webm"],
    permissions: ['create("users")'],
    compression: "none",
  },
];

/**
 * Worker-only archive buckets for the Greenbook ingestion pipeline.
 *
 * Government HTML and PDFs are blobs, not records: they are archived so facts
 * can be re-extracted when the extractor improves and diffed when a source
 * changes. Keeping them in the same Storage service as user media means one
 * credential and one permission model instead of two.
 *
 * Not readable by clients: only the ingestion worker writes, and the app reads
 * facts, never raw pages.
 */
export const SOURCE_BUCKETS = [
  {
    id: "greenbook_snapshots",
    name: "greenbook_snapshots",
    purpose: "archived raw source pages and PDFs for fact re-extraction",
    fileSecurity: false,
    maximumFileSize: 20_000_000,
    allowedFileExtensions: ["html", "htm", "pdf", "json", "csv", "xml", "txt"],
    permissions: [],
    compression: "none",
  },
];

/** Every bucket the bootstrap must create or reconcile. */
export const ALL_BUCKETS = [...MEDIA_BUCKETS, ...SOURCE_BUCKETS];

/**
 * Tightened policy for the environment-provided temporary media bucket
 * (Lens screenshots / PDFs). Raw media is transient: derived insight is
 * persisted, the original is deleted after processing.
 */
export const TEMP_MEDIA_POLICY = {
  fileSecurity: true,
  maximumFileSize: 15_000_000,
  allowedFileExtensions: ["jpg", "jpeg", "png", "webp", "heic", "pdf"],
  compression: "none",
};
