/**
 * Shared provisioning for browser probes that need a *real* signed-in student.
 *
 * WHY THIS EXISTS
 *
 * The onboarding walker is the obvious way to get a browser into the app, and it
 * is the wrong tool for anything that is not testing onboarding. It depends on a
 * guest session being created over the network, on a sequence of screens, and on
 * a `Try YapYep` button that can sit on "Starting securely…" indefinitely — so a
 * test about Realtime propagation or feed ranking can fail for a reason that has
 * nothing to do with what it is measuring.
 *
 * Instead, a probe account is created through the admin API and given exactly the
 * journey row the onboarding flow would have written. The browser is then handed
 * the session cookie directly and lands in the shell on first paint.
 *
 * The cookie name is read back from the login response rather than hardcoded. If
 * the server ever renames its session cookie, the failure is a clear error here
 * instead of two anonymous clients that quietly pass every assertion for the
 * wrong reason.
 */
import { Client, ID, Permission, Query, Role, Storage, TablesDB, Users } from "node-appwrite";

const DAY_MS = 86_400_000;

/*
 * Two different date shapes, and mixing them up is silent.
 *
 * `journey_dates` holds day-only `YYYY-MM-DD` strings because the app validates
 * each one against `/^\d{4}-\d{2}-\d{2}$/` before parsing. A full ISO instant
 * fails that test, `parseDay` returns null, and the derived stage collapses to
 * "before_departure" for every probe — so the timeline looks provisioned and
 * decides nothing. The two `exchange_*` datetime columns take the opposite form
 * and need a real instant.
 */
const isoDay = (offset) => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
const asInstant = (day) => `${day}T00:00:00.000Z`;

export function adminClients() {
  const endpoint = process.env.VITE_APPWRITE_ENDPOINT;
  const project = process.env.VITE_APPWRITE_PROJECT_ID;
  const database = process.env.VITE_APPWRITE_DATABASE_ID;
  const key = process.env.APPWRITE_API_KEY;
  for (const [name, value] of Object.entries({ VITE_APPWRITE_ENDPOINT: endpoint, VITE_APPWRITE_PROJECT_ID: project, VITE_APPWRITE_DATABASE_ID: database, APPWRITE_API_KEY: key })) {
    if (!value) throw new Error(`${name} is not set — run with --env-file=.env.local`);
  }
  const client = new Client().setEndpoint(endpoint).setProject(project).setKey(key);
  return {
    endpoint,
    project,
    database,
    mediaBucket: process.env.VITE_APPWRITE_COMMUNITY_MEDIA_BUCKET_ID ?? "",
    client,
    users: new Users(client),
    tables: new TablesDB(client),
    storage: new Storage(client),
  };
}

/**
 * Offsets that place a probe in a chosen exchange stage.
 *
 * The app re-derives the stage from `journey_dates` on every load — the
 * `exchange_stage` column is written but never read back — so the stage a probe
 * actually gets is decided entirely by these dates. Hardcoding one timeline made
 * every probe a mid-exchange student, which silently removed the "Worth reading
 * before your first week" branch of the ranker from every corridor test.
 *
 * `before_departure` is the default because it is the demo narrative: a student
 * who has not left yet, for whom the community's arrival stories are preparation.
 */
const STAGE_OFFSETS = {
  before_departure: { departure: 20, arrival: 45, programStart: 52, programEnd: 180, return: 190 },
  arriving_soon: { departure: -5, arrival: 9, programStart: 16, programEnd: 150, return: 160 },
  first_week: { departure: -20, arrival: -4, programStart: 3, programEnd: 140, return: 150 },
  settling_in: { departure: -30, arrival: -21, programStart: -18, programEnd: 120, return: 130 },
  studying: { departure: -70, arrival: -60, programStart: -55, programEnd: 60, return: 70 },
};

const ROLE_FOR_STAGE = {
  before_departure: "incoming",
  arriving_soon: "incoming",
  first_week: "current_exchange",
  settling_in: "current_exchange",
  studying: "current_exchange",
};

/**
 * Write the journey the onboarding flow would have produced.
 *
 * Permissions are the user's own id, matching what the app writes. An
 * admin-created row with no permissions is invisible to the very session meant to
 * read it, and the client would land back on onboarding.
 */
export async function provisionJourney(tables, database, userId, spec) {
  const now = new Date().toISOString();
  const stage = STAGE_OFFSETS[spec.stage] ? spec.stage : "before_departure";
  const offsets = STAGE_OFFSETS[stage];
  const dates = {
    departureDate: isoDay(offsets.departure),
    arrivalDate: isoDay(offsets.arrival),
    programStartDate: isoDay(offsets.programStart),
    programEndDate: isoDay(offsets.programEnd),
    returnDate: isoDay(offsets.return),
  };
  const owner = [Permission.read(Role.user(userId)), Permission.update(Role.user(userId)), Permission.delete(Role.user(userId))];

  await tables.createRow({
    databaseId: database,
    tableId: "student_profiles",
    rowId: userId,
    data: {
      user_id: userId,
      display_name: spec.name,
      home_country_code: spec.home,
      host_country_code: spec.host,
      host_city: spec.city,
      university_id: spec.university,
      languages: JSON.stringify(spec.languages),
      interests: JSON.stringify(spec.interests),
      goals: "[]",
      concerns: JSON.stringify(spec.concerns),
      journey_dates: JSON.stringify(dates),
      exchange_start: asInstant(dates.arrivalDate),
      exchange_end: asInstant(dates.returnDate),
      exchange_stage: stage,
      journey_role: ROLE_FOR_STAGE[stage],
      created_at: now,
      updated_at: now,
    },
    permissions: owner,
  });

  /*
   * `assessment_version` is a required column and the row is rejected without it.
   * The app's own writer always supplies it; a probe that omits it produces a
   * profile that looks provisioned in the logs and then fails the insert.
   */
  await tables.createRow({
    databaseId: database,
    tableId: "my_dna_profiles",
    rowId: userId,
    data: {
      user_id: userId,
      explicitness: 52,
      formality: 64,
      hierarchy_sensitivity: 66,
      conflict_openness: 48,
      relationship_orientation: 70,
      time_structure: 58,
      participation_confidence: 54,
      uncertainty_tolerance: 56,
      assessment_version: "probe-v1",
      updated_at: now,
    },
    permissions: owner,
  });
}

/**
 * Log in over REST and return everything a probe needs to act as that student.
 *
 * Two different consumers need two different things from the same login, and
 * conflating them is why this was wrong the first time:
 *
 *   the browser  needs the cookie *value* exactly as the server set it, because
 *                the Appwrite web SDK sends it with `credentials: 'include'`
 *   the SDK      needs the raw `secret` for the `X-Appwrite-Session` header
 *
 * The current API returns neither a `secret` field in the body nor a plaintext
 * cookie. The cookie value is a URL-encoded, base64 JSON envelope of the form
 * `{"id":"...","secret":"..."}` — so the secret has to be decoded out of it. A
 * probe that treated the envelope as the secret produced a session header the
 * server ignored, and every request then ran as an anonymous user.
 *
 * Returns `{ secret, cookieValue, cookieName }`.
 */
export async function loginAs(endpoint, project, email, password) {
  const response = await fetch(`${endpoint}/account/sessions/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Appwrite-Project": project },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`login failed for ${email}: ${response.status} ${await response.text()}`);

  const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  const pair = cookies
    .map((cookie) => cookie.split(";")[0])
    .find((cookie) => cookie.startsWith(`a_session_${project}=`) && !cookie.startsWith(`a_session_${project}_legacy=`));
  if (!pair) throw new Error(`login for ${email} set no a_session_${project} cookie`);

  const cookieValue = pair.slice(pair.indexOf("=") + 1);
  const body = await response.json().catch(() => ({}));

  /*
   * `??` is wrong here: the API answers with `"secret": ""` rather than omitting
   * the field, and an empty string is not nullish, so the fallback never ran and
   * the probe carried a zero-length session token. Every request then executed as
   * a guest and the SDK reported a missing `account` scope — an error that looks
   * like a permissions problem and is really a decoding one.
   */
  const bodySecret = typeof body?.secret === "string" && body.secret.length > 0 ? body.secret : null;

  return {
    cookieName: `a_session_${project}`,
    cookieValue,
    secret: bodySecret ?? decodeSessionSecret(cookieValue),
  };
}

/** Pull the raw secret out of Appwrite's URL-encoded base64 session envelope. */
function decodeSessionSecret(cookieValue) {
  try {
    const json = Buffer.from(decodeURIComponent(cookieValue), "base64").toString("utf8");
    const parsed = JSON.parse(json);
    if (typeof parsed?.secret === "string" && parsed.secret) return parsed.secret;
  } catch {
    /* fall through — the caller gets an explicit error rather than a bogus token */
  }
  throw new Error("could not decode the session secret from the login cookie; the cookie format changed");
}

/**
 * An authenticated `fetch` bound to one student's session.
 *
 * The SDK's `setSession(secret)` — which sends `X-Appwrite-Session` — is *not*
 * accepted by this deployment. Measured against the live API:
 *
 *   Cookie: a_session_<project>=<envelope>   -> 200
 *   X-Appwrite-Session: <secret>             -> 401 guests missing scopes
 *   X-Fallback-Cookies: {...}                -> 401 guests missing scopes
 *
 * Only the cookie authenticates. A probe that used `setSession` therefore ran as
 * a guest and produced permission results that were true about nobody. This
 * wrapper is the session-bearing transport for server-side assertions; the
 * browser uses the same cookie through `openCommunityClient`.
 */
export function sessionFetch(endpoint, project, account) {
  return async (path, init = {}) => {
    const response = await fetch(`${endpoint}${path}`, {
      ...init,
      headers: {
        "X-Appwrite-Project": project,
        "Content-Type": "application/json",
        Cookie: `${account.cookie.cookieName}=${account.cookie.cookieValue}`,
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: response.status, ok: response.ok, body };
  };
}

/**
 * Create, provision and authenticate one probe account.
 *
 * The caller owns cleanup: `destroyProbeAccount` removes the journey rows and the
 * account itself, and is safe to call twice.
 */
export async function createProbeAccount({ users, tables, database, endpoint, project }, label, journey) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `probe.${label.toLowerCase()}.${stamp}@example.com`;
  const password = `Pw-${stamp}-${label.toLowerCase()}`;
  const record = await users.create({ userId: ID.unique(), email, password, name: `Probe ${label}` });
  const account = { label, email, password, userId: record.$id, journey, endpoint, project };
  await provisionJourney(tables, database, account.userId, journey);
  account.cookie = await loginAs(endpoint, project, email, password);
  return account;
}

/**
 * Delete every row a probe account created, then the account.
 *
 * WHY THIS IS NOT OPTIONAL
 *
 * A probe that writes a post is indistinguishable, to the ranker, from a student
 * who did. Leftover probe posts are not inert: each one matches the demo corridor
 * exactly (right country, right university, and a post type the feed rewards), so
 * a few dozen runs of a test suite will fill the first page of the For You feed
 * with them and push the seeded demo content off it. That is both a demo failure
 * and a reason for a test to fail confusingly — a card that was there a second ago
 * is gone after the Realtime event re-runs the ranked query.
 *
 * Storage files are deleted first and by the ids recorded on the media rows, so a
 * failed cleanup cannot orphan a file whose row has already gone.
 */
export async function destroyProbeAccount({ users, tables, database, storage, mediaBucket }, account) {
  if (!account?.userId) return;
  const userId = account.userId;

  const purge = async (tableId, column) => {
    try {
      const page = await tables.listRows({
        databaseId: database,
        tableId,
        queries: [Query.equal(column, userId), Query.limit(200)],
      });
      for (const row of page.rows) {
        // `$id` is the row id Appwrite addresses deletes by; the per-table `*_id`
        // column is a separate, application-level identifier and is not always the
        // same value.
        await tables.deleteRow({ databaseId: database, tableId, rowId: row.$id }).catch(() => {});
      }
      return page.total;
    } catch {
      return -1;
    }
  };

  // 1. Storage first, keyed off the media rows that still exist.
  try {
    const posts = await tables.listRows({
      databaseId: database,
      tableId: "community_posts",
      queries: [Query.equal("author_id", userId), Query.limit(200)],
    });
    for (const post of posts.rows) {
      const media = await tables
        .listRows({ databaseId: database, tableId: "post_media", queries: [Query.equal("post_id", post.post_id), Query.limit(50)] })
        .catch(() => ({ rows: [] }));
      for (const row of media.rows) {
        if (storage && mediaBucket && row.file_id) {
          await storage.deleteFile({ bucketId: mediaBucket, fileId: row.file_id }).catch(() => {});
        }
        await tables.deleteRow({ databaseId: database, tableId: "post_media", rowId: row.media_id ?? row.$id }).catch(() => {});
      }
      await tables.deleteRow({ databaseId: database, tableId: "community_posts", rowId: post.post_id ?? post.$id }).catch(() => {});
    }
  } catch {
    // Best effort: an account that cannot be fully cleaned still must not block
    // the rest of the teardown.
  }

  // 2. Rows the probe wrote under its own identity.
  await purge("post_comments", "author_id");
  await purge("post_reactions", "user_id");
  await purge("saved_posts", "user_id");
  await purge("place_saves", "user_id");
  await purge("follows", "follower_id");
  await purge("place_contributions", "author_id");
  await purge("reports", "reporter_id");
  await purge("user_blocks", "user_id");
  await purge("student_social_profiles", "user_id");

  // 3. The journey rows and the account itself.
  await tables.deleteRow({ databaseId: database, tableId: "student_profiles", rowId: userId }).catch(() => {});
  await tables.deleteRow({ databaseId: database, tableId: "my_dna_profiles", rowId: userId }).catch(() => {});
  await users.delete({ userId }).catch(() => {});
}

/**
 * Open an authenticated browser context and land on the community feed.
 *
 * Waiting on the Connect nav button is the readiness signal: it only renders once
 * the journey has hydrated, so a probe that reaches it is genuinely signed in
 * rather than merely having loaded HTML.
 *
 * THE SESSION IS INSTALLED TWICE, ON PURPOSE.
 *
 * Appwrite is a *different origin* from the dev server, and the two mechanisms
 * fail differently:
 *
 *   the cookie        is set by Appwrite on `.sgp.cloud.appwrite.io` and travels
 *                     with each cross-site call. Setting it by hand for the dev
 *                     host does nothing, because a cookie scoped to `127.0.0.1`
 *                     is never sent to the Appwrite endpoint.
 *
 *   cookieFallback    is the SDK's localStorage escape hatch: when it is present
 *                     the SDK sends `X-Fallback-Cookies` on every request, and
 *                     the server honours it.
 *
 * Only the second is what actually authenticates in this deployment, but the
 * first is what production relies on, so both are written. The consequence of
 * getting this wrong is silent: the app sees `GET /account` answer 401, quietly
 * creates an anonymous guest session, and renders the welcome screen — and the
 * probe reports "Connect button never appeared" for what is really a session that
 * was never attached.
 *
 * `addInitScript` runs before any application code on every navigation, so the
 * fallback is in place before the SDK reads it.
 */
/**
 * Open Connect and wait for a settled feed.
 *
 * TWO TRAPS THIS HANDLES, BOTH OF WHICH LOOK LIKE A BROKEN FEED
 *
 * 1. The selected tab lives in React memory, not the URL. After `page.reload()`
 *    the app boots on Today, so a probe that reloads and then waits for
 *    `community-feed` waits forever for a screen nobody navigated to. Every
 *    reload has to re-enter Connect.
 *
 * 2. The first paint is not the last one. `load` is re-created while the journey
 *    hydrates, which re-runs its effect and briefly empties the list. "A card
 *    exists" is therefore not a readiness signal — a probe that counts on first
 *    sight reports zero on a feed that is about to render twenty.
 *
 * Waiting for two consecutive equal, non-zero counts is what makes both go away.
 */
/**
 * Dismiss any full-screen layer sitting above the shell.
 *
 * The community surfaces stack: the place sheet, then the post screen on top of
 * it. Both are `absolute inset-0`, so while either is open the bottom navigation
 * is underneath them and a tab tap is intercepted by the backdrop. Playwright
 * reports that as a 30-second click timeout, which is easy to misread as "the nav
 * is broken" when the real state is "a sheet is open".
 *
 * A back button first (that is the post screen), then a tap on the backdrop area
 * (that is the sheet). Both are best-effort: if nothing is open, this is a no-op.
 */
export async function dismissOverlays(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const back = page.getByLabel("Back").first();
    if ((await back.count()) > 0 && (await back.isVisible().catch(() => false))) {
      await back.click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(400);
      continue;
    }
    break;
  }
  // Tap the top strip, which is backdrop for any bottom sheet.
  await page.mouse.click(195, 24).catch(() => {});
  await page.waitForTimeout(400);
}

export async function openFeed(page, { timeoutMs = 60_000 } = {}) {
  await dismissOverlays(page);
  const connect = page.getByRole("button", { name: "Connect" }).first();
  await connect.waitFor({ state: "visible", timeout: 45_000 });
  await connect.click();
  /*
   * `attached`, because the container is always mounted and an empty feed has a
   * zero-height box that Playwright's default visibility check rejects.
   */
  await page.waitForSelector('[data-testid="community-feed"]', { state: "attached", timeout: 30_000 });

  const deadline = Date.now() + timeoutMs;
  let previous = -1;
  while (Date.now() < deadline) {
    const count = await page.locator('[data-testid="post-card"]').count();
    if (count > 0 && count === previous) return count;
    previous = count;
    await page.waitForTimeout(500);
  }
  return previous;
}

/**
 * Open an authenticated browser context and land on the community feed.
 *
 * Waiting on the Connect button is the readiness signal: the shell only renders
 * once the journey has hydrated, and the journey is read from `student_profiles`
 * under this student's own permissions. A guest would 404 that row and be left on
 * the welcome screen, so a probe that gets here is genuinely signed in — no
 * separate identity assertion is needed, and adding one that reads a different
 * source would be a second thing to keep in sync.
 */
export async function openCommunityClient(browser, account, baseUrl) {
  const appwriteHost = new URL(account.endpoint).hostname;
  const fallback = JSON.stringify({ [account.cookie.cookieName]: account.cookie.cookieValue });

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addCookies([
    {
      name: account.cookie.cookieName,
      value: account.cookie.cookieValue,
      domain: appwriteHost,
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "None",
    },
  ]);
  await context.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, value);
    },
    { key: "cookieFallback", value: fallback },
  );

  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await openFeed(page);
  return { context, page, errors };
}

/** Wait until a post card containing `text` is rendered. Returns ms elapsed, or null. */
export async function waitForCard(page, text, timeoutMs = 15_000) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  while (Date.now() < deadline) {
    const present = await page.evaluate(
      ({ source }) => [...document.querySelectorAll('[data-testid="post-card"]')].some((card) => card.textContent?.includes(source)),
      { source: text },
    );
    if (present) return Date.now() - started;
    await page.waitForTimeout(250);
  }
  return null;
}

/**
 * Snapshot the feed as the student actually sees it.
 *
 * Reasons are read from `post-reasons`, the element that renders them — so this
 * records what is on screen rather than what the ranker intended to return. If
 * the reasons stop being displayed, this goes empty and the evidence is
 * correspondingly empty, which is the honest outcome.
 */
export async function readFeedCards(page, limit = 8) {
  return page.evaluate(({ take }) => {
    return [...document.querySelectorAll('[data-testid="post-card"]')].slice(0, take).map((card) => {
      const text = card.textContent ?? "";
      const reasonsNode = card.querySelector('[data-testid="post-reasons"]');
      const reasons = reasonsNode ? [...reasonsNode.querySelectorAll("li, span")].map((node) => node.textContent?.trim()).filter(Boolean) : [];
      return {
        text: text.slice(0, 400),
        demo: text.includes("Demo"),
        reasons,
        place: card.querySelector('[aria-label^="Open this place"]') ? true : false,
      };
    });
  }, { take: limit });
}
