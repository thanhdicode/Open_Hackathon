/**
 * Remove the test content the Phase 5.1 browser suites left behind.
 *
 * WHY THIS EXISTS
 *
 * The suites sign in as real students, because a permission mistake is invisible to
 * an admin key — so their posts land in the same corpus the demo reads. A probe post
 * is indistinguishable to the ranker from a real one, and each matches the demo
 * corridor exactly (host country, host university, and a post type the feed
 * rewards). After a few dozen runs the first page of the For You feed is nothing but
 * "Phase 5.1 photo post 1789…" and the seeded content is pushed off it.
 *
 * The earlier teardown deleted the *account* but not its posts, so the accounts are
 * already gone while their content is orphaned. That is why this is driven by the
 * content marker rather than by user record — and why the marker has to be one only
 * these suites write.
 *
 * `destroyProbeAccount` now removes everything a probe wrote, so this is for the
 * backlog. Safe to re-run: it reports before/after counts and deletes only matches.
 *
 * Usage:
 *   node --env-file=.env.local scripts/phase5/purge-probe-data.mjs --dry-run
 *   node --env-file=.env.local scripts/phase5/purge-probe-data.mjs
 */
import { Query } from "node-appwrite";
import { adminClients } from "../verify/lib/probe-session.mjs";

const DRY_RUN = process.argv.includes("--dry-run");
const admin = adminClients();

/**
 * Markers written only by these suites.
 *
 * Deliberately narrow. A loose pattern such as /Phase 5/ would match a real
 * student's post, and the cost of deleting a real contribution is much higher than
 * the cost of leaving a test post behind. `vid debug` / `bridge debug` come from the
 * throwaway probes used while diagnosing the media and place-bridge paths.
 */
const POST_MARKER =
  /^Phase 5\.1 (?:real|photo|video) post \d+ —|^Phase 5\.1 realtime probe \d+|^(?:vid|bridge|feed|seq|sess|react) debug \d+$/;
const COMMENT_MARKER = /^comment probe \d+/;

const TABLES = ["community_posts", "post_media", "post_comments", "post_reactions", "saved_posts", "place_saves", "follows", "place_contributions"];

async function counts() {
  const out = {};
  for (const tableId of TABLES) {
    out[tableId] = await admin.tables
      .listRows({ databaseId: admin.database, tableId, queries: [Query.limit(1)] })
      .then((page) => page.total)
      .catch(() => -1);
  }
  return out;
}

async function allRows(tableId, queries = []) {
  const rows = [];
  let cursor = null;
  for (let page = 0; page < 40; page += 1) {
    const next = [...queries, Query.limit(100)];
    if (cursor) next.push(Query.cursorAfter(cursor));
    const result = await admin.tables.listRows({ databaseId: admin.database, tableId, queries: next });
    rows.push(...result.rows);
    if (result.rows.length < 100) break;
    cursor = result.rows[result.rows.length - 1].$id;
  }
  return rows;
}

const before = await counts();
console.log(`before: ${JSON.stringify(before)}`);

/* --------------------------------- posts ---------------------------------- */

const posts = await allRows("community_posts");
const doomed = posts.filter((row) => POST_MARKER.test(String(row.body ?? "")));
console.log(`\ntest posts found: ${doomed.length}`);
for (const row of doomed.slice(0, 5)) console.log(`  ${row.post_id} | ${String(row.body).slice(0, 56)}`);
if (doomed.length > 5) console.log(`  … and ${doomed.length - 5} more`);

const comments = await allRows("post_comments");
const doomedComments = comments.filter((row) => COMMENT_MARKER.test(String(row.body ?? "")));
console.log(`test comments found: ${doomedComments.length}`);

if (DRY_RUN) {
  console.log("\n--dry-run: nothing deleted");
  process.exit(0);
}

/* -------------------------------- deletion -------------------------------- */

let mediaDeleted = 0;
let filesDeleted = 0;

for (const post of doomed) {
  const media = await admin.tables
    .listRows({ databaseId: admin.database, tableId: "post_media", queries: [Query.equal("post_id", post.post_id), Query.limit(50)] })
    .catch(() => ({ rows: [] }));
  for (const row of media.rows) {
    if (admin.mediaBucket && row.file_id) {
      await admin.storage.deleteFile({ bucketId: admin.mediaBucket, fileId: row.file_id }).catch(() => {});
      filesDeleted += 1;
    }
    await admin.tables.deleteRow({ databaseId: admin.database, tableId: "post_media", rowId: row.$id }).catch(() => {});
    mediaDeleted += 1;
  }

  // Reactions, saves and comments are keyed by post, and their rows are owned by
  // the reactor/saver — an admin key is the only thing that can clear them.
  for (const tableId of ["post_reactions", "saved_posts", "post_comments"]) {
    const dependents = await admin.tables
      .listRows({ databaseId: admin.database, tableId, queries: [Query.equal("post_id", post.post_id), Query.limit(200)] })
      .catch(() => ({ rows: [] }));
    for (const row of dependents.rows) {
      await admin.tables.deleteRow({ databaseId: admin.database, tableId, rowId: row.$id }).catch(() => {});
    }
  }

  await admin.tables.deleteRow({ databaseId: admin.database, tableId: "community_posts", rowId: post.$id }).catch(() => {});
}

for (const comment of doomedComments) {
  await admin.tables.deleteRow({ databaseId: admin.database, tableId: "post_comments", rowId: comment.$id }).catch(() => {});
}

console.log(`\ndeleted ${doomed.length} posts, ${mediaDeleted} media rows, ${filesDeleted} storage files, ${doomedComments.length} comments`);

const after = await counts();
console.log(`after:  ${JSON.stringify(after)}`);
for (const tableId of TABLES) {
  if (before[tableId] !== after[tableId]) console.log(`  ${tableId}: ${before[tableId]} -> ${after[tableId]}`);
}
