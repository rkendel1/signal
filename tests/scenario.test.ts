/**
 * The product, end to end, against a real FeltDB instance (FeltKit createTestApp) and a real HTTP server.
 * Data is the SYNTHETIC example (lib/example.ts): this proves behaviour, not real-world accuracy.
 *
 * Steps follow the required scenario: connect two different sources → inspect coverage and provenance →
 * define criteria that need both → evaluate existing information → a finding supported by both → change one
 * observation → finding changes / resolves → originals preserved → change the criterion → full evidence trail.
 * Then: ambiguity, conflicts, stale data, an unavailable source, duplicate updates, no results, removing a
 * source, criteria change while monitoring, durability across restart, authorization.
 */
process.env.SIGNAL_ALLOW_PRIVATE_HOSTS = "127.0.0.1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.ts";
import { EXAMPLE_CRITERIA, LISTINGS_MAPPING, PARCELS_MAPPING, exampleData, parcelsGeoJson } from "../lib/example.ts";
import { fixture } from "./helpers.ts";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

test("Signal end to end: sources → criteria → findings → change → evidence", async (t) => {
  const http = await fixture();
  const app = await createTestApp();
  const ada = app.as("ada");
  const { listings, parcels } = exampleData();
  const serve = (ls: typeof listings, etag?: string) => http.set("/api/listings", { body: JSON.stringify({ count: ls.length, listings: ls }), type: "application/json", ...(etag ? { etag } : {}) });
  const timings: Record<string, number> = {};
  const timed = async <T>(name: string, f: () => Promise<T>): Promise<T> => { const t0 = performance.now(); const r = await f(); timings[name] = Math.round(performance.now() - t0); return r; };
  try {
    // ---------------------------------------------------------------- 1. connect two different sources
    serve(listings, '"v1"');
    const listingsId: string = await ada.mutation(api.sources.create, { name: "Listings API (synthetic)", kind: "http_json", entityType: "property", config: JSON.stringify({ url: `${http.url}/api/listings`, recordsPath: "listings" }), mapping: JSON.stringify(LISTINGS_MAPPING), synthetic: true, intervalMinutes: 15 });
    const first: Any = await timed("refresh-38", () => ada.action(api.sources.refresh, { sourceId: listingsId }));
    assert.equal(first.status, "ok"); assert.equal(first.added, 38); assert.equal(first.run.evaluations, 0, "no criteria yet: observations only");

    const inspected: Any = await ada.query(api.sources.inspect, { kind: "file", content: parcelsGeoJson(parcels), format: "geojson", entityType: "property" });
    assert.equal(inspected.rows, 38); assert.equal(inspected.withGeometry, 38);
    assert.equal(inspected.mapping.fields.find((f: Any) => f.source === "parcel_id").role, "id", "proposal recognises the parcel id");
    const parcelsId: string = await timed("upload-38", () => ada.mutation(api.sources.create, { name: "County parcels (synthetic)", kind: "file", entityType: "property", config: JSON.stringify({ format: "geojson" }), mapping: JSON.stringify(PARCELS_MAPPING), content: parcelsGeoJson(parcels), dataAsOf: "2026-07-01T00:00:00.000Z", staleAfterDays: 540, synthetic: true }));

    // ---------------------------------------------------------------- 2. coverage and provenance
    const pDetail: Any = await ada.query(api.sources.get, { sourceId: parcelsId });
    assert.equal(pDetail.coverage.records, 38);
    assert.equal(pDetail.coverage.identity.withId, 38);
    assert.equal(pDetail.coverage.validAt.min, "2026-07-01T00:00:00.000Z");
    assert.ok(pDetail.coverage.links.probable >= 33, JSON.stringify(pDetail.coverage.links));
    assert.equal(pDetail.coverage.links.exact, 1, "parcel 34 joined by its id alone");
    assert.equal(pDetail.coverage.links.conflict, 1, "parcel 36: same address, 600 m away");
    assert.equal(pDetail.coverage.links.ambiguous, 1, "duplex: a second parcel for an entity this source already describes");
    assert.match(pDetail.source.refresh, /Snapshot/);
    const lDetail: Any = await ada.query(api.sources.get, { sourceId: listingsId });
    assert.match(lDetail.source.refresh, /Polled/);
    assert.equal(lDetail.ingestions[0].provenance.httpStatus, 200);
    assert.ok(lDetail.ingestions[0].rawHash, "the exact bytes fetched are kept (Files) and hashed");

    // ---------------------------------------------------------------- 3–5. criteria needing both sources; evaluate existing information
    const saved: Any = await timed("criteria-v1", () => ada.mutation(api.criteria.save, { definition: JSON.stringify(EXAMPLE_CRITERIA) }));
    const critId = saved.criteriaId;
    assert.equal(saved.version, 1); assert.ok(saved.run.evaluations >= 38);
    const open: Any[] = await ada.query(api.findings.list, {});
    const matches = open.filter((f) => f.qualification === "match");
    assert.ok(matches.length > 0, "something qualifies");
    for (let i = 1; i < open.length; i++) assert.ok(open[i - 1].priority >= open[i].priority, "feed is in priority order");
    const both = matches.find((f) => f.sourceCount === 2)!;
    assert.ok(both, "a match supported by both sources");
    assert.equal(both.synthetic, true, "synthetic evidence is labelled");
    const detail: Any = await ada.query(api.findings.get, { findingId: both.id });
    const sourcesUsed = new Set(detail.evidence.map((e: Any) => e.source.name));
    assert.deepEqual([...sourcesUsed].sort(), ["County parcels (synthetic)", "Listings API (synthetic)"]);
    const ratio = detail.explanation.require.find((n: Any) => n.leaf?.attr === "priceToAssessed");
    assert.equal(ratio.result, "true");
    assert.deepEqual(ratio.leaf.values[0].inputs.map((i: Any) => i.attr), ["price", "assessedValue"], "derived value names its inputs");
    assert.equal(detail.history[0].kind, "new");
    assert.equal(detail.history[0].cause.kind, "criteria");

    // possible: listing 35 has no parcel → missing ≠ negative
    const l35 = listings[35];
    const missingOne = open.find((f) => f.entityLabel?.startsWith(l35.address.split(",")[0]));
    if (l35.price <= 450000) { assert.ok(missingOne, "listing without parcel evidence is surfaced as possible"); assert.equal(missingOne!.qualification, "possible"); assert.equal(missingOne!.hasMissing, true); }

    // ---------------------------------------------------------------- 6–7. change one source observation
    const entityId = both.entityId;
    const ent: Any = await ada.query(api.entities.get, { entityId });
    const listingRec = ent.records.find((r: Any) => r.source.id === listingsId);
    const idx = listings.findIndex((l) => l.listing_id === listingRec.recordKey);
    const assessed = ent.matrix.find((m: Any) => m.attr === "assessedValue").cells.find(Boolean).value.amount;

    // a duplicate refresh: same bytes → not new information, nothing evaluated
    const dup: Any = await ada.action(api.sources.refresh, { sourceId: listingsId });
    assert.equal(dup.status, "not_modified", "etag honoured");
    serve(listings); // same body, no etag
    const dup2: Any = await ada.action(api.sources.refresh, { sourceId: listingsId });
    assert.equal(dup2.newInformation, false); assert.equal(dup2.unchanged, 38); assert.equal(dup2.run, null);

    // below the 1% threshold: a new observation version, but not a meaningful change
    const nudged = listings.map((l, i) => (i === idx ? { ...l, price: l.price - 1000 } : l));
    serve(nudged);
    const r1: Any = await timed("refresh-1-change", () => ada.action(api.sources.refresh, { sourceId: listingsId }));
    assert.equal(r1.changed, 1); assert.equal(r1.affectedEntities, 1, "incremental: only the affected entity is re-evaluated");
    let h: Any = await ada.query(api.findings.get, { findingId: both.id });
    if (Math.abs(1000 / listings[idx].price) < 0.01) assert.equal(h.history.length, 1, "below threshold: no event");

    // above the assessed value: the finding resolves
    const pricier = nudged.map((l, i) => (i === idx ? { ...l, price: assessed + 50_000 } : l));
    serve(pricier);
    const r2: Any = await ada.action(api.sources.refresh, { sourceId: listingsId });
    assert.equal(r2.run.closed, 1);
    h = await ada.query(api.findings.get, { findingId: both.id });
    assert.equal(h.finding.status, "resolved");
    assert.equal(h.history.at(-1).kind, "resolved");
    assert.ok(h.history.at(-1).diff.some((d: Any) => d.what === "price"));

    // ---------------------------------------------------------------- 8. originals preserved
    const ent2: Any = await ada.query(api.entities.get, { entityId });
    const versions = ent2.records.find((r: Any) => r.source.id === listingsId).versions;
    assert.equal(versions.length, 3, "v1 original, v2 nudge, v3 price rise");
    assert.equal(versions.at(-1).attributes.price.value.amount, listings[idx].price, "the first observation is intact");
    assert.equal(versions.at(-1).status, "superseded");

    // back under: reopened
    serve(listings);
    const r3: Any = await ada.action(api.sources.refresh, { sourceId: listingsId });
    assert.equal(r3.run.reopened, 1);
    assert.equal((await ada.query(api.findings.get, { findingId: both.id }) as Any).finding.change, "reopened");

    // ---------------------------------------------------------------- 9. change a criterion
    const before: Any[] = await ada.query(api.findings.list, { criteriaId: critId });
    const stricterDef = { ...EXAMPLE_CRITERIA, require: EXAMPLE_CRITERIA.require.map((c) => (c.attr === "price" ? { ...c, value: 300000 } : c)) };
    const pv: Any = await ada.query(api.criteria.preview, { definition: JSON.stringify(stricterDef), criteriaId: critId });
    const v2: Any = await timed("criteria-v2", () => ada.mutation(api.criteria.save, { criteriaId: critId, definition: JSON.stringify(stricterDef) }));
    assert.equal(v2.version, 2);
    const after: Any[] = await ada.query(api.findings.list, { criteriaId: critId });
    assert.equal(after.length, pv.counts.match + pv.counts.possible, "the preview predicted the result");
    const superseded: Any[] = (await ada.query(api.findings.list, { criteriaId: critId, status: "closed" }) as Any[]).filter((f: Any) => f.change === "superseded");
    assert.equal(superseded.length, pv.delta.wouldClose);
    assert.ok(superseded.length > 0 || before.every((f) => after.some((x) => x.id === f.id)));
    for (const f of after) assert.equal(f.criteriaVersion, 2);

    // criteria change while monitoring is active: the next source change is evaluated under v2
    const cheap = after.find((f) => f.qualification === "match");
    if (cheap) {
      const e3: Any = await ada.query(api.entities.get, { entityId: cheap.entityId });
      const key = e3.records.find((r: Any) => r.source.id === listingsId)?.recordKey;
      if (key) {
        serve(listings.map((l) => (l.listing_id === key ? { ...l, price: 310000 } : l)));
        const r4: Any = await ada.action(api.sources.refresh, { sourceId: listingsId });
        assert.equal(r4.run.closed, 1, "310k breaks v2's 300k limit (it would not have broken v1's)");
        serve(listings);
        await ada.action(api.sources.refresh, { sourceId: listingsId });
      }
    }

    // ---------------------------------------------------------------- 10. the complete evidence trail
    const trail: Any = await ada.query(api.findings.get, { findingId: both.id });
    assert.deepEqual(trail.history.map((e: Any) => e.kind).filter((k: string) => k !== "persistent").slice(0, 3), ["new", "resolved", "reopened"]);
    for (const e of trail.history) assert.ok(e.cause.kind && e.cause.label, "every event says what caused it");
    assert.ok(trail.evidence.some((e: Any) => e.status === "superseded"), "evidence of earlier states is part of the trail");
    assert.ok(trail.evidence.every((e: Any) => e.ingestion && e.source), "each observation names its source and the refresh that produced it");
    assert.ok(trail.runs.length >= 3);

    // ---------------------------------------------------------------- ambiguity: never merged, a person decides
    const queue: Any[] = await ada.query(api.entities.identityQueue, {});
    const amb = queue.find((q) => q.status === "ambiguous")!;
    const conf = queue.find((q) => q.status === "conflict")!;
    assert.ok(amb && conf);
    assert.equal(amb.options.length, 1);
    const fixRun: Any = await ada.mutation(api.entities.separate, { sourceId: amb.sourceId, recordKey: amb.recordKey });
    assert.ok(fixRun.unchanged || fixRun.entities >= 1);
    // the conflicting parcel really is that house (a person knows the pin is wrong): assign it
    const assigned: Any = await ada.mutation(api.entities.assign, { sourceId: conf.sourceId, recordKey: conf.recordKey, entityId: conf.options[0].entityId });
    assert.equal(assigned.entities, 2, "both sides of an identity correction are re-evaluated");
    const merged: Any = await ada.query(api.entities.get, { entityId: conf.options[0].entityId });
    assert.equal(merged.records.find((r: Any) => r.recordKey === conf.recordKey).link.decidedBy, "user");

    // ---------------------------------------------------------------- conflicting observations from a third source
    await ada.mutation(api.criteria.save, { criteriaId: critId, definition: JSON.stringify(EXAMPLE_CRITERIA) }); // v3: back to the original thresholds
    assert.equal(((await ada.query(api.findings.get, { findingId: both.id })) as Any).finding.qualification, "match");
    const pushId: string = await ada.mutation(api.sources.create, { name: "Broker feed (synthetic)", kind: "push", entityType: "property", mapping: JSON.stringify({ ...LISTINGS_MAPPING, fields: LISTINGS_MAPPING.fields.filter((f) => f.source !== "parcel_ref") }), synthetic: true });
    const target = listings[idx];
    const pushed: Any = await timed("push-1", () => ada.mutation(api.sources.push, { sourceId: pushId, records: JSON.stringify([{ ...target, listing_id: "BRK-1", price: assessed + 80_000 }]) }));
    assert.equal(pushed.added, 1); assert.equal(pushed.run.entities, 1);
    const conflicted: Any = await ada.query(api.findings.get, { findingId: both.id });
    const priceLeaf = conflicted.explanation.require.find((n: Any) => n.leaf?.attr === "price");
    assert.equal(priceLeaf.result, "unknown"); assert.equal(priceLeaf.leaf.reason, "conflict");
    assert.ok(conflicted.explanation.conflicts.some((c: Any) => c.attr === "price"));
    assert.equal(conflicted.finding.qualification, "possible", "a conflict is uncertainty, not a verdict");
    // a duplicate push is not new information
    const again: Any = await ada.mutation(api.sources.push, { sourceId: pushId, records: JSON.stringify([{ ...target, listing_id: "BRK-1", price: assessed + 80_000 }]) });
    assert.equal(again.newInformation, false);
    // the user decides the listings API is the authority on price
    await ada.mutation(api.criteria.save, { criteriaId: critId, definition: JSON.stringify({ ...EXAMPLE_CRITERIA, trust: { price: [listingsId] } }) });
    const trusted: Any = await ada.query(api.findings.get, { findingId: both.id });
    assert.equal(trusted.finding.qualification, "match");
    assert.match(trusted.explanation.require.find((n: Any) => n.leaf?.attr === "price").leaf.resolvedBy, /trust/);

    // ---------------------------------------------------------------- stale evidence
    await ada.mutation(api.sources.update, { sourceId: parcelsId, staleAfterDays: 30 });
    const staleList: Any[] = await ada.query(api.findings.list, { criteriaId: critId });
    assert.ok(staleList.length > 0 && staleList.every((f) => f.qualification === "possible" && (f.hasStale || f.hasMissing)) && staleList.some((f) => f.hasStale), "parcel data as of 2026-07-01 is older than 30 days: nothing can be a full match on it");
    await ada.mutation(api.sources.update, { sourceId: parcelsId, staleAfterDays: 540 });

    // ---------------------------------------------------------------- re-confirmation is not new information
    const same: Any = await ada.mutation(api.sources.upload, { sourceId: parcelsId, content: parcelsGeoJson(parcels), dataAsOf: "2026-07-01T00:00:00.000Z" });
    assert.deepEqual([same.newInformation, same.unchanged, same.reconfirmed, same.run], [false, 38, 0, null]);
    const newer: Any = await ada.mutation(api.sources.upload, { sourceId: parcelsId, content: parcelsGeoJson(parcels), dataAsOf: "2026-11-01T00:00:00.000Z" });
    assert.deepEqual([newer.newInformation, newer.changed, newer.reconfirmed], [false, 0, 38], "a newer as-of date with the same values re-confirms; it does not create versions");
    assert.equal(newer.run.entities >= 36, true, "but freshness is re-evaluated");

    // ---------------------------------------------------------------- an unavailable source
    http.set("/api/listings", { status: 503, body: "down" });
    const down: Any = await ada.action(api.sources.refresh, { sourceId: listingsId });
    assert.equal(down.status, "unavailable");
    const srcs: Any[] = await ada.query(api.sources.list, {});
    assert.equal(srcs.find((x) => x.id === listingsId).status, "unavailable");
    const flagged: Any[] = await ada.query(api.findings.list, { criteriaId: critId });
    assert.ok(flagged.some((f) => f.sourceIssues.some((s: string) => /unavailable/.test(s))), "findings say their source is unavailable");
    assert.ok(flagged.length > 0, "unavailability is not a retraction: evidence stays (and ages)");
    serve(listings);
    assert.equal(((await ada.action(api.sources.refresh, { sourceId: listingsId })) as Any).status, "ok");

    // ---------------------------------------------------------------- criteria with no results
    const none: Any = await ada.mutation(api.criteria.save, { definition: JSON.stringify({ ...EXAMPLE_CRITERIA, name: "Nothing qualifies", require: [{ attr: "price", op: "lt", value: 1 }] }) });
    assert.equal(none.run.created, 0);
    assert.equal(((await ada.query(api.findings.list, { criteriaId: none.criteriaId })) as Any[]).length, 0);

    // ---------------------------------------------------------------- protected characteristics are refused
    await assert.rejects(ada.mutation(api.criteria.save, { definition: JSON.stringify({ ...EXAMPLE_CRITERIA, require: [{ attr: "familialStatus", op: "exists" }] }) }), /protected/);

    // ---------------------------------------------------------------- authorization
    await assert.rejects(app.as("bob").query(api.findings.get, { findingId: both.id }), /FORBIDDEN|not the owner/);
    await assert.rejects(app.as("grace").mutation(api.sources.remove, { sourceId: parcelsId }), /FORBIDDEN|permission/i);

    // ---------------------------------------------------------------- durability
    const beforeRestart: Any[] = await ada.query(api.findings.list, { status: "all" });
    await app.restart();
    const afterRestart: Any[] = await app.as("ada").query(api.findings.list, { status: "all" });
    assert.deepEqual(afterRestart.map((f) => [f.id, f.status, f.change]).sort(), beforeRestart.map((f) => [f.id, f.status, f.change]).sort());

    // ---------------------------------------------------------------- removing a source
    const removed: Any = await timed("remove-source", () => app.as("ada").mutation(api.sources.remove, { sourceId: parcelsId }));
    assert.equal(removed.retracted, 38);
    const gone: Any = await app.as("ada").query(api.findings.get, { findingId: both.id });
    assert.equal(gone.finding.status, "open", "without parcel evidence the listing is still possibly relevant");
    assert.equal(gone.finding.qualification, "possible");
    const closedByRemoval: Any[] = (await app.as("ada").query(api.findings.list, { criteriaId: critId, status: "closed" }) as Any[]).filter((f: Any) => f.change === "invalid");
    const ent4: Any = await app.as("ada").query(api.entities.get, { entityId });
    assert.equal(ent4.records.find((r: Any) => r.source.id === parcelsId).current, null, "withdrawn, not deleted");
    assert.ok(ent4.records.find((r: Any) => r.source.id === parcelsId).versions.length >= 1);
    t.diagnostic(`closed as invalid by removal: ${closedByRemoval.length}`);

    t.diagnostic(`timings (ms): ${JSON.stringify(timings)}`);
  } finally {
    await app.close();
    await http.close();
  }
});
