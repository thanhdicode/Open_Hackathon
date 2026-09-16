/**
 * Greenbook ingestion runner.
 *
 * source registry → fetch → snapshot → hash → parse → extract → validate → Appwrite
 *
 * Idempotent: an unchanged source is detected by content hash and skipped, and a
 * fact already present by its own hash is not written twice. Re-running this is
 * therefore safe, which matters because it will run on a schedule.
 *
 * Usage:
 *   node scripts/greenbook/ingest.mjs --country MY --limit 2
 *   node scripts/greenbook/ingest.mjs --source my-immigration-student
 *   node scripts/greenbook/ingest.mjs --country MY --dry-run
 *   node scripts/greenbook/ingest.mjs --source my-immigration-student --force
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { loadRegistry } from "./registry.mjs";
import { fetchSource, stripBoilerplate, loadLiveness } from "./fetch.mjs";
import { extractFacts } from "./extract.mjs";
import { validateBatch, summarize, GUIDANCE_STATUSES } from "./validate.mjs";
import { createLocalStore } from "./snapshot-store.mjs";

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

function args() {
  const out = { country: null, source: null, limit: 3, dryRun: false, skipAi: false, force: false };
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--country") out.country = argv[++index];
    else if (argv[index] === "--source") out.source = argv[++index];
    else if (argv[index] === "--limit") out.limit = Number(argv[++index]);
    else if (argv[index] === "--dry-run") out.dryRun = true;
    else if (argv[index] === "--skip-ai") out.skipAi = true;
    else if (argv[index] === "--force") out.force = true;
  }
  return out;
}

async function main() {
  loadEnv();
  const options = args();
  const registry = loadRegistry();
  const liveness = loadLiveness();

  let targets = registry.sources.filter((source) => source.crawl_allowed !== false);
  if (options.source) targets = targets.filter((source) => source.id === options.source);
  else if (options.country) targets = targets.filter((source) => source.country === options.country);

  // Skip hosts measured as unreachable so the run does not stall on them.
  const skipped = targets.filter((source) => liveness.blocked.has(source.id));
  targets = targets.filter((source) => !liveness.blocked.has(source.id)).slice(0, options.limit);

  console.log(`ingest: ${targets.length} source(s)${options.country ? ` for ${options.country}` : ""}${options.dryRun ? " (dry run)" : ""}`);
  if (skipped.length) console.log(`  skipped ${skipped.length} measured-unreachable: ${skipped.map((s) => s.id).join(", ")}`);

  const persist = options.dryRun ? null : await import("./persist.mjs");
  const admin = persist ? persist.createAdminClient() : null;
  const store = createLocalStore();
  const registryUrls = new Set(registry.sources.map((source) => source.url));
  const run = { generatedAt: new Date().toISOString(), dryRun: options.dryRun, sources: [] };

  for (const source of targets) {
    console.log(`\n--- ${source.id} (${source.country}, authority ${source.authority}) ---`);

    const fetched = await fetchSource(source, { store });
    if (!fetched.ok) {
      console.log(`  fetch FAILED: ${fetched.error}`);
      run.sources.push({ sourceId: source.id, stage: "fetch", ok: false, error: fetched.error });
      continue;
    }
    console.log(`  fetched ${fetched.bytes}B  hash=${fetched.contentHash.slice(0, 12)}  snapshot=${fetched.snapshotKey}`);

    /*
     * `--skip-ai` is an explicit "fetch and record only" instruction, so it is
     * answered before the gate below — asking to skip AI and then being told the
     * source was skipped for a different reason would be confusing.
     */
    if (options.skipAi) {
      run.sources.push({ sourceId: source.id, stage: "fetch", ok: true, bytes: fetched.bytes, contentHash: fetched.contentHash });
      continue;
    }

    /*
     * The idempotency gate.
     *
     * Extraction is nondeterministic and expensive; the page hash is neither.
     * If the bytes are unchanged, the facts already derived from them are still
     * current, so re-extracting can only produce paraphrases of rows we already
     * have. `--force` re-runs anyway, which is what you want after changing the
     * extraction prompt or the model ladder.
     */
    if (admin && !options.force) {
      const prior = await persist.getSourceState(admin, source.id);
      if (prior?.contentHash && prior.contentHash === fetched.contentHash) {
        console.log(`  unchanged since ${prior.checkedAt ?? "last run"} — extraction skipped (use --force to re-extract)`);
        run.sources.push({ sourceId: source.id, stage: "unchanged", ok: true, bytes: fetched.bytes, contentHash: fetched.contentHash, snapshotKey: fetched.snapshotKey, skippedReason: "content hash unchanged" });
        continue;
      }
    }

    const text = stripBoilerplate(fetched.text ?? "");
    if (text.length < 400) {
      console.log(`  too little text after parsing (${text.length} chars) — skipped`);
      run.sources.push({ sourceId: source.id, stage: "parse", ok: false, error: `only ${text.length} chars of text` });
      continue;
    }

    let extraction;
    try {
      extraction = await extractFacts({ source, text });
    } catch (error) {
      console.log(`  extraction FAILED: ${error.message}`);
      run.sources.push({ sourceId: source.id, stage: "extract", ok: false, error: error.message });
      continue;
    }

    const { accepted, duplicates } = validateBatch(extraction.candidates, { registryUrls });
    const summary = summarize(accepted, duplicates);
    const guidance = accepted.filter((fact) => GUIDANCE_STATUSES.includes(fact.verificationStatus));
    console.log(`  extracted ${extraction.candidateCount} candidates in ${(extraction.latencyMs / 1000).toFixed(1)}s`);
    console.log(`  validation: ${summary.guidanceReady} guidance-ready, ${summary.needsReview} review, ${summary.unverified} unverified, ${summary.community ?? 0} community, ${summary.duplicates} duplicate`);

    const entry = { sourceId: source.id, stage: "done", ok: true, bytes: fetched.bytes, contentHash: fetched.contentHash, snapshotKey: fetched.snapshotKey, extraction: { model: extraction.model, latencyMs: extraction.latencyMs, candidates: extraction.candidateCount, usage: extraction.usage }, summary };

    if (admin) {
      await persist.upsertSource(admin, source, { contentHash: fetched.contentHash, checkedAt: fetched.checkedAt });
      await persist.recordSnapshot(admin, { source, contentHash: fetched.contentHash, bytes: fetched.bytes, contentType: fetched.contentType, storageKey: fetched.snapshotKey, storeKind: "local" });
      // Only facts that carry a verification status are persisted. The validator
      // is the only thing that can produce one.
      const { written, unchanged, skipped } = await persist.writeFacts(admin, accepted);
      entry.persisted = {
        created: written.filter((fact) => fact.action === "created").length,
        statusChanged: written.filter((fact) => fact.action !== "created").length,
        unchanged: unchanged.length,
        skipped: skipped.length,
      };
      console.log(`  persisted: ${entry.persisted.created} new, ${entry.persisted.statusChanged} status-changed, ${entry.persisted.unchanged} unchanged`);
    }

    entry.guidanceSample = guidance.slice(0, 3).map((fact) => ({ chapter: fact.chapter, claim: fact.claim.slice(0, 160), action: fact.action.slice(0, 120), quote: fact.evidenceQuote.slice(0, 140), status: fact.verificationStatus }));
    run.sources.push(entry);
  }

  mkdirSync("docs/evidence/phase4", { recursive: true });
  writeFileSync("docs/evidence/phase4/ingest-run.json", JSON.stringify(run, null, 2));

  const done = run.sources.filter((entry) => entry.ok);
  const facts = done.reduce((total, entry) => total + (entry.persisted?.created ?? 0), 0);
  console.log(`\ningest complete: ${done.length}/${run.sources.length} sources, ${facts} new facts written to Appwrite`);
  console.log("wrote docs/evidence/phase4/ingest-run.json");
  if (done.length !== run.sources.length) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error("ingest failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    /*
     * Release the headless browser, if one was launched.
     *
     * Measured 2026-09-16: without this the process never exits. `render.mjs`
     * keeps one browser alive across sources so a run does not pay a launch per
     * page, and a live Chromium holds the event loop open forever — the run
     * printed "ingest complete" and then hung until an external timeout killed
     * it. A pipeline that finishes its work and cannot return is a pipeline that
     * reports nothing.
     *
     * Dynamic import so the dependency is still optional: a run that never
     * rendered never loads Playwright.
     */
    try {
      const { closeRenderer } = await import("./render.mjs");
      await closeRenderer();
    } catch {
      /* rendering was never used */
    }
  });
