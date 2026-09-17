# 08 — Implementation Plan and Hoplite Agent Ownership

## 1. Current project state

The current report indicates:
- TypeScript passes
- production build passes
- preview port issue fixed
- 13-step onboarding works
- 11 ASEAN countries are present
- five main tabs render
- Lens state pipeline UI exists
- Connect seed matches exist
- PairDNA directional logic exists
- places/passport/study seed layers exist
- forced UI states exist

This means agents should **productionize**, not rebuild.

## 2. Five parallel Hoplite agents

### Agent A — Foundation / Backend
Owns:
- Appwrite client/server config
- Auth
- TablesDB schema
- Functions scaffolding
- env handling
- persistence
- deployment config

Must not redesign UI or AI prompts.

### Agent B — YapLens / Trust
Owns:
- text + screenshot Lens
- retrieval
- source/confidence UI wiring
- Zod/schema validation
- tone/reply flow

Must not change global navigation.

### Agent C — YapSim / Study
Owns:
- Lens→Sim handoff
- scenario engine
- text session first
- voice fallback/P1
- score/feedback/retry
- skill persistence
- Professor/Group mode

### Agent D — Data / Ingestion
Owns:
- source registry
- facts
- Passport source data
- six deep demo countries
- five baseline countries
- crawler/data worker
- freshness metadata

Must not create unsourced administrative facts.

### Agent E — QA / UX Polish
Owns:
- Playwright/E2E or chosen browser testing
- mobile 390px
- accessibility/touch target
- error/offline states
- console/network failures
- production demo verification

Must not add product features.

## 3. Merge order

1. Agent A foundation
2. Agent D data foundation
3. Agent B Lens
4. Agent C Sim/Study
5. Agent E QA fixes

Parallel work may occur in isolated branches/sandboxes, but reconcile in this order when dependencies overlap.

## 4. Delivery phases

### Phase 0 — Freeze
- commit current working baseline
- install agent instructions/spec pack
- create env template
- make P0 issue list

### Phase 1 — Backend reality
- real Appwrite auth
- real tables
- persistence
- server secret boundary
- deployed URL

### Phase 2 — Lens
- text first
- schema
- evidence retrieval
- screenshot
- reply
- low-confidence

### Phase 3 — Sim
- text scenario
- scoring
- retry
- persist skills
- voice after stable text path

### Phase 4 — Passport/Today grounding
- replace critical seed admin cards with source-backed facts
- task progress persistence

### Phase 5 — Social / Explore if time
- actual profiles
- chat
- minimal map

### Phase 6 — Final Product Integrity, UX/AI QA & Release Gate
No new features.
Only:
- bug fixes
- performance
- demo data
- accessibility
- failure modes
- pitch rehearsal

Current execution/evidence: `docs/superpowers/plans/2026-09-17-phase6-integrity.md` and `docs/evidence/phase6/`.

## 5. Branch/task naming

Examples:
- `feat/appwrite-auth-persistence`
- `feat/yaplens-grounded`
- `feat/yapsim-scoring`
- `data/asean-source-registry`
- `qa/golden-flows`

## 6. Every agent completion report must include

- files changed
- architecture decisions made (should be none unless approved)
- commands run
- test/build results
- browser flow tested
- screenshot/video evidence if Hoplite supports it
- known limitations
- follow-up blockers
