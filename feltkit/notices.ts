import { fail, s } from "@feltdb/feltkit";
import { app, findings, notices, preferences } from "./app.js";
import { json, loadPrefs, parse, requireFound } from "./_store.js";
import { atLeast, normalizePrefs, type NotificationPrefs } from "../lib/engine/notify.ts";

/**
 * Signal's notifications: one durable inbox per person, created by the engine on meaningful events only.
 * Every surface (the web app, the extension's overlay and browser notifications) reads it; acknowledging or
 * snoozing a notice never deletes it.
 */

const View = s.object({
  id: s.string(), kind: s.string(), severity: s.string(), priority: s.number(), title: s.string(), body: s.string(),
  findingId: s.nullable(s.string()), sourceId: s.nullable(s.string()), entityId: s.nullable(s.string()), urls: s.array(s.string()),
  createdAt: s.string(), acknowledged: s.boolean(), snoozedUntil: s.nullable(s.string()), delivered: s.boolean(), active: s.boolean(),
});

const view = (n: any, now: string) => ({
  id: n.id, kind: n.kind, severity: n.severity, priority: n.priority, title: n.title, body: n.body, findingId: n.findingId ?? null, sourceId: n.sourceId ?? null,
  entityId: n.entityId ?? null, urls: n.urls, createdAt: n.createdAt, acknowledged: Boolean(n.ackAt), snoozedUntil: n.snoozedUntil ?? null, delivered: Boolean(n.deliveredAt),
  active: !n.ackAt && !(n.snoozedUntil && n.snoozedUntil > now),
});

export const list = app.query({
  access: "signal.read",
  args: { active: s.optional(s.boolean()), since: s.optional(s.string()), limit: s.optional(s.integer()) },
  returns: s.array(View),
  capability: { name: "signal.notices.list", description: "The caller's Signal notifications, newest first: new, changed, resolved and reopened findings and source problems, with acknowledgement and snooze state." },
  handler: async (ctx, a) => {
    const ownerId = ctx.auth.requirePrincipal().id;
    const now = new Date().toISOString();
    const rows = await ctx.db.find(notices, { ownerId }, { orderBy: [{ field: "createdAt", direction: "desc" }], limit: Math.min(a.limit ?? 100, 500) });
    return rows.map((n) => view(n, now)).filter((n) => (!a.active || n.active) && (!a.since || n.createdAt > a.since));
  },
});

/**
 * What a browser should show as a notification now: active, not yet shown, at or above the person's minimum
 * severity, if they want browser notifications at all. The extension marks what it showed with `delivered`.
 */
export const pending = app.query({
  access: "signal.read",
  handler: async (ctx) => {
    const ownerId = ctx.auth.requirePrincipal().id;
    const prefs = await loadPrefs(ctx, ownerId);
    const now = new Date().toISOString();
    if (!prefs.browser) return { prefs, notices: [] };
    const rows = await ctx.db.find(notices, { ownerId }, { orderBy: [{ field: "createdAt", direction: "desc" }], limit: 50 });
    return { prefs, notices: rows.filter((n) => !n.deliveredAt && !n.ackAt && !(n.snoozedUntil && n.snoozedUntil > now) && atLeast(n.severity, prefs.minSeverity)).map((n) => view(n, now)) };
  },
});

export const delivered = app.mutation({
  access: "signal.read",
  args: { noticeIds: s.array(s.string(), { maxItems: 50 }) },
  handler: async (ctx, a) => {
    const ownerId = ctx.auth.requirePrincipal().id;
    const at = new Date().toISOString();
    let n = 0;
    for (const id of a.noticeIds) { const r = await ctx.db.get(notices, id); if (r && r.ownerId === ownerId && !r.deliveredAt) { await ctx.db.patch(notices, id, { deliveredAt: at }); n++; } }
    return { marked: n };
  },
});

export const acknowledge = app.mutation({
  access: "signal.write",
  args: { noticeId: s.optional(s.string()), all: s.optional(s.boolean()) },
  handler: async (ctx, a) => {
    const ownerId = ctx.auth.requirePrincipal().id;
    const at = new Date().toISOString();
    const rows = a.all ? (await ctx.db.find(notices, { ownerId })).filter((n) => !n.ackAt) : [requireFound(await ctx.db.get(notices, a.noticeId ?? ""), "That notice")];
    for (const r of rows) await ctx.db.patch(notices, r.id, { ackAt: at });
    return { acknowledged: rows.length };
  },
});

export const snooze = app.mutation({
  access: "signal.write",
  args: { noticeId: s.string(), hours: s.number() },
  handler: async (ctx, a) => {
    if (!(a.hours > 0 && a.hours <= 24 * 30)) fail("INVALID_ARGUMENT", "Snooze for 1 hour to 30 days.");
    const until = new Date(Date.now() + a.hours * 3_600_000).toISOString();
    requireFound(await ctx.db.get(notices, a.noticeId), "That notice");
    await ctx.db.patch(notices, a.noticeId, { snoozedUntil: until });
    return { snoozedUntil: until };
  },
});

/** Snooze a finding: hidden from the feed and silent until then; it keeps being evaluated and keeps its history. */
export const snoozeFinding = app.mutation({
  access: "signal.write",
  args: { findingId: s.string(), hours: s.number() },
  handler: async (ctx, a) => {
    if (!(a.hours >= 0 && a.hours <= 24 * 30)) fail("INVALID_ARGUMENT", "Snooze for up to 30 days (0 to unsnooze).");
    requireFound(await ctx.db.get(findings, a.findingId), "That finding");
    const until = a.hours ? new Date(Date.now() + a.hours * 3_600_000).toISOString() : undefined;
    await ctx.db.patch(findings, a.findingId, { snoozedUntil: until });
    for (const n of await ctx.db.find(notices, { findingId: a.findingId })) if (!n.ackAt) await ctx.db.patch(notices, n.id, { snoozedUntil: until });
    return { snoozedUntil: until ?? null };
  },
});

export const getPreferences = app.query({
  access: "signal.read",
  handler: async (ctx) => loadPrefs(ctx, ctx.auth.requirePrincipal().id),
});

export const setPreferences = app.mutation({
  access: "signal.write",
  args: { prefs: s.string({ maxLength: 4000 }) },
  handler: async (ctx, a) => {
    const ownerId = ctx.auth.requirePrincipal().id;
    let p: NotificationPrefs;
    try { p = normalizePrefs(JSON.parse(a.prefs)); } catch { return fail("INVALID_ARGUMENT", "Preferences must be JSON."); }
    if (!["info", "warning", "critical"].includes(p.minSeverity)) fail("INVALID_ARGUMENT", "minSeverity must be info, warning or critical.");
    const [cur] = await ctx.db.find(preferences, { ownerId });
    const at = new Date().toISOString();
    if (cur) await ctx.db.patch(preferences, cur.id, { prefs: json(p), updatedAt: at });
    else await ctx.db.insert(preferences, { prefs: json(p), updatedAt: at, ownerId });
    return p;
  },
});

export const summary = app.query({
  access: "signal.read",
  handler: async (ctx) => {
    const ownerId = ctx.auth.requirePrincipal().id;
    const now = new Date().toISOString();
    const rows = await ctx.db.find(notices, { ownerId }, { orderBy: [{ field: "createdAt", direction: "desc" }], limit: 200 });
    const active = rows.map((n) => view(n, now)).filter((n) => n.active);
    return { active: active.length, critical: active.filter((n) => n.severity === "critical").length, latest: active[0]?.createdAt ?? null };
  },
});

void parse;
