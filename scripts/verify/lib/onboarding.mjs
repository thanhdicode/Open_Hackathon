/**
 * Shared browser helpers for the Phase 3 evidence scripts.
 *
 * The onboarding walker reacts to whatever screen is showing rather than
 * assuming a fixed order. A country already chosen becomes disabled, so only an
 * enabled option is selectable — that is what distinguishes the home step from
 * the host step. Assuming an order is what stalled the earlier harness.
 */

const NAV = /^(Today|Passport|Lens|Explore|Connect|Back|Settings)$/;

/**
 * Controls the walker must never click.
 *
 * Measured 2026-09-16: the option-grid fallback clicked "Sign in with Google"
 * and the harness ended up on a Google `Error 401: invalid_client` page, which
 * made onboarding fail for a reason that had nothing to do with the product.
 * A test harness cannot complete a real OAuth flow, so it must not start one.
 */
const FORBIDDEN = /google|apple|facebook|sign in|log in|login|oauth|account$/i;

/**
 * The onboarding workspace column, when the layout has one.
 *
 * On desktop the left rail sits alongside the onboarding flow and exposes a
 * country chip plus the same navigation labels, so an unscoped click can hit the
 * rail instead of the flow. `responsive.mjs` worked around this locally; doing it
 * in the shared walker fixes it for every script.
 */
function workspace(page) {
  return page.locator('div[class*="max-w-[800px]"]').first();
}

/** Click the first matching pattern inside the workspace if possible, else page-wide. */
async function clickInWorkspace(page, patterns, timeout = 2500) {
  const scoped = workspace(page);
  if ((await scoped.count()) > 0) {
    const picked = await clickVisible(scoped, patterns, timeout);
    if (picked) return picked;
  }
  return clickVisible(page, patterns, timeout);
}

/** Click the first pattern that is present, visible and enabled. */
export async function clickVisible(page, patterns, timeout = 2500) {
  for (const pattern of patterns) {
    const target = page.getByRole("button", { name: pattern }).first();
    if ((await target.count()) === 0) continue;
    if (!(await target.isVisible().catch(() => false))) continue;
    if (await target.isDisabled().catch(() => true)) continue;
    try {
      await target.click({ timeout });
      return String(pattern);
    } catch {
      /* try the next pattern */
    }
  }
  return null;
}

/** True when a matching button exists, is visible and is not disabled. */
export async function isClickable(page, pattern) {
  const target = page.getByRole("button", { name: pattern }).first();
  if ((await target.count()) === 0) return false;
  if (!(await target.isVisible().catch(() => false))) return false;
  return !(await target.isDisabled().catch(() => true));
}

/**
 * Fill every visible, enabled, empty text field with a plausible value.
 *
 * Onboarding has a free-text step ("Your host university" asks for a city and a
 * university) whose Continue button stays disabled until both are filled. A
 * walker that only clicks buttons stalls there forever — which is the
 * `known_harness_issue` recorded in config/current-state.yaml.
 *
 * The value is taken from the placeholder (`e.g. National University of
 * Singapore` -> `National University of Singapore`), so the harness fills
 * something meaningful rather than a literal "test".
 */
async function fillEmptyInputs(scope) {
  const fields = scope.locator("input[type='text'], input[type='email'], input:not([type]), textarea");
  const total = await fields.count();
  let filled = 0;
  for (let index = 0; index < total && index < 12; index += 1) {
    const field = fields.nth(index);
    if (!(await field.isVisible().catch(() => false))) continue;
    if (await field.isDisabled().catch(() => true)) continue;
    const current = (await field.inputValue().catch(() => "")) || "";
    if (current.trim()) continue;
    const placeholder = ((await field.getAttribute("placeholder").catch(() => "")) || "").replace(/^e\.g\.\s*/i, "").trim();
    await field.fill(placeholder || "Singapore").catch(() => {});
    filled += 1;
  }
  return filled;
}

/**
 * True while the onboarding flow is still on screen.
 *
 * A stable hook is the primary signal. The text markers it replaced were a list of
 * known step titles, and the list was wrong: it named "Where are you from?" but not
 * "Where are you going?", so the host-country step read as "not onboarding". Because
 * `AppShell` mounts the rail around every screen — onboarding included — the walker
 * then saw navigation with no recognised onboarding text and reported that
 * onboarding had finished while the country picker was plainly on screen. Any new
 * step would have reintroduced the same false pass; an explicit hook cannot.
 */
const ONBOARDING_MARKERS = [/Where are you from\?/i, /Where are you going\?/i, /Your home country/i, /Your host country/i, /Try YapYep/i, /Who are you going as/i];

export async function onboardingVisible(page) {
  if (await page.locator('[data-testid="onboarding"]').first().isVisible().catch(() => false)) return true;
  // Fallback for any build that predates the hook.
  for (const marker of ONBOARDING_MARKERS) {
    if (await page.getByText(marker).first().isVisible().catch(() => false)) return true;
  }
  return false;
}

/**
 * Completion that survives a load race.
 *
 * The rail mounts before the onboarding content, so a single observation can see
 * navigation with no onboarding text and conclude the flow finished. Requiring the
 * answer to hold across a short settle removes that false positive.
 */
async function confirmedShell(page, settleMs = 1200) {
  if (!(await shellReached(page))) return false;
  await page.waitForTimeout(settleMs);
  return shellReached(page);
}

export async function shellReached(page) {
  const nav = await page.getByRole("button", { name: "Lens" }).first().isVisible().catch(() => false);
  if (!nav) return false;
  return !(await onboardingVisible(page));
}

/**
 * Drive anonymous onboarding until the five-tab shell is reachable.
 *
 * Retries once with a reload: the first page load in a fresh dev server can be
 * racing a cold module compile, which makes the welcome screen appear late and
 * the walker give up on a flow that actually works.
 */
export async function completeOnboarding(page, { maxSteps = 40, firstScreenTimeoutMs = 30_000, attempts = 2 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const reached = await walkOnboarding(page, { maxSteps, firstScreenTimeoutMs });
    if (reached) {
      /*
       * Confirm rather than trust. The desktop rail renders before the onboarding
       * content does, so a single check can see navigation with no onboarding text
       * yet and report success during a load race — which made a desktop run claim
       * it had reached the shell while the country picker was still coming up.
       */
      await page.waitForTimeout(1500);
      if (await confirmedShell(page)) {
        const closeGuide = page.getByRole("button", { name: "Close guide", exact: true });
        if (await closeGuide.isVisible().catch(() => false)) await closeGuide.click();
        return true;
      }
    }
    if (attempt < attempts - 1) {
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(4000);
    }
  }
  return false;
}

async function walkOnboarding(page, { maxSteps, firstScreenTimeoutMs }) {
  // A cold Vite start compiles modules on first request, so the welcome screen
  // can take far longer than a warm reload. Wait for it explicitly.
  await page
    .getByRole("button", { name: /Try YapYep|Start my journey/ })
    .first()
    .waitFor({ state: "visible", timeout: firstScreenTimeoutMs })
    .catch(() => {});

  await clickInWorkspace(page, [/Try YapYep|Start my journey/], 10000);

  /*
   * A screen can be momentarily un-clickable for a legitimate reason: the welcome
   * button disables itself to "Starting securely…" while the anonymous session is
   * created, and every option on it is then either disabled or a sign-in path the
   * walker must not take. Treating one such moment as "the flow is over" ended the
   * walk on the very first step and reported that onboarding had failed. Only
   * conclude after several consecutive idle steps.
   */
  const MAX_IDLE_STEPS = 8;
  let idleSteps = 0;

  /*
   * Patterns that select an option rather than advance the flow. They toggle, so
   * clicking the same one twice on one screen undoes the selection. At 1440px the
   * walker re-clicked "Speak with confidence" until the step budget ran out, leaving
   * the goals step on screen with Continue still disabled — the stall was the
   * harness toggling its own answer off, not a product fault.
   */
  const OPTION_PATTERNS = [/Speak with confidence/, /^Coffee$/, /^Library$/];
  const ADVANCE_PATTERNS = [
    /Create my Passport/,
    /Continue as guest/,
    /Continue with email/i,
    /See your adaptation map/,
    /Generate my Passport/,
    /Enter YapYep/,
    /^Continue$/,
    /^Next$/,
    /^Skip$/,
  ];

  let screenSignature = "";
  let clickedOnScreen = new Set();

  /** Click the first pattern not already used on this screen, and remember it. */
  async function clickOnce(patterns, timeout = 2500) {
    const remaining = patterns.filter((pattern) => !clickedOnScreen.has(String(pattern)));
    if (!remaining.length) return null;
    const picked = await clickInWorkspace(page, remaining, timeout);
    if (picked) clickedOnScreen.add(picked);
    return picked;
  }

  for (let step = 0; step < maxSteps; step += 1) {
    /*
     * Confirm, do not sample. Immediately after "Try YapYep" the rail is already
     * painted while the first onboarding screen has not rendered yet, so a single
     * `shellReached` reads navigation with no onboarding text and reports the flow
     * finished. `completeOnboarding` rejects that answer, retries, and hits the same
     * race — which is why desktop reported "shell never appeared" while the country
     * picker was plainly on screen. Only a reading that survives a settle counts.
     */
    if (await confirmedShell(page)) return true;
    await page.waitForTimeout(250);

    // Selecting an option does not change the visible text, so this signature stays
    // stable across a toggle — which is what makes it a useful key for "same screen".
    const signature = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 80);
    if (signature !== screenSignature) {
      screenSignature = signature;
      clickedOnScreen = new Set();
    }

    // A free-text step gates its Continue button behind input, so fill first.
    // Scoped, so a rail search box is never mistaken for an onboarding field.
    await fillEmptyInputs((await workspace(page).count()) > 0 ? workspace(page) : page);
    const arrival = page.getByRole("textbox", { name: "Arrival date", exact: true });
    if (await arrival.isVisible().catch(() => false) && !await arrival.inputValue()) {
      const day = new Date(); day.setDate(day.getDate() + 10);
      await arrival.fill(day.toISOString().slice(0, 10));
    }

    const country = await clickOnce([/Viet Nam/, /Singapore/, /Thailand/, /Malaysia/, /Indonesia/, /Philippines/]);
    if (country) {
      await clickInWorkspace(page, [/^Continue$/, /^Next$/], 4000);
      idleSteps = 0;
      continue;
    }

    const option = await clickOnce(OPTION_PATTERNS);
    if (option) {
      // Selecting an option normally enables Continue, so advance in the same step
      // rather than looping and clicking the same chip again.
      await clickInWorkspace(page, [/^Continue$/, /^Next$/], 4000);
      idleSteps = 0;
      continue;
    }

    const advanced = await clickOnce(ADVANCE_PATTERNS);
    if (advanced) {
      idleSteps = 0;
      continue;
    }

    // Option grids: pick any enabled, non-navigation button not already used.
    const buttons = ((await workspace(page).count()) > 0 ? workspace(page) : page).getByRole("button");
    const total = await buttons.count();
    let picked = false;
    for (let index = 0; index < total && index < 30; index += 1) {
      const candidate = buttons.nth(index);
      const label = ((await candidate.innerText().catch(() => "")) || "").trim();
      if (!label || NAV.test(label)) continue;
      if (FORBIDDEN.test(label)) continue;
      if (clickedOnScreen.has(label)) continue;
      if (await candidate.isDisabled().catch(() => true)) continue;
      try {
        await candidate.click({ timeout: 1200 });
        clickedOnScreen.add(label);
        picked = true;
        break;
      } catch {
        /* keep looking */
      }
    }

    if (picked) {
      idleSteps = 0;
      continue;
    }

    idleSteps += 1;
    if (idleSteps >= MAX_IDLE_STEPS) return confirmedShell(page);
  }


  // Ran out of steps rather than idle time; report what the page actually shows.
  return confirmedShell(page);
}

/** Horizontal-overflow measurement for the frozen breakpoints. */
export async function overflowMetrics(page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
}

export const VIEWPORTS = [
  { name: "390x844", width: 390, height: 844 },
  { name: "430x932", width: 430, height: 932 },
  { name: "768", width: 768, height: 1024 },
  { name: "1440x900", width: 1440, height: 900 },
];
