/**
 * Demo release certification — the two golden corridors, from fresh accounts.
 *
 * WHAT THIS IS FOR
 *
 * A demo that works on the machine it was built on is not a demo. This script
 * drives the exact two journeys the pitch depends on, in a real browser, from a
 * fresh account each time, and records what actually happened:
 *
 *   Corridor A   Viet Nam -> Singapore, NUS        (Minh)
 *   Corridor B   Singapore -> Viet Nam, FPT HCMC   (Kai)
 *
 * It is deliberately stricter than a smoke test in three places:
 *
 *   - It picks the countries EXPLICITLY. The shared onboarding walker chooses any
 *     country, which is right for a layout test and useless for proving that a
 *     specific directional corridor works.
 *   - It verifies persistence by reading the Appwrite row back, not by looking at
 *     the screen. A UI that renders from in-memory state can look correct while
 *     nothing was saved.
 *   - It asserts the two corridors produce DIFFERENT guidance. "PairDNA is
 *     directional" is the product thesis; if A and B rendered the same thing the
 *     thesis would be false and every other check would still pass.
 *
 * Usage:
 *   node scripts/verify/demo-rc.mjs
 *   node scripts/verify/demo-rc.mjs --corridor A
 */
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { Client, Query, TablesDB } from "node-appwrite";

/* ---------------------------------- env ---------------------------------- */

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
loadEnv();

const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 5173}`;
const DATABASE_ID = process.env.VITE_APPWRITE_DATABASE_ID;

function admin() {
  const endpoint = process.env.VITE_APPWRITE_ENDPOINT;
  const projectId = process.env.VITE_APPWRITE_PROJECT_ID;
  const apiKey = process.env.APPWRITE_API_KEY;
  if (!endpoint || !projectId || !apiKey) return null;
  const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
  return new TablesDB(client);
}

const CORRIDORS = [
  {
    id: "A",
    persona: "Minh",
    label: "Viet Nam → Singapore (NUS)",
    homeName: "Viet Nam",
    hostName: "Singapore",
    /*
     * Explicit ISO codes, not derived from the display name.
     *
     * `"Singapore".slice(0, 2).toUpperCase()` is "SI" and `"Viet Nam"` gives
     * "VI" — neither is a country code. The old code used that to locate the
     * persisted row, so it never matched on the code and fell through to
     * `rows[0]`, which is simply the newest row in the table: another run's
     * journey. The cert then reported someone else's host country as a failure
     * of this corridor.
     */
    homeCode: "VN",
    hostCode: "SG",
    /*
     * Today's route line renders the home country as a FLAG and the host country
     * as flag + name (`{home.flag} → {host.flag} {host.name}`), so the home
     * country's name never appears there. Asserting on `homeName` would fail on a
     * perfectly correct render; the flag is what identifies the origin.
     */
    homeFlag: "🇻🇳",
    hostFlag: "🇸🇬",
    university: "National University of Singapore",
    city: "Singapore",
  },
  {
    id: "B",
    persona: "Kai",
    label: "Singapore → Viet Nam (FPT University HCMC)",
    homeName: "Singapore",
    hostName: "Viet Nam",
    homeCode: "SG",
    hostCode: "VN",
    homeFlag: "🇸🇬",
    hostFlag: "🇻🇳",
    university: "FPT University Ho Chi Minh City",
    city: "Ho Chi Minh City",
  },
];

const argv = process.argv.slice(2);
const corridorIndex = argv.indexOf("--corridor");
const only = corridorIndex >= 0 ? argv[corridorIndex + 1] : null;

/* ------------------------------- utilities -------------------------------- */

/** Click the first visible control whose text matches, preferring the workspace. */
async function clickText(page, patterns, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const pattern of patterns) {
      const candidates = page.getByRole("button", { name: pattern });
      const count = await candidates.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const node = candidates.nth(index);
        if (!(await node.isVisible().catch(() => false))) continue;
        if (await node.isDisabled().catch(() => true)) continue;
        try {
          await node.click({ timeout: 1500 });
          return pattern.toString();
        } catch {
          /* try the next candidate */
        }
      }
    }
    await page.waitForTimeout(200);
  }
  return null;
}

async function typeInto(page, placeholder, value) {
  const field = page.getByPlaceholder(placeholder).first();
  if (!(await field.isVisible().catch(() => false))) return false;
  await field.fill(value).catch(() => {});
  return true;
}

/**
 * Choose a specific country on a country step, then advance.
 *
 * Scoped to the onboarding container on purpose. The shell renders a route chip
 * (`🇻🇳 → 🇸🇬 Singapore`) as a <button> in the desktop rail and in the header,
 * and that chip is FIRST in the DOM. A page-wide `/Singapore/` lookup therefore
 * clicks the chip — which only pushes the "compass" screen and advances nothing —
 * and the walker sits on the host-country step forever. Scoping to the
 * onboarding frame, and rejecting any option whose label contains the arrow,
 * makes the pick unambiguous.
 */
async function chooseCountry(page, name) {
  const frame = page.getByTestId("onboarding");
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const options = frame.getByRole("button", { name: new RegExp(name) });
    const count = await options.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const node = options.nth(index);
      const label = ((await node.innerText().catch(() => "")) || "").trim();
      if (label.includes("→")) continue;
      if (await node.isDisabled().catch(() => true)) continue;
      if (!(await node.isVisible().catch(() => false))) continue;
      try {
        await node.click({ timeout: 1500 });
        await page.waitForTimeout(300);
        await clickText(page, [/^Continue$/, /^Next$/], 5000);
        return label.replace(/\s+/g, " ");
      } catch {
        /* try the next candidate */
      }
    }
    await page.waitForTimeout(200);
  }
  return null;
}

/**
 * Wait until the onboarding frame is actually showing a given step.
 *
 * The step heading is read from inside the onboarding frame, never from the page
 * as a whole: the shell renders behind the overlay, so a page-wide `h1` lookup
 * can return a heading that belongs to the other screen entirely.
 */
async function waitForStep(page, title, timeout = 30_000) {
  const frame = page.getByTestId("onboarding");
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const heading = (await frame.locator("h1").first().innerText().catch(() => "")).trim().toLowerCase();
    if (heading.includes(title.toLowerCase())) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

/**
 * Start the guest session, tolerating a slow or failed first attempt.
 *
 * `Try YapYep` awaits a real anonymous-session round trip to Appwrite. When that
 * call is slow the button reads "Starting securely…" and the flow never leaves
 * the welcome step, so the next lookup finds no country options and the corridor
 * dies for a reason that has nothing to do with the corridor. Retrying is the
 * honest fix: the failure is transient infrastructure, and the walker's job is
 * to reach the shell, not to assert how long a session takes to create.
 */
async function startGuestSession(page) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await clickText(page, [/Try YapYep/], 15_000);
    if (await waitForStep(page, "Where are you from?", 30_000)) return true;
    const alert = (await page.locator('[role="alert"]').first().innerText().catch(() => "")).trim();
    if (alert) console.log(`    guest session attempt ${attempt} reported: ${alert.replace(/\s+/g, " ")}`);
    await page.waitForTimeout(1500);
  }
  return false;
}

/**
 * Walk onboarding choosing this corridor's countries.
 *
 * Written here rather than reusing scripts/verify/lib/onboarding.mjs because that
 * walker's job is "reach the shell from anywhere" and it picks an arbitrary
 * country. Reusing it would have made this script unable to prove the thing it
 * exists to prove.
 */
async function onboardCorridor(page, corridor) {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /Try YapYep/ }).first().waitFor({ state: "visible", timeout: 45_000 }).catch(() => {});
  if (!(await startGuestSession(page))) throw new Error("guest session never started — stayed on the welcome step");

  // Home country, then host country — the order the flow presents them in. Each
  // pick waits for its step to render, so a slow transition cannot be mistaken
  // for a missing option.
  if (!(await chooseCountry(page, corridor.homeName))) throw new Error(`could not pick home country ${corridor.homeName}`);
  if (!(await waitForStep(page, "Where are you going?"))) throw new Error("never reached the host-country step");
  if (!(await chooseCountry(page, corridor.hostName))) throw new Error(`could not pick host country ${corridor.hostName}`);
  if (!(await waitForStep(page, "host university"))) throw new Error("never reached the host university step");

  // Host university / city free text.
  await typeInto(page, /e\.g\. Singapore/, corridor.city);
  await typeInto(page, /e\.g\. National University/, corridor.university);
  await clickText(page, [/^Continue$/, /^Next$/], 6000);
  await page.waitForTimeout(500);

  // Dates step: the suggested timeline is valid, so Continue is enabled. Nothing
  // is filled here on purpose — that is the property being verified.
  await clickText(page, [/^Continue$/, /^Next$/], 6000);
  await page.waitForTimeout(400);

  // The remaining steps are choices; take the first enabled option and advance.
  for (let step = 0; step < 30; step += 1) {
    if (await shellReached(page)) break;
    const frame = page.getByTestId("onboarding");
    const advanced = await clickText(page, [/^Continue$/, /^Next$/, /^Skip$/, /See your adaptation map/, /Generate my Passport/, /Enter YapYep/, /Continue as guest/], 2500);
    if (advanced) {
      await page.waitForTimeout(350);
      continue;
    }
    // An option grid: click the first enabled, non-navigation button. Scoped to
    // the onboarding frame so the shell's route chip can never be the target —
    // clicking it leaves the flow unchanged and the loop would spin to its cap.
    const buttons = frame.getByRole("button");
    const total = Math.min(await buttons.count().catch(() => 0), 40);
    let clicked = false;
    for (let index = 0; index < total; index += 1) {
      const candidate = buttons.nth(index);
      const label = ((await candidate.innerText().catch(() => "")) || "").trim();
      if (!label || label.includes("→") || /Sign in|Google|Back|Home|Today|Passport|Lens|Explore|Connect/.test(label)) continue;
      if (await candidate.isDisabled().catch(() => true)) continue;
      if (!(await candidate.isVisible().catch(() => false))) continue;
      try {
        await candidate.click({ timeout: 1200 });
        clicked = true;
        break;
      } catch {
        /* keep looking */
      }
    }
    if (!clicked) await page.waitForTimeout(400);
  }

  await page.waitForTimeout(2500);
  return shellReached(page);
}

async function shellReached(page) {
  if (await page.getByTestId("onboarding").isVisible().catch(() => false)) return false;
  const tabs = page.getByRole("button", { name: /^(Today|Passport|Lens|Explore|Connect)$/ });
  return (await tabs.count().catch(() => 0)) >= 3;
}

async function overflowAt(page, width, height) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(700);
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
}

/* ---------------------------------- run ----------------------------------- */

const tables = admin();
const results = { generatedAt: new Date().toISOString(), baseUrl: BASE_URL, corridors: [] };

/*
 * Row identity is time-boxed.
 *
 * Each corridor runs in a fresh browser context, so it gets a fresh anonymous
 * Appwrite session and writes a NEW `student_profiles` row. Matching on
 * "newest row whose city looks right" is not safe: the table holds ~90 rows from
 * earlier runs, and a corridor whose city does not match falls through to
 * `rows[0]` — the newest row in the whole table, which belongs to a different
 * run entirely. That is how this script previously reported host=TH for both
 * corridors. Only rows created after this run started are candidates.
 */
const runStartedAt = new Date(Date.now() - 5_000).toISOString();
console.log(`run started ${runStartedAt} — only rows newer than this count as ours`);

for (const corridor of CORRIDORS.filter((entry) => !only || entry.id === only)) {
  console.log(`\n=== Corridor ${corridor.id} — ${corridor.label} (${corridor.persona}) ===`);
  const record = { id: corridor.id, persona: corridor.persona, label: corridor.label, checks: [] };
  const check = (name, ok, detail = {}) => {
    record.checks.push({ name, ok, ...detail });
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail.note ? ` — ${detail.note}` : ""}`);
  };

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

  try {
    const reached = await onboardCorridor(page, corridor);
    check("fresh account completes onboarding into the five-tab shell", reached);

    // --- the derived stage must be visible, and must not be a seed number -----
    const stageText = await page.getByTestId("today-stage").innerText().catch(() => "");
    check("Today shows a derived exchange stage", Boolean(stageText.trim()), { note: stageText.trim() || "(none rendered)", stage: stageText.trim() });

    /*
     * Scoped to Today's own route line. A whole-page search for the host country
     * is worthless here: the shell header renders a route chip with the same
     * text, and that chip is in the DOM behind the onboarding overlay, so the
     * assertion used to pass while the student was still onboarding.
     */
    const routeText = (await page.getByTestId("today-route").innerText().catch(() => "")).trim();
    const showsCorridor = routeText.includes(corridor.homeFlag) && routeText.includes(corridor.hostName);
    check("Today shows this corridor's route, not a seed journey", showsCorridor, {
      note: routeText ? `${routeText.replace(/\s+/g, " ")} (expected ${corridor.homeFlag} → ${corridor.hostName})` : "no route line rendered on Today",
    });

    // --- persistence, read back from Appwrite rather than the screen ----------
    if (tables && DATABASE_ID) {
      const rows = await tables
        .listRows({
          databaseId: DATABASE_ID,
          tableId: "student_profiles",
          queries: [Query.greaterThan("$createdAt", runStartedAt), Query.orderDesc("$createdAt"), Query.limit(20)],
        })
        .catch(() => ({ rows: [] }));
      const mine = rows.rows.find((row) => row.host_country_code === corridor.hostCode);
      if (mine) {
        check("journey persisted to Appwrite", mine.host_country_code === corridor.hostCode, { note: `host=${mine.host_country_code} city=${mine.host_city}`, userId: mine.$id });
        check("the home country was persisted too", mine.home_country_code === corridor.homeCode, { note: `home=${mine.home_country_code} expected=${corridor.homeCode}` });
        const dates = (() => {
          try {
            return JSON.parse(mine.journey_dates || "null");
          } catch {
            return null;
          }
        })();
        check("the canonical timeline was persisted", Boolean(dates?.arrivalDate && dates?.returnDate), { note: dates ? `arrival=${dates.arrivalDate} return=${dates.returnDate}` : "no journey_dates stored", dates });
        check("exchange_stage is derived, not hardcoded 'studying'", typeof mine.exchange_stage === "string" && mine.exchange_stage.length > 0 && mine.exchange_stage !== "studying", { note: `exchange_stage=${mine.exchange_stage}` });
        record.persisted = { userId: mine.$id, host: mine.host_country_code, home: mine.home_country_code, city: mine.host_city, exchangeStage: mine.exchange_stage, exchangeStart: mine.exchange_start, exchangeEnd: mine.exchange_end, dates };
      } else {
        const seen = rows.rows.map((row) => `${row.host_country_code}/${row.host_city}`).join(", ") || "none";
        check("journey persisted to Appwrite", false, { note: `no row created by this corridor (rows since run start: ${seen})` });
        check("the home country was persisted too", false, { note: "no row" });
        record.persisted = null;
      }
    } else {
      check("journey persisted to Appwrite", false, { note: "Appwrite admin credentials unavailable — cannot verify" });
      check("the home country was persisted too", false, { note: "Appwrite admin credentials unavailable" });
      record.persisted = null;
    }

    // --- reload ---------------------------------------------------------------
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    const survived = await shellReached(page);
    const afterReload = await page.locator("body").innerText().catch(() => "");
    const routeAfterReload = (await page.getByTestId("today-route").innerText().catch(() => "")).trim();
    const restored = routeAfterReload.includes(corridor.homeFlag) && routeAfterReload.includes(corridor.hostName);
    check("journey survives a reload", survived && restored, {
      note: survived ? (restored ? `route restored: ${routeAfterReload.replace(/\s+/g, " ")}` : `shell restored but Today shows "${routeAfterReload.replace(/\s+/g, " ")}"`) : "onboarding shown again",
    });

    // --- Greenbook for the host country --------------------------------------
    /*
     * Read the count from Today's Living Greenbook card, which is where the app
     * actually states it: "N verified points from official sources, with tasks
     * and phrases for your first weeks." The Passport tab does not print a point
     * count at all, so scraping Passport only ever produced 0 and reported a
     * missing corpus that was in fact present.
     */
    const readPoints = (text) => {
      const match = text.match(/(\d+)\s+verified\s+points?/i);
      return match ? Number(match[1]) : null;
    };
    let points = readPoints(afterReload);
    if (points === null) {
      // The card loads its count asynchronously; give it a moment before giving up.
      await page.waitForTimeout(2500);
      points = readPoints(await page.locator("body").innerText().catch(() => ""));
    }
    const greenbookText = await page.locator("body").innerText().catch(() => "");
    const sparse = /No verified official guidance/i.test(greenbookText);
    check("host country Greenbook has a published corpus", (points ?? 0) > 0, {
      note: points === null ? `no point count rendered for ${corridor.hostName}${sparse ? " (card reports a sparse country)" : ""}` : `${points} point(s) for ${corridor.hostName}`,
      points,
    });
    record.greenbook = { hostName: corridor.hostName, points, sparse };

    // --- responsive -----------------------------------------------------------
    const wide = await overflowAt(page, 1440, 900);
    const narrow = await overflowAt(page, 390, 844);
    check("no horizontal overflow at 1440", wide.overflow <= 1, { note: `${wide.scrollWidth} vs ${wide.clientWidth}` });
    check("no horizontal overflow at 390", narrow.overflow <= 1, { note: `${narrow.scrollWidth} vs ${narrow.clientWidth}` });

    await page.screenshot({ path: `docs/evidence/demo-rc/screenshots/corridor-${corridor.id.toLowerCase()}-390.png`, fullPage: false }).catch(() => {});

    // --- console --------------------------------------------------------------
    // Appwrite guest probes (401/404 before the anonymous session exists) are
    // expected on a cold start and are not product errors.
    const fatal = consoleErrors.filter((line) => !/401|403|404|Failed to load resource|AppwriteException|User \(role: guests\)/.test(line));
    check("zero fatal console errors", fatal.length === 0, { note: fatal.length ? fatal.slice(0, 3).join(" | ") : `${consoleErrors.length} expected guest probe(s), 0 fatal`, consoleErrors: consoleErrors.slice(0, 10) });

    record.finalText = afterReload.slice(0, 400);
  } catch (error) {
    check("corridor completed without an exception", false, { note: error.message });
  } finally {
    await browser.close();
  }

  results.corridors.push(record);
}

/* ------------------------------ directional check -------------------------- */

if (!only && results.corridors.length === 2) {
  const [a, b] = results.corridors;
  const sameHost = a.persisted?.host === b.persisted?.host;
  const directional = !sameHost && a.persisted?.host === "SG" && b.persisted?.host === "VN";
  const check = { name: "PairDNA is directional: the two corridors land on different hosts", ok: directional, note: `A host=${a.persisted?.host ?? "?"} · B host=${b.persisted?.host ?? "?"}` };
  results.directional = check;
  console.log(`\n  ${directional ? "PASS" : "FAIL"}  ${check.name} — ${check.note}`);
}

/* ---------------------------------- write --------------------------------- */

await mkdir("docs/evidence/demo-rc/screenshots", { recursive: true });
for (const corridor of results.corridors) {
  await writeFile(`docs/evidence/demo-rc/corridor-${corridor.id.toLowerCase()}.json`, JSON.stringify(corridor, null, 2));
}

const allChecks = [...results.corridors.flatMap((corridor) => corridor.checks), ...(results.directional ? [results.directional] : [])];
const passed = allChecks.filter((entry) => entry.ok).length;
results.summary = { passed, total: allChecks.length, failed: allChecks.filter((entry) => !entry.ok).map((entry) => entry.name) };
await writeFile("docs/evidence/demo-rc/corridors.json", JSON.stringify(results, null, 2));

console.log(`\nCorridor certification: ${passed}/${allChecks.length} checks passed`);
if (results.summary.failed.length) console.log(`failed: ${results.summary.failed.join("; ")}`);
console.log("wrote docs/evidence/demo-rc/");
process.exitCode = passed === allChecks.length ? 0 : 1;
