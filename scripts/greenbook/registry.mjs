/**
 * Source registry loader and validator.
 *
 * The registry is the input to the whole ingestion pipeline, so it is validated
 * before anything is fetched. A malformed registry should fail loudly here
 * rather than silently produce half-ingested knowledge.
 *
 * Usage:
 *   node scripts/greenbook/registry.mjs            # validate + summary
 *   node scripts/greenbook/registry.mjs --liveness # also check every URL resolves
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";

export const REGISTRY_PATH = "config/source-registry.yaml";

const REQUIRED_FIELDS = ["id", "country", "categories", "url", "status", "authority", "agency", "domain", "source_type", "access_strategy", "crawl_allowed", "language", "refresh_frequency", "parser"];
const VALID_AUTHORITY = ["A", "B", "C", "D"];
const VALID_STRATEGY = ["api", "dataset", "structured_html", "pdf", "html", "manual"];
const VALID_STATUS = ["verified_official", "candidate_verify_before_ingest"];
/** Sources that may never be mirrored, regardless of what the registry says. */
const NEVER_MIRROR = ["youtube.com", "tiktok.com"];

export function loadRegistry(path = REGISTRY_PATH) {
  return parse(readFileSync(path, "utf8"));
}

/** Structural validation. Returns a list of problems, empty when clean. */
export function validateRegistry(registry) {
  const problems = [];
  const seen = new Set();
  const categories = new Set(registry.categories ?? []);

  for (const source of registry.sources ?? []) {
    const where = source.id ?? "(missing id)";

    for (const field of REQUIRED_FIELDS) {
      if (source[field] === undefined) problems.push(`${where}: missing ${field}`);
    }
    if (source.id) {
      if (seen.has(source.id)) problems.push(`${where}: duplicate id`);
      seen.add(source.id);
    }
    if (source.authority && !VALID_AUTHORITY.includes(source.authority)) problems.push(`${where}: authority must be one of ${VALID_AUTHORITY.join("/")}`);
    if (source.status && !VALID_STATUS.includes(source.status)) problems.push(`${where}: status must be one of ${VALID_STATUS.join("/")}`);

    for (const strategy of source.access_strategy ?? []) {
      if (!VALID_STRATEGY.includes(strategy)) problems.push(`${where}: unknown access_strategy "${strategy}"`);
    }
    for (const category of source.categories ?? []) {
      if (!categories.has(category)) problems.push(`${where}: category "${category}" is not declared in categories`);
    }

    // A source that requires credentials cannot be fetched unattended.
    if (source.credentials_required && !(source.access_strategy ?? []).includes("api")) {
      problems.push(`${where}: credentials_required but no api strategy`);
    }
    // Media platforms must never be mirrored, whatever the flag says.
    if (NEVER_MIRROR.some((domain) => String(source.domain ?? "").includes(domain)) && source.crawl_allowed !== false) {
      problems.push(`${where}: ${source.domain} must have crawl_allowed: false`);
    }
    // Administrative authority without a concrete URL is the failure mode the
    // whole trust rule exists to prevent.
    if (["A", "B"].includes(source.authority) && !source.url) {
      problems.push(`${where}: authority ${source.authority} requires a concrete source URL`);
    }
  }

  return problems;
}

/** Group sources by country for the coverage report. */
export function coverageOf(registry) {
  const byCountry = {};
  for (const source of registry.sources ?? []) {
    byCountry[source.country] ??= { total: 0, verified: 0, byCategory: {} };
    byCountry[source.country].total += 1;
    if (source.status === "verified_official") byCountry[source.country].verified += 1;
    for (const category of source.categories ?? []) {
      byCountry[source.country].byCategory[category] = (byCountry[source.country].byCategory[category] ?? 0) + 1;
    }
  }
  return byCountry;
}

/**
 * Fetchability check.
 *
 * HEAD is not reliable on government sites (many reject it), so this issues a
 * ranged GET and only reads the status line.
 */
export async function checkLiveness(registry, { timeoutMs = 15_000, concurrency = 4 } = {}) {
  const sources = (registry.sources ?? []).filter((source) => source.crawl_allowed !== false);
  const results = [];
  let cursor = 0;

  const worker = async () => {
    while (cursor < sources.length) {
      const source = sources[cursor];
      cursor += 1;
      const startedAt = Date.now();
      try {
        const response = await fetch(source.url, {
          redirect: "follow",
          headers: { "user-agent": "YapYepGreenbook/0.1 (+contact: student project; respecting robots)", range: "bytes=0-2048" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        results.push({ id: source.id, country: source.country, status: response.status, ok: response.ok, ms: Date.now() - startedAt, finalUrl: response.url });
      } catch (error) {
        results.push({ id: source.id, country: source.country, status: null, ok: false, ms: Date.now() - startedAt, error: error.name });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, sources.length) }, worker));
  return results.sort((a, b) => a.id.localeCompare(b.id));
}

async function main() {
  const registry = loadRegistry();
  const problems = validateRegistry(registry);

  console.log(`registry: ${registry.sources.length} sources, version ${registry.version}`);
  console.log(`  deep: ${(registry.coverage?.deep ?? []).join(", ")}`);
  console.log(`  baseline: ${(registry.coverage?.baseline ?? []).join(", ")}`);

  const coverage = coverageOf(registry);
  console.log("\ncoverage:");
  for (const [country, entry] of Object.entries(coverage).sort()) {
    console.log(`  ${country.padEnd(7)} ${String(entry.total).padStart(2)} sources, ${entry.verified} verified  [${Object.keys(entry.byCategory).sort().join(", ")}]`);
  }

  console.log(`\nvalidation: ${problems.length === 0 ? "PASS" : `${problems.length} problem(s)`}`);
  for (const problem of problems) console.log(`  - ${problem}`);

  if (process.argv.includes("--liveness")) {
    console.log("\nliveness check (ranged GET, 15s timeout, 4 concurrent)…");
    const results = await checkLiveness(registry);
    const ok = results.filter((entry) => entry.ok);
    const redirected = results.filter((entry) => entry.ok && entry.finalUrl && !entry.finalUrl.startsWith("https://" + new URL(entry.finalUrl).host));
    for (const entry of results) {
      const mark = entry.ok ? "OK  " : "FAIL";
      console.log(`  ${mark} ${entry.id.padEnd(28)} ${String(entry.status ?? entry.error).padStart(6)}  ${String(entry.ms).padStart(6)}ms`);
    }
    console.log(`\n  ${ok.length}/${results.length} reachable`);
    if (redirected.length) console.log(`  ${redirected.length} served from a different host than registered`);
    if (ok.length !== results.length) process.exitCode = 1;
  }

  if (problems.length > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("registry.mjs")) {
  main().catch((error) => {
    console.error("registry failed:", error.message);
    process.exitCode = 1;
  });
}
