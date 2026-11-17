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
      "signal.sources.*", "signal.criteria.*", "signal.monitors.*", "signal.events.*",
      "files.read", "files.write", "notifications.*", "webhooks.emit", "webhooks.deliver",
    ],
    // Viewers read events and their evidence (their own; see authorize).
    viewer: ["signal.events.read", "files.read", "notifications.read"],
    // Agents may read and run monitors they are delegated, never define or delete them.
    agent: ["signal.events.read", "signal.monitors.read", "signal.monitors.run", "files.read", "files.write", "notifications.send", "webhooks.emit", "webhooks.deliver"],
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
    if (!principal) return { allowed: false, reason: "sign in" };
    if (principal.roles?.includes("admin")) return true;
    const a = (args ?? {}) as Record<string, unknown>;
    const owned = async (collection: string, id: unknown) => {
      if (typeof id !== "string") return true; // functions without that argument
      const rec = (await db.get(collection as never, id)) as { ownerId?: string } | null;
      return !rec || rec.ownerId === principal.id; // missing records are reported NOT_FOUND by the handler
    };
    const checks: Array<[string, unknown]> = [
      ["signal_sources", a.sourceId], ["signal_monitors", a.monitorId], ["signal_events", a.eventId],
    ];
    for (const [c, id] of checks) if (!(await owned(c, id))) return { allowed: false, reason: `not the owner (${fn})` };
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
  monitorId: s.string(),
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
