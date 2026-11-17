import { s } from "@feltdb/feltkit";
import { app, entities, findings, ingestions, runs, sources } from "./app.js";
import { addNotice, evaluateEntities, parse } from "./_store.js";

/**
 * Time-driven re-evaluation. Nothing in a source changes when evidence merely ages, so freshness is checked
 * by a sweep: a mutation (no outbound I/O), which a FeltKit schedule can run as the `signal.sweep` job.
 */
export const sweep = app.mutation({
  access: "signal.write",
  args: { all: s.optional(s.boolean()) },
  handler: async (ctx, a) => {
    const ownerId = ctx.auth.requirePrincipal().id;
    const ids = a.all
      ? (await ctx.db.find(entities, { ownerId })).map((e) => e.id)
      : [...new Set((await ctx.db.find(findings, { ownerId, status: "open" })).map((f) => f.entityId))];
    // Sources that have gone quiet past their freshness rule: one notice per stale period.
    const now = new Date().toISOString();
    for (const src of await ctx.db.find(sources, { ownerId })) {
      if (src.status === "removed" || !src.staleAfterDays || !src.lastSuccessAt || src.refreshMode === "capture" || src.refreshMode === "push") continue;
      if ((Date.now() - Date.parse(src.lastSuccessAt)) / 86_400_000 > src.staleAfterDays) await addNotice(ctx, { kind: "source_stale", severity: "warning", priority: 40, title: `Stale: ${src.name}`, body: `No successful refresh for more than ${src.staleAfterDays} days; its evidence no longer counts.`, sourceId: src.id, dedupKey: `source:${src.id}:stale:${src.lastSuccessAt}` }, ownerId, now);
    }
    return evaluateEntities(ctx, ownerId, ids, { kind: "time", ref: now, label: "freshness sweep" });
  },
});

/** Evaluation runs and source refreshes, newest first: what Signal did and why. */
export const activity = app.query({
  access: "signal.read",
  args: { limit: s.optional(s.integer()) },
  handler: async (ctx, a) => {
    const ownerId = ctx.auth.requirePrincipal().id;
    const limit = a.limit ?? 50;
    const rs = await ctx.db.find(runs, { ownerId }, { orderBy: [{ field: "seq", direction: "desc" }], limit });
    const ings = await ctx.db.find(ingestions, { ownerId }, { orderBy: [{ field: "at", direction: "desc" }], limit });
    const names = new Map((await ctx.db.find(sources, { ownerId })).map((x) => [x.id, x.name]));
    return {
      runs: rs.map((r) => ({ seq: r.seq, at: r.at, cause: parse(r.cause), entities: r.entities, evaluations: r.evaluations, created: r.created, changed: r.changed, closed: r.closed, reopened: r.reopened, durationMs: r.durationMs })),
      ingestions: ings.map((i) => ({ at: i.at, sourceId: i.sourceId, sourceName: names.get(i.sourceId) ?? "?", trigger: i.trigger, status: i.status, received: i.received, added: i.added, changed: i.changed, unchanged: i.unchanged, retracted: i.retracted, error: i.error ?? null, durationMs: i.durationMs ?? null })),
    };
  },
});

export const summary = app.query({
  access: "signal.read",
  handler: async (ctx) => {
    const ownerId = ctx.auth.requirePrincipal().id;
    const srcs = (await ctx.db.find(sources, { ownerId })).filter((x) => x.status !== "removed");
    const open = await ctx.db.find(findings, { ownerId, status: "open" });
    return {
      sources: srcs.length, sourcesWithIssues: srcs.filter((x) => x.status !== "connected").length, synthetic: srcs.some((x) => x.synthetic),
      records: srcs.reduce((n, x) => n + x.records, 0),
      openFindings: open.filter((f) => !f.dismissedAt).length, matches: open.filter((f) => f.qualification === "match" && !f.dismissedAt).length,
      unacknowledged: open.filter((f) => !f.acknowledgedAt && !f.dismissedAt).length,
    };
  },
});
