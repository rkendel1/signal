import { fail, s } from "@feltdb/feltkit";
import { app, criteria, evaluations, events, interpretations, monitors, observations, sources } from "./app.js";
import { api } from "./_generated/api.js";
import type { Interpretation, Observation, SourceDefinition } from "../lib/contracts/types.ts";
import { newId, sha256 } from "../lib/core/canonical.ts";
import { runCycle } from "../lib/core/cycle.ts";
import { normalizeContent } from "../lib/interpret/normalize.ts";
import { HttpSource } from "../lib/sources/sources.ts";
import { TENANT, json, netPolicy, parse, parseCriteria, requireFound, signalDecoders } from "./_shared.js";

const MAX_BODY = 5_000_000;

/** Bind a source to a criteria version and to who/what is told when it matches. */
export const create = app.mutation({
  access: "signal.monitors.write",
  args: {
    sourceId: s.string(), criteriaId: s.string(), criteriaVersion: s.integer(),
    notify: s.optional(s.array(s.string())), emitWebhook: s.optional(s.boolean()),
  },
  returns: s.string(),
  capability: { name: "signal.monitors.create", description: "Create a monitor: a source, a criteria version, and who is notified when it matches." },
  handler: async (ctx, a) => {
    const owner = ctx.auth.requirePrincipal().id;
    requireFound(await ctx.db.get(sources, a.sourceId), "That source");
    const [c] = await ctx.db.find(criteria, { criteriaId: a.criteriaId, version: a.criteriaVersion });
    if (!c || c.ownerId !== owner) fail("NOT_FOUND", `Criteria ${a.criteriaId}@v${a.criteriaVersion} does not exist.`);
    const notify = a.notify ?? [owner];
    // Recipients other than the owner would let one member push alerts into another's inbox.
    if (notify.some((r) => r !== owner) && !ctx.auth.has("signal.admin")) fail("FORBIDDEN", "Monitors may only notify their owner.");
    return ctx.db.insert(monitors, {
      sourceId: a.sourceId, criteriaId: a.criteriaId, criteriaVersion: a.criteriaVersion, notify, emitWebhook: a.emitWebhook ?? false,
      enabled: true, matched: false, ownerId: owner, createdAt: new Date().toISOString(),
    });
  },
});

export const list = app.query({
  access: "signal.monitors.read",
  handler: async (ctx) => ctx.db.find(monitors, { ownerId: ctx.auth.requirePrincipal().id }),
});

/** Everything the observe action needs, read under the caller's authority. */
export const context = app.query({
  access: "signal.monitors.run",
  args: { monitorId: s.string() },
  handler: async (ctx, { monitorId }) => {
    const m = requireFound(await ctx.db.get(monitors, monitorId), "That monitor");
    const src = requireFound(await ctx.db.get(sources, m.sourceId), "Its source");
    return { monitor: m, source: src };
  },
});

/**
 * Observe a monitor's HTTP source and record the result. An action: it talks to the
 * outside (never from a mutation), then records through `record`, as the caller.
 * Robots.txt, access refusals, the SSRF guard (DNS-checked, every redirect) and the
 * byte cap all apply; conditional GET avoids re-evaluating unchanged pages.
 */
export const observe = app.action({
  access: "signal.monitors.run",
  args: { monitorId: s.string() },
  handler: async (ctx, { monitorId }) => {
    const { monitor, source } = await ctx.runQuery(api.monitors.context, { monitorId });
    if (!/^https?:/i.test(source.locator)) fail("FAILED_PRECONDITION", "This source receives pushed content; use monitors:push.");
    const def: SourceDefinition = {
      schema: "signal.source/v1", id: source.id, tenantId: TENANT, ownerId: source.ownerId, type: source.type, locator: source.locator,
      access: { authorization: source.authorization, respectRobots: source.respectRobots }, observation: { strategy: source.strategy }, createdAt: source.createdAt,
    };
    const r = await new HttpSource(source.type === "json" ? "json" : "http_page", netPolicy()).observe({
      source: def, requestedAt: new Date().toISOString(),
      previous: { etag: monitor.etag, lastModified: monitor.lastModified, contentHash: monitor.lastContentHash },
    });
    return ctx.runMutation(api.monitors.record, {
      monitorId, observation: json(r.observation), body: r.body ? new TextDecoder().decode(r.body) : undefined,
    });
  },
});

/** Pushed content (text/json/dom sources): e.g. an overlay or an app submitting what it can see. */
export const push = app.mutation({
  access: "signal.monitors.run",
  args: { monitorId: s.string(), content: s.string({ maxLength: MAX_BODY }) },
  capability: { name: "signal.monitors.push", description: "Submit content observed by the caller for a pushed (text/json/dom) monitor and evaluate it." },
  returns: s.object({ outcome: s.string(), eventId: s.nullable(s.string()), observationId: s.string() }),
  handler: async (ctx, { monitorId, content }) => {
    const m = requireFound(await ctx.db.get(monitors, monitorId), "That monitor");
    const src = requireFound(await ctx.db.get(sources, m.sourceId), "Its source");
    if (/^https?:/i.test(src.locator)) fail("FAILED_PRECONDITION", "HTTP sources are observed by Signal (monitors:observe), not pushed.");
    const bytes = new TextEncoder().encode(content);
    const obs: Observation = {
      schema: "signal.observation/v1", observationId: newId("obs"), tenantId: TENANT, sourceId: src.id, observedAt: new Date().toISOString(),
      status: "ok", contentHash: sha256(bytes), byteLength: bytes.byteLength,
      contentType: src.type === "json" ? "application/json" : src.type === "dom" ? "text/html" : "text/plain",
      provenance: { adapter: "pushed-content@1", method: "PUSH", submittedBy: ctx.auth.requirePrincipal().id },
    };
    return recordObservation(ctx, monitorId, obs, content);
  },
});

/**
 * Record one observation and everything that follows from it, atomically:
 * observation → evidence (Files) → interpretation → evaluation (+ event) → monitor state,
 * then — only if this commits — notifications to people and the `signal.event` webhook.
 * Idempotent per observationId: a replay returns the recorded outcome and sends nothing.
 */
export const record = app.mutation({
  access: "signal.monitors.run",
  args: { monitorId: s.string(), observation: s.string(), body: s.optional(s.string({ maxLength: MAX_BODY })) },
  returns: s.object({ outcome: s.string(), eventId: s.nullable(s.string()), observationId: s.string() }),
  handler: async (ctx, { monitorId, observation, body }) => {
    const obs = parse<Observation>(observation);
    if (obs.schema !== "signal.observation/v1" || typeof obs.observationId !== "string") fail("INVALID_ARGUMENT", "Not a signal.observation/v1 record.");
    const m = requireFound(await ctx.db.get(monitors, monitorId), "That monitor");
    if (obs.sourceId !== m.sourceId) fail("INVALID_ARGUMENT", "Observation is for a different source.");
    if (obs.status === "ok" && (body === undefined || sha256(new TextEncoder().encode(body)) !== obs.contentHash)) {
      fail("INVALID_ARGUMENT", "Body is missing or does not match the observation's contentHash.");
    }
    return recordObservation(ctx, monitorId, obs, body);
  },
});

type Ctx = Parameters<Parameters<typeof app.mutation>[0]["handler"]>[0];

async function recordObservation(ctx: Ctx, monitorId: string, obs: Observation, body: string | undefined) {
  const [replay] = await ctx.db.find(evaluations, { observationId: obs.observationId });
  if (replay) {
    // Callers address events by record id; the evaluation stores the content-derived eventId.
    const [ev] = replay.eventId ? await ctx.db.find(events, { eventId: replay.eventId }) : [];
    return { outcome: replay.outcome, eventId: ev?.id ?? null, observationId: obs.observationId };
  }
  const [seenObs] = await ctx.db.find(observations, { observationId: obs.observationId });
  if (seenObs) return { outcome: `observation_${seenObs.status}`, eventId: null, observationId: obs.observationId };

  const m = requireFound(await ctx.db.get(monitors, monitorId), "That monitor");
  if (!m.enabled) fail("FAILED_PRECONDITION", "Monitor is disabled.");
  const src = requireFound(await ctx.db.get(sources, m.sourceId), "Its source");
  const owner = m.ownerId;

  // Evidence first: the exact bytes observed, content-addressed by hash in metadata.
  if (obs.status === "ok" && body !== undefined) {
    const f = await ctx.services.files.upload({
      name: `${obs.observationId}.raw`, contentType: obs.contentType ?? "text/plain", content: body,
      metadata: { kind: "signal.evidence.raw", observationId: obs.observationId, sha256: obs.contentHash! },
    });
    obs.evidenceRef = `files:${f.id}`;
  }
  await ctx.db.insert(observations, {
    observationId: obs.observationId, sourceId: obs.sourceId, monitorId, observedAt: obs.observedAt, status: obs.status,
    ...(obs.evidenceRef ? { evidenceRef: obs.evidenceRef } : {}), ...(obs.contentHash ? { contentHash: obs.contentHash } : {}),
    ...(obs.contentType ? { contentType: obs.contentType } : {}), ...(obs.byteLength !== undefined ? { byteLength: obs.byteLength } : {}),
    provenance: json(obs.provenance), ...(obs.error ? { error: json(obs.error) } : {}), ownerId: owner,
  });
  if (obs.status !== "ok" || body === undefined) {
    return { outcome: `observation_${obs.status}`, eventId: null, observationId: obs.observationId };
  }

  const [c] = await ctx.db.find(criteria, { criteriaId: m.criteriaId, version: m.criteriaVersion });
  const crit = parseCriteria(requireFound(c, "Its criteria").definition);
  const normalizedText = normalizeContent(body, obs.contentType);
  const nf = await ctx.services.files.upload({
    name: `${obs.observationId}.txt`, contentType: "text/plain", content: normalizedText,
    metadata: { kind: "signal.evidence.normalized", observationId: obs.observationId, sha256: sha256(normalizedText) },
  });
  const [prevRec] = m.lastInterpretationId ? await ctx.db.find(interpretations, { interpretationId: m.lastInterpretationId }) : [];
  const now = new Date().toISOString();
  const out = runCycle({
    tenantId: TENANT, monitor: { id: monitorId, ownerId: owner }, source: { id: src.id, locator: src.locator }, criteria: crit,
    observation: obs, rawBody: body, normalizedText, normalizedTextRef: `files:${nf.id}`,
    state: { matched: m.matched, lastDedupKey: m.lastDedupKey, lastEventAt: m.lastEventAt, lastInterpretationId: m.lastInterpretationId, lastContentHash: m.lastContentHash },
    previous: prevRec ? parse<Interpretation>(prevRec.body) : undefined, decoders: signalDecoders(), now,
  });

  await ctx.db.insert(interpretations, { interpretationId: out.interpretation.interpretationId, observationId: obs.observationId, body: json(out.interpretation), ownerId: owner });
  const seq = await ctx.db.sequence(`signal.evaluations:${monitorId}`);
  await ctx.db.insert(evaluations, {
    evaluationId: out.evaluation.evaluationId, monitorId, observationId: obs.observationId, seq, evaluatedAt: now,
    matched: out.evaluation.matched, outcome: out.evaluation.outcome, ...(out.event ? { eventId: out.event.eventId } : {}),
    body: json(out.evaluation), ownerId: owner,
  });
  let eventRecordId: string | null = null;
  if (out.event) {
    eventRecordId = await ctx.db.insert(events, {
      eventId: out.event.eventId, monitorId, sourceLocator: src.locator, severity: out.event.severity, occurredAt: now, body: json(out.event), ownerId: owner,
    });
  }
  // The read of `m` above makes this write conflict with any concurrent record for this monitor.
  const n = out.nextState;
  await ctx.db.patch(monitors, monitorId, {
    matched: n.matched, lastDedupKey: n.lastDedupKey, lastEventAt: n.lastEventAt, lastInterpretationId: n.lastInterpretationId,
    lastContentHash: n.lastContentHash, etag: obs.provenance.headers?.etag, lastModified: obs.provenance.headers?.["last-modified"],
  });

  if (out.event) {
    const e = out.event;
    const what = e.matched.map((l) => {
      const name = (/field\(([^)]+)\)/.exec(l.path) ?? [])[1] ?? l.op;
      const prev = l.previous !== undefined && l.previous !== null ? ` (was ${String(l.previous)})` : "";
      return `${name}: ${typeof l.actual === "object" ? JSON.stringify(l.actual) : String(l.actual)}${prev}`;
    }).join("; ");
    for (const recipient of m.notify) {
      ctx.afterCommit.notifications.send({
        recipient, type: "signal.criteria_matched", title: e.criteriaName.slice(0, 200), body: `${what} — ${e.sourceLocator}`.slice(0, 2000),
        data: { eventRecordId, eventId: e.eventId, monitorId, severity: e.severity, sourceLocator: e.sourceLocator, evidenceRef: e.evidence.observationRef },
        idempotencyKey: `signal.event:${e.eventId}:${recipient}`,
      });
    }
    if (m.emitWebhook) ctx.afterCommit.webhooks.emit("signal.event", { ...e, eventRecordId });
  }
  return { outcome: out.evaluation.outcome, eventId: eventRecordId, observationId: obs.observationId };
}

/** Evaluation history for a monitor, in order, including non-matches and suppressions. */
export const history = app.query({
  access: "signal.monitors.read",
  args: { monitorId: s.string() },
  handler: async (ctx, { monitorId }) => {
    requireFound(await ctx.db.get(monitors, monitorId), "That monitor");
    const rows = await ctx.db.find(evaluations, { monitorId }, { orderBy: [{ field: "seq", direction: "asc" }] });
    return rows.map((r) => ({ seq: r.seq, outcome: r.outcome, matched: r.matched, eventId: r.eventId ?? null, evaluation: parse(r.body) }));
  },
});
