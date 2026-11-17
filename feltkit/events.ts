import { s } from "@feltdb/feltkit";
import { app, events } from "./app.js";
import type { MatchedEvent } from "../lib/contracts/types.ts";
import { sha256 } from "../lib/core/canonical.ts";
import { eventView, parse, requireFound } from "./_shared.js";

/** The caller's events, newest first; optionally only those for one page/source locator (the overlay's question). */
export const list = app.query({
  access: "signal.events.read",
  args: { sourceLocator: s.optional(s.string()) },
  capability: { name: "signal.events.list", description: "List the caller's Signal events (criteria matches with evidence references), newest first." },
  returns: s.array(s.object({ id: s.string(), eventId: s.string(), criteriaName: s.string(), severity: s.string(), occurredAt: s.string(), sourceLocator: s.string(), acknowledged: s.boolean() })),
  handler: async (ctx, { sourceLocator }) => {
    const owner = ctx.auth.requirePrincipal().id;
    const rows = await ctx.db.find(events, { ownerId: owner, ...(sourceLocator ? { sourceLocator } : {}) }, { orderBy: [{ field: "occurredAt", direction: "desc" }] });
    return rows.map((r) => {
      const v = eventView(r);
      return { id: v.id, eventId: v.eventId, criteriaName: v.criteriaName, severity: v.severity, occurredAt: v.occurredAt, sourceLocator: v.sourceLocator, acknowledged: v.acknowledged };
    });
  },
});

/** Full events (signal.event/v1 bodies) for the overlay. */
export const forPage = app.query({
  access: "signal.events.read",
  args: { sourceLocator: s.string() },
  handler: async (ctx, { sourceLocator }) => {
    const rows = await ctx.db.find(events, { ownerId: ctx.auth.requirePrincipal().id, sourceLocator }, { orderBy: [{ field: "occurredAt", direction: "desc" }] });
    return rows.map(eventView);
  },
});

/**
 * An event with its preserved evidence: the exact observed bytes (hash re-verified on
 * read) and the normalized text criteria ran against.
 */
export const evidence = app.query({
  access: "signal.events.read",
  args: { eventId: s.string() },
  handler: async (ctx, { eventId }) => {
    const rec = requireFound(await ctx.db.get(events, eventId), "That event");
    const e = parse<MatchedEvent>(rec.body);
    const read = async (ref: string) => (await ctx.services.files.read(ref.replace(/^files:/, ""))).text();
    const raw = await read(e.evidence.observationRef);
    const normalizedText = await read(e.evidence.normalizedTextRef);
    const verified = sha256(new TextEncoder().encode(raw)) === e.evidence.contentHash;
    return { event: eventView(rec), raw, normalizedText, verified };
  },
});

export const acknowledge = app.mutation({
  access: "signal.events.ack",
  args: { eventId: s.string() },
  handler: async (ctx, { eventId }) => {
    const rec = requireFound(await ctx.db.get(events, eventId), "That event");
    if (rec.acknowledgedAt) return { acknowledgedAt: rec.acknowledgedAt };
    const at = new Date().toISOString();
    await ctx.db.patch(events, eventId, { acknowledgedAt: at, acknowledgedBy: ctx.auth.requirePrincipal().id });
    return { acknowledgedAt: at };
  },
});

/** The caller's Signal notifications (AppPort Services Notifications; each principal reads only its own). */
export const inbox = app.query({
  access: "notifications.read",
  args: { unread: s.optional(s.boolean()) },
  handler: async (ctx, { unread }) =>
    (await ctx.services.notifications.list(unread ? { unread: true } : {}))
      .filter((n) => n.type === "signal.criteria_matched")
      .map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body ?? null, data: n.data ?? null, createdAt: n.createdAt, read: Boolean(n.readAt) })),
});
