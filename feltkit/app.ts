/**
 * Signal as a FeltKit application.
 *
 * FeltKit supplies what Signal must not rebuild: one FeltDB instance per environment
 * (durable state), roles and per-record authorization, AppPort capabilities (so apps and
 * agents can discover and invoke Signal), and AppPort Services — Files (evidence),
 * Notifications (alerts to people), Webhooks (alerts to systems), Jobs and Schedules.
 *
 * Signal supplies the capability itself (lib/): the Ghostpost codec and decoders,
 * normalization and extraction, the deterministic criteria evaluator, and the
 * observation adapters with their network guard.
 *
 * Nested structures (criteria conditions, evaluation traces, provenance) are stored as
 * canonical JSON strings: they are written once, never queried by inner field, and their
 * exact bytes are part of the record's evidence value.
 */
import { feltkit, s } from "@feltdb/feltkit";

export const app = feltkit({
  name: "signal",
  description: "Observe authorized sources, interpret signals, evaluate declarative criteria, record evidence-backed events, and alert.",
  roles: {
    // Members define what they care about and receive alerts. Ownership of each source,
    // criteria and monitor is enforced by `authorize` below, not by the role alone.
    member: [
      "signal.sources.*", "signal.criteria.*", "signal.monitors.*", "signal.events.*", "signal.pages.*", "signal.datasets.*",
      "files.read", "files.write", "notifications.*", "webhooks.emit", "webhooks.deliver",
    ],
    // Viewers read events and their evidence (their own; see authorize).
    viewer: ["signal.events.read", "signal.pages.read", "files.read", "notifications.read"],
    // Agents may read and run monitors they are delegated, never define or delete them.
    agent: ["signal.events.read", "signal.pages.read", "signal.monitors.read", "signal.monitors.run", "files.read", "files.write", "notifications.send", "webhooks.emit", "webhooks.deliver"],
    admin: ["signal.*", "webhooks.*", "jobs.*", "schedules.*", "configuration.*", "apikeys.*", "credential.*", "files.*", "notifications.*"],
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
    notifications: { types: ["signal.criteria_matched"] },
    webhooks: { events: ["signal.event"] },
    configuration: true,
    apiKeys: { roles: ["agent"] },
    jobs: { handlers: {} },
    schedules: true,
  },
  /**
   * Per-record rules: a caller may only act on sources, criteria, monitors and events
   * it owns (admins excepted). Roles decide *which* operations; this decides *on what*.
   */
  authorize: async ({ function: fn, args, principal, db }) => {
    if (!principal) return { allowed: false, code: "UNAUTHORIZED", reason: "sign in" };
    if (principal.roles?.includes("admin")) return true;
    const a = (args ?? {}) as Record<string, unknown>;
    const owned = async (collection: string, id: unknown) => {
      if (typeof id !== "string") return true; // functions without that argument
      const rec = (await db.get(collection as never, id)) as { ownerId?: string } | null;
      return !rec || rec.ownerId === principal.id; // missing records are reported NOT_FOUND by the handler
    };
    const checks: Array<[string, unknown]> = [
      ["signal_sources", a.sourceId], ["signal_datasets", a.datasetId], ["signal_monitors", a.monitorId], ["signal_events", a.eventId], ["signal_pages", a.pageId],
    ];
    for (const [c, id] of checks) if (!(await owned(c, id))) return { allowed: false, code: "FORBIDDEN", reason: `not the owner (${fn})` };
    return true;
  },
});

const ownerAndTime = { ownerId: s.string(), createdAt: s.string() };

export const sources = app.collection("signal_sources", {
  type: s.union([s.literal("http_page"), s.literal("text"), s.literal("json"), s.literal("dom")]),
  locator: s.string({ minLength: 1, maxLength: 2048 }),
  authorization: s.union([s.literal("public"), s.literal("credential_ref")]),
  credentialRef: s.optional(s.string()),
  respectRobots: s.boolean(),
  strategy: s.union([s.literal("manual"), s.literal("poll"), s.literal("event")]),
  intervalSeconds: s.optional(s.integer()),
  ...ownerAndTime,
}, { indexes: [{ fields: ["ownerId"] }] });

/** Immutable criteria versions: `criteriaId@version` is unique; an edit is a new version. */
export const criteria = app.collection("signal_criteria", {
  criteriaId: s.string({ minLength: 1, maxLength: 120 }),
  version: s.integer(),
  name: s.string({ minLength: 1, maxLength: 200 }),
  severity: s.union([s.literal("info"), s.literal("warning"), s.literal("critical")]),
  definition: s.string(), // canonical JSON of the full signal.criteria/v1 definition
  ...ownerAndTime,
}, { unique: [["criteriaId", "version"]], indexes: [{ fields: ["ownerId"] }] });

export const monitors = app.collection("signal_monitors", {
  sourceId: s.string(),
  criteriaId: s.string(),
  criteriaVersion: s.integer(),
  /** Recipients of AppPort notifications (people). */
  notify: s.array(s.string()),
  /** Emit the `signal.event` webhook to registered endpoints (systems). */
  emitWebhook: s.boolean(),
  enabled: s.boolean(),
  // Mutable condition state, updated in the same transaction as the evaluation it follows.
  matched: s.boolean(),
  lastDedupKey: s.optional(s.string()),
  lastEventAt: s.optional(s.string()),
  lastInterpretationId: s.optional(s.string()),
  lastContentHash: s.optional(s.string()),
  etag: s.optional(s.string()),
  lastModified: s.optional(s.string()),
  ...ownerAndTime,
}, { indexes: [{ fields: ["ownerId"] }, { fields: ["sourceId"] }] });

export const observations = app.collection("signal_observations", {
  observationId: s.string(),
  sourceId: s.string(),
  monitorId: s.optional(s.string()), // absent for pages:inspect observations
  observedAt: s.string(),
  status: s.union([s.literal("ok"), s.literal("not_modified"), s.literal("denied"), s.literal("error")]),
  evidenceRef: s.optional(s.string()), // Files id of the exact bytes observed
  contentHash: s.optional(s.string()), // sha256 of those bytes
  contentType: s.optional(s.string()),
  byteLength: s.optional(s.integer()),
  provenance: s.string(),
  error: s.optional(s.string()),
  ownerId: s.string(),
}, { unique: [["observationId"]], indexes: [{ fields: ["monitorId", "observedAt"] }] });

export const interpretations = app.collection("signal_interpretations", {
  interpretationId: s.string(),
  observationId: s.string(),
  body: s.string(), // canonical JSON of signal.interpretation/v1
  ownerId: s.string(),
}, { unique: [["interpretationId"]] });

export const evaluations = app.collection("signal_evaluations", {
  evaluationId: s.string(),
  monitorId: s.string(),
  observationId: s.string(),
  seq: s.integer(), // per-monitor order (ctx.db.sequence), never wall-clock
  evaluatedAt: s.string(),
  matched: s.boolean(),
  outcome: s.string(),
  eventId: s.optional(s.string()),
  body: s.string(), // canonical JSON of signal.evaluation/v1 incl. full trace
  ownerId: s.string(),
}, { unique: [["evaluationId"]], indexes: [{ fields: ["monitorId", "seq"] }] });

export const events = app.collection("signal_events", {
  eventId: s.string(),
  monitorId: s.string(),
  sourceLocator: s.string(),
  severity: s.string(),
  occurredAt: s.string(),
  acknowledgedAt: s.optional(s.string()),
  acknowledgedBy: s.optional(s.string()),
  body: s.string(), // canonical JSON of signal.event/v1
  ownerId: s.string(),
}, { unique: [["eventId"]], indexes: [{ fields: ["ownerId", "occurredAt"] }, { fields: ["sourceLocator"] }, { fields: ["monitorId"] }] });

/**
 * Index of signal.page/v1 representations. The representation itself (often tens of KB)
 * is stored in Files beside the evidence it was derived from; it is a derived projection,
 * never the authority — the raw observed bytes are.
 */
export const pages = app.collection("signal_pages", {
  observationId: s.string(),
  sourceId: s.string(),
  locator: s.string(),
  observedAt: s.string(),
  revision: s.string(),
  extractorVersion: s.string(),
  pageRef: s.string(), // files:<id> of the canonical JSON representation
  entities: s.integer(),
  relationships: s.integer(),
  collections: s.integer(),
  signals: s.integer(),
  truncated: s.boolean(),
  ownerId: s.string(),
}, { unique: [["observationId"]], indexes: [{ fields: ["sourceId", "observedAt"] }, { fields: ["ownerId"] }] });

/**
 * A user-owned dataset: an independent source of facts that is not a page (a parcel file, a rent survey,
 * an export). Distinct from `signal_sources`, which are pages Signal observes. The dataset is the identity
 * and the declared update semantics; what it contains lives in immutable versions.
 */
export const datasets = app.collection("signal_datasets", {
  name: s.string({ minLength: 1, maxLength: 200 }),
  /** static: a snapshot; periodic: replaced on a schedule; live: queried at use. Declared by the owner, never inferred. */
  freshness: s.union([s.literal("static"), s.literal("periodic"), s.literal("live")]),
  retired: s.boolean(),
  ...ownerAndTime,
}, { indexes: [{ fields: ["ownerId"] }] });

/**
 * Immutable. An import creates version 1 (mapping proposed, not reviewed); changing the mapping creates the next
 * version over the same raw bytes. A version is what a discovery result cites, so it is never edited.
 */
export const datasetVersions = app.collection("signal_dataset_versions", {
  datasetId: s.string(),
  version: s.integer(),
  rawRef: s.string(), // files:<id> of the gzip of the exact bytes imported
  rawHash: s.string(), // sha256 of those bytes
  format: s.union([s.literal("csv"), s.literal("geojson")]),
  rows: s.integer(),
  mapping: s.string(), // canonical JSON of DatasetMapping (its version equals `version`)
  /** False until a person accepted or edited the mapping. Unreviewed versions are never used in discovery. */
  reviewed: s.boolean(),
  dataAsOf: s.optional(s.string()), // when the provider says the data was true
  retrievedAt: s.string(), // when Signal received it
  ownerId: s.string(),
}, { unique: [["datasetId", "version"]], indexes: [{ fields: ["datasetId"] }, { fields: ["ownerId"] }] });
