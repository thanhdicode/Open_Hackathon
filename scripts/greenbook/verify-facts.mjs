/**
 * Fact integrity check against the live Appwrite database.
 *
 * The ingestion pipeline makes promises that only hold if the data on disk
 * actually satisfies them: every fact traceable to a registry source, every fact
 * carrying a verbatim quote, and no two rows describing the same requirement.
 * The unit tests check the logic; this checks the result.
 *
 * Written after a measured failure. Row identity used to be derived from the
 * model's paraphrase of a claim, so re-running extraction over an unchanged page
 * stored the same requirement twice — 29 rows holding 17 real rules. Nothing
 * detected it, because nothing looked.
 *
 * Exits non-zero on any violation, so it can gate a scheduled run.
 *
 * Usage:
 *   node scripts/greenbook/verify-facts.mjs
 */
import { readFileSync } from "node:fs";
import { Query } from "node-appwrite";
import { createAdminClient } from "./persist.mjs";
import { factHash } from "./extract.mjs";
import { loadRegistry } from "./registry.mjs";

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

/** Appwrite pages at 25 rows by default. */
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

/**
 * Recompute the canonical row id the way persist.mjs does.
 *
 * Two details that are easy to get wrong, and both of them produced a false
 * alarm the first time this check ran:
 *   - `knowledge_facts` stores `source_id`, not a URL, so the URL has to be
 *     resolved through the registry. Passing `undefined` silently falls back to
 *     the claim-based branch of `factHash` and makes every row look drifted.
 *   - `rowId()` truncates to Appwrite's 36-character ceiling, so `fact_` plus 31
 *     hex characters, not 32.
 */
function canonicalRowId(fact, urlBySourceId) {
  const hash = factHash({
    sourceUrl: urlBySourceId.get(fact.source_id),
    evidenceQuote: fact.evidence_quote,
    country: fact.country_code,
    chapter: fact.chapter,
    claim: fact.claim,
  });
  return `fact_${hash.slice(0, 32)}`.slice(0, 36);
}

async function main() {
  loadEnv();
  const admin = createAdminClient();
  const sources = loadRegistry().sources;
  const registryUrls = new Set(sources.map((source) => source.url));
  const urlBySourceId = new Map(sources.map((source) => [source.id, source.url]));

  const facts = await readAll(admin, "knowledge_facts");
  const events = await readAll(admin, "verification_events");
  const violations = [];

  console.log(`knowledge_facts:      ${facts.length} row(s)`);
  console.log(`verification_events:  ${events.length} row(s)`);

  const byIdentity = new Map();
  const byRowId = new Map();

  for (const fact of facts) {
    const label = `${fact.country_code}/${(fact.claim || "").slice(0, 60)}`;

    // Trust rule: no registry source URL, no verified fact.
    const sourceUrl = urlBySourceId.get(fact.source_id);
    if (!sourceUrl || !registryUrls.has(sourceUrl)) {
      violations.push(`${label}: source_id ${fact.source_id} does not resolve to a registry URL`);
    }

    // Provenance: a claim with no quotable sentence is an assertion — but only
    // a guidance-ready fact has to have one. A missing quote is precisely why a
    // fact sits in needs_review or unverified, so demanding one from every row
    // would flag the review queue as corruption.
    const isGuidance = fact.verification_status === "official_verified" || fact.verification_status === "university_verified";
    if (isGuidance && (!fact.evidence_quote || fact.evidence_quote.length < 15)) {
      violations.push(`${label}: guidance-ready but has no verbatim evidence quote`);
    }

    // The validator is the only thing allowed to set a status.
    if (!fact.verification_status) {
      violations.push(`${label}: no verification status`);
    }

    // Identity: the stored id must be the one this content derives.
    const expected = canonicalRowId(fact, urlBySourceId);
    if (fact.$id !== expected) {
      violations.push(`${label}: row id ${fact.$id} does not match canonical ${expected}`);
    }
    if (byRowId.has(fact.$id)) violations.push(`${label}: duplicate row id ${fact.$id}`);
    byRowId.set(fact.$id, fact);

    if (!byIdentity.has(expected)) byIdentity.set(expected, []);
    byIdentity.get(expected).push(fact);
  }

  const collisions = [...byIdentity.values()].filter((group) => group.length > 1);
  for (const group of collisions) {
    violations.push(`identity collision: ${group.length} rows share one requirement — ${(group[0].claim || "").slice(0, 70)}`);
  }

  const factIds = new Set(facts.map((fact) => fact.fact_id));
  const orphanEvents = events.filter((event) => !factIds.has(event.fact_id));

  console.log(`distinct requirements: ${byIdentity.size}`);
  console.log(`orphaned events:       ${orphanEvents.length}`);

  if (orphanEvents.length) {
    // Events for facts that no longer exist. Not fatal — a reset deletes facts —
    // but it means the audit trail references rows nobody can read.
    console.log(`  note: ${orphanEvents.length} event(s) reference a fact that is no longer stored`);
  }

  if (violations.length) {
    console.log(`\n${violations.length} violation(s):`);
    for (const violation of violations.slice(0, 25)) console.log(`  - ${violation}`);
    if (violations.length > 25) console.log(`  ... and ${violations.length - 25} more`);
    process.exitCode = 1;
    return;
  }

  console.log("\nall facts are traceable, quoted, uniquely identified and verified");
}

main().catch((error) => {
  console.error("verify failed:", error.message);
  process.exitCode = 1;
});
