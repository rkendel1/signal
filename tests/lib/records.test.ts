/** Parsing, mapping and identity details for user-provided records (synthetic inputs written for each case). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseGeoJson } from '../../lib/sources/records.ts';
import { applyMapping, normalizeAddress, profileFields, proposeMapping, validateMapping, type SourceMapping } from '../../lib/engine/mapping.ts';
import { EntityIndex, distanceM, keysFrom, resolveIdentity } from '../../lib/engine/identity.ts';

test('csv: quotes, CRLF, BOM; malformed input is rejected, not guessed at', () => {
	const d = parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n,2\r\n');
	assert.deepEqual(d.rows.map((r) => r.props), [{ a: 'x, y', b: 'say "hi"' }, { a: null, b: '2' }]);
	assert.throws(() => parseCsv('a,a\n1,2'), /duplicate/);
	assert.throws(() => parseCsv('a,b\n"open,2'), /unterminated/);
});

const parcels = parseCsv('parcel_no,site_addr,assessed_total,tax_annual,yr_built,lat,lon,owner_name\n12-1,"121 ELM STREET",$241000,$3100,1962,39.75,-104.98,A\n12-2,48 Oak Ave,n/a,$2800,1971,,,B\n12-3,7 Ash Ct,$199000,$2500,1980,39.7,-104.9,C\n12-4,9 Ash Ct,$205000,$2600,1981,39.71,-104.91,D\n12-5,11 Ash Ct,$215000,$2700,1982,39.72,-104.92,E\n');

test('proposals come from a fixed vocabulary and are reviewable; unknown columns are kept under their own name', () => {
	const { proposals, mapping } = proposeMapping(parcels, 'property');
	const by = Object.fromEntries(proposals.map((p) => [p.source, p]));
	assert.equal(by.parcel_no.attribute, 'parcelId'); assert.equal(by.parcel_no.role, 'id');
	assert.equal(by.assessed_total.type, 'money');
	assert.equal(by.owner_name.attribute, 'ownerName'); assert.match(by.owner_name.basis, /own name/);
	assert.deepEqual(validateMapping(mapping, parcels), []);
	assert.equal(profileFields(parcels).find((f) => f.name === 'assessed_total')!.type, 'number', 'currency formatting is understood');
});

test('mapping: bad values are reported with their row and are absent, never zero; blank coordinates stay unknown', () => {
	const m = applyMapping(parcels, proposeMapping(parcels, 'property').mapping);
	assert.deepEqual(m.issues, [{ row: 1, field: 'assessed_total', problem: 'not an amount', raw: 'n/a' }]);
	assert.equal(m.drafts[1].attributes.assessedValue, undefined);
	assert.equal(m.drafts[1].identity.lat, null);
	const bad: SourceMapping = { version: 1, entityType: 'p', fields: [{ source: 'nope', attribute: 'x', type: 'text' }, { source: 'lat', attribute: 'a', type: 'number', role: 'latitude' }, { source: 'lon', attribute: 'b', type: 'number', role: 'latitude' }] };
	assert.equal(validateMapping(bad, parcels).length, 2);
	assert.throws(() => applyMapping(parcels, bad), /invalid mapping/);
});

test('addresses normalize for comparison only; incomplete addresses are not keys', () => {
	assert.equal(normalizeAddress('121 ELM STREET, METRO CO 80205'), '121 elm st');
	assert.equal(normalizeAddress('121 Elm St.'), '121 elm st');
	assert.equal(normalizeAddress('48 Oak Avenue'), normalizeAddress('48 oak ave'));
	assert.equal(normalizeAddress('PINE CT LOT 9'), null);
	assert.equal(normalizeAddress('Elm St'), null);
});

test('containment: a point inside exactly one parcel polygon; overlapping parcels are ambiguous', () => {
	const sq = (w: number, s: number, e: number, n: number) => [[[w, s], [e, s], [e, n], [w, n], [w, s]]];
	const gj = parseGeoJson(JSON.stringify({ type: 'FeatureCollection', features: [
		{ type: 'Feature', properties: { apn: 'A', v: 1 }, geometry: { type: 'Polygon', coordinates: sq(-104.9815, 39.7505, -104.9805, 39.7515) } },
		{ type: 'Feature', properties: { apn: 'B', v: 2 }, geometry: { type: 'Polygon', coordinates: sq(-104.9725, 39.7615, -104.9715, 39.7625) } },
		{ type: 'Feature', properties: { apn: 'C', v: 3 }, geometry: { type: 'Polygon', coordinates: sq(-104.9722, 39.7618, -104.9712, 39.7628) } },
	] }));
	const drafts = applyMapping(gj, proposeMapping(gj, 'property').mapping).drafts;
	const ix = new EntityIndex(drafts.map((d) => ({ entityId: d.recordKey, type: 'property', label: null, keys: keysFrom([{ identity: d.identity, sourceId: 'parcels' }]) })));
	const at = (lat: number, lng: number) => resolveIdentity({ identity: { ids: {}, address: null, addressKey: null, lat, lng, name: null } }, 'listings', ix);
	const a = at(39.751, -104.981), b = at(39.762, -104.972), c = at(39.7, -105);
	assert.equal(a.status, 'probable'); assert.equal(a.basis, 'containment'); assert.equal(a.entityId, 'parcelId:A');
	assert.equal(b.status, 'ambiguous'); assert.deepEqual(b.options.map((o) => o.entityId).sort(), ['parcelId:B', 'parcelId:C']);
	assert.equal(c.status, 'unmatched');
	assert.ok(distanceM({ lat: 39.751, lng: -104.981 }, { lat: 39.7511, lng: -104.9811 }) < 20);
});

test('profiling a column of 200,000 numbers does not overflow the call stack', () => {
	const rows = ['id,v', ...Array.from({ length: 200_000 }, (_, i) => `${i},${i % 977}`)].join('\n');
	const p = profileFields(parseCsv(rows)).find((f) => f.name === 'v')!;
	assert.deepEqual([p.type, p.min, p.max, p.present], ['number', 0, 976, 200_000]);
});
