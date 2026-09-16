/**
 * Fetcher: registry entry → raw snapshot + extracted text.
 *
 * Deterministic acquisition only. No model is involved in getting the bytes —
 * an LLM is never a crawler. The fetcher applies the policy measured in
 * config/source-registry.yaml (browser user agent, politeness delay, timeout)
 * and records a content hash so unchanged sources are not re-processed.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createStore, extensionFor, snapshotKey } from "./snapshot-store.mjs";

/** Measured: sbv.gov.vn 403s an identifying agent and 200s a browser agent. */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_DELAY_MS = 1_500;
const LIVENESS_PATH = "docs/evidence/phase4/source-liveness.json";

/**
 * Measured reachability, kept separate from the hand-written registry.
 *
 * The registry records intent (what we would like to ingest); this records what
 * the network actually allows. Keeping them apart means a liveness run never
 * rewrites the curated source list, and the pipeline can skip hosts that refuse
 * this environment instead of retrying them forever.
 */
export function loadLiveness(path = LIVENESS_PATH) {
  try {
    const report = JSON.parse(readFileSync(path, "utf8"));
    const blocked = new Set(report.summary?.blocked_by_ip ?? []);
    for (const entry of report.summary?.unresolvable ?? []) blocked.add(entry.id);
    for (const id of report.summary?.redirect_not_followed ?? []) blocked.add(id);
    return { generatedAt: report.generatedAt, blocked };
  } catch {
    return { generatedAt: null, blocked: new Set() };
  }
}

export function contentHash(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Slice out a tag's full region, counting nested opens so the matching close is
 * the right one.
 *
 * A regex cannot do this. Measured 2026-09-16 on the ICA Student's Pass page:
 * the previous `/<div[^>]+(?:id|class)="…(?:content|main|article)…"[^>]*>([\s\S]*?)<\/div>/`
 * fallback captured 485 bytes out of 29,845, because the non-greedy `</div>`
 * stops at the first *nested* close. The extractor then saw 0 characters of text
 * and the pipeline skipped the most important Singapore source it had.
 */
function balancedSlice(html, startIndex, tag) {
  const openPattern = new RegExp(`<${tag}\\b`, "gi");
  const closePattern = new RegExp(`</${tag}\\s*>`, "gi");
  let depth = 0;
  let cursor = startIndex;

  while (cursor < html.length) {
    openPattern.lastIndex = cursor;
    closePattern.lastIndex = cursor;
    const nextOpen = openPattern.exec(html);
    const nextClose = closePattern.exec(html);
    if (!nextClose) return null;

    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      cursor = nextOpen.index + nextOpen[0].length;
      continue;
    }
    depth -= 1;
    cursor = nextClose.index + nextClose[0].length;
    if (depth === 0) return html.slice(startIndex, cursor);
  }
  return null;
}

/**
 * Pick the document's main content region.
 *
 * Preference order is strict — `<main>`, then `<article>`, then a content-ish
 * `<div>` — and within a tier the LARGEST balanced candidate wins, because a
 * page can carry several plausibly-named containers and the real content is the
 * big one. Size never promotes a lower tier: a large `div` must not beat a
 * declared `<main>`, since the author's own markup is the better signal.
 *
 * Two details that matter, both learned from the failure above:
 *   - `\b` boundaries, so `site-header__main` does not read as a main region.
 *     `_` is a word character, so `\bmain\b` correctly refuses to match it.
 *   - chrome containers are excluded by name, because a header or cookie banner
 *     named "…content…" would otherwise win.
 *
 * If nothing matches, the whole document is returned. Stripping scripts, nav and
 * footer already happens afterwards, so a conservative fallback loses nothing —
 * whereas guessing wrong loses everything, which is what happened before.
 */
export function contentContainer(html) {
  const largestOf = (regions) => (regions.length ? regions.reduce((a, b) => (b.length > a.length ? b : a)) : null);

  for (const tag of ["main", "article"]) {
    const regions = [];
    const pattern = new RegExp(`<${tag}\\b[^>]*>`, "gi");
    let match;
    while ((match = pattern.exec(html))) {
      const region = balancedSlice(html, match.index, tag);
      if (region) regions.push(region);
    }
    const best = largestOf(regions);
    if (best) return best;
  }

  const divs = [];
  const divPattern = /<div\b[^>]*(?:id|class)\s*=\s*"([^"]*)"[^>]*>/gi;
  let divMatch;
  while ((divMatch = divPattern.exec(html))) {
    const name = divMatch[1];
    if (!/\b(content|main|article)\b/i.test(name)) continue;
    if (/\b(header|footer|nav|menu|sidebar|banner|cookie|modal|breadcrumb)\b/i.test(name)) continue;
    const region = balancedSlice(html, divMatch.index, "div");
    if (region) divs.push(region);
  }

  return largestOf(divs) ?? html;
}

/**
 * Strip an HTML document down to readable text.
 *
 * Two defects found by inspecting real output rather than assuming it worked:
 *   1. Numeric entities (`&#8211;`, `&#038;`) were left encoded, so the
 *      extractor saw "Student Pass &#8211; Malaysian Immigration Department".
 *   2. Site navigation survived, because most government sites put the menu in
 *      a plain <div>, not a <nav>. A main-content region is preferred when the
 *      page marks one, and obvious boilerplate lines are dropped otherwise.
 */
/**
 * Container selection with a self-check.
 *
 * Measured 2026-09-16 across all 15 archived snapshots, the ratio of picked-text
 * to whole-document-text separates good picks from bad ones with a wide margin:
 *
 *   bad picks   0%, 10%, 43%   (`my-emgs` picked 12 chars, whole doc 9,525)
 *   good picks  81%, 85%, 96%, 98%, 99%, 100%
 *
 * A container that keeps less than half the document's text has almost certainly
 * grabbed a sidebar or a header rather than the main region, so the whole
 * document is used instead. Note how little the container usually helps when it
 * does work (99% kept on several pages) — `stripBoilerplate` does the real noise
 * removal, so falling back is cheap and being wrong is expensive.
 */
export function htmlToText(html) {
  const picked = regionToText(contentContainer(html));
  const whole = regionToText(html);
  return picked.length >= whole.length * 0.5 ? picked : whole;
}

/**
 * Tags whose content is never readable text, stripped however large they are.
 * A 300 KB inline script bundle is still not prose.
 */
const NON_CONTENT_REGIONS = ["script", "style", "noscript"];

/**
 * Tags whose content is usually chrome, but which can also wrap the whole body
 * when markup is malformed — an unclosed `<form>` or `<header>` is common on
 * government sites.
 */
const CHROME_REGIONS = ["nav", "header", "footer", "form", "button", "select", "textarea"];

/**
 * Chrome may not swallow more than this share of the document.
 *
 * Measured 2026-09-16 on `id-bank-indonesia`: one `<form>` region spanned
 * 148,508 of 163,260 bytes — 91% of the page. Stripping it left 14 characters of
 * text from a 163 KB document, and the source looked like a dead page. Removing
 * a "form" that holds 91% of a page is never right; the markup is broken, not
 * the content.
 */
const MAX_CHROME_SHARE = 0.5;

/**
 * ...but the share test only applies above this size.
 *
 * A share alone misfires on small documents: in a 133-byte test page a normal
 * `<select>` is 56% of it, and treating that as "oversized chrome" would leave
 * dropdown labels in the prompt. Real chrome is small in absolute terms — the
 * case this guards against was 148 KB — so both tests must hold.
 */
const MIN_OVERSIZED_CHROME_BYTES = 20_000;

/**
 * Strip scripts, styles and chrome, refusing to delete a region that is
 * implausibly large for the role it claims.
 *
 * The size guard is what makes this safe: chrome regions are small, so anything
 * both large in absolute terms and holding most of the document is treated as
 * content and kept. Without it, one unclosed tag silently empties a page.
 */
function stripChrome(html) {
  let output = html.replace(/<!--[\s\S]*?-->/g, " ");

  for (const tag of NON_CONTENT_REGIONS) {
    output = output.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), " ");
  }

  for (const tag of CHROME_REGIONS) {
    output = output.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), (match) =>
      match.length > MIN_OVERSIZED_CHROME_BYTES && match.length > html.length * MAX_CHROME_SHARE ? match : " ",
    );
  }

  return output;
}

/**
 * Remove tags, respecting quoted attribute values.
 *
 * The obvious implementation — `/<[^>]+>/g` — stops at the first `>`, which is
 * correct for plain HTML and WRONG for almost every modern site. Tailwind's
 * arbitrary variants put a `>` *inside* a class attribute:
 *
 *     class="[&>li>a]:py-1! [&>li>a]:px-0! pb-3 whitespace-nowrap"
 *
 * Measured 2026-09-16 on `chula.ac.th/en/international-students`: the regex ended
 * the tag at the `>` inside `[&>li>a]`, so the remainder
 *
 *     li>a]:py-1! [&>li>a]:px-0! pb-3 whitespace-nowrap">
 *
 * was emitted as if it were prose. Every such element added another fragment, so
 * the corruption scaled with the size of the page — and the fragments went to the
 * model as candidate fact text.
 *
 * This scans instead: it finds `<`, then walks forward to the closing `>` while
 * skipping over `"` and `'` quoted regions. A `<` inside a script body is not a
 * tag either, but scripts are removed before this runs, so that case cannot reach
 * here.
 */
export function stripTags(html) {
  let output = "";
  let cursor = 0;

  while (cursor < html.length) {
    const open = html.indexOf("<", cursor);
    if (open < 0) {
      output += html.slice(cursor);
      break;
    }
    output += html.slice(cursor, open);

    let scan = open + 1;
    let quote = null;
    while (scan < html.length) {
      const char = html[scan];
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        break;
      }
      scan += 1;
    }

    if (scan >= html.length) {
      // An unterminated `<` is literal text, not a tag. Keep it rather than
      // silently deleting the rest of the document.
      output += html.slice(open);
      break;
    }
    // A tag becomes a space, so adjacent inline elements do not fuse into one word.
    output += " ";
    cursor = scan + 1;
  }

  return output;
}

/**
 * Strip a chosen region down to readable text.
 *
 * Split out from `htmlToText` so a diagnostic can measure what the *whole*
 * document would yield and compare it against the picked region. That
 * comparison is how a bad container pick becomes visible instead of being
 * guessed at from a character count.
 */
export function regionToText(main) {
  const withoutNoise = stripChrome(main);

  const text = stripTags(
    withoutNoise
      .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n"),
  )
    // Named entities.
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    // Numeric entities, decimal and hex.
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");

  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}

/**
 * Drop obvious navigation boilerplate from extracted text.
 *
 * Government sites often place the menu in a plain container, so tag-based
 * stripping misses it. Lines that are short, repeat a pipe-separated menu shape,
 * or match known chrome words are removed before the extraction prompt sees them
 * — fewer prompt tokens and less chance the model treats a menu item as a fact.
 */
const CHROME_PATTERN = /\b(skip to content|home|contact us|sitemap|faq|privacy policy|terms of use|about us|careers|newsletter|subscribe|cookie)\b/i;

export function stripBoilerplate(text) {
  const lines = text.split("\n");
  const counts = new Map();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);

  return lines
    .filter((line) => {
      // A line repeated across the document is chrome, not content.
      if ((counts.get(line) ?? 0) > 2 && line.length < 120) return false;
      // A dense pipe-separated line is a menu.
      if (line.length < 200 && (line.match(/\|/g) ?? []).length >= 3) return false;
      // Known chrome vocabulary on a short line.
      if (line.length < 60 && CHROME_PATTERN.test(line)) return false;
      return true;
    })
    .join("\n")
    .trim();
}

/**
 * Fetch one registry source.
 *
 * Returns a record describing what happened. A blocked or failed source is a
 * normal outcome, not an exception: the registry already records which hosts
 * this environment cannot reach, and the pipeline continues without them.
 *
 * ACQUISITION STRATEGY, AND WHY THERE ARE TWO
 *
 * A plain HTTP fetch is tried first, always. It is fast, cheap and works for
 * every source that currently produces facts. Headless rendering is a fallback
 * with two triggers, never a default:
 *
 *   - the registry marks the source `browser_render_required`, or
 *   - the plain fetch succeeded but produced a shell (real bytes, no text).
 *
 * Rendering rewrites the record's text and the archived snapshot, because the
 * rendered DOM is what was actually parsed — archiving the empty shell while
 * claiming to have read the page would make the snapshot useless as evidence.
 */
export async function fetchSource(source, { store = createStore(), timeoutMs = DEFAULT_TIMEOUT_MS, snapshot = true, blocked = null, allowRender = true } = {}) {
  const startedAt = Date.now();
  const blockedIds = blocked ?? loadLiveness().blocked;
  const record = {
    sourceId: source.id,
    country: source.country,
    url: source.url,
    authority: source.authority,
    categories: source.categories,
    checkedAt: new Date().toISOString(),
    ok: false,
    status: null,
    contentType: null,
    bytes: 0,
    contentHash: null,
    snapshotKey: null,
    text: null,
    textLength: 0,
    latencyMs: 0,
    error: null,
    // Strategy telemetry. Recorded for every source so a run can be audited
    // without re-fetching: how it was fetched, how it was parsed, and how much
    // of the document survived into the prompt.
    fetch_strategy: "http",
    parser_strategy: "region+boilerplate",
    raw_bytes: 0,
    parsed_chars: 0,
    content_ratio: 0,
    language: source.language ?? null,
    rendered: false,
    failure_reason: null,
  };

  if (source.crawl_allowed === false) {
    record.error = "crawl_allowed: false — cited and linked only, never mirrored";
    record.failure_reason = "crawl_not_allowed";
    record.latencyMs = Date.now() - startedAt;
    return record;
  }
  if (blockedIds.has(source.id)) {
    record.error = "unreachable from this environment (measured) — see docs/evidence/phase4/source-liveness.json";
    record.failure_reason = "blocked_by_egress";
    record.latencyMs = Date.now() - startedAt;
    return record;
  }

  try {
    const response = await fetch(source.url, {
      redirect: "follow",
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,application/pdf,*/*" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    record.status = response.status;
    record.latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      record.error = `HTTP ${response.status}`;
      record.failure_reason = `http_${response.status}`;
      return record;
    }

    record.contentType = response.headers.get("content-type") ?? "";
    let buffer = Buffer.from(await response.arrayBuffer());
    record.bytes = buffer.length;
    record.raw_bytes = buffer.length;
    record.ok = true;
    record.contentHash = contentHash(buffer);

    let extension = extensionFor(record.contentType, source.url);

    if (extension === "html") {
      record.text = htmlToText(buffer.toString("utf8"));
      record.textLength = record.text.length;

      /*
       * The render fallback. Only reached when the page looks like a shell, or
       * when the registry has already declared it needs a browser.
       */
      const { looksLikeShell, renderPage } = await import("./render.mjs");
      const shell = looksLikeShell({ text: record.text, bytes: record.bytes });
      if (allowRender && (source.browser_render_required === true || shell)) {
        const rendered = await renderPage(source.url);
        if (rendered.ok) {
          const renderedText = htmlToText(rendered.html);
          // Accept the render only if it actually yielded more. A render that
          // returns less means the plain fetch was already the better source,
          // and overwriting good text with worse text would be a regression.
          if (renderedText.length > record.text.length) {
            record.text = renderedText;
            record.textLength = renderedText.length;
            record.rendered = true;
            record.fetch_strategy = "headless";
            record.renderedBytes = rendered.bytes;
            record.renderLatencyMs = rendered.latencyMs;
            record.renderTrigger = source.browser_render_required === true ? "registry_flag" : "shell_detected";
            buffer = Buffer.from(rendered.html, "utf8");
            record.contentHash = rendered.contentHash;
            extension = "html";
          } else {
            record.renderNote = `rendered but yielded no more text (${renderedText.length} vs ${record.text.length})`;
          }
        } else {
          record.renderNote = `render unavailable: ${rendered.error}`;
        }
      }
    } else {
      // PDF and dataset parsing is a separate step; the raw bytes are archived.
      record.text = null;
      record.note = `${extension} archived; text extraction not implemented for this type yet`;
      record.parser_strategy = "none";
    }

    if (snapshot) {
      const key = snapshotKey({ country: source.country, category: source.categories?.[0], sourceId: source.id, extension });
      const stored = await store.put(key, buffer);
      record.snapshotKey = stored.key;
      record.snapshotLocation = stored.location ?? null;
    }

    record.parsed_chars = record.textLength;
    record.content_ratio = record.raw_bytes > 0 ? Number((record.textLength / record.raw_bytes).toFixed(4)) : 0;
    if (!record.failure_reason && record.textLength === 0) record.failure_reason = "no_text_extracted";
    return record;
  } catch (error) {
    record.latencyMs = Date.now() - startedAt;
    record.error = `${error.name}: ${error.message}`.slice(0, 160);
    record.failure_reason = error.name === "TimeoutError" ? "timeout" : "fetch_error";
    return record;
  }
}

/** Fetch many sources politely: bounded concurrency and a delay between starts. */
export async function fetchAll(sources, { concurrency = 4, delayMs = DEFAULT_DELAY_MS, ...options } = {}) {
  const store = options.store ?? createStore();
  const results = [];
  let cursor = 0;

  const worker = async () => {
    while (cursor < sources.length) {
      const source = sources[cursor];
      cursor += 1;
      const result = await fetchSource(source, { ...options, store });
      results.push(result);
      console.log(
        `  ${result.ok ? "OK  " : "FAIL"} ${source.id.padEnd(28)} ${String(result.status ?? result.error).slice(0, 40).padEnd(40)} ${String(result.bytes).padStart(8)}B  hash=${result.contentHash ? result.contentHash.slice(0, 12) : "—"}`,
      );
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, sources.length) }, worker));
  return results.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}
