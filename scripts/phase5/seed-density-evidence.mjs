/**
 * Phase 5.1 — seed density evidence, measured from storage.
 *
 * The seed script already reports what it wrote, and it verifies those numbers
 * against the tables. This is a second, independent read: it counts rows through
 * the admin API without consulting the seed report at all, so a run that wrote
 * nothing cannot produce a healthy-looking evidence file.
 *
 * It also answers the questions the density claim actually depends on and a
 * single total cannot: is the corpus balanced across the two golden corridors,
 * is every synthetic row marked, and does every seeded media record still carry
 * the provenance that makes it legal to show?
 *
 * Usage:
 *   node --env-file=.env.local scripts/phase5/seed-density-evidence.mjs
 */
import { Query } from "node-appwrite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { adminClients } from "../verify/lib/probe-session.mjs";

const OUT = "docs/evidence/phase5-rc/seed-density.json";
const MANIFEST = "seed/phase5/yapyep_phase5_media_manifest.json";
const SEED_REPORT = "docs/evidence/phase5/seed-report.json";

const { database, tables } = adminClients();

/** Count rows matching a query, following the cursor so the total is exact. */
async function countRows(tableId, queries = []) {
  let total = 0;
  let cursor = null;
  for (;;) {
    const page = await tables.listRows({
      databaseId: database,
      tableId,
      queries: cursor ? [...queries, Query.cursorAfter(cursor), Query.limit(100)] : [...queries, Query.limit(100)],
    });
    total += page.rows.length;
    if (page.rows.length < 100) return total;
    cursor = page.rows[page.rows.length - 1].$id;
  }
}

async function readAll(tableId, queries = []) {
  const rows = [];
  let cursor = null;
  for (;;) {
    const page = await tables.listRows({
      databaseId: database,
      tableId,
      queries: cursor ? [...queries, Query.cursorAfter(cursor), Query.limit(100)] : [...queries, Query.limit(100)],
    });
    rows.push(...page.rows);
    if (page.rows.length < 100) return rows;
    cursor = page.rows[page.rows.length - 1].$id;
  }
}

/*
 * Targets come from the Phase 5.1 brief. They are asserted, not described: a
 * density file that lists numbers without saying which of them was required is
 * not evidence of anything.
 */
const TARGETS = {
  student_social_profiles: 24,
  community_posts: 40,
  post_comments: 80,
  post_reactions: 120,
  saved_posts: 40,
  place_saves: 60,
  follows: 20,
  place_contributions: 20,
  post_media: 20,
};

const tablesToCount = Object.keys(TARGETS);
const counts = {};
for (const tableId of tablesToCount) {
  counts[tableId] = await countRows(tableId);
}

/* ------------------------- corridor balance ------------------------- */

const posts = await readAll("community_posts", [Query.select(["post_id", "country_code", "university_id", "is_demo_seed", "verification", "media_count", "place_id", "topics", "journey_stage"])]);
const byCountry = {};
const byUniversity = {};
const byType = {};
for (const post of posts) {
  byCountry[post.country_code] = (byCountry[post.country_code] ?? 0) + 1;
  byUniversity[post.university_id] = (byUniversity[post.university_id] ?? 0) + 1;
  byType[post.post_type] = (byType[post.post_type] ?? 0) + 1;
}

/*
 * "Balanced" is a claim about the two golden corridors, so it is measured on the
 * corridors themselves rather than on the country totals — a corpus with forty
 * Thai posts and one Singaporean one would otherwise look balanced.
 */
const sgPosts = posts.filter((post) => post.country_code === "SG").length;
const vnPosts = posts.filter((post) => post.country_code === "VN").length;
const balanceRatio = Math.max(sgPosts, vnPosts) === 0 ? 0 : Number((Math.min(sgPosts, vnPosts) / Math.max(sgPosts, vnPosts)).toFixed(3));

/* --------------------------- honesty checks --------------------------- */

const FORBIDDEN_VERIFICATION = ["verified_student", "real_user", "partner_student"];
const violations = posts
  .filter((post) => FORBIDDEN_VERIFICATION.includes(String(post.verification ?? "")))
  .map((post) => post.post_id);

const unmarked = posts.filter((post) => Number(post.is_demo_seed) !== 1 && String(post.seed_origin ?? "") === "demo").map((post) => post.post_id);

const profiles = await readAll("student_social_profiles", [Query.select(["user_id", "is_demo_seed", "verification", "home_country_code", "host_country_code", "university_id", "live_location_shared"])]);
const profilesSharingLocation = profiles.filter((profile) => Number(profile.live_location_shared) === 1).map((profile) => profile.user_id);

/* ------------------------- media provenance ------------------------- */

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const REQUIRED_PROVENANCE = ["source_provider", "source_page", "author", "license", "license_url", "retrieved_at"];
const provenanceGaps = manifest.assets
  .map((asset) => ({ id: asset.id, missing: REQUIRED_PROVENANCE.filter((field) => !asset[field]) }))
  .filter((entry) => entry.missing.length > 0);
const notDemoMarked = manifest.assets.filter((asset) => asset.is_demo_seed !== true).map((asset) => asset.id);

/* ------------------------------ verdict ------------------------------ */

const shortfalls = Object.entries(TARGETS)
  .filter(([tableId, target]) => counts[tableId] < target)
  .map(([tableId, target]) => ({ table: tableId, required: target, actual: counts[tableId] }));

const evidence = {
  generated_at: new Date().toISOString(),
  measured_from: "live Appwrite tables read through the admin API (independent of the seed report)",
  targets: TARGETS,
  counts,
  shortfalls,
  density_met: shortfalls.length === 0,
  corridors: {
    sg_posts: sgPosts,
    vn_posts: vnPosts,
    balance_ratio: balanceRatio,
    balanced: balanceRatio >= 0.6,
    by_country: byCountry,
    by_university: byUniversity,
    by_type: byType,
  },
  honesty: {
    synthetic_posts: posts.filter((post) => Number(post.is_demo_seed) === 1).length,
    posts_claiming_verified_or_real: violations,
    demo_posts_missing_the_demo_marker: unmarked,
    profiles_sharing_live_location: profilesSharingLocation,
    distinct_profiles: new Set(profiles.map((profile) => profile.user_id)).size,
  },
  media: {
    assets: manifest.assets.length,
    media_rows: counts.post_media,
    assets_missing_provenance: provenanceGaps,
    assets_not_marked_demo: notDemoMarked,
    providers: [...new Set(manifest.assets.map((asset) => asset.source_provider))],
    licenses: [...new Set(manifest.assets.map((asset) => asset.license))],
  },
};

try {
  evidence.seed_report = JSON.parse(readFileSync(SEED_REPORT, "utf8")).counts;
} catch {
  evidence.seed_report = null;
}

mkdirSync("docs/evidence/phase5-rc", { recursive: true });
writeFileSync(OUT, JSON.stringify(evidence, null, 2));

console.log("== counts vs targets");
for (const [tableId, target] of Object.entries(TARGETS)) {
  const actual = counts[tableId];
  console.log(`  ${(actual >= target ? "ok  " : "SHORT")} ${tableId.padEnd(26)} ${String(actual).padStart(5)} / ${target}`);
}
console.log(`\ncorridors: SG ${sgPosts} posts, VN ${vnPosts} posts, balance ${balanceRatio}`);
console.log(`honesty: ${evidence.honesty.synthetic_posts} synthetic posts, ${violations.length} false-verified, ${unmarked.length} unmarked`);
console.log(`media: ${manifest.assets.length} assets, ${provenanceGaps.length} with provenance gaps, ${notDemoMarked.length} not marked demo`);
console.log(`\nevidence -> ${OUT}`);

process.exitCode = evidence.density_met && violations.length === 0 && provenanceGaps.length === 0 && evidence.corridors.balanced ? 0 : 1;
