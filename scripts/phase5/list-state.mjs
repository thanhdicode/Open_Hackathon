/** List personal-state rows to find leftovers and conflicts. */
import { Client, Query, TablesDB } from "node-appwrite";

const tables = new TablesDB(
  new Client()
    .setEndpoint(process.env.VITE_APPWRITE_ENDPOINT)
    .setProject(process.env.VITE_APPWRITE_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY),
);
const databaseId = process.env.VITE_APPWRITE_DATABASE_ID;

for (const tableId of ["saved_posts", "place_saves", "post_reactions"]) {
  const page = await tables.listRows({ databaseId, tableId, queries: [Query.limit(200)] });
  console.log(`\n${tableId}: total=${page.total}`);
  for (const row of page.rows.slice(0, 10)) {
    console.log(`   ${row.$id}  post=${row.post_id ?? "-"}  place=${row.place_id ?? "-"}  user=${row.user_id}`);
  }
  if (page.total > 10) console.log(`   … ${page.total - 10} more`);
}
