/**
 * Read-only inspection of the tables Phase 5 touches.
 *
 * Exists because "inspect current DB resources before adding tables" is only a
 * real instruction if there is a cheap way to look. Prints a row count and a
 * truncated sample per table so an operator can see what already exists before
 * deciding whether a new table is warranted.
 *
 *   node --env-file=.env.local scripts/explore/inspect.mjs [tableId ...]
 */
import { Client, Query, TablesDB } from "node-appwrite";

const DEFAULT_TABLES = [
  "universities",
  "places",
  "student_social_profiles",
  "community_posts",
  "post_media",
  "post_comments",
  "place_contributions",
  "user_blocks",
  "reports",
];

const client = new Client()
  .setEndpoint(process.env.VITE_APPWRITE_ENDPOINT)
  .setProject(process.env.VITE_APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_KEY);
const databaseId = process.env.VITE_APPWRITE_DATABASE_ID;
const tables = new TablesDB(client);

const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const tableIds = requested.length ? requested : DEFAULT_TABLES;

for (const tableId of tableIds) {
  try {
    const page = await tables.listRows({ databaseId, tableId, queries: [Query.limit(3)] });
    console.log(`\n== ${tableId}  total=${page.total}`);
    for (const row of page.rows) {
      const { $id, $permissions, ...rest } = row;
      console.log(`   ${$id}`);
      console.log(`     permissions: ${$permissions.length ? $permissions.join(", ") : "(none)"}`);
      console.log(`     ${JSON.stringify(rest).slice(0, 300)}`);
    }
  } catch (error) {
    console.log(`\n== ${tableId}  ERROR ${error.message}`);
  }
}
