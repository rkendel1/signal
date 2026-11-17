import { fail, s } from "@feltdb/feltkit";
import { app, pages } from "./app.js";
import { readPage, requireFound } from "./_shared.js";
import { discover, validateIntent, type DiscoveryIntent, type DiscoveryScope, type Enrichment } from "../lib/discovery/discover.ts";
import type { PageRepresentation } from "../lib/page/types.ts";

/**
 * Discovery over recorded page representations (signal.discovery/v1). Read-only: nothing is fetched
 * and nothing is persisted. The result is recomputed from durable pages, so it needs no store of its own.
 * Enrichments are caller-supplied external values and are labelled as such in every result.
 */

const MAX_PAGES = 20;
const MAX_JSON = 1_000_000;
const parse = <T>(text: string, what: string): T => { try { return JSON.parse(text) as T; } catch { return fail("INVALID_ARGUMENT", `${what} is not valid JSON`); } };

const open = { additionalProperties: true } as const;
const Candidate = s.object({
  key: s.string(), entityIds: s.array(s.string()), type: s.string(), name: s.nullable(s.string()),
  status: s.enum(["match", "possible", "non_match", "out_of_scope"] as const),
  criteria: s.array(s.object({ id: s.string(), label: s.string(), result: s.enum(["true", "false", "unknown"] as const), reason: s.optional(s.string()), values: s.array(s.unknown()), provenance: s.array(s.string()) })),
  missing: s.array(s.string()), metrics: s.record(s.unknown()), changed: s.optional(s.object({ since: s.string(), fields: s.array(s.string()) })), evidenceRefs: s.array(s.string()),
});
const n = s.integer();
const Result = s.object({
  schema: s.literal("signal.discovery/v1"),
  intent: s.object({ id: s.string(), version: s.integer() }),
  context: s.object({}, open),
  scope: s.object({ source: s.string() }, open),
  candidates: s.array(Candidate),
  coverage: s.object({
    pagesExamined: n, declaredTotal: s.nullable(n), listed: n, nonTarget: n, discovered: n, extracted: n, categorized: n, inScope: n,
    evaluated: n, partiallyEvaluated: n, ambiguous: n, outOfScope: n, notYetExamined: s.nullable(n),
    unavailable: s.array(s.object({ what: s.string(), why: s.string() })), exhaustive: s.boolean(), exhaustiveBasis: s.string(),
  }),
  plan: s.array(s.object({ kind: s.string(), target: s.string(), reason: s.string(), executesIn: s.enum(["browser-session", "background", "user"] as const), priority: n })),
  pages: s.array(s.object({ observationId: s.string(), revision: s.string(), factsRevision: s.string() })),
  resultDigest: s.string(),
});

export const evaluate = app.query({
  access: "signal.pages.read",
  args: {
    pageIds: s.array(s.string(), { minItems: 1, maxItems: MAX_PAGES }),
    intent: s.string({ maxLength: 100_000 }),
    previousPageIds: s.optional(s.array(s.string(), { maxItems: MAX_PAGES })),
    enrichments: s.optional(s.string({ maxLength: MAX_JSON })),
    scope: s.optional(s.string({ maxLength: 10_000 })),
  },
  returns: Result,
  capability: { name: "signal.discovery.evaluate", description: "Evaluate a discovery intent over recorded page representations: candidates with match/possible/non_match status, evidence, coverage and a scan plan." },
  handler: async (ctx, a) => {
    // The authorize hook checks a single pageId; lists are checked here, per page.
    const principal = ctx.auth.requirePrincipal();
    const admin = (principal as { roles?: string[] }).roles?.includes("admin");
    const load = async (ids: string[]): Promise<PageRepresentation[]> => {
      const out: PageRepresentation[] = [];
      for (const id of ids) {
        const rec = requireFound(await ctx.db.get(pages, id), "That page");
        if (!admin && rec.ownerId !== principal.id) fail("FORBIDDEN", "not the owner of every page");
        out.push(await readPage(ctx as never, rec.pageRef));
      }
      return out;
    };
    const intent = parse<DiscoveryIntent>(a.intent, "intent");
    const invalid = validateIntent(intent);
    if (invalid.length) fail("INVALID_ARGUMENT", invalid.join("; "));
    const enrichments = a.enrichments ? parse<Enrichment[]>(a.enrichments, "enrichments") : undefined;
    if (enrichments && (!Array.isArray(enrichments) || enrichments.some((e) => !e?.source?.id || !Array.isArray(e.records)))) fail("INVALID_ARGUMENT", "enrichments must be [{source:{id,...}, records:[...]}]");
    const scope = a.scope ? parse<DiscoveryScope>(a.scope, "scope") : undefined;
    const current = await load(a.pageIds);
    const previous = a.previousPageIds?.length ? discover({ intent, pages: await load(a.previousPageIds), enrichments, scope }) : undefined;
    return JSON.parse(JSON.stringify(discover({ intent, pages: current, enrichments, scope, previous }))) as never;
  },
});
