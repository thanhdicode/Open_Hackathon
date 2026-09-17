/**
 * Phase 5 — import the provided seed pack into Appwrite.
 *
 * WHAT THIS IS
 *
 * The user supplied `yapyep_phase5_seed_pack.json`: 15 researched real POIs
 * around UM / NUS / UI, 12 synthetic community profiles, 10 synthetic posts, and
 * the safety defaults. This script turns that file into rows.
 *
 * THE RULE IT EXISTS TO ENFORCE
 *
 * Synthetic people and posts must never be mistakable for verified real students.
 * Every demo row carries `is_demo_seed = 1`, `seed_origin = "demo"` and an
 * explicit `verification` value, and the client renders a "Demo" marker from
 * those fields. The seeded rows are readable by signed-in students but writable
 * by nobody, because the seed profiles have no real Appwrite account behind them
 * — an immutable fixture cannot be edited into something misleading.
 *
 * COUNTS ARE DERIVED, NEVER DECORATED
 *
 * A post's `reaction_count` is not a nice-looking number typed into the file: it
 * is written as the exact number of `post_reactions` rows that were seeded for
 * that post, and `verify-phase5.mjs` asserts the two agree. The same holds for
 * comments, saves and place stories. A demo that shows "32 reactions" over three
 * rows is a lie the UI tells, and this project has already been burned once by a
 * pipeline that reported writes it had not made.
 *
 * COORDINATES
 *
 * The seed pack ships addresses with `geocode_on_seed: true` and no lat/lng. The
 * script first tries to match each anchor against the real OSM rows produced by
 * `bootstrap-osm.mjs` — if the anchor is genuinely at the campus, OSM has it and
 * the two layers agree by construction. Only an unmatched anchor falls back to
 * Nominatim, one request per second, which is within the OSMF policy for a small
 * number of seed addresses. No coordinate is ever invented.
 *
 * Idempotent: every row id derives from the seed id, so a re-run is a no-op.
 *
 * Usage:
 *   node --env-file=.env.local scripts/phase5/seed.mjs
 *   node --env-file=.env.local scripts/phase5/seed.mjs --dry-run
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Client, ID, Permission, Query, Role, TablesDB } from "node-appwrite";

const SEED_PACK = "seed/phase5/yapyep_phase5_seed_pack.json";
const MEDIA_MANIFEST = "seed/phase5/yapyep_phase5_media_manifest.json";
const CAMPUS_CONFIG = "config/phase5-campuses.json";
const OSM_CACHE = "docs/evidence/phase5/osm-bootstrap.json";
const OUT_PATH = "docs/evidence/phase5/seed-report.json";

const PROFILES = "student_social_profiles";
const POSTS = "community_posts";
const POST_MEDIA = "post_media";
const REACTIONS = "post_reactions";
const COMMENTS = "post_comments";
const SAVED_POSTS = "saved_posts";
const CONTRIBUTIONS = "place_contributions";
const PLACE_SAVES = "place_saves";
const FOLLOWS = "follows";
const PLACES = "places";
const UNIVERSITIES = "universities";

const dryRun = process.argv.includes("--dry-run");
const seedPack = JSON.parse(readFileSync(SEED_PACK, "utf8"));
const mediaManifest = JSON.parse(readFileSync(MEDIA_MANIFEST, "utf8"));
const campusConfig = JSON.parse(readFileSync(CAMPUS_CONFIG, "utf8"));
const osmCache = existsSync(OSM_CACHE) ? JSON.parse(readFileSync(OSM_CACHE, "utf8")) : { corridors: [] };

const campusBySeedId = new Map(campusConfig.campuses.map((campus) => [campus.campus_id, campus]));
const campusByUniversity = new Map(campusConfig.campuses.map((campus) => [campus.university_id, campus]));

const client = new Client()
  .setEndpoint(process.env.VITE_APPWRITE_ENDPOINT)
  .setProject(process.env.VITE_APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_KEY);
const tables = new TablesDB(client);
const databaseId = process.env.VITE_APPWRITE_DATABASE_ID;

/** Deterministic pseudo-random in [0,1) so a re-run reproduces the same fixtures. */
function hashUnit(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

const normalise = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
const DAY_MS = 86400000;

/*
 * Timestamps are relative to the run, not to a frozen epoch.
 *
 * The Phase 5 version anchored every row to a fixed 2026-08-18 and advanced one
 * step per row. That was fine for ten posts; at forty-four the last ones land
 * three months *after* the seed runs, so the feed shows posts dated in the
 * future and the ranker's recency decay behaves backwards. Spreading the corpus
 * across the ~nine weeks ending a few hours ago keeps "newest first" true
 * whenever the seed is run, and keeps an older post competitive without letting
 * it look current.
 */
const SEED_WINDOW = {
  oldest: Date.now() - 63 * DAY_MS,
  newest: Date.now() - 6 * 3600000,
};

/** Position `index` of `total` along the corpus timeline. */
function seededDate(index, total = 12) {
  const span = SEED_WINDOW.newest - SEED_WINDOW.oldest;
  const progress = total <= 1 ? 1 : index / (total - 1);
  return new Date(SEED_WINDOW.oldest + progress * span).toISOString();
}

/* ------------------------------------------------------------------ *
 * 1. Resolve POI coordinates
 * ------------------------------------------------------------------ */
const osmPlaces = [];
for (const corridor of osmCache.corridors ?? []) {
  for (const place of corridor.places ?? []) osmPlaces.push({ ...place, campus_id: corridor.campus_id });
}

/**
 * Categories that may legitimately describe the same physical place.
 *
 * The seed pack calls a campus café "hangout"; OSM tags it `amenity=cafe`, which
 * categorises as "coffee". Both are right, so an exact category equality test
 * would reject a correct match. Campus is deliberately compatible with nothing
 * but itself: "Universiti Malaya" is the campus, "Universiti Malaya Central
 * Library" is the library, and treating those as interchangeable is exactly the
 * mistake this table exists to prevent.
 */
const CATEGORY_COMPATIBILITY = {
  campus: ["campus"],
  study: ["study"],
  food: ["food", "coffee", "hangout"],
  coffee: ["coffee", "food", "hangout"],
  hangout: ["hangout", "coffee", "food"],
  health: ["health", "pharmacy"],
  pharmacy: ["pharmacy", "health"],
  banking: ["banking"],
  transport: ["transport"],
  culture: ["culture"],
  religion: ["religion"],
  studentlife: ["studentlife"],
};

/** Meaningful words for comparison. Short words carry no signal and cause false hits. */
function nameTokens(value) {
  return [...new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4 && !["with", "near", "area", "centre", "center"].includes(token)),
  )];
}

/**
 * Match a curated anchor to the OSM row for the same physical place.
 *
 * THE BUG THIS REPLACES
 *
 * The first version accepted any substring containment in either direction, so:
 *   "24 Hours Study Area, UM Library" matched an OSM node named "A"
 *   "Universiti Malaya Central Library" matched the campus boundary polygon
 *   "Makan Malah @ NUS" matched a node named "Mala"
 *
 * Each of those wrote a real, recognisable place name onto coordinates that
 * belong to something else — a failure that looks like success in every report.
 * Anchors now require a compatible category AND either an exact normalised name
 * or at least two shared meaningful words, so a short generic string can no
 * longer win. An anchor that fails falls through to Nominatim, and one that fails
 * both is dropped rather than pinned to the wrong building.
 */
function matchOsm(poi) {
  const wanted = normalise(poi.name);
  const wantedTokens = nameTokens(poi.name);
  const compatible = CATEGORY_COMPATIBILITY[poi.category] ?? [poi.category];
  const pool = osmPlaces.filter((place) => place.campus_id === poi.campus_id);

  let best = null;
  let bestScore = 0;
  for (const place of pool) {
    if (!compatible.includes(place.category)) continue;

    const candidate = normalise(place.name);
    if (!candidate) continue;

    if (candidate === wanted) {
      // Exact name and compatible category: as certain as this can get.
      const score = 1000 + (place.category === poi.category ? 50 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = place;
      }
      continue;
    }

    const candidateTokens = nameTokens(place.name);
    const shared = wantedTokens.filter((token) => candidateTokens.includes(token));
    if (shared.length < 2) continue;

    const score = shared.length * 10 + (place.category === poi.category ? 5 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = place;
    }
  }

  return best ? { place: best, score: bestScore } : null;
}

const NOMINATIM_DELAY_MS = 1100;
const OVERPASS_RADIUS_M = campusConfig.overpass.radius_m;

function metresBetween(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * A geocode lookup that cannot abort the seed.
 *
 * The first live run of this script died on an unhandled `ECONNRESET` from
 * Nominatim, halfway through anchor resolution, leaving the database partly
 * seeded and no report written. A network failure here is expected rather than
 * exceptional — Nominatim resets connections under load — and the contract
 * already covers it: an anchor that cannot be geocoded is dropped and reported.
 * Retrying briefly and then returning null turns a fatal crash into a recorded
 * degradation.
 *
 * The anchors that still reach this path are the ones with no OpenStreetMap
 * match at all; every demo-corridor anchor resolves from the cached OSM data
 * without touching the network.
 */
async function nominatim(query, attempt = 1) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "YapYep-Hackathon-Demo/1.0 (contact: demo@yapyep.app)" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;
    const results = await response.json();
    if (!results[0]) return null;
    return { lat: Number(results[0].lat), lng: Number(results[0].lon), display: results[0].display_name };
  } catch (error) {
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      return nominatim(query, attempt + 1);
    }
    console.warn(`  nominatim "${query}" gave up after ${attempt} attempts: ${error.message}`);
    return null;
  }
}

/**
 * Geocode one anchor, with a distance guard that makes the fallback safe.
 *
 * A bare-name lookup is genuinely dangerous: "Perpustakaan Universitas Indonesia"
 * resolves to a library at Universitas Diponegoro, ~400 km away in Semarang.
 * Accepting that would put a real UI place name on a Central Java coordinate and
 * every report would still read "resolved". So a hit is only accepted if it lands
 * inside the same radius the Overpass query used — outside it, the answer is a
 * different place that happens to share a name.
 *
 * Query order is most-specific first, and the whole sequence is bounded at two
 * requests per unmatched anchor, which keeps this inside the OSMF policy for
 * resolving a small number of seed addresses.
 */
async function geocode(poi, campus) {
  const attempts = [poi.address, `${poi.name}, ${campus.city}`];
  for (const attempt of attempts) {
    if (!attempt) continue;
    const hit = await nominatim(attempt);
    await new Promise((resolve) => setTimeout(resolve, NOMINATIM_DELAY_MS));
    if (!hit) continue;
    const distance = metresBetween(campus.center, hit);
    if (distance > OVERPASS_RADIUS_M) {
      console.log(`  ${poi.id}: "${attempt}" resolved ${Math.round(distance / 1000)} km away (${hit.display.slice(0, 50)}) — rejected as a different place`);
      continue;
    }
    return { ...hit, query: attempt, distance };
  }
  return null;
}

console.log("== resolving seed POI coordinates");
const resolvedPois = [];
for (const [index, poi] of seedPack.poi_seeds.entries()) {
  const campus = campusBySeedId.get(poi.campus_id);
  if (!campus) throw new Error(`${poi.id}: unknown campus_id ${poi.campus_id}`);

  const osm = matchOsm(poi);
  if (osm) {
    console.log(`  ${poi.id}: matched OSM ${osm.place.osm_type}/${osm.place.osm_id} "${osm.place.name}" (score ${osm.score})`);
    resolvedPois.push({
      ...poi,
      lat: Number(osm.place.latitude),
      lng: Number(osm.place.longitude),
      osm_type: osm.place.osm_type,
      osm_id: osm.place.osm_id,
      coordinate_source: "osm_match",
      matched_osm_name: osm.place.name,
    });
    continue;
  }

  if (dryRun) {
    console.log(`  ${poi.id}: NO OSM MATCH (dry run — skipping geocode)`);
    resolvedPois.push({ ...poi, lat: null, lng: null, coordinate_source: "unresolved" });
    continue;
  }

  const hit = await geocode(poi, campus);
  if (!hit) {
    // An anchor with no coordinate is dropped rather than placed at the campus
    // centre, which would put a real name on the wrong building.
    console.log(`  ${poi.id}: NO OSM MATCH and Nominatim found nothing within ${OVERPASS_RADIUS_M} m — DROPPED`);
    resolvedPois.push({ ...poi, lat: null, lng: null, coordinate_source: "unresolved" });
    continue;
  }
  console.log(`  ${poi.id}: geocoded via Nominatim (${hit.distance | 0} m from campus) -> ${hit.lat},${hit.lng}`);
  resolvedPois.push({ ...poi, lat: hit.lat, lng: hit.lng, osm_type: null, osm_id: null, coordinate_source: "nominatim", geocode_query: hit.query });
}

const usablePois = resolvedPois.filter((poi) => poi.lat !== null);
console.log(`  ${usablePois.length}/${resolvedPois.length} anchors have coordinates`);

/**
 * Only these places will exist in the `places` table.
 *
 * A post that links to an anchor whose coordinates could not be verified would
 * point at a place the map cannot show — the feed would offer "Open on map" and
 * the map would have nothing to fly to. So the link is dropped rather than
 * written dangling, and every dropped link is reported instead of passing
 * silently.
 */
const persistedPlaceIds = new Set(usablePois.map((poi) => poi.id));

function linkPlace(post) {
  if (!post.place_id) return "";
  return persistedPlaceIds.has(post.place_id) ? post.place_id : "";
}

const droppedLinks = seedPack.community_posts.filter((post) => post.place_id && !persistedPlaceIds.has(post.place_id));
if (droppedLinks.length) {
  console.log(`  ${droppedLinks.length} post(s) lost their map link (anchor unresolved): ${droppedLinks.map((p) => `${p.id}->${p.place_id}`).join(", ")}`);
}

/* ------------------------------------------------------------------ *
 * 2. Media mapping
 * ------------------------------------------------------------------ */
const mediaByTarget = new Map();
for (const asset of mediaManifest.assets) {
  const localUrl = `/demo-media/${asset.file_name}`;
  for (const target of asset.map_to) {
    if (!mediaByTarget.has(target)) mediaByTarget.set(target, []);
    mediaByTarget.get(target).push({
      url: localUrl,
      file_name: asset.file_name,
      title: asset.title,
      author: asset.author,
      license: asset.license,
      attribution: asset.attribution,
      source_page: asset.source_page,
    });
  }
}

/* ------------------------------------------------------------------ *
 * 3. Write
 * ------------------------------------------------------------------ */
const report = {
  generated_at: new Date().toISOString(),
  seed_pack: SEED_PACK,
  demo_marker: { is_demo_seed: 1, seed_origin: "demo" },
  counts: {},
  poi_resolution: resolvedPois.map((poi) => ({
    id: poi.id,
    name: poi.name,
    campus_id: poi.campus_id,
    coordinate_source: poi.coordinate_source,
    lat: poi.lat,
    lng: poi.lng,
    matched_osm_name: poi.matched_osm_name ?? null,
  })),
  aggregates: [],
  errors: [],
};

async function upsert(tableId, rowId, data, permissions) {
  if (dryRun) return { $id: rowId };
  return tables.upsertRow({ databaseId, tableId, rowId, data, permissions });
}

/**
 * Write a personal-state row (a reaction, a save, a follow).
 *
 * Two hard-won facts about this table family, both of which cost a debugging
 * session:
 *
 * 1. These tables carry a unique index on (user_id, target_id), and Appwrite's
 *    PUT upsert does not report a conflict against it. When the pair already
 *    exists under a *different* row id, the upsert returns success and leaves the
 *    old row untouched — so a seed that trusts that return value reports writes
 *    that never happened. That is why this uses create-with-conflict-retry rather
 *    than `upsert`.
 *
 * 2. The row id is generated, not derived from the pair. The client derives one
 *    (`pairRowId`) because a tap must be idempotent, but a seed does not need
 *    that: it clears its own rows first. A derived id was actively harmful here —
 *    re-running produced `row_already_exists` for ids that were demonstrably
 *    absent (checked with both `getRow` and a full `listRows`), a consistency
 *    window a bootstrap script should not be built on.
 *
 * A 409 is retried with a delete first, because a delete immediately before a
 * create can leave the index briefly stale.
 */
async function putState(tableId, rowId, data, permissions) {
  if (dryRun) return { $id: rowId };

  /*
   * Create first, clear only on conflict.
   *
   * This used to delete unconditionally before every create. That was written for
   * an earlier id scheme where a row id was derived from the (user_id, target_id)
   * pair, so a re-run really could collide. Ids are now unique per write and the
   * owning rows are all cleared up front, which makes the delete a second network
   * round trip for a row that provably does not exist — 1,600 of them per seed
   * run. Keeping it on the 409 path preserves the convergent behaviour for the
   * case that actually needs it.
   */
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await tables.createRow({ databaseId, tableId, rowId, data, permissions });
    } catch (error) {
      lastError = error;
      if (error?.code !== 409) throw error;
      // Either this row id exists, or the unique index on (user_id, target_id)
      // matched a row written under a different id. Clearing the id and retrying
      // converges for the first case; the up-front clear handles the second.
      await tables.deleteRow({ databaseId, tableId, rowId }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }
  throw lastError;
}

/**
 * Remove this script's own personal-state rows before rewriting them.
 *
 * Re-running the seed has to converge on the same result. These tables carry a
 * unique index on (user_id, target_id), so when a row's derived id changes the new
 * write is no longer the same row and the old one lingers as an orphan — which is
 * exactly what happened when the over-long `${placeId}_ps_${userId}` scheme was
 * replaced. Clearing first keeps the seeded counts exact and the run repeatable.
 *
 * Scoped to `user_id` values starting with `seed_`, so a real student's saves are
 * never touched. Deletes are re-checked in a bounded loop because the API can lag
 * behind them, and a create issued before a delete has applied is rejected with a
 * spurious conflict.
 */
async function clearSeedOwnedRows(tableId, ownerColumn = "user_id") {
  if (dryRun) return 0;
  const removed = new Set();
  for (let pass = 0; pass < 5; pass += 1) {
    const page = await tables.listRows({
      databaseId,
      tableId,
      queries: [Query.startsWith(ownerColumn, "seed_"), Query.limit(500)],
    });
    if (!page.rows.length) break;
    for (const row of page.rows) {
      await tables.deleteRow({ databaseId, tableId, rowId: row.$id }).catch(() => {});
      removed.add(row.$id);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return removed.size;
}

// --- universities (so places.university_id always resolves) ---
for (const campus of campusConfig.campuses) {
  await upsert(
    UNIVERSITIES,
    campus.university_id,
    {
      university_id: campus.university_id,
      country_code: campus.country_code,
      name: campus.university_name,
      city: campus.city,
      resources: JSON.stringify([]),
      checked_at: new Date().toISOString(),
    },
    [Permission.read(Role.any())],
  );
}

// --- curated anchor places ---
/*
 * The community counters are computed BEFORE the place row is written, so a
 * place is written once with its true numbers instead of being created empty and
 * patched afterwards. A read-modify-write here would also mean an extra query per
 * anchor for no benefit.
 */
const storyByPlace = new Map();
for (const post of seedPack.community_posts) {
  const linked = linkPlace(post);
  if (!linked) continue;
  storyByPlace.set(linked, (storyByPlace.get(linked) ?? 0) + 1);
}

const placeSavers = new Map();
for (const poi of usablePois) {
  placeSavers.set(
    poi.id,
    seedPack.community_profiles.filter((profile) => hashUnit(`${profile.id}:${poi.id}:ps`) > 0.7),
  );
}

let placeWrites = 0;

/*
 * Remove curated anchors this run no longer resolves.
 *
 * The anchor set is derived, not fixed: an anchor drops out when neither OSM nor a
 * distance-checked Nominatim hit can place it. Without this the row from an earlier
 * run survives, and an anchor stored under a looser match is exactly how a real name
 * ends up pinned to the wrong building. Deleting keeps the stored set equal to the
 * set this run actually stands behind.
 *
 * A row a non-seed saver has saved is kept: deleting it would strand that student's
 * save on a place that no longer exists.
 */
const existingCurated = await tables
  .listRows({ databaseId, tableId: PLACES, queries: [Query.equal("source", "seed_pack_researched"), Query.limit(200)] })
  .catch(() => ({ rows: [] }));
let staleRemoved = 0;
for (const row of existingCurated.rows) {
  if (persistedPlaceIds.has(row.place_id)) continue;
  const realSaves = await tables
    .listRows({ databaseId, tableId: PLACE_SAVES, queries: [Query.equal("place_id", row.place_id), Query.limit(50)] })
    .catch(() => ({ rows: [] }));
  const savedByRealUser = realSaves.rows.some((save) => !String(save.user_id).startsWith("seed_"));
  if (savedByRealUser) {
    console.log(`  kept stale anchor ${row.place_id} — a real student has saved it`);
    continue;
  }
  await tables.deleteRow({ databaseId, tableId: PLACES, rowId: row.$id }).catch(() => {});
  staleRemoved += 1;
}
if (staleRemoved) console.log(`  removed ${staleRemoved} stale curated anchor(s) that no longer resolve`);

for (const poi of usablePois) {
  const campus = campusBySeedId.get(poi.campus_id);
  const data = {
    place_id: poi.id,
    country_code: poi.country,
    city: campus.city,
    name: poi.name,
    category: poi.category,
    description: `Curated student anchor near ${campus.university_name}.`,
    address: poi.address,
    latitude: String(poi.lat),
    longitude: String(poi.lng),
    university_id: campus.university_id,
    campus_id: campus.campus_id,
    osm_type: poi.osm_type ?? "",
    osm_id: poi.osm_id ?? "",
    source: "seed_pack_researched",
    source_updated_at: new Date().toISOString(),
    // Tier C — manually reviewed, but still never official guidance.
    authority_level: "C",
    status: "published",
    is_demo_seed: 1,
    student_saves: (placeSavers.get(poi.id) ?? []).length,
    student_stories: storyByPlace.get(poi.id) ?? 0,
    tags: JSON.stringify([]),
    search_text: [poi.name, poi.category, campus.city, poi.address].join(" ").toLowerCase(),
  };
  await upsert(PLACES, poi.id, data, [Permission.read(Role.any())]);
  report.aggregates.push({
    place_id: poi.id,
    student_saves: data.student_saves,
    student_stories: data.student_stories,
  });
  placeWrites += 1;
}
report.counts.places = placeWrites;

// --- demo profiles ---
const profileIds = seedPack.community_profiles.map((profile) => profile.id);
for (const [index, profile] of seedPack.community_profiles.entries()) {
  const campus = campusByUniversity.get(profile.university.toLowerCase()) ?? campusBySeedId.get(`campus_${profile.university.toLowerCase()}`);
  const data = {
    user_id: profile.id,
    display_name: profile.display_name,
    avatar_file_id: "",
    role: profile.home_country === profile.host_country ? "local" : "current_exchange",
    current_country: profile.host_country,
    city: campus?.city ?? "",
    university_id: profile.university,
    major: profile.major,
    bio: `${profile.major} student from ${profile.home_country}, currently in ${profile.host_country}. Demo fixture.`,
    interests: JSON.stringify(profile.interests),
    languages: JSON.stringify(profile.languages),
    exchange_history: JSON.stringify([{ home: profile.home_country, host: profile.host_country, university: profile.university }]),
    local_helper: profile.home_country === profile.host_country ? 1 : 0,
    discoverable: profile.discoverable ? 1 : 0,
    home_country_code: profile.home_country,
    host_country_code: profile.host_country,
    is_demo_seed: 1,
    seed_origin: "demo",
    verification: "demo_seed",
    joined_at: seededDate(index, seedPack.community_profiles.length),
    // Stored, not just promised: the client asserts this is 0 everywhere.
    live_location_shared: 0,
    updated_at: new Date().toISOString(),
  };
  /*
   * A discoverable demo profile is granted authenticated read. It is never
   * granted update or delete: there is no real account behind it, so nobody
   * should be able to rewrite a fixture into something that looks real.
   */
  const permissions = profile.discoverable
    ? [Permission.read(Role.users()), Permission.read(Role.user(profile.id))]
    : [Permission.read(Role.user(profile.id))];
  await upsert(PROFILES, profile.id, data, permissions);
}
report.counts.profiles = seedPack.community_profiles.length;

/*
 * Clear this script's own interaction rows before rewriting them, so a re-run
 * converges instead of accumulating orphans from an earlier id scheme.
 *
 * THIS MUST RUN BEFORE THE FOLLOW GRAPH IS WRITTEN. It previously sat further
 * down, after the follow loop, and silently deleted every follow row the same run
 * had just created: the report claimed 108 follows while the table stayed empty,
 * and the only visible symptom was that "You follow this student" could never
 * appear in a feed. The ordering is the entire fix, and the reported count is
 * now read back from the table rather than from the array it was built from.
 */
const cleared = {};
for (const [tableId, ownerColumn] of [
  ["post_reactions", "user_id"],
  ["saved_posts", "user_id"],
  ["place_saves", "user_id"],
  // The follow graph is owned by the follower, not by a generic `user_id`, so it
  // needs its own column name or its rows accumulate on every re-run.
  ["follows", "follower_id"],
]) {
  cleared[tableId] = await clearSeedOwnedRows(tableId, ownerColumn);
}
console.log(`  cleared stale seed interaction rows: ${JSON.stringify(cleared)}`);

/*
 * --- follow graph ---
 *
 * `follows` was declared in the schema in Phase 5 and never populated, which made
 * two things unreachable: the "You follow this student" ranking reason, and the
 * People surface's claim to show a network rather than a directory. Every demo
 * profile follows a deterministic handful of others, weighted towards its own
 * host country — a VN→SG student following other students in Singapore is the
 * network the product actually promises, whereas following someone in an
 * unrelated country is filler.
 *
 * Read permission is the follower's alone. A follow is personal state: exposing
 * who follows whom to every signed-in student would leak the graph.
 */
const followPairs = [];
for (const profile of seedPack.community_profiles) {
  const sameHost = seedPack.community_profiles.filter(
    (other) => other.id !== profile.id && other.host_country === profile.host_country,
  );
  const chosen = sameHost.filter((other) => hashUnit(`${profile.id}:${other.id}:f`) > 0.55).slice(0, 4);
  for (const target of chosen) followPairs.push([profile.id, target.id]);
}
for (const [followerId, followingId] of followPairs) {
  const followId = `fl_${ID.unique()}`;
  await putState(
    FOLLOWS,
    followId,
    {
      follow_id: followId,
      follower_id: followerId,
      following_id: followingId,
      created_at: seededDate(0, 1),
    },
    [Permission.read(Role.user(followerId))],
  );
}
/*
 * Read the count back from the table rather than reporting the array length.
 * The previous version reported what it intended to write, which is exactly how a
 * run that deleted its own follows still printed "follows: 108" and looked
 * healthy. A count that cannot disagree with reality is not evidence.
 */
report.counts.follows = await tables
  .listRows({ databaseId, tableId: FOLLOWS, queries: [Query.startsWith("follower_id", "seed_"), Query.limit(1)] })
  .then((page) => page.total)
  .catch(() => 0);

// --- posts, media, comments, reactions ---

/**
 * Reply pools, keyed by post type.
 *
 * Every sentence is written to be a plausible peer response to the post above it
 * and to claim nothing about the world: a reply can react, ask, or relate, but it
 * must never assert a rule, a price or a deadline. Those belong to the Greenbook
 * with a source and a freshness date, and a synthetic reply is not a source.
 */
const COMMENT_POOL = {
  food: [
    "Adding this to my list, I walk past here every day and never went in.",
    "How busy does it get around lunch? I only have half an hour between classes.",
    "This is the kind of thing I wish I had known in my first week.",
    "Tried it after reading this and it is now in my regular rotation.",
  ],
  study: [
    "Which floor do you usually end up on? I keep getting lost in there.",
    "Good to know it stays quiet, that is the hard part to find.",
    "Saving this for the week before exams, thank you.",
    "I have been looking for somewhere like this since I arrived.",
  ],
  place: [
    "Pinned it. This is exactly the kind of spot I would never have found alone.",
    "Went here today because of this post, it was worth it.",
    "Do you go in the morning or later? Trying to pick a quiet time.",
    "Adding this to my saved places right now.",
  ],
  tip: [
    "This is genuinely useful, saving it before I arrive.",
    "Did this work out for you long term, or just the first week?",
    "Adding this to my first-week list, thank you.",
    "Nobody told me this before I came, so thank you for writing it down.",
  ],
  warning: [
    "Wish I had read this a month ago, learned it the hard way.",
    "Good to know it is manageable, I was worried about this.",
    "Thanks for being honest about it instead of just saying it is fine.",
    "This matches my experience almost exactly.",
  ],
  question: [
    "Following this, I have the same question.",
    "I found one near the east side that works for me, happy to share.",
    "Did you get an answer? Curious about this too.",
    "Same problem here, let me know if you find somewhere.",
  ],
  moment: [
    "This is such a good feeling, glad it worked out.",
    "The first month really is like this, enjoy it.",
    "Made me smile, I had a similar week.",
    "Great to see someone settling in properly.",
  ],
  culture: [
    "This is a really good way of putting it.",
    "I noticed the same thing and could not explain it until now.",
    "Reading this made me understand something I had been missing.",
    "Thanks for writing it down, it helps to hear it from another student.",
  ],
  guide: [
    "This is the most useful thing I have read before arriving.",
    "Saving this and re-reading it on the plane.",
    "The order you put these in is exactly right.",
    "Sending this to a friend who is coming next term.",
  ],
  _default: [
    "This is genuinely useful, saving it before I arrive.",
    "Thanks for sharing this, it helps more than you think.",
    "Adding this to my notes for next week.",
    "Good to hear from someone who has actually done it.",
  ],
};

const postAggregates = [];
const commentAggregates = [];
/** The post row is built once and reused for the aggregate flush below. */
const postRowById = new Map();

for (const [index, post] of seedPack.community_posts.entries()) {
  const media = mediaByTarget.get(post.id) ?? [];
  const createdAt = seededDate(index, seedPack.community_posts.length);

  const row = {
    post_id: post.id,
    author_id: post.author_id,
    country_code: post.country,
    university_id: post.university,
    post_type: post.type,
    body: post.body,
    place_id: linkPlace(post),
    tags: JSON.stringify(buildTags(post)),
    /*
     * Enrichment is authored in the pack rather than requested from the AI
     * gateway. A seed run has to be offline, deterministic and repeatable, and a
     * demo corpus that only ranks correctly when a model call succeeds is a demo
     * that degrades on a bad network. Posts that predate the column fall back to
     * their own tags, which is the same fallback the client applies — so an
     * unenriched post still participates in topic matching instead of being
     * silently invisible to it.
     */
    topics: JSON.stringify(post.topics ?? buildTags(post)),
    journey_stage: post.stage ?? "",
    visibility: "public",
    is_demo_seed: 1,
    seed_origin: "demo",
    verification: "synthetic_demo",
    reaction_count: 0,
    comment_count: 0,
    save_count: 0,
    media_count: media.length,
    created_at: createdAt,
    updated_at: createdAt,
  };
  postRowById.set(post.id, row);

  await upsert(POSTS, post.id, row, [Permission.read(Role.users())]);

  for (const [mediaIndex, item] of media.entries()) {
    await upsert(
      POST_MEDIA,
      `${post.id}_m${mediaIndex}`,
      {
        media_id: `${post.id}_m${mediaIndex}`,
        post_id: post.id,
        kind: "image",
        file_id: "",
        url: item.url,
        width: 0,
        height: 0,
        alt_text: item.title,
        attribution: item.attribution,
        license: item.license,
        order_index: mediaIndex,
        created_at: createdAt,
      },
      [Permission.read(Role.users())],
    );
  }

  /*
   * Comments and reactions are seeded from the other demo profiles, so the
   * visible count is the number of rows that actually exist. `hashUnit` keeps
   * the selection stable across re-runs.
   */
  const commenters = seedPack.community_profiles
    .filter((profile) => profile.id !== post.author_id && hashUnit(`${post.id}:${profile.id}`) > 0.62)
    .slice(0, 3);

  /*
   * Replies are drawn from a pool keyed by what the post is about.
   *
   * The Phase 5 seed wrote the same three sentences under every post. Across ten
   * posts that is invisible; across forty-four it is the fastest way to make a
   * seeded feed read as seeded — the second time a student sees "This is
   * genuinely useful" under an unrelated post, the thread stops looking like a
   * conversation. The pool is chosen per post, and the reply within it is chosen
   * per commenter, so a re-run still reproduces the same threads exactly.
   */
  const pool = COMMENT_POOL[post.type] ?? COMMENT_POOL._default;
  for (const [commentIndex, commenter] of commenters.entries()) {
    const commentId = `${post.id}_c${commentIndex}`;
    const pick = Math.min(pool.length - 1, Math.floor(hashUnit(`${post.id}:${commenter.id}:c`) * pool.length));
    await upsert(
      COMMENTS,
      commentId,
      {
        comment_id: commentId,
        post_id: post.id,
        author_id: commenter.id,
        body: pool[pick],
        is_demo_seed: 1,
        created_at: new Date(Date.parse(createdAt) + (commentIndex + 1) * 3600000).toISOString(),
      },
      [Permission.read(Role.users())],
    );
  }
  commentAggregates.push({ post_id: post.id, count: commenters.length });

  const reactors = seedPack.community_profiles.filter((profile) => hashUnit(`${profile.id}:${post.id}:r`) > 0.45);
  for (const reactor of reactors) {
    const reactionId = `sr_${ID.unique()}`;
    await putState(
      REACTIONS,
      reactionId,
      {
        reaction_id: reactionId,
        post_id: post.id,
        user_id: reactor.id,
        kind: "like",
        created_at: createdAt,
      },
      /*
       * Readable by signed-in students, because the reaction count shown on a post
       * is derived from these rows.
       *
       * The Phase 5 version scoped read to the reactor alone, which made every
       * count private to the person who cast it: two students looking at the same
       * post saw two different numbers, and a real account reacting to a seeded
       * post could never appear in anyone else's total. A reaction on a public
       * post is a public act; delete stays with the owner.
       */
      [Permission.read(Role.users()), Permission.delete(Role.user(reactor.id))],
    );
  }

  const savers = seedPack.community_profiles.filter((profile) => hashUnit(`${profile.id}:${post.id}:s`) > 0.78);
  for (const saver of savers) {
    const saveId = `sp_${ID.unique()}`;
    await putState(
      SAVED_POSTS,
      saveId,
      { save_id: saveId, post_id: post.id, user_id: saver.id, created_at: createdAt },
      [Permission.read(Role.user(saver.id))],
    );
  }

  postAggregates.push({
    post_id: post.id,
    reactions: reactors.length,
    comments: commenters.length,
    saves: savers.length,
    media: media.length,
  });

  // --- place contributions: the post IS the story when it carries a place ---
  const linkedPlaceId = linkPlace(post);
  if (linkedPlaceId) {
    const contributionId = `ctb_${post.id}`;
    await upsert(
      CONTRIBUTIONS,
      contributionId,
      {
        contribution_id: contributionId,
        place_id: linkedPlaceId,
        author_id: post.author_id,
        note: post.body,
        media_file_id: "",
        media_url: media[0]?.url ?? "",
        tags: JSON.stringify(buildTags(post)),
        visit_context: index < 3 ? "first_week" : "settling",
        country_code: post.country,
        university_id: post.university,
        is_demo_seed: 1,
        visibility: "public",
        created_at: createdAt,
      },
      [Permission.read(Role.users())],
    );
  }
}

// --- flush aggregates so the visible number equals the stored rows ---
for (const aggregate of postAggregates) {
  const row = postRowById.get(aggregate.post_id);
  await upsert(
    POSTS,
    aggregate.post_id,
    {
      ...row,
      reaction_count: aggregate.reactions,
      comment_count: aggregate.comments,
      save_count: aggregate.saves,
      updated_at: new Date().toISOString(),
    },
    [Permission.read(Role.users())],
  );
}

report.counts.posts = seedPack.community_posts.length;
report.counts.comments = commentAggregates.reduce((sum, entry) => sum + entry.count, 0);
report.counts.reactions = postAggregates.reduce((sum, entry) => sum + entry.reactions, 0);
report.counts.post_saves = postAggregates.reduce((sum, entry) => sum + entry.saves, 0);
report.counts.media = postAggregates.reduce((sum, entry) => sum + entry.media, 0);
report.counts.contributions = seedPack.community_posts.filter((post) => linkPlace(post)).length;

// --- place saves (personal state: owner-only rows) ---
let placeSaveRows = 0;
for (const [placeId, savers] of placeSavers) {
  for (const saver of savers) {
    const saveId = `ps_${ID.unique()}`;
    await putState(
      PLACE_SAVES,
      saveId,
      { save_id: saveId, place_id: placeId, user_id: saver.id, created_at: seededDate(0) },
      [Permission.read(Role.user(saver.id))],
    );
    placeSaveRows += 1;
  }
}
report.counts.place_saves = placeSaveRows;

/*
 * Verify the counts against the tables instead of trusting the arrays.
 *
 * The follow bug settled this: the script reported 108 follows while the table
 * held none, and the report still looked healthy. Every personal-state count is
 * now read back from storage, and a mismatch is recorded as an error rather than
 * smoothed over — a count that cannot disagree with reality is not evidence.
 */
if (!dryRun) {
  report.verified_counts = {};
  for (const [tableId, query, intended] of [
    [REACTIONS, Query.startsWith("user_id", "seed_"), report.counts.reactions],
    [SAVED_POSTS, Query.startsWith("user_id", "seed_"), report.counts.post_saves],
    [PLACE_SAVES, Query.startsWith("user_id", "seed_"), report.counts.place_saves],
    [FOLLOWS, Query.startsWith("follower_id", "seed_"), report.counts.follows],
    // Seeded comments carry the demo marker and a real student's does not, so this
    // counts exactly what this script wrote without depending on an id shape.
    [COMMENTS, Query.equal("is_demo_seed", 1), report.counts.comments],
  ]) {
    const actual = await tables
      .listRows({ databaseId, tableId, queries: [query, Query.limit(1)] })
      .then((page) => page.total)
      .catch(() => -1);
    report.verified_counts[tableId] = { intended, actual };
    if (actual !== intended) report.errors.push(`${tableId}: intended ${intended}, table holds ${actual}`);
  }
}

mkdirSync(dirname(OUT_PATH), { recursive: true });
if (!dryRun) writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));

console.log("\n== seeded");
for (const [key, value] of Object.entries(report.counts)) console.log(`  ${key}: ${value}`);

if (report.verified_counts) {
  console.log("\n== verified against storage");
  for (const [tableId, entry] of Object.entries(report.verified_counts)) {
    const mark = entry.actual === entry.intended ? "ok" : "MISMATCH";
    console.log(`  ${tableId}: intended ${entry.intended}, table holds ${entry.actual} — ${mark}`);
  }
}
if (report.errors.length) {
  console.log("\n== ERRORS");
  for (const error of report.errors) console.log(`  ${error}`);
  process.exitCode = 1;
}

console.log(`\nreport: ${OUT_PATH}`);

/** Hashtags are derived from the post's own type and place, never invented freely. */
function buildTags(post) {
  const tags = [post.type];
  // Only tag "place" when the link survived resolution, or the tag promises a pin
  // the map cannot show. A place-type post derives this tag from its own type, so
  // the set collapses the repeat rather than storing the same value twice.
  if (linkPlace(post)) tags.push("place");
  tags.push(post.country.toLowerCase());
  tags.push(post.university.toLowerCase());
  return [...new Set(tags)];
}
