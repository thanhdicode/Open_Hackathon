# Phase 6: additive, grounded ASEAN visitor advice

`knowledge-facts.json` contains 173 manually reviewed, exact-evidence snippets
across all eleven ASEAN countries: 114 official DFAT visitor-advice snippets and
59 cultural, language, festival, business-introduction and campus facts from
fourteen further primary source pages. These are source-specific facts and advice, not a claim
that nationality determines behaviour, and not student visa eligibility. Cultural
advice should be applied to its setting and local hosts' preferences.

DFAT attribution: Department of Foreign Affairs and Trade's Smartraveller website -
www.smartraveller.gov.au. Webpage text reuse is covered by the Creative Commons
Attribution section of https://www.smartraveller.gov.au/copyright. No downloaded
media, logos, coats of arms or illustrations are reused. Additional sources retain
their named official publisher and source URL with short supporting excerpts.
`policy-check.json`
archives the checked robots and copyright pages. Only destination HTML pages are
fetched; no PDF path prohibited by robots is fetched.

`source-registry.yaml` supplements, never replaces, `config/source-registry.yaml`.
`scripts/phase6/knowledge-seed.mjs` loads both registries, merges sources and
categories in memory, calls the existing structural validator, and validates
facts against the merged exact URL set. The seed persists matching
`knowledge_sources` rows before facts and uses existing publication permissions
from `scripts/greenbook/persist.mjs`. All twenty-five supplemental entries have also
been appended to the main registry, so recurring ingestion can see them directly.
`registry-integration.json` confirms existing parsed entries and original bytes
were preserved. `integrate-registry.mjs` is an idempotent append-only helper.

Every live run re-fetches ordinary HTTP HTML and requires the exact evidence
quote in newly parsed text. A missing quote or failed request is skipped; existing
facts are never deleted, promoted from a different source, or bulk reseeded. HTML
snapshots, content hashes and retrieval times are retained. Original probe JSONs
record the first read; current live evidence is under `snapshots/` and the live
report. Existing validator alone does not prove entailment, so this seed adds the
retrieval/quote gate before invoking it.

Run locally:

```powershell
node scripts/phase6/knowledge-seed.mjs --self-test
node scripts/phase6/knowledge-seed.mjs
node scripts/phase6/knowledge-seed.mjs --offline
node scripts/phase6/knowledge-seed.mjs --culture-only
node scripts/phase6/knowledge-seed.mjs --deep-only
node --env-file=.env.local scripts/phase6/knowledge-seed.mjs --live
node --env-file=.env.local scripts/phase6/knowledge-seed.mjs --readback
```

Default and offline modes perform no database writes. Offline mode cannot be
combined with live mode. Live mode touches only knowledge_sources,
source_snapshots, knowledge_facts and verification_events; it never writes or
deletes Community data. Existing product-layer projections are separate.

## Honest remaining gaps

This seed expands money, transport, temple dress/customs, hydration,
medical payment and arrival-navigation advice, plus Brunei mosque/handshake
guidance and UBD campus dining/counselling, Cambodian business introductions and
sampeah, Lao language diversity/holidays, Myanmar Mingalabar and Buddhist festival
practices, and Timor-Leste Tetun context and tais/storytelling heritage. Cambodian
business advice is labelled as business context; UBD facts apply only to UBD.
`extend-culture.mjs` prepared the reviewed fixtures; live retrieval independently
checks every quote before publication.

The six deep-demo countries also have 26 further facts: Vietnam Tourism home,
family greeting and shared-meal guidance; NUS SP2273 question/participation and
instructor-help advice; Thai business wai/address etiquette; UM attendance and
absence communication; Indonesian business hospitality and batik; and UP Diliman
Asian Center consent/privacy/online-classroom conduct. Each university or course
is named explicitly. Business-guide advice does not prescribe classroom rules.
The NUS course's flexible attendance options were not generalised to the rest of
NUS. Failed original tourism and university URLs with errors, blocking or empty
text were replaced with fetched primary pages, never promoted from cache alone.

Lao official tourism was excluded because its robots rules disallow this crawler.
Old Cambodian ministry page URLs returned 404 or connection failure and were not
used. HTTP refusals were never bypassed. Supplemental robots responses are
archived in `supplemental-policy-check.json`.

It does not pretend to cover all fifteen requested culture topics.
Translated greeting phrases, wider dining etiquette, classroom
participation, student housing, friendship/relationships, hospitality, religious
diversity beyond documented settings, broader festival context, local language registers,
support beyond the named campuses and further country-specific dress heritage require further
destination-government/university/community-context primary sources. No phrase,
cost, national costume or campus rule was invented to fill those gaps.

Myanmar's source includes serious current travel warnings: cultural snippets are
not a recommendation to travel or evidence that transport is safe. Read the full
linked current advisory. Health and safety recommendations are source advice,
not individual medical diagnosis.
