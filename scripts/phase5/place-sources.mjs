/**
 * Exact composition of the `places` table.
 *
 * `listRows().total` cannot be trusted here: a single page of 5000 reported
 * `total: 5000` for a table that holds more, so the count is capped by the page
 * size. Counting is therefore done by paging through with a cursor. The per-country
 * totals also answer the question the map actually depends on — whether any single
 * country exceeds what one request can return.
 */
import { Client, Query, TablesDB } from "node-appwrite";

const tables = new TablesDB(
  new Client()
    .setEndpoint(process.env.VITE_APPWRITE_ENDPOINT)
    .setProject(process.env.VITE_APPWRITE_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY),
);
const databaseId = process.env.VITE_APPWRITE_DATABASE_ID;

async function countAll(extraQueries = []) {
  const rows = [];
  let cursor = null;
  for (;;) {
    const queries = [Query.orderAsc("place_id"), Query.limit(1000), ...extraQueries];
    if (cursor) queries.push(Query.cursorAfter(cursor));
    const page = await tables.listRows({ databaseId, tableId: "places", queries });
    rows.push(...page.rows);
    if (page.rows.length < 1000) break;
    cursor = page.rows[page.rows.length - 1].place_id;
  }
  return rows;
}

const all = await countAll();
console.log(`total places: ${all.length}`);

const bySource = {};
const byCountry = {};
let curated = 0;
for (const row of all) {
  const source = row.source || "(none)";
  bySource[source] = (bySource[source] ?? 0) + 1;
  byCountry[row.country_code] = (byCountry[row.country_code] ?? 0) + 1;
  if (row.is_demo_seed) curated += 1;
}
console.log("by source:", JSON.stringify(bySource));
console.log("by country:", JSON.stringify(byCountry));
console.log(`rows flagged is_demo_seed: ${curated}`);

const largest = Math.max(...Object.values(byCountry));
console.log(`largest single-country set: ${largest} (one request returns up to 5000)`);
