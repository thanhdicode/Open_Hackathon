/**
 * Source discovery probe.
 *
 * THE PROBLEM THIS SOLVES
 *
 * The registry is full of bare site roots. `id-immigration-candidate` points at
 * `https://www.imigrasi.go.id/` — a homepage. Homepages do not state student
 * requirements; they carry press releases. Measured consequence: Indonesia's
 * only facts are homepage news, capped at `needs_review` by the trust gate, so
 * the country publishes nothing and demo corridor 3 is dead.
 *
 * Replacing a homepage with a real requirement page needs the site to be asked
 * what it actually publishes. This walks the documented ladder:
 *
 *   robots.txt -> sitemap.xml (including sitemap indexes) -> on-page links
 *
 * and scores every candidate URL by how likely it is to state an actionable
 * student requirement. It NEVER bypasses a WAF, never ignores robots, and never
 * invents a URL: every candidate it prints was observed in a real response.
 *
 * It is a PROBE, not a crawler. It fetches one site's discovery documents and at
 * most one page per candidate; it does not follow the site.
 *
 * Usage:
 *   node scripts/greenbook/discovery/probe.mjs https://www.imigrasi.go.id/
 *   node scripts/greenbook/discovery/probe.mjs https://www.ui.ac.id/ --top 40
 *   node scripts/greenbook/discovery/probe.mjs --registry ID
 */
import { writeFileSync, mkdirSync } from "node:fs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/**
 * Terms that indicate a page states a requirement a student must act on.
 * Weighted: an immigration or visa page is worth more than a news page, because
 * the whole point is to stop ingesting press releases as guidance.
 */
const POSITIVE = [
  [/\b(visa|izin tinggal|itas|kitas|stay permit|student pass|pass)\b/i, 10],
  [/\b(student|mahasiswa|pelajar|international)\b/i, 8],
  [/\b(requirement|persyaratan|syarat|dokumen|document|procedure|prosedur|tata cara)\b/i, 9],
  [/\b(apply|application|pendaftaran|permohonan|registration|daftar)\b/i, 7],
  [/\b(fee|biaya|tarif|cost|payment|pembayaran)\b/i, 5],
  [/\b(arrival|kedatangan|kedatangan|entry|masuk|exit)\b/i, 5],
  [/\b(health|kesehatan|insurance|asuransi|clinic|klinik)\b/i, 5],
  [/\b(transport|transportasi|bus|krl|mrt|lrt|ticket|tiket)\b/i, 5],
  [/\b(scholarship|beasiswa|tuition|ukt|akademik|academic|admission)\b/i, 6],
  [/\b(emergency|darurat|contact|kontak|hotline)\b/i, 4],
];

/** Terms that mark a page as not a requirement, however official it is. */
const NEGATIVE = [
  [/\b(news|berita|press|siaran pers|pengumuman)\b/i, -6],
  [/\b(gallery|galeri|photo|foto|video|multimedia)\b/i, -5],
  [/\b(career|karier|lowongan|recruitment|tender|procurement)\b/i, -6],
  [/\b(login|masuk\b|signin|register\b)/i, -3],
  [/\b(about|tentang|profile|profil|sejarah|history|vision|visi)\b/i, -3],
  [/\b(social|facebook|instagram|twitter|youtube|tiktok)\b/i, -8],
  [/\b(tag|category|kategori|archive|arsip|page\/\d+)\b/i, -4],
];

const SKIP_EXT = /\.(jpg|jpeg|png|gif|svg|webp|ico|css|js|woff2?|ttf|eot|mp4|mp3|zip|rar|gz|xlsx?|docx?|pptx?)$/i;
/** Binary or non-HTML assets that are still worth registering as documents. */
const DOC_EXT = /\.(pdf)$/i;

function score(url) {
  let total = 0;
  for (const [pattern, weight] of POSITIVE) if (pattern.test(url)) total += weight;
  for (const [pattern, weight] of NEGATIVE) if (pattern.test(url)) total += weight;
  // Depth is a weak signal: requirement pages usually sit a level or two below
  // the root, while a bare root is the thing being replaced.
  const depth = url.replace(/^https?:\/\/[^/]+/, "").split("/").filter(Boolean).length;
  if (depth === 0) total -= 12;
  else if (depth === 1) total += 1;
  else if (depth >= 2) total += 2;
  return total;
}

async function get(url, { timeoutMs = 20_000 } = {}) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/xml,text/plain,*/*" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = response.ok ? await response.text() : "";
    return { ok: response.ok, status: response.status, body, finalUrl: response.url };
  } catch (error) {
    return { ok: false, status: null, body: "", error: error.name };
  }
}

/** robots.txt is read, not merely checked: a disallowed path is never probed. */
async function loadRobots(origin) {
  const { ok, body } = await get(`${origin}/robots.txt`);
  if (!ok) return { disallow: [], sitemaps: [] };
  const disallow = [];
  const sitemaps = [];
  for (const line of body.split(/\r?\n/)) {
    const dis = /^\s*disallow:\s*(\S+)/i.exec(line);
    if (dis && dis[1]) disallow.push(dis[1]);
    const sm = /^\s*sitemap:\s*(\S+)/i.exec(line);
    if (sm && sm[1]) sitemaps.push(sm[1]);
  }
  return { disallow, sitemaps };
}

function isAllowed(url, disallow) {
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  return !disallow.some((rule) => rule !== "/" && path.startsWith(rule.replace(/\*$/, "")));
}

/** Pull <loc> entries out of a sitemap or sitemap index. */
function parseSitemap(xml) {
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((match) => match[1]);
  const isIndex = /<sitemapindex/i.test(xml);
  return { locs, isIndex };
}

function extractLinks(html, origin) {
  const found = new Set();
  for (const match of html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
    let href = match[1].trim();
    if (href.startsWith("//")) href = `https:${href}`;
    if (href.startsWith("/")) href = `${origin}${href}`;
    if (!/^https?:\/\//i.test(href)) continue;
    if (!href.startsWith(origin)) continue;
    if (SKIP_EXT.test(href)) continue;
    found.add(href.split("?")[0].replace(/\/$/, ""));
  }
  return [...found];
}

async function discover(root, { render = false } = {}) {
  const origin = new URL(root).origin;
  const report = { root, origin, robots: null, sitemaps: [], candidates: [], blocked: false, rendered: false };

  const robots = await loadRobots(origin);
  report.robots = { disallow: robots.disallow.length, sitemaps: robots.sitemaps.length };

  // --- sitemap ladder -------------------------------------------------------
  const sitemapSeeds = robots.sitemaps.length ? robots.sitemaps : [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const pageUrls = new Set();

  for (const seed of sitemapSeeds.slice(0, 3)) {
    const { ok, body } = await get(seed);
    if (!ok || !body.includes("<loc")) continue;
    const { locs, isIndex } = parseSitemap(body);
    report.sitemaps.push({ url: seed, entries: locs.length, index: isIndex });
    if (isIndex) {
      // A sitemap index points at sitemaps, not pages. Follow a bounded number.
      for (const child of locs.filter((loc) => /\.xml/i.test(loc)).slice(0, 6)) {
        const nested = await get(child);
        if (!nested.ok) continue;
        const parsed = parseSitemap(nested.body);
        report.sitemaps.push({ url: child, entries: parsed.locs.length, index: false });
        for (const loc of parsed.locs) pageUrls.add(loc.split("?")[0].replace(/\/$/, ""));
      }
    } else {
      for (const loc of locs) pageUrls.add(loc.split("?")[0].replace(/\/$/, ""));
    }
  }

  // --- on-page links --------------------------------------------------------
  const home = await get(root);
  if (!home.ok && !render) {
    report.blocked = true;
    report.blockedStatus = home.status ?? home.error;
    return report;
  }

  let homepageHtml = home.ok ? home.body : "";
  let homepageLinks = homepageHtml ? extractLinks(homepageHtml, origin) : [];

  /*
   * `--render` exists because a JavaScript shell cannot be probed.
   *
   * Measured 2026-09-16: six countries returned 0 facts, and the reason was not
   * a missing source — their hosts serve a shell, so the probe saw an empty
   * document and found no links to follow. The renderer can read those pages, so
   * with `--render` the probe does too, and then the same scoring applies.
   */
  if (render && homepageLinks.length < 20) {
    const { renderPage, closeRenderer } = await import("../render.mjs");
    const rendered = await renderPage(root);
    if (rendered.ok) {
      const renderedLinks = extractLinks(rendered.html, origin);
      if (renderedLinks.length > homepageLinks.length) {
        homepageLinks = renderedLinks;
        homepageHtml = rendered.html;
        report.rendered = true;
      }
    }
    await closeRenderer();
  }

  report.homepageLinks = homepageLinks.length;
  for (const link of homepageLinks) pageUrls.add(link);

  // --- score ----------------------------------------------------------------
  const scored = [...pageUrls]
    .filter((url) => isAllowed(url, robots.disallow))
    .map((url) => ({ url, score: score(url) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.url.length - b.url.length);

  // De-duplicate near-identical paths (a trailing slash variant, or ?lang=).
  const seen = new Set();
  report.candidates = scored.filter((entry) => {
    const key = entry.url.replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  report.documentCandidates = report.candidates.filter((entry) => DOC_EXT.test(entry.url));
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const top = Number((/--top\s+(\d+)/.exec(args.join(" ")) ?? [])[1] ?? 25);
  const render = args.includes("--render");
  const roots = args.filter((arg) => /^https?:\/\//.test(arg));

  if (args.includes("--registry")) {
    const { loadRegistry } = await import("../registry.mjs");
    const country = (args[args.indexOf("--registry") + 1] ?? "").toUpperCase();
    const registry = loadRegistry();
    for (const source of registry.sources.filter((entry) => entry.country === country)) {
      roots.push(source.url);
      console.log(`\n=== ${source.id} (${source.status}, authority ${source.authority}) ===`);
      const report = await discover(source.url, { render });
      print(report, top);
    }
    return;
  }

  if (!roots.length) {
    console.error("usage: node scripts/greenbook/discovery/probe.mjs <url> [--top N] [--render]");
    process.exitCode = 1;
    return;
  }

  const reports = [];
  for (const root of roots) {
    console.log(`\n=== ${root}${render ? " (rendered)" : ""} ===`);
    const report = await discover(root, { render });
    reports.push(report);
    print(report, top);
  }

  mkdirSync("docs/evidence/greenbook/sources", { recursive: true });
  writeFileSync("docs/evidence/greenbook/sources/discovery-probe.json", JSON.stringify(reports, null, 2));
  console.log(`\nwrote docs/evidence/greenbook/sources/discovery-probe.json`);
}

function print(report, top) {
  if (report.blocked) {
    console.log(`  BLOCKED at ${report.blockedStatus} — egress refusal, not a client problem. Needs another official source.`);
    return;
  }
  console.log(`  robots: ${report.robots.disallow} disallow rule(s), ${report.robots.sitemaps} sitemap(s) declared`);
  for (const sitemap of report.sitemaps) console.log(`  sitemap: ${sitemap.url} — ${sitemap.entries} entries${sitemap.index ? " (index)" : ""}`);
  console.log(`  on-page links: ${report.homepageLinks ?? 0}`);
  console.log(`  ${report.candidates.length} candidate page(s), top ${Math.min(top, report.candidates.length)}:`);
  for (const entry of report.candidates.slice(0, top)) {
    console.log(`    ${String(entry.score).padStart(3)}  ${entry.url}`);
  }
}

main().catch((error) => {
  console.error("probe failed:", error.message);
  process.exitCode = 1;
});
