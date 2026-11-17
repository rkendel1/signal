import { fail, s } from "@feltdb/feltkit";
import { app, sources } from "./app.js";
import { assertUrlShapeAllowed, BlockedUrlError } from "../lib/sources/net-guard.ts";
import { netPolicy } from "./_shared.js";

/** Register an authorized observation source. URLs are checked here (shape) and again, with DNS, at every fetch. */
export const register = app.mutation({
  access: "signal.sources.write",
  args: {
    type: s.union([s.literal("http_page"), s.literal("text"), s.literal("json"), s.literal("dom")]),
    locator: s.string({ minLength: 1, maxLength: 2048 }),
    strategy: s.union([s.literal("manual"), s.literal("poll"), s.literal("event")]),
    intervalSeconds: s.optional(s.integer()),
    respectRobots: s.optional(s.boolean()),
  },
  returns: s.string(),
  capability: { name: "signal.sources.register", description: "Register a source Signal may observe: a public web page (http_page/json URL) or pushed content (text/json/dom)." },
  handler: async (ctx, a) => {
    const isHttp = /^https?:/i.test(a.locator);
    if (a.type === "http_page" && !isHttp) fail("INVALID_ARGUMENT", "http_page sources need an absolute http(s) URL.");
    if (!isHttp && a.strategy === "poll") fail("INVALID_ARGUMENT", "Only http(s) sources can be polled; pushed sources use strategy event or manual.");
    if (isHttp) {
      try { assertUrlShapeAllowed(a.locator, netPolicy()); } catch (e) {
        if (e instanceof BlockedUrlError) fail("INVALID_ARGUMENT", e.message);
        throw e;
      }
    }
    return ctx.db.insert(sources, {
      type: a.type, locator: a.locator, authorization: "public", respectRobots: a.respectRobots ?? true, strategy: a.strategy,
      ...(a.strategy === "poll" ? { intervalSeconds: Math.max(300, a.intervalSeconds ?? 3600) } : {}),
      ownerId: ctx.auth.requirePrincipal().id, createdAt: new Date().toISOString(),
    });
  },
});

export const list = app.query({
  access: "signal.sources.read",
  handler: async (ctx) => ctx.db.find(sources, { ownerId: ctx.auth.requirePrincipal().id }),
});
