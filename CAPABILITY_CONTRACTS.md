# Signal — Capability Contracts (v1)

**Normative source:** [`src/contracts/types.ts`](src/contracts/types.ts). It contains plain-data TypeScript types only, with no behaviour. Every durable record carries a `schema` discriminator `signal.<record>/v1`. This document explains the contracts and their rules. If the two disagree, `types.ts` wins.

The brief proposed four starting interfaces. They were reconciled with the code as follows:

| Proposed | Implemented as | Why it changed |
|---|---|---|
| `ObservationSource.observe(req) → ObservationResult{content: unknown}` | `observe(req) → {observation: Observation, body?: Uint8Array}` | Evidence must be the **exact bytes**, and they must be stored content-addressed *before* interpretation. `unknown` content cannot be hashed reproducibly. The `Observation` record carries status, provenance and `evidenceRef`. |
| `SignalDecoder.detect()` + `decode()` (async) | `detect(input) → DetectedSignal[]` (sync) | Detection and decoding are the same pass for every codec built so far. A separate `decode` duplicated work and allowed the two to disagree, which is exactly Ghostpost's `isLikely…` vs `decode` problem. Decoders are pure and synchronous, so they are deterministic and cheap. |
| `CriteriaEvaluator.evaluate(observation, criteria)` | `evaluate(current: Interpretation, previous?, criteria, ctx)` | Criteria run on the *interpretation* (fields and signals), not raw content. Change detection needs the previous interpretation. Time comes from `ctx.now`, so evaluation is a pure function. |
| `AlertDispatcher.dispatch(event, destination)` | `dispatch(event, destination, {idempotencyKey, attempt})` | The receiver needs a key that is stable across retries in order to deduplicate. |

## 1. Records and their separation

A signal is not an alert, a detection is not an interpretation, and an interpretation is not evidence. Each record below is a separate fact with its own id. None of them overwrites another.

| # | Fact | Record | Id | Written |
|---|---|---|---|---|
| 1 | We looked at a source | `Observation` (+ evidence bytes in the FeltDB content store) | random `obs_…`; evidence `sha256:…` | Once |
| 2 | We extracted / detected something | `Interpretation` (`fields`, `signals`) | `int_` + hash(observation, rules, decoders) | Once |
| 3 | Criteria were evaluated | `Evaluation` (full trace + `outcome`) | `evl_` + hash(monitor, observation, criteria id+version) | Once, **including non-matches and suppressions** |
| 4 | Something mattered | `MatchedEvent` | `evt_` + the same basis | Once, in the same transaction as 3 |
| 5 | We tried to notify | `DeliveryAttempt` (`attempted→delivered/failed/suppressed`) | random `att_…` | Once per attempt |
| 6 | A human or app saw it | `Acknowledgement` | `ack_{event}_{subject}` | Once per subject |

The only mutable record is `signal_monitor_state` (current match flag, last dedup key, last interpretation, ETag). It is updated with a version fence in the same FeltDB transaction that writes facts 3–4.

## 2. Source contract

```ts
SourceDefinition { schema:'signal.source/v1', id, tenantId, ownerId,
  type: 'http_page'|'text'|'json'|'dom', locator,
  access: { authorization:'public'|'credential_ref', credentialRef?, respectRobots? },
  observation: { strategy:'manual'|'poll'|'event', intervalSeconds? }, createdAt }
```

Rules (enforced in `SignalService.registerSource` and `HttpSource`):
- `http_page` requires an absolute `http(s)` URL. Only `http(s)` sources may be `poll`ed. `text`/`json`/`dom` with logical locators are *pushed* by an authorized caller (`POST /v1/monitors/:id/run {content}`).
- URLs pass the net guard **at registration and at every fetch, including every redirect hop**: no private, loopback, link-local, metadata, CGNAT or multicast addresses, no credentials in URLs, schemes limited to http(s).
- The poll interval is floored at 300 s.
- `robots.txt` is honoured for polling (RFC 9309: 4xx means allowed, 5xx or unreachable means disallowed). 401, 403 and 451 are recorded as `denied`. Signal never retries around an access decision.
- `credential_ref` sources are refused with `CREDENTIALS_UNAVAILABLE` until a host credential resolver is wired (gap G-SRC-2). Signal never stores secrets.

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

## 6. Delivery contract

```ts
AlertDestination { id, type: 'webhook'|'inbox'|'appport_notification', target, secretRef?, minSeverity?, quietHours? }
DeliveryAttempt  { schema:'signal.delivery/v1', attemptId, eventId, destinationId, attempt, attemptedAt,
                   status:'delivered'|'failed'|'suppressed', retryable, detail?, responseStatus?, idempotencyKey }
```

Rules (`delivery/dispatch.ts`):
- `idempotencyKey = hash(eventId, destinationId)`. It is identical on every retry and across reprocessing.
- A destination that has a `delivered` or `suppressed` attempt is never sent again. Reprocessing resumes only the destinations that failed, and attempt numbers continue.
- Retryable means 5xx, 408, 429 or a network error. A 4xx or a blocked destination is final. Backoff is exponential, `500 ms × 2^(n-2)`, capped at 30 s, with 4 attempts per pass.
- `minSeverity` produces a `suppressed` attempt. `quietHours` produces **no** attempt (held, not dropped).
- A failed delivery never alters or removes the event.

**Webhook wire format:**
- Method and body: `POST` with the `MatchedEvent` JSON as the body.
- Headers: `idempotency-key`, `x-signal-event-id`, `x-signal-attempt`, `x-signal-timestamp`, and `x-signal-signature: sha256=HMAC(secret, "<timestamp>.<body>")` when `secretRef` is set. The secret is resolved by the host (a Resolver `secret` ref).
- Destinations must be `https` and pass the net guard. Redirects are not followed.

`appport_notification` is declared but has **no dispatcher** in this slice. It records `failed: No dispatcher configured` rather than pretending (see GAP_REGISTER).

## 7. Application-facing API (`src/api/server.ts`)

| Method | Path | Authorization (action) |
|---|---|---|
| GET | `/v1/events?sourceLocator=` | `signal.event.read` (own events; `signal.admin` sees the tenant) |
| GET | `/v1/events/:id/evidence` | `signal.evidence.read` + ownership |
| POST | `/v1/events/:id/ack` | `signal.event.ack` + ownership |
| POST | `/v1/monitors/:id/run` `{content?}` | `signal.monitor.run` + ownership |
| GET | `/overlay.js`, `/codec/*` | public static assets |

Other rules:
- **Authentication is injected** (`authenticate(req) → Principal`). Signal does not mint or verify credentials.
- **A service instance serves one tenant.** A principal from another tenant is refused before any lookup.
- **Definition writes** (`registerSource`, `defineCriteria`, `createMonitor`) are exposed as `SignalService` methods for in-process hosts. They are not yet HTTP routes (gap G-API-1).

**Actions** a host's authority must know about: `signal.source.write`, `signal.criteria.write`, `signal.monitor.write`, `signal.monitor.run`, `signal.event.read`, `signal.event.ack`, `signal.evidence.read`, `signal.admin`.

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
