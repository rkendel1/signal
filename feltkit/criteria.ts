import { fail, s } from "@feltdb/feltkit";
import { app, criteria, criteriaVersions, entities, findings, observations, sources } from "./app.js";
import { EvidenceLoader, loadAreas, evaluateEntities, json, loadCriteria, parse, requireFound, storedObservation, type Ctx } from "./_store.js";
import { criteriaAttrs, validateCriteria, type CriteriaDefinition } from "../lib/engine/criteria.ts";
import { coverage } from "../lib/engine/coverage.ts";
import { evaluate } from "../lib/engine/evaluate.ts";

/**
 * Criteria: what the user cares about. Explicit JSON (signal.criteria/v2), validated, versioned immutably.
 * Saving a version re-evaluates every entity of its type at once; findings that no longer apply are
 * superseded, never silently deleted. Signal never changes a criterion's meaning on its own.
 */

function parseDef(text: string): CriteriaDefinition {
  try { return validateCriteria(JSON.parse(text)); } catch (e) { return fail("INVALID_ARGUMENT", `Invalid criteria: ${(e as Error).message}`); }
}

async function allEntityIds(ctx: Ctx, ownerId: string, type: string): Promise<string[]> {
  return (await ctx.db.find(entities, { ownerId, type })).map((e: any) => e.id);
}

/** Create criteria (criteriaId omitted) or publish its next version. Evaluates existing information immediately. */
export const save = app.mutation({
  access: "signal.write",
  args: { criteriaId: s.optional(s.string()), definition: s.string({ maxLength: 64_000 }), notify: s.optional(s.array(s.string(), { maxItems: 20 })) },
  handler: async (ctx, a) => {
    const ownerId = ctx.auth.requirePrincipal().id;
    const def = parseDef(a.definition);
    const notify = a.notify ?? [ownerId];
    if (notify.some((r) => r !== ownerId) && !ctx.auth.has("signal.admin")) fail("FORBIDDEN", "Criteria may only notify their owner.");
    const now = new Date().toISOString();
    let id = a.criteriaId, version = 1;
    if (id) {
      const c = requireFound(await ctx.db.get(criteria, id), "That criteria");
      if (c.removed) fail("FAILED_PRECONDITION", "That criteria was removed.");
      if (c.entityType !== def.entityType) fail("INVALID_ARGUMENT", `This criteria evaluates ${c.entityType}; create new criteria for ${def.entityType}.`);
      version = c.activeVersion + 1;
      await ctx.db.patch(criteria, id, { name: def.name, activeVersion: version, notify, updatedAt: now });
    } else {
      id = await ctx.db.insert(criteria, { name: def.name, entityType: def.entityType, activeVersion: 1, enabled: true, removed: false, notify, createdAt: now, updatedAt: now, ownerId });
    }
    await ctx.db.insert(criteriaVersions, { criteriaId: id!, version, definition: json(def), createdAt: now, ownerId });
    const c = requireFound(await ctx.db.get(criteria, id!), "That criteria");
    const run = c.enabled ? await evaluateEntities(ctx, ownerId, await allEntityIds(ctx, ownerId, def.entityType), { kind: "criteria", ref: `${id}@v${version}`, label: `criteria "${def.name}" v${version}` }, { onlyCriteriaId: id! }) : null;
    return { criteriaId: id!, version, run };
  },
});

/** Pause or resume monitoring. Resuming re-evaluates everything (the world may have changed meanwhile). */
export const setEnabled = app.mutation({
  access: "signal.write",
  args: { criteriaId: s.string(), enabled: s.boolean() },
  handler: async (ctx, a) => {
    const c = requireFound(await ctx.db.get(criteria, a.criteriaId), "That criteria");
    await ctx.db.patch(criteria, c.id, { enabled: a.enabled, updatedAt: new Date().toISOString() });
    if (!a.enabled) return { enabled: false, run: null };
    const run = await evaluateEntities(ctx, c.ownerId, await allEntityIds(ctx, c.ownerId, c.entityType), { kind: "criteria", ref: `${c.id}@v${c.activeVersion}`, label: `criteria "${c.name}" resumed` }, { onlyCriteriaId: c.id });
    return { enabled: true, run };
  },
});

/** Remove: open findings are superseded (history kept). The versions stay, because findings cite them. */
export const remove = app.mutation({
  access: "signal.write",
  args: { criteriaId: s.string() },
  handler: async (ctx, a) => {
    const c = requireFound(await ctx.db.get(criteria, a.criteriaId), "That criteria");
    const open = await ctx.db.find(findings, { criteriaId: c.id, status: "open" });
    const now = new Date().toISOString();
    for (const f of open) await ctx.db.patch(findings, f.id, { status: "superseded", change: "superseded", lastChangedAt: now, summary: `Criteria "${c.name}" was removed` });
    await ctx.db.patch(criteria, c.id, { removed: true, enabled: false, updatedAt: now });
    return { removed: true, closed: open.length };
  },
});

export const list = app.query({
  access: "signal.read",
  handler: async (ctx) => {
    const ownerId = ctx.auth.requirePrincipal().id;
    const cs = (await ctx.db.find(criteria, { ownerId })).filter((c) => !c.removed);
    const out = [];
    for (const c of cs) {
      const fs = await ctx.db.find(findings, { criteriaId: c.id, status: "open" });
      const [v] = await ctx.db.find(criteriaVersions, { criteriaId: c.id, version: c.activeVersion });
      out.push({ id: c.id, name: c.name, entityType: c.entityType, version: c.activeVersion, enabled: c.enabled, updatedAt: c.updatedAt, open: fs.length, matches: fs.filter((f) => f.qualification === "match").length, possible: fs.filter((f) => f.qualification === "possible").length, definition: v ? parse(v.definition) : null });
    }
    return out;
  },
});

export const get = app.query({
  access: "signal.read",
  args: { criteriaId: s.string() },
  handler: async (ctx, { criteriaId }) => {
    const c = requireFound(await ctx.db.get(criteria, criteriaId), "That criteria");
    const versions = (await ctx.db.find(criteriaVersions, { criteriaId })).sort((a, b) => b.version - a.version);
    return { id: c.id, name: c.name, entityType: c.entityType, version: c.activeVersion, enabled: c.enabled, removed: c.removed, notify: c.notify, versions: versions.map((v) => ({ version: v.version, createdAt: v.createdAt, definition: parse(v.definition) })), reads: criteriaAttrs(parse(versions[0].definition)) };
  },
});

/** Evaluate a draft definition over current information without saving anything: the effect of a change, before making it. */
export const preview = app.query({
  access: "signal.read",
  args: { definition: s.string({ maxLength: 64_000 }), criteriaId: s.optional(s.string()) },
  handler: async (ctx, a) => {
    const ownerId = ctx.auth.requirePrincipal().id;
    const def = parseDef(a.definition);
    const t0 = performance.now();
    const ents = await ctx.db.find(entities, { ownerId, type: def.entityType });
    const now = new Date().toISOString();
    const counts: Record<string, number> = { match: 0, possible: 0, non_match: 0, excluded: 0, insufficient: 0 };
    const top: Array<{ entityId: string; label: string | null; qualification: string; score: number; confidence: number; summary: string }> = [];
    const loader = new EvidenceLoader(ctx);
    await loader.preload(ownerId, ents.map((e) => e.id));
    const areas = await loadAreas(ctx, ownerId, [def]);
    for (const e of ents) {
      const ev = await loader.evidence(e.id);
      if (!ev || !ev.records.some((r) => r.current)) continue;
      const o = evaluate(ev, def, now, areas);
      counts[o.qualification]++;
      if (o.qualification === "match" || o.qualification === "possible") top.push({ entityId: e.id, label: e.label ?? null, qualification: o.qualification, score: o.score, confidence: o.confidence, summary: o.summary });
    }
    top.sort((x, y) => y.score * y.confidence - x.score * x.confidence);
    // What would change for the saved version's open findings.
    let delta = null;
    if (a.criteriaId) {
      const open = await ctx.db.find(findings, { criteriaId: a.criteriaId, status: "open" });
      const would = new Set(top.map((t) => t.entityId));
      delta = { wouldClose: open.filter((f) => !would.has(f.entityId)).length, wouldOpen: top.filter((t) => !open.some((f) => f.entityId === t.entityId)).length, wouldStay: open.filter((f) => would.has(f.entityId)).length };
    }
    return { entities: ents.length, counts, top: top.slice(0, 25), delta, durationMs: Math.round(performance.now() - t0) };
  },
});

/** The attributes available for an entity type across connected sources: what criteria can be written against. */
export const attributes = app.query({
  access: "signal.read",
  args: { entityType: s.optional(s.string()) },
  handler: async (ctx, a) => {
    const ownerId = ctx.auth.requirePrincipal().id;
    const srcs = (await ctx.db.find(sources, { ownerId })).filter((x) => x.status !== "removed" && (!a.entityType || x.entityType === a.entityType));
    const types = [...new Set((await ctx.db.find(sources, { ownerId })).filter((x) => x.status !== "removed").map((x) => x.entityType))].sort();
    const attrs = new Map<string, { attr: string; kinds: Set<string>; min?: number; max?: number; samples: string[]; sources: Array<{ id: string; name: string; present: number; of: number }> }>();
    for (const src of srcs) {
      const obs = (await ctx.db.find(observations, { sourceId: src.id, status: "current" })).map(storedObservation);
      for (const c of coverage(obs, []).attributes) {
        const e = attrs.get(c.attr) ?? attrs.set(c.attr, { attr: c.attr, kinds: new Set(), samples: [], sources: [] }).get(c.attr)!;
        c.types.forEach((t) => e.kinds.add(t));
        if (c.min !== undefined) { e.min = Math.min(e.min ?? c.min, c.min); e.max = Math.max(e.max ?? c.max!, c.max!); }
        e.samples = [...new Set([...e.samples, ...c.samples])].slice(0, 5);
        e.sources.push({ id: src.id, name: src.name, present: c.present, of: obs.length });
      }
    }
    return { entityTypes: types, attributes: [...attrs.values()].map((e) => ({ ...e, kinds: [...e.kinds] })).sort((x, y) => x.attr.localeCompare(y.attr)) };
  },
});

/** Re-evaluate everything for this criteria now (e.g. after a long pause). */
export const reevaluate = app.mutation({
  access: "signal.write",
  args: { criteriaId: s.string() },
  handler: async (ctx, a) => {
    const c = requireFound(await ctx.db.get(criteria, a.criteriaId), "That criteria");
    const [crit] = await loadCriteria(ctx, c.ownerId, c.id);
    return evaluateEntities(ctx, c.ownerId, await allEntityIds(ctx, c.ownerId, c.entityType), { kind: "criteria", ref: `${c.id}@v${c.activeVersion}`, label: `criteria "${c.name}" re-evaluated on request` }, { criteriaOverride: [crit] });
  },
});
