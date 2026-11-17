/**
 * Progressive discovery on SYNTHETIC real-estate fixtures (scripts/gen-discovery-fixtures.ts).
 * Expected statuses (truth.json) are computed by the generator from its own data, not from the extractor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractPage } from '../../lib/page/extract.ts';
import { discover, extractContext, validateIntent, type DiscoveryIntent, type Enrichment } from '../../lib/discovery/discover.ts';

const fx = (f: string) => readFileSync(new URL(`../fixtures/discovery/${f}`, import.meta.url), 'utf8');
const truth = JSON.parse(fx('truth.json'));
const rents: Enrichment = JSON.parse(fx('rent-estimates.json'));
const page = (f: string, url: string, obs: string) => extractPage({ html: fx(f), locator: url, baseUrl: url, observationId: obs, contentHash: obs, contentType: 'text/html', observedAt: '2026-11-17T12:00:00.000Z' });
const metro = page('metro-p1.html', 'https://homes.example/search?south=39.70&west=-105.10&north=39.85&east=-104.85&sort=newest', 'o-metro');
const hood = page('neighborhood.html', 'https://homes.example/search?south=39.74&west=-105.00&north=39.77&east=-104.96&sort=newest', 'o-hood');
const later = page('neighborhood-later.html', 'https://homes.example/search?south=39.74&west=-105.00&north=39.77&east=-104.96&sort=newest', 'o-later');

const TARGET = { type: ['RealEstateListing', 'SingleFamilyResidence', 'Residence', 'House', 'Apartment'] };
const yieldMetric = { name: 'grossYield', formula: { div: [{ mul: [{ attr: 'estimatedMonthlyRent' }, { const: 12 }] }, { attr: 'price' }] as [never, never] } };
const intent1: DiscoveryIntent = {
	schema: 'signal.intent/v1', id: 'starter-rentals', version: 1, name: 'Under $350k, 3+ beds, yield > 8%', target: TARGET,
	metrics: [yieldMetric],
	criteria: [
		{ id: 'price', label: 'price < $350,000', where: { attr: 'price', op: 'lt', value: 350000 } },
		{ id: 'beds', label: '3+ bedrooms', where: { attr: 'numberOfBedrooms', op: 'gte', value: 3 } },
		{ id: 'yield', label: 'gross yield > 8%', metric: 'grossYield', where: { attr: 'grossYield', op: 'gt', value: 0.08 } }
	]
};
const intent2: DiscoveryIntent = {
	...intent1, version: 2, name: 'refined',
	criteria: [
		intent1.criteria[0], intent1.criteria[1],
		{ id: 'built', label: 'built after 1980', where: { attr: 'yearBuilt', op: 'gt', value: 1980 } },
		{ id: 'hoa', label: 'no HOA', where: { attr: 'hoaFee', op: 'eq', value: 0 } },
		{ id: 'yield', label: 'gross yield > 10%', metric: 'grossYield', where: { attr: 'grossYield', op: 'gt', value: 0.10 } },
		{ id: 'reduced', label: 'recently reduced', where: { attr: 'priceReduction', op: 'exists' }, absent: 'false' }
	]
};
const statuses = (r: ReturnType<typeof discover>) => Object.fromEntries(r.candidates.map((c) => [c.key, c.status]));

test('context: every value says where it came from; markers are not listings', () => {
	const c = extractContext(metro);
	assert.deepEqual(c.bounds.value, { south: 39.7, west: -105.1, north: 39.85, east: -104.85 });
	assert.equal(c.bounds.source, 'page-explicit');
	assert.equal(c.sort.value, 'newest');
	assert.equal(c.declaredTotal.value, truth.declared.metroTotal);
	assert.equal(c.declaredTotal.source, 'page-inferred', 'a count read from text is inferred, not explicit');
	assert.equal(c.shown.value, truth.declared.metroShown);
	assert.equal(c.viewportMarkers.value, truth.declared.metroMarkers);
	assert.match(String(c.nextPage.value), /page=2/);
	assert.equal(c.query.source, 'unknown');
	const user = extractContext(metro, { bounds: { south: 39.74, west: -105, north: 39.77, east: -104.96 } });
	assert.equal(user.bounds.source, 'user', 'a drawn area is the user\'s, not the page\'s');
});

test('metro page, intent 1: statuses equal the independent truth; missing data is never a match', () => {
	const r = discover({ intent: intent1, pages: [metro], enrichments: [rents] });
	assert.deepEqual(statuses(r), truth.metroIntent1);
	const birch = r.candidates.find((c) => c.key.endsWith('birch-300'))!;
	assert.equal(birch.status, 'possible');
	assert.ok(birch.missing.some((m) => m.startsWith('beds')), 'bedrooms not shown');
	const willow = r.candidates.find((c) => c.key.endsWith('willow-88'))!;
	assert.ok(willow.missing.some((m) => /yield: metric inputs missing: estimatedMonthlyRent/.test(m)));
	// Calculated metric names its inputs and their provenance (page fact vs external estimate).
	const elm = r.candidates.find((c) => c.key.endsWith('elm-121'))!;
	assert.ok(Math.abs(elm.metrics.grossYield.value! - (2350 * 12) / 289000) < 1e-9);
	assert.deepEqual(elm.metrics.grossYield.inputs, [{ attr: 'estimatedMonthlyRent', provenance: 'external-estimate', source: 'metro-rent-survey-2026' }, { attr: 'price', provenance: 'page' }]);
	assert.ok(!r.candidates.some((c) => c.key.endsWith('lot-5')), 'the lot is not a residential candidate');
});

test('coverage is explicit and not exhaustive when the source declares more', () => {
	const r = discover({ intent: intent1, pages: [metro], enrichments: [rents] });
	assert.equal(r.coverage.declaredTotal, 87);
	assert.equal(r.coverage.discovered, 11, '12 cards, one is a lot (Product)');
	assert.equal(r.coverage.listed, 12);
	assert.equal(r.coverage.nonTarget, 1);
	assert.equal(r.coverage.notYetExamined, 75);
	assert.equal(r.coverage.exhaustive, false);
	assert.match(r.coverage.exhaustiveBasis, /declares 87/);
	assert.ok(r.coverage.unavailable.some((u) => u.what === `${truth.declared.metroMarkers - truth.declared.metroShown} map markers without a listing on this page`), '20 markers vs 12 listed cards is reported, not assumed equal');
	assert.equal(r.coverage.evaluated + r.coverage.partiallyEvaluated, r.coverage.inScope);
	assert.deepEqual(r.plan[0], { kind: 'next_page', target: String(r.context.nextPage.value), reason: '75 candidates declared but not yet examined', executesIn: 'browser-session', priority: 1 });
	assert.ok(r.plan.some((p) => p.kind === 'detail_page' && p.target.endsWith('birch-300')));
	assert.ok(r.plan.some((p) => p.kind === 'enrichment' && p.target.endsWith('willow-88') && p.executesIn === 'background'));
});

test('narrowing scope: same evidence, user-drawn area; outside the area is out_of_scope, not non_match', () => {
	const r = discover({ intent: intent1, pages: [metro], enrichments: [rents], scope: { bounds: { south: 39.74, west: -105, north: 39.77, east: -104.96 }, source: 'user' } });
	assert.deepEqual(statuses(r), truth.neighborhoodScopeIntent1);
	assert.equal(r.scope.source, 'user');
	assert.equal(r.coverage.outOfScope, 4);
});

test('neighborhood page, refined intent: JSON-LD and card are one candidate; a stale conflicting price decides only when both agree', () => {
	const r = discover({ intent: intent2, pages: [hood], enrichments: [rents] });
	assert.deepEqual(statuses(r), truth.neighborhoodIntent2);
	assert.equal(r.coverage.exhaustive, true, 'the page declares 8 and shows all of them, no next page');
	const elm = r.candidates.find((c) => c.key.endsWith('elm-121'))!;
	assert.equal(elm.entityIds.length, 2, 'JSON-LD SingleFamilyResidence + visible listing reconciled');
	const price = elm.criteria.find((c) => c.id === 'price')!;
	assert.equal(price.result, 'true', '$279,000 and $289,000 are both < $350,000');
	const y = elm.criteria.find((c) => c.id === 'yield')!;
	assert.equal(y.values.length, 2, 'yield computed for both conflicting prices');
	assert.equal(y.result, 'unknown', '28,200/279,000 = 10.1% but 28,200/289,000 = 9.76%: the conflict straddles 10%');
	assert.match(String(y.reason), /conflict/);
	assert.equal(elm.status, 'non_match', 'decided by another criterion (no recent reduction), not by picking a price');
	const at8 = discover({ intent: intent1, pages: [hood], enrichments: [rents] }).candidates.find((c) => c.key.endsWith('elm-121'))!;
	assert.equal(at8.criteria.find((c) => c.id === 'yield')!.result, 'true', 'both prices give > 8%: the conflict does not matter');
	// With the 8% threshold the two prices also agree; if they straddled the threshold the result would be unknown.
	const straddle = discover({ intent: { ...intent1, criteria: [{ id: 'y', label: 'y', metric: 'grossYield', where: { attr: 'grossYield', op: 'gt', value: (2350 * 12) / 284000 } }] }, pages: [hood], enrichments: [rents] });
	const e2 = straddle.candidates.find((c) => c.key.endsWith('elm-121'))!;
	assert.equal(e2.criteria[0].result, 'unknown');
	assert.match(String(e2.criteria[0].reason), /conflict/);
	assert.equal(e2.status, 'possible');
});

test('absence is unknown by default; only an explicit intent declaration makes it false', () => {
	const open = discover({ intent: { ...intent2, criteria: intent2.criteria.map((c) => (c.id === 'reduced' ? { ...c, absent: undefined } : c)) }, pages: [hood], enrichments: [rents] });
	for (const c of open.candidates) {
		const reduced = c.criteria.find((x) => x.id === 'reduced')!;
		if (!c.key.endsWith('pine-9')) assert.equal(reduced.result, 'unknown');
		assert.notEqual(c.status === 'match' && reduced.result !== 'true', true);
	}
});

test('later observation: change and new listing detected against the previous result; unchanged pages can be skipped', () => {
	const before = discover({ intent: intent2, pages: [hood], enrichments: [rents] });
	const after = discover({ intent: intent2, pages: [later], enrichments: [{ ...rents, records: [...rents.records] }], previous: before });
	assert.deepEqual(statuses(after), truth.laterIntent2);
	const oak = after.candidates.find((c) => c.key.endsWith('oak-48'))!;
	assert.deepEqual(oak.changed?.fields.sort(), ['price', 'reduced', 'yield']);
	assert.equal(oak.changed?.since, before.resultDigest);
	assert.ok(!before.candidates.some((c) => c.key.endsWith('juniper-3')) && after.candidates.some((c) => c.key.endsWith('juniper-3')));
	const again = discover({ intent: intent2, pages: [later], enrichments: [rents], previous: after });
	assert.ok(again.plan.some((p) => p.kind === 'skip_unchanged'));
	assert.ok(!again.candidates.some((c) => c.changed));
	assert.equal(again.resultDigest, after.resultDigest, 'deterministic');
});

test('intents with undecidable operators are rejected, not evaluated as false', () => {
	assert.ok(validateIntent({ ...intent1, criteria: [{ id: 'x', label: 'x', where: { attr: 'price', op: 'decreased' } }] }).length);
	assert.throws(() => discover({ intent: { ...intent1, criteria: [{ id: 'x', label: 'x', where: { attr: 'price', op: 'changed' } }] }, pages: [metro] }), /not supported/);
});
