import { fail, s } from "@feltdb/feltkit";
import { app, entities, findings, ingestions, links, observations, sources } from "./app.js";
import { parse, relink, requireFound, storedObservation } from "./_store.js";
import { emptyKeys } from "../lib/engine/identity.ts";
import { normalizeAddress } from "../lib/engine/mapping.ts";
import type { EntityKeys, Value } from "../lib/engine/types.ts";

/**
 * Entities: the things several sources describe. Each source's records stay separate and inspectable; the
 * entity view lines them up attribute by attribute so agreement, conflict and gaps are visible.
 */

export const list = app.query({
  access: "signal.read",
  args: { type: s.optional(s.string()), search: s.optional(s.string()), limit: s.optional(s.integer()) },
  handler: async (ctx, a) => {
    const ownerId = ctx.auth.requirePrincipal().id;
    let es = a.type ? await ctx.db.find(entities, { ownerId, type: a.type }) : await ctx.db.find(entities, { ownerId });
    if (a.search) { const q = a.search.toLowerCase(); es = es.filter((e) => (e.label ?? "").toLowerCase().includes(q)); }
    const fs = await ctx.db.find(findings, { ownerId, status: "open" });
    return es.filter((e) => e.records > 0).slice(0, a.limit ?? 500).map((e) => ({ id: e.id, type: e.type, label: e.label ?? null, records: e.records, sources: parse<EntityKeys>(e.keys, emptyKeys()).sources.length, lat: e.lat ?? null, lng: e.lng ?? null, openFindings: fs.filter((f) => f.entityId === e.id).length }));
  },
});

const same = (a: Value, b: Value) => JSON.stringify(a) === JSON.stringify(b) || (typeof a === "object" && a && typeof b === "object" && b && "amount" in a && "amount" in b && a.amount === b.amount);

export const get = app.query({
  access: "signal.read",
  args: { entityId: s.string() },
  handler: async (ctx, { entityId }) => {
    const e = requireFound(await ctx.db.get(entities, entityId), "That entity");
    const ls = await ctx.db.find(links, { entityId });
    const records: any[] = [];
    for (const l of ls) {
      const src = await ctx.db.get(sources, l.sourceId);
      const versions = (await ctx.db.find(observations, { sourceId: l.sourceId, recordKey: l.recordKey })).map(storedObservation).sort((x, y) => y.version - x.version);
      const ings = new Map<string, any>();
      for (const v of versions) if (!ings.has(v.ingestionId)) { const [i] = await ctx.db.find(ingestions, { ingestionId: v.ingestionId }); ings.set(v.ingestionId, i ? { at: i.at, trigger: i.trigger, rawHash: i.rawHash ?? null } : null); }
      records.push({
        source: src ? { id: src.id, name: src.name, kind: src.kind, status: src.status, synthetic: src.synthetic, staleAfterDays: src.staleAfterDays ?? null, lastSuccessAt: src.lastSuccessAt ?? null } : null,
        recordKey: l.recordKey,
        link: { id: l.id, status: l.status, basis: l.basis, confidence: l.confidence, reason: l.reason, options: parse(l.options, []), decidedBy: l.decidedBy, at: l.at },
        current: versions.find((v) => v.status === "current") ?? null,
        versions: versions.map((v) => ({ ...v, ingestion: ings.get(v.ingestionId) })),
      });
    }
    // Attribute × source matrix, current values only.
    const attrs = [...new Set(records.flatMap((r) => Object.keys(r.current?.attributes ?? {})))].sort();
    const matrix = attrs.map((attr) => {
      const cells = records.map((r) => (r.current?.attributes[attr] ? { sourceName: r.source?.name ?? "?", recordKey: r.recordKey, ...r.current.attributes[attr] } : null));
      const vals = cells.filter((c): c is NonNullable<typeof c> => !!c);
      // Addresses are compared as normalized street addresses: "10 Alder Street, City" and "10 Alder St" agree.
      const eq = attr === "address" ? (a: Value, b: Value) => same(a, b) || (typeof a === "string" && typeof b === "string" && normalizeAddress(a) !== null && normalizeAddress(a) === normalizeAddress(b)) : same;
      return { attr, cells, agreement: vals.length < 2 ? "single" : vals.every((v) => eq(v.value, vals[0].value)) ? "agree" : "conflict" };
    });
    const fs = await ctx.db.find(findings, { entityId });
    return {
      entity: { id: e.id, type: e.type, label: e.label ?? null, lat: e.lat ?? null, lng: e.lng ?? null, keys: parse(e.keys, emptyKeys()), records: e.records },
      records, matrix,
      findings: fs.map((f) => ({ id: f.id, criteriaId: f.criteriaId, status: f.status, change: f.change, qualification: f.qualification, summary: f.summary })),
    };
  },
});

/** Records waiting for a person: ambiguous and conflicting identity decisions. */
export const identityQueue = app.query({
  access: "signal.read",
  handler: async (ctx) => {
    const ownerId = ctx.auth.requirePrincipal().id;
    const out = [];
    for (const status of ["ambiguous", "conflict"] as const) {
      for (const l of await ctx.db.find(links, { ownerId, status })) {
        const [cur] = await ctx.db.find(observations, { sourceId: l.sourceId, recordKey: l.recordKey, status: "current" });
        if (!cur) continue;
        const src = await ctx.db.get(sources, l.sourceId);
        const o = storedObservation(cur);
        out.push({ linkId: l.id, status: l.status, reason: l.reason, sourceId: l.sourceId, sourceName: src?.name ?? "?", recordKey: l.recordKey, entityId: l.entityId, label: o.identity.address ?? o.identity.name ?? o.recordKey, options: parse(l.options, []) });
      }
    }
    return out;
  },
});

/** A person's identity decision: this source record IS that entity. */
export const assign = app.mutation({
  access: "signal.write",
  args: { sourceId: s.string(), recordKey: s.string(), entityId: s.string() },
  handler: async (ctx, a) => {
    const [l] = await ctx.db.find(links, { sourceId: a.sourceId, recordKey: a.recordKey });
    const link = requireFound(l, "That record");
    const target = requireFound(await ctx.db.get(entities, a.entityId), "That entity");
    if (target.ownerId !== link.ownerId) fail("FORBIDDEN", "not the owner");
    if (link.entityId === a.entityId && link.decidedBy === "user") return { unchanged: true };
    return relink(ctx, link, a.entityId, link.ownerId, `identity confirmed by a person: ${a.recordKey} is ${target.label ?? target.id}`);
  },
});

/** A person's identity decision: this source record is NOT the entity it was linked to. */
export const separate = app.mutation({
  access: "signal.write",
  args: { sourceId: s.string(), recordKey: s.string() },
  handler: async (ctx, a) => {
    const [l] = await ctx.db.find(links, { sourceId: a.sourceId, recordKey: a.recordKey });
    const link = requireFound(l, "That record");
    const others = (await ctx.db.find(links, { entityId: link.entityId })).filter((x) => x.id !== link.id);
    if (!others.length) {
      await ctx.db.patch(links, link.id, { status: "manual", basis: "user", confidence: 1, reason: "kept separate by a person", decidedBy: "user", at: new Date().toISOString() });
      return { unchanged: true };
    }
    return relink(ctx, link, null, link.ownerId, `identity corrected by a person: ${a.recordKey} is a different thing`);
  },
});
