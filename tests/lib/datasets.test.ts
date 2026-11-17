/**
 * User datasets on the SYNTHETIC real-estate fixtures: parse → inspect → reviewable mapping → resolve → augmented discovery.
 * Expected outcomes are written from the parcels.csv rows, not read back from the code under test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractPage } from '../../lib/page/extract.ts';
import { discover, type DiscoveryIntent, type Enrichment } from '../../lib/discovery/discover.ts';
import { applyMapping, inspectDataset, normalizeAddress, parseCsv, parseGeoJson, validateMapping, type DatasetMapping } from '../../lib/datasets/dataset.ts';
import { discoverAugmented, distanceM, resolveCandidates, identityOf, type DatasetSource } from '../../lib/datasets/resolve.ts';

const fx = (f: string) => readFileSync(new URL(`../fixtures/discovery/${f}`, import.meta.url), 'utf8');
const rents: Enrichment = JSON.parse(fx('rent-estimates.json'));
const metro = extractPage({ html: fx('metro-p1.html'), locator: 'https://homes.example/search?south=39.70&west=-105.10&north=39.85&east=-104.85', baseUrl: 'https://homes.example/search?south=39.70&west=-105.10&north=39.85&east=-104.85', observationId: 'o-metro', contentHash: 'o-metro', contentType: 'text/html', observedAt: '2026-11-17T12:00:00.000Z' });
const home = (id: string) => `https://homes.example/homes/${id}`;

const parsed = parseCsv(fx('parcels.csv'));
const inspection = inspectDataset(parsed);
const mapped = applyMapping(parsed, inspection.proposed);
const parcels: DatasetSource = { id: 'ds-parcels', name: 'County parcels (synthetic)', versionId: 'v1', mappingVersion: 1, freshness: 'static', dataAsOf: '2026-01-01', retrievedAt: '2026-11-17T00:00:00Z', records: mapped.records };

const TARGET = { type: ['RealEstateListing', 'SingleFamilyResidence', 'Residence', 'House', 'Apartment'] };
const intent: DiscoveryIntent = {
	schema: 'signal.intent/v1', id: 'net-yield', version: 1, name: 'Under $350k, net yield > 8%', target: TARGET,
	metrics: [{ name: 'netYield', formula: { div: [{ sub: [{ mul: [{ attr: 'estimatedMonthlyRent' }, { const: 12 }] }, { attr: 'annualPropertyTax' }] as [never, never] }, { attr: 'price' }] as [never, never] } }],
	criteria: [
		{ id: 'price', label: 'price < $350,000', where: { attr: 'price', op: 'lt', value: 350000 } },
		{ id: 'net', label: 'net yield > 8%', metric: 'netYield', where: { attr: 'netYield', op: 'gt', value: 0.08 } }
	]
};

test('csv: quotes, CRLF, BOM; malformed input is rejected, not guessed at', () => {
	const d = parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n,2\r\n');
	assert.deepEqual(d.rows.map((r) => r.props), [{ a: 'x, y', b: 'say "hi"' }, { a: null, b: '2' }]);
	assert.throws(() => parseCsv('a,a\n1,2'), /duplicate/);
	assert.throws(() => parseCsv('a,b\n"open,2'), /unterminated/);
});

test('inspection proposes a reviewable mapping from unfamiliar column names; nothing is applied silently', () => {
	assert.equal(inspection.rows, 9);
	const by = Object.fromEntries(inspection.proposals.map((p) => [p.attribute, p]));
	assert.equal(by.parcelId.source, 'parcel_no'); assert.equal(by.parcelId.role, 'id');
	assert.equal(by.address.source, 'site_addr');
	assert.equal(by.assessedValue.source, 'assessed_total'); assert.equal(by.assessedValue.type, 'money');
	assert.equal(by.annualPropertyTax.source, 'tax_annual');
	assert.equal(by.floorSize.source, 'gross_living_area');
	assert.equal(by.yearBuilt.source, 'yr_built');
	assert.equal(by.latitude.source, 'lat'); assert.equal(by.longitude.source, 'lon');
	assert.deepEqual(inspection.unmapped, ['owner_name'], 'a column the vocabulary does not know is left out and reported');
	assert.match(by.parcelId.basis, /parcel_no/);
	assert.equal(inspection.fields.find((f) => f.name === 'assessed_total')!.type, 'number', 'currency formatting is understood');
});

test('mapping: units are applied, bad values are reported with their row, and an invalid mapping is refused', () => {
	assert.deepEqual(mapped.records[0].attributes.assessedValue, { amount: 241000, currency: 'USD' });
	assert.deepEqual(mapped.issues, [{ row: 8, field: 'assessed_total', problem: 'not a number', raw: 'n/a' }]);
	assert.equal(mapped.records[8].attributes.assessedValue, undefined, 'a bad value is absent, never zero');
	assert.equal(mapped.records[6].lat, null, 'blank coordinates stay unknown');
	const bad: DatasetMapping = { version: 1, fields: [{ source: 'nope', attribute: 'x', type: 'text' }, { source: 'lat', attribute: 'a', type: 'number', role: 'latitude' }, { source: 'lon', attribute: 'b', type: 'number', role: 'latitude' }] };
	assert.equal(validateMapping(bad, parsed).length, 2);
	assert.throws(() => applyMapping(parsed, bad), /invalid mapping/);
});

test('a new mapping is a new version; the earlier one still means what it meant', () => {
	const v2: DatasetMapping = { version: 2, fields: inspection.proposed.fields.map((f) => (f.attribute === 'assessedValue' ? { ...f, attribute: 'taxAssessment' } : f)) };
	const a = applyMapping(parsed, inspection.proposed), b = applyMapping(parsed, v2);
	assert.ok(a.records[0].attributes.assessedValue && !a.records[0].attributes.taxAssessment);
	assert.ok(b.records[0].attributes.taxAssessment && !b.records[0].attributes.assessedValue);
});

test('addresses normalize for comparison only; incomplete addresses are not keys', () => {
	assert.equal(normalizeAddress('121 ELM STREET, METRO CO 80205'), '121 elm st');
	assert.equal(normalizeAddress('121 Elm St.'), '121 elm st');
	assert.equal(normalizeAddress('48 Oak Avenue'), normalizeAddress('48 oak ave'));
	assert.equal(normalizeAddress('PINE CT LOT 9'), null, 'no house number first: not an address');
	assert.equal(normalizeAddress('Elm St'), null);
});

test('resolution against the listing page: every outcome is explicit and explained', () => {
	const r = discover({ intent, pages: [metro] });
	const ents = new Map(metro.entities.map((e) => [e.id, e]));
	const ids = r.candidates.map((c) => identityOf(c.key, c.entityIds.map((i) => ents.get(i)!)));
	const res = Object.fromEntries(resolveCandidates(ids, parcels).map((x) => [x.candidateKey.split('/').pop()!, x]));

	assert.equal(res['elm-121'].status, 'matched'); assert.equal(res['elm-121'].basis, 'address+coordinates'); assert.equal(res['elm-121'].confidence, 'high'); assert.equal(res['elm-121'].recordId, '12-001-001');
	assert.equal(res['oak-48'].basis, 'address+coordinates');
	// "PINE CT LOT 9" is not a usable address, but its point is 15 m from the listing's.
	assert.equal(res['pine-9'].status, 'matched'); assert.equal(res['pine-9'].basis, 'coordinates'); assert.equal(res['pine-9'].confidence, 'medium'); assert.equal(res['pine-9'].recordId, '12-001-003');
	// Two parcels share one address and one location: never silently pick one.
	assert.equal(res['birch-300'].status, 'ambiguous'); assert.deepEqual(res['birch-300'].options!.map((o) => o.recordId).sort(), ['12-001-004', '12-001-005']);
	// The address matches, the coordinates say it is 5 km away: a conflict, not a match.
	assert.equal(res['cedar-77'].status, 'conflict'); assert.match(res['cedar-77'].reason, /5\d{3} m apart/);
	// Address only, no coordinates on the record: matched, but at medium confidence and labelled so.
	assert.equal(res['maple-15'].status, 'matched'); assert.equal(res['maple-15'].basis, 'address'); assert.equal(res['maple-15'].confidence, 'medium');
	assert.equal(res['aspen-62'].status, 'unmatched');
});

test('containment: a listing point inside exactly one parcel polygon; overlapping parcels are ambiguous', () => {
	const sq = (w: number, s: number, e: number, n: number) => [[[w, s], [e, s], [e, n], [w, n], [w, s]]];
	const gj = parseGeoJson(JSON.stringify({ type: 'FeatureCollection', features: [
		{ type: 'Feature', properties: { apn: 'A' }, geometry: { type: 'Polygon', coordinates: sq(-104.9815, 39.7505, -104.9805, 39.7515) } },
		{ type: 'Feature', properties: { apn: 'B' }, geometry: { type: 'Polygon', coordinates: sq(-104.9725, 39.7615, -104.9715, 39.7625) } },
		{ type: 'Feature', properties: { apn: 'C' }, geometry: { type: 'Polygon', coordinates: sq(-104.9722, 39.7618, -104.9712, 39.7628) } } // overlaps B
	] }));
	const ins = inspectDataset(gj);
	assert.equal(ins.withGeometry, 3);
	const ds: DatasetSource = { ...parcels, records: applyMapping(gj, ins.proposed).records };
	const mk = (key: string, lat: number, lng: number) => ({ key, parcelId: null, address: null, addressKey: null, lat, lng, values: new Map() });
	const [a, b, c] = resolveCandidates([mk('in-A', 39.751, -104.981), mk('in-B-and-C', 39.762, -104.972), mk('nowhere', 39.7, -105)], ds);
	assert.equal(a.status, 'matched'); assert.equal(a.basis, 'containment'); assert.equal(a.recordId, 'A');
	assert.equal(b.status, 'ambiguous'); assert.deepEqual(b.options!.map((o) => o.recordId).sort(), ['B', 'C']);
	assert.equal(c.status, 'unmatched');
	assert.ok(distanceM({ lat: 39.751, lng: -104.981 }, { lat: 39.7511, lng: -104.9811 }) < 20);
});

test('augmented discovery: parcel facts enter the existing evaluator, labelled, with provenance', () => {
	const { result, augmentation } = discoverAugmented({ intent, pages: [metro], enrichments: [rents], datasets: [parcels] });
	const c = (id: string) => result.candidates.find((x) => x.key === home(id))!;
	// net yield = (rent × 12 − annual tax) / price, computed by hand from the fixtures
	assert.ok(Math.abs(c('elm-121').metrics.netYield.value! - (2350 * 12 - 3180) / 289000) < 1e-12);
	assert.equal(c('elm-121').status, 'match');
	assert.ok(Math.abs(c('pine-9').metrics.netYield.value! - (2290 * 12 - 2900) / 249000) < 1e-12);
	assert.equal(c('pine-9').status, 'match');
	assert.equal(c('oak-48').status, 'non_match', 'net yield 7.5% is below 8%');
	assert.ok(Math.abs(c('oak-48').metrics.netYield.value! - (2400 * 12 - 3600) / 335000) < 1e-12);
	// ambiguous and conflicting matches add nothing: the metric stays unknown and the candidate is only "possible"
	for (const id of ['birch-300', 'cedar-77']) { assert.equal(c(id).metrics.netYield.value, null); assert.equal(c(id).status, 'possible'); }
	// provenance names the external source for tax and the rent survey for rent
	const prov = c('elm-121').criteria.find((x) => x.id === 'net')!.provenance;
	assert.ok(prov.includes('annualPropertyTax:external-record(ds-parcels)'));
	assert.ok(prov.includes('estimatedMonthlyRent:external-estimate(metro-rent-survey-2026)'));

	// the report shows every augmented value with its dataset version, freshness, record and basis
	const v = augmentation.values.find((x) => x.candidateKey === home('elm-121') && x.attribute === 'annualPropertyTax')!;
	assert.deepEqual(v.value, { amount: 3180, currency: 'USD' });
	assert.equal(v.recordId, '12-001-001'); assert.equal(v.basis, 'address+coordinates');
	assert.deepEqual([v.dataset.versionId, v.dataset.mappingVersion, v.dataset.freshness, v.dataset.dataAsOf], ['v1', 1, 'static', '2026-01-01']);
	assert.equal(augmentation.values.some((x) => ['birch-300', 'cedar-77', 'aspen-62'].some((id) => x.candidateKey === home(id))), false);
	assert.equal(augmentation.enrichments[0].source.method, 'external-record');
});

test('where the page and the dataset disagree, the page wins and the disagreement is reported', () => {
	const { augmentation, result } = discoverAugmented({ intent: { ...intent, metrics: [], criteria: [{ id: 'built', label: 'built after 1978', where: { attr: 'yearBuilt', op: 'gt', value: 1978 } }] }, pages: [metro], datasets: [parcels] });
	const oak = augmentation.values.find((x) => x.candidateKey === home('oak-48') && x.attribute === 'yearBuilt')!;
	assert.equal(oak.value, 1979); assert.deepEqual(oak.conflict, { pageValue: 1978 });
	assert.equal(result.candidates.find((x) => x.key === home('oak-48'))!.status, 'non_match', 'the page says 1978, so 1978 is what is evaluated');
	const elm = augmentation.values.find((x) => x.candidateKey === home('elm-121') && x.attribute === 'yearBuilt')!;
	assert.equal(elm.conflict, undefined, 'agreement is not a conflict');
});

test('without a dataset, discovery is exactly what it was', () => {
	const plain = discover({ intent, pages: [metro], enrichments: [rents] });
	const aug = discoverAugmented({ intent, pages: [metro], enrichments: [rents], datasets: [] });
	assert.equal(aug.result.resultDigest, plain.resultDigest);
});

test('REGRESSION (found by the synthetic scale workload, scripts/m9-scale.ts): profiling a column of 200,000 numbers does not overflow the call stack', () => {
	const rows = ['id,v', ...Array.from({ length: 200_000 }, (_, i) => `${i},${i % 977}`)].join('\n');
	const p = inspectDataset(parseCsv(rows)).fields.find((f) => f.name === 'v')!;
	assert.deepEqual([p.type, p.min, p.max, p.present], ['number', 0, 976, 200_000]);
});
