/**
 * Greenbook data-coverage matrix.
 *
 * The ingestion pipeline reports what it did on one run. It cannot answer the
 * question the demo actually depends on: for each country, how much *usable*
 * guidance exists right now, and where is the gap?
 *
 * This joins three sources of truth that never meet anywhere else:
 *   - config/source-registry.yaml      what we intend to cover
 *   - docs/evidence/phase4/source-liveness.json   what the network actually allows
 *   - the live Appwrite tables         what survived validation and got stored
 *
 * The distinction that matters is `sources_productive`: a source is registered
 * and reachable, but it is only productive if it produced at least one stored
 * fact. Twenty reachable homepages with zero facts is a worse position than
 * three reachable guides with forty facts, and only this report shows that.
 *
 * Empty chapters are reported, never hidden. A country with 0 facts in
 * `immigration` is the single most important line in this report, because
 * immigration is the chapter the demo opens on.
 *
 * Usage:
 *   node scripts/greenbook/coverage.mjs              # table to stdout
 *   node scripts/greenbook/coverage.mjs --json       # machine-readable only
 *   node scripts/greenbook/coverage.mjs --write      # also write evidence JSON
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { Query } from "node-appwrite";
import { createAdminClient } from "./persist.mjs";
import { loadRegistry } from "./registry.mjs";

const LIVENESS_PATH = "docs/evidence/phase4/source-liveness.json";
const OUTPUT_PATH = "docs/evidence/phase4/coverage-matrix.json";

/** Demo priority order. Mirrors config/source-registry.yaml coverage tiers. */
const TIERS = {
  0: ["MY", "SG", "ID"],
  1: ["TH", "PH", "VN"],
  2: ["BN", "KH", "LA", "MM", "TL"],
};

/** Registry "countries" that are not countries. Kept separate so the matrix
 *  does not report a phantom nation called ALL. */
const NON_COUNTRY = new Set(["ALL", "ASEAN", "GLOBAL"]);

const ALL_ASEAN = ["BN", "KH", "ID", "LA", "MM", "MY", "PH", "SG", "TH", "TL", "VN"];

/**
 * The chapters a country must eventually have content in to be demoable.
 *
 * Imported conceptually from scripts/greenbook/extract.mjs CHAPTERS — that list
 * is the authority, because it is the enum the extraction contract restricts the
 * model to. Any chapter named here that is not in that list can never be
 * populated, and would show up as permanently empty.
 */
const CORE_CHAPTERS = [
  "get_ready",
  "land_and_settle",
  "study_here",
  "speak_and_understand",
  "money_and_pay",
  "live_here",
  "move_around",
  "stay_safe_and_healthy",
  "culture_and_people",
  "student_reality",
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

/** Appwrite caps a page at 100 rows here; walk the whole table. */
async function readAll(admin, tableId) {
  const { tables, databaseId } = admin;
  const rows = [];
  for (let offset = 0; ; offset += 100) {
    let page;
    try {
      page = await tables.listRows({ databaseId, tableId, queries: [Query.limit(100), Query.offset(offset)] });
    } catch (error) {
      // A table that does not exist yet is a real gap, not a crash.
      if (error?.code === 404) return { rows: [], missing: true };
      throw error;
    }
    rows.push(...page.rows);
    if (rows.length >= page.total || page.rows.length === 0) break;
  }
  return { rows, missing: false };
}

function emptyCell() {
  return {
    sources_total: 0,
    sources_reachable: 0,
    sources_productive: 0,
    sources_blocked: [],
    facts_total: 0,
    facts_verified: 0,
    facts_review: 0,
    facts_rejected: 0,
    facts_by_status: {},
    facts_by_chapter: {},
    empty_core_chapters: [],
    tasks: 0,
    phrases: 0,
    media: 0,
    universities: 0,
    entries: 0,
    chapters_with_content: 0,
  };
}

function loadLiveness() {
  if (!existsSync(LIVENESS_PATH)) return { reachable: new Set(), blocked: new Map(), generatedAt: null };
  const evidence = JSON.parse(readFileSync(LIVENESS_PATH, "utf8"));
  const reachable = new Set();
  const blocked = new Map();
  for (const entry of evidence.results ?? []) {
    if (entry.ok) reachable.add(entry.id);
    else blocked.set(entry.id, entry.status ?? entry.error ?? "unknown");
  }
  return { reachable, blocked, generatedAt: evidence.generatedAt ?? null };
}

function tally(rows, keyFn) {
  const out = {};
  for (const row of rows) {
    const key = keyFn(row) ?? "(unset)";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

async function main() {
  loadEnv();
  const registry = loadRegistry();
  const liveness = loadLiveness();

  let admin = null;
  let appwriteError = null;
  try {
    admin = createAdminClient();
  } catch (error) {
    appwriteError = error.message;
  }

  const matrix = {};
  for (const code of ALL_ASEAN) matrix[code] = emptyCell();

  // ---- registry ---------------------------------------------------------
  for (const source of registry.sources ?? []) {
    const code = source.country;
    if (NON_COUNTRY.has(code)) continue;
    if (!matrix[code]) matrix[code] = emptyCell();
    matrix[code].sources_total += 1;
    if (liveness.reachable.has(source.id)) matrix[code].sources_reachable += 1;
    else if (liveness.blocked.has(source.id)) matrix[code].sources_blocked.push({ id: source.id, reason: liveness.blocked.get(source.id) });
  }

  if (admin) {
    const [facts, tasks, phrases, media, universities, entries] = await Promise.all([
      readAll(admin, "knowledge_facts"),
      readAll(admin, "greenbook_tasks"),
      readAll(admin, "student_phrases"),
      readAll(admin, "media_resources"),
      readAll(admin, "universities"),
      readAll(admin, "greenbook_entries"),
    ]);

    const productiveByCountry = {};

    for (const fact of facts.rows) {
      const code = fact.country_code;
      if (!matrix[code]) continue;
      const cell = matrix[code];
      cell.facts_total += 1;
      cell.facts_by_status[fact.verification_status] = (cell.facts_by_status[fact.verification_status] ?? 0) + 1;
      const chapter = fact.chapter ?? "(unset)";
      cell.facts_by_chapter[chapter] = (cell.facts_by_chapter[chapter] ?? 0) + 1;

      if (["official_verified", "university_verified", "community_verified"].includes(fact.verification_status)) cell.facts_verified += 1;
      else if (["needs_review", "conflict", "stale"].includes(fact.verification_status)) cell.facts_review += 1;
      else cell.facts_rejected += 1;

      productiveByCountry[code] ??= new Set();
      if (fact.source_id) productiveByCountry[code].add(fact.source_id);
    }

    for (const code of ALL_ASEAN) {
      matrix[code].sources_productive = productiveByCountry[code]?.size ?? 0;
      const present = Object.keys(matrix[code].facts_by_chapter);
      matrix[code].empty_core_chapters = CORE_CHAPTERS.filter((chapter) => !present.includes(chapter));
    }

    for (const row of tasks.rows) if (matrix[row.country_code]) matrix[row.country_code].tasks += 1;
    for (const row of phrases.rows) if (matrix[row.country_code]) matrix[row.country_code].phrases += 1;
    for (const row of media.rows) if (matrix[row.country_code]) matrix[row.country_code].media += 1;
    for (const row of universities.rows) {
      const code = row.country_code ?? row.country;
      if (matrix[code]) matrix[code].universities += 1;
    }
    for (const row of entries.rows) {
      if (matrix[row.country_code]) {
        matrix[row.country_code].entries += 1;
        matrix[row.country_code].chapters_with_content = Object.keys(tally(entries.rows.filter((e) => e.country_code === row.country_code), (e) => e.chapter_id)).length;
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    registryVersion: registry.version,
    livenessGeneratedAt: liveness.generatedAt,
    appwriteError,
    tiers: Object.fromEntries(Object.entries(TIERS).map(([tier, codes]) => [tier, codes])),
    matrix,
    totals: {
      sources_total: Object.values(matrix).reduce((sum, cell) => sum + cell.sources_total, 0),
      sources_reachable: Object.values(matrix).reduce((sum, cell) => sum + cell.sources_reachable, 0),
      sources_productive: Object.values(matrix).reduce((sum, cell) => sum + cell.sources_productive, 0),
      facts_total: Object.values(matrix).reduce((sum, cell) => sum + cell.facts_total, 0),
      facts_verified: Object.values(matrix).reduce((sum, cell) => sum + cell.facts_verified, 0),
      tasks: Object.values(matrix).reduce((sum, cell) => sum + cell.tasks, 0),
      phrases: Object.values(matrix).reduce((sum, cell) => sum + cell.phrases, 0),
      media: Object.values(matrix).reduce((sum, cell) => sum + cell.media, 0),
      universities: Object.values(matrix).reduce((sum, cell) => sum + cell.universities, 0),
      entries: Object.values(matrix).reduce((sum, cell) => sum + cell.entries, 0),
    },
  };

  if (process.argv.includes("--write")) {
    mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
    writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2));
  }

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Greenbook coverage — registry v${report.registryVersion}, liveness ${liveness.generatedAt ?? "n/a"}`);
    if (appwriteError) console.log(`  (Appwrite unavailable: ${appwriteError} — registry-only view)`);
    console.log("");
    console.log("      country  tier  src  reach  prod  facts  ver  rev  tasks  phr  media  uni  ent  empty chapters");
    for (const [tier, codes] of Object.entries(TIERS)) {
      for (const code of codes) {
        const cell = matrix[code];
        console.log(
          `  ${code.padEnd(11)}  T${tier}  ${String(cell.sources_total).padStart(3)}  ${String(cell.sources_reachable).padStart(5)}  ${String(cell.sources_productive).padStart(4)}  ${String(cell.facts_total).padStart(5)}  ${String(cell.facts_verified).padStart(3)}  ${String(cell.facts_review).padStart(3)}  ${String(cell.tasks).padStart(5)}  ${String(cell.phrases).padStart(3)}  ${String(cell.media).padStart(5)}  ${String(cell.universities).padStart(3)}  ${String(cell.entries).padStart(3)}  ${cell.empty_core_chapters.length ? cell.empty_core_chapters.join(",") : "-"}`,
        );
      }
    }
    console.log("");
    const t = report.totals;
    console.log(`totals: ${t.sources_total} sources (${t.sources_reachable} reachable, ${t.sources_productive} productive) · ${t.facts_total} facts (${t.facts_verified} verified) · ${t.tasks} tasks · ${t.phrases} phrases · ${t.media} media · ${t.universities} universities · ${t.entries} entries`);
  }

  if (process.argv.includes("--write")) console.log(`\nwrote ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error("coverage failed:", error.message);
  process.exitCode = 1;
});
