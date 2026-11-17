/**
 * Shared site intelligence + notifications + page context, against a real FeltDB instance.
 *
 * The evidence and the feed body are REAL (collected from public USGS pages, tests/fixtures/sites/PROVENANCE.md),
 * replayed from a local HTTP server so the test is hermetic: every https://earthquake.usgs.gov URL in them is
 * rewritten to the local origin. Changes to the feed are made by the test (labelled where they happen).
 */
process.env.SIGNAL_ALLOW_PRIVATE_HOSTS = "127.0.0.1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.ts";
import { fixture } from "./helpers.ts";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const FEED = "/earthquakes/feed/v1.0/summary/2.5_day.geojson";

test("site intelligence: analyze → shared catalog → connect with own access → verified → findings, notices, page context; a second user reuses it", async () => {
  const http = await fixture();
  const app = await createTestApp();
  const ada = app.as("ada"), bob = app.as("bob");
  const local = (t: string) => t.replaceAll("https://earthquake.usgs.gov", http.url);
  const evidence = local(readFileSync(new URL("./fixtures/sites/usgs-map.json", import.meta.url), "utf8"));
  const ev = JSON.parse(evidence);
  const body0 = ev.responses.find((r: Any) => r.url.endsWith(FEED)).json;
  let lm = 1;
  const serve = (doc: unknown) => http.set(FEED, { body: JSON.stringify(doc), type: "application/json", etag: `"v${lm++}"` });
  try {
    serve(body0);
    // ---------------------------------------------------------------- analyze (ada's own browser evidence)
    const an: Any = await ada.mutation(api.sites.analyze, { evidence });
    const top = an.candidates[0];
    assert.equal(top.verdict, "feed");
    assert.equal(top.contribution.outcome, "new");
    assert.equal(top.contribution.status, "discovered", "seen, not yet shown to work");
    assert.ok(an.candidates.some((c: Any) => c.verdict === "metadata" && !c.contribution), "metadata is not contributed");
    assert.ok(top.fields.some((f: Any) => f.samples?.length), "the owner sees samples in their own analysis");
    const feedId = top.contribution.feedId;

    // the shared definition: structure only
    const cat: Any[] = await bob.query(api.sites.catalog, {});
    const site = cat.find((x) => x.domain === "127.0.0.1")!;
    assert.ok(site && site.feeds >= 1);
    const detail: Any = await bob.query(api.sites.site, { siteId: site.id });
    const shared = JSON.stringify(detail.feeds.map((f: Any) => f.definition));
    const place = body0.features[0].properties.place;
    assert.ok(!shared.includes(place), "no record value reaches the catalog");
    assert.ok(!shared.includes("REDACTEDfixtureTOKEN"), "no token value reaches the catalog");
    assert.ok(!/"samples"/.test(shared));
    await assert.rejects(bob.query(api.sites.analysis, { analysisId: an.analysisId }), /FORBIDDEN|not the owner/, "an analysis is private");
    assert.deepEqual(detail.myAnalyses, [], "bob sees only his own analyses");

    // ---------------------------------------------------------------- connect with ada's own access; acquisition verifies the definition
    const conn: Any = await ada.mutation(api.sites.connect, { feedId, entityType: "earthquake", staleAfterDays: 2 });
    assert.equal(conn.acquisition, "server", "public feed: Signal's server may fetch it");
    assert.equal(conn.intervalMinutes, 1, "from the feed's cache max-age (60 s)");
    const t0 = performance.now();
    const r1: Any = await ada.action(api.sources.refresh, { sourceId: conn.sourceId });
    const acquireMs = Math.round(performance.now() - t0);
    assert.equal(r1.status, "ok"); assert.equal(r1.added, body0.features.length);
    assert.equal(r1.verification.ok, true);
    assert.equal(((await ada.query(api.sites.site, { siteId: site.id })) as Any).feeds.find((f: Any) => f.id === feedId).status, "verified", "an actual acquisition matched: verified");

    // ---------------------------------------------------------------- criteria → findings → notices
    const strongest = [...body0.features].sort((a: Any, b: Any) => b.properties.mag - a.properties.mag)[0];
    const threshold = Math.floor(strongest.properties.mag * 10) / 10;
    const crit: Any = await ada.mutation(api.criteria.save, { definition: JSON.stringify({ name: `Magnitude ${threshold}+`, entityType: "earthquake", severity: "warning", require: [{ attr: "mag", op: "gte", value: threshold }], changeThresholds: { mag: { abs: 0.1 } } }) });
    assert.ok(crit.run.created >= 1);
    let inbox: Any[] = await ada.query(api.notices.list, { active: true });
    assert.ok(inbox.some((n) => n.kind === "finding_new" && n.findingId));
    const newCount = inbox.filter((n) => n.kind === "finding_new").length;

    // a duplicate refresh (304) and an unchanged body: no new information, no notice
    const dup: Any = await ada.action(api.sources.refresh, { sourceId: conn.sourceId });
    assert.equal(dup.status, "not_modified");
    // TEST CHANGE: USGS revises the second-strongest event upward (its `updated` advances).
    const second = [...body0.features].sort((a: Any, b: Any) => b.properties.mag - a.properties.mag)[1];
    const body1 = structuredClone(body0);
    const f1 = body1.features.find((f: Any) => f.id === second.id);
    f1.properties.mag = threshold + 0.4; f1.properties.updated += 60_000;
    serve(body1);
    const t1 = performance.now();
    const r2: Any = await ada.action(api.sources.refresh, { sourceId: conn.sourceId });
    const changeToFindingMs = Math.round(performance.now() - t1);
    assert.equal(r2.changed, 1); assert.equal(r2.run.created, 1);
    inbox = await ada.query(api.notices.list, { active: true });
    assert.equal(inbox.filter((n) => n.kind === "finding_new").length, newCount + 1, "one notice for the one new finding");
    serve(body1); // same content, new etag: a refresh, not new information
    const r3: Any = await ada.action(api.sources.refresh, { sourceId: conn.sourceId });
    assert.equal(r3.newInformation, false);
    assert.equal(((await ada.query(api.notices.list, {})) as Any[]).length, inbox.length, "no duplicate notice");

    // ---------------------------------------------------------------- page context: the event's own page
    const eventUrl = f1.properties.url;
    const ctx: Any = await ada.query(api.ambient.context, { url: eventUrl });
    assert.equal(ctx.site.known, true);
    assert.ok(ctx.findings.some((f: Any) => f.status === "open" && f.qualification === "match"), "the page is about an entity with a finding");
    assert.ok(ctx.notices.contextual >= 1, "and its notice is contextual to this page");
    assert.ok(ctx.watching.some((c: Any) => c.id === crit.criteriaId));
    assert.ok(ctx.timing.totalMs < 2000);

    // ---------------------------------------------------------------- snooze, acknowledge, preferences
    const fid = ctx.findings[0].id;
    await ada.mutation(api.notices.snoozeFinding, { findingId: fid, hours: 2 });
    assert.ok(!((await ada.query(api.findings.list, {})) as Any[]).some((f) => f.id === fid), "a snoozed finding leaves the feed");
    assert.ok(!((await ada.query(api.notices.list, { active: true })) as Any[]).some((n) => n.findingId === fid), "and its notices go quiet");
    assert.ok(((await ada.query(api.findings.get, { findingId: fid })) as Any).history.length >= 1, "its history is intact");
    await ada.mutation(api.notices.snoozeFinding, { findingId: fid, hours: 0 });
    const pend: Any = await ada.query(api.notices.pending, {});
    assert.ok(pend.notices.length >= 1);
    await ada.mutation(api.notices.delivered, { noticeIds: pend.notices.map((n: Any) => n.id) });
    assert.equal(((await ada.query(api.notices.pending, {})) as Any).notices.length, 0, "a browser notification is shown once");
    await ada.mutation(api.notices.setPreferences, { prefs: JSON.stringify({ minSeverity: "critical" }) });
    assert.equal(((await ada.query(api.notices.getPreferences, {})) as Any).minSeverity, "critical");
    await ada.mutation(api.notices.acknowledge, { all: true });
    assert.equal(((await ada.query(api.notices.list, { active: true })) as Any[]).length, 0);
    assert.ok(((await ada.query(api.notices.list, {})) as Any[]).length > 0, "acknowledged, not deleted");

    // ---------------------------------------------------------------- feed failure: one notice per outage, recovery noticed
    http.set(FEED, { status: 503, body: "down" });
    await ada.action(api.sources.refresh, { sourceId: conn.sourceId });
    await ada.action(api.sources.refresh, { sourceId: conn.sourceId });
    const fails = ((await ada.query(api.notices.list, {})) as Any[]).filter((n) => n.kind === "source_failure");
    assert.equal(fails.length, 1, "two failed attempts, one outage, one notice");
    serve(body1);
    await ada.action(api.sources.refresh, { sourceId: conn.sourceId });
    assert.equal(((await ada.query(api.notices.list, {})) as Any[]).filter((n) => n.kind === "source_recovered").length, 1);

    // ---------------------------------------------------------------- the site changes shape: needs reanalysis
    serve({ type: "FeatureCollection", features: body1.features.map((f: Any) => ({ type: "Feature", id: f.id, properties: { magnitude: f.properties.mag }, geometry: f.geometry })) });
    const broken: Any = await ada.action(api.sources.refresh, { sourceId: conn.sourceId });
    assert.equal(broken.verification.ok, false);
    assert.equal(((await ada.query(api.sites.site, { siteId: site.id })) as Any).feeds.find((f: Any) => f.id === feedId).status, "needs_reanalysis", "the catalog learns the site changed");
    serve(body1);
    await ada.action(api.sources.refresh, { sourceId: conn.sourceId });
    assert.equal(((await ada.query(api.sites.site, { siteId: site.id })) as Any).feeds.find((f: Any) => f.id === feedId).status, "verified", "and recovers when it conforms again");

    // ---------------------------------------------------------------- a second user reuses the shared definition with their own access
    const rec: Any = await bob.query(api.sites.recognize, { url: `${http.url}/earthquakes/map/` });
    assert.ok(rec.known && rec.pageFeeds.includes(feedId), "the site and its feed are recognised for bob");
    assert.deepEqual(rec.feeds.find((f: Any) => f.id === feedId).connections, [], "ada's connection is invisible to bob");
    const bconn: Any = await bob.mutation(api.sites.connect, { feedId, entityType: "earthquake" });
    assert.notEqual(bconn.sourceId, conn.sourceId);
    await assert.rejects(bob.query(api.sources.get, { sourceId: conn.sourceId }), /FORBIDDEN|not the owner/);
    assert.equal(((await bob.query(api.findings.list, {})) as Any[]).length, 0, "nothing of ada's evaluation reaches bob");
    const br: Any = await bob.action(api.sources.refresh, { sourceId: bconn.sourceId });
    assert.equal(br.added, body1.features.length, "bob's own acquisition, his own observations");

    // ---------------------------------------------------------------- the real Rhode Island boundary as an area
    const ri = readFileSync(new URL("../rhode island.geojson", import.meta.url), "utf8");
    const regions: string = await ada.mutation(api.sources.create, { name: "US state boundary: Rhode Island", kind: "file", entityType: "region", config: JSON.stringify({ format: "geojson" }), content: ri, mapping: JSON.stringify({ version: 1, entityType: "region", fields: [{ source: "abbreviation", attribute: "abbreviation", type: "text", role: "key" }, { source: "name", attribute: "name", type: "text", role: "name" }, { source: "population", attribute: "population", type: "number" }] }) });
    const near: Any = await ada.query(api.criteria.preview, { definition: JSON.stringify({ name: "near RI", entityType: "earthquake", severity: "info", require: [{ attr: "@location", op: "within", value: { sourceId: regions, recordKey: "RI", bufferKm: 1500 } }] }) });
    const far: Any = await ada.query(api.criteria.preview, { definition: JSON.stringify({ name: "in RI", entityType: "earthquake", severity: "info", require: [{ attr: "@location", op: "within", value: { sourceId: regions, recordKey: "RI" } }] }) });
    assert.equal(near.counts.match + near.counts.non_match, body1.features.length, "every earthquake is placed relative to the boundary");
    assert.equal(far.counts.match, 0, "none of these real events is inside Rhode Island");
    await assert.rejects(bob.query(api.criteria.preview, { definition: JSON.stringify({ name: "x", entityType: "earthquake", severity: "info", require: [{ attr: "@location", op: "within", value: { sourceId: regions, recordKey: "RI" } }] }) }).then((p: Any) => { if (p.counts.match + p.counts.non_match > 0) throw new Error("bob used ada's area"); throw new Error("unknown"); }), /unknown/, "another user's area is not available to bob");

    console.log(`# acquisition ${acquireMs} ms (${body0.features.length} records, local replay); change→finding ${changeToFindingMs} ms; page context ${ctx.timing.totalMs} ms (recognize ${ctx.timing.recognizeMs} ms)`);
  } finally {
    await app.close();
    await http.close();
  }
});
