# Signal — Capability Contracts (v1)

**Normative sources:** [`lib/contracts/types.ts`](lib/contracts/types.ts) (record shapes) and the FeltKit functions in [`feltkit/`](feltkit/) (operations, permissions, storage). It contains plain-data TypeScript types only, with no behaviour. Every durable record carries a `schema` discriminator `signal.<record>/v1`. This document explains the contracts and their rules. If the two disagree, `types.ts` wins.

The brief proposed four starting interfaces. They were reconciled with the code as follows:

| Proposed | Implemented as | Why it changed |
|---|---|---|
| `ObservationSource.observe(req) → ObservationResult{content: unknown}` | `observe(req) → {observation: Observation, body?: Uint8Array}` | Evidence must be the **exact bytes**, and they must be stored content-addressed *before* interpretation. `unknown` content cannot be hashed reproducibly. The `Observation` record carries status, provenance and `evidenceRef`. |
| `SignalDecoder.detect()` + `decode()` (async) | `detect(input) → DetectedSignal[]` (sync) | Detection and decoding are the same pass for every codec built so far. A separate `decode` duplicated work and allowed the two to disagree, which is exactly Ghostpost's `isLikely…` vs `decode` problem. Decoders are pure and synchronous, so they are deterministic and cheap. |
| `CriteriaEvaluator.evaluate(observation, criteria)` | `evaluate(current: Interpretation, previous?, criteria, ctx)` | Criteria run on the *interpretation* (fields and signals), not raw content. Change detection needs the previous interpretation. Time comes from `ctx.now`, so evaluation is a pure function. |
| `AlertDispatcher.dispatch(event, destination)` | **Not Signal's.** `ctx.afterCommit.notifications.send` / `.webhooks.emit` (AppPort Services via FeltKit) | Boundry already has durable, idempotent, retried delivery with per-channel records. Signal only decides *that* something matters. The `AlertDispatcher` type remains in `types.ts` as the shape of a future non-AppPort channel; nothing implements it. |

## 1. Records and their separation

A signal is not an alert, a detection is not an interpretation, and an interpretation is not evidence. Each record below is a separate fact in its own FeltDB collection. None of them overwrites another.

| # | Fact | Collection (`feltkit/app.ts`) | Identity | Written |
|---|---|---|---|---|
| 1 | We looked at a source | `signal_observations` + evidence in **Files** (`files:<id>`, metadata `sha256`) | `obs_…` (random, unique) | Once |
| 2 | We extracted / detected something | `signal_interpretations` | `int_` + hash(observation, rules, decoders) (unique) | Once |
| 3 | Criteria were evaluated | `signal_evaluations` (full trace, `outcome`, per-monitor `seq`) | `evl_` + hash(monitor, observation, criteria id+version) (unique) | Once, **including non-matches and suppressions** |
| 4 | Something mattered | `signal_events` | `evt_` + the same basis (unique). Callers address events by FeltKit record id | Once |
| 5 | People were told | AppPort `notifications` + `notification_deliveries` | idempotency key `signal.event:<evt>:<recipient>` | By AppPort, after commit |
| 6 | Systems were told | FeltKit outbox → AppPort webhook deliveries | one per committed effect | By AppPort, after commit |
| 7 | Someone acknowledged | `signal_events.acknowledgedAt/By` (+ AppPort notification read/ack) | – | Once |

Facts 1–4 and the monitor's condition state (`signal_monitors.matched/lastDedupKey/…`) are written in **one FeltKit mutation**, so they commit together or not at all. Facts 5–6 are staged in that same transaction (`ctx.afterCommit`) and performed only if it commits. Replaying an observation id returns the recorded outcome and stages nothing.

## 2. Source contract

```ts
SourceDefinition { schema:'signal.source/v1', id, tenantId, ownerId,
  type: 'http_page'|'text'|'json'|'dom', locator,
  access: { authorization:'public'|'credential_ref', credentialRef?, respectRobots? },
  observation: { strategy:'manual'|'poll'|'event', intervalSeconds? }, createdAt }
```

Rules (enforced in `feltkit/sources.ts`, `feltkit/monitors.ts` and `lib/sources/`):
- `http_page` requires an absolute `http(s)` URL. Only `http(s)` sources may be `poll`ed. `text`/`json`/`dom` with logical locators are *pushed* by an authorized caller (`monitors:push`).
- URLs pass the net guard: a synchronous shape check at registration (inside the mutation, no network), and the full DNS-resolved check **at every fetch, including every redirect hop** (inside the `observe` action): no private, loopback, link-local, metadata, CGNAT or multicast addresses, no credentials in URLs, schemes limited to http(s).
- The poll interval is floored at 300 s.
- `robots.txt` is honoured for polling (RFC 9309: 4xx means allowed, 5xx or unreachable means disallowed). 401, 403 and 451 are recorded as `denied`. Signal never retries around an access decision.
- `credential_ref` sources are not registrable yet (gap G-SRC-2). Signal never stores secrets.

Observation `status`: `ok` (evidence stored) · `not_modified` (conditional GET 304; nothing re-evaluated) · `denied` · `error`. Every status is persisted with its provenance.

`Provenance { adapter, method, requestedUrl, finalUrl, httpStatus, headers (allow-listed), redirects, robots, submittedBy }`.

## 3. Interpretation contract

**Normalization** (`interpret/normalize.ts`) is deterministic:
- HTML is converted to visible text. `script`, `style`, `noscript`, `template` and `svg` are dropped, entities are decoded, block tags become newlines and whitespace is collapsed.
- **Invisible code points are preserved**, because stripping them would destroy embedded signals.
- The normalized text is itself stored as evidence (`normalizedTextRef`).

**Extraction rules** (`ExtractionRule`):
- `{field, from:'text', pattern, flags∈[imsu], type}` uses capture group 1. The pattern is limited to 512 characters.
- `{field, from:'json', pointer (RFC 6901), type}`.
- A rule that finds nothing yields `value: null`, which means *absent*. Absence is a value that criteria can test.

**Decoders** (`SignalDecoder`), registered per engine:

| Codec id | Kind(s) | Notes |
|---|---|---|
| `ghostpost-unicode/v1` | `text`, `reference`, `ai_prompt`, `secure_note`, `unimplemented`, `corrupt_envelope`, `oversized_input` | The Ghostpost wire format, byte-identical (tested against the original build). It finds **every** envelope, validates framing strictly and dispatches on the marker. `warnings` always include "no integrity check" (format v1 has no checksum). |
| `invisible-unicode/v1` | `invisible_cluster` | Format-agnostic. It covers zero-width characters, bidi controls, the word-joiner family, the BOM and Unicode **tag characters**. Runs shorter than 8 are ignored (emoji ZWJ, RTL marks). It reports *that* and *where*, not *what*. |

`DetectedSignal.confidence` is `1` for deterministic decoders. Any future probabilistic interpreter must report a value below 1, and the event's confidence is the minimum over contributing signals.

## 4. Criteria contract — `signal.criteria/v1`

```ts
CriteriaDefinition { schema, id, version, name, extract?: ExtractionRule[], condition: Condition,
  severity: 'info'|'warning'|'critical', notify?: 'on_change'|'on_enter',
  window?: {notBefore?, notAfter?}, minIntervalSeconds?, metadata? }

Condition =
  | {all: Condition[]} | {any: Condition[]} | {not: Condition}                  // composition, exclusions
  | {field, op, value?, caseSensitive?}                                         // structured
      op ∈ eq neq lt lte gt gte contains not_contains matches in exists absent  // exact, numeric, presence
           changed unchanged increased decreased                                // change (vs previous interpretation)
  | {text: {contains? | matches?(+flags) | fuzzy?: {term, maxDistance}}}        // over normalized text
  | {signal: {codec?, kind?, payloadContains?}}                                 // decoded embedded signals
  | {content: 'changed'|'unchanged'}                                            // whole-content hash change
```

Semantics, all implemented in `core/evaluate.ts` and tested:
- **Deterministic and pure.** Identical inputs give an identical result, including the trace. There is no I/O, clock read or model call.
- **The trace is complete.** `all`/`any` evaluate every child (no short-circuit), so the trace explains *why not* as well as *why*. Each leaf records `op`, `expected`, `actual`, `previous` and `note`.
- **Missing values never satisfy comparisons.** `lt 100` on an absent price is `false`, with the note "non-numeric or missing value". Use `absent` explicitly.
- **There is no previous observation on the first run.** That run is a baseline: change operators evaluate `false` with the note "baseline". The first observation of a page is never "a change".
- **Versions are immutable.** Re-publishing `id@vN` is refused, so an edit is `vN+1`. Events and evaluations record the version that ran.
- **Limits:** nesting depth ≤ 16, nodes ≤ 256, regexes compiled at definition time.
- **Notification policy:**
  - `on_change` (default) records an event when the condition becomes true **or** when the matched values change while it stays true.
  - `on_enter` records an event only on the false→true transition.
  - `minIntervalSeconds` is a frequency limit.
  - `window` bounds when events may be recorded.
  - A suppressed match is still recorded as an `Evaluation` with its `outcome`.
- **Dedup identity** is `dedupKey = hash(monitorId, criteriaId, criteriaVersion, matchedValues)`, where `matchedValues` holds only the leaves that were true.

**AI's role (not implemented, by design):** a model may *propose* a `CriteriaDefinition` from natural language. The proposal is then validated by the same `validateCondition`/`validateRule`, shown to the user, and stored only through `defineCriteria`. The engine never calls a model.

## 5. Event contract — `signal.event/v1`

```ts
MatchedEvent { schema, eventId, tenantId, ownerId, monitorId, sourceId, sourceLocator,
  observationId, interpretationId, evaluationId, criteriaId, criteriaVersion, criteriaName, severity,
  occurredAt, matched: ConditionTrace[] /* true leaves with actual + previous */,
  excerpts: [{field?, text}] /* convenience only */, evidence: {observationRef, normalizedTextRef, contentHash},
  provenance, confidence, dedupKey }
```

`excerpts` never replace evidence. `evidence.observationRef` resolves to the exact observed bytes, and `contentHash` lets anyone verify them.

## 6. Delivery (AppPort Services, via FeltKit)

Signal does not deliver. When an event is recorded, `monitors.ts` stages delivery in the same transaction:

- **People:** for each monitor recipient (`notify`, default the owner; only admins may name others), Signal stages `ctx.afterCommit.notifications.send` with these fields:
  - `type: "signal.criteria_matched"`
  - `title`: the criteria name
  - `body`: the matched values, each with its previous value, plus the source
  - `data`: `{eventRecordId, eventId, monitorId, severity, sourceLocator, evidenceRef}`
  - `idempotencyKey: "signal.event:<eventId>:<recipient>"`

  AppPort Services persists the notification, routes it to channels (in-app by default), retries on its job service, and tracks read/acknowledge. Recipients read it with `events:inbox`.
- **Systems:** if `emitWebhook`, Signal stages `ctx.afterCommit.webhooks.emit("signal.event", {…event, eventRecordId})`. Delivery goes to endpoints that an admin registered in Studio, signed with a custody-held credential, by AppPort Webhooks.

What Signal guarantees is that the event and its evidence are durable *before* anything is sent, and that delivery is staged exactly once per committed event. Delivery outcomes are AppPort's records, not Signal's.

## 7. Operations (FeltKit functions)

| Function | Kind | Permission (`access`) | AppPort capability | Notes |
|---|---|---|---|---|
| `sources:register` | mutation | `signal.sources.write` | `signal.sources.register` | shape-checked URL; poll floor 300 s |
| `sources:list` | query | `signal.sources.read` | – | own sources |
| `criteria:define` | mutation | `signal.criteria.write` | `signal.criteria.define` | `definition` = signal.criteria/v1 JSON; immutable versions; ids are per-owner |
| `criteria:get` | query | `signal.criteria.read` | – | |
| `monitors:create` | mutation | `signal.monitors.write` | `signal.monitors.create` | `notify` limited to owner unless `signal.admin` |
| `monitors:observe` | **action** | `signal.monitors.run` | – (actions are not capabilities) | fetches (robots, SSRF guard, conditional GET), then calls `monitors:record` |
| `monitors:push` | mutation | `signal.monitors.run` | `signal.monitors.push` | pushed sources only |
| `monitors:record` | mutation | `signal.monitors.run` | – | the atomic record step; body must match `contentHash` |
| `monitors:history` | query | `signal.monitors.read` | – | evaluations in `seq` order |
| `events:list` / `events:forPage` | query | `signal.events.read` | `signal.events.list` | own events |
| `events:evidence` | query | `signal.events.read` | – | raw + normalized evidence; hash re-verified on read |
| `events:acknowledge` | mutation | `signal.events.ack` | – | |
| `events:inbox` | query | `notifications.read` | – | the caller's Signal notifications |

**Ownership** is enforced by the app's `authorize` hook for every function that takes `sourceId`, `monitorId` or `eventId`, and inside handlers for criteria. Admins are exempt. Roles (`feltkit/app.ts`): `member`, `viewer`, `agent`, `admin`.

## 8. Codec contract — `ghostpost-unicode/v1` wire format

```
carrier[0..mid] U+FEFF  symbols  U+FEFF carrier[mid..]
symbols   = pairs over alphabet [U+2060 U+200B U+200C U+200D U+200E U+200F U+202D U+202C]  (8×8 = 64 = base64 alphabet, no padding)
bytes     = base64-decode(symbols)
bytes[0]  = marker: 0x00 text | 0x01 DEFLATE text | 0x02 reference | 0x05 ai_prompt | 0x09 secure_note
            0x03 hybrid, 0x04 metadata, 0x06–0x08: reserved, never implemented
reference = [type u8: 0 ghostpost | 1 external_url | 2 supabase | 3 crosslink][u16le len][id][u16le len][metadata]
other     = unmarked legacy payloads (pre-Dec-2025): raw DEFLATE or UTF-8
```

Format v1 has no version byte and no integrity check. A successor format (v2: magic, version, CRC32) is proposed in `EXTRACTION_PLAN.md`. v1 decoding must remain supported indefinitely, because content already published cannot be re-encoded.
