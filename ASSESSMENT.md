# Signal rebuild — reality assessment and target model

Written before the rebuild, from the code at `cbeacff` (baseline: `npm test` 135/135 passing).

## 1. What existed

| Area | Reality (from code, not docs) |
|---|---|
| Platform | FeltKit 0.3.31 app: FeltDB collections, roles + `authorize` ownership hook, Files, Notifications, Webhooks. Works; tests run against real FeltDB. |
| Sources | **Three unrelated concepts.** `signal_sources` = a web page/pushed text for a monitor. `signal_datasets` = an uploaded CSV/GeoJSON with versioned, reviewed mappings. `enrichments` = caller-supplied JSON passed per call. No common identity, freshness, health or coverage model. |
| Information model | Pages became `signal.page/v1` (entities/attributes/evidence) — **real and measured** on 16 real pages. Dataset rows became `DatasetRecord`s held only in memory per call. No source-independent observation, no observation history except whole interpretations per monitor. |
| Identity | `lib/datasets/resolve.ts`: tiered id → address(+coords) → containment → coordinates, with ambiguous/conflict/unmatched. **Good logic**, but recomputed per call, page-vs-dataset only, never persisted, never correctable by a user. |
| Criteria | **Three evaluators.** `core/evaluate.ts` (field/text/signal/content on one observation), `page/query.ts` (entity conditions), `discovery/discover.ts` (tri-state candidate intents, metrics, enrichment). Intents were not persisted (G-DISC-1). |
| Detection | A monitor = one source × one criteria version. Dedup by matched-value hash → `signal_events`. Cross-source criteria **could never alert** (G-DATA-9). No finding lifecycle (resolved / superseded / invalid), no re-evaluation when criteria change, no reaction to a dataset change. |
| Freshness | Datasets declared `static/periodic/live` but nothing executed it. No staleness in evaluation. |
| UI | No web app. A Chrome extension side panel (capture, intent builder, dataset import, alerts overlay) bound to the old API. |
| Synthetic | Real-estate discovery fixtures, parcel CSV, rent JSON: synthetic. M9 real-data validation never run. |
| Off-thesis | Ghostpost invisible-Unicode codec (Rust/WASM) and `signal` conditions: a niche decoder unrelated to multi-source intelligence. |

## 2. Decisions

**Retained (as adapters behind the new model):** page intelligence (`lib/page/extract.ts`, values, vocab, types) and its quality tests; CSV/GeoJSON parsing, profiling and mapping proposals; the identity tiers; the HTTP observer with its SSRF guard; canonical hashing; FeltKit platform use (roles, ownership hook, Files, Notifications).

**Replaced:** sources/datasets/enrichments → one `Source` model; interpretations/dataset records → durable, versioned `Observation`s; three evaluators → one deterministic tri-state evaluator; monitors/events → durable `Finding`s with lifecycle and history; per-call identity → persisted, user-correctable `Link`s; extension panel → thin capture client of a page source; new web app is the primary product surface.

**Removed:** Ghostpost codec and `signal` conditions, `core/evaluate.ts`, `core/cycle.ts`, `interpret/*`, `discovery/discover.ts`, `page/query.ts`, monitors/events/discovery/datasets/pages function modules, M9 discovery measurement, intent builder, overlay, and documents describing the removed model (kept in git history at `cbeacff`).

## 3. Target model

```
Source ──refresh──▶ Ingestion ──(only if content changed)──▶ Observation vN (supersedes vN-1, or retracted)
                                                               │
                                     identity resolution ──▶ Link (exact | probable | ambiguous | conflict | unmatched | manual)
                                                               │
                                                             Entity ◀── several sources' records
                                                               │
             Criteria vK (user-owned, immutable versions) ──▶ Evaluation (tri-state, freshness, conflicts, derived values)
                                                               │
                                                             Finding (new | changed | persistent | resolved | superseded | invalid)
                                                               └── FindingEvent history, EvaluationRun (cause), notification
```

Separate events, never conflated: *refresh* (Ingestion) ≠ *new information* (new Observation version) ≠ *meaningful change* (finding digest crosses a threshold) ≠ *qualifying finding* ≠ *action* (explicit user acknowledgement / dismissal; nothing executes on detection).

Triggers for re-evaluation: new/changed/retracted observations (incremental: affected entities only), criteria version (full, that criteria), mapping change (re-ingest stored raw), identity correction (affected entities), source removal (affected entities), time (freshness sweep, a mutation a schedule can run).

## 4. Gaps against the requirements, known before building

- **Scheduled outbound fetch** (G-PLAT-1): FeltKit jobs run mutations, mutations may not fetch. Polled HTTP sources are refreshed by an action that a person, the app, or an external poller calls. Not claimed as live.
- **Native sources**: the platform exposes no other application's data to Signal. "Native" here means information produced inside Signal's environment (browser captures, in-app manual records). Stated, not hidden.
- **Natural-language criteria drafting**: needs a configured model; the editor produces explicit JSON criteria; no LLM in evaluation.
