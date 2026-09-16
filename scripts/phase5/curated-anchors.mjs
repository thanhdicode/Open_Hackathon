/**
 * List the curated anchors actually stored, with coordinates and campus.
 *
 * The seed writes a fixed set of anchors, so the stored count should equal that set.
 * A larger count means rows from an earlier run survived — and an anchor written
 * under an older, looser coordinate match is exactly the "real name on the wrong
 * building" defect that must not reach the map.
 */
import { Client, Query, TablesDB } from "node-appwrite";

const tables = new TablesDB(
  new Client()
    .setEndpoint(process.env.VITE_APPWRITE_ENDPOINT)
    .setProject(process.env.VITE_APPWRITE_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY),
);
const databaseId = process.env.VITE_APPWRITE_DATABASE_ID;

const page = await tables.listRows({
  databaseId,
  tableId: "places",
  queries: [Query.equal("source", "seed_pack_researched"), Query.limit(100)],
});

for (const row of page.rows) {
  const campus = String(row.campus_id || "-").padEnd(13);
  const coords = `${String(row.latitude)},${String(row.longitude)}`;
  console.log(`${String(row.place_id).padEnd(20)} ${campus} ${coords.padStart(24)}  ${row.name}`);
}
console.log(`total curated rows stored: ${page.rows.length}`);
