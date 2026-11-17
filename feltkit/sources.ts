import { fail, s } from "@feltdb/feltkit";
import { gunzipSync, gzipSync } from "node:zlib";
import { app, ingestions, links, observations, sources } from "./app.js";
import { api } from "./_generated/api.js";
import { recordFeedCheck, verifyAcquisition } from "./sites.js";
import { addNotice, evaluateEntities, ingest, json, parse, requireFound, storedObservation, type Ctx } from "./_store.js";
import { newId, sha256 } from "../lib/core/canonical.ts";
import { coverage, refreshStatement } from "../lib/engine/coverage.ts";
import { applyMapping, mapRow, profileFields, proposeMapping, validateMapping, type SourceMapping } from "../lib/engine/mapping.ts";
import type { ObservationDraft } from "../lib/engine/types.ts";
import { extractPage } from "../lib/page/extract.ts";
import { fetchJson } from "../lib/sources/http.ts";
import { assertUrlShapeAllowed, BlockedUrlError } from "../lib/sources/net-guard.ts";
import { pageToDrafts, pageTypeSummary, type PageMapping } from "../lib/sources/page.ts";
import { parseRecords, type RecordFormat } from "../lib/sources/records.ts";

/**
 * Sources: what Signal can see. Five kinds behind one model —
 *   file          CSV / GeoJSON / JSON snapshots the user uploads
 *   http_json     an HTTP JSON API Signal fetches (conditional GET, SSRF guard)
 *   push          a system pushes records (an AppPort capability)
 *   manual        records a person enters in Signal (native)
 *   page_capture  pages captured in the user's own browser (native; via the extension)
 * Every kind produces observation drafts; one pipeline (_store.ts) does the rest.
 */

const MAX_CONTENT = 1_800_000; // FeltKit request bodies are limited to 2 MiB
const self = api.sources as unknown as Record<string, never>;
const Kind = s.enum(["file", "http_json", "push", "page_capture", "manual"] as const);
const Format = s.enum(["csv", "geojson", "json"] as const);

function netPolicy() {
  const raw = process.env.SIGNAL_ALLOW_PRIVATE_HOSTS ?? "";
  return { allowPrivateHosts: raw.split(",").map((h) => h.trim()).filter(Boolean) };
}
const bad = (e: unknown): never => fail("INVALID_ARGUMENT", (e as Error).message);
const modeOf = (kind: string) => (kind === "file" ? "snapshot" : kind === "http_json" ? "poll" : kind === "page_capture" ? "capture" : "push") as "snapshot" | "poll" | "capture" | "push";

async function storeRaw(ctx: Ctx, sourceId: string, content: string, contentType: string) {
  const hash = sha256(content);
  const f = await ctx.services.files.upload({ name: `${sourceId}-${hash.slice(0, 12)}.gz`, contentType: "application/gzip", content: new Uint8Array(gzipSync(content)), metadata: { kind: "signal.source.raw", sourceId, sha256: hash, contentType } });
  return { rawRef: `files:${f.id}`, rawHash: hash };
}
async function readRaw(ctx: Ctx, ref: string): Promise<string> {
  const f = await ctx.services.files.read(ref.replace(/^files:/, ""));
  return gunzipSync(f.bytes).toString("utf8");
}

function parseFor(content: string, source: { config: string }) {
  const cfg = parse<{ format: RecordFormat; recordsPath?: string | null; responsePrefix?: string }>(source.config);
  const text = cfg.responsePrefix && content.trimStart().startsWith(cfg.responsePrefix) ? content.trimStart().slice(cfg.responsePrefix.length) : content;
  return parseRecords(text, cfg.format ?? "json", cfg.format === "geojson" ? undefined : cfg.recordsPath ?? undefined);
}
function draftsFromRecords(content: string, source: { config: string; mapping: string }) {
  let ds;
  try { ds = parseFor(content, source); } catch (e) { return bad(e); }
  try { return { ...applyMapping(ds, parse<SourceMapping>(source.mapping)), rows: ds.rows.map((r) => r.props) }; } catch (e) { return bad(e); }
}

function draftsFromPage(html: string, url: string, source: { id: string; mapping: string }) {
  const page = extractPage({ html, locator: url, baseUrl: /^https?:/i.test(url) ? url : null, observationId: `cap_${sha256(html).slice(0, 16)}`, contentHash: sha256(html), contentType: "text/html", observedAt: new Date().toISOString() });
  return { page, ...pageToDrafts(page, parse<PageMapping>(source.mapping)) };
}

// ------------------------------------------------------------------ understand before connecting

/** Profile content and propose a mapping. Nothing is stored. */
export const inspect = app.query({
  access: "signal.read",
  args: { kind: Kind, content: s.string({ maxLength: MAX_CONTENT }), format: s.optional(Format), recordsPath: s.optional(s.string()), entityType: s.optional(s.string()), url: s.optional(s.string()) },
  handler: async (_ctx, a) => {
    if (a.kind === "page_capture") {
      const page = extractPage({ html: a.content, locator: a.url ?? "about:capture", baseUrl: a.url && /^https?:/i.test(a.url) ? a.url : null, observationId: "inspect", contentHash: sha256(a.content), contentType: "text/html", observedAt: new Date().toISOString() });
      return { kind: a.kind, title: page.title, types: pageTypeSummary(page), entities: page.entities.length };
    }
    let ds;
    try { ds = parseRecords(a.content, a.format ?? "json", a.recordsPath); } catch (e) { return bad(e); }
    const prop = proposeMapping(ds, a.entityType ?? "record");
    const fields = profileFields(ds);
    const issues: Parameters<typeof mapRow>[2] = [];
    const sample: ObservationDraft[] = ds.rows.slice(0, 5).map((r) => mapRow(r, prop.mapping, issues));
    return { kind: a.kind, format: ds.format, rows: ds.rows.length, withGeometry: ds.rows.filter((r) => r.geometry).length, fields, proposals: prop.proposals, skipped: prop.skipped, mapping: prop.mapping, sample, errors: validateMapping(prop.mapping, ds) };
  },
});

// ------------------------------------------------------------------ connect

export const create = app.mutation({
  access: "signal.write",
  args: {
    name: s.string({ minLength: 1, maxLength: 200 }), kind: Kind, entityType: s.string({ minLength: 1, maxLength: 80 }),
    config: s.optional(s.string({ maxLength: 10_000 })), mapping: s.string({ maxLength: 100_000 }),
    content: s.optional(s.string({ maxLength: MAX_CONTENT })), url: s.optional(s.string({ maxLength: 2048 })),
    dataAsOf: s.optional(s.string()), staleAfterDays: s.optional(s.number()), intervalMinutes: s.optional(s.integer()),
    synthetic: s.optional(s.boolean()), description: s.optional(s.string({ maxLength: 2000 })),
  },
  handler: async (ctx, a) => {
    const ownerId = ctx.auth.requirePrincipal().id;
    const config = parse<Record<string, unknown>>(a.config, {});
    const mapping = parse<Record<string, unknown>>(a.mapping);
    if (a.kind === "page_capture") {
      const pm = mapping as unknown as PageMapping;
      if (!Array.isArray(pm.pageTypes) || !pm.pageTypes.length) fail("INVALID_ARGUMENT", "Choose at least one page entity type (pageTypes).");
      pm.entityType = a.entityType;
    } else {
      const sm = { ...(mapping as unknown as SourceMapping), entityType: a.entityType, version: 1 };
      const errors = validateMapping(sm);
      if (errors.length) fail("INVALID_ARGUMENT", `Invalid mapping: ${errors.join("; ")}`);
      Object.assign(mapping, sm);
    }
    if (a.kind === "file" && !config.format) fail("INVALID_ARGUMENT", "A file source needs config.format (csv, geojson or json).");
    if (a.kind === "http_json") {
      if (typeof config.url !== "string") fail("INVALID_ARGUMENT", "An HTTP source needs config.url.");
      try { assertUrlShapeAllowed(config.url as string, netPolicy()); } catch (e) { if (e instanceof BlockedUrlError) fail("INVALID_ARGUMENT", e.message); throw e; }
      config.format = "json";
    }
    if (a.kind === "push" || a.kind === "manual") config.format = "json";
    if (a.staleAfterDays !== undefined && !(a.staleAfterDays > 0)) fail("INVALID_ARGUMENT", "staleAfterDays must be positive.");
    const now = new Date().toISOString();
    const id = await ctx.db.insert(sources, {
      name: a.name, ...(a.description ? { description: a.description } : {}), kind: a.kind, origin: a.kind === "manual" || a.kind === "page_capture" ? "native" : "user",
      status: "connected", entityType: a.entityType, config: json(config), mapping: json(mapping), mappingVersion: 1, refreshMode: modeOf(a.kind),
      ...(a.intervalMinutes ? { intervalMinutes: Math.max(5, a.intervalMinutes) } : {}), ...(a.staleAfterDays ? { staleAfterDays: a.staleAfterDays } : {}),
      synthetic: a.synthetic ?? false, records: 0, createdAt: now, ownerId,
    });
    if (a.content !== undefined) {
      const src = requireFound(await ctx.db.get(sources, id), "That source");
      if (a.kind === "page_capture") {
        const { drafts, skipped } = draftsFromPage(a.content, a.url ?? "about:capture", src);
        await ingest(ctx, { source: src, drafts, mode: "partial", trigger: "capture", provenance: { url: a.url ?? null, method: "browser-capture", by: ownerId, contentHash: sha256(a.content) }, issues: skipped });
      } else {
        const raw = await storeRaw(ctx, id, a.content, String(config.format));
        const m = draftsFromRecords(a.content, src);
        await ingest(ctx, { source: src, drafts: m.drafts, mode: a.kind === "file" ? "snapshot" : "partial", trigger: "create", ...raw, provenance: { method: a.kind === "file" ? "upload" : "push", by: ownerId }, issues: m.issues, validAt: a.dataAsOf ?? null });
      }
    }
    return id;
  },
});

// ------------------------------------------------------------------ new information

/** A new snapshot of a file source. Unchanged records are confirmed, changed ones versioned, missing ones withdrawn. */
export const upload = app.mutation({
  access: "signal.write",
  args: { sourceId: s.string(), content: s.string({ maxLength: MAX_CONTENT }), dataAsOf: s.optional(s.string()) },
  handler: async (ctx, a) => {
    const src = requireFound(await ctx.db.get(sources, a.sourceId), "That source");
    if (src.kind !== "file") fail("FAILED_PRECONDITION", "Only file sources take uploads.");
    const raw = await storeRaw(ctx, src.id, a.content, parse<{ format: string }>(src.config).format);
    const m = draftsFromRecords(a.content, src);
    return ingest(ctx, { source: src, drafts: m.drafts, mode: "snapshot", trigger: "upload", ...raw, provenance: { method: "upload", by: ctx.auth.requirePrincipal().id }, issues: m.issues, validAt: a.dataAsOf ?? null });
  },
});

const IngestResult = s.object({
  ingestionId: s.string(), received: s.integer(), added: s.integer(), changed: s.integer(), unchanged: s.integer(), retracted: s.integer(), reconfirmed: s.integer(),
  newInformation: s.boolean(), affectedEntities: s.integer(),
  run: s.nullable(s.object({ runId: s.string(), entities: s.integer(), evaluations: s.integer(), created: s.integer(), changed: s.integer(), closed: s.integer(), reopened: s.integer(), durationMs: s.number() })),
});

/** Records pushed by a system or entered by a person. Evaluated in the same transaction. */
export const push = app.mutation({
  access: "signal.push",
  args: { sourceId: s.string(), records: s.string({ maxLength: MAX_CONTENT }), mode: s.optional(s.enum(["partial", "snapshot"] as const)), removed: s.optional(s.array(s.string(), { maxItems: 1000 })), dataAsOf: s.optional(s.string()) },
  returns: IngestResult,
  capability: { name: "signal.sources.push", description: "Push records (a JSON array) into a push source; Signal versions what changed, resolves identity and re-evaluates affected findings at once." },
  handler: async (ctx, a) => {
    const src = requireFound(await ctx.db.get(sources, a.sourceId), "That source");
    if (src.kind !== "push" && src.kind !== "manual") fail("FAILED_PRECONDITION", `A ${src.kind} source does not accept pushed records.`);
    const raw = await storeRaw(ctx, src.id, a.records, "application/json");
    const m = draftsFromRecords(a.records, src);
    return ingest(ctx, { source: src, drafts: m.drafts, mode: a.mode ?? "partial", removed: a.removed, trigger: "push", ...raw, provenance: { method: src.kind === "manual" ? "manual-entry" : "push", by: ctx.auth.requirePrincipal().id }, issues: m.issues, validAt: a.dataAsOf ?? null });
  },
});

/** A page captured in the user's own browser (the extension). */
export const capture = app.mutation({
  access: "signal.write",
  args: { sourceId: s.string(), html: s.string({ maxLength: MAX_CONTENT }), url: s.string({ maxLength: 2048 }) },
  handler: async (ctx, a) => {
    const src = requireFound(await ctx.db.get(sources, a.sourceId), "That source");
    if (src.kind !== "page_capture") fail("FAILED_PRECONDITION", "Only page-capture sources take captures.");
    const { drafts, skipped, page } = draftsFromPage(a.html, a.url, src);
    const r = await ingest(ctx, { source: src, drafts, mode: "partial", trigger: "capture", provenance: { url: a.url, title: page.title, method: "browser-capture", by: ctx.auth.requirePrincipal().id, contentHash: sha256(a.html), entitiesOnPage: page.entities.length }, issues: skipped });
    return { ...r, recordKeys: drafts.map((d) => d.recordKey), title: page.title };
  },
});

export const refreshContext = app.query({
  access: "signal.write",
  args: { sourceId: s.string() },
  handler: async (ctx, { sourceId }) => {
    const src = requireFound(await ctx.db.get(sources, sourceId), "That source");
    return { kind: src.kind, status: src.status, acquisition: src.acquisition ?? null, url: parse<{ url?: string }>(src.config).url ?? null, etag: src.etag ?? null, lastModified: src.lastModified ?? null };
  },
});

/** Fetch an HTTP JSON source now (an action: it talks to the outside), then record what came back. */
export const refresh = app.action({
  access: "signal.write",
  args: { sourceId: s.string() },
  handler: async (ctx, { sourceId }) => {
    const c = (await ctx.runQuery(self.refreshContext, { sourceId } as never)) as { kind: string; status: string; acquisition: string | null; url: string | null; etag: string | null; lastModified: string | null };
    if (!(c.kind === "http_json" || (c.kind === "site_feed" && c.acquisition === "server")) || !c.url) fail("FAILED_PRECONDITION", c.kind === "site_feed" ? "This feed is acquired in your browser with your own session (the Signal extension), not by Signal's server." : "Only HTTP sources are fetched by Signal.");
    if (c.status === "paused" || c.status === "removed") fail("FAILED_PRECONDITION", `The source is ${c.status}.`);
    const r = await fetchJson(c.url!, { etag: c.etag, lastModified: c.lastModified }, netPolicy());
    if (!r.ok) return ctx.runMutation(self.recordFailure, { sourceId, code: r.code, message: r.message, httpStatus: r.httpStatus ?? undefined, durationMs: r.durationMs } as never);
    if (r.notModified) return ctx.runMutation(self.recordNotModified, { sourceId, finalUrl: r.finalUrl, durationMs: r.durationMs } as never);
    return ctx.runMutation(self.recordFetch, { sourceId, body: r.body, hash: r.hash, etag: r.etag ?? undefined, lastModified: r.lastModified ?? undefined, finalUrl: r.finalUrl, httpStatus: r.httpStatus, durationMs: r.durationMs } as never);
  },
});

export const recordFetch = app.mutation({
  access: "signal.write",
  args: { sourceId: s.string(), body: s.string({ maxLength: MAX_CONTENT }), hash: s.string(), etag: s.optional(s.string()), lastModified: s.optional(s.string()), finalUrl: s.string(), httpStatus: s.integer(), durationMs: s.number() },
  handler: async (ctx, a) => {
    const src = requireFound(await ctx.db.get(sources, a.sourceId), "That source");
    if (sha256(a.body) !== a.hash) fail("INVALID_ARGUMENT", "Body does not match its hash.");
    if (src.kind !== "http_json" && src.kind !== "site_feed") fail("FAILED_PRECONDITION", "Only HTTP and site feeds record fetched responses.");
    const raw = await storeRaw(ctx, src.id, a.body, "application/json");
    let m;
    try { m = draftsFromRecords(a.body, src); } catch (e) {
      // The response no longer fits this connection's mapping. For a shared feed, that is evidence the site changed.
      let rows: Array<Record<string, unknown>> | null = null;
      try { rows = parseFor(a.body, src).rows.map((r) => r.props); } catch { /* not even parseable */ }
      const verification = src.kind === "site_feed" && rows ? await verifyAcquisition(ctx, src, rows) : null;
      await failure(ctx, src, "UNPARSEABLE", (e as Error).message, {}, !verification);
      return { status: "error", error: (e as Error).message, verification };
    }
    await ctx.db.patch(sources, src.id, { ...(a.etag ? { etag: a.etag } : {}), ...(a.lastModified ? { lastModified: a.lastModified } : {}) });
    const r = await ingest(ctx, { source: { ...src }, drafts: m.drafts, mode: "snapshot", trigger: "refresh", ...raw, provenance: { method: "GET", url: a.finalUrl, httpStatus: a.httpStatus, etag: a.etag ?? null, fetchMs: a.durationMs, acquiredBy: src.kind === "site_feed" ? src.acquisition : "server" }, issues: m.issues });
    const verification = src.kind === "site_feed" ? await verifyAcquisition(ctx, src, m.rows) : null;
    return { status: "ok", ...r, verification };
  },
});

export const recordNotModified = app.mutation({
  access: "signal.write",
  args: { sourceId: s.string(), finalUrl: s.string(), durationMs: s.number() },
  handler: async (ctx, a) => {
    const src = requireFound(await ctx.db.get(sources, a.sourceId), "That source");
    const now = new Date().toISOString();
    const seq = await ctx.db.sequence(`signal.ingestions:${src.id}`);
    await ctx.db.insert(ingestions, { ingestionId: newId("ing"), sourceId: src.id, seq, at: now, trigger: "refresh", status: "not_modified", mappingVersion: src.mappingVersion, received: 0, added: 0, changed: 0, unchanged: src.records, retracted: 0, issues: json({ count: 0, first: [] }), provenance: json({ method: "GET", url: a.finalUrl, httpStatus: 304, fetchMs: a.durationMs }), ownerId: src.ownerId });
    await ctx.db.patch(sources, src.id, { lastRefreshAt: now, lastSuccessAt: now, ...(src.status === "unavailable" ? { status: "connected", statusReason: undefined } : {}), lastError: undefined });
    return { status: "not_modified" };
  },
});

async function failure(ctx: Ctx, src: any, code: string, message: string, extra: Record<string, unknown> = {}, feedCheck = true) {
  const now = new Date().toISOString();
  const seq = await ctx.db.sequence(`signal.ingestions:${src.id}`);
  await ctx.db.insert(ingestions, { ingestionId: newId("ing"), sourceId: src.id, seq, at: now, trigger: "refresh", status: "unavailable", mappingVersion: src.mappingVersion, received: 0, added: 0, changed: 0, unchanged: 0, retracted: 0, issues: json({ count: 0, first: [] }), provenance: json(extra), error: `${code}: ${message}`, ownerId: src.ownerId });
  // Evidence already observed stays as it was (and ages): unavailability is not a retraction.
  // One notice per outage (keyed by the last success), not one per failed attempt.
  await addNotice(ctx, { kind: "source_failure", severity: "warning", priority: 60, title: `Source unavailable: ${src.name}`, body: `${code}: ${message}. Findings that rely on it keep its last evidence, which ages until it answers again.`.slice(0, 600), sourceId: src.id, dedupKey: `source:${src.id}:failure:${src.lastSuccessAt ?? src.createdAt}` }, src.ownerId, now);
  await ctx.db.patch(sources, src.id, { status: "unavailable", statusReason: `${code}: ${message}`, lastRefreshAt: now, lastError: `${code}: ${message}` });
  // A refusal of this user's session says nothing about the site; an unreachable or changed site does.
  if (src.feedId && feedCheck) await recordFeedCheck(ctx, src.feedId, { kind: "acquisition", ok: false, conformance: 1, records: 0, detail: `${code}`, counts: !/HTTP_(401|403)/.test(code) });
}

export const recordFailure = app.mutation({
  access: "signal.write",
  args: { sourceId: s.string(), code: s.string(), message: s.string(), httpStatus: s.optional(s.integer()), durationMs: s.number() },
  handler: async (ctx, a) => {
    const src = requireFound(await ctx.db.get(sources, a.sourceId), "That source");
    await failure(ctx, src, a.code, a.message, { httpStatus: a.httpStatus ?? null, fetchMs: a.durationMs });
    return { status: "unavailable", error: `${a.code}: ${a.message}` };
  },
});

// ------------------------------------------------------------------ change how a source is understood or used

/** A new mapping version. File and HTTP sources are re-mapped from their stored raw bytes; only real differences become new observations. */
export const setMapping = app.mutation({
  access: "signal.write",
  args: { sourceId: s.string(), mapping: s.string({ maxLength: 100_000 }) },
  handler: async (ctx, a) => {
    const src = requireFound(await ctx.db.get(sources, a.sourceId), "That source");
    const version = src.mappingVersion + 1;
    let mapping: Record<string, unknown>;
    if (src.kind === "page_capture") {
      const pm = parse<PageMapping>(a.mapping);
      if (!pm.pageTypes?.length) fail("INVALID_ARGUMENT", "Choose at least one page entity type.");
      mapping = { ...pm, entityType: src.entityType };
    } else {
      const sm = { ...parse<SourceMapping>(a.mapping), entityType: src.entityType, version };
      const errors = validateMapping(sm);
      if (errors.length) fail("INVALID_ARGUMENT", `Invalid mapping: ${errors.join("; ")}`);
      mapping = sm as unknown as Record<string, unknown>;
    }
    await ctx.db.patch(sources, src.id, { mapping: json(mapping), mappingVersion: version });
    const updated = requireFound(await ctx.db.get(sources, src.id), "That source");
    if (src.kind !== "file" && src.kind !== "http_json") return { mappingVersion: version, reapplied: false, note: "Applies to records received from now on." };
    const [last] = await ctx.db.find(ingestions, { sourceId: src.id, status: "ok" }, { orderBy: [{ field: "seq", direction: "desc" }], limit: 1 });
    if (!last?.rawRef) return { mappingVersion: version, reapplied: false, note: "No stored snapshot yet." };
    const content = await readRaw(ctx, last.rawRef);
    const m = draftsFromRecords(content, updated);
    const r = await ingest(ctx, { source: updated, drafts: m.drafts, mode: "snapshot", trigger: "mapping", rawRef: last.rawRef, rawHash: last.rawHash, provenance: { method: "re-map", fromIngestion: last.id, mappingVersion: version }, issues: m.issues });
    return { mappingVersion: version, reapplied: true, ...r };
  },
});

export const update = app.mutation({
  access: "signal.write",
  args: { sourceId: s.string(), name: s.optional(s.string({ minLength: 1, maxLength: 200 })), staleAfterDays: s.optional(s.nullable(s.number())), description: s.optional(s.string({ maxLength: 2000 })), intervalMinutes: s.optional(s.integer()) },
  handler: async (ctx, a) => {
    const src = requireFound(await ctx.db.get(sources, a.sourceId), "That source");
    if (a.staleAfterDays !== undefined && a.staleAfterDays !== null && !(a.staleAfterDays > 0)) fail("INVALID_ARGUMENT", "staleAfterDays must be positive.");
    await ctx.db.patch(sources, src.id, { ...(a.name ? { name: a.name } : {}), ...(a.description !== undefined ? { description: a.description } : {}), ...(a.intervalMinutes ? { intervalMinutes: Math.max(5, a.intervalMinutes) } : {}), ...(a.staleAfterDays !== undefined ? { staleAfterDays: a.staleAfterDays ?? undefined } : {}) });
    if (a.staleAfterDays === undefined) return { reevaluated: 0 };
    const ls = await ctx.db.find(links, { sourceId: src.id });
    const run = await evaluateEntities(ctx, src.ownerId, [...new Set(ls.map((l: any) => l.entityId as string))], { kind: "source_status", ref: src.id, label: `${src.name}: freshness rule changed to ${a.staleAfterDays ?? "none"}` });
    return { reevaluated: run.entities, run };
  },
});

export const setStatus = app.mutation({
  access: "signal.write",
  args: { sourceId: s.string(), status: s.enum(["connected", "paused"] as const) },
  handler: async (ctx, a) => {
    const src = requireFound(await ctx.db.get(sources, a.sourceId), "That source");
    if (src.status === "removed") fail("FAILED_PRECONDITION", "A removed source cannot be resumed; connect it again.");
    await ctx.db.patch(sources, src.id, { status: a.status, statusReason: a.status === "paused" ? "paused by its owner" : undefined });
    return { status: a.status };
  },
});

/** Disconnect: every current observation is withdrawn (history kept), affected findings re-evaluated. */
export const remove = app.mutation({
  access: "signal.write",
  args: { sourceId: s.string() },
  handler: async (ctx, a) => {
    const src = requireFound(await ctx.db.get(sources, a.sourceId), "That source");
    if (src.status === "removed") return { removed: true, run: null };
    const r = await ingest(ctx, { source: { ...src, status: "connected" }, drafts: [], mode: "snapshot", trigger: "removal", provenance: { method: "removed", by: ctx.auth.requirePrincipal().id } });
    await ctx.db.patch(sources, src.id, { status: "removed", statusReason: "removed by its owner", records: 0 });
    return { removed: true, ...r };
  },
});

// ------------------------------------------------------------------ understand what is connected

function view(src: any) {
  const now = Date.now();
  const ageDays = src.lastSuccessAt ? (now - Date.parse(src.lastSuccessAt)) / 86_400_000 : null;
  return {
    id: src.id, name: src.name, description: src.description ?? null, kind: src.kind, origin: src.origin, status: src.status, statusReason: src.statusReason ?? null,
    entityType: src.entityType, refreshMode: src.refreshMode, intervalMinutes: src.intervalMinutes ?? null, staleAfterDays: src.staleAfterDays ?? null, synthetic: src.synthetic,
    records: src.records, mappingVersion: src.mappingVersion, lastRefreshAt: src.lastRefreshAt ?? null, lastSuccessAt: src.lastSuccessAt ?? null, lastChangeAt: src.lastChangeAt ?? null,
    lastError: src.lastError ?? null, createdAt: src.createdAt, refresh: refreshStatement(src.kind, src.refreshMode, src.intervalMinutes),
    siteId: src.siteId ?? null, feedId: src.feedId ?? null, feedVersion: src.feedVersion ?? null, acquisition: src.acquisition ?? null,
    nextRefreshAt: src.refreshMode === "poll" && src.intervalMinutes ? new Date(Date.parse(src.lastRefreshAt ?? src.createdAt) + src.intervalMinutes * 60_000).toISOString() : null,
    overdue: src.refreshMode === "poll" && src.intervalMinutes && ageDays !== null ? ageDays * 1440 > src.intervalMinutes * 2 : false,
    stale: src.staleAfterDays && ageDays !== null && src.refreshMode !== "capture" && src.refreshMode !== "push" ? ageDays > src.staleAfterDays : false,
    config: (() => { const c = parse<Record<string, unknown>>(src.config, {}); return { url: c.url ?? null, format: c.format ?? null, recordsPath: c.recordsPath ?? null }; })(),
  };
}

export const list = app.query({
  access: "signal.read",
  args: { includeRemoved: s.optional(s.boolean()) },
  handler: async (ctx, a) => (await ctx.db.find(sources, { ownerId: ctx.auth.requirePrincipal().id })).filter((x) => a.includeRemoved || x.status !== "removed").map(view),
});

export const get = app.query({
  access: "signal.read",
  args: { sourceId: s.string() },
  handler: async (ctx, { sourceId }) => {
    const src = requireFound(await ctx.db.get(sources, sourceId), "That source");
    const cur = (await ctx.db.find(observations, { sourceId, status: "current" })).map(storedObservation);
    const ls = await ctx.db.find(links, { sourceId });
    const ings = await ctx.db.find(ingestions, { sourceId }, { orderBy: [{ field: "seq", direction: "desc" }], limit: 25 });
    const curKeys = new Set(cur.map((o) => o.recordKey));
    return {
      source: view(src),
      mapping: parse(src.mapping),
      coverage: coverage(cur, ls.filter((l: any) => curKeys.has(l.recordKey)).map((l: any) => l.status)),
      ingestions: ings.map((i: any) => ({ id: i.id, seq: i.seq, at: i.at, trigger: i.trigger, status: i.status, received: i.received, added: i.added, changed: i.changed, unchanged: i.unchanged, retracted: i.retracted, mappingVersion: i.mappingVersion, error: i.error ?? null, issues: parse(i.issues), provenance: parse(i.provenance), rawHash: i.rawHash ?? null, durationMs: i.durationMs ?? null })),
      records: cur.slice(0, 200).map((o) => ({ recordKey: o.recordKey, version: o.version, observedAt: o.observedAt, validAt: o.validAt, locator: o.locator, label: o.identity.address ?? o.identity.name ?? o.recordKey, link: (() => { const l = ls.find((x: any) => x.recordKey === o.recordKey); return l ? { entityId: l.entityId, status: l.status, basis: l.basis, reason: l.reason } : null; })() })),
    };
  },
});

/**
 * Polled sources whose interval has elapsed. The extension's scheduler calls this while the browser runs:
 * server-acquired feeds are then fetched by Signal (sources:refresh), browser-acquired ones by the extension with
 * the user's own session (then recorded with sources:recordFetch). Nothing polls while no browser is running
 * (GAP_REGISTER G-PLAT-1).
 */
export const due = app.query({
  access: "signal.write",
  handler: async (ctx) => {
    const now = Date.now();
    return (await ctx.db.find(sources, { ownerId: ctx.auth.requirePrincipal().id }))
      .filter((x) => (x.kind === "http_json" || x.kind === "site_feed") && (x.status === "connected" || x.status === "unavailable") && x.intervalMinutes && now - Date.parse(x.lastRefreshAt ?? x.createdAt) >= x.intervalMinutes * 60_000 - 5_000)
      .map((x) => ({ sourceId: x.id, name: x.name, acquisition: x.kind === "http_json" ? "server" : x.acquisition ?? "server", url: x.acquisition === "browser" ? parse<{ url: string }>(x.config).url : null, etag: x.etag ?? null, lastModified: x.lastModified ?? null }));
  },
});
