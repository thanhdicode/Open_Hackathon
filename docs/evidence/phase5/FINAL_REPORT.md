# Phase 5 — Connect + Explore: Final Report

Run date: 2026-09-16
Scope: turn Connect and Explore from demo placeholders into a polished ASEAN exchange-student
community product, in parallel with Phase 4.

Product thesis, unchanged from the brief:

| Layer | Role |
| --- | --- |
| Greenbook | verified institutional knowledge |
| YapLens / YapSim | AI interpretation and practice |
| **Connect + Explore** | **lived student experience** |

---

## 1. What changed

**Explore** no longer draws a map — it renders one. The hand-drawn SVG grid map is deleted from the
production path, not hidden behind a flag. MapLibre GL JS draws a real basemap over real
OpenStreetMap data, with clustering, category filters and a place bottom sheet carrying the
community layer.

**Connect** is no longer a people directory. The default view is a Community feed of lived
experience, with People discovery behind it. Messaging was explicitly out of scope and the existing
chat infrastructure was not touched.

The two are joined: a location-tagged post is one record that appears in the feed *and* contributes
to a place's activity. Nothing is duplicated.

---

## 2. Appwrite resources

### Created (10 tables, all row-secured, all `access: owner`)

`community_posts`, `post_media`, `post_reactions`, `post_comments`, `saved_posts`,
`place_contributions`, `place_saves`, `place_collections`, `follows`, `reports`

### Reused rather than duplicated

| Table | Change |
| --- | --- |
| `student_social_profiles` | extended: `home_country_code`, `host_country_code`, `is_demo_seed`, `seed_origin`, `verification`, `joined_at`, `live_location_shared`; index `(discoverable, host_country_code)` |
| `places` | extended: OSM identity (`osm_type`, `osm_id`), `university_id`, `campus_id`, `source`, `source_updated_at`, community counters (`student_saves`, `student_stories`), `status`, `search_text`; index `(country_code, category, status)` |
| `user_blocks` | reused for block state |
| `universities` | was empty — seeded with the seven demo campuses |

Bucket added: `community_media` (file-level security, images only, owner-scoped writes).

The brief's logical names were not turned into second physical tables: no `blocks`, `social_profiles`,
`pois` or `student_places` table exists. This is asserted by `scripts/appwrite/schema.test.mjs`.

### Indexes that the feed depends on

Cursor pagination is only correct if the sort column is indexed, so these are asserted, not assumed:

- `community_posts`: `(country_code, created_at)`, `(university_id, created_at)`, `(post_type, created_at)`, `(place_id)`
- `place_contributions`: `(place_id, created_at)`
- `post_comments`: `(post_id, created_at)`
- `saved_posts`: `(user_id, created_at)`
- unique: `post_reactions(user_id, post_id)`, `saved_posts(user_id, post_id)`, `place_saves(user_id, place_id)`, `follows(follower_id, following_id)`

---

## 3. Measured data

### POIs — real, from OpenStreetMap

| Country | Corridor(s) | Places |
| --- | --- | --- |
| Malaysia | Universiti Malaya | 1,004 |
| Singapore | NUS | 762 |
| Indonesia | Universitas Indonesia | 365 |
| Thailand | Chulalongkorn | 3,056 |
| Philippines | Ateneo de Manila | 1,745 |
| Viet Nam | VNU-HCM, FTU | 1,498 |
| **Total** | | **8,430** |

Composition: **8,419** rows sourced `osm_overpass` + **11** curated anchors sourced
`seed_pack_researched`. The curated count matches the seed report exactly — see §7 for how that was
made true.

Largest single-country set is 3,056, comfortably inside the 5,000 rows one Appwrite request returns,
so the map loads a country in one round-trip and never geocodes at runtime.

### Community seed

| Item | Rows |
| --- | --- |
| demo profiles | 12 |
| demo posts | 10 |
| comments | 28 |
| reactions | 68 |
| post saves | 24 |
| place saves | 41 |
| media | 9 |
| place contributions | 6 |

**Real-user rows: 0.** Two real authenticated users were created for the permission test and both
were deleted afterwards; nothing they wrote remains.

### Provenance

Every synthetic row carries `is_demo_seed = 1`, `seed_origin = demo`, `verification = synthetic_demo`.
No row anywhere carries `verified_student`, `real_user` or `partner_student` — asserted against the
live database, and asserted against the schema itself so the fields cannot be introduced later.

---

## 4. Permission test — two real users, real sessions

Not a schema review: two users were created, logged in over REST, and each request was made with that
user's own session secret.

```
PASS  user A can create their own post
PASS  user B CAN read user A's public post
PASS  user B CANNOT update user A's post        — denied:401
PASS  user B CANNOT delete user A's post        — denied:401
PASS  user A CAN update their own post
PASS  user B CANNOT read user A's private place save  — denied:404
PASS  user B's query for A's saves returns nothing    — 0 rows
PASS  user A CANNOT delete user B's post        — denied:401
PASS  an anonymous caller CANNOT read a community post — denied:404
```

Row ids for personal state are all inside Appwrite's 36-character limit (longest observed: 23).

**33/33 checks pass.** Evidence: `docs/evidence/phase5/verify.json`.

---

## 5. Realtime

One subscription per authenticated user on `community_posts`, created only after authentication, with
the HTTP query remaining the source of truth — the feed works normally with Realtime disconnected.

**Result: no user-visible realtime errors.** Chromium logs `WebSocket is already in CLOSING or CLOSED
state` only when the browser context is destroyed mid-close. Measured with
`scripts/phase5/realtime-teardown.mjs`: **zero** occurrences across onboarding, six tab switches
between Connect/Explore/Today and a full reload. The gate records that measurement explicitly rather
than filtering the message silently.

---

## 6. Browser verification — four viewports

**37/37 checks pass.** Evidence: `docs/evidence/phase5/browser.json`.

| Viewport | Map | Feed | Overflow |
| --- | --- | --- | --- |
| 390×844 | 348×319, 247KB render | 10 cards | none |
| 430×932 | 388×352, 294KB render | 10 cards | none |
| 768×1024 | 650×387, 235KB render | 10 cards | none |
| 1440×900 | 758×340, 243KB render | 10 cards | none |

Also asserted, not assumed:

- the map is a MapLibre canvas and **0** legacy grid elements exist
- OpenStreetMap attribution is visible (a licence requirement)
- Explore lists real seeded places, and **no** fabricated placeholder name appears
- seeded posts carry a visible Demo marker
- a location-tagged post opens its place on the map
- a reload never yields a white screen
- no uncaught page errors, no app console errors, no failed requests

Screenshot bytes are used as an honest signal that tiles actually painted — a flat canvas compresses
far smaller — but the check now also requires that the *map element itself* was captured, because a
full-page fallback had been satisfying a byte threshold while the map was missing.

---

## 7. Defects found and fixed

Each of these was caught by a check, traced to a cause, and fixed — not worked around.

**A `place` tag repeated itself.** A place-type post that links to a place derives both its type and
its `place` tag, so the stored array held `"place"` twice. Tags are React keys, so this produced 17
duplicate-key errors. Fixed at the source and at the parse boundary, which also repairs rows already
written.

**Personal-state row ids exceeded Appwrite's limit.** `postId + "_s_" + userId` overflows 36
characters for real ids, so saving a post or place would have failed for actual users. Uniqueness is
already enforced by each table's unique index, so the id only needs to be short and stable.

**A real name could be pinned to the wrong building.** The curated anchors were matched to OSM by
token overlap, which put "Universiti Malaya Central Library" on the whole campus polygon. The matcher
now requires a strict match, and an anchor that cannot be placed within 2.5 km of its campus is
dropped rather than guessed. Five anchors genuinely absent from OSM are reported as dropped.

**A seed run that did not converge.** The anchor set is derived, so an anchor that stops resolving
left its row behind — two such rows were live in the database. The seed now removes curated anchors
it no longer stands behind, unless a real student has saved one. The stored count now equals the
reported count (11).

**A first-run 404 was logged as an error.** A brand-new guest has no saved journey, so the 404 is the
normal path. Logging it as a failure made every fresh session look broken and buried real errors.

**The map's worker never loaded.** MapLibre's clustering worker did not resolve under Vite's
dependency optimiser, so clustering was silently degraded. The map screenshot went from 28KB to 247KB
once fixed, and the worker now ships as its own build chunk.

**Map labels requested fonts the basemap does not serve.** The style provides single-font stacks, so a
comma-joined request 404'd and cluster counts rendered no text.

**The Realtime socket was rebuilt on every filter tap.** The channel is the whole table, so it never
depended on the filter. Keying the effect on the filter tore the socket down and rebuilt it on each
chip tap; the current filter now comes from a ref.

**Harness defects that were reporting false results.** Three, all in
`scripts/verify/lib/onboarding.mjs`:

1. Completion was *sampled* rather than *confirmed*. The rail mounts before onboarding content, so a
   single observation saw navigation with no onboarding text and declared success while the country
   picker was on screen. Desktop evidence had been passing for the wrong reason.
2. The walker ended the flow on the first idle step. The welcome button disables itself to
   "Starting securely…" while the session is created, so the walk ended on step one.
3. Option chips were clicked repeatedly. Re-clicking a toggle undid the answer, stalling the goals
   step at 1440px with Continue still disabled.

The root cause of (1) and (3) was that "is onboarding showing?" was a hardcoded list of step titles
that named "Where are you from?" but not "Where are you going?". Onboarding now exposes
`data-testid="onboarding"`, so the question is answered structurally.

`config/current-state.yaml` also did not parse — a pre-existing multi-line list item. Fixed; the file
now parses and carries a `phase5_connect_explore` section.

---

## 8. Quality gate

| Gate | Result |
| --- | --- |
| TypeScript (`tsc --noEmit`) | **0 errors** |
| Production build | **pass** (worker emitted as its own chunk) |
| Unit tests | **61/61 pass** |
| Data + permission verification | **33/33 pass** |
| Browser verification (4 viewports) | **37/37 pass** |
| Secret scan | **pass** — no server-side secret in any tracked file or `dist/` |

Quality-gate assertions, verified rather than asserted by hand:

- no fake SVG map in the production path
- no generated fake POI in the production path
- no synthetic user marked verified
- no public precise live location
- no cross-user update/delete permission
- OSM attribution visible
- three demo corridors have distinct data

---

## 9. Deliberate non-goals

- **No live-location tracking.** Bump can do this because its whole safety architecture is built
  around friend location. YapYep is proving community adaptation, not surveillance. Shared places and
  shared experiences only; precise current coordinates are never published, and the
  `live_location_shared` flag is false on every row.
- **No messaging.** Untouched by request.
- **No ML recommender.** Matching is deterministic and every reason shown to a student is
  human-readable ("Also at UM", "Speaks Vietnamese") — no opaque compatibility score.
- **No Google Maps data.** POIs come from OpenStreetMap via Overpass, bootstrapped once and cached.
  Public Nominatim is used only for bounded, rate-limited resolution of a handful of seed addresses,
  never bulk crawling.

---

## 10. Known gaps

- Thai and Philippine demo content is POI-only: those corridors have no seeded community posts.
  Posts cover MY, SG and ID.
- `community_media` uploads are validated client-side (type, size, downscale) but no server-side
  moderation queue exists.
- Realtime is verified as non-breaking, not as a live multi-client propagation test.
- `scripts/verify/responsive.mjs` (Phase 1) still carries its own onboarding walker rather than the
  shared, now-fixed helper, so the `known_harness_issue` recorded against it stands.

---

## 11. Reproducing this

```bash
node --env-file=.env.local scripts/appwrite/bootstrap.mjs      # provision tables + bucket
node --env-file=.env.local scripts/explore/bootstrap-osm.mjs   # fetch + cache real POIs
node --env-file=.env.local scripts/phase5/seed.mjs             # import the demo seed pack
node --env-file=.env.local scripts/phase5/verify.mjs           # data + two-user permissions
pnpm dev                                                       # then, in another shell:
node scripts/phase5/browser.mjs                                # four-viewport browser gate
```

Evidence: `docs/evidence/phase5/{verify.json,browser.json,seed-report.json,osm-bootstrap.json}` plus
the viewport screenshots.
