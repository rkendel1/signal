import { fail, s } from "@feltdb/feltkit";
import { app, pages } from "./app.js";
import { readPage, requireFound } from "./_shared.js";
import { discoverAugmented } from "../lib/datasets/resolve.ts";
import { loadDatasetSources } from "./datasets.js";
import { discover, facets, validateIntent, type DiscoveryIntent, type DiscoveryScope, type Enrichment } from "../lib/discovery/discover.ts";
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
  missing: s.array(s.string()), locators: s.array(s.string()), metrics: s.record(s.unknown()), changed: s.optional(s.object({ since: s.string(), fields: s.array(s.string()) })), evidenceRefs: s.array(s.string()),
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
  /** Present when datasets were used: per-dataset resolutions (matched / ambiguous / conflict / unmatched) and every augmented value with its provenance. */
  augmentation: s.optional(s.object({}, open)),
});

type QueryCtx = Parameters<Parameters<typeof app.query>[0]["handler"]>[0];

/** Load page representations, every one owned by the caller (the authorize hook checks single ids only). */
async function loadOwnPages(ctx: QueryCtx, ids: string[]): Promise<PageRepresentation[]> {
  const principal = ctx.auth.requirePrincipal();
  const admin = (principal as { roles?: string[] }).roles?.includes("admin");
  const out: PageRepresentation[] = [];
  for (const id of ids) {
    const rec = requireFound(await ctx.db.get(pages, id), "That page");
    if (!admin && rec.ownerId !== principal.id) fail("FORBIDDEN", "not the owner of every page");
    out.push(await readPage(ctx as never, rec.pageRef));
  }
  return out;
}

const FacetsResult = s.object({
  types: s.array(s.object({ type: s.string(), candidates: s.integer(), inCollections: s.integer(), label: s.string(), sample: s.array(s.string()) })),
  selected: s.array(s.string()),
  candidates: s.integer(),
  facets: s.array(s.object({
    attr: s.string(), label: s.string(), kind: s.enum(["range", "category", "boolean", "presence"] as const), present: s.integer(), of: s.integer(),
    min: s.optional(s.number()), max: s.optional(s.number()), currency: s.optional(s.nullable(s.string())), unit: s.optional(s.enum(["money", "number", "percent", "rating"] as const)),
    values: s.optional(s.array(s.object({ value: s.union([s.string(), s.number(), s.boolean()]), count: s.integer() }))),
  })),
});

/** What the pages offer to filter on: entity types and, for the selected types, ranges, categories and toggles. */
export const facetsOf = app.query({
  access: "signal.pages.read",
  args: { pageIds: s.array(s.string(), { minItems: 1, maxItems: MAX_PAGES }), types: s.optional(s.array(s.string({ maxLength: 200 }), { maxItems: 20 })) },
  returns: FacetsResult,
  capability: { name: "signal.discovery.facets", description: "List the entity types on recorded pages and, for the selected types, the attributes an intent can filter on: numeric ranges, categories with counts, booleans and presence." },
  handler: async (ctx, a) => JSON.parse(JSON.stringify(facets(await loadOwnPages(ctx, a.pageIds), a.types))) as never,
});

export const evaluate = app.query({
  access: "signal.pages.read",
  args: {
    pageIds: s.array(s.string(), { minItems: 1, maxItems: MAX_PAGES }),
    intent: s.string({ maxLength: 100_000 }),
    previousPageIds: s.optional(s.array(s.string(), { maxItems: MAX_PAGES })),
    enrichments: s.optional(s.string({ maxLength: MAX_JSON })),
    scope: s.optional(s.string({ maxLength: 10_000 })),
    /** Datasets (signal.datasets.*) whose reviewed mapping may enrich candidates. */
    datasetIds: s.optional(s.array(s.string(), { maxItems: 10 })),
  },
  returns: Result,
  capability: { name: "signal.discovery.evaluate", description: "Evaluate a discovery intent over recorded page representations: candidates with match/possible/non_match status, evidence, coverage and a scan plan." },
  handler: async (ctx, a) => {
    const load = (ids: string[]) => loadOwnPages(ctx, ids);
    const intent = parse<DiscoveryIntent>(a.intent, "intent");
    const invalid = validateIntent(intent);
    if (invalid.length) fail("INVALID_ARGUMENT", invalid.join("; "));
    const enrichments = a.enrichments ? parse<Enrichment[]>(a.enrichments, "enrichments") : undefined;
    if (enrichments && (!Array.isArray(enrichments) || enrichments.some((e) => !e?.source?.id || !Array.isArray(e.records)))) fail("INVALID_ARGUMENT", "enrichments must be [{source:{id,...}, records:[...]}]");
    const scope = a.scope ? parse<DiscoveryScope>(a.scope, "scope") : undefined;
    const current = await load(a.pageIds);
    if (a.datasetIds?.length) {
      const sources = await loadDatasetSources(ctx, a.datasetIds);
      const previousPages = a.previousPageIds?.length ? await load(a.previousPageIds) : undefined;
      const { result, augmentation } = discoverAugmented({ intent, pages: current, enrichments, scope, datasets: sources, previousPages });
      return JSON.parse(JSON.stringify({ ...result, augmentation })) as never;
    }
    const previous = a.previousPageIds?.length ? discover({ intent, pages: await load(a.previousPageIds), enrichments, scope }) : undefined;
    return JSON.parse(JSON.stringify(discover({ intent, pages: current, enrichments, scope, previous }))) as never;
  },
});
