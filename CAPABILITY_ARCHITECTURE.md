# Signal — Capability Architecture

> Observe. Interpret. Evaluate. Act.
> A signal is not an alert, a detection is not an interpretation, and an interpretation is not evidence.

Signal is a **FeltKit application** (`npm create feltkit@latest signal`). That decision removes most of what a monitoring product would otherwise have to build: durable state, authorization, capability publication, evidence storage, notification and webhook delivery. What remains is the capability that is genuinely Signal's.

## 1. Responsibility boundaries

```
            ┌──────────────────────────── FeltKit application "signal" ─────────────────────────────┐
 caller ──► │ feltkit/sources.ts   feltkit/criteria.ts   feltkit/monitors.ts   feltkit/events.ts     │
 (person,   │   roles + authorize hook (ownership) · AppPort capabilities · activity log              │
  agent,    │                                                                                         │
  app,      │   monitors:observe (ACTION: network) ──► monitors:record (MUTATION: one transaction)     │
  overlay)  │        │                                     │                                          │
            │        ▼                                     ▼                                          │
            │   lib/sources (HttpSource,         lib/core/cycle.ts  (pure)                            │
            │    robots, SSRF guard)               ├─ lib/interpret (normalize, extract)              │
            │                                      ├─ lib/codecs   (ghostpost-unicode WASM,           │
            │                                      │                invisible-unicode)                │
            │                                      └─ lib/core/evaluate (deterministic criteria)      │
            │                                                                                         │
            │   ctx.db ─► FeltDB (signal_* collections)      ctx.services.files ─► evidence bytes      │
            │   ctx.afterCommit.notifications ─► AppPort Notifications ─► in-app / browser / email    │
            │   ctx.afterCommit.webhooks      ─► AppPort Webhooks (signed, retried)                   │
            └─────────────────────────────────────────────────────────────────────────────────────────┘
 lib/overlay/overlay.js  — Signal Experience: in-page alerts + local decoding; talks only to a host transport
 codecs/ghostpost-unicode — the extracted Rust codec (wire-compatible with Ghostpost), built to WASM
```

| Logical part (from the brief) | Where it lives | Owner |
|---|---|---|
| **Signal Core**: codecs, detection, normalization, criteria, event generation | `lib/codecs`, `lib/interpret`, `lib/core` (`evaluate.ts`, `cycle.ts`) | Signal. Pure and dependency-free; usable outside FeltKit |
| **Signal Sources**: browser/DOM, text, JSON, web pages | `lib/sources` (HTTP), `monitors:push` (pushed text/json/dom), overlay (DOM) | Signal |
| **Signal Runtime**: observation lifecycle, scheduling, state | `feltkit/monitors.ts` (lifecycle + state); scheduling is **not built** (G-PLAT-1) | Signal over FeltKit |
| **Signal Experience**: overlay, evidence, reveal | `lib/overlay/overlay.js` | Signal (the host extension is not built, G-OVL-1) |
| **Signal Delivery**: routing, retry, dedup | AppPort Notifications + Webhooks via `ctx.afterCommit` | **Platform** |
| Durable state, authorization, capability discovery | FeltDB, FeltKit roles/`authorize`, AppPort | **Platform** |

These are logical boundaries in one deployable application. There are no microservices.

## 2. Data flow of one observation

1. **Observe**: `monitors:observe` is an action, the only place Signal touches the network.
   - It reads the monitor and source under the caller's authority (`monitors:context`).
   - `HttpSource` performs the fetch: robots.txt (RFC 9309), the DNS-checked SSRF guard on every hop, a 5 MB cap, conditional GET with ETag / Last-Modified, and a record of 401/403/451 refusals.
   - The result is a `signal.observation/v1` plus the exact bytes.
2. **Record**: `monitors:record` is a mutation, and everything below happens in one FeltDB transaction.
   - Verify `sha256(body) == observation.contentHash`, so the evidence cannot be swapped between steps.
   - Store the raw bytes and the normalized text in **Files**, with `sha256` metadata.
   - `runCycle()` (pure) produces the interpretation, the evaluation and, if warranted, an event and the next state.
   - Insert the observation, interpretation, evaluation (with per-monitor `seq`) and event, and patch the monitor's condition state. A concurrent record for the same monitor conflicts, so it cannot produce a second event from the same prior state (tested).
   - Stage notifications (idempotency key per event and recipient) and the `signal.event` webhook.
3. **Commit, then deliver.** AppPort performs the staged effects. A failed delivery never touches the event.
4. **Read.** `events:list|forPage|evidence|inbox` serve applications and the overlay. Evidence is re-hashed on every read.

Pushed sources (`monitors:push`) enter at step 2, with provenance `pushed-content@1` and `submittedBy`.

## 3. Trust and authorization model

| Concern | Mechanism |
|---|---|
| Who may call what | FeltKit roles → permissions (`signal.*`, `notifications.*`, `files.*`), checked before arguments are validated |
| On what records | The `authorize` hook checks ownership of `sourceId` / `monitorId` / `eventId`. Criteria ids are per-owner (handler check). Admins are exempt |
| Who is told | A monitor notifies its owner only, unless the creator holds `signal.admin` |
| Tenancy | Single-tenant app today (`TENANT = "default"`). FeltKit `auth.tenant` would partition (G-TEN-1) |
| Outbound network | Only from the `observe` action. Through the guard (scheme, credentials, internal names, private/link-local/metadata/CGNAT/IPv4-mapped addresses, every redirect). Robots respected. No credentials for sources yet (G-SRC-2) |
| Observed content | **Untrusted data.** It is never executed, never sent to a model, and never used as configuration. The overlay renders it with `textContent` in a closed shadow root. Prompt-injection text is preserved verbatim as evidence and changes nothing (tested) |
| AI | Not in the execution path. A model may *draft* `signal.criteria/v1`; `criteria:define` validates it deterministically and stores it immutably |
| Evidence integrity | Content hash at observation time, checked at record time and on every read. Files are additive. The raw bytes are the authority; excerpts and summaries are conveniences |
| Caller-attested observations | `monitors:record` accepts an observation from the caller's own action. A member can therefore fabricate content for *their own* monitors (G-SEC-1) |

## 4. Boundry integration mapping (verified against the code, not the docs)

| Responsibility | Boundry component | How Signal uses it | Status |
|---|---|---|---|
| Durable source of truth (monitors, criteria, events, evaluations, history) | **FeltDB** via FeltKit `ctx.db` | `signal_*` collections, unique constraints for insert-once facts, `ctx.db.sequence` for ordering | Used, tested (incl. restart) |
| Evidence bytes | **AppPort Services Files** | `ctx.services.files.upload/read`, `sha256` metadata | Used, tested |
| Capability discovery and invocation | **AppPort** via FeltKit `capability:` | `signal.sources.register`, `signal.criteria.define`, `signal.monitors.create`, `signal.monitors.push`, `signal.events.list` | Declared; not exercised through `/appport` in tests |
| Authorization | FeltKit roles + `authorize`. **AuthBoundry** for people in deployed environments | Ownership in `authorize` | Roles and ownership tested; AuthBoundry not exercised |
| Notifications | **AppPort Services Notifications** | `afterCommit.notifications.send` | Tested (content, idempotency, recipient isolation) |
| Webhooks | **AppPort Services Webhooks** | `afterCommit.webhooks.emit("signal.event")` | Staged; **delivery not exercised** (needs an endpoint registered with a custody credential) |
| Scheduling | **AppPort Jobs/Schedules** | Not used: job handlers are mutations and may not fetch | Gap G-PLAT-1 |
| Replaceable providers | **Resolver** | Not used yet. Codec and source adapters are code-level interfaces | Future (G-RES-1) |
| Deployment | **AppBoundry** (`feltkit build --target appboundry`) | Not attempted. An artifact has `network: "none"`, so `observe` would need a FeltKit server or an egress component | Gap G-PLAT-2 |
| Deterministic orchestration | **Intent** | No Intent source exists anywhere surveyed. Signal's pipeline is itself deterministic | Not applicable |

## 5. Relationship to `rkendel1/web-monitor`

`web-monitor` is an existing AppPort-native monitor MVP. It uses `@appport/runtime` directly, not FeltKit. It has five structured condition types (`numeric_threshold`, `text_appears`, `text_disappears`, `value_changes`, `element_appears`), recurring AppPort jobs, AppPort notifications on the false→true transition, a Chrome extension, and a local WebLLM intent compiler. It overlaps **Signal Monitor** directly.

Recommendation: **do not run both.**
- Signal's criteria model is a strict superset of those five conditions: `lt/gt`, `text.contains`, `not text.contains`, `changed`, and `matches`/presence respectively.
- Signal adds evidence preservation, explainable traces, dedup and immutable versions.
- web-monitor has two assets Signal lacks: the extension host and a scheduler wiring.

The convergence path is in `EXTRACTION_PLAN.md` M4. Its tests were not run during this work.
