# Discovery Model (M7)

> A page tells Signal what information is available. Context tells Signal where to look. Intent tells Signal what matters. Discovery finds the candidates. Evidence explains every result.

Discovery answers the question "which things, across what I have looked at, satisfy what I care about, and how sure is that answer?" It is built **on** `signal.page/v1`. It adds no store, scheduler, crawler or extension.

**Implemented in M7:**
- `lib/discovery/discover.ts`: pure and deterministic;
- the FeltKit query `discovery:evaluate` (capability `signal.discovery.evaluate`);
- tests: `tests/lib/discovery.test.ts` (8) and `tests/pages.test.ts` (1, through FeltKit).

**Not implemented:** interactive refinement and execution of the scan plan. Both are M8.

## 1. Concepts and where each one lives

| Concept | Meaning | Representation | Authority |
|---|---|---|---|
| **Page** | What was observed | `signal.page/v1` in Files, indexed in `signal_pages` | Raw observed bytes (Files) |
| **Context** | Where the user is looking: URL, filters, sort, map bounds, selection, result counts | `DiscoveryContext`: every value tagged `page-explicit` / `page-inferred` / `user` / `unknown`, with its basis | Derived from the page, or supplied by the user |
| **Intent** | What matters: target types, criteria, derived metrics, preferences | `signal.intent/v1` (versioned) | The user. Supplied per call today; persisting intents is M8 (§9) |
| **Scope** | The region being searched (bounds) | `DiscoveryScope {bounds?, source}` | User-drawn > page-explicit > unknown |
| **Sources** | Pages examined, plus external enrichments | `pages[]`, `Enrichment {source{id, method, observedAt}, records[]}` | Each source for its own values; enrichments are never page facts |
| **Candidate** | One thing in the world, reconciled from all its descriptions | `Candidate {key, entityIds[], status, criteria[], metrics, missing[], changed?, evidenceRefs[]}` | Derived. Recomputed from pages, never stored as truth |
| **Evaluation** | The tri-state result of each criterion, with values and provenance | `CriterionResult {result: true / false / unknown, reason, values, provenance}` | Derived |
| **Coverage** | What was and was not examined | `DiscoveryCoverage` | Derived. Claims exhaustiveness only with a stated basis |
| **Plan** | What examining next would resolve | `ScanSuggestion[]`, proposals only | Derived. Execution belongs to the caller (browser session, a background job, or the user) |
| **Evidence** | Why | Each candidate keeps `entityIds` and `evidenceRefs` into its pages; each criterion keeps its values and provenance | Pages |

## 2. Contracts (implemented)

The normative types are in `lib/discovery/discover.ts`.

```ts
DiscoveryIntent  { schema: 'signal.intent/v1', id, version, name, target: { type: string[] },
                   criteria: IntentCriterion[], metrics?: MetricDefinition[], preferences? }
IntentCriterion  { id, label, where: AttrPredicate, metric?: string, absent?: 'unknown' | 'false' }
MetricDefinition { name, formula: Formula }      // Formula = attr | const | mul | add | div | sub
DiscoveryContext { url, query, sort, filters[], bounds, declaredTotal, shown, nextPage, viewportMarkers, selection }
                 // each a ContextValue { value, source: page-explicit|page-inferred|user|unknown, basis, evidenceRef? }
DiscoveryResult  { schema: 'signal.discovery/v1', intent, context, scope, candidates[], coverage, plan[], pages[], resultDigest }
```

**Reconciliation with the existing architecture:**
- `IntentCriterion.where` **is** M5's `AttrPredicate`, with the same attribute paths and aliases (`price` → `offers.price`, `latitude` → `geo.latitude`).
- Discovery does not add a second predicate language. Only decidable operators are accepted: `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `contains`, `exists`, `between`.
- Change operators (`changed`, `decreased`, …) belong to monitoring criteria, and `validateIntent` rejects them rather than evaluating them as false.

**FeltKit:** `discovery:evaluate {pageIds[≤20], intent, previousPageIds?, enrichments?, scope?}`.
- It is a query, so it cannot fetch and does not write.
- It needs the `signal.pages.read` permission. Ownership is checked for every page id in the handler, because the `authorize` hook checks single ids only.
- It publishes a `returns` schema as an AppPort capability. Invalid JSON and undecidable intents return `INVALID_ARGUMENT`.

## 3. Evaluation rules

1. **Three-valued.** A criterion is `true`, `false` or `unknown`.
   - A missing value is `unknown` (reason `not shown`).
   - An `ambiguity`-flagged value is `unknown` (reason `value ambiguous`).
   - Absence is `false` only when the intent explicitly says so (`absent: 'false'`) — a closed-world choice the intent author makes and documents. Example: "recently reduced", where the source always badges reductions.
2. **Status.**
   - `out_of_scope` when coordinates are known and outside the scope;
   - otherwise `non_match` if any criterion is `false`;
   - otherwise `possible` if any criterion is `unknown`, or scope cannot be decided (no coordinates);
   - otherwise `match`.
   **Missing information is never a match, and ambiguity never satisfies a criterion.**
3. **`changed` is a flag, not a status.** A candidate can be a `match` that changed, or a `non_match` that changed. `changed {since: previousResultDigest, fields[]}` lists the criteria whose normalized values differ from the previous result. `"4"` restated as `4` is not a change.
4. **Reconciliation.** Descriptions of the same thing become one candidate, joined by:
   - a `sameAs` relationship;
   - or the same strong URL identity. The extractor now links entities across types that share a strong URL identity, e.g. a JSON-LD `SingleFamilyResidence` and the visible `RealEstateListing` card.

   **Weak (name-only) identities are never joined.**
5. **Conflicts.** When descriptions disagree (e.g. a stale JSON-LD price of $279,000 vs a card showing $289,000), a criterion is decided only if **every** conflicting value gives the same outcome. Otherwise it is `unknown`, with reason `descriptions disagree (conflict)`. No value is silently picked.
6. **Derived metrics** are `calculated`. They list each input with its provenance: `page`, `page-conflict`, `external-estimate` (with source id) or `missing`.
   - When inputs conflict, the metric carries `possibleValues`, and the criterion is decided only if all of them agree.
   - Page facts take precedence. An external value is used only when the page does not state one.
7. **Preferences only order results.** They never include or exclude.

## 4. Context and viewport semantics (requirement 7)

| Value | Source | Basis recorded |
|---|---|---|
| Bounds from `south/west/north/east`, `sw_lat…`, or `bbox` URL parameters | page-explicit | "URL bounds parameters" |
| Bounds from a map element's `data-south/west/north/east` | page-explicit | "map element data attributes" + evidence |
| Bounds the user drew or selected | user | Overrides the page |
| Sort, query, other filters | page-explicit (URL parameters) | – |
| "Showing 1–12 of 87 homes" | page-inferred (read from text) | Quoted text + evidence |
| `rel=next` | page-explicit | – |
| Map markers with coordinates | page-explicit **count of markers** | Not assumed to be listings |
| Selection | user, or page-explicit (`aria-selected` / `aria-current`) | – |
| Anything else | unknown, with the reason it is unknown | – |

**Markers are not listings.** The metro fixture shows 20 markers and 12 cards. Coverage reports "8 map markers without a listing on this page" (20 markers − 12 listed cards) as `unavailable` and does not invent 8 candidates.

## 5. Coverage (requirement 8)

| Field | Meaning |
|---|---|
| `pagesExamined` | Pages in this evaluation |
| `declaredTotal` | What the source says exists (page-inferred), or null |
| `listed` | Items shown in the result lists that hold candidates, of any type |
| `nonTarget` | Listed items not of the target type (the lot) |
| `discovered` | Candidates (reconciled target-type entities) |
| `extracted` | Candidates with at least one criterion value |
| `categorized` | Candidates with a known type |
| `inScope` / `outOfScope` | Relative to the scope |
| `evaluated` / `partiallyEvaluated` | In-scope candidates with every criterion decided / with some unknown |
| `ambiguous` | Candidates with ambiguous identity or conflicting descriptions |
| `notYetExamined` | `declaredTotal − listed` when the total is known; otherwise null (unknown, **not zero**) |
| `unavailable[]` | What could not be determined, and why (unlisted markers, missing metric inputs) |
| `exhaustive` + `exhaustiveBasis` | `true` only when a declared total exists, every declared item was examined, and there is no further page. The basis is always stated |

**Not represented yet:** `failed`, for a page that could not be observed. A refused observation produces no page, so the caller knows about it, but discovery does not list it. This is M8, when discovery drives observation.

## 6. Scanning strategy (requirement 9)

`plan[]` holds deterministic proposals ranked by what they would resolve. **Nothing is executed by discovery.**

| Kind | When | Executes in | Why there |
|---|---|---|---|
| `next_page` | `rel=next` exists and the declared total is not covered | browser-session | The user's session already has the context, filters and any sign-in. Background fetching of a search page may not be permitted |
| `detail_page` | A candidate is `possible` because a page fact is missing (e.g. bedrooms) | browser-session | Same reason; detail pages are what the product-listing evaluation reports as `not_accessible` |
| `enrichment` | A metric needs an input no page states (rent) | background | An authorized external dataset, not page browsing |
| `skip_unchanged` | A page's `factsRevision` equals one in the previous result | browser-session | Evidence reuse: nothing to re-evaluate |

**Incremental by construction:**
- `factsRevision` identifies unchanged pages;
- per-entity `digest` identifies unchanged entities;
- `previousPageIds` recomputes the previous result from stored pages, so it needs no stored result.

**Not built:** a scheduler (G-PLAT-1) and an extension host (G-OVL-1). M8 decides who executes `browser-session` proposals.

## 7. Real-estate scenario (requirement 6) — synthetic

No real listing site is used: their terms prohibit automated access.

**Fixtures.** `scripts/gen-discovery-fixtures.ts` generates:
- `metro-p1.html`: 12 cards, "Showing 1–12 of 87 homes", 20 map markers, `rel=next`;
- `neighborhood.html`: 8 cards, exhaustive; JSON-LD for 2 homes, one with a **stale price**;
- `neighborhood-later.html`: one price cut and one new listing;
- `rent-estimates.json`: an external estimate dataset, with no estimate for 3 homes.

**Truth.** `truth.json` is computed by the generator from its own data, never from the extractor.

| Step | Intent / scope | Result vs truth |
|---|---|---|
| 1. Metro page | price < $350k, beds ≥ 3, gross yield (rent×12/price, rent = external estimate) > 8% | **Equal.** 6 match, 2 possible (birch: bedrooms not shown; willow: no rent estimate), 3 non-match. The lot is not a candidate. Coverage: declared 87, listed 12, 75 not yet examined, not exhaustive. Plan: next page, birch detail page, birch and willow rent enrichment |
| 2. Narrow scope | Same intent, user-drawn neighborhood bounds | **Equal.** 4 out_of_scope (not non_match); scope source `user` |
| 3. Refine | + built after 1980, no HOA, yield > 10%, recently reduced (`absent: 'false'`) | **Equal.** 1 match (pine-9). elm-121: card $289k and JSON-LD $279k give yields of 9.76% vs 10.1%, so the yield is `unknown (conflict)`; the status is `non_match` only because "recently reduced" is false. Exhaustive: 8 of 8 declared listed, 1 not a target |
| 4. Later observation | Same refined intent, previous = step 3 | **Equal.** oak-48 `changed: [price, reduced, yield]`; juniper-3 new. Re-running on the same page proposes `skip_unchanged` and gives an identical `resultDigest` |

Values stay distinct throughout:
- **observed:** card text, JSON-LD;
- **calculated:** yield, which names its inputs;
- **external estimates:** rent, which names its source id.

A missing value is never filled in.

## 8. Page-initiated and multi-page discovery

| Mode | How |
|---|---|
| **Page-initiated** | The page the user is on supplies the context (bounds, filters, counts) and the first candidates. The intent supplies the criteria |
| **Multi-page** | `pages[]` holds several pages: result pages and detail pages. The same thing on several pages becomes one candidate (same URL identity), and its values from all pages are evaluated together, with conflicts handled by rule 5. Context is taken from the first page |

## 9. Limits

- **Not tested on real listing sites.** Synthetic fixtures only.
- **Lots are typed `Product`** by the extractor (G-PAGE-12). They are excluded only because the intent targets residential types.
- **Geo scope is a bounding box.** No polygons yet.
- **Context parameter names are a fixed list.** Other sites encode bounds differently; unknown encodings report `unknown`.
- **Intents are not persisted.** Saving intents, refining them interactively and executing plans in the browser session are M8 (Interactive Discovery).
- **Enrichment joins by exact URL only.**
