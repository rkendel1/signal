import { s } from "@feltdb/feltkit";
import { app, criteria, findings, links, notices, observations, sources } from "./app.js";
import { normalizeUrl, parse } from "./_store.js";
import { recognizeUrl } from "./sites.js";
import { refreshStatement } from "../lib/engine/coverage.ts";

/**
 * The ambient surface's one question: "what does Signal have for the page I am on?" Read-only, owner-scoped,
 * answered from the same durable findings, notices and catalog the web app uses. The overlay has no evaluator,
 * no criteria and no finding store of its own.
 */
export const context = app.query({
  access: "signal.read",
  args: { url: s.string({ maxLength: 4096 }) },
  handler: async (ctx, a) => {
    const t0 = performance.now();
    const ownerId = ctx.auth.requirePrincipal().id;
    const url = normalizeUrl(a.url);
    const now = new Date().toISOString();
    const site = await recognizeUrl(ctx, ownerId, a.url);
    const tRecognize = Math.round(performance.now() - t0);

    // Entities whose records name this page (their own URL) or were captured on it.
    const hits = [...(await ctx.db.find(observations, { url })), ...(await ctx.db.find(observations, { pageUrl: url }))].filter((o) => o.ownerId === ownerId && o.status === "current");
    const entityIds = new Set<string>();
    for (const o of hits) { const [l] = await ctx.db.find(links, { sourceId: o.sourceId, recordKey: o.recordKey }); if (l) entityIds.add(l.entityId); }
    const crit = new Map<string, any>();
    const pageFindings = [];
    for (const id of entityIds) for (const f of await ctx.db.find(findings, { entityId: id })) {
      if (f.dismissedAt) continue;
      if (!crit.has(f.criteriaId)) crit.set(f.criteriaId, await ctx.db.get(criteria, f.criteriaId));
      pageFindings.push({ id: f.id, entityId: f.entityId, entityLabel: f.entityLabel ?? null, criteriaName: crit.get(f.criteriaId)?.name ?? "", status: f.status, change: f.change, qualification: f.qualification, summary: f.summary, confidence: f.confidence, lastChangedAt: f.lastChangedAt, snoozedUntil: f.snoozedUntil && f.snoozedUntil > now ? f.snoozedUntil : null, acknowledged: Boolean(f.acknowledgedAt) });
    }
    pageFindings.sort((x, y) => Number(y.status === "open") - Number(x.status === "open") || y.lastChangedAt.localeCompare(x.lastChangedAt));

    const recent = await ctx.db.find(notices, { ownerId }, { orderBy: [{ field: "createdAt", direction: "desc" }], limit: 60 });
    const active = recent.filter((n) => !n.ackAt && !(n.snoozedUntil && n.snoozedUntil > now));
    const view = (n: any) => ({ id: n.id, kind: n.kind, severity: n.severity, title: n.title, body: n.body, findingId: n.findingId ?? null, sourceId: n.sourceId ?? null, createdAt: n.createdAt, contextual: n.urls.includes(url) });

    // This user's sources on this site, and the criteria that read their entity types.
    const mine = (await ctx.db.find(sources, { ownerId })).filter((x) => x.status !== "removed" && ((site && "siteId" in site && x.siteId === site.siteId) || (x.kind === "page_capture" && hits.some((h) => h.sourceId === x.id))));
    const types = new Set(mine.map((x) => x.entityType));
    const watching = (await ctx.db.find(criteria, { ownerId })).filter((c) => !c.removed && types.has(c.entityType)).map((c) => ({ id: c.id, name: c.name, enabled: c.enabled, version: c.activeVersion }));
    const captureSources = (await ctx.db.find(sources, { ownerId })).filter((x) => x.kind === "page_capture" && x.status !== "removed").map((x) => ({ id: x.id, name: x.name, pageTypes: parse<{ pageTypes?: string[] }>(x.mapping).pageTypes ?? [] }));
    return {
      url, site,
      sources: mine.map((x) => ({ id: x.id, name: x.name, kind: x.kind, status: x.status, statusReason: x.statusReason ?? null, records: x.records, acquisition: x.acquisition ?? null, lastSuccessAt: x.lastSuccessAt ?? null, lastChangeAt: x.lastChangeAt ?? null, refresh: refreshStatement(x.kind, x.refreshMode, x.intervalMinutes), nextRefreshAt: x.refreshMode === "poll" && x.intervalMinutes ? new Date(Date.parse(x.lastRefreshAt ?? x.createdAt) + x.intervalMinutes * 60_000).toISOString() : null })),
      entities: entityIds.size, findings: pageFindings.slice(0, 20), watching, captureSources,
      notices: { active: active.length, contextual: active.filter((n) => n.urls.includes(url)).length, items: active.slice(0, 15).map(view) },
      timing: { recognizeMs: tRecognize, totalMs: Math.round(performance.now() - t0) },
    };
  },
});
