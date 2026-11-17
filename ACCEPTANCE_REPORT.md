# Signal — Acceptance Report

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

## 3. Measurements (from `docs/bench.json`)

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
