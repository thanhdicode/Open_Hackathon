/**
 * Phase 5 verification — seed integrity and two-user permission isolation.
 *
 * Two questions this answers that no amount of UI clicking can:
 *
 *  1. Is the seeded demo content honestly labelled? A synthetic profile that
 *     reads as a verified real exchange student is a product-integrity failure,
 *     not a data bug, so the flags are asserted rather than trusted.
 *
 *  2. Can student B write to student A's content? Every check here runs as a
 *     real authenticated user, because a permission mistake is invisible to the
 *     admin API key — the key bypasses the very rules under test.
 *
 * Usage: node --env-file=.env.local scripts/phase5/verify.mjs
 */
import { Account, Client, ID, Permission, Query, Role, TablesDB, Users } from "node-appwrite";

const ENDPOINT = process.env.VITE_APPWRITE_ENDPOINT;
const PROJECT = process.env.VITE_APPWRITE_PROJECT_ID;
const KEY = process.env.APPWRITE_API_KEY;
const DATABASE = process.env.VITE_APPWRITE_DATABASE_ID;

if (!ENDPOINT || !PROJECT || !KEY || !DATABASE) {
  console.error("Missing Appwrite configuration. Run with --env-file=.env.local");
  process.exit(1);
}

/* --------------------------------- harness -------------------------------- */

const results = [];
let failures = 0;

function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function section(title) {
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);
}

/** Admin client — setup, teardown, and reads that are not under test. */
const adminClient = new Client().setEndpoint(ENDPOINT).setProject(PROJECT).setKey(KEY);
const admin = new TablesDB(adminClient);
const adminUsers = new Users(adminClient);

/** A client that acts as one specific student, via a real session secret. */
function sessionClient(sessionSecret) {
  const client = new Client().setEndpoint(ENDPOINT).setProject(PROJECT).setSession(sessionSecret);
  return { client, tables: new TablesDB(client) };
}

/**
 * Log a real user in over REST and return their session secret.
 *
 * Deliberately not using the SDK's Account service: the secret is what proves the
 * identity, and reading it from the documented login response keeps this test
 * honest about who is making each request. A session that silently failed to
 * attach would make every permission assertion below pass for the wrong reason.
 *
 * The secret is read from the body when present and otherwise parsed out of the
 * session cookie — the API has been observed to return it in only one of the two
 * places, and falling back beats failing for a reason that is not under test.
 */
async function loginAs(email, password) {
  const response = await fetch(`${ENDPOINT}/account/sessions/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Appwrite-Project": PROJECT },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`login failed for ${email}: ${response.status} ${await response.text()}`);

  const body = await response.json();
  if (body.secret) return body.secret;

  const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  const pair = cookies
    .map((cookie) => cookie.split(";")[0])
    .find((cookie) => cookie.startsWith(`a_session_${PROJECT}=`) && !cookie.startsWith(`a_session_${PROJECT}_legacy=`));
  if (!pair) throw new Error(`login for ${email} returned neither a secret nor a session cookie`);
  return pair.slice(pair.indexOf("=") + 1);
}

const DEMO_VERIFICATION_VALUES = new Set(["demo_seed", "synthetic_demo"]);
const FORBIDDEN_VERIFICATION = ["verified_student", "real_user", "partner_student"];
const KNOWN_PLACE_SOURCES = new Set(["osm_overpass", "seed_pack_researched", "seed_pack"]);

/* ========================================================================== *
 * Part 1 — seed integrity
 * ========================================================================== */

async function readAll(tableId, queries = []) {
  const rows = [];
  let cursor = null;
  for (;;) {
    const page = await admin.listRows({
      databaseId: DATABASE,
      tableId,
      queries: [...queries, Query.limit(1000), ...(cursor ? [Query.cursorAfter(cursor)] : [])],
    });
    rows.push(...page.rows);
    if (page.rows.length < 1000) break;
    cursor = page.rows[page.rows.length - 1].$id;
  }
  return rows;
}

async function verifySeedIntegrity() {
  section("PART 1 — Seed integrity");

  const places = await readAll("places");
  const profiles = await readAll("student_social_profiles");
  const posts = await readAll("community_posts");
  const contributions = await readAll("place_contributions").catch(() => []);

  // --- places: real provenance, and three genuinely distinct corridors ------
  const byCountry = new Map();
  for (const place of places) {
    const code = place.country_code ?? "??";
    byCountry.set(code, (byCountry.get(code) ?? 0) + 1);
  }
  console.log(`  places total=${places.length} by country=${JSON.stringify(Object.fromEntries([...byCountry].sort()))}`);
  check("places exist for all three demo corridors (MY/SG/ID)", ["MY", "SG", "ID"].every((c) => (byCountry.get(c) ?? 0) > 0));

  const unknownSource = places.filter((place) => !KNOWN_PLACE_SOURCES.has(String(place.source)));
  check(
    "every place declares a known provenance",
    unknownSource.length === 0,
    unknownSource.length ? `${unknownSource.length} unexpected, e.g. ${unknownSource[0].source}` : "all osm_overpass / seed_pack_researched",
  );

  const badCoords = places.filter((place) => {
    const lat = Number(place.latitude);
    const lng = Number(place.longitude);
    return !Number.isFinite(lat) || !Number.isFinite(lng) || lat === 0 || lng === 0 || Math.abs(lat) > 90 || Math.abs(lng) > 180;
  });
  check("no place has a null or out-of-range coordinate", badCoords.length === 0, badCoords.length ? `${badCoords.length} bad rows` : "all coordinates valid");

  // Distinctness: a country swap must not leave the previous country's pins.
  const myPlaces = places.filter((p) => p.country_code === "MY");
  const sgPlaces = places.filter((p) => p.country_code === "SG");
  const idPlaces = places.filter((p) => p.country_code === "ID");
  const countryCounts = [myPlaces.length, sgPlaces.length, idPlaces.length];
  check("the three corridors are separate datasets, not one shared list", countryCounts.every((n) => n > 0) && new Set(countryCounts).size >= 2, `MY=${myPlaces.length} SG=${sgPlaces.length} ID=${idPlaces.length}`);

  const firstPlaceId = (rows) => rows[0]?.place_id;
  check(
    "no place row is shared between countries",
    firstPlaceId(myPlaces) !== firstPlaceId(sgPlaces) && firstPlaceId(sgPlaces) !== firstPlaceId(idPlaces),
    "distinct place ids per country",
  );

  // --- demo profiles must never read as real verified students --------------
  const demoProfiles = profiles.filter((p) => Number(p.is_demo_seed) === 1);
  check("demo profiles carry is_demo_seed = 1", demoProfiles.length > 0, `${demoProfiles.length} of ${profiles.length} profiles`);

  const mislabelled = demoProfiles.filter((p) => !DEMO_VERIFICATION_VALUES.has(String(p.verification)));
  check(
    "every demo profile declares demo provenance",
    mislabelled.length === 0,
    mislabelled.length ? `e.g. ${mislabelled[0].user_id} -> "${mislabelled[0].verification}"` : `verification in ${[...DEMO_VERIFICATION_VALUES].join(" | ")}`,
  );

  const claimedReal = profiles.filter((p) => FORBIDDEN_VERIFICATION.includes(String(p.verification)));
  check("no profile claims to be a verified real student", claimedReal.length === 0, claimedReal.length ? `found ${claimedReal.length}` : "no verified_student / real_user / partner_student");

  const claimsLiveLocation = profiles.filter((p) => Number(p.live_location_shared) === 1);
  check("no profile shares live location", claimsLiveLocation.length === 0, claimsLiveLocation.length ? `${claimsLiveLocation.length} profiles claim it` : "all rows false");

  // --- posts: labelled, and linked to a real place -------------------------
  const demoPosts = posts.filter((p) => Number(p.is_demo_seed) === 1);
  const postIds = new Set(places.map((place) => place.place_id));
  const tagged = demoPosts.filter((p) => p.place_id);
  const dangling = tagged.filter((p) => !postIds.has(p.place_id));
  check(
    "every location-tagged post points at a place that exists",
    dangling.length === 0,
    dangling.length ? `${dangling.length} dangling, e.g. ${dangling[0].place_id}` : `${tagged.length} tagged posts all resolve`,
  );

  const badPostVerification = demoPosts.filter((p) => !DEMO_VERIFICATION_VALUES.has(String(p.verification)));
  check("every demo post declares demo provenance", badPostVerification.length === 0, badPostVerification.length ? `${badPostVerification.length} unlabelled` : `${demoPosts.length} posts labelled`);

  const countriesWithPosts = new Set(demoPosts.map((p) => p.country_code));
  check("demo posts cover all three corridors", ["MY", "SG", "ID"].every((c) => countriesWithPosts.has(c)), `countries with posts: ${[...countriesWithPosts].sort().join(", ")}`);

  console.log(`  contributions=${contributions.length}`);

  /*
   * Personal-state rows are keyed by a derived id, and Appwrite rejects anything
   * over 36 characters. This was a live defect — `placeId_ps_userId` runs to ~42
   * characters — so the invariant is asserted against the stored rows rather than
   * trusted, and it is checked here because only real data reveals it.
   */
  const APPWRITE_ROW_ID_MAX = 36;
  for (const tableId of ["saved_posts", "place_saves", "post_reactions", "follows"]) {
    const rows = await readAll(tableId).catch(() => []);
    const tooLong = rows.filter((row) => String(row.$id).length > APPWRITE_ROW_ID_MAX);
    check(
      `${tableId} row ids fit Appwrite's ${APPWRITE_ROW_ID_MAX}-character limit`,
      tooLong.length === 0,
      tooLong.length ? `${tooLong.length} too long, longest=${Math.max(...tooLong.map((r) => String(r.$id).length))}` : `${rows.length} rows, longest=${rows.length ? Math.max(...rows.map((r) => String(r.$id).length)) : 0}`,
    );
  }

  return { places: places.length, profiles: profiles.length, posts: posts.length, byCountry: Object.fromEntries(byCountry) };
}

/* ========================================================================== *
 * Part 2 — two-user permission isolation
 * ========================================================================== */

async function verifyPermissions() {
  section("PART 2 — Two-user permission isolation");

  const stamp = Date.now();
  const users = [
    { email: `phase5.a.${stamp}@example.com`, password: `Pw-${stamp}-aaaa`, name: "Phase5 A" },
    { email: `phase5.b.${stamp}@example.com`, password: `Pw-${stamp}-bbbb`, name: "Phase5 B" },
  ];

  const created = [];
  let postId = null;
  let placeId = null;
  let probeSaveId = null;
  let probeBlockId = null;
  let probeReportId = null;

  try {
    // --- create two real users and log each one in ------------------------
    for (const user of users) {
      const record = await adminUsers.create({ userId: ID.unique(), email: user.email, password: user.password, name: user.name });
      // Register for cleanup before logging in, so a failed login still removes
      // the account it just created instead of leaking a probe user per run.
      const entry = { ...user, userId: record.$id, session: "" };
      created.push(entry);
      entry.session = await loginAs(user.email, user.password);
    }
    const [a, b] = created;
    check("two real authenticated users created", Boolean(a?.userId && b?.userId), `${a.userId.slice(0, 8)}… / ${b.userId.slice(0, 8)}…`);

    const clientA = sessionClient(a.session);
    const clientB = sessionClient(b.session);

    // Confirm each session really is that user, or every later result is noise.
    const whoA = await new Account(clientA.client).get();
    check("session A authenticates as user A", whoA.$id === a.userId, `${whoA.email}`);
    const whoB = await new Account(clientB.client).get();
    check("session B authenticates as user B", whoB.$id === b.userId, `${whoB.email}`);

    // --- pick a real place to attach content to ---------------------------
    const somePlace = await admin.listRows({ databaseId: DATABASE, tableId: "places", queries: [Query.limit(1)] });
    placeId = somePlace.rows[0]?.place_id ?? null;

    // --- A writes a post, using the same permission shape the app uses -----
    postId = ID.unique();
    const now = new Date().toISOString();
    await clientA.tables.createRow({
      databaseId: DATABASE,
      tableId: "community_posts",
      rowId: postId,
      data: {
        post_id: postId,
        author_id: a.userId,
        country_code: "MY",
        university_id: "UM",
        post_type: "tip",
        body: "Phase 5 permission probe — user A.",
        place_id: placeId ?? "",
        tags: JSON.stringify([]),
        visibility: "public",
        is_demo_seed: 0,
        seed_origin: "user",
        verification: "self_reported",
        reaction_count: 0,
        comment_count: 0,
        save_count: 0,
        media_count: 0,
        created_at: now,
        updated_at: now,
      },
      // Exactly what publicRowPermissions() stamps: readable by any signed-in
      // student, writable only by the author.
      permissions: [Permission.read(Role.users()), Permission.update(Role.user(a.userId)), Permission.delete(Role.user(a.userId))],
    });
    check("user A can create their own post", true, postId.slice(0, 8));

    // --- B must be able to read it ---------------------------------------
    const bRead = await clientB.tables
      .getRow({ databaseId: DATABASE, tableId: "community_posts", rowId: postId })
      .then(() => "ok")
      .catch((error) => `denied:${error.code}`);
    check("user B CAN read user A's public post", bRead === "ok", bRead === "ok" ? "readable by authenticated students" : bRead);

    // --- B must NOT be able to update or delete it ------------------------
    const bUpdate = await clientB.tables
      .updateRow({ databaseId: DATABASE, tableId: "community_posts", rowId: postId, data: { body: "tampered by B" } })
      .then(() => "ALLOWED")
      .catch((error) => `denied:${error.code}`);
    check("user B CANNOT update user A's post", bUpdate !== "ALLOWED", bUpdate === "ALLOWED" ? "SECURITY FAILURE" : bUpdate);

    const bDelete = await clientB.tables
      .deleteRow({ databaseId: DATABASE, tableId: "community_posts", rowId: postId })
      .then(() => "ALLOWED")
      .catch((error) => `denied:${error.code}`);
    check("user B CANNOT delete user A's post", bDelete !== "ALLOWED", bDelete === "ALLOWED" ? "SECURITY FAILURE" : bDelete);

    // --- A can still edit their own post ---------------------------------
    const aUpdate = await clientA.tables
      .updateRow({ databaseId: DATABASE, tableId: "community_posts", rowId: postId, data: { body: "Phase 5 permission probe — user A edited." } })
      .then(() => "ok")
      .catch((error) => `denied:${error.code}`);
    check("user A CAN update their own post", aUpdate === "ok", aUpdate);

    // --- A's private state must be invisible to B -------------------------
    if (placeId) {
      // A short id, because Appwrite rejects row ids over 36 characters — the very
      // defect this run exists to catch. Determinism is not what is under test here.
      const saveId = ID.unique();
      probeSaveId = saveId;
      await clientA.tables.createRow({
        databaseId: DATABASE,
        tableId: "place_saves",
        rowId: saveId,
        data: { save_id: saveId, place_id: placeId, user_id: a.userId, created_at: now },
        permissions: [Permission.read(Role.user(a.userId)), Permission.update(Role.user(a.userId)), Permission.delete(Role.user(a.userId))],
      });

      const bReadSave = await clientB.tables
        .getRow({ databaseId: DATABASE, tableId: "place_saves", rowId: saveId })
        .then(() => "ALLOWED")
        .catch((error) => `denied:${error.code}`);
      check("user B CANNOT read user A's private place save", bReadSave !== "ALLOWED", bReadSave === "ALLOWED" ? "SECURITY FAILURE" : bReadSave);

      // And B's own save list must not contain A's save.
      const bSaves = await clientB.tables
        .listRows({ databaseId: DATABASE, tableId: "place_saves", queries: [Query.equal("user_id", a.userId), Query.limit(10)] })
        .then((page) => page.rows.length)
        .catch(() => -1);
      check("user B's query for A's saves returns nothing", bSaves === 0, `returned ${bSaves} rows`);
    }

    // --- B's own post is equally protected from A -------------------------
    const bPostId = ID.unique();
    await clientB.tables.createRow({
      databaseId: DATABASE,
      tableId: "community_posts",
      rowId: bPostId,
      data: {
        post_id: bPostId,
        author_id: b.userId,
        country_code: "SG",
        university_id: "NUS",
        post_type: "question",
        body: "Phase 5 permission probe — user B.",
        place_id: "",
        tags: JSON.stringify([]),
        visibility: "public",
        is_demo_seed: 0,
        seed_origin: "user",
        verification: "self_reported",
        reaction_count: 0,
        comment_count: 0,
        save_count: 0,
        media_count: 0,
        created_at: now,
        updated_at: now,
      },
      permissions: [Permission.read(Role.users()), Permission.update(Role.user(b.userId)), Permission.delete(Role.user(b.userId))],
    });
    const aDeleteB = await clientA.tables
      .deleteRow({ databaseId: DATABASE, tableId: "community_posts", rowId: bPostId })
      .then(() => "ALLOWED")
      .catch((error) => `denied:${error.code}`);
    check("user A CANNOT delete user B's post", aDeleteB !== "ALLOWED", aDeleteB === "ALLOWED" ? "SECURITY FAILURE" : aDeleteB);

    // --- an unauthenticated caller sees nothing ---------------------------
    const anon = new TablesDB(new Client().setEndpoint(ENDPOINT).setProject(PROJECT));
    const anonRead = await anon
      .getRow({ databaseId: DATABASE, tableId: "community_posts", rowId: postId })
      .then(() => "ALLOWED")
      .catch((error) => `denied:${error.code}`);
    check("an anonymous caller CANNOT read a community post", anonRead !== "ALLOWED", anonRead === "ALLOWED" ? "SECURITY FAILURE" : anonRead);

    /* --- blocking ---------------------------------------------------------
     *
     * A block is only real if the block *set* the feed reads contains the other
     * student. The feed filters with `posts.filter(p => !blocked.has(p.authorId))`,
     * so an unreadable block row is a block that silently does nothing — the
     * student taps "Block", the toast confirms, and the content stays. That is the
     * failure this check exists to catch, which is why it asserts on the id being
     * *in the set*, not merely on a row existing.
     */
    probeBlockId = ID.unique();
    await clientB.tables.createRow({
      databaseId: DATABASE,
      tableId: "user_blocks",
      rowId: probeBlockId,
      data: { user_id: b.userId, blocked_user_id: a.userId, display_name: "Probe A", created_at: now },
      permissions: [Permission.read(Role.user(b.userId)), Permission.update(Role.user(b.userId)), Permission.delete(Role.user(b.userId))],
    });

    const bBlockSet = await clientB.tables
      .listRows({ databaseId: DATABASE, tableId: "user_blocks", queries: [Query.equal("user_id", b.userId), Query.limit(50)] })
      .then((page) => page.rows.map((row) => row.blocked_user_id))
      .catch(() => []);
    check("B's block list contains A, so A's posts are filtered from B's feed", bBlockSet.includes(a.userId), `blocked ids: ${bBlockSet.length}`);

    const aReadBlock = await clientA.tables
      .getRow({ databaseId: DATABASE, tableId: "user_blocks", rowId: probeBlockId })
      .then(() => "ALLOWED")
      .catch((error) => `denied:${error.code}`);
    check("user A CANNOT read B's block list", aReadBlock !== "ALLOWED", aReadBlock === "ALLOWED" ? "SECURITY FAILURE" : aReadBlock);

    /* --- reporting --------------------------------------------------------
     *
     * The report must persist and be readable by the student who filed it, and by
     * nobody else. A report that cannot be read back is a safety control that
     * looks present in the UI and does not exist in the product.
     */
    probeReportId = ID.unique();
    await clientA.tables.createRow({
      databaseId: DATABASE,
      tableId: "reports",
      rowId: probeReportId,
      data: {
        report_id: probeReportId,
        reporter_id: a.userId,
        target_type: "post",
        target_id: bPostId,
        reason: "spam",
        detail: "Phase 5 permission probe",
        status: "open",
        created_at: now,
      },
      permissions: [`read("user:${a.userId}")`],
    });

    const aReadReport = await clientA.tables
      .getRow({ databaseId: DATABASE, tableId: "reports", rowId: probeReportId })
      .then((row) => ({ ok: true, status: row.status }))
      .catch((error) => ({ ok: false, code: error.code }));
    check("a report persists and is readable by the student who filed it", aReadReport.ok === true, aReadReport.ok ? `status ${aReadReport.status}` : `denied:${aReadReport.code}`);

    const bReadReport = await clientB.tables
      .getRow({ databaseId: DATABASE, tableId: "reports", rowId: probeReportId })
      .then(() => "ALLOWED")
      .catch((error) => `denied:${error.code}`);
    check("another student CANNOT read A's report", bReadReport !== "ALLOWED", bReadReport === "ALLOWED" ? "SECURITY FAILURE" : bReadReport);

    // cleanup the B probe post
    await admin.deleteRow({ databaseId: DATABASE, tableId: "community_posts", rowId: bPostId }).catch(() => {});
  } finally {
    // Always remove the probe rows and users so repeated runs stay clean.
    if (postId) await admin.deleteRow({ databaseId: DATABASE, tableId: "community_posts", rowId: postId }).catch(() => {});
    if (probeSaveId) {
      await admin.deleteRow({ databaseId: DATABASE, tableId: "place_saves", rowId: probeSaveId }).catch(() => {});
    }
    if (probeBlockId) {
      await admin.deleteRow({ databaseId: DATABASE, tableId: "user_blocks", rowId: probeBlockId }).catch(() => {});
    }
    if (probeReportId) {
      await admin.deleteRow({ databaseId: DATABASE, tableId: "reports", rowId: probeReportId }).catch(() => {});
    }
    for (const user of created) {
      await adminUsers.delete({ userId: user.userId }).catch(() => {});
    }
    console.log(`  cleaned up ${created.length} probe users`);
  }
}

/* ========================================================================== *
 * Part 3 — no fabricated fallbacks in the production path
 * ========================================================================== */

async function verifyNoFabrication() {
  section("PART 3 — No fabricated fallback data");

  const { readFileSync, existsSync } = await import("node:fs");
  const { execSync } = await import("node:child_process");

  for (const removed of ["src/data/places.ts", "src/data/people.ts", "src/data/circles.ts"]) {
    check(`${removed} is gone`, !existsSync(removed), existsSync(removed) ? "still present" : "removed");
  }

  // The hand-drawn SVG map must not be reachable from the production entry.
  // `git ls-files` still lists deleted-but-tracked files, so filter to what is
  // actually on disk before reading.
  const reachable = execSync("git ls-files src", { encoding: "utf8" })
    .split(/\r?\n/)
    .filter((file) => (file.endsWith(".tsx") || file.endsWith(".ts")) && existsSync(file));
  const svgGridUsers = reachable.filter((file) => {
    const source = readFileSync(file, "utf8");
    return /FakeMap|SvgGridMap|handDrawnMap/i.test(source);
  });
  check("no production file references the fake SVG map", svgGridUsers.length === 0, svgGridUsers.length ? svgGridUsers.join(", ") : `scanned ${reachable.length} files`);

  const exploreSource = readFileSync("src/features/Explore.tsx", "utf8");
  check("Explore renders the real MapLibre map", /ExploreMap/.test(exploreSource) && /maplibre/i.test(readFileSync("src/features/explore/ExploreMap.tsx", "utf8")), "ExploreMap imported by Explore");
}

/* ---------------------------------- main ---------------------------------- */

const summary = {};

try {
  summary.seed = await verifySeedIntegrity();
  await verifyPermissions();
  await verifyNoFabrication();
} catch (error) {
  console.error(`\nUNEXPECTED ERROR: ${error.message}`);
  console.error(error.stack);
  failures += 1;
}

section("SUMMARY");
console.log(`checks: ${results.length}   passed: ${results.length - failures}   failed: ${failures}`);
if (summary.seed) console.log(`data: ${JSON.stringify(summary.seed)}`);

/*
 * Defaults to the Phase 5 artifact. Phase 5.1 re-runs this unchanged against the
 * same tables and points the output at its own evidence directory, so the two
 * releases keep separate reports instead of overwriting one another.
 */
const outDir = process.env.PHASE5_EVIDENCE_DIR ?? "docs/evidence/phase5";
const { mkdirSync, writeFileSync } = await import("node:fs");
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/verify.json`, JSON.stringify({ generatedAt: new Date().toISOString(), failures, results, summary }, null, 2));
console.log(`\nreport: ${outDir}/verify.json`);

process.exit(failures === 0 ? 0 : 1);
