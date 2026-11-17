# Signal — Gap Register

Each entry is **missing or limited functionality**, with evidence. *Platform* means it belongs to a Boundry component (FeltKit, FeltDB, AppPort, AuthBoundry, Resolver, AppBoundry), and Signal deliberately did not build a local workaround. *Product* means it is Signal's to build.

Severity: **High** blocks a stated outcome · **Medium** limits a supported use · **Low** is a quality or completeness gap.

**Still open after M5** (unchanged; not solved by page intelligence):
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
| G-PAGE-2 | **Representation size is about 10–18× the HTML** (3.4 MB for a 1,000-product page), mostly per-value evidence | Medium | `docs/bench-pages.json` | Options: deduplicate evidence text, cap evidence per entity, or store evidence separately. Changing it trades traceability for size; a decision is needed |
| G-PAGE-3 | **Heuristics are English-leaning:** labels, availability phrases, class hints, relative dates | Medium | `lib/page/vocab.ts`, `values.ts` | Add vocabulary rows per language (tables, not code) |
| G-PAGE-4 | **Real-site quality not measured.** 8 synthetic fixtures; no precision/recall on live pages | Medium | ACCEPTANCE_REPORT | A labelled corpus of saved real pages and a measured scorecard per extractor version |
| G-PAGE-5 | **No reviewable mapping proposals.** Unknown structures are retained, but there is no workflow to propose and accept a new mapping (human- or AI-suggested) | Low | – | A `mappings` collection: proposals → explicit acceptance → deterministic rule tables. Models may propose, never decide |
| G-PAGE-6 | **Identity stability depends on the key.** Locator-keyed entities (no name, url or sku) get new ids when the DOM moves, so `changed`/`added` see them as new | Low | PAGE_INTELLIGENCE §2 Identity | Better keys from collection position + content fingerprint. Documented today |
| G-PAGE-7 | **Partial structural coverage:** no shadow DOM in static HTML (cheerio sees none; the overlay does), no iframes, simple RDFa only (no `prefix`/CURIE expansion beyond stripping), no PDF/image/OCR content | Low | `lib/page/extract.ts` | Extend per need |
| G-PAGE-8 | **Revision depends on observation time for relative dates.** Pages showing "3 hours ago" get a new revision every observation, because the inferred absolute time changes | Low | `values.ts parseDate` | Exclude inferred relative values from the revision hash, or keep the raw string only |
