/**
 * Optional headless rendering.
 *
 * WHY THIS EXISTS
 *
 * Measured 2026-09-16: six ASEAN countries produce zero facts, and it is not for
 * lack of sources. Their government hosts answer 200 and serve a JavaScript
 * shell. The pipeline reports `too little text after parsing` for
 * moeys.gov.kh (49 chars), immigration.gov.kh (175), laoevisa.gov.la (318),
 * immigration.gov.la (40), gov.bn (70) and evisa.moip.gov.mm (34) — which is the
 * correct refusal, because the alternative is storing navigation menus as
 * guidance. The same problem costs NUS (200, zero characters) and
 * thaievisa.go.th (115 chars).
 *
 * Those pages are not broken. They are client-rendered, and a plain fetch cannot
 * execute the client. This module can.
 *
 * TWO RULES IT FOLLOWS
 *
 * 1. **It is never the default.** Rendering is expensive — a browser launch, a
 *    network-idle wait, and a real page load — so it runs only when the registry
 *    marks a source `browser_render_required`, or when a plain fetch has already
 *    produced a shell. A source that works over plain HTTP is never rendered.
 *
 * 2. **It degrades to nothing, never to an error.** Playwright is a devDependency
 *    and Chromium may be absent. Every path here returns `{ ok: false }` rather
 *    than throwing, so the pipeline behaves exactly as it did before this file
 *    existed when rendering is unavailable.
 *
 * It also does not defeat bot protection: it loads the page once, as a browser,
 * with the same user agent the fetcher uses, and reads what the page renders. It
 * does not solve challenges, rotate identities or retry aggressively.
 */
import { createHash } from "node:crypto";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/**
 * A shell is a page that returns real markup and almost no text.
 *
 * Both thresholds are needed. Size alone misfires on a genuinely short page;
 * text alone misfires on a real page whose content sits inside a script tag.
 *
 * The byte floor started at 20,000 and was lowered to 2,000 after a measured
 * miss: `kh-moeys` serves only 3,426 bytes — 49 characters of text, which is
 * 1.4% — and the old floor skipped it, so the render never ran and Cambodia's
 * education ministry stayed empty. A page with under 500 characters of readable
 * text and more than 2 KB of markup is a shell or an error page; neither is
 * worth extracting from, and rendering either costs about twenty seconds.
 *
 * A genuinely small page is still safe: a 300-byte page with 200 characters of
 * text is a short page, not a shell, and stays under the floor.
 */
export const SHELL_TEXT_CEILING = 500;
export const SHELL_BYTES_FLOOR = 2_000;

export function looksLikeShell({ text, bytes }) {
  return (text ?? "").length < SHELL_TEXT_CEILING && (bytes ?? 0) > SHELL_BYTES_FLOOR;
}

/** One browser for the whole run; launching per page is far slower. */
let browserPromise = null;
let renderCount = 0;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = await import("@playwright/test");
      return chromium.launch();
    })();
  }
  return browserPromise;
}

/** True when a headless browser is actually available in this environment. */
export async function rendererAvailable() {
  try {
    const browser = await getBrowser();
    return Boolean(browser);
  } catch {
    return false;
  }
}

/**
 * Load a URL in a real browser and return the rendered HTML.
 *
 * The wait is two-tiered, and the split is a measured cost decision.
 *
 * `networkidle` is the wait that matters — an SPA that fetches its content after
 * load is empty at `domcontentloaded`. But measured 2026-09-16 it is also a wait
 * some government sites never reach: `immigration.gov.kh` times out because the
 * page keeps polling, even though it rendered long before. Waiting the full
 * budget on a page that will never settle costs 35s per source for nothing.
 *
 * So `networkidle` gets a short leash, and a timeout falls back to
 * `domcontentloaded` plus a longer settle. Worst case drops from ~39s to ~22s,
 * and a page that genuinely settles still gets the good wait.
 */
const NETWORK_IDLE_MS = 15_000;

export async function renderPage(url, { timeoutMs = 30_000, settleMs = 1_500 } = {}) {
  let context = null;
  const startedAt = Date.now();
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 900 },
      // The pipeline wants text, not images or fonts.
      javaScriptEnabled: true,
    });
    const page = await context.newPage();

    // Block only genuinely heavy, non-textual resources. Blocking more than this
    // changes what the site renders and produces a page no student would see.
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "font" || type === "media") return route.abort();
      return route.continue();
    });

    let navigation = "networkidle";
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: NETWORK_IDLE_MS });
    } catch (error) {
      if (error.name !== "TimeoutError") throw error;
      navigation = "domcontentloaded";
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs }).catch(() => {});
      await page.waitForTimeout(4_000);
    }

    if (settleMs > 0) await page.waitForTimeout(settleMs);
    const html = await page.content();

    renderCount += 1;
    return {
      ok: true,
      html,
      navigation,
      bytes: Buffer.byteLength(html, "utf8"),
      contentHash: createHash("sha256").update(html).digest("hex"),
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return { ok: false, error: `${error.name}: ${String(error.message).slice(0, 120)}`, latencyMs: Date.now() - startedAt };
  } finally {
    await context?.close().catch(() => {});
  }
}

/** Close the shared browser. Safe to call when nothing was rendered. */
export async function closeRenderer() {
  if (!browserPromise) return;
  try {
    const browser = await browserPromise;
    await browser?.close();
  } catch {
    /* nothing to close */
  }
  browserPromise = null;
}

export function renderedCount() {
  return renderCount;
}
