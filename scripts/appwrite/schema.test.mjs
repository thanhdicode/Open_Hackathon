import assert from "node:assert/strict";
import test from "node:test";

import { ALL_BUCKETS, GREENBOOK_TABLES, MEDIA_BUCKETS, P0_TABLES, PHASE5_TABLES, SOURCE_BUCKETS, TEMP_MEDIA_POLICY, privateRowPermissions } from "./schema.mjs";

test("declares every assigned P0 table exactly once", () => {
  const expected = [
    "student_profiles",
    "journeys",
    "my_dna_profiles",
    "user_task_progress",
    "skill_profiles",
    "lens_sessions",
    "practice_sessions",
    "knowledge_sources",
    "knowledge_facts",
    "passport_progress",
    "student_social_profiles",
    "conversations",
    "messages",
    // Phase 2 addition: Settings → Safety block list (owner-only rows).
    "user_blocks",
  ];

  assert.deepEqual(P0_TABLES.map((table) => table.id), expected);
  assert.equal(new Set(expected).size, expected.length);
});

test("social profile keeps public fields only and stays opt-in", () => {
  const social = P0_TABLES.find((table) => table.id === "student_social_profiles");
  assert.ok(social);
  const keys = social.columns.map((column) => column.key);
  for (const key of ["display_name", "avatar_file_id", "role", "current_country", "city", "university_id", "major", "bio", "interests", "languages", "discoverable", "local_helper"]) {
    assert.ok(keys.includes(key), `social profile is missing ${key}`);
  }
  // Private journey fields must never live on the discoverable table.
  for (const leaked of ["goals", "concerns", "exchange_start", "exchange_end", "explicitness"]) {
    assert.ok(!keys.includes(leaked), `social profile must not expose ${leaked}`);
  }
  assert.equal(social.access, "owner");
});

test("user blocks are private pairs", () => {
  const blocks = P0_TABLES.find((table) => table.id === "user_blocks");
  assert.ok(blocks);
  assert.equal(blocks.access, "owner");
  assert.deepEqual(
    blocks.columns.map((column) => column.key),
    ["user_id", "blocked_user_id", "display_name", "created_at"],
  );
  assert.deepEqual(blocks.indexes[0].attributes, ["user_id", "blocked_user_id"]);
});

test("passport progress retains the full aggregate required by the Passport", () => {
  const progress = P0_TABLES.find((table) => table.id === "passport_progress");
  assert.ok(progress);
  assert.deepEqual(
    progress.columns.map((column) => column.key),
    [
      "user_id",
      "countries_experienced",
      "situations_mastered",
      "situations_total",
      "language_practice",
      "verified_interactions",
      "skills",
      "quests",
      "stamps",
      "updated_at",
    ],
  );
});

test("private rows grant access only to their owner", () => {
  assert.deepEqual(privateRowPermissions("user-123"), [
    'read("user:user-123")',
    'update("user:user-123")',
    'delete("user:user-123")',
  ]);
});

test("profile media bucket is avatar-safe and privacy-scoped", () => {
  const bucket = MEDIA_BUCKETS.find((candidate) => candidate.id === "profile_media");
  assert.ok(bucket, "the avatar bucket must be declared");
  assert.equal(bucket.fileSecurity, true, "file-level security must be on");
  assert.ok(bucket.maximumFileSize <= 2_000_000, "avatar cap must stay ~2MB");
  for (const extension of bucket.allowedFileExtensions) {
    assert.match(extension, /^(jpg|jpeg|png|webp)$/, `unexpected extension ${extension}`);
  }
  assert.deepEqual(bucket.permissions, ['create("users")'], "uploads are authenticated-only");
});

/*
 * Phase 5 adds a second user-media bucket. It is held to the same privacy model
 * as avatars (per-file security, authenticated upload, media formats only).
 *
 * Phase 5.1 widened it from images to images + short video, so the assertion
 * moved from "images only" to "media only, and never anything a browser will
 * execute". The negative half is the part that matters: the old test would have
 * passed a bucket that also accepted `svg`.
 */
test("community media bucket keeps the user-media privacy model", () => {
  const bucket = MEDIA_BUCKETS.find((candidate) => candidate.id === "community_media");
  assert.ok(bucket, "the community media bucket must be declared");
  assert.equal(bucket.fileSecurity, true, "file-level security must be on");
  assert.deepEqual(bucket.permissions, ['create("users")'], "uploads are authenticated-only");
  for (const extension of bucket.allowedFileExtensions) {
    assert.match(extension, /^(jpg|jpeg|png|webp|mp4|webm)$/, `unexpected extension ${extension}`);
  }
  for (const dangerous of ["svg", "svgz", "html", "htm", "js", "pdf", "exe", "php"]) {
    assert.equal(
      bucket.allowedFileExtensions.includes(dangerous),
      false,
      `${dangerous} in a user-writable bucket is an execution surface`,
    );
  }
  assert.ok(bucket.maximumFileSize > 2_000_000, "a feed photo needs more headroom than an avatar");
  assert.ok(bucket.maximumFileSize <= 25_000_000, "but it must stay bounded so an upload cannot stall the demo");
});

/*
 * User media and source archives have opposite privacy models. They lived in
 * one list until a source bucket was added to MEDIA_BUCKETS, which silently
 * widened a documented media-privacy contract. These two tests keep them apart.
 */
test("source archive buckets are worker-only and never client-readable", () => {
  const bucket = SOURCE_BUCKETS.find((candidate) => candidate.id === "greenbook_snapshots");
  assert.ok(bucket, "the Greenbook snapshot bucket must be declared");
  assert.equal(bucket.fileSecurity, false, "archives are not per-file scoped");
  assert.deepEqual(bucket.permissions, [], "no client may read raw source pages");
  assert.ok(bucket.maximumFileSize >= 10_000_000, "archived government PDFs exceed the avatar cap");
  assert.match(bucket.allowedFileExtensions.join(","), /pdf|html/, "archives are documents, not images");
});

test("user media and source archives never share a list", () => {
  const mediaIds = MEDIA_BUCKETS.map((bucket) => bucket.id);
  const sourceIds = SOURCE_BUCKETS.map((bucket) => bucket.id);
  assert.deepEqual(
    mediaIds.filter((id) => sourceIds.includes(id)),
    [],
    "a bucket must belong to exactly one privacy model",
  );
  assert.equal(ALL_BUCKETS.length, mediaIds.length + sourceIds.length, "ALL_BUCKETS must be the union, with no duplicates");
});

test("temp media bucket policy is transient and type-restricted", () => {
  assert.equal(TEMP_MEDIA_POLICY.fileSecurity, true);
  assert.ok(TEMP_MEDIA_POLICY.maximumFileSize <= 15_000_000);
  for (const extension of TEMP_MEDIA_POLICY.allowedFileExtensions) {
    assert.match(extension, /^(jpg|jpeg|png|webp|heic|pdf)$/, `unexpected extension ${extension}`);
  }
});

/* ------------------------------------------------------------------------- *
 * Phase 5 — Connect + Explore
 *
 * These lock the two rules that make the social layer safe: a student may read
 * other students' public content but may never write to it, and the tables that
 * hold personal state are never granted to anyone else.
 * ------------------------------------------------------------------------- */

test("Phase 5 declares each new table exactly once", () => {
  const expected = [
    "community_posts",
    "post_media",
    "post_reactions",
    "post_comments",
    "saved_posts",
    "place_contributions",
    "place_saves",
    "place_collections",
    "follows",
    "reports",
  ];
  assert.deepEqual(PHASE5_TABLES.map((table) => table.id), expected);
  assert.equal(new Set(expected).size, expected.length);
});

test("Phase 5 reuses existing tables instead of duplicating them", () => {
  const existing = new Set([...P0_TABLES, ...GREENBOOK_TABLES].map((table) => table.id));
  for (const reused of ["student_social_profiles", "places", "user_blocks"]) {
    assert.ok(existing.has(reused), `${reused} must come from an earlier phase`);
  }
  // The brief names these logically; they must not become second physical tables.
  for (const duplicated of ["blocks", "social_profiles", "pois", "student_places"]) {
    assert.ok(!PHASE5_TABLES.some((table) => table.id === duplicated), `${duplicated} duplicates an existing table`);
  }
});

test("every Phase 5 table is row-secured so access is decided per row", () => {
  for (const table of PHASE5_TABLES) {
    assert.equal(table.rowSecurity, true, `${table.id} must enable row security`);
    assert.equal(table.access, "owner", `${table.id} must be an owner table`);
  }
});

test("Phase 5 tables are indexed on the columns the feed actually sorts by", () => {
  const byId = new Map(PHASE5_TABLES.map((table) => [table.id, table]));
  const hasIndex = (id, attributes) =>
    byId.get(id).indexes.some((index) => JSON.stringify(index.attributes) === JSON.stringify(attributes));

  // Cursor pagination is only correct if the sort column is indexed.
  assert.ok(hasIndex("community_posts", ["country_code", "created_at"]), "host-country feed needs country + created_at");
  assert.ok(hasIndex("community_posts", ["university_id", "created_at"]), "my-university feed needs university + created_at");
  assert.ok(hasIndex("community_posts", ["post_type", "created_at"]), "type filters need post_type + created_at");
  assert.ok(hasIndex("community_posts", ["place_id"]), "the feed-to-place bridge resolves by place_id");
  assert.ok(hasIndex("place_contributions", ["place_id", "created_at"]), "the place sheet reads stories by place");
  assert.ok(hasIndex("post_comments", ["post_id", "created_at"]), "comments paginate by post");
  assert.ok(hasIndex("saved_posts", ["user_id", "created_at"]), "Saved filter paginates by user");
});

test("personal state is unique per user so a double tap cannot double count", () => {
  const byId = new Map(PHASE5_TABLES.map((table) => [table.id, table]));
  const uniqueOn = (id, attributes) =>
    byId.get(id).indexes.some((index) => index.type === "unique" && JSON.stringify(index.attributes) === JSON.stringify(attributes));

  assert.ok(uniqueOn("post_reactions", ["post_id", "user_id"]), "one reaction per user per post");
  assert.ok(uniqueOn("saved_posts", ["user_id", "post_id"]), "one save per user per post");
  assert.ok(uniqueOn("place_saves", ["user_id", "place_id"]), "one save per user per place");
  assert.ok(uniqueOn("follows", ["follower_id", "following_id"]), "one follow edge per pair");
});

test("a community post keeps its demo provenance", () => {
  const posts = PHASE5_TABLES.find((table) => table.id === "community_posts");
  const keys = posts.columns.map((column) => column.key);
  for (const key of ["is_demo_seed", "seed_origin", "verification"]) {
    assert.ok(keys.includes(key), `a post must carry ${key} so synthetic content stays labelled`);
  }
  // A post must never carry a field that implies a verified real student.
  for (const forbidden of ["verified_student", "real_user", "partner_student"]) {
    assert.ok(!keys.includes(forbidden), `a post must never claim ${forbidden}`);
  }
});

test("a contribution stores experience, never an authoritative claim", () => {
  const contributions = PHASE5_TABLES.find((table) => table.id === "place_contributions");
  const keys = contributions.columns.map((column) => column.key);
  assert.ok(keys.includes("note"), "the student's own words");
  assert.ok(keys.includes("visit_context"), "when they visited, so the note can be aged");
  for (const forbidden of ["authority_level", "official", "verified_fact"]) {
    assert.ok(!keys.includes(forbidden), `community experience must not carry ${forbidden}`);
  }
});
