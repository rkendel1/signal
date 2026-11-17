import { fail, s } from "@feltdb/feltkit";
import { app, pages, sources } from "./app.js";
import { api } from "./_generated/api.js";
import type { Observation, SourceDefinition } from "../lib/contracts/types.ts";
import { newId, sha256 } from "../lib/core/canonical.ts";
import { HttpSource } from "../lib/sources/sources.ts";
import { TENANT, json, netPolicy, parse, readPage, requireFound, storeObservation, storePage } from "./_shared.js";

/**
 * Universal page intelligence: understand what a page contains before anyone says
 * what matters. Inspection needs a registered (authorized) source, not a monitor or criteria.
 */

const self = api.pages as unknown as { record: never };
const MAX_BODY = 5_000_000;
const Summary = s.object({
  pageId: s.string(), observationId: s.string(), outcome: s.string(), revision: s.nullable(s.string()),
  entities: s.integer(), relationships: s.integer(), collections: s.integer(), signals: s.integer(), truncated: s.boolean(),
});

/** Fetch an http(s) source (robots.txt, SSRF guard, byte cap) and record its page representation. */
export const inspect = app.action({
  access: "signal.pages.inspect",
  args: { sourceId: s.string() },
  handler: async (ctx, { sourceId }) => {
    const src = (await ctx.runQuery(api.pages.source as never, { sourceId } as never)) as Record<string, any>;
    if (!/^https?:/i.test(src.locator)) fail("FAILED_PRECONDITION", "This source receives pushed content; use pages:push.");
    const def: SourceDefinition = {
      schema: "signal.source/v1", id: src.id, tenantId: TENANT, ownerId: src.ownerId, type: src.type, locator: src.locator,
      access: { authorization: src.authorization, respectRobots: src.respectRobots }, observation: { strategy: src.strategy }, createdAt: src.createdAt,
    };
    const r = await new HttpSource("http_page", netPolicy()).observe({ source: def, requestedAt: new Date().toISOString() });
    return ctx.runMutation(self.record, { sourceId, observation: json(r.observation), body: r.body ? new TextDecoder().decode(r.body) : undefined } as never) as Promise<Record<string, unknown>>;
  },
});

export const source = app.query({
  access: "signal.pages.inspect",
  args: { sourceId: s.string() },
  handler: async (ctx, { sourceId }) => requireFound(await ctx.db.get(sources, sourceId), "That source"),
});

/** Record an observation made by `inspect` (hash-checked) and its representation. */
export const record = app.mutation({
  access: "signal.pages.inspect",
  args: { sourceId: s.string(), observation: s.string(), body: s.optional(s.string({ maxLength: MAX_BODY })) },
  returns: Summary,
  handler: async (ctx, { sourceId, observation, body }) => {
    const obs = parse<Observation>(observation);
    const src = requireFound(await ctx.db.get(sources, sourceId), "That source");
    if (obs.schema !== "signal.observation/v1" || obs.sourceId !== sourceId) fail("INVALID_ARGUMENT", "Not an observation of this source.");
    if (obs.status === "ok" && (body === undefined || sha256(new TextEncoder().encode(body)) !== obs.contentHash)) fail("INVALID_ARGUMENT", "Body is missing or does not match the observation's contentHash.");
    return recordPage(ctx, src, obs, body);
  },
});

/**
 * Pushed DOM (e.g. a browser-rendered snapshot of a dynamic page) for a `dom` source.
 * Scripts in the content are never executed by Signal; the snapshot is data.
 */
export const push = app.mutation({
  access: "signal.pages.inspect",
  args: { sourceId: s.string(), html: s.string({ maxLength: MAX_BODY }), baseUrl: s.optional(s.string({ maxLength: 2048 })) },
  returns: Summary,
  capability: { name: "signal.pages.push", description: "Submit a rendered page (HTML) for a dom source and get its universal page representation." },
  handler: async (ctx, { sourceId, html, baseUrl }) => {
    const src = requireFound(await ctx.db.get(sources, sourceId), "That source");
    if (src.type !== "dom") fail("FAILED_PRECONDITION", "pages:push is for dom sources.");
    const bytes = new TextEncoder().encode(html);
    const obs: Observation = {
      schema: "signal.observation/v1", observationId: newId("obs"), tenantId: TENANT, sourceId, observedAt: new Date().toISOString(),
      status: "ok", contentHash: sha256(bytes), byteLength: bytes.byteLength, contentType: "text/html",
      provenance: { adapter: "pushed-dom@1", method: "PUSH", submittedBy: ctx.auth.requirePrincipal().id, ...(baseUrl && /^https?:/i.test(baseUrl) ? { finalUrl: baseUrl } : {}) },
    };
    return recordPage(ctx, src, obs, html);
  },
});

type Ctx = Parameters<Parameters<typeof app.mutation>[0]["handler"]>[0];

async function recordPage(ctx: Ctx, src: { id: string; locator: string; ownerId: string }, obs: Observation, body: string | undefined) {
  const [existing] = await ctx.db.find(pages, { observationId: obs.observationId });
  if (existing) return { pageId: existing.id, observationId: obs.observationId, outcome: "already_recorded", revision: existing.revision, entities: existing.entities, relationships: existing.relationships, collections: existing.collections, signals: existing.signals, truncated: existing.truncated };
  await storeObservation(ctx as never, obs, body, src.ownerId);
  if (obs.status !== "ok" || body === undefined) {
    return { pageId: "", observationId: obs.observationId, outcome: `observation_${obs.status}`, revision: null, entities: 0, relationships: 0, collections: 0, signals: 0, truncated: false };
  }
  if (!/html/i.test(obs.contentType ?? "")) fail("FAILED_PRECONDITION", `Page representation needs HTML; got ${obs.contentType ?? "unknown"}.`);
  const p = await storePage(ctx as never, obs, body, { id: src.id, locator: src.locator }, src.ownerId);
  const r = p.representation;
  return { pageId: p.recordId, observationId: obs.observationId, outcome: "represented", revision: r.revision, entities: r.entities.length, relationships: r.relationships.length, collections: r.collections.length, signals: r.signals.length, truncated: r.stats.truncated };
}

/** The full signal.page/v1 representation. */
export const get = app.query({
  access: "signal.pages.read",
  args: { pageId: s.string() },
  handler: async (ctx, { pageId }) => {
    const rec = requireFound(await ctx.db.get(pages, pageId), "That page");
    return readPage(ctx as never, rec.pageRef);
  },
});

/** Representations recorded for a source, newest first (summaries). */
export const list = app.query({
  access: "signal.pages.read",
  args: { sourceId: s.string() },
  handler: async (ctx, { sourceId }) => {
    requireFound(await ctx.db.get(sources, sourceId), "That source");
    const rows = await ctx.db.find(pages, { sourceId }, { orderBy: [{ field: "observedAt", direction: "desc" }] });
    return rows.map((r) => ({ pageId: r.id, observationId: r.observationId, observedAt: r.observedAt, revision: r.revision, entities: r.entities, relationships: r.relationships, collections: r.collections, truncated: r.truncated }));
  },
});
