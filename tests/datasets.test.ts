/**
 * The first vertical slice, through the real FeltKit app (FeltDB, Files, authorization):
 * a user uploads their own parcel dataset, reviews the mapping, and the listing page they captured
 * is evaluated with the parcel facts — each one labelled with its dataset version and match basis.
 * SYNTHETIC data (tests/fixtures/discovery).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestApp } from '@feltdb/feltkit/testing';
import { api } from '../feltkit/_generated/api.js';

const fx = (f: string) => readFileSync(new URL(`./fixtures/discovery/${f}`, import.meta.url), 'utf8');
const home = (id: string) => `https://homes.example/homes/${id}`;
const BASE = 'https://homes.example/search?south=39.70&west=-105.10&north=39.85&east=-104.85';
const intent = JSON.stringify({
	schema: 'signal.intent/v1', id: 'net-yield', version: 1, name: 'Under $350k, net yield > 8%', target: { type: ['RealEstateListing', 'SingleFamilyResidence', 'Residence', 'House', 'Apartment'] },
	metrics: [{ name: 'netYield', formula: { div: [{ sub: [{ mul: [{ attr: 'estimatedMonthlyRent' }, { const: 12 }] }, { attr: 'annualPropertyTax' }] }, { attr: 'price' }] } }],
	criteria: [{ id: 'price', label: 'price < $350,000', where: { attr: 'price', op: 'lt', value: 350000 } }, { id: 'net', label: 'net yield > 8%', metric: 'netYield', where: { attr: 'netYield', op: 'gt', value: 0.08 } }]
});

async function setup(t: { after: (f: () => unknown) => void }) {
	const app = await createTestApp();
	t.after(() => app.close());
	const ada = app.as('ada'), bob = app.as('bob');
	const sourceId = await ada.mutation(api.sources.register, { type: 'dom', locator: 'dom:metro', strategy: 'manual' });
	const page = await ada.mutation(api.pages.push, { sourceId, html: fx('metro-p1.html'), baseUrl: BASE }) as { pageId: string };
	return { ada, bob, page };
}

test('import → review → accept → discover: the user’s own parcel data improves the listing evaluation', async (t) => {
	const { ada, page } = await setup(t);
	const imp = await ada.mutation(api.datasets.importDataset, { name: 'County parcels', format: 'csv', content: fx('parcels.csv'), freshness: 'static', dataAsOf: '2026-01-01' }) as any;
	assert.equal(imp.version, 1);
	// Review shows the file's real columns, the proposal with its basis, what is left out, and records before/after normalization.
	const rv = imp.review;
	assert.equal(rv.reviewed, false);
	assert.ok(rv.fields.some((f: any) => f.name === 'assessed_total'));
	assert.deepEqual(rv.unmapped, ['owner_name']);
	assert.equal(rv.issueCount, 1);
	assert.deepEqual(rv.preview[0].mapped.annualPropertyTax, { amount: 3180, currency: 'USD' });
	assert.equal(rv.preview[0].raw.tax_annual, '$3,180');

	// An unreviewed mapping is never used — refused by name, not silently ignored.
	await assert.rejects(ada.query(api.discovery.evaluate, { pageIds: [page.pageId], intent, datasetIds: [imp.datasetId] }), { code: 'FAILED_PRECONDITION' });

	const accepted = await ada.mutation(api.datasets.setMapping, { datasetId: imp.datasetId, mapping: JSON.stringify(rv.mapping), dataAsOf: '2026-01-01' }) as any;
	assert.equal(accepted.version, 2);
	assert.equal(accepted.review.reviewed, true);

	const r = await ada.query(api.discovery.evaluate, { pageIds: [page.pageId], intent, datasetIds: [imp.datasetId] }) as any;
	const c = (id: string) => r.candidates.find((x: any) => x.key === home(id));
	assert.equal(c('elm-121').status, 'possible', 'no rent estimate in this test, so net yield is unknown — not a match');
	const aug = r.augmentation;
	const tax = aug.values.find((v: any) => v.candidateKey === home('elm-121') && v.attribute === 'annualPropertyTax');
	assert.deepEqual(tax.value, { amount: 3180, currency: 'USD' });
	assert.equal(tax.basis, 'address+coordinates');
	assert.equal(tax.dataset.mappingVersion, 2);
	assert.equal(tax.dataset.freshness, 'static');
	assert.equal(tax.dataset.dataAsOf, '2026-01-01');
	const byKey = Object.fromEntries(aug.resolutions[0].resolutions.map((x: any) => [x.candidateKey.split('/').pop(), x.status]));
	assert.equal(byKey['birch-300'], 'ambiguous'); assert.equal(byKey['cedar-77'], 'conflict'); assert.equal(byKey['aspen-62'], 'unmatched'); assert.equal(byKey['pine-9'], 'matched');

	// With a rent survey as caller-supplied enrichment too, both external sources combine in one deterministic metric.
	const rents = JSON.stringify([JSON.parse(fx('rent-estimates.json'))]);
	const both = await ada.query(api.discovery.evaluate, { pageIds: [page.pageId], intent, datasetIds: [imp.datasetId], enrichments: rents }) as any;
	const elm = both.candidates.find((x: any) => x.key === home('elm-121'));
	assert.equal(elm.status, 'match');
	assert.ok(Math.abs(elm.metrics.netYield.value - (2350 * 12 - 3180) / 289000) < 1e-12);

	// Without datasetIds nothing changes and no augmentation is reported.
	const plain = await ada.query(api.discovery.evaluate, { pageIds: [page.pageId], intent }) as any;
	assert.equal(plain.augmentation, undefined);
});

test('a mapping change is a new version; the original bytes and earlier versions are untouched', async (t) => {
	const { ada } = await setup(t);
	const imp = await ada.mutation(api.datasets.importDataset, { name: 'p', format: 'csv', content: fx('parcels.csv') }) as any;
	const m = imp.review.mapping;
	const renamed = { ...m, fields: m.fields.map((f: any) => (f.attribute === 'assessedValue' ? { ...f, attribute: 'taxAssessment' } : f)) };
	await ada.mutation(api.datasets.setMapping, { datasetId: imp.datasetId, mapping: JSON.stringify(renamed) });
	const v1 = await ada.query(api.datasets.inspect, { datasetId: imp.datasetId, version: 1 }) as any;
	const v2 = await ada.query(api.datasets.inspect, { datasetId: imp.datasetId, version: 2 }) as any;
	assert.ok(v1.preview[0].mapped.assessedValue && !v1.preview[0].mapped.taxAssessment);
	assert.ok(v2.preview[0].mapped.taxAssessment && !v2.preview[0].mapped.assessedValue);
	await assert.rejects(ada.mutation(api.datasets.setMapping, { datasetId: imp.datasetId, mapping: JSON.stringify({ version: 1, fields: [{ source: 'nope', attribute: 'x', type: 'text' }] }) }), { code: 'INVALID_ARGUMENT' });
	const [row] = await ada.query(api.datasets.list, {}) as any[];
	assert.equal(row.latestVersion, 2); assert.equal(row.reviewed, true); assert.equal(row.rows, 9);
});

test('datasets are private to their owner and a retired dataset is not used', async (t) => {
	const { ada, bob, page } = await setup(t);
	const imp = await ada.mutation(api.datasets.importDataset, { name: 'mine', format: 'csv', content: fx('parcels.csv') }) as any;
	await ada.mutation(api.datasets.setMapping, { datasetId: imp.datasetId, mapping: JSON.stringify(imp.review.mapping) });
	await assert.rejects(bob.query(api.datasets.inspect, { datasetId: imp.datasetId }), { code: 'FORBIDDEN' });
	await assert.rejects(bob.mutation(api.datasets.setMapping, { datasetId: imp.datasetId, mapping: JSON.stringify(imp.review.mapping) }), { code: 'FORBIDDEN' });
	assert.deepEqual(await bob.query(api.datasets.list, {}), []);
	await assert.rejects(ada.query(api.discovery.evaluate, { pageIds: [page.pageId], intent, datasetIds: ['nonexistent'] }), { code: 'NOT_FOUND' });
	await ada.mutation(api.datasets.retire, { datasetId: imp.datasetId });
	await assert.rejects(ada.query(api.discovery.evaluate, { pageIds: [page.pageId], intent, datasetIds: [imp.datasetId] }), { code: 'FAILED_PRECONDITION' });
	await assert.rejects(ada.mutation(api.datasets.importDataset, { name: 'x', format: 'csv', content: 'a,a\n1,2' }), { code: 'INVALID_ARGUMENT' });
});

test('two datasets enrich the same candidate; another user’s dataset id and an unapproved one are refused even when the UI is bypassed', async (t) => {
	const { ada, bob, page } = await setup(t);
	const parcels = await ada.mutation(api.datasets.importDataset, { name: 'County parcels', format: 'csv', content: fx('parcels.csv') }) as any;
	const rentCsv = 'site,monthly_rent,lat,lon\n"121 Elm St",2350,39.7511,-104.9811\n"48 Oak Ave",2400,39.7621,-104.9721\n';
	const rent = await ada.mutation(api.datasets.importDataset, { name: 'Rent survey', format: 'csv', content: rentCsv, dataAsOf: '2026-10-01' }) as any;
	assert.ok(rent.review.proposals.some((p: any) => p.attribute === 'estimatedMonthlyRent' && p.source === 'monthly_rent'));
	// The rent file's address column is called "site": not in the vocabulary, so the person maps it (a reviewed edit → version 2).
	const m = rent.review.mapping;
	const edited = { ...m, fields: [...m.fields, { source: 'site', attribute: 'address', type: 'text', role: 'address' }] };
	const bothIds = [parcels.datasetId, rent.datasetId];

	// Neither is approved: refused by name, whatever the client did.
	await assert.rejects(ada.query(api.discovery.evaluate, { pageIds: [page.pageId], intent, datasetIds: bothIds }), { code: 'FAILED_PRECONDITION' });
	await ada.mutation(api.datasets.setMapping, { datasetId: parcels.datasetId, mapping: JSON.stringify(parcels.review.mapping), dataAsOf: '2026-01-01' });
	await assert.rejects(ada.query(api.discovery.evaluate, { pageIds: [page.pageId], intent, datasetIds: bothIds }), { code: 'FAILED_PRECONDITION' }, 'one unapproved dataset is enough to refuse');
	await ada.mutation(api.datasets.setMapping, { datasetId: rent.datasetId, mapping: JSON.stringify(edited), dataAsOf: '2026-10-01' });

	const r = await ada.query(api.discovery.evaluate, { pageIds: [page.pageId], intent, datasetIds: bothIds }) as any;
	const elm = r.candidates.find((x: any) => x.key === home('elm-121'));
	assert.equal(elm.status, 'match');
	assert.ok(Math.abs(elm.metrics.netYield.value - (2350 * 12 - 3180) / 289000) < 1e-12, 'rent from one dataset, tax from the other');
	const prov = elm.criteria.find((x: any) => x.id === 'net').provenance;
	assert.ok(prov.some((p: string) => p.startsWith('estimatedMonthlyRent:external-record(') && p.includes(rent.datasetId)));
	assert.ok(prov.some((p: string) => p.startsWith('annualPropertyTax:external-record(') && p.includes(parcels.datasetId)));
	assert.equal(r.augmentation.resolutions.length, 2);
	const names = new Set(r.augmentation.values.filter((v: any) => v.candidateKey === home('elm-121')).map((v: any) => v.dataset.name));
	assert.deepEqual([...names].sort(), ['County parcels', 'Rent survey']);
	// An ambiguous parcel stays unresolved in the combined run.
	assert.equal(r.candidates.find((x: any) => x.key === home('birch-300')).metrics.netYield.value, null);

	// Another user cannot use, inspect or change Ada's dataset by id, and cannot see it listed.
	await assert.rejects(bob.query(api.discovery.evaluate, { pageIds: [page.pageId], intent, datasetIds: [parcels.datasetId] }), { code: 'FORBIDDEN' });
	await assert.rejects(bob.query(api.datasets.inspect, { datasetId: parcels.datasetId }), { code: 'FORBIDDEN' });
	assert.deepEqual(await bob.query(api.datasets.list, {}), []);
	// list reports the format the panel shows
	assert.deepEqual(((await ada.query(api.datasets.list, {})) as any[]).map((d) => d.format).sort(), ['csv', 'csv']);
});
