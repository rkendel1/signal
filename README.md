# Signal

**Observe. Interpret. Evaluate. Act.** Signal makes accessible information observable, interpretable, actionable and continuously relevant to the person or application that cares about it.

Give Signal an authorized source, a set of declarative criteria, and who should hear about it. Signal deterministically:
1. observes the source and preserves the exact bytes it saw;
2. interprets them: builds a site-agnostic representation of the page (entities, attributes, relationships, collections, each with evidence), extracts fields, and decodes embedded signals, including Ghostpost's invisible-Unicode payloads;
3. evaluates the criteria and records *why* with a full trace;
4. produces a durable, deduplicated event;
5. notifies people through AppPort Notifications and systems through AppPort Webhooks;
6. shows it in context with an in-page overlay.

No LLM runs anywhere in that path.

Signal is a **FeltKit application** (`npm create feltkit@latest signal`). FeltKit and the Boundry platform supply durable state (FeltDB), authorization, AppPort capabilities, evidence storage (Files) and delivery. Signal supplies the capability.

```
feltkit/          the application: collections, roles, ownership rule, functions
  app.ts            roles, authorize hook, signal_* collections
  sources.ts        sources:register|list
  criteria.ts       criteria:define|get          (immutable signal.criteria/v1 versions)
  monitors.ts       monitors:create|observe|push|record|history
  events.ts         events:list|forPage|evidence|acknowledge|inbox
  pages.ts          pages:inspect|push|get|list    (signal.page/v1, no criteria needed)
lib/              Signal's capability: pure, framework-free
  codecs/           ghostpost-unicode/v1 (WASM), invisible-unicode/v1
  interpret/        normalization (preserves invisible signals), extraction
  page/             universal page intelligence: signal.page/v1, extraction, typing, entity criteria
  core/             deterministic criteria evaluator, the pure cycle decision
  sources/          HTTP observation: robots.txt, conditional GET, SSRF guard
  overlay/          in-page overlay (host transport, closed shadow root)
  contracts/        record shapes (signal.*/v1)
codecs/ghostpost-unicode/   Rust codec extracted from rkendel1/ghostpost (wire-identical) + built WASM
examples/         documented use cases, each executed by the tests
tests/            feltkit test suite (library, application, use cases, browser overlay)
```

## Run

```bash
npm install
```

```bash
npm test
```

```bash
npm run test:codec
```

```bash
npm run bench
```

```bash
node scripts/bench-pages.ts
```

```bash
npm run dev
```

- `npm test` runs `feltkit test`: 55 tests against real FeltDB, AppPort services and headless Chromium.
- `npm run test:codec` runs the Rust codec tests (12).
- `npm run bench` and `node scripts/bench-pages.ts` print the measurements behind ACCEPTANCE_REPORT.md.
- `npm run dev` starts FeltKit dev with Studio. Sign in as `ada`.

A minimal session (as a member):

```ts
const sourceId  = await client.mutation(api.sources.register, { type: "http_page", locator: "https://example.com/widget", strategy: "manual" });
await client.mutation(api.criteria.define, { definition: JSON.stringify({
  id: "widget-drop", name: "Widget under $100", severity: "warning",
  extract: [{ field: "price", from: "text", pattern: "Price:\\s*\\$([0-9.,]+)", type: "number" }],
  condition: { field: "price", op: "lt", value: 100 } }) });
const monitorId = await client.mutation(api.monitors.create, { sourceId, criteriaId: "widget-drop", criteriaVersion: 1 });
await client.action(api.monitors.observe, { monitorId });   // → { outcome: "event_recorded" | "no_match" | "suppressed_duplicate" | … }
```

## Documents

| Document | What it answers |
|---|---|
| [EXTRACTION_AUDIT.md](EXTRACTION_AUDIT.md) | What Ghostpost actually contains, what works, what is a placeholder (with evidence) |
| [CAPABILITY_ARCHITECTURE.md](CAPABILITY_ARCHITECTURE.md) | Boundaries, data flow, trust model, Boundry mapping, relation to `web-monitor` |
| [CAPABILITY_CONTRACTS.md](CAPABILITY_CONTRACTS.md) | Records, criteria language, operations, codec wire format |
| [PAGE_INTELLIGENCE.md](PAGE_INTELLIGENCE.md) | M5: the page representation, extraction pipeline, type rules, entity criteria, limits |
| [EXTRACTION_PLAN.md](EXTRACTION_PLAN.md) | Preserve / refactor / replace / retire; milestones |
| [GAP_REGISTER.md](GAP_REGISTER.md) | What is missing, platform vs product |
| [ACCEPTANCE_REPORT.md](ACCEPTANCE_REPORT.md) | Commands run, results, measurements, security findings |

## Known limits

These are stated plainly; details are in GAP_REGISTER.
- **No scheduled polling yet.** FeltKit jobs run mutations, and mutations may not fetch.
- **The overlay needs an extension host** to run on third-party pages.
- **Single tenant.**
- **Webhook delivery is staged but not exercised** in tests.
- **Page intelligence** is demonstrated on 8 unrelated fixtures, not proven universal. Dynamic pages need a rendered snapshot. Representations are large. See GAP_REGISTER G-PAGE-*.
