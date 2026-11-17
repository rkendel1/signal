/**
 * Signal: continuous, user-directed intelligence over the sources a person connects.
 *
 * FeltKit supplies durable state (one FeltDB instance per environment), roles and per-record authorization,
 * AppPort capabilities, Files (raw source bytes), Notifications, Jobs and Schedules. Signal supplies the model:
 *
 *   signal_sources ─refresh→ signal_ingestions ─(content changed)→ signal_observations (versioned)
 *        └ signal_links (identity, with basis) → signal_entities
 *   signal_criteria (+ immutable signal_criteria_versions) × entity evidence → signal_findings
 *        └ signal_finding_events (history), signal_runs (what caused each evaluation)
 *
 * Nested, write-once structures (mappings, attribute values, explanations) are canonical JSON strings.
 */
import { feltkit, s } from "@feltdb/feltkit";

export const app = feltkit({
  name: "signal",
  description: "Connect sources, define what matters, and continuously surface explainable findings with their evidence.",
  roles: {
    member: ["signal.read", "signal.write", "signal.push", "files.read", "files.write"],
    viewer: ["signal.read", "files.read"],
    /** Systems that push records into sources their owner created (API keys hold this role). */
    agent: ["signal.read", "signal.push", "files.read", "files.write"],
    /** signal.curate: review shared site definitions (promote to production, deprecate). signal.admin: act for others. */
    admin: ["signal.*", "jobs.*", "schedules.*", "configuration.*", "apikeys.*", "credential.*", "files.*", "webhooks.*"],
  },
  auth: { accounts: { roles: ["member"] } },
  dev: {
    users: [
      { id: "ada", name: "Ada Lovelace", roles: ["member", "admin"] },
      { id: "bob", name: "Bob", roles: ["member"] },
      { id: "grace", name: "Grace Hopper", roles: ["viewer"] },
    ],
  },
  services: {
    files: true,
    configuration: true,
    apiKeys: { roles: ["agent"] },
    // A schedule can run the freshness sweep (a mutation: it reads and writes state, it does not fetch).
    jobs: { handlers: { "signal.sweep": "engine:sweep" } },
    schedules: true,
  },
  /** A caller may act only on records it owns (admins excepted). Roles decide which operations; this decides on what. */
  authorize: async ({ function: fn, args, principal, db }) => {
    if (!principal) return { allowed: false, code: "UNAUTHORIZED", reason: "sign in" };
    if (principal.roles?.includes("admin")) return true;
    const a = (args ?? {}) as Record<string, unknown>;
    const checks: Array<[string, unknown]> = [
      ["signal_sources", a.sourceId], ["signal_criteria", a.criteriaId], ["signal_findings", a.findingId], ["signal_entities", a.entityId],
      ["signal_notices", a.noticeId], ["signal_site_analyses", a.analysisId],
      // signal_sites and signal_site_feeds are shared knowledge: readable by everyone signed in, owned by no one.
    ];
    for (const [c, id] of checks) {
      if (typeof id !== "string") continue;
      const rec = (await db.get(c as never, id)) as { ownerId?: string } | null;
      if (rec && rec.ownerId !== principal.id) return { allowed: false, code: "FORBIDDEN", reason: `not the owner (${fn})` };
    }
    return true;
  },
});

const owner = { ownerId: s.string() };

/*
 * Index note (GAP_REGISTER G-PLAT-5). Every equality read that can match more than 1,000 records has an index on
 * exactly those fields. With FeltDB 0.21, a read on only a PREFIX of a composite index was observed to stop after
 * the first 1,000-record page (silently, for signal_links by sourceId) or to fail with a repeated cursor
 * (signal_observations by sourceId). The single-field indexes below are load-bearing. scripts/repro-unique-prefix.ts.
 */

export const sources = app.collection("signal_sources", {
  name: s.string({ minLength: 1, maxLength: 200 }),
  description: s.optional(s.string({ maxLength: 2000 })),
  kind: s.enum(["file", "http_json", "push", "page_capture", "manual", "site_feed"] as const),
  /** site_feed: the shared definition this connection instantiates, and how this user's copy is acquired. */
  siteId: s.optional(s.string()),
  feedId: s.optional(s.string()),
  feedVersion: s.optional(s.integer()),
  acquisition: s.optional(s.enum(["server", "browser"] as const)),
  /** native: produced inside Signal's environment (captures, manual records). user: brought by the user. */
  origin: s.enum(["native", "user"] as const),
  status: s.enum(["connected", "paused", "unavailable", "removed"] as const),
  statusReason: s.optional(s.string()),
  entityType: s.string({ minLength: 1, maxLength: 80 }),
  /** canonical JSON: kind-specific connection settings (URL, records path, page types, format). Never a secret. */
  config: s.string(),
  /** canonical JSON SourceMapping / PageMapping. */
  mapping: s.string(),
  mappingVersion: s.integer(),
  refreshMode: s.enum(["snapshot", "poll", "push", "capture"] as const),
  intervalMinutes: s.optional(s.integer()),
  staleAfterDays: s.optional(s.number()),
  synthetic: s.boolean(),
  records: s.integer(),
  lastRefreshAt: s.optional(s.string()),
  lastSuccessAt: s.optional(s.string()),
  lastChangeAt: s.optional(s.string()),
  lastError: s.optional(s.string()),
  etag: s.optional(s.string()),
  lastModified: s.optional(s.string()),
  createdAt: s.string(),
  ...owner,
}, { indexes: [{ fields: ["ownerId"] }] });

/** One refresh attempt. A refresh is not new information: `added/changed/retracted` say whether it was. */
export const ingestions = app.collection("signal_ingestions", {
  ingestionId: s.string(),
  sourceId: s.string(),
  seq: s.integer(),
  at: s.string(),
  trigger: s.enum(["upload", "refresh", "push", "capture", "mapping", "removal", "create"] as const),
  status: s.enum(["ok", "not_modified", "error", "unavailable"] as const),
  rawRef: s.optional(s.string()),
  rawHash: s.optional(s.string()),
  mappingVersion: s.integer(),
  received: s.integer(),
  added: s.integer(),
  changed: s.integer(),
  unchanged: s.integer(),
  retracted: s.integer(),
  issues: s.string(), // canonical JSON (first 50 mapping issues + count)
  provenance: s.string(),
  error: s.optional(s.string()),
  durationMs: s.optional(s.number()),
  ...owner,
}, { unique: [["ingestionId"]], indexes: [{ fields: ["sourceId", "seq"] }, { fields: ["ownerId", "at"] }] });

/** Versioned: a new version only when what the record states changes. Superseded and retracted versions are kept. */
export const observations = app.collection("signal_observations", {
  observationId: s.string(),
  sourceId: s.string(),
  recordKey: s.string(),
  version: s.integer(),
  ingestionId: s.string(),
  status: s.enum(["current", "superseded", "retracted"] as const),
  entityType: s.string(),
  observedAt: s.string(),
  confirmedAt: s.optional(s.string()),
  validAt: s.optional(s.string()),
  contentHash: s.string(),
  body: s.string(), // canonical JSON { attributes, identity, locator, keyBasis }
  retractedAt: s.optional(s.string()),
  retractReason: s.optional(s.string()),
  /** The record's own web address (a listing, an event page), and the page it was captured on: how the overlay finds context. */
  url: s.optional(s.string()),
  pageUrl: s.optional(s.string()),
  ...owner,
}, { unique: [["observationId"]], indexes: [{ fields: ["url"] }, { fields: ["pageUrl"] }, { fields: ["sourceId"] }, { fields: ["sourceId", "status"] }, { fields: ["sourceId", "recordKey"] }] });

export const entities = app.collection("signal_entities", {
  type: s.string(),
  label: s.optional(s.string()),
  keys: s.string(), // canonical JSON EntityKeys
  records: s.integer(),
  lat: s.optional(s.number()),
  lng: s.optional(s.number()),
  createdAt: s.string(),
  ...owner,
}, { indexes: [{ fields: ["ownerId"] }, { fields: ["ownerId", "type"] }] });

/** Which entity a source record contributes to, and why. User decisions are never overwritten by the system. */
export const links = app.collection("signal_links", {
  sourceId: s.string(),
  recordKey: s.string(),
  entityId: s.string(),
  status: s.enum(["exact", "probable", "ambiguous", "conflict", "unmatched", "manual"] as const),
  basis: s.string(),
  confidence: s.number(),
  reason: s.string(),
  options: s.string(), // canonical JSON of alternative entities
  decidedBy: s.enum(["system", "user"] as const),
  at: s.string(),
  ...owner,
}, { unique: [["sourceId", "recordKey"]], indexes: [{ fields: ["sourceId"] }, { fields: ["entityId"] }, { fields: ["ownerId"] }, { fields: ["ownerId", "status"] }] });

export const criteria = app.collection("signal_criteria", {
  name: s.string({ minLength: 1, maxLength: 200 }),
  entityType: s.string(),
  activeVersion: s.integer(),
  enabled: s.boolean(),
  removed: s.boolean(),
  notify: s.array(s.string()),
  createdAt: s.string(),
  updatedAt: s.string(),
  ...owner,
}, { indexes: [{ fields: ["ownerId"] }] });

/** Immutable. An edit is a new version; findings record the version they were evaluated under. */
export const criteriaVersions = app.collection("signal_criteria_versions", {
  criteriaId: s.string(),
  version: s.integer(),
  definition: s.string(),
  createdAt: s.string(),
  ...owner,
}, { unique: [["criteriaId", "version"]], indexes: [{ fields: ["criteriaId"] }] });

export const findings = app.collection("signal_findings", {
  criteriaId: s.string(),
  entityId: s.string(),
  status: s.enum(["open", "resolved", "superseded", "invalid"] as const),
  change: s.enum(["new", "changed", "persistent", "reopened", "resolved", "superseded", "invalid"] as const),
  qualification: s.enum(["match", "possible"] as const),
  criteriaVersion: s.integer(),
  score: s.number(),
  confidence: s.number(),
  summary: s.string(),
  entityLabel: s.optional(s.string()),
  explanation: s.string(), // canonical JSON Outcome at the last evaluation
  state: s.string(), // canonical JSON FindingState (results and values at the last event)
  hasConflict: s.boolean(),
  hasStale: s.boolean(),
  hasMissing: s.boolean(),
  synthetic: s.boolean(),
  sourceCount: s.integer(),
  firstDetectedAt: s.string(),
  lastChangedAt: s.string(),
  lastEvaluatedAt: s.string(),
  acknowledgedAt: s.optional(s.string()),
  dismissedAt: s.optional(s.string()),
  dismissReason: s.optional(s.string()),
  /** Hidden from the feed and silent until then; its history continues. */
  snoozedUntil: s.optional(s.string()),
  ...owner,
}, { unique: [["criteriaId", "entityId"]], indexes: [{ fields: ["ownerId"] }, { fields: ["ownerId", "status"] }, { fields: ["entityId"] }, { fields: ["criteriaId"] }, { fields: ["criteriaId", "status"] }] });

export const findingEvents = app.collection("signal_finding_events", {
  findingId: s.string(),
  seq: s.integer(),
  at: s.string(),
  kind: s.string(),
  criteriaVersion: s.integer(),
  cause: s.string(), // canonical JSON Cause
  runId: s.string(),
  reason: s.string(),
  diff: s.string(),
  evidenceIds: s.string(),
  qualification: s.optional(s.string()),
  ...owner,
}, { indexes: [{ fields: ["findingId", "seq"] }, { fields: ["ownerId", "at"] }] });

/** One evaluation pass and what caused it. */
export const runs = app.collection("signal_runs", {
  runId: s.string(),
  seq: s.integer(),
  at: s.string(),
  cause: s.string(),
  causeKind: s.string(),
  entities: s.integer(),
  evaluations: s.integer(),
  created: s.integer(),
  changed: s.integer(),
  closed: s.integer(),
  reopened: s.integer(),
  durationMs: s.number(),
  ...owner,
}, { unique: [["runId"]], indexes: [{ fields: ["ownerId", "seq"] }] });

// ------------------------------------------------------------------ notifications (Signal's own, durable)

/**
 * What Signal tells a person, and what they did about it. Created in the same transaction as the change that
 * caused it; deduplicated by `dedupKey`. Delivery channels (the extension's browser notifications, the overlay,
 * the web app) read from here; acknowledging or snoozing never deletes history.
 */
export const notices = app.collection("signal_notices", {
  kind: s.enum(["finding_new", "finding_changed", "finding_resolved", "finding_reopened", "finding_closed", "source_failure", "source_recovered", "source_stale", "monitor"] as const),
  severity: s.enum(["info", "warning", "critical"] as const),
  priority: s.number(),
  title: s.string(),
  body: s.string(),
  findingId: s.optional(s.string()),
  sourceId: s.optional(s.string()),
  entityId: s.optional(s.string()),
  /** Context for contextual delivery: the entity's web address(es), when known. */
  urls: s.array(s.string()),
  dedupKey: s.string(),
  createdAt: s.string(),
  ackAt: s.optional(s.string()),
  snoozedUntil: s.optional(s.string()),
  /** When a browser notification was shown for it (set by the extension). */
  deliveredAt: s.optional(s.string()),
  ...owner,
}, { unique: [["dedupKey"]], indexes: [{ fields: ["ownerId"] }, { fields: ["ownerId", "createdAt"] }, { fields: ["findingId"] }] });

export const preferences = app.collection("signal_preferences", {
  prefs: s.string(), // canonical JSON NotificationPrefs
  updatedAt: s.string(),
  ...owner,
}, { unique: [["ownerId"]] });

// ------------------------------------------------------------------ shared site intelligence

/** A website Signal has learned about. Shared: no owner, no user data. */
export const sites = app.collection("signal_sites", {
  domain: s.string(),
  name: s.string(),
  analyses: s.integer(),
  firstSeenAt: s.string(),
  lastAnalyzedAt: s.string(),
}, { unique: [["domain"]] });

/**
 * A versioned, shareable description of one information source on a site (signal.site-feed/v1). Structure and
 * semantics only: never values, never a user's parameters or session. Status:
 *   discovered        seen by an analysis, not yet shown to work for acquisition
 *   verified          an actual acquisition matched the described structure
 *   production        reviewed by a curator: recommended for everyone
 *   needs_reanalysis  acquisitions no longer match (the site changed)
 *   broken            repeated failures
 *   deprecated        withdrawn by a curator (kept: connections and history cite it)
 */
export const siteFeeds = app.collection("signal_site_feeds", {
  siteId: s.string(),
  feedKey: s.string(),
  version: s.integer(),
  status: s.enum(["discovered", "verified", "production", "needs_reanalysis", "broken", "deprecated"] as const),
  verdict: s.string(),
  label: s.string(),
  score: s.number(),
  definition: s.string(), // canonical JSON FeedDefinition
  structureHash: s.string(),
  pages: s.array(s.string()),
  analyses: s.integer(),
  verifications: s.integer(),
  failures: s.integer(),
  consecutiveFailures: s.integer(),
  lastVerifiedAt: s.optional(s.string()),
  lastFailureAt: s.optional(s.string()),
  lastFailure: s.optional(s.string()),
  reviewNote: s.optional(s.string()),
  createdAt: s.string(),
  updatedAt: s.string(),
}, { unique: [["feedKey", "version"]], indexes: [{ fields: ["siteId"] }, { fields: ["feedKey"] }] });

/** Verification history of a definition. Anonymous by design: no user id, no values; counts and outcomes only. */
export const feedChecks = app.collection("signal_feed_checks", {
  feedId: s.string(),
  version: s.integer(),
  at: s.string(),
  kind: s.enum(["analysis", "acquisition", "report"] as const),
  ok: s.boolean(),
  conformance: s.number(),
  records: s.integer(),
  detail: s.string(),
}, { indexes: [{ fields: ["feedId"] }] });

/** One user's analysis of one page. PRIVATE: it holds what their browser saw (samples, their URLs). */
export const siteAnalyses = app.collection("signal_site_analyses", {
  siteId: s.string(),
  url: s.string(),
  at: s.string(),
  durationMs: s.number(),
  result: s.string(), // canonical JSON SiteAnalysis (with private samples)
  contributed: s.array(s.string()), // feed ids this analysis contributed to or matched
  ...owner,
}, { indexes: [{ fields: ["ownerId"] }, { fields: ["siteId"] }] });
