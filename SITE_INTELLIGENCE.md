# Ambient Signal and Shared Site Intelligence

Phase 2 of the rebuild. Two capabilities on the existing foundation
(sources → versioned observations → identity → entities → criteria → findings), not beside it:

| System | Responsibility | Where | Shared? |
|---|---|---|---|
| **Site Intelligence Catalog** | How a website exposes information: feeds, structure, identifiers, change mechanisms, access requirements | `signal_sites`, `signal_site_feeds`, `signal_feed_checks` | Yes — structure only |
| **User Source Connection** | This user's authorized access to one feed (their URL, their session, their schedule) | a `signal_sources` row of kind `site_feed` | No |
| **Signal Intelligence Engine** | What the observations mean against this user's criteria | observations, entities, criteria, findings, notices | No |

The overlay is a delivery surface for the engine. It has no evaluator, criteria or finding store of its own.

## 1. Reality assessment (before building)

| Question | Finding (verified, not assumed) |
|---|---|
| What remained of the overlay | Nothing in the tree (removed in the rebuild). In git history (`cbeacff:lib/overlay/overlay.js`): badge → panel, closed shadow root, text-only rendering, a host-provided allow-listed transport, outlines re-applied after redraws, a badge that survives a failed refresh. Its data model (monitor events, Ghostpost signals) is gone. |
| How the extension talked to Signal | The side panel held the bearer session; the worker held none. Overlay ops were relayed by the panel, so alerts needed the panel open. |
| How live updates reach the web app | FeltKit's change stream (`client.onChange`): the app re-renders when a collection it reads changes. |
| Notifications | AppPort Notifications inbox only (sent via `afterCommit`): no snooze, no kinds, no browser delivery. No push or e-mail channel in the platform for this app. |
| What an extension can observe | Resource Timing (URLs, initiator, size, status; no bodies, no methods); the DOM, JSON-LD, `<script type="application/json">` and page globals (MAIN world); response bodies only by re-issuing a GET. **Not observable without intrusive hooks:** POST bodies (so GraphQL queries), WebSocket frames, SSE payloads, responses the page received. Signal does not monkey-patch `fetch`/`WebSocket` or use `chrome.debugger`. |
| Real-estate sites | Zillow's robots.txt disallows `/graphql/`, `/api/`, `/async-create-search-page-state` for all agents; Redfin's disallows `/stingray` (its listing API) and Redfin answered this environment with HTTP 429. Automated analysis or polling of those APIs is not done. |
| A real site that permits it | USGS Earthquake Hazards: public-domain, published for programmatic use, no robots.txt (404 = no restrictions). Its map is an SPA that loads a GeoJSON feed. |

## 2. Ambient Signal

```
 site tab                    extension service worker                    Signal (FeltKit)
 ┌──────────────┐  port, 1 of ~16 ops  ┌──────────────────────┐  bearer   ┌──────────────────┐
 │ overlay      │ ───────────────────▶ │ session (trusted     │ ───────▶  │ ambient:context  │
 │ (shadow root)│ ◀── "changed" ────── │ storage only)        │ ◀──────   │ change stream    │
 └──────────────┘                      │ chrome.alarms (1 min)│           │ notices, findings│
                                       │  · due feeds         │           │ sites, sources   │
 OS notification ◀──────────────────── │  · pending notices   │           └──────────────────┘
                                       └──────────────────────┘
```

- **Where it runs.** On sites the person enables in the side panel ("Show Signal on this site"). That grants access to that one origin and registers the content script persistently (`chrome.scripting.registerContentScripts`). Nothing runs on other sites.
- **What it shows.** It answers one query (`ambient:context`):
  - findings about this page: an entity whose record URL is this page, or whose record was captured here;
  - findings built on your sources for this site;
  - unread notifications, marked contextual when they concern this page;
  - what Signal knows about the site (shared feeds, their status, your connections);
  - your sources and the criteria watching them.
- **What you can do.** All of it happens without opening the app:
  - acknowledge, snooze (24 h) or dismiss a finding (dismissal keeps its reason), and acknowledge or snooze a notice;
  - pause or resume criteria;
  - "Understand this site", "Connect…" a feed (inline review: what will run, as what entity type), "Capture this page", "Refresh now";
  - open the finding's why, evidence and history in the overlay, or "Open in Signal" in a new tab, leaving the page where it was.
- **Quiet by default.** A small dim dot when there is nothing; "N here", "N on this site" or "N new" when there is.
- **Robust on modern sites.**
  - It lives on `<html>` and re-attaches if a script removes it.
  - Client-side routing is detected by watching `location.href`, because content scripts cannot see `pushState`.
  - It refreshes when the tab becomes visible.
  - It updates live while visible: the overlay keeps the worker awake, and the worker subscribes to the change stream.
- **While the full app is closed** (verified in `tests/e2e/ambient.e2e.ts`):
  - every minute the worker refreshes due feeds — server-acquired ones via `sources:refresh`, browser-acquired ones by fetching with the person's own session — then records what came back;
  - it shows new notices as OS notifications, each once (`notices:delivered`), and sets the toolbar badge.
- **While the browser is closed:** nothing is fetched and nothing is delivered. The platform has no scheduled outbound fetch (G-PLAT-1) and no push or e-mail channel (G-NOTIFY-2). Notices still accumulate whenever something else changes Signal's state (a system pushing records), and are shown when the browser returns.

### Notification lifecycle

Notices (`signal_notices`) are created by the engine in the same transaction as the event that caused them, deduplicated by key, and never deleted (acknowledging and snoozing are states).

| Kind | When | Deduplication |
|---|---|---|
| `finding_new`, `finding_changed`, `finding_resolved`, `finding_reopened`, `finding_closed` | a finding event (never an observation update); "changed" only past the criteria's change thresholds | finding + event + diff |
| `source_failure` | first failed refresh of an outage | source + last success |
| `source_recovered` | first success after an outage | source + time of the failure |
| `source_stale` | the freshness sweep finds a source past its freshness rule | source + last success |

Filtering is layered:
- **The criteria author** decides which transitions are worth announcing (`notifyOn`, `notifyPossible`).
- **The person's preferences** decide which kinds they want, whether "possible" findings count, the minimum severity for browser notifications, and whether browser and contextual delivery are on.
- **Snoozing** a finding silences its notices until then.

## 3. Site Intelligence

### Analyzer (`lib/site/analyze.ts`, pure)

**Input: SiteEvidence.** The extension collects it in the person's tab when they ask (`lib/site/collect.ts`). The validation script runs the same collector in a real page.
- It re-issues each GET the page itself made, up to 8, once with the person's session and once without (to learn whether the data depends on the session). It never invents an endpoint.
- It skips paths the site's robots.txt disallows, and analytics or map-tile noise.

**Output: ranked candidates.** Each candidate has a verdict:

| Verdict | Meaning |
|---|---|
| `feed` | a collection of records sharing a structure |
| `detail` | one record, many fields: an entity detail endpoint |
| `metadata` | records without identifiers, names, times or places: configuration, enumerations, styling |
| `not_records` | no record collection in the response |
| `surface` | items recognised only in the rendered page: capture |
| `disallowed` | robots.txt disallows the path |

For each candidate the analyzer works out:
- fields (type, presence, distinctness, role);
- the identifier, and relations (detail links, page links, as path templates);
- pagination (page, offset or cursor parameters and response fields) and filters (bbox, query, enum);
- change mechanisms (ETag / Last-Modified, cache max-age, a per-record `updated` field);
- completeness (declared total vs returned);
- access (public or session; robots allowed, disallowed or unknown; whether it can be automated);
- duplicates (another candidate holding the same identifiers);
- a scored breakdown (structure, richness, records, identifiers, change detection, traversal, access).

**The same information in several representations stays separate.** The API, the embedded state and the rendered page of one site are separate candidates with their own provenance, flagged as duplicates when their identifiers overlap, and never merged into an invented record.

### Catalog (`feltkit/sites.ts`)

- **Definitions** (`signal.site-feed/v1`, `lib/site/types.ts`):
  - **Contain:** endpoint origin and path template (data-like path segments become `{placeholders}`), parameter names and roles (credential-like ones flagged `sensitive`), records path, fields with types and roles, identifier, relations, pagination, filters, change mechanisms, access, completeness, limitations, score, structure hash, page templates.
  - **Never contain:** values, parameter values, samples, cookies, headers or user ids.
  - **Leak check:** `assertShareable` checks every definition independently. Site-derived strings must not equal any value the person's browser observed, and nothing anywhere may look like a token, key or e-mail address.
- **Contribution:**
  - Analyses are private.
  - Public, session-independent feeds, page-surface entries and disallowed endpoints are contributed automatically.
  - Session-bound feeds are contributed only when the person presses "Share its structure".
  - The same structure seen again increments the count; a different structure for the same endpoint becomes a new version.
- **Lifecycle:**

| Status | How it is reached |
|---|---|
| `discovered` | first contribution |
| `verified` | an actual acquisition conformed to the definition (fields present, identifier unique) |
| `production` | a curator (`signal.curate`) promoted a verified feed |
| `needs_reanalysis` | an acquisition no longer conforms: the site changed |
| `broken` | three consecutive failures that are evidence about the site (a user's expired session is not) |
| `deprecated` | a curator withdrew it |

  Every check is recorded anonymously (`signal_feed_checks`: outcome, conformance, record count; no user, no values). Users can report problems.
- **Connections (`sites:connect`):**
  - A parameterised feed is instantiated with this user's own URL: by default the one their browser used, taken from their own private analysis.
  - Session-bound feeds can only be acquired in the person's browser. Signal's server refuses to acquire them, and never holds a session.
  - The connection is an ordinary source. Its records flow through the existing ingestion, identity, criteria and finding pipeline, with conditional requests and an interval taken from the feed's `max-age`.
  - Every acquisition is also a verification of the shared definition.

### Areas: the real Rhode Island boundary

`rhode island.geojson` (the repository's real state boundary, a MultiPolygon) is used as a file source and referenced by the new condition `{ attr: "@location", op: "within", value: { sourceId, recordKey, bufferKm? } }`. The area keeps its provenance (it is a source record, not a pasted polygon). An area that is missing makes the condition unknown, never "outside". Distances outside the polygon are measured to its nearest vertex: an upper bound on the true distance to the edge.

## 4. Evidence

See `docs/site-validation.json` (real sites, real feeds) and the tests:

| Test | What it proves | Data |
|---|---|---|
| `tests/lib/site.test.ts` | analyzer on real USGS evidence (feed found and ranked first, detail endpoint, search page's JSON correctly not a feed, token never shared), synthetic session/robots/embedded-state cases | real USGS evidence + synthetic |
| `tests/sites.test.ts` | catalog → connect → verified → findings → deduplicated notices → page context → shape change → needs_reanalysis → recovery → second user reuse → areas | real USGS feed replayed locally |
| `tests/e2e/ambient.e2e.ts` | the 15-step ambient scenario in real Chromium with the extension | **synthetic** site (session-bound SPA) |
| `scripts/validate-real-sites.ts` | real pages, real feeds, live monitoring, second user | **real** (USGS, Hacker News) |

## 5. Measured

**Real sites** (`docs/site-validation.json`, 2026-11-17, real Chromium through this environment's proxy, real FeltDB):

| Page | Load | Collect (re-issue GETs) | Analyze | Result |
|---|---|---|---|---|
| USGS latest earthquakes map | 4.6 s | 2.8 s (8 of 26 requests) | 53 ms | `summary/2.5_day.geojson` ranked first (0.98): 45 records, `id`, Last-Modified, per-record `updated`, public, robots allowed. ArcGIS layers found (one third-party feed public, one session-bound by token: not shared). Styling and sprites classified as metadata |
| USGS event page | 4.0 s | 2.0 s | 23 ms | the detail endpoint `/earthquakes/feed/v1.0/detail/{id}.geojson` (one record, same id scheme, `updated`) |
| USGS search | 2.7 s | 0.2 s | 7 ms | `application.json` correctly **not** a feed (enumerations) |
| Hacker News | 2.6 s | 0.2 s | 178 ms | no feed; page surface only (posts ×29, people ×28): capture |

**Acquisition and monitoring:**
- **Summary feed:** first acquisition 407 ms (45 records), verified 1.0. Detail feed: 70 ms, verified.
- **Cross-feed identity:** the detail record joined the same real earthquake from the summary feed by location (probable match, within 30 m), and both records were kept.
- **Six minutes of live monitoring:**
  - every 60 s a 200 response, because USGS regenerates the file each minute; most polls carried no new information;
  - one record was revised at minute 6 and became a new observation version, but it was not a meaningful change for any criteria, so no notice was sent.
- **Criteria on real data:** magnitude ≥ 4.5 gave 11 findings, evaluated in 58 ms. "Within 1,500 km of Rhode Island" and "inside Rhode Island" gave 0 findings (true for that day's data).
- **Second user:** recognised the site (3 feeds), connected with their own access (45 records of their own), saw none of the first user's analyses, and the catalog held no token value.

**Ambient** (`docs/ambient-measurements.json`, synthetic session-bound SPA):
- recognition 15 ms; site analysis 228 ms; connect + first acquisition 263 ms.
- change → finding 56 s. That is bounded by the site's 60 s cache interval, which Signal honours as its poll interval.
- finding → overlay ≈ 0.3 s.
- 2 notices for 2 findings; overlay ≈ 0.9 MB of page heap.
