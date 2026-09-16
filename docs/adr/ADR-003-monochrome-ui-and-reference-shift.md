# ADR-003: Monochrome UI direction and per-area reference shift

- **Status:** Accepted
- **Date:** 2026-09-15
- **Decision owner:** Product owner (approved directly in thread; supersedes
  the Qiao-as-visual-reference and multi-color token assumptions in
  `docs/02_UX_UI_SPEC.md` and `docs/11_FIGMA_BUILD_SPEC.md`)

## Context

The previous spec treated Qiao as the primary shell/visual reference and
pinned a multi-color token set (cobalt + warm amber on green-tinted canvas,
ink `#172033`, 20px card radius, shadows on cards). Product-owner review
concluded the current UI reads as generic "AI slop" and that Qiao's public
surface (Daily Home, checklist, personal guide/map, AI helper, community)
is a useful information-architecture model but not a mature mobile app to
clone visually 1:1.

Separately researched on 2026-09-15 (see `docs/12_RESEARCH_REFERENCES.md`):

- **Speak** — Learn → Practice → Apply loop; expert-crafted, AI-personalized
  lessons from real goals/situations; guided lesson → repeat speaking →
  feedback → simulated real conversation.
- **Praktika** — personal study plan, contextual suggestions, gentle
  corrections (pronunciation/grammar/vocabulary/pace), free conversation,
  saved lessons, per-word pronunciation review with Try Again; multi-agent
  Lesson / Progress / Planning design.
- **HelloTalk** — chat-centric language exchange: text/voice/video,
  in-thread translation, grammar correction with explanations, saved
  corrections, transcription, calls, groups, blocking/reporting.
- **Unibuddy** — Social Matching (~3 personalized matches/week) ranked by
  shared course/interests/country; match carousels → Message → icebreakers;
  block/report; GPT assistant answers from institution content.
- **Duolingo** — Roleplay scenarios with XP + AI feedback; Video Call
  (Lily: open practice + transcript; Falstaff: structured beginner coaching
  with suggested phrases); practice-loop and score-delta mechanics.
- **Airbnb-like map/card** — full-screen map + draggable bottom sheet
  (peek/half/full detents), two-way card↔marker sync, filter updates both.
- **Apple HIG** — clear hierarchy, grouping via spacing, top/leading
  placement for important content, 44×44pt minimum touch targets, strong
  contrast, one font with limited styles.
- **WCAG 2.2 SC 2.5.8 (AA)** — pointer targets ≥24×24 CSS px, with
  spacing/equivalent/inline/user-agent/essential exceptions; 44×44 best
  practice.
- **web.dev** — ~48px touch targets with ~8px separation, `any-pointer:
  coarse` enlargement, viewport meta, no zoom-disable, relative units,
  content-based breakpoints and container queries over fixed device sizes.

## Decision

### 1. Qiao is demoted to IA-only reference

Qiao remains the reference for **information architecture only**: phased
journey, checklist, country utility (passport/onboarding). It is explicitly
**not** the visual/interaction reference.

### 2. Per-area visual/interaction references (frozen)

| YapYep area | Reference | What we take |
|---|---|---|
| Today / learning home | Speak | clean hierarchy, lesson cards, personalized Learn → Practice → Apply loop, low noise |
| YapSim | Praktika + Duolingo | immersive conversation, contextual suggestions, correction, transcript, retry, score delta |
| Connect chat | HelloTalk | chat-centric UX, in-thread translate/correct, voice |
| Matching | Unibuddy | match cards, shared attributes, AI icebreaker, safety (block/report) |
| Passport / onboarding | Qiao | phased journey, checklist, country utility (IA only) |
| Progress | Duolingo mechanics minus clutter | score delta, mastery, repetition; no hearts/shop/cartoon clutter |
| Explore | Airbnb-like map/card pattern | map + bottom sheet + place context, card↔marker sync |

Do not copy logos, mascots, branded assets, or screen reproductions from
any reference. Interaction patterns only, with original YapYep identity.

### 3. Monochrome student-product token set (replaces old palette)

```yaml
background: '#F7F7F5'
surface: '#FFFFFF'
text: '#111111'
secondary: '#6B6B68'
border: '#E5E5E1'
cta_black: '#111111'
accent_cobalt: '#3157D5'   # only when truly needed
accent_soft: '#EEF2FF'
success: '#1F7A45'
warning: '#B7791F'
danger: '#C43B3B'
```

- Country flags are the primary source of color. The rest of the UI stays
  restrained.
- Warm amber (`#FFB648`), green-tinted canvas (`#F6F7F3`), ink `#172033`,
  and muted `#667085` are retired.
- Typography: Geist (Inter/system fallback).
- Geometry: 10–14px radius, 1px borders, shadows on overlays/floating
  sheets only — never a default shadow on every card.

### 4. Hard UI rules (binding on all agents and UI work)

No purple AI gradient. No glowing orb. No glassmorphism. No 28–32px radius
everywhere. No default shadow on every card. No rainbow dashboard. No fake
AI metrics. No decorative emojis as icons. No five competing CTAs on one
screen. No "everything is a card". No lorem ipsum. No desktop page rendered
as a tiny centered phone in empty space.

### 5. Real responsive (replaces centered-phone-shell MVP)

- **360–599 (mobile):** bottom nav, single column, 16px gutters, sticky
  primary CTA, sheets instead of side panels.
- **600–1023 (tablet / narrow laptop):** compact navigation rail, 2-column
  only when meaningful.
- **1024+ (desktop):** left nav rail ~220px, main working column
  680–800px, optional context panel 280–320px; Lens/Chat/Sim must use the
  space properly.
- Breakpoints follow content, not iPhone/Android models, per responsive-web
  guidance; container queries preferred where a component adapts to its
  container rather than the viewport.
- Touch targets: 44px minimum (Apple HIG, binding); 48px best practice
  (web.dev); WCAG 2.2 AA 24px floor with spacing/equivalent/inline
  exceptions. The existing centered `max-w-[420px]` phone frame
  (`src/components/shell.tsx` `AppShell`) is now legacy and must be
  replaced during implementation — see `docs/13_ARCHITECTURE.md`.

## Consequences

- `config/project-decisions.yaml` `design_tokens` and `docs/02_UX_UI_SPEC.md`
  §1/§2/§4, `docs/11_FIGMA_BUILD_SPEC.md` §2, and `docs/09_QA_ACCEPTANCE.md`
  §3 are updated to this direction. `docs/AGENT_RULES.md` is the verbatim
  shipped pack text and is intentionally left untouched; where it conflicts
  with this ADR, this ADR plus `config/project-decisions.yaml` win per the
  precedence order in `README.md`.
- Existing `src/index.css` `@theme` tokens and `shell.tsx` phone frame do
  **not** yet match this ADR — implementation is explicitly deferred until
  the product owner assigns the UI rework. No code is changed in this ADR.
  **Implemented 2026-09-16** (Phase 1, single-owner productionization): the
  monochrome token set, 10–14px geometry, no-default-card-shadow rule,
  icon-driven controls, and the 3-zone responsive shell (bottom nav / compact
  rail / rail + 680–800px workspace + claim-based 300px context panel) are in
  `src/index.css`, `src/components/shell.tsx`, `src/components/ui.tsx`,
  `src/components/icons.tsx` and the feature screens. Browser evidence at
  360/390/430/768/1024/1440 is in `docs/evidence/phase1/`.
- All future UI work (including any Figma Make output) must follow the
  monochrome tokens, hard rules, and responsive layout above, and must keep
  the frozen bottom nav, DNA concepts, and trust/safety rules unchanged.
