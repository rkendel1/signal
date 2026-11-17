/**
 * The extension's dataset logic (extension/src/datasets.ts): file checks, mapping draft, selection,
 * and how results describe external facts. Uses the real backend library output on the synthetic fixtures.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractPage } from '../../lib/page/extract.ts';
import { applyMapping, inspectDataset as inspectParsed, parseCsv } from '../../lib/datasets/dataset.ts';
import { discoverAugmented, type DatasetSource } from '../../lib/datasets/resolve.ts';
import type { DiscoveryIntent } from '../../lib/discovery/discover.ts';
import {
	Latest, addField, checkFileName, draftChanged, draftMapping, draftProblem, dropField, factsFor, formatAttr, issueLines, prepareFile, reconcileSelection,
	renameField, startDraft, statusOf, unmappedIn, usable, warnings, why, type DatasetRow, type Review
} from '../../extension/src/datasets.ts';
import { can } from '../../extension/src/host.ts';

const fx = (f: string) => readFileSync(new URL(`../fixtures/discovery/${f}`, import.meta.url), 'utf8');
const file = (name: string, text: string, size = text.length) => ({ name, size, text: async () => text });

const parsed = parseCsv(fx('parcels.csv'));
const inspection = inspectParsed(parsed);
const mapped = applyMapping(parsed, inspection.proposed);
const review: Review = {
	version: 1, reviewed: false, format: 'csv', rows: inspection.rows, fields: inspection.fields, proposals: inspection.proposals, unmapped: mapped.unmapped,
	mapping: inspection.proposed, issues: mapped.issues, issueCount: mapped.issues.length, preview: []
};
const row = (o: Partial<DatasetRow>): DatasetRow => ({ id: 'd', name: 'D', freshness: 'static', format: 'csv', retired: false, createdAt: '', latestVersion: 1, reviewed: true, rows: 9, dataAsOf: null, retrievedAt: '', ...o });

test('files: only CSV and GeoJSON, by name; the rest is explained', () => {
	assert.deepEqual(checkFileName('County Parcels.CSV'), { ok: true, format: 'csv', defaultName: 'County Parcels' });
	assert.deepEqual(checkFileName('p.geojson'), { ok: true, format: 'geojson', defaultName: 'p' });
	assert.equal((checkFileName('p.json') as { format: string }).format, 'geojson');
	for (const bad of ['p.xlsx', 'p.txt', 'parcels', 'p.csv.exe']) assert.match((checkFileName(bad) as { reason: string }).reason, /not a CSV or GeoJSON file/);
});

test('files: unsupported, empty and oversized files are refused whole, before anything is sent', async () => {
	await assert.rejects(prepareFile(file('a.xlsx', 'x')), /not a CSV or GeoJSON/);
	await assert.rejects(prepareFile(file('a.csv', '', 0)), /empty/);
	await assert.rejects(prepareFile(file('big.csv', 'x', 5_000_000)), /4\.8 MB[^]*split it by area/i);
	// Small as text, too big once stored: incompressible content.
	const noise = Buffer.from(Array.from({ length: 1_400_000 }, () => Math.floor(Math.random() * 256))).toString('base64'); // ~1.87 MB
	await assert.rejects(prepareFile(file('noise.csv', noise.slice(0, 1_700_000))), /once compressed[^]*split it by area/i);
	const ok = await prepareFile(file('parcels.csv', fx('parcels.csv')));
	assert.equal(ok.format, 'csv'); assert.equal(ok.defaultName, 'parcels'); assert.ok(ok.storedBytes > 0 && ok.storedBytes < ok.bytes);
});

test('mapping draft: edits are local until approved, and a changed draft is what creates a new version', () => {
	const base = startDraft(review.mapping);
	assert.equal(draftChanged(base), false);
	assert.equal(draftProblem(base), null);
	const renamed = renameField(base, 'gross_living_area', 'livingArea');
	assert.equal(draftChanged(renamed), true);
	assert.equal(base.fields.find((f) => f.source === 'gross_living_area')!.attribute, 'floorSize', 'the stored mapping is not mutated');
	assert.equal(review.mapping.fields.find((f) => f.source === 'gross_living_area')!.attribute, 'floorSize');
	assert.deepEqual(draftMapping(renamed, 3).version, 3);
	const dropped = dropField(base, 'yr_built');
	assert.ok(!dropped.fields.some((f) => f.source === 'yr_built'));
	assert.deepEqual(unmappedIn(dropped, review.fields.map((f) => f.name)), ['yr_built', 'owner_name']);
	const added = addField(dropped, 'owner_name', 'ownerName', 'text');
	assert.equal(added.fields.at(-1)!.attribute, 'ownerName');
	assert.match(draftProblem(renameField(base, 'tax_annual', 'assessedValue'))!, /Two columns are mapped to “assessedValue”/);
	assert.match(draftProblem(renameField(base, 'tax_annual', ''))!, /Name the Signal attribute/);
	assert.match(draftProblem(renameField(base, 'tax_annual', 'a b'))!, /not a valid attribute name/);
});

test('review: states, why each field was proposed, unmapped and invalid values with row numbers, warnings', () => {
	assert.equal(statusOf({ reviewed: false }).key, 'proposed');
	assert.match(statusOf({ reviewed: false }).hint, /Nothing from this file is used until you approve/);
	assert.equal(statusOf({ reviewed: true }).key, 'approved');
	const tax = review.mapping.fields.find((f) => f.attribute === 'annualPropertyTax')!;
	assert.match(why(review, tax), /tax_annual/);
	assert.equal(why(review, { ...tax, attribute: 'myTax' }), 'You chose this attribute');
	assert.equal(why(review, { source: 'owner_name', attribute: 'x', type: 'text' }), 'You added this column');
	assert.deepEqual(issueLines(review), ['Row 9 · assessed_total: not a number (“n/a”)']);
	assert.deepEqual(warnings(review), []);
	const noId = { ...review.mapping, fields: review.mapping.fields.filter((f) => f.role !== 'id' && f.role !== 'latitude') };
	const w = warnings(review, noId);
	assert.ok(w.some((x) => /No parcel ID/.test(x)) && w.some((x) => /No latitude and longitude/.test(x)));
	assert.ok(warnings(review, { ...noId, fields: noId.fields.filter((f) => f.role) }).some((x) => /would not add any information/.test(x)));
});

test('selection: only approved, existing datasets can be selected; others fall away', () => {
	const list = [row({ id: 'a' }), row({ id: 'b', reviewed: false }), row({ id: 'c', retired: true })];
	assert.deepEqual(usable(list[0]), { ok: true });
	assert.match((usable(list[1]) as { why: string }).why, /not been approved/);
	assert.deepEqual(reconcileSelection(['b', 'a', 'a', 'gone', 'c'], list), ['a']);
	assert.deepEqual(reconcileSelection(['a'], []), [], 'sign-out or a different instance clears the selection');
});

test('stale responses: only the newest ticket may apply its result', () => {
	const g = new Latest();
	const first = g.next(), second = g.next();
	assert.equal(g.isCurrent(first), false);
	assert.equal(g.isCurrent(second), true);
	g.cancel();
	assert.equal(g.isCurrent(second), false);
});

// ---- results

const page = extractPage({ html: fx('metro-p1.html'), locator: 'https://homes.example/search?south=39.70&west=-105.10&north=39.85&east=-104.85', baseUrl: 'https://homes.example/search?south=39.70&west=-105.10&north=39.85&east=-104.85', observationId: 'o', contentHash: 'o', contentType: 'text/html', observedAt: '2026-11-17T12:00:00.000Z' });
const ds: DatasetSource = { id: 'ds1', name: 'County parcels', versionId: 'v', mappingVersion: 2, freshness: 'static', dataAsOf: '2026-01-01', retrievedAt: '2026-11-17T00:00:00Z', records: mapped.records };
const intent: DiscoveryIntent = {
	schema: 'signal.intent/v1', id: 'i', version: 1, name: 'tax', target: { type: ['RealEstateListing'] },
	metrics: [{ name: 'taxRate', formula: { div: [{ attr: 'annualPropertyTax' }, { attr: 'price' }] as [never, never] } }],
	criteria: [{ id: 'tax', label: 'tax rate under 1.08%', metric: 'taxRate', where: { attr: 'taxRate', op: 'lt', value: 0.0108 } }]
};
const out = discoverAugmented({ intent, pages: [page], datasets: [ds] });
const key = (id: string) => `https://homes.example/homes/${id}`;
const cand = (id: string) => out.result.candidates.find((c) => c.key === key(id))!;
const facts = (id: string) => factsFor(key(id), cand(id).metrics as never, out.augmentation as never);

test('results: an external value is labelled as the dataset’s, with version, freshness, record and basis', () => {
	const f = facts('oak-48');
	const tax = f.external.find((x) => x.attribute === 'annualPropertyTax')!;
	assert.deepEqual([tax.label, tax.value, tax.dataset], ['Annual Property Tax', '$3,600', 'County parcels']);
	assert.match(tax.version, /mapping version 2/); assert.match(tax.asOf, /data as of 2026-01-01/); assert.match(tax.fresh, /snapshot that does not change/);
	assert.equal(tax.record, '12-001-002'); assert.match(tax.basis, /same address, at the same location/);
	assert.equal(f.links[0].status, 'matched'); assert.match(f.links[0].text, /^Matched by the same address/);
});

test('results: a calculated metric names where each input came from', () => {
	const m = facts('oak-48').metrics[0];
	assert.equal(m.name, 'Tax Rate'); assert.equal(m.value, String(Math.round((3600 / 335000) * 10000) / 10000));
	assert.deepEqual(m.inputs.map((i) => `${i.attr} from ${i.from}`).sort(), ['Annual Property Tax from your data: County parcels', 'Price from the listing page']);
	assert.deepEqual(m.unknown, []);
});

test('results: page and dataset disagree → both are shown, the page’s value is the one used', () => {
	const y = facts('oak-48').external.find((x) => x.attribute === 'yearBuilt')!;
	assert.equal(y.value, '1,979');
	assert.match(y.conflict!, /listing page says 1,978\. Signal uses the page’s value/);
	assert.equal(facts('elm-121').external.find((x) => x.attribute === 'yearBuilt')!.conflict, undefined);
});

test('results: ambiguous, conflicting and unmatched properties get no external facts, and say why', () => {
	for (const [id, status] of [['birch-300', 'ambiguous'], ['cedar-77', 'conflict'], ['aspen-62', 'unmatched']] as const) {
		const f = facts(id);
		assert.equal(f.external.length, 0, `${id}: nothing joined`);
		assert.equal(f.links[0].status, status);
		assert.ok(f.links[0].reason.length > 10);
		const m = f.metrics[0]; assert.equal(m.value, 'cannot be calculated'); assert.deepEqual(m.unknown, ['Annual Property Tax']);
	}
	assert.match(facts('birch-300').links[0].text, /more than one property — not used/);
	assert.equal(facts('birch-300').links[0].options!.length, 2);
	assert.equal(cand('birch-300').status, 'possible');
});

test('results: without a dataset nothing is added', () => {
	const f = factsFor(key('oak-48'), {}, undefined);
	assert.deepEqual(f, { links: [], external: [], metrics: [] });
	assert.equal(formatAttr({ amount: 1500, currency: 'USD' }), '$1,500');
	assert.equal(formatAttr({ amount: 1500, currency: 'EUR' }), '1,500 EUR');
});

test('access: permissions from the session decide what the panel offers, wildcards included', () => {
	const member = ['signal.sources.*', 'signal.pages.*', 'signal.datasets.*', 'files.read'];
	const viewer = ['signal.events.read', 'signal.pages.read', 'files.read', 'notifications.read'];
	assert.ok(can(member, 'signal.datasets.write') && can(member, 'signal.sources.read'));
	assert.equal(can(viewer, 'signal.datasets.write'), false);
	assert.equal(can(viewer, 'signal.sources.read'), false);
	assert.ok(can(viewer, 'signal.pages.read'));
	assert.ok(can(['signal.*'], 'signal.datasets.read') && can(['*'], 'anything'));
	assert.equal(can(['signal.datasets.*'], 'signal.datasetsX.read'), false, 'a wildcard covers its own namespace only');
	assert.equal(can(undefined, 'signal.sources.read'), false);
});

test('a mapping that adds no facts (only identifiers and location) cannot be approved', () => {
	const onlyRoles = startDraft({ ...review.mapping, fields: review.mapping.fields.filter((f) => f.role) });
	assert.match(draftProblem(onlyRoles)!, /Nothing in this mapping is a fact/);
	assert.equal(draftProblem(startDraft({ version: 1, fields: [] }))!.length > 0, true, 'an empty mapping (a file Signal recognised nothing in) is refused');
	assert.equal(draftProblem(startDraft(review.mapping)), null);
});
