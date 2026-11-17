# Page Quality (M7)

M5 established `signal.page/v1`. M7 asks whether it holds up on pages Signal did not write, and reports the answer per page, per category and per extraction method. There is no single aggregate score: one would hide exactly the failures this document exists to show.

**Summary.**
- Every page is measured against labels written independently of the extractor.
- 10 tuning pages score near 1.0. Those scores are optimistic by construction (§1).
- 6 held-out pages were labelled and committed before the extractor ever ran on them. Their first run is preserved unchanged:
  - entity detection was strong;
  - attribute understanding failed on 3 of 6 pages: countries 0.000, tallest buildings 0.096, Python events 0.333.
- After generic fixes, those pages reach 0.976–1.000. The held-out set has now been used, so it is **no longer an unbiased estimate**.
- The next quality claim needs a new, unseen set (GAP G-PAGE-9).

## 1. Method

### Pages and access

16 real public pages, plus 2 recorded refusals. The provenance for each is in `tests/fixtures/real/<id>.provenance.json`:
- URL (secrets redacted), fetch time, final URL;
- status, content type, sha256, byte length;
- robots decision, terms note, split.

All pages were fetched with Signal's own `HttpSource`: robots.txt respected, SSRF guard, byte cap, a single request per page. The sites are scraping sandboxes (toscrape, webscraper.io, scrapethissite, Real Python), public-domain or CC BY-SA sources (usa.gov, Wikipedia), or sites whose robots.txt allows the path (arXiv `/abs`, HN, python.org, PyPI).

Refusals are kept as evidence that access controls are honoured, not bypassed:

| Page | Outcome |
|---|---|
| `discourse-meta` | HTTP 403 for automated access, recorded as a refusal |
| `gutenberg-1342` | robots.txt unreachable ⇒ disallow (RFC 9309), not fetched |

**Not covered by real pages:**
- **Real-estate listing sites.** Their terms prohibit automated access, so the real-estate scenario uses synthetic fixtures (DISCOVERY_MODEL.md).
- **Forum software beyond HN.** Discourse refused.
- **A real page with conflicting JSON-LD.** None of the permitted pages had one. Conflicts are covered by synthetic fixtures only (M5 tests, and the stale JSON-LD price in `tests/fixtures/discovery/neighborhood.html`).

### Sanitization

`scripts/sanitize-real-pages.ts` runs before retention:
- **arXiv:** the abstract text is removed; only metadata is kept.
- **HN:** user names are replaced with `user1..3`, comment text is removed, and `auth`/`goto` parameters are stripped.

Labels describe the sanitized page.

### Expected results, independent of the extractor

`scripts/label-real-pages.ts` is a per-site oracle that produces the labels. It uses cheerio selectors written for each specific site's markup and never imports `lib/page`.

The independence is provable from git history:
- `a5d70af` committed the 10 tuning pages and their labels;
- `3d71e47` committed the 6 held-out pages and their labels before any evaluation run.

A label lists entities with a key, a type and attributes. Each attribute has an expected value and a comparison mode (exact, number, money, date, url-suffix, contains). Labels also mark attributes that are present on the page but **not accessible** without another page (e.g. a description shown only on the detail page).

### Splits

| Split | Pages | Meaning |
|---|---|---|
| tuning | 10 | Inspected while improving generic rules. Scores are optimistic |
| held-out | 6 | Labelled and committed first, then evaluated once untuned. That run is preserved in `docs/page-quality.heldout-first-run.json` and is never overwritten |

### Outcome taxonomy (per labelled attribute)

| Outcome | Meaning |
|---|---|
| `correct` | Extracted on the matched entity with the expected normalized value |
| `not_understood` | Extracted, but with the wrong value or on the wrong attribute (e.g. a population read as a year) |
| `ambiguous` | Extracted with `ambiguity` set, i.e. the representation said it could not decide |
| `missed` | Present on the page, not extracted |
| `not_accessible` | Not on this page (needs another page); excluded from recall |
| `not_present` | The label says the page does not show it; excluded from recall |

### Metrics

Computed per page by `tests/eval/score.ts`:
- **Entities:** recall, detection (found under any type), precision, false-entity rate, wrong-type rate, and duplicate rate (duplicates beyond the label's own count for the same key).
- **Attributes and relationships:** recall and precision.
- **Traceability:** the share of extracted values whose evidence resolves to an element present in the HTML.
- **Text coverage:** the share of visible text represented somewhere.

Precision is scored against the labelled collections. On pages where the label covers only part of the page (`precisionScope: "matched-collections"`, used for heldout-tallest), unlabelled collections are not counted as false.

Reproduce:

```bash
node scripts/evaluate-pages.ts
```

```bash
node scripts/summarize-quality.ts
```

```bash
node --test tests/lib/page-quality.test.ts
```

The test is a regression floor at the committed measurement.

## 2. Results (`docs/page-quality.json`, extractor `page-extractor/1.1.0`)

### Per page

| split | page | category | ent R | ent P | dup | attr R | attr P | rel R | rel P | trace |
|---|---|---|---|---|---|---|---|---|---|---|
| tuning | arxiv-abs | research_publication | 1.000 | 1.000 | 0 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |
| tuning | books-catalog | product_listing | 1.000 | 1.000 | 0 | 1.000 | 1.000 | – | – | 1.000 |
| tuning | books-detail | product_detail | 1.000 | 1.000 | 0 | 1.000 | 1.000 | – | – | 1.000 |
| tuning | fake-jobs | job_listing | 1.000 | 1.000 | 0 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |
| tuning | hn-item | discussion | **0.750** | 0.750 | 0 | **0.600** | 1.000 | **0.500** | **0.400** | 1.000 |
| tuning | quotes | posts_with_authors | 1.000 | 1.000 | 0 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |
| tuning | usagov-agencies | directory | 1.000 | 1.000 | 0 | 1.000 | 1.000 | – | – | 1.000 |
| tuning | webscraper-laptops | product_listing | 1.000 | 1.000 | 0 | 1.000 | 1.000 | – | – | 1.000 |
| tuning | wiki-night-train | article | 1.000 | 1.000 | 0 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |
| tuning | wiki-population | data_table | 1.000 | 1.000 | 0 | 1.000 | 1.000 | – | – | 1.000 |
| held-out* | heldout-countries | directory | 1.000 | – | 0 | 0.997 | 0.997 | – | – | 1.000 |
| held-out* | heldout-hockey | data_table | 1.000 | 1.000 | 0 | 1.000 | 1.000 | – | – | 1.000 |
| held-out* | heldout-pyevents | event_listing | 1.000 | 1.000 | 0 | 1.000 | 1.000 | – | – | 1.000 |
| held-out* | heldout-pypi | product_detail | 1.000 | – | 0 | 1.000 | 1.000 | **0.000** | – | 0.998 |
| held-out* | heldout-tallest | data_table | 0.980 | **0.696** | **0.760** | 0.976 | 1.000 | – | – | 1.000 |
| held-out* | heldout-wstables | data_table | 1.000 | 1.000 | 0 | 1.000 | 1.000 | – | – | 1.000 |

\* After held-out-informed fixes; no longer an unbiased estimate. A dash means no labelled items of that kind, or precision not scored (single-entity labels).

### First, untuned held-out run (`docs/page-quality.heldout-first-run.json`)

This is the most honest number in this document.

| page | ent R | ent P | attr R | attr P | what failed |
|---|---|---|---|---|---|
| heldout-countries | 1.000 | 0.988 | **0.000** | **0.000** | `Capital: X` / `Population: N` / `Area (km2): N` label pairs: "Area (km2):" was mis-split on its digits, and label-only spans with sibling values were not paired |
| heldout-hockey | 1.000 | 1.000 | 1.000 | 1.000 | – |
| heldout-pyevents | 1.000 | 0.400 | **0.333** | 1.000 | `<li>` wrapping a single article was not promoted to the record; location was not read |
| heldout-pypi | 1.000 | **0.003** | 1.000 | 1.000 | The desktop/mobile duplicate sidebar became hundreds of records. Author relationship missed |
| heldout-tallest | 0.989 | 0.354 | **0.096** | 0.151 | rowspan/colspan and two-row headers shifted columns; footnote markers broke numbers |
| heldout-wstables | 1.000 | 1.000 | 1.000 | 1.000 | – |

### Per category (`node scripts/summarize-quality.ts`, current run)

Attribute outcomes are listed as correct / not understood / ambiguous / missed / not accessible.

| category | pages | outcomes | attr recall | attr precision |
|---|---|---|---|---|
| article | wiki-night-train | 3 / 0 / 0 / 0 / 0 | 1.000 | 1.000 |
| data_table | hockey, tallest, wstables, wiki-population | 614 / 0 / 0 / 7 / 0 | 0.989 | 1.000 |
| directory | countries, usagov-agencies | 810 / 2 / 0 / 0 / 0 | 0.998 | 0.998 |
| discussion | hn-item | 3 / 0 / 0 / 2 / 0 | **0.600** | 1.000 |
| event_listing | pyevents | 18 / 0 / 0 / 0 / 0 | 1.000 | 1.000 |
| job_listing | fake-jobs | 300 / 0 / 0 / 0 / 0 | 1.000 | 1.000 |
| posts_with_authors | quotes | 10 / 0 / 0 / 0 / 0 | 1.000 | 1.000 |
| product_detail | books-detail, pypi | 6 / 0 / 0 / 0 / 1 | 1.000 | 1.000 |
| product_listing | books-catalog, webscraper-laptops | 411 / 0 / 0 / 0 / 137 | 1.000 | 1.000 |
| research_publication | arxiv-abs | 2 / 0 / 0 / 0 / 0 | 1.000 | 1.000 |

In product listings, 137 labelled facts (descriptions, full specifications) are only on detail pages. They are reported as `not_accessible`, not counted as misses, and they are exactly what a discovery scan plan proposes fetching (`detail_page`).

The held-out first run, by category:

| category | attr recall | attr precision |
|---|---|---|
| data_table | 0.322 | 0.443 |
| directory | 0.000 | 0.000 |
| event_listing | 0.333 | 1.000 |
| product_detail | 1.000 | 1.000 |

### Per extraction method (attribute outcomes on matched entities, current run)

| method | correct | not understood | precision |
|---|---|---|---|
| table | 616 | 0 | 1.000 |
| label ("Label: value") | 810 | 2 | 0.998 |
| microdata | 361 | 0 | 1.000 |
| html (semantic / class hints) | 234 | 0 | 1.000 |
| structure (repeated records) | 148 | 0 | 1.000 |
| json-ld | 3 | 0 | 1.000 |
| meta | 2 | 0 | 1.000 |
| text | 3 | 0 | 1.000 |

In the first held-out run, `label` was 0/250 and `table` was 112/253. These are the two methods that needed generic fixes.

## 3. What changed in the extractor because of real pages

Every fix is generic: there is no site-specific code, and all M5 tests still pass. The rules are in PAGE_INTELLIGENCE.md §2.

| Real-page failure | Generic fix |
|---|---|
| `$1033.99` parsed as 103 (grouping regex) | Grouped thousands require a separator; `(?!\d)` boundary |
| `$1 033,99` | Spaces inside amounts removed before parsing |
| `1,540 sqft` parsed as 540 | Quantity splitting no longer splits on `, ` followed by a digit inside a number |
| Area (km2): label digits | Labels may contain digits/units; label-only element + sibling value pairing |
| rowspan/colspan, two-row headers, footnote markers | Table grid expansion; multi-row header names; footnote markers stripped |
| `<li>` around one `<article>` | Wrapper promotion: the single inner record becomes the member |
| Inline containers consumed before their children | Records processed deepest-first; parents keep only remaining text |
| Authors given as plain text / profile links | `partyFromText`, profile-link heuristics |
| Scholarly metadata (`citation_*`, Dublin Core) | Mapped to `ScholarlyArticle` attributes |
| `hidden="until-found"` content dropped | Treated as accessible content |
| Property tables beside a main record | Attached to the main record (innermost container of the single h1) |
| Indented threads (`aria-level`, `data-depth`, indent) | `inReplyTo` from indent levels |
| Layout tables hid records | Layout tables are scanned for records |
| `form` treated as non-content | Removed from skipped containers (filter panels and search results often sit in forms) |
| 3.5 s on a 1.4 MB page (quadratic containment checks) | O(depth) ancestor walks: 0.4 s |

## 4. Corrections disclosed

1. **Label correction (heldout-tallest).** The oracle ignored `rowspan`, so its own expected values were shifted. It was corrected after the first run, and the note is recorded in the label file. The first-run numbers above were scored against the uncorrected label, and that run was not re-scored. Treat the 0.096 as "very poor", not as an exact figure.
2. **Scorer corrections**, made after the first held-out run and applied to all pages:
   - duplicates are counted relative to the label's own count for the same key;
   - declared but unlabelled entities (e.g. a publisher) are not false entities;
   - `Unknown` is not a claimed type, so it no longer counts against wrong-type rate;
   - `precisionScope` added.
   These change how the metrics are computed, not what the extractor did.
3. **The held-out set is consumed.** Fixes were informed by its failures. A new unseen set is required for the next unbiased claim (G-PAGE-9).

## 5. Remaining measured failures

| Where | What | Why it is not fixed |
|---|---|---|
| hn-item | Story entity recall 0.75, attributes 0.6, relationships 0.5/0.4 | HN puts one story across two table rows (title row + subtext row) with no shared container. Joining rows needs a cross-row record rule, which risks merging unrelated rows elsewhere. Documented, not guessed (G-PAGE-10) |
| heldout-pypi | Author relationship 0/1 | Sidebar "Meta" facts sit in sections that become their own records, and the sidebar is duplicated for desktop and mobile. The package record is not linked to its sidebar (G-PAGE-11) |
| heldout-tallest | Entity precision 0.696, duplicate rate 0.76 | The same buildings appear in several tables on the page. Each table row is a distinct row entity. Merging them by name would be weak-identity merging, which Signal refuses to do silently; they are kept as rows |
| synthetic lot (discovery fixtures) | A land lot card is typed `Product` | T2 fires (price + image). A lot is not a product. There is no reliable generic cue (G-PAGE-12) |

## 5a. Identity and change (requirement 4)

The scenarios are in `tests/lib/identity.test.ts`. All run on the real books catalog, or on controlled edits of it.

| Scenario | Result |
|---|---|
| Price change | Same entity id, new `digest`, new `factsRevision`; `decreased` matches with the previous value |
| Availability change | `changed` matches one entity |
| Seller change | The relationship target changes; the entity id does not |
| New / disappearing listing | `added` / `removed` report exactly the one entity |
| Reordered list | Same ids, **same `factsRevision`**, no added/changed |
| Layout-only change (classes, wrappers) | `revision` changes; `factsRevision` and ids do not |
| Same item in two cards | One entity, `occurrences: 2` |
| Moving between collections | Ids unchanged; collection membership changes |
| Similar names | Distinct URLs ⇒ distinct entities. Same name without a strong identifier ⇒ both marked `ambiguous`, linked `possiblySameAs`, and excluded from change detection (`uncertain`), never merged |

Identity strength is recorded on every entity:
- **strong:** `@id`, url or sku;
- **weak:** a name;
- **positional:** a DOM path.

Continuity is claimed only for strong or unambiguous weak identities.

## 6. Size (requirement 3) — decision: gzip of the canonical JSON

`scripts/analyze-size.ts` → `docs/size-analysis.json`. Where the bytes go (1,000-product synthetic page, 3.43 MB representation, 18× its HTML):

| Part | Share |
|---|---|
| JSON keys (repeated property names) | 36.6% (24–41% across pages) |
| Evidence total | 43.1%, of which: CSS locators 17.1% (4–31%), evidence text 3.2% (3–7%), evidence attributes 4.4% |
| Attribute metadata (provenance, method, confidence, type) | 11.2% |
| Entity metadata | 10.4% |
| Relationships | 11.8% (7–12%) |

The size comes from **structure repeated per value**, not from page text. Options benchmarked by `scripts/bench-storage.ts` → `docs/storage-options.json`:

| Option | Result | Decision |
|---|---|---|
| A — canonical JSON, as is | 3.43 MB | Baseline |
| **A+ — gzip of the canonical JSON** | **324 KB (10.6×)**; encode 21 ms, decode 14 ms | **Chosen.** The same document byte for byte after decompression; no schema change; `revision` unchanged; deterministic |
| B — drop or cap evidence | Smaller, but loses traceability | Rejected: evidence must survive |
| C — summaries instead of values | Not authoritative | Rejected: summaries are never the authority |
| D/D+ — columnar compact format (locator prefix table, interned keys) | D+ 267 KB (18% smaller than A+), but **decode 29.6 s**. Re-run against `page-extractor/1.1.0`, D is **no longer lossless** (it predates `digest`/`identity.strength`) | Rejected: a second schema to keep in sync, slow, and already drifted |
| E — split evidence into a separate file | Same total bytes, two reads, and consistency risk | Not needed after A+ |

What was implemented:
- `storePage` writes `gzip(canonicalJson(representation))` with metadata `{encoding: "gzip", revision, factsRevision}`.
- `readPage` detects the gzip magic and still reads pre-M7 uncompressed files.
- Both behaviours are tested in `tests/storage.test.ts`.

**Incremental updates** use `factsRevision` and per-entity `digest`. An unchanged page or entity is recognized without diffing the whole document, and discovery skips pages whose `factsRevision` is unchanged.

## 7. What is not claimed

- **No universal accuracy.** These are 16 pages in 10 categories, mostly scraping sandboxes and reference sites.
- **Tuning scores are optimistic.** Held-out scores after fixes are no longer unbiased.
- **No real-estate site was evaluated.**
- **No non-English page was evaluated** (G-PAGE-3).
- **No JavaScript-rendered page was evaluated as real data** (G-PAGE-1).
- **Timings are from one container and are indicative only.**
