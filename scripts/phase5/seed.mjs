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
const SEED_EPOCH = Date.parse("2026-08-18T09:00:00.000Z");

function seededDate(index, spreadDays = 26) {
  return new Date(SEED_EPOCH + index * (spreadDays / 12) * DAY_MS).toISOString();
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

async function nominatim(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: { "user-agent": "YapYep-Hackathon-Demo/1.0 (contact: demo@yapyep.app)" },
  });
  if (!response.ok) return null;
  const results = await response.json();
  if (!results[0]) return null;
  return { lat: Number(results[0].lat), lng: Number(results[0].lon), display: results[0].display_name };
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
 * Write a personal-state row so the result is unambiguous.
 *
 * These tables carry a unique index on (user_id, target_id). Appwrite's PUT upsert
 * does not report a conflict against that index: when the pair already exists under
 * a *different* row id it returns success and leaves the old row untouched. A seed
 * that trusts that return value reports writes that never happened, which is
 * exactly what happened when the row-id scheme changed and the old rows lingered.
 *
 * Deleting first makes the intended end state explicit and lets a re-run converge.
 */
/**
 * Write a personal-state row.
 *
 * The row id is generated rather than derived from the pair. The client derives
 * one (`pairRowId`) because a tap must be idempotent, but a seed has no such need:
 * it clears its own rows first and the table's unique index on (user_id,
 * target_id) is the real guarantee. Using a derived id here turned out to be
 * actively harmful — re-running the seed produced `row_already_exists` for ids
 * that were demonstrably absent from the table (verified with both `getRow` and a
 * full `listRows`), which is a consistency window in the API that a bootstrap
 * script should not be built on.
 *
 * A 409 is still retried briefly, because a delete immediately before a create can
 * leave the index briefly stale.
 */
async function putState(tableId, rowId, data, permissions) {
  if (dryRun) return { $id: rowId };

  await tables.deleteRow({ databaseId, tableId, rowId }).catch(() => {});

  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await tables.createRow({ databaseId, tableId, rowId, data, permissions });
    } catch (error) {
      lastError = error;
      if (error?.code !== 409) throw error;
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
async function clearSeedOwnedRows(tableId) {
  if (dryRun) return 0;
  const removed = new Set();
  for (let pass = 0; pass < 5; pass += 1) {
    const page = await tables.listRows({
      databaseId,
      tableId,
      queries: [Query.startsWith("user_id", "seed_"), Query.limit(500)],
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
    joined_at: seededDate(index),
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

// --- posts, media, comments, reactions ---

/*
 * Clear this script's own interaction rows first so a re-run converges instead of
 * accumulating orphans from an earlier id scheme.
 */
const cleared = {};
for (const tableId of ["post_reactions", "saved_posts", "place_saves"]) {
  cleared[tableId] = await clearSeedOwnedRows(tableId);
}
console.log(`  cleared stale seed interaction rows: ${JSON.stringify(cleared)}`);
const postAggregates = [];
const commentAggregates = [];
/** The post row is built once and reused for the aggregate flush below. */
const postRowById = new Map();

for (const [index, post] of seedPack.community_posts.entries()) {
  const media = mediaByTarget.get(post.id) ?? [];
  const createdAt = seededDate(index);

  const row = {
    post_id: post.id,
    author_id: post.author_id,
    country_code: post.country,
    university_id: post.university,
    post_type: post.type,
    body: post.body,
    place_id: linkPlace(post),
    tags: JSON.stringify(buildTags(post)),
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

  const commentBodies = [
    "This is genuinely useful, saving it before I arrive.",
    "Did this work out for you long term, or just the first week?",
    "Adding this to my first-week list, thank you.",
  ];
  for (const [commentIndex, commenter] of commenters.entries()) {
    const commentId = `${post.id}_c${commentIndex}`;
    await upsert(
      COMMENTS,
      commentId,
      {
        comment_id: commentId,
        post_id: post.id,
        author_id: commenter.id,
        body: commentBodies[commentIndex % commentBodies.length],
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
      // Personal state: readable only by its own (nonexistent) demo owner and admin.
      [Permission.read(Role.user(reactor.id))],
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

mkdirSync(dirname(OUT_PATH), { recursive: true });
if (!dryRun) writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));

console.log("\n== seeded");
for (const [key, value] of Object.entries(report.counts)) console.log(`  ${key}: ${value}`);
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
