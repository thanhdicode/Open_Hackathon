/**
 * Reset derived Greenbook data: every fact and its verification events.
 *
 * This exists because fact identity was corrected on 2026-09-16. Row ids were
 * previously derived from the model's paraphrase of a claim, so re-running
 * extraction over an unchanged page stored the same requirement twice under two
 * wordings — 29 rows holding 17 real rules. Identity is now anchored on the
 * verbatim evidence quote, which does not retroactively re-key existing rows,
 * so the polluted set has to be cleared once.
 *
 * Deliberately narrow. It clears FACTS and their EVENTS only:
 *   - `knowledge_sources` and `source_snapshots` are the provenance record and
 *     are kept, so the archive still shows what was read and when.
 *   - user-owned tables are never touched.
 *
 * Destructive, so it refuses to run without `--yes`.
 *
 * Usage:
 *   node scripts/greenbook/reset-facts.mjs            # report only
 *   node scripts/greenbook/reset-facts.mjs --yes      # delete
 */
import { readFileSync } from "node:fs";
import { Query } from "node-appwrite";
import { createAdminClient } from "./persist.mjs";

function loadEnv() {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !process.env[key]) process.env[key] = value;
  }
}

/** Appwrite pages at 25 rows by default; read every row before deleting any. */
async function readAll(admin, tableId) {
  const { tables, databaseId } = admin;
  const rows = [];
  for (let offset = 0; ; offset += 100) {
    const page = await tables.listRows({ databaseId, tableId, queries: [Query.limit(100), Query.offset(offset)] });
    rows.push(...page.rows);
    if (rows.length >= page.total || page.rows.length === 0) break;
  }
  return rows;
}

async function main() {
  loadEnv();
  const confirmed = process.argv.includes("--yes");
  const orphanMode = process.argv.includes("--orphans");
  const admin = createAdminClient();
  const { tables, databaseId } = admin;

  const facts = await readAll(admin, "knowledge_facts");
  const events = await readAll(admin, "verification_events");

  /*
   * `--orphans` is the targeted mode, and it exists because of a measured
   * failure. Removing a source from the registry (as happened to
   * `id-immigration-candidate`, a homepage whose only output was press releases)
   * leaves its facts behind, pointing at a source_id that no longer resolves.
   * `verify-facts.mjs` correctly reports those as violations — a fact whose
   * provenance cannot be checked is not a fact.
   *
   * A full wipe would fix it and destroy 212 good rows with it. This deletes
   * only the rows that are already broken.
   */
  const { loadRegistry } = await import("./registry.mjs");
  const knownSourceIds = new Set(loadRegistry().sources.map((source) => source.id));
  const orphans = facts.filter((fact) => !knownSourceIds.has(fact.source_id));
  const orphanIds = new Set(orphans.map((fact) => fact.fact_id));

  if (orphanMode) {
    console.log(`knowledge_facts:       ${facts.length} row(s), ${orphans.length} orphaned`);
    console.log(`verification_events:   ${events.length} row(s)`);
    const orphanEvents = events.filter((event) => orphanIds.has(event.fact_id));
    console.log(`                       ${orphanEvents.length} event(s) belong to an orphaned fact`);

    const bySource = {};
    for (const fact of orphans) bySource[fact.source_id] = (bySource[fact.source_id] ?? 0) + 1;
    for (const [sourceId, count] of Object.entries(bySource)) {
      console.log(`  ${sourceId}: ${count} fact(s) — not in the registry`);
    }

    if (!confirmed) {
      console.log("\nreport only — nothing deleted. Re-run with --orphans --yes to clear these rows.");
      return;
    }

    let deletedFacts = 0;
    for (const row of orphans) {
      await tables.deleteRow({ databaseId, tableId: "knowledge_facts", rowId: row.$id });
      deletedFacts += 1;
    }
    let deletedEvents = 0;
    for (const row of orphanEvents) {
      await tables.deleteRow({ databaseId, tableId: "verification_events", rowId: row.$id });
      deletedEvents += 1;
    }
    console.log(`\ndeleted ${deletedFacts} orphaned fact(s) and ${deletedEvents} event(s)`);
    console.log("kept: every fact whose source is still registered");
    return;
  }

  console.log(`knowledge_facts:       ${facts.length} row(s)`);
  console.log(`verification_events:   ${events.length} row(s)`);

  if (!confirmed) {
    console.log("\nreport only — nothing deleted. Re-run with --yes to clear these rows.");
    console.log("kept: knowledge_sources, source_snapshots (provenance is not derived data)");
    console.log("tip: use --orphans to remove only facts whose source left the registry.");
    return;
  }

  let deletedFacts = 0;
  for (const row of facts) {
    await tables.deleteRow({ databaseId, tableId: "knowledge_facts", rowId: row.$id });
    deletedFacts += 1;
  }

  let deletedEvents = 0;
  for (const row of events) {
    await tables.deleteRow({ databaseId, tableId: "verification_events", rowId: row.$id });
    deletedEvents += 1;
  }

  console.log(`\ndeleted ${deletedFacts} fact(s) and ${deletedEvents} event(s)`);
  console.log("provenance kept: knowledge_sources and source_snapshots are untouched");
}

main().catch((error) => {
  console.error("reset failed:", error.message);
  process.exitCode = 1;
});
