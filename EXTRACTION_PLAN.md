# Signal — Extraction Plan

Ghostpost remains the working reference implementation. Nothing in `rkendel1/ghostpost` was modified. Signal is a separate FeltKit application in `rkendel1/signal`.

## Preserve

| What | How | Status |
|---|---|---|
| The invisible-Unicode **wire format** (v1) | `codecs/ghostpost-unicode`: the Rust source vendored from `ghostpost@369220a` | Done. Encodes **byte-identically** to Ghostpost's shipped WASM, and decodes everything it produces (11 fixture cases, `tests/fixtures/ghostpost-369220a.json`) |
| Legacy decoding (unmarked pre-Dec-2025 payloads; nested "double-wrapped" references from the userscript) | Strict decoder keeps both paths, flagged `legacy` / `nested` | Done |
| WASM export names (`encode`, `decode`, `encode_reference`, …) | Unchanged in `codecs/ghostpost-unicode/src/lib.rs` | Done. Existing callers can swap the artifact |
| Dynamic-feed observation (MutationObserver, debounce) | `lib/overlay/overlay.js` | Done (debounced 400 ms; no periodic rescan) |

## Refactor

| What | Into | Status |
|---|---|---|
| Panicking length-prefixed parsers | Bounds-checked `read_u16` / `Reader` | Done; panics become errors |
| `decode()` guessing payload type | `inspect()`: every envelope, strict framing, marker dispatch, warnings | Done |
| Ghostpost-only detector, one result per text | `invisible-unicode/v1` (format-agnostic, tag characters) plus the strict envelope finder | Done |
| Overlay state machine + StackLive adapter | Overlay states (monitoring / signal / alerts / acknowledged) driven by real decoding and real events | Done |
| Secure-note "password" embedding | Decodable, with an explicit warning | Done (warning). Recommend that Ghostpost stop embedding secrets |

## Replace

| What | With |
|---|---|
| StackLive runtime bridge (`TODO` placeholders) | Nothing. Signal events and the overlay replace "experience launch" |
| `extractExperienceId` (hashes visible text) | Decoder → criteria → event |
| Extension sidebar (`panel.js`, unescaped `innerHTML`) | Signal overlay (closed shadow root, `textContent`, host transport) |
| `prefetchReference(external_url)` (fetches any URL in content) | Authorized `references:resolve` action behind the net guard (G-REF-1, not built) |
| Ghostpost analytics as a stand-in for alerting | Signal's evaluation/event records + AppPort Notifications |

## Retire

- Placeholder markers `0x03 hybrid`, `0x04 metadata`, `0x06–0x08 conversation/adaptive/story`: reported as `unimplemented`, never encoded.
- AI-prompt payloads as an *execution* path: decodable as data only. Running embedded prompts is a prompt-injection vector.
- Dead extension modules: `message-detector.js` (imports a file that does not exist), `prefetch-reference.js`, `utils/dom-walker.js`.
- The duplicate JS decoder in the userscript, once the extension host (M4) ships.
- Signal's own pre-FeltKit layers (store, service, HTTP API, webhook/inbox dispatchers) were built, then **deleted** when FeltKit was adopted. They are in git history (`81d49cd`, `eceea2b`) for reference only.

## Migration and compatibility

1. **Content already published stays readable.** v1 decoding is permanent. A future v2 (G-CODEC-1) is opt-in on encode and always decoded alongside v1.
2. **Ghostpost can adopt the codec artifact** (`codecs/ghostpost-unicode/pkg`) without changing callers. Export names and outputs are identical, and malformed input now returns errors instead of trapping.
3. **The extension migrates by host, not by rewrite.** The extension becomes a host for `overlay.js` (transport + `codecBase`). Ghostpost-specific reveal flows (hosted references, limited reveals) stay in Ghostpost.

## Milestones (prioritized)

| # | Milestone | Outcome | Depends on |
|---|---|---|---|
| M1 | **Codec extracted** | Done: wire-compatible, panic-free, strict, tested (Rust 12, TS 9, cross-implementation fixtures) | – |
| M2 | **Signal Core + FeltKit app** | Done: criteria, evidence, events, AppPort notifications, ownership, overlay; 28 tests | M1 |
| M3 | **Continuous monitoring** | Due monitors observed on schedule | FeltKit job→action (G-PLAT-1) or an egress component |
| M4 | **Converge with `web-monitor`** | One product. Port web-monitor's five conditions to `signal.criteria/v1` (a mechanical mapping). Reuse its Chrome extension as the overlay host (G-OVL-1) and its local WebLLM compiler to *draft* criteria (G-CRIT-1). Retire its separate condition engine and notification wiring | M2 |
| M5 | **Hardening** | Tenancy (G-TEN-1), DNS pinning (G-SEC-2), attested observations (G-SEC-1), webhook end-to-end (G-DEL-1), credentialed sources (G-SRC-2) | M2 |
| M6 | **Codec v2** | Integrity and versioning (G-CODEC-1/2) | M1 |
| M7 | **Reference resolution** | Authorized, guarded resolver (G-REF-1) | M5 |
