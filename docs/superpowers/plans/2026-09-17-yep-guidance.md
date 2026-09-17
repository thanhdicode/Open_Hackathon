# Yep mascot and mobile guidance implementation plan

**Goal:** Integrate the original Yep mascot and optional Driver.js guidance into useful YapYep surfaces without covering user content.

**Architecture:** Reuse React/Vite/Tailwind and existing navigation. One mascot component, one inline guide component, a static scoped tour registry, and a small tour lifecycle module. Driver.js is the explicitly requested walkthrough dependency, not a replacement UI framework. No backend or AI contracts change.

**Tech stack:** React 19, TypeScript, Tailwind v4, Driver.js, existing Node test runner and Playwright browser verification.

**Authorization:** User explicitly requested analysis followed by code and autonomous QA/QC in this task. No publish, deploy, git reset or merge.

## Research and design decisions

- [Driver configuration](https://driverjs.com/docs/configuration): scoped steps, explicit close, progress, no active-target interaction, lifecycle cleanup. Verify the installed package types; documentation may describe newer options.
- [Driver theming](https://driverjs.com/docs/theming): custom popover class rather than changing app-wide typography/colors.
- [VisualViewport](https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport): mobile keyboard/pinch can reduce visible viewport independently of layout viewport. Bound popover to visible dimensions and destroy if keyboard opens.
- [WCAG target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html): use the project's stricter 44px controls; visible focus and Escape dismissal.
- [Qiao](https://qiaoguide.com/en/china), [Duo](https://design.duolingo.com/writing/duo), [Finch](https://finchcare.com/): companion role and consistent personality. Original Yep artwork remains independent of references.

These implementation choices are inferences from docs and actual JSX, not library guarantees. No automatic walkthrough, media capture, message sending, navigation or form submission. Static tour copy never contains user input. Dismissed guide cards retain a compact replay button. Local storage contains only versioned screen guide preferences; blocked storage must not break the app.

## Screen-by-screen placement inventory

| Screen / state | Decision and implementation |
|---|---|
| Welcome | Waving hero; make short-height layout scrollable before insertion. |
| Sign in | Small waving mascot above methods; keep OTP/errors readable. |
| Home / host country | Compact shared onboarding header mascot, not in every country cell. |
| Place / dates | No extra panel; keyboard/form space stays primary. |
| Languages / goals / interests | Compact header signature only. |
| MyDNA questions | No mascot; no distraction from assessment options. |
| MyDNA result | Small encouragement and contextual interpretation, not nationality inference. |
| PairDNA map | Small neutral coaching; retain scores and stereotype caveat. |
| Passport ready | Replace icon/ring with celebration; avoid fake AI loading. |
| Save journey / account offer | Small shared SaveJourneyCard signature; no duplication. |
| Today | Inline short guide plus scoped tour of daily task/practice. No extra mascot on every card. |
| Today loading/error/offline/stale | Preserve existing skeleton/notices. |
| Passport home | Host-country heritage outfit, visible label; scoped source/checklist guidance. |
| Passport sections | No mascot for populated cards; neutral helper in empty reviewed-guidance state. |
| Passport fact detail / bank checklist | No mascot; sources, freshness, requirements dominate. |
| Lens text/photo/camera/voice initial | Compact mode-specific AI helper within scroller; tour explains controls, no capture. |
| Lens results / scene evidence | No decorative overlay; preserve evidence, confidence, risk and actions. |
| Lens request working | Thinking mascot in shared real request status; preserve elapsed time/cancel. |
| Lens conversation initial | Speaking helper inside transcript scroller; explain consent before speaking. |
| Lens conversation active / recording | No large mascot; preserve speaker identity and controls. |
| YapSim setup | Practice helper and short scoped tour of domain/goal/start. |
| YapSim live turns | No decorative mascot/avatar substitution. |
| YapSim feedback | Small supportive illustration; celebrate effort, not a fabricated passing score. |
| Study home | Guide explicitly says demo examples, not live upload/AI. |
| Study sample details | No additional panel; input/output cards dominate. |
| Greenbook cover | Host-themed compact guide within scroller; never in country switch sheet. |
| Greenbook browse / entry details | No large decoration; verified sources remain primary. |
| Ask Greenbook initial | Guide explains verified facts and refusal; short question/ask tour. |
| Ask Greenbook working | Thinking marker alongside actual steps. |
| Ask Greenbook answer / refusal | No decorative takeover; preserve verification/refusal. |
| Phrases / StudentReality | No extra populated panel; current explanation/media sufficient. |
| Explore home | Compact replay help inside list scroller, never above map. |
| Explore benign empty | Searching helper inside list; no mascot in errors/location denial. |
| Explore map / PlaceSheet / place-category | No floating decoration; preserve map controls and attribution. |
| AddExperience | No mascot; form and keyboard dominate. |
| Connect community home | Compact help in feed scroller; scoped tour of tabs/filters/post. |
| Connect People / posts / profiles | Real student avatars dominate; no mascot replacing people. |
| Connect benign empty | Small welcoming illustration, separate from failure state. |
| Connect local composer / post / profile / shared map | Home guide unmounts, so tour closes. No persistent floating guide. |
| Report / block / delete / missing post | No cheerful mascot. |
| Profile / skills / MyDNA / ASEAN passport | No extra panel; account offer reuses shared signature. |
| Compass | No extra panel; directional country selection already explained. |
| Settings home | Manual guide entry explaining where to replay tours. |
| Email/account offer | Shared compact SaveJourneyCard mascot. |
| EditProfile / Preferences / PrivacyData / BlockedUsers / Legal | No decoration; controls/readability/safety dominate. |
| About | Signature mascot. |

Audit method: navigation cases, each feature file, targeted JSX ranges and local state early returns. Serena tools unavailable; used rg. Whole-repository compression is unnecessary for this UI scope; existing structure and imports were sufficient.

## Heritage outfits

Label all as **heritage-inspired illustrations**, not universal national dress. Keep the same face/fur/body across countries. No ceremonial crowns, sacred motifs, airline uniforms or identity inference. Mapping follows host country, not home nationality.

| Code | Outfit inspiration | Source |
|---|---|---|
| BN | Kebaya blouse/long skirt | [UNESCO shared kebaya](https://ich.unesco.org/en/RL/kebaya-knowledge-skills-traditions-and-practices-02090) |
| KH | Sampot-style wrap and krama | [UNESCO krama](https://www.unesco.org/en/articles/unesco-congratulates-cambodia-kramas-inscription) |
| ID | Kebaya/wrap skirt | [UNESCO](https://ich.unesco.org/en/RL/kebaya-knowledge-skills-traditions-and-practices-02090) |
| LA | Blouse/woven long skirt | [Lao tourism weaving](https://www.tourismlaos.org/welcome/authentic-culture/artisans-handicrafts/) |
| MY | Kebaya/long skirt | [UNESCO](https://ich.unesco.org/en/RL/kebaya-knowledge-skills-traditions-and-practices-02090) |
| MM | Shirt/longyi | [Ministry garment names](https://www.moi.gov.mm/moi%3Aeng/news/3995) |
| PH | Barong-inspired shirt/trousers | [Museum collection catalogue](https://www.nafa.edu.sg/docs/default-source/press-releases/2019/pina-seda-annex-1.pdf) |
| SG | Peranakan kebaya/sarong, one community tradition | [National Heritage Board](https://www.roots.gov.sg/ich-landing/ich/Kebaya) |
| TH | Ruean Ton-inspired blouse/skirt | [Tourism Authority of Thailand](https://www.tatnews.org/2025/08/chud-thai-a-timeless-invitation-to-dress-the-nation-in-heritage/) |
| TL | Tais-inspired shoulder cloth | [UNESCO Tais](https://www.unesco.org/archives/multimedia/document-5636) |
| VN | Ao dai-inspired tunic/trousers | [Vietnam tourism](https://vietnam.travel/node/1216) |

Generated outfit artwork is stylized and not verified textile documentation. Use abstract patterns and visible captions. An equal-cell CSS atlas avoids image processing and preserves original generated files; inspect all cells before shipping.

## Execution and verification

- [x] Add failing Node tests for scoped targets, hidden/missing target exclusion, disabled storage and country atlas coverage.
- [x] Install requested driver.js with pnpm; inspect actual types/source for lifecycle, keyboard and viewport positioning.
- [x] Create mascot/state/heritage assets with built-in imagegen referencing original Yep. Save images and prompts in public/brand; validate transparent alpha and atlas placement.
- [x] Implement Mascot, YepGuide, scoped tour lifecycle and registry. Use safe viewport bounds, 44px controls, reduced-motion support, Escape/close, no actions on targets, focus restoration and cleanup on route/local-state changes.
- [x] Integrate exact screens above using minimal insertion points, reuse shared request/account surfaces, no unrelated refactoring.
- [x] Run new Node tests, build, TypeScript checks and existing test suite. Record pre-existing failures separately.
- [x] Browser QA at 320/360/390/430/768/1024/1440 widths, short-height and landscape. Walk onboarding; inspect all five tabs and affected overlays, tours, replay/dismiss, route cancellation, missing selectors, keyboard resize, assets and no horizontal overflow.
- [x] Save screenshots and QA findings in docs/evidence/yep-guidance. Fix any regressions introduced here and recheck affected cases.

No unsolicited commit/stash/reset in the dirty workspace. Existing user changes must remain intact.
