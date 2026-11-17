# Signal — Gap Register

Each entry is **missing or limited functionality**, with evidence. *Platform* means it belongs to a Boundry component (FeltKit, FeltDB, AppPort, AuthBoundry, Resolver, AppBoundry), and Signal deliberately did not build a local workaround. *Product* means it is Signal's to build.

Severity: **High** blocks a stated outcome · **Medium** limits a supported use · **Low** is a quality or completeness gap.

**Still open after M7** (unchanged; not solved by page quality or discovery):
- **G-PLAT-1:** no scheduled fetching.
- **G-OVL-1:** no overlay host for third-party sites.
- **G-PLAT-3:** no JSON field type. The page representation is stored as canonical JSON in Files, with an index row in FeltDB.

## Platform gaps

| ID | Gap | Severity | Evidence | Proposed resolution |
|---|---|---|---|---|
| G-PLAT-1 | **No scheduled outbound observation in FeltKit.** Job handlers are *mutations* (`services.jobs.handlers` → `"<module>:<mutation>"`), and FeltKit forbids network I/O in mutations. A schedule therefore cannot run `monitors:observe` (an action) | **High** for continuous web monitoring | `@feltdb/feltkit` skills/feltkit-services (handlers map to mutations); skills/feltkit-build ("never call fetch from a mutation"). `web-monitor` shows AppPort Jobs *outside* FeltKit can run fetching handlers | FeltKit: allow a job type to target an **action** (re-authorized as the enqueuer). Until then, an external trigger (a cron or a FeltKit component with `network: egress`) calls `monitors:observe` for due monitors. Signal does not ship its own scheduler |
| G-PLAT-2 | **AppBoundry artifacts have `network: "none"`.** `observe` cannot run inside an artifact | Medium | AppBoundry `manifest.ts:312` (survey) | Deploy Signal on a FeltKit server, or move `observe` into a `components` entry with `network: "egress"`. Not attempted |
| G-OVL-1 | **No CORS by design**, so the overlay needs an extension host for third-party pages. FeltKit documents the host pattern but ships no generic one | Medium | `@feltdb/feltkit` docs/EXTENSION-HOSTS.md (X8) | Build the MV3 host: a content script relaying `transport(op,args)` to a service worker that holds the session in `TRUSTED_CONTEXTS` storage. `web-monitor`'s extension is the starting point (M4). The test bridge (`page.exposeFunction`) is reachable by page scripts; a real isolated-world bridge is not |
| G-PLAT-3 | **No free-form JSON schema type.** Nested records (conditions, traces, provenance) are stored as canonical JSON strings and are not queryable by inner field | Low | `@appport/schema` builders: string/number/integer/boolean/literal/nullable/object/optional/record/union/array | Acceptable: these are write-once evidence. Revisit if the evaluation trace must be queried |
| G-PLAT-4 | **No explicit-id insert in `ctx.db`.** Content-derived ids are unique *fields*; callers address records by FeltKit's generated id | Low | `runtime/data.d.ts` (`insert(ref, value) → id`) | Works with unique constraints. An explicit-id insert would remove the dual id |
| G-TEN-1 | **Single tenant.** Records are owner-scoped; `TENANT="default"` | Medium | `feltkit/_shared.ts` | Enable FeltKit `auth.tenant` and scope collections by tenant. Re-run the authorization tests across tenants |
| G-RES-1 | **Resolver not used.** Codec and source adapters are code-level interfaces, not Resolver bindings | Low | – | Declare `endpoint`/`value` refs for source adapters once more than one implementation exists |
| G-AUTH-1 | **AuthBoundry not exercised.** Signal relies on FeltKit roles and an `authorize` hook. AuthBoundry decides at capability level (survey), so per-record ownership stays in Signal's hook | Low | Survey of `authboundry` (`control_routes.rs:79`) | Run the deployed app under AuthBoundry and keep ownership in `authorize` |

## Product gaps

| ID | Gap | Severity | Evidence | Proposed resolution |
|---|---|---|---|---|
| G-SEC-1 | **Caller-attested observations.** `monitors:record` accepts the observation produced by the caller's own `observe` action. A member can fabricate content for their own monitors. `authorize` confines the impact to their own events and inbox | Medium | `feltkit/monitors.ts` (`record` checks hash consistency, not origin) | Have FeltKit mark calls made by an action (`ctx.caller.viaAction`), or sign observations in the action with a server-held key. Until then evidence for HTTP sources is "observed by Signal on behalf of X", not independently attested |
| G-SEC-2 | **DNS rebinding.** The guard resolves, then `fetch` resolves again | Medium | `lib/sources/net-guard.ts` header comment | Pin the resolved IP at connect time (undici dispatcher `connect.lookup`) or route through an egress proxy |
| G-SRC-2 | **No credentialed sources.** `credential_ref` cannot be registered | Medium | `feltkit/sources.ts` | Use FeltKit credential custody (`credential-ref:`) and inject in the action. Never store secrets in Signal |
| G-INT-2 | **Signals in HTML attributes are invisible.** Decoders run on normalized visible text | Low | `lib/core/cycle.ts` comment | Add an attribute-scanning pass for `alt`, `title` and `aria-label` |
| G-CODEC-1 | **v1 wire format has no integrity check or version byte.** An even number of injected symbols decodes to a wrong payload | Medium | `tests/lib/codec.test.ts` "known limitation" | `ghostpost-unicode/v2`: magic and version byte, CRC32 trailer, length-checked encoders. Decode v1 forever |
| G-CODEC-2 | **u16 length truncation** in reference, AI and secure-note encoders | Low | `hidenly.rs` `as u16`. The TS wrapper rejects more than 65,535 bytes; the raw WASM exports do not | Return `Result` from the encoders in v2 |
| G-REF-1 | **Reference resolution not rebuilt.** Ghostpost fetched any `external_url` found in content | Medium | `src/lib/ghostpost.ts` `prefetchReference` (Ghostpost) | A `references:resolve` action behind authorization, the net guard and an allow-list. Not built |
| G-DEL-1 | **Webhook delivery not verified end to end.** `signal.event` is staged in the outbox, but no endpoint was registered in tests | Medium | Endpoint registration requires a signing credential in custody | Add a test that registers an endpoint as admin with a test credential and runs `runServices()` |
| G-DEL-2 | **Quiet hours, severity routing and per-user preferences** are not modelled. AppPort Notifications has no preference resource yet | Low | `appport-services` docs/notifications.md (Preferences) | Belongs on AppPort's future preference resource, not in Signal |
| G-CRIT-1 | **No natural-language → criteria drafting.** The deterministic model exists; the advisory drafting step does not | Low | – | A FeltKit `action` using `ctx.model.generate`. Its output goes only through `criteria:define`. `web-monitor`'s local WebLLM compiler is prior art |
| G-API-1 | **Not exposed as AppPort capabilities:** `observe` (actions cannot be capabilities), `evidence`, `acknowledge`, `history` | Low | FeltKit `app.action` docs | Expose read-only ones with `returns` schemas. For `observe`, a capability mutation that enqueues once G-PLAT-1 lands |
| G-OBS-1 | **Site-specific DOM reconstruction** (X.com, Facebook splits) is simplified to "nearest block textContent". Not verified on those sites | Low | EXTRACTION_AUDIT | Port the userscript's X.com adapter when the extension host exists |
| G-TEST-1 | **Not measured:** real-site behaviour, memory under long overlay sessions, webhook latency | Low | ACCEPTANCE_REPORT | – |

## Page intelligence gaps (M5)

| ID | Gap | Severity | Evidence | Proposed resolution |
|---|---|---|---|---|
| G-PAGE-1 | **No server-side rendering.** A static fetch sees only server-sent HTML. Dynamic content needs a browser-rendered snapshot pushed by a caller (`pages:push`, `monitors:push`) | Medium | `tests/pages.test.ts` "dynamic content": 0 products from the static fetch, 3 from the Chromium snapshot | A rendering component (FeltKit `components`, `network: egress`, headless Chromium) that pushes snapshots. Needs G-PLAT-1 for scheduling. Not built |
| ~~G-PAGE-2~~ | **Resolved in M7.** The size was measured (JSON keys 24–41%, locators 4–31%, evidence text only 3–7%). Storage is now gzip of the canonical JSON: 3.43 MB → 324 KB, lossless, about 15 ms decode. Traceability is kept | – | PAGE_QUALITY.md §6, `docs/size-analysis.json`, `docs/storage-options.json`, `tests/storage.test.ts` | The in-memory size is unchanged (the full representation is parsed to evaluate). Revisit only if a measured workload is bound by it |
| G-PAGE-3 | **Heuristics are English-leaning:** labels, availability phrases, class hints, relative dates | Medium | `lib/page/vocab.ts`, `values.ts` | Add vocabulary rows per language (tables, not code) |
| ~~G-PAGE-4~~ | **Resolved in M7** for 16 real pages in 10 categories: independent labels, held-out split, per-category and per-method metrics, regression floor | – | PAGE_QUALITY.md, `docs/page-quality*.json`, `tests/lib/page-quality.test.ts` | Continued by G-PAGE-9 |
| G-PAGE-5 | **No reviewable mapping proposals.** Unknown structures are retained, but there is no workflow to propose and accept a new mapping (human- or AI-suggested) | Low | – | A `mappings` collection: proposals → explicit acceptance → deterministic rule tables. Models may propose, never decide |
| G-PAGE-6 | **Identity stability depends on the key.** Locator-keyed entities get new ids when the DOM moves. M7 made this *explicit*: `identity.strength = positional`, and such entities are reported as `uncertain` rather than added/removed. It is still not *solved* for positional identities | Low | `tests/lib/identity.test.ts` | Content fingerprints for positional entities, behind the same uncertainty rules |
| G-PAGE-7 | **Partial structural coverage:** no shadow DOM in static HTML (cheerio sees none; the overlay does), no iframes, simple RDFa only (no `prefix`/CURIE expansion beyond stripping), no PDF/image/OCR content | Low | `lib/page/extract.ts` | Extend per need |
| G-PAGE-8 | **Revision depends on observation time for relative dates.** Pages showing "3 hours ago" get a new revision every observation, because the inferred absolute time changes | Low | `values.ts parseDate` | Exclude inferred relative values from the revision hash, or keep the raw string only |

## Page quality and discovery gaps (M7)

| ID | Gap | Severity | Evidence | Proposed resolution |
|---|---|---|---|---|
| G-PAGE-9 | **The held-out set is consumed.** Fixes were informed by its failures, so the current held-out scores are not an unbiased estimate | Medium | PAGE_QUALITY.md §4 | A fresh held-out set, labelled and committed before evaluation, for each future quality claim. It should include non-English pages and real JSON-LD conflicts |
| G-PAGE-10 | **Cross-row records.** HN puts one story across two table rows with no shared container: story recall 0.75, attributes 0.6, relationships 0.5/0.4 | Low | `docs/page-quality.json` hn-item | A rule joining adjacent rows only when the second row has no record of its own and references the first (e.g. the same item id in links). Must not merge unrelated rows |
| G-PAGE-11 | **Sidebar facts are not linked to the main record.** PyPI "Meta" sections become separate records; the author relationship is missed (0/1). The sidebar is duplicated for desktop and mobile | Low | heldout-pypi | Attach section-level facts to the main record when the sections have no identity of their own; deduplicate identical hidden/visible duplicates |
| G-PAGE-12 | **A land-lot card is typed `Product`** (T2: price + image) | Low | `tests/fixtures/discovery`, DISCOVERY_MODEL.md §9 | A real-estate cue set (acres/lot size + address) mapping to `RealEstateListing`/`Landform` before T2. Needs real examples, not a guess |
| G-PAGE-13 | **Duplicate rows across tables.** The same buildings in several tables become distinct row entities (heldout-tallest: duplicate rate 0.76, entity precision 0.696) | Low | heldout-tallest | Keep them distinct (rows are real). Link rows with the same strong key across tables via `sameAs` when a link URL identifies the subject |
| G-DISC-1 | **Discovery is not interactive.** Intents are not persisted; plans are proposals that nothing executes | Medium | DISCOVERY_MODEL.md §6, §9 | M8: `signal_intents` (immutable versions), plan execution in the browser session via the overlay host, background enrichment through observation |
| G-DISC-2 | **Real listing sites not evaluated.** The real-estate scenario is synthetic because the sites' terms prohibit automated access | Medium | DISCOVERY_MODEL.md §7 | Evaluate on pages a user views in their own session (browser-session observation, M8), or with a licensed data provider |
| G-DISC-3 | **Context encodings are a fixed list.** Bounds and filter parameter names come from a small table; other encodings report `unknown` | Low | `extractContext` | Vocabulary rows per encoding, plus user-supplied context |
| G-DISC-4 | **Coverage omits failed or refused observations** of pages that discovery wanted, because discovery does not observe | Low | DISCOVERY_MODEL.md §5 | Add once discovery drives observation (M8) |
| G-DISC-5 | **Geo scope is a bounding box only;** enrichment joins by exact URL only | Low | `lib/discovery/discover.ts` | Polygons when a caller needs them; fuzzy joins only via reviewable mappings |
