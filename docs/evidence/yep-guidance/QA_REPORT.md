# Yep integration QA/QC — 2026-09-17

**Status: PASS for the implemented UI scope.**

## Delivered

- Original Yep signature in welcome/sign-in, shared save-account offer, onboarding results, Passport-ready, Today, Passport, selected AI guidance surfaces and About.
- Four consistent action poses (thinking, communication, encouragement, exploration), generated with built-in imagegen using the original mascot as reference.
- Eleven destination outfit illustrations: BN, KH, ID, LA, MY, MM, PH, SG, TH, TL, VN. Each maps to its own atlas cell and visible heritage-source label. Singapore is Peranakan-inspired, one community tradition. Outfits are stylized illustrations, not universal national dress or verified textile reproductions.
- Driver.js 1.8.0, short optional screen-scoped tours. Show me / Yep’s guide starts a tour; users can close and replay. Dismiss preferences are versioned, browser-local and tolerate blocked storage.
- All decorative assets stay in normal layout. No mascot over camera evidence, map controls, chat, safety dialogs, privacy actions or dense administrative fact details.
- Mobile popovers bound to VisualViewport and safe-area insets; controls at least 44px; reduced-motion handling, Escape, keyboard focus, route/local-screen cleanup, hidden-target guards. Targets cannot record, submit, send or navigate during a tour.

Screen inventory, source research, placement decisions and cultural references: [implementation plan](../../superpowers/plans/2026-09-17-yep-guidance.md). Asset metadata and exact prompts: [asset notes](../../../public/brand/yep-assets.md).

## Evidence

| Check | Result |
|---|---|
| Production build | PASS |
| TypeScript `pnpm exec tsc --noEmit` | PASS |
| Aggregate `pnpm test` | 239 tests, 9 groups, zero failures (235 existing + 4 guidance) |
| Guidance Node checks | 4 tests, zero failures |
| Browser QA | 167 recorded measurements/checks, zero runtime errors |
| Keyboard | Eight Tab presses on each tour step stayed inside guide; focus returned to replay after normal close |
| Viewports | 320×568, 360×640, 390×844, 430×932, 768×1024, 1024×768, 1440×900, 844×390 |
| Main tabs | All five tabs, every tour step, at every viewport above; no horizontal document overflow or popover escaping viewport |
| Contextual screens | YapSim setup, Study examples, Greenbook cover, Ask Greenbook, Lens Conversation Bridge, Settings help and About |
| Country mapping | All 11 destination outfits exercised through actual Compass→Passport UI; image loading checked, screenshots saved |
| Tour lifecycle | Escape, tab change, hidden target and simulated keyboard VisualViewport shrink close and clean up |
| Side effects | No AI API requests; question input unchanged by tour; Appwrite HTTP intercepted in UI QA |
| PNG validation | All 3 PNG files have 32-bit alpha and transparent corner pixels; atlas cells visually inspected |
| Diff whitespace check | PASS on affected tracked files |

Raw browser evidence: `ui-results.json`. Existing unit output: `unit-tests.log`. Screenshots in this folder include initial welcome, Passport, each guide, every country outfit, and About. `failure.png` is a retained diagnostic from an earlier iteration, not final evidence.

## Corrections made during QC

1. Navigation cleanup initially could restore focus to a tab covered by an overlay. Focus restoration now skips navigation/unmount.
2. Mutation checks now guard `checkVisibility` for older browsers and observe relevant hidden/class/style changes.
3. Explore’s pinned map was reduced to 32dvh with 140–320px bounds so list/help has room on short phones; no decoration added above the map.
4. Welcome and Passport-ready layouts now scroll on short screens. Shared scrollers have `min-h-0`.
5. Formatting with the installed oxfmt 0.2 removed separators from an inline TypeScript object type. Converted that type to multiple lines and reran Node/TypeScript checks.

## Boundaries of verification

Browser checks use headless Chromium with touch enabled and phone-sized viewports, not physical iPhone/Android hardware. Keyboard shrink is simulated; safe-area values are configured but a physical notched-device keyboard was not tested. No live AI accuracy, OAuth provider flow or backend-write certification is implied by this UI QA. Existing backend/AI contract tests remain passing. The build retains the existing large-bundle warning; no unrelated code-splitting refactor was attempted.

## Re-run

```text
pnpm test
pnpm test:guidance
pnpm exec tsc --noEmit
pnpm build
pnpm verify:guidance
```

Browser QA defaults to the existing development preview on port 5173. For stable QA without hot reload, build and run a Vite preview, then set `BASE_URL` to that preview origin before `pnpm verify:guidance`.

## Durable operational notes

- This checkout’s pnpm store is under `AppData/Local/pnpm/store`; use the store base directory (not the versioned `v10` child) if pnpm reports an unexpected-store error.
- UI QA should run against a stable build while files are being edited. Hot reload can reset onboarding and invalidate an otherwise correct browser run.
- Keep multi-field TypeScript object types multiline with the installed formatter; TypeScript checks are required after formatting.
- Tours must follow actual local screen ownership, especially Connect early-return subscreens and Lens modes, in addition to the navigation stack.
