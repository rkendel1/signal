# Page Intelligence (M5, corrected in M7)

> **M7 corrections.**
> - Real-page measurements are now in PAGE_QUALITY.md.
> - The identity model gained a strength (§2 Identity) and per-entity `digest`; pages gained `factsRevision`.
> - Representations are stored gzip-compressed (§4).
> - New generic rules came from real pages (§2).
> - §7 is updated with the measured state.

> Signal should not need to know what a user is looking for before it can understand what a page contains.

M5 adds a deterministic, site-agnostic layer between *observing* a page and *deciding what matters*.

```
observe (bytes, evidence) ─► represent (signal.page/v1) ─► evaluate (criteria) ─► event ─► notify / overlay
           exact bytes           what exists on the page        what matters to someone     what should happen
```

These are three separate concerns:
- **What exists on a page:** `lib/page`.
- **What matters to someone:** `criteria` with the `entity` condition.
- **What should happen:** the existing event and notification pipeline.

None of them knows about the others' internals.

## 1. Representation: `signal.page/v1`

Normative types: [`lib/page/types.ts`](lib/page/types.ts).

| Part | Content |
|---|---|
| `source` | locator, base URL (used to resolve links, **never fetched**), observation id, content hash, content type |
| `observedAt`, `revision`, `factsRevision` | `revision` = sha256 of the canonical representation **excluding** observation identity and time. Identical content ⇒ identical revision. `factsRevision` (M7) = sha256 of entity ids + digests + relationship triples only: **unchanged by reordering or layout-only changes** |
| `entities[]` | `{id, type, classification, typeBasis{method, rule}, identity{key, basis, strength, ambiguous?, occurrences}, digest, attributes[], evidenceRefs[]}` |
| `attributes[]` | `{name, value, raw, dataType, provenance, method, confidence, evidenceRefs[], ambiguity?}` |
| `relationships[]` | `{from, to, type, method, classification, confidence, evidenceRefs[], conflicts?}`. Examples: `offers`, `seller`, `author`, `hiringOrganization`, `inReplyTo`, `isPartOf`, `hasPart`, `mainEntity`, `sameAs` |
| `collections[]` | `{kind: list \| table \| repeated \| itemlist \| thread, name, itemType, members[], signature?}` |
| `signals[]` | Outputs of specialized interpreters (`ghostpost-unicode/v1`, `invisible-unicode/v1`), structure problems (`page-structure/v1`: invalid or oversized JSON-LD) and access boundaries (`page-access/v1`: login form) |
| `evidence[]` | `{id, locator (CSS path), element, attributes (allow-listed, secrets removed), text (≤300 chars), method, pointer? (JSON pointer for JSON-LD)}` |
| `stats` | element counts, `truncated`, the limits applied, counts by classification |

**Vocabulary stays open.** Types use schema.org names where an explicit mapping applies (`Product`, `Offer`, `JobPosting`, `Article`, `SocialMediaPosting`, `Comment`, `Organization`, `Person`, `Brand`, `TableRow`, `ListItem`, `WebPage`, …). Any other declared type is kept verbatim. Anything that cannot be typed is `Unknown`, with its structure and text retained.

### Facts versus interpretation

| Field | Values | Meaning |
|---|---|---|
| Entity `classification` | `declared` | The page's structured data states the type (JSON-LD, microdata, RDFa) |
| | `semantic` | HTML/ARIA semantics imply it (`<table>` row, `<article>`, the document itself) |
| | `inferred` | A numbered, documented rule inferred it (T1–T6 below) |
| | `unknown` | Retained, not typed |
| Attribute `provenance` | `observed` | The value exactly as on the page (text, attribute, structured-data scalar) |
| | `normalized` | A deterministic parse of an observed value (money, date, availability, URL) |
| | `inferred` | Beyond parsing: relative dates resolved against observation time |
| `confidence` | 1.0 / 0.9 / 0.6 / 0.3 | **A rule tier, not a probability:** declared/observed 1.0, semantic 0.9, structural inference 0.6, weak or ambiguous 0.3 |
| `ambiguity` | `format` | e.g. `03/04/2026` (MM/DD vs DD/MM). Value is `null`, both candidates kept |
| | `relative` | e.g. "3 hours ago". Value is resolved and marked inferred |
| | `conflict` | Two descriptions of the same thing disagree. Both values are kept, and the conflict is recorded on the `sameAs` relationship |

## 2. Extraction pipeline (`lib/page/extract.ts`)

The stages run in a fixed order. No site-specific code exists.

1. **JSON-LD.**
   - Covers `@graph` and arrays. Each nested object with `@type`, or under an entity property, becomes an entity plus a relationship.
   - `@id` references are linked. Unresolved references become `Unknown` entities.
   - `price` + `priceCurrency` become money. `MonetaryAmount` / `QuantitativeValue` become a comparable `amount`.
   - Invalid or oversized blocks are reported as signals, not skipped silently.
2. **Microdata and RDFa.** `itemscope/itemtype/itemprop` and `typeof/property`. Values come from `content`, `href`, `src`, `datetime`, `value` or text, by HTML rules.
3. **Metadata.** Title, `lang`, canonical link, `meta` description/author/keywords, OpenGraph/`article:`/`product:` properties, and h1–h3 headings, all as attributes of the `WebPage` entity.
4. **Semantic HTML / ARIA.**
   - Tables: header cells name the attributes, and each body row is an entity in a `table` collection.
   - `<article>` / `role=article`.
   - `<time datetime>` and `<dl>` pairs.
   - `nav`, `header`, `footer` and `role=navigation` are not content. (M7: `form` is no longer skipped; filter panels and search results often sit inside forms.)
   - `[hidden]`, `aria-hidden="true"` and inline `display:none` are not treated as visible. `hidden="until-found"` **is** accessible content (M7).
   - Tables (M7) have their grid expanded for `rowspan`/`colspan`, name attributes from multi-row headers, and strip footnote markers. Layout tables are scanned for records.
5. **Repeated structures.**
   - Siblings sharing a signature (tag + classes, digits normalized) form a group. The minimum is 3 members, or 2 for `li`, `article`, `tr` or `role=feed/list`.
   - A group becomes a collection when ≥60% of members are record-like. Lists of `li` are always kept. Groups of ≥3 with ≥2 fields each are kept as `Unknown` records.
   - Nested records become `inReplyTo` (comments) or `isPartOf` links to their container record.
6. **Fields per record.** The fields come from:
   - the heading (`name`), `<time>`, and `dl`/`th` labels;
   - "Label: value" text, plus "Sold by / Posted by / by X";
   - class-name hints (a fixed vocabulary: price, author, seller, date, location, salary, …);
   - typed leaf values (money, ranges, dates, availability, ratings, numbers, emails);
   - the first link (`url`) and image (`image`), and the first paragraph (`description`);
   - remaining text, kept under its class name.

   Labels that name a party (seller, brand, employer, author) create the related `Organization` / `Brand` / `Person` entity and the relationship.
7. **Identity across sources.** Entities of the same type and name from different methods get a `sameAs` link. So do (M7) entities of **any** type that share a strong URL identity (a JSON-LD `SingleFamilyResidence` and the visible listing card for it). Price, availability, dates, author and seller are compared, resolving through `offers`. Disagreements become `conflicts` plus `ambiguity` on both attributes. Nothing is merged or resolved silently.
8. **Specialized interpreters.** Injected `SignalDecoder`s (Ghostpost, invisible-Unicode) run per block that contains invisible characters, so each signal has an element locator. Password fields produce a `page-access/v1 login_form` signal. This logic is adapted from `rkendel1/web-monitor`'s `auth-detection.js`, narrowed to structural evidence.
9. **Residual text.** Visible text blocks that no entity covers are kept on the `WebPage` entity (up to 100), so nothing visible is silently dropped.

### Type rules for structural records (first match wins)

| Rule | Condition | Type | Classification |
|---|---|---|---|
| T1 | compensation (money or range), or employer + location | `JobPosting` | inferred |
| T1b (M7) | price + a real-estate quantity (bedrooms, baths, floor size) | `RealEstateListing` | inferred |
| T2 | a price **plus** a product cue (normalized availability, image, seller, brand, sku, rating) | `Product` | inferred |
| T3a/b/c | author + date: nested in a record / in a repeated structure / an `<article>` | `Comment` / `SocialMediaPosting` / `Article` | inferred |
| T4 | `<article>` with a heading | `Article` | semantic |
| T5 | table row | `TableRow` | semantic |
| T6 | list item | `ListItem` | semantic |
| T7 (M7) | contact facts only (telephone, email, website, contactPoint) | `Organization` | inferred |
| – | otherwise | `Unknown` | unknown |

**Known misfire (measured, G-PAGE-12):** a land-lot card (price + image, no bedrooms) is typed `Product` by T2.

**Other M7 rules** (each from a real-page failure; see PAGE_QUALITY.md §3):
- the main record (the innermost container of the single h1) receives page-level property tables and labelled facts;
- `Label:` elements with a sibling value are paired;
- an `<li>` wrapping a single record is promoted to that record;
- records are processed deepest-first;
- indent levels (`aria-level`, `data-depth`, `data-level`, indent classes) produce `inReplyTo`;
- `citation_*` and Dublin Core meta map to scholarly attributes;
- author/publisher/seller text becomes a party entity;
- `data-lat`/`data-lng` become `latitude`/`longitude`;
- `aria-selected` becomes `selected`;
- `rel=next`/`prev` become `nextPage`/`previousPage`;
- a map element's `data-south/west/north/east` becomes `viewportBounds`, and its markers become `viewportMarkers` (a count, not listings).

Vocabulary additions (`vocab.ts`):
- price incl./excl. tax, review count, telephone, website, email, contact point, upc/gtin/ean;
- units (bedrooms, baths, sqft, m², acres, rooms, floors, km, mi);
- prefix labels (`Built 1986` → `yearBuilt`, `No HOA` → `hoaFee` 0, `Price cut $10,000` → `priceReduction`).

T2 originally fired on "name + price". The fuel-price table fixture showed that this overclaims, so a product cue is now required.

### Identity and stability

`entity.id = ent_<hash(type, identity key)>`. The identity key comes from the first that applies:

| Basis | Key |
|---|---|
| `@id` / `itemid` | the declared identifier |
| `url` | normalized link |
| `sku` | sku / gtin |
| `name` | lower-cased name |
| `locator` | element path |

Name, URL and sku identities are stable across observations when content changes, which is what makes `changed`, `added` and `removed` meaningful. Locator identities move if the page structure moves.

**Strength (M7).** `identity.strength` is:
- `strong` for `@id`, url or sku;
- `weak` for a name;
- `positional` for a locator.

**Same key on one page:**
- **Strong identity:** repeated occurrences are the **same** entity. They merge, and `occurrences` counts them (one product shown in two cards).
- **Weak identity:** records sharing the key are kept apart with `_2`, `_3`, marked `ambiguous: true`, and linked by `possiblySameAs` (classification `unknown`). Change detection excludes ambiguous and positional entities and reports them as `uncertain`, never as added/removed/changed. Continuity is not invented.

**Digest.** `digest` = sha256 of the entity's type and its attribute facts, order-insensitive and excluding evidence and layout.

The scenarios are in `tests/lib/identity.test.ts` and are summarized in PAGE_QUALITY.md §5a.

## 3. Criteria over the representation

The `entity` condition (`lib/page/query.ts`) joins `all`, `any`, `not`, `field`, `text`, `signal` and `content`. All of them are evaluated by the same deterministic evaluator, with a full trace.

```jsonc
{ "entity": {
    "type": "Product" | ["SocialMediaPosting","Comment"],
    "where": [ { "attr": "price", "op": "lt", "value": 200, "currency": "USD" },
               { "attr": "hiringOrganization.name", "op": "eq", "value": "Lumen Analytics" },
               { "attr": "compensation", "op": "overlaps", "value": [150000, 170000] },
               { "attr": "availability", "op": "changed" } ],
    "related": [ { "rel": "seller", "entity": { "where": [ { "attr": "name", "op": "contains", "value": "summit" } ] } } ],
    "inCollection": { "kind": "repeated", "itemType": "Product" },
    "state": "present" | "added" | "removed",
    "quantifier": "any" | "all" | "none",
    "count": { "op": "gte", "value": 3 } } }
```

- **Operators:**
  - Comparison: `eq neq lt lte gt gte contains not_contains matches in exists absent`.
  - Range: `between overlaps`.
  - Change: `changed unchanged increased decreased`, compared to the **same entity id** in the previous observation's representation.
- **How values compare:**
  - Money compares by amount, with an optional currency filter.
  - Ranges: `lt` uses the minimum and `gt` the maximum; `overlaps` and `between` are interval tests.
  - Dates compare as instants.
  - Ambiguous (`null`) values never satisfy a comparison; use `absent` to find them.
- **Paths and aliases:** dotted paths follow relationships. Documented aliases cover where schema.org puts things: `price` → `offers.price`, `availability` → `offers.availability`, `compensation` → `baseSalary.amount`, `date` ↔ `datePublished`, and so on (`ATTRIBUTE_ALIASES`).
- **Dedup identity:** the matched entity ids and their values. Re-rendering a page with the same facts is suppressed; a change to a matched entity's value is a new event.
- **What an event carries:** the matched entities (`id`, `type`, `name`, values, previous values, evidence refs) in its trace, readable excerpts such as `Product “Canyon 1”: price=USD 179.99`, and `evidence.pageRef` / `pageRevision`.

## 4. FeltKit integration (`feltkit/pages.ts`, `feltkit/monitors.ts`)

| Function | Kind | What it does |
|---|---|---|
| `pages:inspect {sourceId}` | action | Fetches an http(s) source (robots.txt, SSRF guard, byte cap), then records the observation, evidence and representation. **No monitor and no criteria needed** |
| `pages:push {sourceId, html, baseUrl?}` | mutation, capability `signal.pages.push` | For `dom` sources, e.g. a browser-rendered snapshot of a dynamic page |
| `pages:get {pageId}` / `pages:list {sourceId}` | query | The full representation / summaries |
| `monitors:observe` / `monitors:push` | existing | Now also build the representation for HTML and evaluate `entity` conditions against it and against the previous one |

Storage uses only what FeltKit already provides:
- the raw bytes in **Files** (unchanged);
- the representation's canonical JSON in **Files** (`metadata.kind = signal.page`). Since M7 it is **gzip-compressed** (`encoding: "gzip"`, about 10× smaller; the decision is in PAGE_QUALITY.md §6). Pre-M7 uncompressed files are still read;
- an index row in `signal_pages`.

**Page intelligence keeps the structure, not the page.**
- `pages:push` and `pages:inspect` record the content hash, size and provenance (`bodyRetained: false`) of what was observed, plus the representation. Every value in the representation carries its own evidence: locator, observed text and the raw string.
- The page itself is not copied into Signal. A page is re-read by capturing it again, not by re-extracting stored bytes.
- **Monitors still retain the exact bytes**, because an event's evidence is re-verified against them (`events:evidence`).
- This replaced M5's "raw bytes are the authority" for page intelligence. It was changed after a real capture (1.7 MB) exceeded the runtime's 1 MiB file limit, and because storing whole third-party pages is not the product.

## 5. Security and bounds

- **Nothing on the page runs or is followed.** Scripts are never executed (cheerio parses without scripting). Page-derived URLs are never fetched; links, images and references are recorded only.
- **Unsafe links are dropped.** `javascript:`, `data:`, `vbscript:`, `file:` and `blob:` links are not retained.
- **Secrets are excluded.** Secret-looking query parameters are redacted in values *and* in `raw` (`token`, `session`, `sid`, `key`, `signature`, `password`, `code`, …), and tracking parameters are dropped. Form field values are never read. Meta tags whose name suggests a credential (csrf, xsrf, token, nonce, session, …) are never copied. Evidence attributes are allow-listed.
- **Bounds** (`DEFAULT_PAGE_LIMITS`): 25,000 elements, 2,000 entities, 64 attributes per entity, 1,000 characters per value, 512 KB per JSON-LD block, 2,000 JSON-LD nodes, depth 8, and 100 residual text blocks. Exceeding a bound sets `stats.truncated`; it never fails silently.
- **Authorization is unchanged.** Ownership of `pageId` and `sourceId` is enforced by the app's `authorize` hook (tested).

## 6. What `rkendel1/web-monitor` contributed

| From web-monitor | Use in M5 |
|---|---|
| cheerio 1.2.0 as the HTML parser | The same dependency and version, so the M4 convergence shares a parser |
| `normalizeTargetUrl` (tracking-param stripping, sorted query, no fragment) | `safeUrl`, extended with secret redaction and scheme filtering |
| `DEFAULT_LIMITS` (bounded extraction) | `DEFAULT_PAGE_LIMITS` |
| `detectAuthState` | Narrowed to the structural part (password field → `page-access/v1`). Its URL-substring and "dashboard"-text rules were not adopted: too many false positives |
| Five condition types, and the LLM "semantic decision" | Not used. Signal's criteria are a superset, and M5 is deterministic |

## 7. What is not claimed

- **Coverage is not universal.** M7 measured 16 real pages in 10 categories (PAGE_QUALITY.md). The first untuned held-out run failed attribute understanding on 3 of 6 pages. Generic fixes followed, so the current held-out scores are no longer unbiased. The measured remaining failures are: HN cross-row stories, PyPI sidebar facts, duplicate rows across tables, and a lot typed as `Product`.
- **Heuristics lean on English.** Labels, availability phrases, class hints and relative dates are mostly English.
- **Dynamic content needs a rendered snapshot pushed by a caller.** Signal does not run a headless browser (G-PAGE-1).
- **AI-suggested mappings are not implemented.** The intended path is a reviewable, explicitly accepted addition to `vocab.ts` tables (G-PAGE-5).
