/**
 * What page size will Appwrite actually return for `places`?
 *
 * The map needs a whole country's places, and the client's load strategy depends
 * entirely on this number. Guessing it wrong means either 30 round-trips per
 * country or a silent truncation that hides pins.
 *
 *   node --env-file=.env.local scripts/explore/probe-page-size.mjs
 */
import { Client, Query, TablesDB } from "node-appwrite";

const client = new Client()
  .setEndpoint(process.env.VITE_APPWRITE_ENDPOINT)
  .setProject(process.env.VITE_APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_KEY);
const databaseId = process.env.VITE_APPWRITE_DATABASE_ID;
const tables = new TablesDB(client);

const country = process.argv[2] ?? "TH";

for (const limit of [100, 500, 1000, 2000, 5000]) {
  const started = Date.now();
  try {
    const page = await tables.listRows({
      databaseId,
      tableId: "places",
      queries: [Query.equal("country_code", country), Query.limit(limit)],
    });
    console.log(`limit=${limit} -> returned ${page.rows.length} of total ${page.total} in ${Date.now() - started}ms`);
  } catch (error) {
    console.log(`limit=${limit} -> ERROR ${error.code} ${error.message}`);
  }
}
