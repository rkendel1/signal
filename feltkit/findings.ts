import { fail, s } from "@feltdb/feltkit";
import { app, criteria, criteriaVersions, entities, findingEvents, findings, ingestions, links, observations, runs, sources } from "./app.js";
import { parse, requireFound, storedObservation } from "./_store.js";
import { priority } from "../lib/engine/lifecycle.ts";

/**
 * Findings: what deserves attention, in priority order, each traceable to criteria and evidence.
 * Acknowledging or dismissing is the user's explicit action; detection itself never acts.
 */

const Status = s.enum(["open", "closed", "all"] as const);

const Summary = s.object({
  id: s.string(), criteriaId: s.string(), criteriaName: s.string(), entityId: s.string(), entityLabel: s.nullable(s.string()),
  status: s.string(), change: s.string(), qualification: s.string(), summary: s.string(), score: s.number(), confidence: s.number(),
  priority: s.number(), priorityWhy: s.string(), hasConflict: s.boolean(), hasStale: s.boolean(), hasMissing: s.boolean(), synthetic: s.boolean(),
  sourceCount: s.integer(), sourceIssues: s.array(s.string()), firstDetectedAt: s.string(), lastChangedAt: s.string(), lastEvaluatedAt: s.string(),
  acknowledged: s.boolean(), dismissed: s.boolean(), lat: s.nullable(s.number()), lng: s.nullable(s.number()), criteriaVersion: s.integer(),
});

export const list = app.query({
  access: "signal.read",
  args: { status: s.optional(Status), criteriaId: s.optional(s.string()), qualification: s.optional(s.enum(["match", "possible"] as const)), includeDismissed: s.optional(s.boolean()), limit: s.optional(s.integer()) },
  returns: s.array(Summary),
  capability: { name: "signal.findings.list", description: "The caller's findings in priority order, with why each was surfaced, its confidence, and whether its evidence is conflicting, stale or missing." },
  handler: async (ctx, a) => {
    const ownerId = ctx.auth.requirePrincipal().id;
    const status = a.status ?? "open";
    let rows = a.criteriaId ? await ctx.db.find(findings, { criteriaId: a.criteriaId }) : status === "open" ? await ctx.db.find(findings, { ownerId, status: "open" }) : await ctx.db.find(findings, { ownerId });
    rows = rows.filter((f) => f.ownerId === ownerId && (status === "all" || (status === "open" ? f.status === "open" : f.status !== "open")) && (!a.qualification || f.qualification === a.qualification) && (a.includeDismissed || !f.dismissedAt));
    const now = new Date().toISOString();
    const crit = new Map<string, any>(), ents = new Map<string, any>();
    const srcs = (await ctx.db.find(sources, { ownerId })).filter((x) => x.status === "unavailable" || x.status === "paused" || x.status === "removed");
    const out = [];
    for (const f of rows) {
      if (!crit.has(f.criteriaId)) crit.set(f.criteriaId, await ctx.db.get(criteria, f.criteriaId));
      if (!ents.has(f.entityId)) ents.set(f.entityId, await ctx.db.get(entities, f.entityId));
      const e = ents.get(f.entityId);
      const p = priority({ score: f.score, confidence: f.confidence, lastChangedAt: f.lastChangedAt, status: f.status, acknowledged: Boolean(f.acknowledgedAt) }, now);
      const used = new Set(parse<{ sources: string[] }>(f.explanation).sources);
      out.push({
        id: f.id, criteriaId: f.criteriaId, criteriaName: crit.get(f.criteriaId)?.name ?? "(removed)", entityId: f.entityId, entityLabel: f.entityLabel ?? null,
        status: f.status, change: f.change, qualification: f.qualification, summary: f.summary, score: f.score, confidence: f.confidence,
        priority: p.value, priorityWhy: p.why, hasConflict: f.hasConflict, hasStale: f.hasStale, hasMissing: f.hasMissing, synthetic: f.synthetic, sourceCount: f.sourceCount,
        sourceIssues: srcs.filter((x) => used.has(x.name)).map((x) => `${x.name} is ${x.status}${x.statusReason ? ` (${x.statusReason})` : ""}`),
        firstDetectedAt: f.firstDetectedAt, lastChangedAt: f.lastChangedAt, lastEvaluatedAt: f.lastEvaluatedAt,
        acknowledged: Boolean(f.acknowledgedAt), dismissed: Boolean(f.dismissedAt), lat: e?.lat ?? null, lng: e?.lng ?? null, criteriaVersion: f.criteriaVersion,
      });
    }
    out.sort((x, y) => y.priority - x.priority || y.lastChangedAt.localeCompare(x.lastChangedAt));
    return out.slice(0, a.limit ?? 500);
  },
});

/** The complete trail behind one finding: criteria version, explanation, every observation version used, source state, history. */
export const get = app.query({
  access: "signal.read",
  args: { findingId: s.string() },
  handler: async (ctx, { findingId }) => {
    const f = requireFound(await ctx.db.get(findings, findingId), "That finding");
    const c = await ctx.db.get(criteria, f.criteriaId);
    const [v] = await ctx.db.find(criteriaVersions, { criteriaId: f.criteriaId, version: f.criteriaVersion });
    const ent = await ctx.db.get(entities, f.entityId);
    const events = await ctx.db.find(findingEvents, { findingId }, { orderBy: [{ field: "seq", direction: "asc" }] });
    const explanation = parse<Record<string, unknown>>(f.explanation);
    const ids = new Set<string>([...(explanation.evidenceIds as string[]), ...events.flatMap((e) => parse<string[]>(e.evidenceIds))]);
    const evidence = [];
    const srcCache = new Map<string, any>();
    for (const id of ids) {
      const [o] = await ctx.db.find(observations, { observationId: id });
      if (!o) continue;
      if (!srcCache.has(o.sourceId)) srcCache.set(o.sourceId, await ctx.db.get(sources, o.sourceId));
      const src = srcCache.get(o.sourceId);
      const [ingRec] = await ctx.db.find(ingestions, { ingestionId: o.ingestionId });
      evidence.push({ ...storedObservation(o), source: { id: src.id, name: src.name, kind: src.kind, status: src.status, statusReason: src.statusReason ?? null, synthetic: src.synthetic, lastSuccessAt: src.lastSuccessAt ?? null }, ingestion: ingRec ? { at: ingRec.at, trigger: ingRec.trigger, rawHash: ingRec.rawHash ?? null, provenance: parse(ingRec.provenance) } : null });
    }
    const runIds = [...new Set(events.map((e) => e.runId))];
    const runRecs = (await ctx.db.find(runs, { ownerId: f.ownerId })).filter((r) => runIds.includes(parse<{ runId: string }>(r.cause).runId));
    return {
      finding: { id: f.id, status: f.status, change: f.change, qualification: f.qualification, summary: f.summary, score: f.score, confidence: f.confidence, firstDetectedAt: f.firstDetectedAt, lastChangedAt: f.lastChangedAt, lastEvaluatedAt: f.lastEvaluatedAt, acknowledgedAt: f.acknowledgedAt ?? null, dismissedAt: f.dismissedAt ?? null, dismissReason: f.dismissReason ?? null, synthetic: f.synthetic, criteriaVersion: f.criteriaVersion },
      criteria: { id: f.criteriaId, name: c?.name ?? "(removed)", activeVersion: c?.activeVersion ?? null, enabled: c?.enabled ?? false, definition: v ? parse(v.definition) : null },
      entity: ent ? { id: ent.id, type: ent.type, label: ent.label ?? null, lat: ent.lat ?? null, lng: ent.lng ?? null, records: ent.records } : null,
      explanation,
      evidence: evidence.sort((a, b) => a.source.name.localeCompare(b.source.name) || a.recordKey.localeCompare(b.recordKey) || a.version - b.version),
      history: events.map((e) => ({ seq: e.seq, at: e.at, kind: e.kind, criteriaVersion: e.criteriaVersion, cause: parse(e.cause), reason: e.reason, diff: parse(e.diff), evidenceIds: parse(e.evidenceIds), qualification: e.qualification ?? null })),
      runs: runRecs.map((r) => ({ seq: r.seq, at: r.at, cause: parse(r.cause), entities: r.entities, evaluations: r.evaluations, durationMs: r.durationMs })),
    };
  },
});

export const acknowledge = app.mutation({
  access: "signal.write",
  args: { findingId: s.string(), acknowledged: s.optional(s.boolean()) },
  handler: async (ctx, a) => {
    const f = requireFound(await ctx.db.get(findings, a.findingId), "That finding");
    const on = a.acknowledged ?? true;
    await ctx.db.patch(findings, f.id, { acknowledgedAt: on ? new Date().toISOString() : undefined });
    return { acknowledged: on };
  },
});

/** "Not relevant to me": hidden from the feed, kept with its reason. It reappears if it changes meaningfully. */
export const dismiss = app.mutation({
  access: "signal.write",
  args: { findingId: s.string(), reason: s.optional(s.string({ maxLength: 500 })), dismissed: s.optional(s.boolean()) },
  handler: async (ctx, a) => {
    const f = requireFound(await ctx.db.get(findings, a.findingId), "That finding");
    if (a.dismissed === false) { await ctx.db.patch(findings, f.id, { dismissedAt: undefined, dismissReason: undefined }); return { dismissed: false }; }
    if (!a.reason?.trim()) fail("INVALID_ARGUMENT", "Say why it is not relevant; the reason is kept with the finding.");
    await ctx.db.patch(findings, f.id, { dismissedAt: new Date().toISOString(), dismissReason: a.reason });
    return { dismissed: true };
  },
});

/** Finding history across all criteria: a timeline of what changed and why. */
export const timeline = app.query({
  access: "signal.read",
  args: { limit: s.optional(s.integer()) },
  handler: async (ctx, a) => {
    const ownerId = ctx.auth.requirePrincipal().id;
    const evs = await ctx.db.find(findingEvents, { ownerId }, { orderBy: [{ field: "at", direction: "desc" }], limit: a.limit ?? 200 });
    const fs = new Map<string, any>();
    const out = [];
    for (const e of evs) {
      if (e.kind === "persistent") continue;
      if (!fs.has(e.findingId)) fs.set(e.findingId, await ctx.db.get(findings, e.findingId));
      const f = fs.get(e.findingId);
      const c = f ? await ctx.db.get(criteria, f.criteriaId) : null;
      out.push({ at: e.at, kind: e.kind, findingId: e.findingId, entityLabel: f?.entityLabel ?? null, criteriaName: c?.name ?? null, reason: e.reason, diff: parse(e.diff), cause: parse(e.cause), qualification: e.qualification ?? null });
    }
    return out;
  },
});

/** Findings whose entities include these records of a source: "what does this captured page affect?" */
export const forRecords = app.query({
  access: "signal.read",
  args: { sourceId: s.string(), recordKeys: s.array(s.string(), { maxItems: 2000 }) },
  handler: async (ctx, a) => {
    const want = new Set(a.recordKeys);
    const ls = (await ctx.db.find(links, { sourceId: a.sourceId })).filter((l) => want.has(l.recordKey));
    const out = [];
    for (const l of ls) for (const f of await ctx.db.find(findings, { entityId: l.entityId })) {
      if (f.status !== "open" || f.dismissedAt) continue;
      const c = await ctx.db.get(criteria, f.criteriaId);
      out.push({ id: f.id, recordKey: l.recordKey, entityLabel: f.entityLabel ?? null, criteriaName: c?.name ?? "", qualification: f.qualification, change: f.change, summary: f.summary, sourceCount: f.sourceCount, lastChangedAt: f.lastChangedAt });
    }
    return out.sort((x, y) => (x.qualification === y.qualification ? y.lastChangedAt.localeCompare(x.lastChangedAt) : x.qualification === "match" ? -1 : 1));
  },
});
