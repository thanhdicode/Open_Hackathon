# Phase 6 — Final Product Integrity, UX/AI QA & Release Gate

**Authorization:** User supplied the execution brief and requested Product Design audit/design QA and frontend-patterns. Implement and test autonomously, including live AI and safe isolated synthetic QA data. No production deployment, destructive reseed or Community rebuild.

**Goal:** Make the current app coherent and demo-safe, retain architecture/tokens, and verify the complete real guest→journey→grounded answer→reload loop plus PWA production behaviour.

**Baseline evidence:** Current-run captures under `docs/evidence/phase6/baseline`; live Appwrite coverage snapshot `coverage.json`. Prior QA screenshots are not baseline evidence for this run.

## Prioritized findings

- P0: verified KB coverage is zero for BN, KH, LA, MM, TL; model responses alone do not meet the grounding gate. Current published entry/chapter coverage is also zero despite facts existing.
- P1: first landing viewport prioritizes mascot/proof/lengthy prose over concrete product value.
- P1: fourteen named onboarding states (assessment includes several questions) delay first value. Mandatory English level, goals, interests and MyDNA need not block a journey. City/university can be completed in Profile.
- P1: date suggestion silently supplies a semester and return is required even if unknown. Arrival must be explicit, return optional but validated if present.
- P1: root completion does not await durable save before revealing home; immediate reload can race persistence.
- P1: custom journeys inherit seed task, reminder, culture tip and profile defaults. Restoring another route can retain sample city/university/arrival labels.
- P1: Ask Greenbook sets journeyStage to null and language to English rather than real journey/preferences. Debug/provider implementation copy still exists.
- P1: installed PWA dependency was not configured or registered before this phase. Production SW/cache/install/update/offline must be verified.
- P2: large eager app bundle, repeated explanatory mascot cards, and manual-only tours require a single eligible first-use contextual tour with durable dismissal.

## Incremental execution

1. Add failing tests for optional return/invalid supplied dates and isolated custom journey projection. Simplify onboarding to origin, destination, explicit arrival + optional return. Preserve sign-in and all other routes. Save before entering home; neutral unassessed MyDNA remains a core concept and never inferred from nationality.
2. Reuse existing tokens and real UI for a compact Passport/interpretation product preview on landing. Short headline, one sentence, Start my journey / Sign in. Supporting country count stays subordinate.
3. Correct custom/restored journey display dates, neutral personal fields, destination/stage task/reminder copy. Keep original seed journeys intact. Hide readiness percentages derived from unanswered MyDNA; offer profile personalization contextually.
4. Wire actual AI journey stage and preference language, remove internal status/provenance noise, retain human errors and retry. Evaluate grounding and lack-of-evidence failures, not only citation URL validity.
5. Add one eligible first-home tour, persist intentional finish/dismiss and retain per-screen manual replay. No first-landing tour, no actions on behalf of user, no repeated tutorial cards.
6. Independent additive data branches: eleven clearly synthetic QA accounts; sourced verified KB across eleven countries; 57-case repeatable live AI eval. Never remove existing data or rework Community. Review claim support and record gaps honestly.
7. Integrate PWA prompt-update lifecycle, production manifest/icons/static shell cache and value-triggered install/cooldown/iOS manual fallback. No API/auth/AI mutation cache.
8. Lazy-load genuinely heavy contextual screens while preserving header/nav/back/loading. Build/typecheck/unit checks per coherent group. Audit fresh rendered mobile/tablet/desktop states and real primary flow, reload and isolation.
9. Verify production SW/offline/manifest/update/install/standalone, security/configuration and lab performance. Lab measurements are not field percentile75 evidence. Save final acceptance matrix with exact READY_FOR_DEMO or BLOCKED status and named blockers.

Each area follows audit→fix→test/build→inspect. Design fidelity uses current-run baseline typography/tokens as visual reference and classifies requested composition changes as intentional; no new palette or whole-app redesign.
