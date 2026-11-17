# Signal — Acceptance Report

## M7 — Page Quality and Discovery Readiness (2026-11-17)

### Baseline, verified before any change
The branch was at `1523f14` (M5): Rust 12/12, `feltkit test` 55/55, `tsc` clean. During M7, the real pages and their labels were committed **before** evaluation:
- `a5d70af`: tuning pages and labels;
- `3d71e47`: held-out pages and labels.

### Final verification

| Command | Result |
|---|---|
| `cargo test --manifest-path codecs/ghostpost-unicode/Cargo.toml` | **12 passed**, 0 failed |
| `npx feltkit test` | **90 passed**, 0 failed, 0 skipped, 0 cancelled. The 55 M5 tests pass, with one M5 test file extended |
| `npx tsc --noEmit -p .` | **0 errors** |
| `node scripts/evaluate-pages.ts` | [`docs/page-quality.json`](docs/page-quality.json). The current measured metrics are identical to the run before the final extractor change (only representation byte counts moved) |
| `node scripts/summarize-quality.ts` | The per-category and per-method tables in PAGE_QUALITY.md §2 |
| `node scripts/analyze-size.ts` | [`docs/size-analysis.json`](docs/size-analysis.json) |
| `node scripts/bench-storage.ts` | [`docs/storage-options.json`](docs/storage-options.json) (6.5 min, mostly the rejected columnar decoder) |
| `npm run bench` | [`docs/bench.json`](docs/bench.json) |

The 35 new tests:
- **`tests/lib/page-quality.test.ts` (16):** every real page is scored against its independent label and must not fall below the committed measurement.
- **`tests/lib/identity.test.ts` (9):** identity and change scenarios on the real books catalog.
- **`tests/lib/discovery.test.ts` (8):** context provenance; four discovery steps equal to the generator truth; coverage; conflicts; absence semantics; change; rejection of undecidable intents.
- **`tests/pages.test.ts` (+1):** `discovery:evaluate` through FeltKit, with owner-only access and invalid input.
- **`tests/storage.test.ts` (1):** gzip storage plus legacy read.

### Requirements

| # | Requirement | Evidence | Result |
|---|---|---|---|
| 1 | Real-page evaluation suite with authorized access, provenance, independent expectations, sanitized fixtures | 16 pages and 2 recorded refusals; `*.provenance.json`; oracle labels committed before evaluation; arXiv and HN sanitized | ✅. No real-estate site and no real JSON-LD conflict page: the permitted sources had none (synthetic instead) |
| 2 | Metrics per category and per method, outcome taxonomy, no single aggregate | PAGE_QUALITY.md §2 | ✅ |
| 3 | Size causes, options A–E, benchmarked decision, traceability kept | PAGE_QUALITY.md §6. gzip chosen: 10.6× smaller, lossless, 14 ms decode | ✅ |
| 4 | Identity and change scenarios; uncertainty represented, not invented | `tests/lib/identity.test.ts`, PAGE_QUALITY.md §5a | ✅ |
| 5 | Discovery model and contracts reconciled with the architecture | DISCOVERY_MODEL.md; `lib/discovery`; `discovery:evaluate` | ✅. Persisted intents deferred to M8 |
| 6 | Real-estate progressive scenario, synthetic, values never invented | DISCOVERY_MODEL.md §7; all 4 steps equal `truth.json` | ✅ |
| 7 | Context and viewport semantics, with markers ≠ listings | `extractContext` sources; 20 markers vs 12 listings reported | ✅ |
| 8 | Coverage states; no unproven exhaustiveness | `DiscoveryCoverage` | ✅ except `failed` (G-DISC-4) |
| 9 | Incremental scanning strategy; browser-session vs background; no scheduler or extension | `plan[]` with `executesIn`; `skip_unchanged` via `factsRevision` | ✅. Proposals only |
| 10 | Candidate statuses; missing ≠ match; ambiguity never satisfies | match / possible / non_match / out_of_scope plus the `changed` flag; the conflict tests | ✅ |
| 11 | Architecture decisions, current vs future | CAPABILITY_ARCHITECTURE.md §6 | ✅ |
| 12 | Deliverables | PAGE_QUALITY.md, PAGE_INTELLIGENCE.md (corrected), DISCOVERY_MODEL.md, CAPABILITY_ARCHITECTURE.md, CAPABILITY_CONTRACTS.md, GAP_REGISTER.md, EXTRACTION_PLAN.md, this report; fixtures with provenance; results; reproducible scripts | ✅ |

### Headline measurements

**Held-out first run (untuned; the only unbiased figures).** Attribute recall:

| Page | Recall |
|---|---|
| countries | 0.000 |
| tallest | 0.096 |
| pyevents | 0.333 |
| hockey | 1.000 |
| wstables | 1.000 |
| pypi | 1.000 |

Entity recall was ≥ 0.989 on all six.

**Current (after generic fixes):**
- every page has attribute recall ≥ 0.976, except hn-item at 0.600;
- traceability is ≥ 0.998 everywhere.

PAGE_QUALITY.md has all the figures and the disclosures (label correction, scorer corrections, consumed held-out set).

**Storage:** the 1,000-product representation is 3.43 MB as JSON and 324 KB stored (gzip). Encode takes 21 ms and decode 14 ms.

**Correction to the M5 report.** M5 attributed the size to "per-value evidence". M7 measured that evidence *text* is only 3–7%. JSON keys (24–41%) and CSS locators (4–31%) dominate.

**Observe cycle:** p50 51.3 ms, p95 71.6 ms (M5: 51.4 / 69.3), so gzip adds no measurable cost. Push cycle: p50 23.1 ms. Duplicate suppression is unchanged: 40 events, 20 suppressed, 40 notifications.

### Defects found and fixed in M7
1. **Money parsing:** `$1033.99` became 103; `$1 033,99` failed.
2. **Quantity parsing:** `1,540 sqft` became 540.
3. **Quadratic containment checks:** 3.5 s on a 1.4 MB page, now 0.4 s.
4. **Order sensitivity:** `factsRevision` changed when a list was reordered (the digest is now order-insensitive).
5. **Map markers vs listings:** the unlisted-marker count subtracted candidates, not listed cards (9 reported instead of 8). Found while checking DISCOVERY_MODEL.md against output; fixed and asserted.
6. **Generic extraction failures** from the held-out run, listed in PAGE_QUALITY.md §3.

### Not verified
- **Unbiased accuracy after the fixes** (G-PAGE-9).
- **Real listing sites** (G-DISC-2).
- **Non-English pages** (G-PAGE-3).
- **JavaScript-rendered real pages** (G-PAGE-1).
- **Discovery execution**, i.e. plans run in a browser session or in the background (M8).
- **`signal.discovery.evaluate` called through `/appport`.** It was tested through FeltKit's test client only.

---

## M5 — Universal Page Intelligence (2026-11-17)

### Baseline, verified before any change
The branch was at `80ca98d`: Rust codec 12/12, `feltkit test` 28/28, `tsc` clean.

### Final verification

| Command | Result |
|---|---|
| `cargo test --manifest-path codecs/ghostpost-unicode/Cargo.toml` | **12 passed**, 0 failed |
| `npx feltkit test` | **55 passed**, 0 failed, 0 skipped. That is the 28 M2 tests (unmodified) plus 27 new |
| `npx tsc --noEmit -p .` | **0 errors** |
| `node scripts/bench-pages.ts` | [`docs/bench-pages.json`](docs/bench-pages.json) |
| `node scripts/bench.ts` | [`docs/bench.json`](docs/bench.json), re-measured after M5 |

The 27 new tests:
- **`tests/lib/page.test.ts` (13):** extraction on 8 unrelated page types, evidence traceability, determinism, security, Ghostpost as an interpreter, value typing.
- **`tests/lib/page-criteria.test.ts` (10):** the six requested criteria plus relationships, aliases, quantifiers and ambiguity.
- **`tests/pages.test.ts` (4):** FeltKit end to end (inspect over HTTP, the entity-criteria pipeline, dynamic content in **real Chromium**, all fixtures through `pages:push`).

### Acceptance criteria

| Criterion | Evidence | Result |
|---|---|---|
| An unfamiliar page is inspected without a site-specific adapter | `pages:inspect` on the product page over HTTP; all 8 fixtures through `pages:push`; no site code exists | ✅ |
| Accessible structures become a typed, categorized representation | Product, JobPosting, Article, SocialMediaPosting, Comment, TableRow, Offer, Organization, Person, Brand and Unknown, each with `classification` and the rule that produced it | ✅ |
| Relationships between entities and attributes are preserved | Ridgeline 2 → $249.99, InStock, seller Summit Supply Co.; Canyon 1 → $179.99, OutOfStock, seller Valley Gear (one shared Summit entity for two products); replies → `inReplyTo` their post; JobPosting → `hiringOrganization`; Product → `offers` → Offer → `seller` | ✅ |
| Every extracted value has traceable evidence | The test resolves **every** attribute's evidence locator back to exactly one element in the source HTML across 7 fixtures. JSON-LD evidence carries JSON pointers | ✅ |
| Unknown or ambiguous structures are retained honestly | Observatory log → 3 `Unknown` entities (class-named attributes) in a collection; uncovered blocks kept as page text; `03/04/2026` → value `null` with two candidates; JSON-LD $39.95/InStock vs visible $44.95/OutOfStock → both kept, `sameAs` with explicit conflicts; invalid JSON-LD reported as a signal | ✅ |
| Identical input ⇒ reproducible output | Byte-identical JSON on re-extraction; identical `revision` across observations (and across two live `pages:inspect` calls); a one-price change alters the revision and only that value, with entity ids stable | ✅ |
| Criteria evaluate the representation without knowing the source site | The `entity` condition; tests use only types, attributes and relationships | ✅ |
| A match creates an evidence-backed event through the existing pipeline | "Any product under $200" → event with matched entity Canyon 1, excerpt `Product “Canyon 1”: price=USD 179.99`, `evidence.pageRef`, hash-verified raw evidence, and an AppPort notification. A re-render is suppressed; a price drop and an availability change each produce events | ✅ |
| Existing Ghostpost and monitoring tests still pass | The 28 M2 tests unmodified, 12 Rust tests; Ghostpost decoded as a page signal with an element locator | ✅ |
| Tested on multiple unrelated page types | Product listing, job listing, article, discussion, table, JSON-LD with conflicting visible content, dynamic page, unknown structure | ✅ |
| Limitations explicit | GAP_REGISTER G-PAGE-1…8; the three platform gaps kept visible | ✅ |

Requested criteria examples, all tested: product under $200; job title + compensation range; page adds an organization; publication date changes; discussion post matching text; existing product changes availability.

### Defects found by the new tests and fixed
1. **Script source leaked into evidence text.** Inline `<script>` text appeared in the document-level evidence because cheerio's `.text()` includes it. Text extraction now skips script, style, template and noscript.
2. **A session token leaked through `raw`.** The normalized URL was redacted but the "as observed" `raw` string kept `session=abc123`. Raw URL strings are now redacted too.
3. **"Name + price ⇒ Product" overclaimed.** A fuel-price table became Products. Rule T2 now requires a product cue.
4. **Posts with and without replies were not grouped**, because the signature included child tags. It is now tag + classes.
5. **`monitors:push` refused `dom` sources whose locator is an http URL.** The rule is now by source type.

### Measurements

Extraction per fixture (30 runs each, in-process; includes Ghostpost decoding):

| Fixture | HTML bytes | p50 ms | p95 ms | entities | relationships | collections | evidence | representation bytes |
|---|---|---|---|---|---|---|---|---|
| article | 643 | 1.13 | 3.31 | 3 | 2 | 0 | 10 | 6,600 |
| discussion | 1,058 | 1.59 | 3.32 | 9 | 8 | 2 | 21 | 13,304 |
| dynamic | 729 | 0.41 | 1.16 | 1 | 0 | 0 | 5 | 2,375 |
| job | 890 | 1.35 | 2.65 | 4 | 4 | 1 | 21 | 11,765 |
| jsonld-conflict | 713 | 0.77 | 2.15 | 7 | 7 | 0 | 22 | 11,819 |
| products | 1,399 | 1.44 | 2.65 | 6 | 6 | 1 | 29 | 16,121 |
| table | 567 | 0.73 | 2.32 | 4 | 3 | 1 | 20 | 9,864 |
| unknown | 605 | 0.82 | 1.41 | 4 | 3 | 1 | 18 | 8,416 |

Scale (synthetic catalog pages, 5 runs each):

| Page | HTML bytes | p50 ms | p95 ms | entities | relationships | representation bytes | entity criteria ms | truncated |
|---|---|---|---|---|---|---|---|---|
| 100 products | 18,326 | 20.26 | 24.65 | 121 | 200 | 350,873 | 1.49 | False |
| 500 products | 93,156 | 93.37 | 102.47 | 521 | 1000 | 1,690,515 | 1.85 | False |
| 1,000 products | 186,626 | 213.54 | 246.08 | 1021 | 2000 | 3,364,803 | 5.71 | False |

Full cycles after M5 (`docs/bench.json`, 60 cycles each, FeltKit in-process runtime, loopback HTTP):

| Cycle | p50 | p95 | Before M5 (p50) | Why it changed |
|---|---|---|---|---|
| `monitors:observe` (HTTP, HTML) | 51.4 ms | 69.3 ms | 34.8 ms | Builds the representation, stores it in Files, and reads the previous one back |
| `monitors:push` (text) | 21.5 ms | 34.3 ms | 20.3 ms | Not HTML, so no representation is built |

Duplicate suppression is unchanged: 40 events and 20 suppressed out of 60 matching cycles, exactly as expected, with 40 notifications.

**Representation size** is 10–18× the HTML (3.4 MB for 1,000 products), dominated by per-value evidence. This is a deliberate traceability trade-off and is registered as G-PAGE-2 for decision.

### Not verified
- **Real websites:** no live-site precision or recall was measured (G-PAGE-4).
- **Non-English pages** (G-PAGE-3).
- **Shadow DOM and iframes in static HTML** (G-PAGE-7).
- **Server-side rendering:** dynamic content was verified only through a caller-pushed Chromium snapshot (G-PAGE-1).

---

## M2 — Monitoring vertical slice (accepted baseline)

Environment: Linux x64, Node v22.23.4, Rust 1.97 (`wasm32-unknown-unknown`, wasm-bindgen 0.2.106), `@feltdb/feltkit` 0.3.31 (bundles `@feltdb/core` 0.21.0 and `@appport/services` 0.19.0), Playwright-driven headless Chromium. All results below were produced by commands run in this repository on 2026-11-17.

## 1. Commands and results

| Command | Result |
|---|---|
| `cargo test --manifest-path codecs/ghostpost-unicode/Cargo.toml` | **12 passed**, 0 failed |
| `npx feltkit test` (= `npm test`) | **28 passed**, 0 failed, 0 skipped |
| `npx tsc --noEmit -p .` | **0 errors** |
| `node scripts/bench.ts` (= `npm run bench`) | Output in [`docs/bench.json`](docs/bench.json), summarized in §3 |
| `sh scripts/build-codec.sh` | Rebuilds `codecs/ghostpost-unicode/pkg` from source |
| `node scripts/gen-compat-fixtures.mjs <ghostpost checkout>` | Regenerates the cross-implementation fixtures from Ghostpost's shipped WASM |

The 28 FeltKit tests break down as follows:
- **Library** (`tests/lib`): codec 9, criteria/extraction/normalization 10.
- **Application** (`tests/signal.test.ts`, 7): vertical slice; replay idempotency; refusals; authorization; SSRF; pushed content, embedded signals and injection; concurrency.
- **Use cases** (`tests/examples.test.ts`, 1): all 7 documented use cases, each with a match and a non-match.
- **Overlay** (`tests/overlay.test.ts`, 1): real Chromium.

### Baseline: Ghostpost itself

| Check | Result |
|---|---|
| `cargo test` in `ghostpost/wasm` | **Did not compile** (3 errors in the test module) |
| `npm test` in `ghostpost` | No test script exists |
| Shipped `wasm/pkg` probed in Node | Round-trips correct. The defects below reproduced |

## 2. Vertical slice: required outcomes

| # | Required | Demonstrated by | Result |
|---|---|---|---|
| 1 | Register an authorized observation source | `sources:register` with URL shape check; `robots.txt` honoured | ✅ |
| 2 | Read an accessible webpage | `monitors:observe` (action) over real HTTP, conditional GET (`If-None-Match` sent, 304 → `observation_not_modified`) | ✅ |
| 3 | Extract its content | Normalization drops `<script>`; regex extraction `Price: $95.00` → `95` | ✅ |
| 4 | Detect a relevant change | `previous: 129 → actual: 95` recorded in the trace | ✅ |
| 5 | Evaluate a user-defined criterion | `signal.criteria/v1`, immutable `price-drop@v1`, full trace | ✅ |
| 6 | Produce a durable matched event | `signal_events`, insert-once; survives `restart()` | ✅ |
| 7 | Preserve evidence and provenance | Exact bytes in Files; `sha256` re-verified on read (`verified: true`); `finalUrl`, `httpStatus`, `robots` | ✅ |
| 8 | Deliver a notification through an existing mechanism | **AppPort Services Notifications** via `ctx.afterCommit`: body `price: 95 (was 129)`, linked back to the event; Bob's inbox empty | ✅ |
| 9 | Show the result in an overlay / app interface | Overlay in Chromium: alert, matched values, evidence (hash verified), acknowledge (durable). Screenshot: [`docs/overlay.png`](docs/overlay.png) | ✅ (host is a test bridge; see G-OVL-1) |
| 10 | Suppress duplicate alerts for the same unchanged condition | Re-rendered page with the same price → `suppressed_duplicate`. History: `no_match, event, suppressed_duplicate, event, no_match, event` | ✅ |
| – | Ghostpost decoder through the same boundary | A pushed feed containing a Ghostpost post matches `{signal:{codec:'ghostpost-unicode/v1', payloadContains:'launch'}}`. The overlay reveals `Code WIDGET20 saves 20%` via WASM in the browser | ✅ |
| – | No LLM | None in any path | ✅ |

## 3. Measurements (M2 run; `docs/bench.json` now holds the post-M5 re-run summarized above)

| Metric | p50 | p95 | Notes |
|---|---|---|---|
| WASM init | 0.90 ms | – | 172,100-byte module (synchronous compile + instantiate) |
| Detect + decode, short payload | 0.011 ms | 0.018 ms | |
| Detect + decode, 10 KB DEFLATE payload | 0.072 ms | 0.143 ms | |
| Scan 82,929-char page (2,000 paragraphs, 50 payloads), Ghostpost decoder | 1.88 ms | 3.04 ms | All 50 found |
| Same page, format-agnostic invisible detector | 0.40 ms | 0.75 ms | |
| Criteria evaluation (6-leaf condition incl. fuzzy over ~6 KB text) | 0.16 ms | 0.35 ms | |
| **Full HTTP cycle** (`monitors:observe`: fetch + record + Files ×2 + evaluation + event + notification staging) | **34.8 ms** | 43.9 ms | 60 cycles, loopback, in-process FeltKit test runtime |
| Full pushed cycle (`monitors:push`) | 20.3 ms | 22.9 ms | 60 cycles |

**Duplicate suppression (60 cycles, all matching):** 40 `event_recorded` and 20 `suppressed_duplicate`. That is exactly the expected count: every repeat of an unchanged matched value was suppressed, and no change was missed. 40 AppPort notifications were sent, one per event.

**Memory (Node, after the 60-cycle run):** heap +20.7 MB, RSS 184.5 MB.

**Platform cost, measured honestly:** the earlier hand-built store did the same cycle in about 9 ms p50. FeltKit's roughly 35 ms buys authorization on every call, the activity log, outbox staging and two Files uploads per observation. At the 300 s minimum poll interval this is irrelevant. For high-rate pushed feeds it would matter.

**Not measured in the current build:**
- Overlay DOM scan and MutationObserver cost. On the pre-FeltKit build, with the same overlay scan code, a full refresh of the same 2,000-paragraph page measured 4.1 ms, and 500 inserts while observed took 1.3 ms. The transport has changed since then.
- Webhook delivery latency.
- Behaviour on real social sites.

## 4. Security findings

**Defects in Ghostpost** (demonstrated against its shipped WASM):
1. `decode()` returns control-byte garbage for a reference payload instead of an error. *Fixed* in the extracted codec (marker dispatch).
2. A single injected zero-width character decodes silently to a wrong value. *Mitigated*: odd-symbol corruption is now detected. An even number is not, because v1 has no checksum (G-CODEC-1).
3. Truncated secure-note and AI-prompt payloads trap with `RuntimeError: unreachable`. *Fixed*: they now return errors.
4. Secure-note passwords sit in clear inside the invisible payload. *Flagged* with a warning on every decode.
5. Extension sidebar: a page-controlled `className` is interpolated unescaped into `innerHTML` (`panel.js:490`). *Replaced* by the overlay (closed shadow root, `textContent` only).
6. `prefetchReference` fetches any `external_url` found in content. *Not carried over* (G-REF-1).

**Found in Signal during this work, and fixed:**
1. **SSRF bypass:** the WHATWG URL parser serializes `::ffff:127.0.0.1` as `::ffff:7f00:1`, which the first guard did not decode. Now covered and tested.
2. **Cross-tenant principal** got an empty list instead of a refusal (pre-FeltKit build). This class of bug is now owned by FeltKit roles and the `authorize` hook.
3. **Delivery retry did not resume** after a failed pass (pre-FeltKit build). Delivery is now AppPort's.
4. **Replay returned a different event id** than the first call. Fixed and tested.
5. **The `authorize` hook's denials lacked AppPort's `code` field.** The runtime still failed closed; the hook now returns the proper decision (found by typecheck).

**Verified by tests:**
- Ownership isolation across sources, monitors, events, evidence, acknowledgement, criteria ids and notification inboxes.
- Roles: viewer cannot write; anonymous callers get `UNAUTHORIZED`.
- Registration refuses ten unsafe URL forms (localhost, metadata host and IP, `::1`, RFC 1918, `file:`, credentials in the URL, `gopher:`, `0.0.0.0`, IPv4-mapped IPv6, `.internal`).
- A redirect into `169.254.169.254` is refused at fetch.
- `robots.txt` disallow means the page is never fetched. 403 is recorded as denied.
- Pushed content over 5 MB is refused.
- Evidence tamper attempt (body ≠ `contentHash`) is refused.
- Prompt-injection text is preserved as evidence and alters nothing.
- Observed `<img onerror>` text renders inert in the overlay.
- The overlay's closed shadow root is unreachable from page scripts.
- Concurrent records for one monitor cannot both enter the condition.

**Open (see GAP_REGISTER):** caller-attested observations (G-SEC-1), DNS rebinding (G-SEC-2), single tenant (G-TEN-1), webhook delivery not exercised (G-DEL-1).

## 5. Remaining limitations

- **No scheduled polling** (G-PLAT-1). Monitors are observed when a caller invokes `monitors:observe`.
- **The overlay host is a test bridge.** The production extension host is not built (G-OVL-1).
- **The `rkendel1/web-monitor` overlap is documented, not resolved** (EXTRACTION_PLAN M4). Its tests were not run.
- **The vertical slice runs in FeltKit's in-process test runtime.** `feltkit dev`, `feltkit build` and a deployed environment were not exercised.
