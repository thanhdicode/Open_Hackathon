/**
 * Publish the Greenbook knowledge corpus to the browser client.
 *
 * WHY THIS EXISTS
 *
 * The Greenbook tables are declared `access: "server"` in scripts/appwrite/schema.mjs,
 * and `tablePermissions()` grants a server table NO table-level permissions at all
 * (`permissions: []`) while leaving `rowSecurity: true`. That is deliberate: the
 * ingestion worker writes with an API key, and nothing is readable by default.
 *
 * The consequence, measured 2026-09-16, is that a browser client cannot read a
 * single fact — a guest `listRows` on `knowledge_facts` is refused. The UI has
 * nothing to render.
 *
 * Because `rowSecurity` is true, access is decided per ROW. So the fix is not to
 * loosen the table; it is to stamp an explicit read permission on exactly the
 * rows that are allowed to be public. That keeps the brief's rule intact:
 *
 *   - published knowledge  -> readable by anyone (it is non-personal public info)
 *   - candidate / review / conflict / rejected / unverified -> NOT public
 *   - a student's own progress -> owner-scoped, never touched here
 *
 * `Role.any()` rather than `Role.users()` on purpose: the app bootstraps an
 * anonymous session, but a session failure must not blank the Greenbook. The
 * published corpus contains no personal data, so it is safe to serve to a guest.
 *
 * This is idempotent — re-running rewrites the same permission set.
 *
 * Usage:
 *   node scripts/greenbook/publish.mjs            # apply
 *   node scripts/greenbook/publish.mjs --dry-run  # report only
 *   node scripts/greenbook/publish.mjs --verify   # assert client readability
 */
import { readFileSync, existsSync } from "node:fs";
import { Client, Permission, Query, Role, TablesDB } from "node-appwrite";

/** Fact statuses that may be shown to a student. Mirrors validate.mjs. */
const PUBLISHED_FACT_STATUSES = ["official_verified", "university_verified", "community_verified", "stale"];

/**
 * Client-facing Greenbook tables and the rule that decides which of their rows
 * become public. A `null` filter means "every row in this table is public" —
 * true only for the curated reference tables, which never hold personal data.
 */
const PUBLISH_TARGETS = [
  { tableId: "knowledge_facts", filter: (row) => PUBLISHED_FACT_STATUSES.includes(row.verification_status), label: "published facts" },
  { tableId: "knowledge_sources", filter: () => true, label: "sources" },
  { tableId: "greenbook_countries", filter: () => true, label: "countries" },
  { tableId: "greenbook_chapters", filter: () => true, label: "chapters" },
  { tableId: "greenbook_entries", filter: () => true, label: "entries" },
  { tableId: "student_phrases", filter: () => true, label: "phrases" },
  { tableId: "media_resources", filter: () => true, label: "media" },
  { tableId: "greenbook_tasks", filter: () => true, label: "tasks" },
  { tableId: "universities", filter: () => true, label: "universities" },
];

function loadEnv() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !process.env[key]) process.env[key] = value;
  }
}

function admin() {
  const endpoint = process.env.VITE_APPWRITE_ENDPOINT;
  const projectId = process.env.VITE_APPWRITE_PROJECT_ID;
  const apiKey = process.env.APPWRITE_API_KEY;
  if (!endpoint || !projectId || !apiKey) throw new Error("Appwrite admin credentials are not configured");
  const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
  return { tables: new TablesDB(client), databaseId: process.env.VITE_APPWRITE_DATABASE_ID };
}

async function readAll(tables, databaseId, tableId) {
  const rows = [];
  for (let offset = 0; ; offset += 100) {
    let page;
    try {
      page = await tables.listRows({ databaseId, tableId, queries: [Query.limit(100), Query.offset(offset)] });
    } catch (error) {
      if (error?.code === 404) return [];
      throw error;
    }
    rows.push(...page.rows);
    if (rows.length >= page.total || page.rows.length === 0) break;
  }
  return rows;
}

/** True when the row already carries a read grant for everyone. */
function isPublic(row) {
  return (row.$permissions ?? []).some((permission) => /^read\("any"\)$/.test(permission));
}

async function main() {
  loadEnv();
  const dryRun = process.argv.includes("--dry-run");
  const { tables, databaseId } = admin();

  const summary = [];

  for (const target of PUBLISH_TARGETS) {
    const rows = await readAll(tables, databaseId, target.tableId);
    const eligible = rows.filter(target.filter);
    const needGrant = eligible.filter((row) => !isPublic(row));

    if (!dryRun) {
      for (const row of needGrant) {
        // Permissions only — the row's data is deliberately untouched, so a
        // publish run can never alter what a fact says.
        await tables.updateRow({
          databaseId,
          tableId: target.tableId,
          rowId: row.$id,
          permissions: [Permission.read(Role.any())],
        });
      }
    }

    summary.push({ table: target.tableId, label: target.label, total: rows.length, eligible: eligible.length, granted: needGrant.length, withheld: rows.length - eligible.length });
  }

  console.log(dryRun ? "DRY RUN — no permissions written\n" : "publishing published knowledge to the browser client\n");
  for (const entry of summary) {
    const withheld = entry.withheld ? `, ${entry.withheld} withheld` : "";
    console.log(`  ${entry.table.padEnd(22)} ${String(entry.eligible).padStart(4)}/${String(entry.total).padEnd(4)} public${withheld}  (${entry.granted} newly granted)`);
  }
  const totalPublic = summary.reduce((sum, entry) => sum + entry.eligible, 0);
  const totalRows = summary.reduce((sum, entry) => sum + entry.total, 0);
  console.log(`\n  ${totalPublic}/${totalRows} rows are client-readable`);

  if (process.argv.includes("--verify")) {
    console.log("\nverifying with a session-less client (the strictest case)…");
    const { Client: WebClient, TablesDB: WebTables } = await import("appwrite");
    const web = new WebTables(new WebClient().setEndpoint(process.env.VITE_APPWRITE_ENDPOINT).setProject(process.env.VITE_APPWRITE_PROJECT_ID));
    let failures = 0;
    for (const target of PUBLISH_TARGETS) {
      try {
        const result = await web.listRows({ databaseId, tableId: target.tableId, queries: [Query.limit(1)] });
        const expected = summary.find((entry) => entry.table === target.tableId);
        const ok = expected.eligible === 0 ? result.total === 0 : result.total > 0;
        console.log(`  ${ok ? "OK  " : "FAIL"} ${target.tableId.padEnd(22)} client sees ${result.total} row(s)`);
        if (!ok) failures += 1;
      } catch (error) {
        console.log(`  FAIL ${target.tableId.padEnd(22)} refused: ${error.code} ${error.message}`);
        failures += 1;
      }
    }
    if (failures) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("publish failed:", error.message);
  process.exitCode = 1;
});
