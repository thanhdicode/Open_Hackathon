# Phase 3 Core AI Implementation Plan

**Goal:** Deliver real Lens media/voice, two-way conversation, YapSim persistence, and AI-backed Study flows.

**Architecture:** Use Appwrite Functions as the server boundary. Each AI operation has a dedicated Zod/JSON contract, validated provider output, owner-scoped persistence, and a text fallback.

**Tech Stack:** React, Vite, Appwrite Web/Node SDK, Zod, Groq, Gemini, Motion, Playwright.

## Constraints

- Keep the five fixed tabs, React/Vite/TypeScript, existing navigation, and Phase 2 work.
- Never expose server/provider credentials to the browser.
- Keep original media temporary and do not invent administrative facts or citations.
- Turn-based conversation is mandatory; Gemini Live is capability-gated.

### Task 1: Contracts and provider verification

**Files:** Create `src/lib/ai-contracts/{scene,reply,tone-check,transcription,speech,conversation,sim}.ts`, matching JSON schemas under `schemas/`; modify `functions/ai-gateway/src/main.js`.

- [ ] Write invalid/valid schema fixtures for every contract.
- [ ] Verify each fixture fails/passes through Zod.
- [ ] Replace generic Lens-only response normalization with one validation-repair retry; return `SCHEMA_INVALID` after the second failure.
- [ ] Verify Groq text/STT, Gemini image/TTS and configured fallback capability with real safe requests.
- [ ] Commit contracts and provider matrix.

### Task 2: Media Lens

**Files:** Modify `src/features/Lens.tsx`, `src/lib/ai-contracts/lens.ts`, `functions/ai-gateway/src/main.js`; create media helpers and Scene annotation components.

- [ ] Add image/PDF/audio validation with type signatures, size caps, and owner-scoped temporary upload.
- [ ] Add `/scene`, `/transcribe`, `/speech`, `/reply`, `/tone-check` routes.
- [ ] Add SVG label overlay for normalized image boxes and a tapped-label detail sheet.
- [ ] Connect real upload, recording, cancel, retry, source unavailable, low confidence, 429 and provider unavailable states.
- [ ] Delete temporary originals after successful/failed processing.
- [ ] Verify menu screenshot at 390px and 1440px.

### Task 3: Conversation and YapSim

**Files:** Create conversation contracts and persistence helpers; modify `Lens.tsx`, `YapSim.tsx`, gateway routes, Appwrite schema/bootstrap.

- [ ] Add owner-scoped conversation sessions and AI progress request rows.
- [ ] Implement explicit speaker turns, confirmed facts, native-language explanation and host-language reply playback.
- [ ] Replace seeded Sim timer path with `/sim/start`, `/sim/turn`, `/sim/finish`.
- [ ] Persist real attempt transcript/feedback, update skills, and create retry attempts with a real delta.
- [ ] Verify VN↔Malay food ordering and a 3–5 turn practice loop across reload.

### Task 4: Study, motion and Live fallback

**Files:** Modify `Study.tsx`, shared AI activity components and motion tokens; add Live token broker only if verified.

- [ ] Route Professor/Group/Slide/Lecture/Assignment/Vocabulary to Phase 3 contracts.
- [ ] Show only actual request states, with reduced-motion and Stop/Cancel controls.
- [ ] Add Live ephemeral token endpoint and browser flow after turn-based fallback passes.
- [ ] Verify microphone/camera denial, upload fallback, no speaker and offline draft behavior.

### Task 5: Documentation, QA and release

**Files:** Update docs 00–13, ADRs, config manifests, schemas, `current-state.yaml`, `SHIPBOARD.md`, evidence directory.

- [ ] Update contracts, architecture, schema, QA matrix, provider capability matrix and product behavior docs.
- [ ] Run typecheck, build, schema tests, real provider tests, security/bundle scan and two-user isolation tests.
- [ ] Capture browser evidence at 390×844, 768px and 1440×900.
- [ ] Commit each independently verified release and open focused PRs.
