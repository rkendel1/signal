import { fail } from "@feltdb/feltkit";
import { app, sources } from "./app.js";
import { api } from "./_generated/api.js";
import { EXAMPLE_CRITERIA, LISTINGS_MAPPING, PARCELS_MAPPING, exampleData, listingsCsv, parcelsGeoJson } from "../lib/example.ts";

const self = api as unknown as { sources: { create: never }; criteria: { save: never } };

/**
 * Load the SYNTHETIC example: two sources (a listings file and a parcel GeoJSON) and one criteria. Both sources
 * are flagged `synthetic`, and every finding built on them says so.
 */
export const loadExample = app.action({
  access: "signal.write",
  handler: async (ctx) => {
    const existing = (await ctx.runQuery(api.sources.list as never, {} as never)) as Array<{ synthetic: boolean }>;
    if (existing.some((x) => x.synthetic)) fail("FAILED_PRECONDITION", "The synthetic example is already loaded.");
    const { listings, parcels } = exampleData();
    const listingsId = await ctx.runMutation(self.sources.create, { name: "Example listings (synthetic)", kind: "file", entityType: "property", config: JSON.stringify({ format: "csv" }), mapping: JSON.stringify(LISTINGS_MAPPING), content: listingsCsv(listings), synthetic: true, staleAfterDays: 30, description: "Invented listings in a fictional city, for trying Signal. Not real data." } as never);
    const parcelsId = await ctx.runMutation(self.sources.create, { name: "Example county parcels (synthetic)", kind: "file", entityType: "property", config: JSON.stringify({ format: "geojson" }), mapping: JSON.stringify(PARCELS_MAPPING), content: parcelsGeoJson(parcels), dataAsOf: "2026-07-01T00:00:00.000Z", synthetic: true, staleAfterDays: 540, description: "Invented parcel assessments matching the example listings. Not real data." } as never);
    const crit = await ctx.runMutation(self.criteria.save, { definition: JSON.stringify(EXAMPLE_CRITERIA) } as never);
    return { listingsId, parcelsId, criteria: crit };
  },
});

void sources;
