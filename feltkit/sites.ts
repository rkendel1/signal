import { fail, s } from "@feltdb/feltkit";
import { app, feedChecks, siteAnalyses, siteFeeds, sites, sources } from "./app.js";
import { json, parse, requireFound, type Ctx, type ReadCtx } from "./_store.js";
import { analyzeSite, siteDomain, templateRegex } from "../lib/site/analyze.ts";
import { assertShareable, conformance, mappingFor, matchesDefinition, privateStrings, toDefinition } from "../lib/site/definition.ts";
import type { Candidate, FeedDefinition, SiteAnalysis, SiteEvidence } from "../lib/site/types.ts";
import { assertUrlShapeAllowed, BlockedUrlError } from "../lib/sources/net-guard.ts";

/**
 * Shared Site Intelligence. Three things that are never conflated:
 *   the catalog (signal_sites, signal_site_feeds)  how a site exposes information — shared, no user data
 *   a connection (a signal_sources row, site_feed)  this user's own access to one feed — private
 *   the engine (observations, criteria, findings)  what the information means for this user — private
 *
 * An analysis is private (it holds what the user's browser saw). What it contributes to the catalog is a
 * definition built without values and checked independently (assertShareable). Feeds that are reachable without
 * the user's session are contributed automatically; session-bound ones only when the user chooses to.
 */

const MAX_EVIDENCE = 1_900_000;

async function upsertSite(ctx: Ctx, domain: string, now: string): Promise<any> {
  const [cur] = await ctx.db.find(sites, { domain });
  if (cur) { await ctx.db.patch(sites, cur.id, { analyses: cur.analyses + 1, lastAnalyzedAt: now }); return { ...cur, analyses: cur.analyses + 1 }; }
  const id = await ctx.db.insert(sites, { domain, name: domain, analyses: 1, firstSeenAt: now, lastAnalyzedAt: now });
  return { id, domain };
}

const SHAREABLE_VERDICTS = new Set(["feed", "detail", "surface", "disallowed"]);
/** Contributed without asking: nothing about it depends on the user's session. */
const autoShare = (c: Candidate) => c.access.auth === "public" || c.kind === "dom" || c.verdict === "disallowed";

export async function latestFeed(ctx: ReadCtx, feedKey: string): Promise<any | null> {
  const all = await ctx.db.find(siteFeeds, { feedKey });
  return all.sort((a: any, b: any) => b.version - a.version)[0] ?? null;
}

/** Add a definition to the catalog: a new feed, the same structure seen again, or a new version when the structure changed. */
async function contribute(ctx: Ctx, def: FeedDefinition, key: string, now: string): Promise<{ feedId: string; version: number; outcome: "new" | "confirmed" | "new_version" }> {
  const site = await upsertSiteNoCount(ctx, def.site, now);
  const cur = await latestFeed(ctx, key);
  if (cur && cur.structureHash === def.structureHash) {
    const pages = [...new Set([...cur.pages, ...def.pages])].slice(0, 30);
    await ctx.db.patch(siteFeeds, cur.id, { analyses: cur.analyses + 1, pages, updatedAt: now, definition: json({ ...parse<FeedDefinition>(cur.definition), pages }) });
    await ctx.db.insert(feedChecks, { feedId: cur.id, version: cur.version, at: now, kind: "analysis", ok: true, conformance: 1, records: 0, detail: "seen again by an analysis with the same structure" });
    return { feedId: cur.id, version: cur.version, outcome: "confirmed" };
  }
  const version = cur ? cur.version + 1 : 1;
  const id = await ctx.db.insert(siteFeeds, {
    siteId: site.id, feedKey: key, version, status: "discovered", verdict: def.verdict, label: def.label, score: def.score, definition: json(def), structureHash: def.structureHash,
    pages: def.pages, analyses: 1, verifications: 0, failures: 0, consecutiveFailures: 0, createdAt: now, updatedAt: now,
  });
  await ctx.db.insert(feedChecks, { feedId: id, version, at: now, kind: "analysis", ok: true, conformance: 1, records: 0, detail: cur ? `structure differs from v${cur.version}` : "discovered" });
  return { feedId: id, version, outcome: cur ? "new_version" : "new" };
}
async function upsertSiteNoCount(ctx: Ctx, domain: string, now: string) {
  const [cur] = await ctx.db.find(sites, { domain });
  if (cur) return cur;
  const id = await ctx.db.insert(sites, { domain, name: domain, analyses: 0, firstSeenAt: now, lastAnalyzedAt: now });
  return { id, domain };
}

function candidateView(c: Candidate, contribution: { feedId?: string; version?: number; outcome?: string; reason?: string; status?: string } | undefined) {
  return { ...c, idSample: undefined, contribution: contribution ?? null };
}

/** Analyze what the user's browser collected on a page. Returns the full (private) analysis to its owner. */
export const analyze = app.mutation({
  access: "signal.write",
  args: { evidence: s.string({ maxLength: MAX_EVIDENCE }) },
  handler: async (ctx, a) => {
    const ownerId = ctx.auth.requirePrincipal().id;
    let ev: SiteEvidence;
    try { ev = JSON.parse(a.evidence); new URL(ev.url); } catch { return fail("INVALID_ARGUMENT", "Not site evidence."); }
    if (!/^https?:/i.test(ev.url)) fail("INVALID_ARGUMENT", "Only web pages can be analyzed.");
    const now = new Date().toISOString();
    const analysis = analyzeSite(ev);
    const site = await upsertSite(ctx, analysis.site.domain, now);
    const priv = privateStrings(ev);
    const contributions: Record<string, { feedId?: string; version?: number; outcome?: string; reason?: string; status?: string }> = {};
    for (const c of analysis.candidates) {
      if (!SHAREABLE_VERDICTS.has(c.verdict)) continue;
      if (!autoShare(c)) { contributions[c.key] = { reason: "depends on your session: shared only if you choose to" }; continue; }
      const def = { ...toDefinition(c, analysis), site: c.endpoint ? siteDomain(new URL(c.endpoint.origin).hostname) : analysis.site.domain, pages: [`${analysis.site.domain}${analysis.page.pathTemplate}`] };
      try { assertShareable(def, priv); } catch (e) { contributions[c.key] = { reason: (e as Error).message }; continue; }
      const r = await contribute(ctx, def, c.key, now);
      const f = await ctx.db.get(siteFeeds, r.feedId);
      contributions[c.key] = { ...r, status: f?.status };
    }
    const id = await ctx.db.insert(siteAnalyses, {
      siteId: site.id, url: ev.url, at: now, durationMs: analysis.durationMs, result: json(analysis),
      contributed: Object.values(contributions).map((x) => x.feedId).filter((x): x is string => !!x), ownerId,
    });
    return { analysisId: id, siteId: site.id, site: analysis.site, page: analysis.page, surface: analysis.surface, observed: analysis.observed, durationMs: analysis.durationMs, candidates: analysis.candidates.map((c) => candidateView(c, contributions[c.key])) };
  },
});

/** Share a session-bound feed's structure (never its values or your parameters), at the user's explicit request. */
export const contributeCandidate = app.mutation({
  access: "signal.write",
  args: { analysisId: s.string(), candidateKey: s.string() },
  handler: async (ctx, a) => {
    const an = requireFound(await ctx.db.get(siteAnalyses, a.analysisId), "That analysis");
    const analysis = parse<SiteAnalysis>(an.result);
    const c = analysis.candidates.find((x) => x.key === a.candidateKey);
    if (!c || !SHAREABLE_VERDICTS.has(c.verdict)) fail("NOT_FOUND", "That candidate cannot be shared.");
    const def = { ...toDefinition(c!, analysis), site: c!.endpoint ? siteDomain(new URL(c!.endpoint.origin).hostname) : analysis.site.domain, pages: [`${analysis.site.domain}${analysis.page.pathTemplate}`] };
    // The evidence itself is not kept; check against every value the analysis retained.
    const priv = new Set<string>();
    for (const x of analysis.candidates) { for (const f of x.fields) for (const v of f.samples ?? []) if (v.length >= 6) priv.add(v); for (const p of x.endpoint?.params ?? []) if (p.value && p.value.length >= 6) priv.add(p.value); }
    try { assertShareable(def, priv); } catch (e) { return fail("FAILED_PRECONDITION", (e as Error).message); }
    const r = await contribute(ctx, def, c!.key, new Date().toISOString());
    await ctx.db.patch(siteAnalyses, an.id, { contributed: [...new Set([...an.contributed, r.feedId])] });
    return r;
  },
});

function feedView(f: any, mine: any[] = []) {
  const def = parse<FeedDefinition>(f.definition);
  return {
    id: f.id, feedKey: f.feedKey, version: f.version, status: f.status, verdict: f.verdict, label: f.label, score: f.score, kind: def.kind, site: def.site,
    endpoint: def.endpoint, recordsPath: def.recordsPath, identifier: def.identifier, fields: def.fields.length, entityHint: def.entityHint,
    change: def.change, access: def.access, pagination: def.pagination, completeness: def.completeness, limitations: def.limitations, pages: f.pages,
    analyses: f.analyses, verifications: f.verifications, failures: f.failures, lastVerifiedAt: f.lastVerifiedAt ?? null, lastFailure: f.lastFailure ?? null,
    connections: mine.filter((x) => x.feedId === f.id).map((x) => ({ sourceId: x.id, name: x.name, status: x.status, acquisition: x.acquisition ?? null })),
  };
}

/** Latest version of each feed of a site (deprecated ones last). */
async function siteFeedsLatest(ctx: ReadCtx, siteId: string) {
  const all = await ctx.db.find(siteFeeds, { siteId });
  const by = new Map<string, any>();
  for (const f of all) if (!by.has(f.feedKey) || by.get(f.feedKey).version < f.version) by.set(f.feedKey, f);
  const rank: Record<string, number> = { production: 0, verified: 1, discovered: 2, needs_reanalysis: 3, broken: 4, deprecated: 5 };
  return [...by.values()].sort((a, b) => rank[a.status] - rank[b.status] || b.score - a.score);
}

/** What Signal knows about the site of a URL: shared feeds and this user's connections to them. */
export async function recognizeUrl(ctx: ReadCtx, ownerId: string, url: string) {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const domain = siteDomain(u.hostname);
  const [site] = await ctx.db.find(sites, { domain });
  if (!site) return { domain, known: false as const, feeds: [], pageFeeds: [] };
  const mine = (await ctx.db.find(sources, { ownerId })).filter((x: any) => x.status !== "removed" && x.feedId);
  const feeds = (await siteFeedsLatest(ctx, site.id)).map((f) => feedView(f, mine));
  const here = `${domain}${u.pathname}`;
  const pageFeeds = feeds.filter((f) => f.pages.some((p: string) => templateRegex(p).test(here))).map((f) => f.id);
  return { domain, known: true as const, siteId: site.id, analyses: site.analyses, lastAnalyzedAt: site.lastAnalyzedAt, feeds, pageFeeds };
}

export const recognize = app.query({
  access: "signal.read",
  args: { url: s.string({ maxLength: 4096 }) },
  handler: async (ctx, a) => { const t0 = performance.now(); const r = await recognizeUrl(ctx, ctx.auth.requirePrincipal().id, a.url); return { ...r, durationMs: Math.round(performance.now() - t0) }; },
});

export const catalog = app.query({
  access: "signal.read",
  handler: async (ctx) => {
    const out = [];
    for (const site of await ctx.db.find(sites, {})) {
      const feeds = await siteFeedsLatest(ctx, site.id);
      const count = (st: string) => feeds.filter((f) => f.status === st).length;
      out.push({ id: site.id, domain: site.domain, analyses: site.analyses, lastAnalyzedAt: site.lastAnalyzedAt, feeds: feeds.length, usable: feeds.filter((f) => ["feed", "detail"].includes(f.verdict) && ["verified", "production", "discovered"].includes(f.status) && parse<FeedDefinition>(f.definition).access.automatable).length, production: count("production"), verified: count("verified"), discovered: count("discovered"), broken: count("broken") + count("needs_reanalysis"), best: feeds[0] ? { label: feeds[0].label, score: feeds[0].score, status: feeds[0].status } : null });
    }
    return out.sort((a, b) => b.usable - a.usable || b.analyses - a.analyses);
  },
});

export const site = app.query({
  access: "signal.read",
  args: { siteId: s.string() },
  handler: async (ctx, a) => {
    const ownerId = ctx.auth.requirePrincipal().id;
    const st = requireFound(await ctx.db.get(sites, a.siteId), "That site");
    const mine = (await ctx.db.find(sources, { ownerId })).filter((x: any) => x.status !== "removed" && x.feedId);
    const feeds = [];
    for (const f of await siteFeedsLatest(ctx, st.id)) {
      const checks = (await ctx.db.find(feedChecks, { feedId: f.id })).sort((x, y) => y.at.localeCompare(x.at)).slice(0, 10);
      feeds.push({ ...feedView(f, mine), definition: parse<FeedDefinition>(f.definition), checks: checks.map((c) => ({ at: c.at, kind: c.kind, ok: c.ok, conformance: c.conformance, records: c.records, detail: c.detail })), reviewNote: f.reviewNote ?? null });
    }
    const analyses = (await ctx.db.find(siteAnalyses, { siteId: st.id })).filter((x) => x.ownerId === ownerId).map((x) => ({ id: x.id, url: x.url, at: x.at, durationMs: x.durationMs }));
    return { id: st.id, domain: st.domain, analyses: st.analyses, firstSeenAt: st.firstSeenAt, lastAnalyzedAt: st.lastAnalyzedAt, feeds, myAnalyses: analyses };
  },
});

export const analysis = app.query({
  access: "signal.read",
  args: { analysisId: s.string() },
  handler: async (ctx, a) => {
    const an = requireFound(await ctx.db.get(siteAnalyses, a.analysisId), "That analysis");
    const r = parse<SiteAnalysis>(an.result);
    return { id: an.id, url: an.url, at: an.at, ...r, candidates: r.candidates.map((c) => ({ ...c, idSample: undefined })), contributed: an.contributed };
  },
});

/**
 * Connect a shared feed with the user's OWN access. The connection is an ordinary Signal source (kind site_feed):
 * from here on its records flow through the same ingestion, identity, criteria and finding pipeline as any other.
 */
export const connect = app.mutation({
  access: "signal.write",
  args: {
    feedId: s.string(), url: s.optional(s.string({ maxLength: 4096 })), name: s.optional(s.string({ maxLength: 200 })), entityType: s.optional(s.string({ maxLength: 80 })),
    mapping: s.optional(s.string({ maxLength: 100_000 })), intervalMinutes: s.optional(s.integer()), acquisition: s.optional(s.enum(["server", "browser"] as const)), staleAfterDays: s.optional(s.number()),
  },
  handler: async (ctx, a) => {
    const ownerId = ctx.auth.requirePrincipal().id;
    const f = requireFound(await ctx.db.get(siteFeeds, a.feedId), "That feed");
    const def = parse<FeedDefinition>(f.definition);
    if (["deprecated", "broken"].includes(f.status)) fail("FAILED_PRECONDITION", `This feed is ${f.status}${f.reviewNote ? `: ${f.reviewNote}` : ""}.`);
    if (!def.endpoint || !["feed", "detail"].includes(def.verdict)) fail("FAILED_PRECONDITION", "This is not a requestable feed. Use page capture for what the page shows.");
    if (!def.access.automatable) fail("FAILED_PRECONDITION", "The site's robots.txt disallows automated access to this endpoint. Signal will not poll it; capture pages you view instead.");
    const hasPlaceholders = /\{[a-z]+\}/.test(def.endpoint!.pathTemplate) || def.endpoint!.params.length > 0;
    // A parameterised feed is instantiated with this user's own parameters: the URL their browser used, from their own analysis.
    let url = a.url ?? (hasPlaceholders ? null : `${def.endpoint!.origin}${def.endpoint!.pathTemplate}`);
    if (!url) {
      const mine = (await ctx.db.find(siteAnalyses, { ownerId })).sort((x, y) => y.at.localeCompare(x.at));
      for (const an of mine) { const c = parse<SiteAnalysis>(an.result).candidates.find((x) => x.key === f.feedKey && x.endpoint?.url); if (c) { url = c.endpoint!.url!; break; } }
    }
    if (!url) fail("INVALID_ARGUMENT", "This feed takes parameters: analyze a page of the site that uses it (so Signal knows your own parameters), or give its URL.");
    const m = matchesDefinition(def, url!);
    if (!m.ok) fail("INVALID_ARGUMENT", `That URL does not match this feed: ${m.reason}.`);
    const acquisition = a.acquisition ?? (def.access.auth === "public" ? "server" : "browser");
    if (acquisition === "server" && def.access.auth !== "public") fail("FAILED_PRECONDITION", "This feed depends on your browser session. Signal's server cannot use your session (and must not): choose browser acquisition, which runs in your browser while it is open.");
    if (acquisition === "server") { try { assertUrlShapeAllowed(url!, { allowPrivateHosts: (process.env.SIGNAL_ALLOW_PRIVATE_HOSTS ?? "").split(",").filter(Boolean) }); } catch (e) { if (e instanceof BlockedUrlError) fail("INVALID_ARGUMENT", e.message); throw e; } }
    const entityType = a.entityType ?? (def.entityHint && def.entityHint !== "features" ? def.entityHint : def.site.split(".")[0]);
    const mapping = a.mapping ? { ...parse<Record<string, unknown>>(a.mapping), entityType, version: 1 } : mappingFor(def, entityType);
    const maxAgeMin = def.change.maxAgeSeconds ? Math.ceil(def.change.maxAgeSeconds / 60) : 5;
    const now = new Date().toISOString();
    const id = await ctx.db.insert(sources, {
      name: a.name ?? `${def.site} — ${def.label}`, kind: "site_feed", origin: "user", status: "connected", entityType,
      config: json({ url, recordsPath: def.recordsPath, format: def.format ?? "json", ...(def.responsePrefix ? { responsePrefix: def.responsePrefix } : {}) }),
      mapping: json(mapping), mappingVersion: 1, refreshMode: "poll", intervalMinutes: Math.max(1, a.intervalMinutes ?? maxAgeMin), ...(a.staleAfterDays ? { staleAfterDays: a.staleAfterDays } : {}),
      synthetic: false, records: 0, createdAt: now, siteId: f.siteId, feedId: f.id, feedVersion: f.version, acquisition, ownerId,
    });
    return { sourceId: id, acquisition, intervalMinutes: Math.max(1, a.intervalMinutes ?? maxAgeMin), mapping };
  },
});

/** Record whether an acquisition still matched the shared definition, and move the feed's status accordingly. */
export async function recordFeedCheck(ctx: Ctx, feedId: string, check: { ok: boolean; conformance: number; records: number; detail: string; kind: "acquisition" | "report"; counts: boolean }) {
  const f = await ctx.db.get(siteFeeds, feedId);
  if (!f) return;
  const now = new Date().toISOString();
  await ctx.db.insert(feedChecks, { feedId, version: f.version, at: now, kind: check.kind, ok: check.ok, conformance: check.conformance, records: check.records, detail: check.detail.slice(0, 300) });
  if (check.ok) {
    await ctx.db.patch(siteFeeds, feedId, { verifications: f.verifications + 1, consecutiveFailures: 0, lastVerifiedAt: now, updatedAt: now, ...(["discovered", "needs_reanalysis", "broken"].includes(f.status) ? { status: "verified" } : {}) });
    return;
  }
  if (!check.counts) return; // e.g. this user's session expired: not evidence about the site
  const consecutive = f.consecutiveFailures + 1;
  const status = f.status === "deprecated" ? "deprecated" : check.conformance < 0.8 && check.records > 0 ? "needs_reanalysis" : consecutive >= 3 ? "broken" : f.status;
  await ctx.db.patch(siteFeeds, feedId, { failures: f.failures + 1, consecutiveFailures: consecutive, lastFailureAt: now, lastFailure: check.detail.slice(0, 300), status, updatedAt: now });
}

/** After a site_feed acquisition: does the data still have the structure the catalog describes? */
export async function verifyAcquisition(ctx: Ctx, src: any, rows: Array<Record<string, unknown>>) {
  if (!src.feedId) return null;
  const f = await ctx.db.get(siteFeeds, src.feedId);
  if (!f) return null;
  const c = conformance(parse<FeedDefinition>(f.definition), rows);
  await recordFeedCheck(ctx, f.id, { kind: "acquisition", ok: c.ok, conformance: c.score, records: c.records, detail: c.ok ? `${c.records} records conform` : `${c.missing.length ? `missing ${c.missing.slice(0, 5).join(", ")}` : ""}${c.identifierOk ? "" : " identifier missing or not unique"}`, counts: true });
  return c;
}

export const report = app.mutation({
  access: "signal.write",
  args: { feedId: s.string(), detail: s.string({ minLength: 3, maxLength: 300 }) },
  handler: async (ctx, a) => {
    requireFound(await ctx.db.get(siteFeeds, a.feedId), "That feed");
    await recordFeedCheck(ctx, a.feedId, { kind: "report", ok: false, conformance: 1, records: 0, detail: `reported: ${a.detail}`, counts: true });
    return { reported: true };
  },
});

/** Curators decide what is recommended to everyone. */
export const review = app.mutation({
  access: "signal.curate",
  args: { feedId: s.string(), action: s.enum(["promote", "deprecate", "reset"] as const), note: s.optional(s.string({ maxLength: 500 })) },
  handler: async (ctx, a) => {
    const f = requireFound(await ctx.db.get(siteFeeds, a.feedId), "That feed");
    if (a.action === "promote" && !["verified", "production"].includes(f.status)) fail("FAILED_PRECONDITION", "Only a verified feed (an acquisition matched it) can be promoted to production.");
    const status = a.action === "promote" ? "production" : a.action === "deprecate" ? "deprecated" : "discovered";
    await ctx.db.patch(siteFeeds, f.id, { status, reviewNote: a.note ?? undefined, updatedAt: new Date().toISOString(), ...(a.action === "reset" ? { consecutiveFailures: 0 } : {}) });
    await ctx.db.insert(feedChecks, { feedId: f.id, version: f.version, at: new Date().toISOString(), kind: "report", ok: a.action !== "deprecate", conformance: 1, records: 0, detail: `curator: ${a.action}${a.note ? ` — ${a.note}` : ""}` });
    return { status };
  },
});
