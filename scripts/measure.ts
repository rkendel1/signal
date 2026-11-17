/**
 * Real measurements of the pipeline on a real FeltDB instance (FeltKit createTestApp), at several sizes.
 * Data is SYNTHETIC (generated listings + parcels); this measures cost, not accuracy.
 *
 *   node scripts/measure.ts [sizes…]      → JSON on stdout (default sizes: 100 500 1000)
 *
 * What is measured, each end to end through the FeltKit function call (validation, authorization, transaction):
 *   initialListings   create a push source with N listings (ingest + identity, no criteria yet)
 *   initialParcels    create a file source with N parcels (ingest + identity + linking)
 *   criteriaFull      save criteria: full evaluation of every entity
 *   pushOneChange     push 1 changed listing: version, re-link, re-evaluate 1 entity, finding event  ← the "live" path
 *   pushDuplicate     push the same record again: recognised as no new information
 *   uploadNoChange    re-upload the same N-parcel file: N records compared, nothing re-evaluated
 *   uploadOneChange   re-upload with one parcel changed: N compared, 1 entity re-evaluated
 *   listFindings      findings:list (priority order) as the UI calls it
 *   getFinding        findings:get (full evidence trail)
 */
import { createTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.ts";
import { EXAMPLE_CRITERIA, LISTINGS_MAPPING, PARCELS_MAPPING } from "../lib/example.ts";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

function data(n: number) {
  const listings = [], parcels = [];
  for (let i = 0; i < n; i++) {
    const lat = +(30 + (i % 100) * 0.003).toFixed(6), lng = +(-90 + Math.floor(i / 100) * 0.004).toFixed(6);
    const assessed = 200_000 + ((i * 7919) % 300_000);
    listings.push({ listing_id: `L${i}`, address: `${100 + i} Test Street`, lat, lng, price: Math.round(assessed * (0.85 + ((i * 31) % 40) / 100)), beds: 2 + (i % 4), baths: 1 + (i % 3), sqft: 1000 + (i % 1500), status: "active", parcel_ref: "" });
    parcels.push({ parcel_id: `P${i}`, site_address: `${100 + i} Test St`, latitude: lat + 0.00003, longitude: lng, assessed_value: assessed, annual_tax: Math.round(assessed * 0.018), year_built: 1950 + (i % 70), flood_zone: i % 9 === 0 ? "AE" : "X", land_use: "residential" });
  }
  return { listings, parcels };
}
const csv = (rows: Array<Record<string, unknown>>) => [Object.keys(rows[0]).join(","), ...rows.map((r) => Object.values(r).join(","))].join("\n") + "\n";
const PARCEL_CSV_MAPPING = { ...PARCELS_MAPPING, fields: [...PARCELS_MAPPING.fields, { source: "latitude", attribute: "latitude", type: "number", role: "latitude" }, { source: "longitude", attribute: "longitude", type: "number", role: "longitude" }] };

async function time<T>(f: () => Promise<T>): Promise<[number, T]> { const t = performance.now(); const r = await f(); return [Math.round((performance.now() - t) * 10) / 10, r]; }

async function measure(n: number) {
  const app = await createTestApp();
  const ada = app.as("ada");
  const { listings, parcels } = data(n);
  const out: Record<string, unknown> = { n };
  try {
    const [t1, lid] = await time(() => ada.mutation(api.sources.create, { name: "listings", kind: "push", entityType: "property", mapping: JSON.stringify(LISTINGS_MAPPING), content: JSON.stringify(listings), synthetic: true }) as Promise<string>);
    out.initialListingsMs = t1;
    const [t2, pid] = await time(() => ada.mutation(api.sources.create, { name: "parcels", kind: "file", entityType: "property", config: JSON.stringify({ format: "csv" }), mapping: JSON.stringify(PARCEL_CSV_MAPPING), content: csv(parcels), synthetic: true }) as Promise<string>);
    out.initialParcelsMs = t2;
    const links = ((await ada.query(api.sources.get, { sourceId: pid })) as Any).coverage.links;
    out.parcelLinks = links;
    const [t3, saved] = await time(() => ada.mutation(api.criteria.save, { definition: JSON.stringify(EXAMPLE_CRITERIA) }) as Promise<Any>);
    out.criteriaFullMs = t3; out.criteriaRun = saved.run;
    const target = listings.find((l, i) => i % 9 !== 0 && l.price <= 450000 && l.price <= parcels[i].assessed_value && parcels[i].annual_tax < 7000)!; // a current match
    const [t4, r4] = await time(() => ada.mutation(api.sources.push, { sourceId: lid, records: JSON.stringify([{ ...target, price: target.price + 200_000 }]) }) as Promise<Any>);
    out.pushOneChangeMs = t4; out.pushOneChangeRun = r4.run;
    const [t5, r5] = await time(() => ada.mutation(api.sources.push, { sourceId: lid, records: JSON.stringify([{ ...target, price: target.price + 200_000 }]) }) as Promise<Any>);
    out.pushDuplicateMs = t5; out.pushDuplicateNewInformation = r5.newInformation;
    const [t6, r6] = await time(() => ada.mutation(api.sources.upload, { sourceId: pid, content: csv(parcels) }) as Promise<Any>);
    out.uploadNoChangeMs = t6; out.uploadNoChange = { unchanged: r6.unchanged, run: r6.run };
    const changed = parcels.map((p, i) => (i === 1 ? { ...p, annual_tax: p.annual_tax + 5000 } : p));
    const [t7, r7] = await time(() => ada.mutation(api.sources.upload, { sourceId: pid, content: csv(changed) }) as Promise<Any>);
    out.uploadOneChangeMs = t7; out.uploadOneChangeRun = r7.run;
    const [t8, list] = await time(() => ada.query(api.findings.list, {}) as Promise<Any[]>);
    out.listFindingsMs = t8; out.openFindings = list.length;
    if (list[0]) { const [t9] = await time(() => ada.query(api.findings.get, { findingId: list[0].id })); out.getFindingMs = t9; }
  } finally { await app.close(); }
  return out;
}

const sizes = process.argv.slice(2).map(Number).filter((x) => x > 0);
const results = [];
for (const n of sizes.length ? sizes : [100, 500, 1000]) { results.push(await measure(n)); console.error(`measured n=${n}`); }
console.log(JSON.stringify({ node: process.version, platform: `${process.platform}/${process.arch}`, at: new Date().toISOString(), synthetic: true, results }, null, 2));
