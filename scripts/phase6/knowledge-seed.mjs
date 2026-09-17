/** Additive, exact-evidence seed. Defaults to local validation; --live writes only KB tables. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Permission, Query, Role } from "node-appwrite";
import { loadRegistry, validateRegistry } from "../greenbook/registry.mjs";
import { fetchSource } from "../greenbook/fetch.mjs";
import { validateBatch } from "../greenbook/validate.mjs";
import { createAdminClient, upsertSource, recordSnapshot, writeFacts } from "../greenbook/persist.mjs";

const ROOT = "seed/phase6";
const attribution = "Department of Foreign Affairs and Trade's Smartraveller website - www.smartraveller.gov.au";
export function robotsPatternMatches(pathname, pattern) {
  const end = pattern.endsWith("$") ? "$" : "";
  const body = end ? pattern.slice(0, -1) : pattern;
  const escaped = body.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}${end}`).test(pathname);
}
export function applicableRobotDisallows(text) {
  const rules = [];
  let applicable = false;
  for (const line of text.split(/\r?\n/)) {
    const agent = /^User-agent:\s*(\S+)/i.exec(line);
    if (agent) { applicable = agent[1] === "*" || /^(ChatGPT-User|GPTBot)$/i.test(agent[1]); continue; }
    const rule = /^Disallow:\s*(\S+)/i.exec(line);
    if (applicable && rule) rules.push(rule[1]);
  }
  return rules;
}
export function groundedCandidates(source, records, fetched) {
  if (!fetched.ok || !fetched.text || fetched.url !== source.url || source.crawl_allowed !== true) return [];
  return records.filter((r) => fetched.text.includes(r.evidenceQuote)).map((r) => ({
    ...r, sourceId: source.id, sourceUrl: source.url, sourceType: source.source_type,
    sourceStatus: source.status, authorityLevel: source.authority, country: source.country,
    checkedAt: fetched.checkedAt, confidence: 0.95, effectiveFrom: null, validUntil: null,
    origin: "curated", action: r.action ?? "", journeyStage: r.journeyStage ?? "ongoing",
  }));
}
async function fetchPolicy(sources) {
  const urls = ["https://www.smartraveller.gov.au/robots.txt", "https://www.smartraveller.gov.au/copyright"];
  const results = [];
  for (const url of urls) {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Policy check failed: HTTP ${response.status}`);
    const text = await response.text();
    results.push({ url, text, checkedAt: new Date().toISOString() });
  }
  // Conservative policy check for this explicitly curated host/path only.
  if (/Disallow:\s*\/destinations|Disallow:\s*\/\s*(?:\r?\n|$)/i.test(results[0].text)) throw new Error("Destination crawling disallowed");
  if (!results[1].text.includes("Creative Commons Attribution")) throw new Error("Reuse licence not confirmed");
  writeFileSync(`${ROOT}/policy-check.json`, JSON.stringify({ attribution, results }, null, 2));
  const robotsChecks = [];
  for (const origin of new Set(sources.map((s) => new URL(s.url).origin))) {
    if (origin === "https://www.smartraveller.gov.au") continue;
    const response = await fetch(`${origin}/robots.txt`, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok && response.status !== 404) throw new Error(`Cannot establish robots permission for ${origin}: HTTP ${response.status}`);
    const text = response.status === 404 ? "" : await response.text();
    const disallowed = applicableRobotDisallows(text);
    for (const source of sources.filter((s) => new URL(s.url).origin === origin)) {
      const pathname = new URL(source.url).pathname;
      if (disallowed.some((pattern) => robotsPatternMatches(pathname, pattern))) throw new Error(`Conservative robots check rejects ${source.id}`);
    }
    robotsChecks.push({ origin, status: response.status, text, checkedAt: new Date().toISOString() });
  }
  writeFileSync(`${ROOT}/supplemental-policy-check.json`, JSON.stringify(robotsChecks, null, 2));
}
export async function main(args = process.argv.slice(2)) {
  if (args.includes("--readback")) {
    const admin = createAdminClient();
    const result = { checkedAt: new Date().toISOString(), countries: {}, sources: {} };
    for (const source of loadRegistry(`${ROOT}/source-registry.yaml`).sources) {
      const rows = await admin.tables.listRows({ databaseId: admin.databaseId, tableId: "knowledge_facts", queries: [Query.equal("source_id", [source.id]), Query.limit(100)] });
      const count = { total: rows.total, verified: rows.rows.filter((r) => ["official_verified", "university_verified"].includes(r.verification_status)).length, publicReadable: rows.rows.filter((r) => r.$permissions?.includes(Permission.read(Role.any()))).length, sourceActions: rows.rows.filter((r) => r.actionable_advice).length, chapters: {} };
      for (const row of rows.rows) count.chapters[row.chapter] = (count.chapters[row.chapter] ?? 0) + 1;
      assert.equal(count.total, count.verified, `${source.country}: unexpected unverified seed rows`);
      assert.equal(count.total, count.publicReadable, `${source.country}: publication permission missing`);
      result.sources[source.id] = count;
      const country = result.countries[source.country] ??= { total: 0, verified: 0, publicReadable: 0, sourceActions: 0, chapters: {} };
      for (const key of ["total", "verified", "publicReadable", "sourceActions"]) country[key] += count[key];
      for (const [key, value] of Object.entries(count.chapters)) country.chapters[key] = (country.chapters[key] ?? 0) + value;
    }
    writeFileSync(`${ROOT}/live-readback.json`, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    return result;
  }
  if (args.includes("--self-test")) {
    assert.equal(robotsPatternMatches("/country-commercial-guides/cambodia-business-travel", "/*/media/oembed"), false);
    assert.equal(robotsPatternMatches("/x/media/oembed", "/*/media/oembed"), true);
    assert.equal(robotsPatternMatches("/document.pdf", "/*.pdf$"), true);
    assert.equal(robotsPatternMatches("/document.pdf/info", "/*.pdf$"), false);
    assert.deepEqual(applicableRobotDisallows("User-agent: *\nDisallow: /admin\nUser-agent: Bytespider\nDisallow: /"), ["/admin"]);
    const source = { id: "test", url: "https://example.test/page", country: "BN", crawl_allowed: true };
    const fact = { evidenceQuote: "This sentence is actually present.", claim: "A grounded claim", action: "A source-backed action" };
    assert.equal(groundedCandidates(source, [fact], { ok: true, text: fact.evidenceQuote, url: source.url }).length, 1);
    assert.equal(groundedCandidates(source, [fact], { ok: true, text: fact.evidenceQuote, url: source.url })[0].action, fact.action);
    assert.equal(groundedCandidates(source, [fact], { ok: true, text: "Other content", url: source.url }).length, 0);
    assert.equal(groundedCandidates(source, [fact], { ok: false, text: fact.evidenceQuote, url: source.url }).length, 0);
    assert.equal(groundedCandidates(source, [fact], { ok: true, text: fact.evidenceQuote, url: "https://other.test" }).length, 0);
    console.log("Exact evidence, retrieval failure, and URL mismatch checks passed.");
    return;
  }
  mkdirSync(`${ROOT}/snapshots`, { recursive: true });
  const base = loadRegistry();
  const supplement = loadRegistry(`${ROOT}/source-registry.yaml`);
  const merged = { ...base, categories: [...new Set([...base.categories, ...supplement.categories])], sources: [...base.sources, ...supplement.sources.filter((s) => !base.sources.some((b) => b.id === s.id))] };
  const problems = validateRegistry(merged);
  if (problems.length) throw new Error(problems.join("; "));
  const fixture = JSON.parse(readFileSync(`${ROOT}/knowledge-facts.json`, "utf8"));
  const live = args.includes("--live");
  const offline = args.includes("--offline");
  if (live && offline) throw new Error("Live writes require fresh HTTP retrieval; --offline is validation only");
  if (!offline) await fetchPolicy(supplement.sources);
  const admin = live ? createAdminClient() : null;
  const report = { generatedAt: new Date().toISOString(), live, attribution, countries: {}, sources: {}, skipped: [] };
  for (const source of supplement.sources) {
    if (args.includes("--deep-only") && !source.id.endsWith("-deep-culture")) continue;
    if (args.includes("--culture-only") && source.id.endsWith("-dfat")) continue;
    const store = { put: async (key, bytes) => {
      const file = `${ROOT}/snapshots/${source.id}.html`;
      writeFileSync(file, bytes);
      return { key: file, location: file };
    } };
    const fetched = offline ? JSON.parse(readFileSync(`${ROOT}/${source.id.endsWith("-dfat") ? source.country : source.id}-probe.json`, "utf8")) : await fetchSource(source, { store, allowRender: false, blocked: new Set(), snapshot: true });
    const records = fixture.filter((f) => f.country === source.country && f.sourceId === source.id);
    const candidates = groundedCandidates(source, records, fetched);
    const { accepted } = validateBatch(candidates, { registryUrls: new Set(merged.sources.map((s) => s.url)) });
    const verified = accepted.filter((f) => ["official_verified", "university_verified"].includes(f.verificationStatus));
    const count = { sourceId: source.id, fetched: fetched.ok, candidates: records.length, grounded: candidates.length, verified: verified.length, chapters: {} };
    for (const fact of verified) count.chapters[fact.chapter] = (count.chapters[fact.chapter] ?? 0) + 1;
    report.sources[source.id] = count;
    const countryCount = report.countries[source.country] ??= { candidates: 0, grounded: 0, verified: 0, chapters: {} };
    for (const key of ["candidates", "grounded", "verified"]) countryCount[key] += count[key];
    for (const [key, value] of Object.entries(count.chapters)) countryCount.chapters[key] = (countryCount.chapters[key] ?? 0) + value;
    for (const r of records.filter((r) => !candidates.some((f) => f.evidenceQuote === r.evidenceQuote))) report.skipped.push({ country: source.country, claim: r.claim, reason: "Supporting quote absent from current fetched text or retrieval failed" });
    if (admin && fetched.ok && verified.length) {
      await upsertSource(admin, source, { contentHash: fetched.contentHash, checkedAt: fetched.checkedAt });
      await recordSnapshot(admin, { source, contentHash: fetched.contentHash, bytes: fetched.bytes, contentType: fetched.contentType, storageKey: fetched.snapshotKey, storeKind: "local" });
      count.persistence = await writeFacts(admin, verified);
    }
    writeFileSync(`${ROOT}/seed-report${live ? "-live" : offline ? "-offline" : ""}.json`, JSON.stringify(report, null, 2));
    console.log(`${source.country}: ${verified.length}/${records.length} grounded verified${live ? " written" : " (no database writes)"}`);
  }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
