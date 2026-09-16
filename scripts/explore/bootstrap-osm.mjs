/**
 * Phase 5 — Explore POI bootstrap from OpenStreetMap via Overpass.
 *
 * WHY THIS EXISTS
 *
 * The Explore map must show real places. The previous implementation invented
 * them (`genericPlaces(city)` produced "Campus Food Court", "Student Bank
 * Branch"), which is exactly the kind of fabricated content the quality gate
 * forbids. This script replaces invention with a measured query.
 *
 * WHAT IT DOES
 *
 * For each campus in `config/phase5-campuses.json` it asks Overpass for the
 * student-relevant OSM objects inside a bounded radius, normalises them into the
 * `places` table shape, deduplicates, and persists them. It runs ONCE — the
 * browser never calls Overpass and never geocodes a marker at runtime, because a
 * map that depends on a public API to draw its own pins is not a map, it is an
 * outage waiting for demo day.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * - It never scrapes Google Maps. Google's data is not ODbL and cannot be seeded
 *   into an OSM-derived layer.
 * - It never bulk-crawls public Nominatim. OSMF policy forbids systematic POI
 *   download from that service; Overpass is the service built for this query.
 * - It never invents a name. An OSM object with no `name` tag is skipped, because
 *   a pin labelled "ATM" that a human never named is indistinguishable from a
 *   fabricated one. The skip count is reported so the loss is visible.
 *
 * AUTHORITY
 *
 * These rows are written at authority `D` — "useful for discovery only" per
 * docs/04_DATA_RAG_SPEC.md §2. OSM is community-mapped, so a pin can never be
 * promoted into official guidance by the Greenbook gate, which refuses anything
 * below Tier A/B. The map says "OpenStreetMap" next to the data and means it.
 *
 * Usage:
 *   node --env-file=.env.local scripts/explore/bootstrap-osm.mjs
 *   node --env-file=.env.local scripts/explore/bootstrap-osm.mjs --campus=um,nus,ui
 *   node --env-file=.env.local scripts/explore/bootstrap-osm.mjs --dry-run
 *   node --env-file=.env.local scripts/explore/bootstrap-osm.mjs --refresh   # ignore cache
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { Client, Permission, Query, Role, TablesDB } from "node-appwrite";

const CONFIG_PATH = "config/phase5-campuses.json";
const CACHE_PATH = "docs/evidence/phase5/osm-bootstrap.json";
const PLACES_TABLE = "places";
const UNIVERSITIES_TABLE = "universities";

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(`--${name}`);
const valueOf = (name) => {
  const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const dryRun = hasFlag("dry-run");
const refresh = hasFlag("refresh");
const onlyCampuses = valueOf("campus")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;

const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const { endpoint: OVERPASS_ENDPOINT, radius_m: RADIUS_M, timeout_s: TIMEOUT_S, request_delay_ms: DELAY_MS, user_agent: USER_AGENT } = config.overpass;

/* ------------------------------------------------------------------ *
 * Tag -> category
 *
 * The brief's Explore filter list is the contract: Campus, Study, Food,
 * Coffee, Health, Pharmacy, Banking, Transport, Culture, Religion, Hangout,
 * Student Life. First match wins, so the order below IS the priority.
 * ------------------------------------------------------------------ */
const CATEGORY_RULES = [
  { category: "campus", match: (t) => t.amenity === "university" || t.amenity === "college" },
  { category: "study", match: (t) => t.amenity === "library" || t.amenity === "research_institute" },
  { category: "coffee", match: (t) => t.amenity === "cafe" },
  { category: "food", match: (t) => ["restaurant", "fast_food", "food_court", "canteen", "ice_cream", "marketplace"].includes(t.amenity) },
  { category: "pharmacy", match: (t) => t.amenity === "pharmacy" },
  { category: "health", match: (t) => ["hospital", "clinic", "doctors", "dentist"].includes(t.amenity) },
  { category: "banking", match: (t) => ["bank", "atm", "bureau_de_change"].includes(t.amenity) },
  { category: "religion", match: (t) => t.amenity === "place_of_worship" },
  { category: "transport", match: (t) => ["bus_station", "taxi", "fuel", "bicycle_rental", "car_rental"].includes(t.amenity) || ["station", "halt", "tram_stop", "subway_entrance"].includes(t.railway) || t.public_transport === "station" },
  { category: "culture", match: (t) => ["museum", "gallery", "attraction", "artwork", "viewpoint"].includes(t.tourism) || ["cinema", "theatre", "arts_centre"].includes(t.amenity) },
  { category: "hangout", match: (t) => ["bar", "pub", "nightclub", "biergarten"].includes(t.amenity) },
  { category: "studentlife", match: (t) => ["community_centre", "social_facility", "events_venue"].includes(t.amenity) || ["supermarket", "convenience", "mall", "department_store", "books", "stationery", "bakery", "greengrocer", "laundry", "sports"].includes(t.shop) || ["park", "garden", "sports_centre", "fitness_centre", "pitch", "swimming_pool"].includes(t.leisure) },
];

export function categorize(tags) {
  for (const rule of CATEGORY_RULES) {
    if (rule.match(tags)) return rule.category;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Normalisation
 * ------------------------------------------------------------------ */

/** OSM address tags are fragmented; compose what exists, never guess the rest. */
export function composeAddress(tags) {
  const parts = [
    [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" "),
    tags["addr:suburb"] || tags["addr:neighbourhood"],
    tags["addr:city"] || tags["addr:town"] || tags["addr:village"],
    tags["addr:postcode"],
    tags["addr:state"],
  ].filter((part) => part && part.trim());
  return parts.length ? parts.join(", ") : "";
}

export function pickName(tags) {
  return (tags.name || tags["name:en"] || tags["name:ms"] || tags["name:id"] || "").trim();
}

export function coordinatesOf(element) {
  if (typeof element.lat === "number" && typeof element.lon === "number") return { lat: element.lat, lng: element.lon };
  if (element.center && typeof element.center.lat === "number") return { lat: element.center.lat, lng: element.center.lon };
  return null;
}

/** Haversine, metres. Used to order by real distance from the campus. */
export function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function normalizeElement(element, campus) {
  const tags = element.tags ?? {};
  const category = categorize(tags);
  if (!category) return { skipped: "uncategorized" };
  const name = pickName(tags);
  if (!name) return { skipped: "unnamed" };
  const coords = coordinatesOf(element);
  if (!coords) return { skipped: "no_coordinates" };

  const distance = Math.round(distanceMeters(campus.center, coords));
  const place = {
    place_id: `osm_${element.type}_${element.id}`,
    osm_type: element.type,
    osm_id: String(element.id),
    name,
    category,
    country_code: campus.country_code,
    city: campus.city,
    university_id: campus.university_id,
    campus_id: campus.campus_id,
    address: composeAddress(tags),
    latitude: coords.lat.toFixed(6),
    longitude: coords.lng.toFixed(6),
    distance_m: distance,
    source: "osm_overpass",
    source_updated_at: new Date().toISOString(),
    authority_level: "D",
    status: "published",
    is_demo_seed: 0,
    student_saves: 0,
    student_stories: 0,
    tags: JSON.stringify(buildCommunityTags(tags)),
  };
  place.search_text = [place.name, place.category, place.city, place.address].filter(Boolean).join(" ").toLowerCase();
  place.description = describe(tags, category);
  return { place };
}

/**
 * Community attributes are read off OSM only when OSM actually states them.
 * Nothing is inferred: an absent tag yields no chip rather than a plausible one.
 */
export function buildCommunityTags(tags) {
  const out = [];
  const push = (key, value) => out.push({ key, value });
  if (tags.internet_access === "wlan" || tags.wifi === "yes") push("wifi", "yes");
  if (tags["internet_access:fee"] === "no") push("free_wifi", "yes");
  if (tags.opening_hours === "24/7") push("open", "24_7");
  if (tags.cuisine) push("cuisine", String(tags.cuisine).split(";")[0]);
  if (tags.halal === "yes") push("halal", "yes");
  if (tags.air_conditioning === "yes") push("aircon", "yes");
  if (tags.outdoor_seating === "yes") push("outdoor_seating", "yes");
  if (tags.fee === "no") push("free_entry", "yes");
  if (tags.wheelchair === "yes") push("wheelchair", "yes");
  if (tags["payment:cash"] === "yes") push("cash", "yes");
  if (tags["payment:cards"] === "yes") push("card", "yes");
  return out;
}

function describe(tags, category) {
  const bits = [];
  if (tags.brand) bits.push(tags.brand);
  if (tags.operator && !tags.brand) bits.push(tags.operator);
  if (tags.cuisine) bits.push(`cuisine: ${String(tags.cuisine).replace(/;/g, ", ")}`);
  if (tags.opening_hours) bits.push(`hours: ${tags.opening_hours}`);
  return bits.join(" · ").slice(0, 300) || `OpenStreetMap ${category} near campus.`;
}

/* ------------------------------------------------------------------ *
 * Deduplication
 *
 * OSM frequently maps one physical place as both a node and a building way. The
 * map must show one pin, so collapse entries whose normalised name matches AND
 * that sit within 60 m of each other, preferring the richer tag set.
 * ------------------------------------------------------------------ */
export function dedupe(places) {
  const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const kept = [];
  const removed = [];
  const byId = new Set();

  for (const place of places) {
    if (byId.has(place.place_id)) {
      removed.push({ place_id: place.place_id, reason: "duplicate_osm_id" });
      continue;
    }
    const twin = kept.find(
      (candidate) =>
        candidate.category === place.category &&
        normalize(candidate.name) === normalize(place.name) &&
        distanceMeters(
          { lat: Number(candidate.latitude), lng: Number(candidate.longitude) },
          { lat: Number(place.latitude), lng: Number(place.longitude) },
        ) < 60,
    );
    if (twin) {
      removed.push({ place_id: place.place_id, reason: `same_place_as_${twin.place_id}` });
      // Keep the entry with more stated facts rather than the first seen.
      if (JSON.parse(place.tags).length > JSON.parse(twin.tags).length) {
        Object.assign(twin, place);
      }
      continue;
    }
    byId.add(place.place_id);
    kept.push(place);
  }
  return { kept, removed };
}

/* ------------------------------------------------------------------ *
 * Overpass transport
 * ------------------------------------------------------------------ */
const OVERPASS_QUERY_BODY = `
  nwr(around:RADIUS,LAT,LNG)["amenity"~"^(library|university|college|research_institute|cafe|restaurant|fast_food|food_court|canteen|ice_cream|marketplace|pharmacy|hospital|clinic|doctors|dentist|bank|atm|bureau_de_change|place_of_worship|community_centre|social_facility|events_venue|bus_station|taxi|fuel|bicycle_rental|car_rental|cinema|theatre|arts_centre|nightclub|bar|pub|biergarten)$"];
  nwr(around:RADIUS,LAT,LNG)["railway"~"^(station|halt|tram_stop|subway_entrance)$"];
  nwr(around:RADIUS,LAT,LNG)["public_transport"="station"];
  nwr(around:RADIUS,LAT,LNG)["shop"~"^(supermarket|convenience|mall|department_store|books|stationery|bakery|greengrocer|laundry|sports)$"];
  nwr(around:RADIUS,LAT,LNG)["leisure"~"^(park|garden|sports_centre|fitness_centre|pitch|swimming_pool)$"];
  nwr(around:RADIUS,LAT,LNG)["tourism"~"^(museum|gallery|attraction|artwork|viewpoint)$"];
`;

export function buildQuery(campus) {
  const body = OVERPASS_QUERY_BODY
    .replaceAll("RADIUS", String(RADIUS_M))
    .replaceAll("LAT", String(campus.center.lat))
    .replaceAll("LNG", String(campus.center.lng));
  return `[out:json][timeout:${TIMEOUT_S}];\n(\n${body}\n);\nout center;`;
}

async function fetchOverpass(campus, attempt = 1) {
  const query = buildQuery(campus);
  const response = await fetch(OVERPASS_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT },
    body: new URLSearchParams({ data: query }),
  });
  if (!response.ok) {
    // 429/504 are normal on the public instance; back off and retry rather than
    // dropping a corridor and silently shipping a half-populated map.
    if (attempt < 4 && [429, 502, 503, 504].includes(response.status)) {
      const wait = 8000 * attempt;
      console.warn(`  overpass ${response.status} for ${campus.campus_id}; retrying in ${wait / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, wait));
      return fetchOverpass(campus, attempt + 1);
    }
    throw new Error(`Overpass ${response.status} ${response.statusText}`);
  }
  const payload = await response.json();
  return payload.elements ?? [];
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */
const useCache = !refresh && existsSync(CACHE_PATH);
const cached = useCache ? JSON.parse(readFileSync(CACHE_PATH, "utf8")) : null;

const campuses = config.campuses
  .filter((campus) => !onlyCampuses || onlyCampuses.includes(campus.university_id) || onlyCampuses.includes(campus.campus_id))
  .sort((a, b) => a.demo_priority - b.demo_priority);

if (!campuses.length) {
  console.error("No campus matched the --campus filter.");
  process.exit(1);
}

const report = {
  generated_at: new Date().toISOString(),
  endpoint: OVERPASS_ENDPOINT,
  radius_m: RADIUS_M,
  source: "OpenStreetMap via Overpass API",
  attribution: "© OpenStreetMap contributors, ODbL",
  corridors: [],
};

for (const campus of campuses) {
  console.log(`\n== ${campus.campus_id} (${campus.university_name}, ${campus.country_code})`);
  let elements;
  const cacheHit = cached?.corridors?.find((entry) => entry.campus_id === campus.campus_id);

  if (cacheHit && Array.isArray(cacheHit.elements)) {
    elements = cacheHit.elements;
    console.log(`  cache hit: ${elements.length} raw OSM elements`);
  } else {
    process.stdout.write("  querying overpass… ");
    elements = await fetchOverpass(campus);
    console.log(`${elements.length} raw OSM elements`);
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  }

  const skipped = { unnamed: 0, uncategorized: 0, no_coordinates: 0 };
  const normalized = [];
  for (const element of elements) {
    const result = normalizeElement(element, campus);
    if (result.skipped) {
      skipped[result.skipped] = (skipped[result.skipped] ?? 0) + 1;
      continue;
    }
    normalized.push(result.place);
  }

  const { kept, removed } = dedupe(normalized);
  kept.sort((a, b) => a.distance_m - b.distance_m);

  const byCategory = {};
  for (const place of kept) byCategory[place.category] = (byCategory[place.category] ?? 0) + 1;

  console.log(`  normalized ${normalized.length} → kept ${kept.length} (${removed.length} duplicates, ${skipped.unnamed} unnamed skipped, ${skipped.uncategorized} uncategorized)`);
  console.log(`  categories: ${Object.entries(byCategory).map(([k, v]) => `${k}:${v}`).join(" ")}`);

  report.corridors.push({
    campus_id: campus.campus_id,
    university_id: campus.university_id,
    country_code: campus.country_code,
    city: campus.city,
    center: campus.center,
    raw_elements: elements.length,
    kept: kept.length,
    duplicates_removed: removed.length,
    skipped,
    by_category: byCategory,
    elements: elements.length <= 4000 ? elements : undefined,
    places: kept,
  });

  if (dryRun) continue;

  const client = new Client()
    .setEndpoint(process.env.VITE_APPWRITE_ENDPOINT)
    .setProject(process.env.VITE_APPWRITE_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);
  const tables = new TablesDB(client);
  const databaseId = process.env.VITE_APPWRITE_DATABASE_ID;

  // The university row gives `places.university_id` something to resolve against.
  await tables.upsertRow({
    databaseId,
    tableId: UNIVERSITIES_TABLE,
    rowId: campus.university_id,
    data: {
      university_id: campus.university_id,
      country_code: campus.country_code,
      name: campus.university_name,
      city: campus.city,
      resources: JSON.stringify([]),
      checked_at: new Date().toISOString(),
    },
    permissions: [Permission.read(Role.any())],
  });

  let written = 0;
  /*
   * Bounded concurrency. One corridor is ~1,000 rows and there are seven, so a
   * strictly sequential loop turns a 4-minute bootstrap into a 30-minute one.
   * The pool is deliberately small: Appwrite rate-limits per project, and a
   * 429 in the middle of a bootstrap is worse than a slower bootstrap.
   */
  const POOL = Number(process.env.OSM_WRITE_CONCURRENCY ?? 6);
  const queue = [...kept];
  const failures = [];
  async function worker() {
    for (;;) {
      const place = queue.shift();
      if (!place) return;
      const { distance_m: _distance, ...data } = place;
      try {
        await tables.upsertRow({
          databaseId,
          tableId: PLACES_TABLE,
          rowId: place.place_id,
          data,
          // The table is server-scoped with no table-level grants; row security is
          // on, so this single row permission is what makes the map readable in a
          // browser. Without it the map renders zero pins and no error.
          permissions: [Permission.read(Role.any())],
        });
        written += 1;
      } catch (error) {
        failures.push({ place_id: place.place_id, error: error.message });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(POOL, queue.length) }, worker));
  console.log(`  persisted ${written} places + 1 university${failures.length ? ` (${failures.length} FAILED)` : ""}`);
  if (failures.length) console.log(`  first failure: ${JSON.stringify(failures[0])}`);
  report.corridors[report.corridors.length - 1].write_failures = failures.length;
}

mkdirSync(dirname(CACHE_PATH), { recursive: true });
if (!dryRun) {
  /*
   * Merge, do not replace. A `--campus=um` run covers one corridor, and writing
   * the report straight out would drop every other corridor's cached elements —
   * so the next full run would silently re-query Overpass for all of them (or,
   * worse, appear to have no data for them). The cache is keyed by campus_id and
   * only the corridors touched by this run are updated.
   */
  const merged = cached && !refresh
    ? {
        ...report,
        corridors: [
          ...(cached.corridors ?? []).filter((entry) => !report.corridors.some((fresh) => fresh.campus_id === entry.campus_id)),
          ...report.corridors,
        ].sort((a, b) => (a.campus_id < b.campus_id ? -1 : 1)),
      }
    : report;
  writeFileSync(CACHE_PATH, JSON.stringify(merged, null, 2));
  console.log(`\nreport: ${CACHE_PATH} (${merged.corridors.length} corridor(s) cached)`);
} else {
  console.log(`\nreport: ${CACHE_PATH} (dry run — not written)`);
}
