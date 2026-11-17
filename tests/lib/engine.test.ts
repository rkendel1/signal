/** The pure engine: mapping, identity, three-valued evaluation, freshness, conflicts, derived values, lifecycle. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseJsonRecords } from '../../lib/sources/records.ts';
import { applyMapping, draftHash, proposeMapping, validateMapping } from '../../lib/engine/mapping.ts';
import { EntityIndex, keysFrom, planIngestion, resolveIdentity } from '../../lib/engine/identity.ts';
import { validateCriteria, type CriteriaDefinition } from '../../lib/engine/criteria.ts';
import { evaluate } from '../../lib/engine/evaluate.ts';
import { decide } from '../../lib/engine/lifecycle.ts';
import type { EntityEvidence, ObservationDraft, SourceInfo, StoredObservation } from '../../lib/engine/types.ts';

const NOW = '2026-11-17T12:00:00.000Z';
const src = (id: string, extra: Partial<SourceInfo> = {}): SourceInfo => ({ id, name: id, kind: 'file', origin: 'user', status: 'connected', staleAfterDays: null, synthetic: true, ...extra });
const stored = (d: ObservationDraft, sourceId: string, at = '2026-11-10T00:00:00.000Z', version = 1): StoredObservation => ({ ...d, observationId: `${sourceId}/${d.recordKey}/v${version}`, sourceId, ingestionId: 'i', version, observedAt: at, contentHash: draftHash(d), status: 'current' });

const listingsCsv = `listing_id,address,lat,lng,price,beds\nL1,12 Oak Street,41.8240,-71.4128,"$300,000",3\nL2,40 Elm St,41.8300,-71.4000,450000,4\nL3,9 Pine Rd,41.8400,-71.4200,250000,2\n`;
const parcelsCsv = `parcel_id,site_address,latitude,longitude,assessed_value,annual_tax,flood_zone\nP-1,12 Oak St,41.8241,-71.4127,280000,4200,X\nP-2,40 Elm Street,41.8301,-71.4001,500000,9000,AE\nP-3,9 Pine Road,41.8600,-71.4200,240000,3900,X\n`;

function build() {
	const l = parseCsv(listingsCsv), p = parseCsv(parcelsCsv);
	const lm = proposeMapping(l, 'property').mapping, pm = proposeMapping(p, 'property').mapping;
	return { l: applyMapping(l, lm).drafts, p: applyMapping(p, pm).drafts, lm, pm };
}

test('mapping proposals: keys, ids, address, coordinates and money are recognised; values keep their original text', () => {
	const { l, p, lm, pm } = build();
	assert.deepEqual(validateMapping(lm), []);
	assert.equal(lm.fields.find((f) => f.source === 'listing_id')?.role, 'key');
	assert.equal(pm.fields.find((f) => f.source === 'parcel_id')?.role, 'id');
	assert.equal(l[0].recordKey, 'L1');
	assert.equal(p[0].recordKey, 'parcelId:P-1');
	assert.deepEqual(l[0].attributes.price, { value: { amount: 300000, currency: 'USD' }, raw: '$300,000', unit: 'USD', transform: 'money(USD)' });
	assert.equal(l[0].identity.addressKey, '12 oak st');
	assert.equal(p[0].identity.addressKey, '12 oak st');
});

test('mapping refuses protected characteristics', () => {
	const ds = parseCsv('id,price,race_pct\n1,10,5\n');
	const prop = proposeMapping(ds, 'property');
	assert.ok(prop.skipped.some((s) => s.column === 'race_pct'));
	assert.match(validateMapping({ version: 1, entityType: 'x', fields: [{ source: 'race_pct', attribute: 'racePct', type: 'number' }] }).join(), /protected/);
	assert.throws(() => validateCriteria({ name: 'x', entityType: 'property', severity: 'info', require: [{ attr: 'familialStatus', op: 'exists' }] }), /protected/);
});

test('JSON records at a path, nested properties flattened', () => {
	const ds = parseJsonRecords(JSON.stringify({ data: { items: [{ id: 'a', loc: { lat: 1, lng: 2 }, tags: ['x'] }] } }), 'data.items');
	assert.deepEqual(ds.fields.sort(), ['id', 'loc.lat', 'loc.lng', 'tags']);
	assert.equal(ds.rows[0].pointer, '/data/items/0');
});

test('identity: address + coordinates → probable; distant coordinates → conflict; shared id → exact; two candidates → ambiguous', () => {
	const { l, p } = build();
	const ents = l.map((d, i) => ({ entityId: `e${i}`, type: 'property', label: d.identity.address, keys: keysFrom([{ identity: d.identity, sourceId: 'listings' }]) }));
	const ix = new EntityIndex(ents);
	const r1 = resolveIdentity(p[0], 'parcels', ix);
	assert.equal(r1.status, 'probable'); assert.equal(r1.entityId, 'e0'); assert.equal(r1.basis, 'address+coordinates');
	const r3 = resolveIdentity(p[2], 'parcels', ix);
	assert.equal(r3.status, 'conflict', r3.reason); assert.equal(r3.entityId, null);
	// a shared identifier is exact
	const withId = new EntityIndex([{ entityId: 'z', type: 'property', label: null, keys: keysFrom([{ identity: { ...p[0].identity }, sourceId: 'other' }]) }]);
	assert.equal(resolveIdentity({ identity: { ids: { parcelId: 'P-1' }, address: null, addressKey: null, lat: null, lng: null, name: null } }, 'listings', withId).status, 'exact');
	// two entities at one address, no location to separate them
	const twin = new EntityIndex([ents[0], { ...ents[0], entityId: 'e9', keys: keysFrom([{ identity: { ...l[0].identity, lat: null, lng: null }, sourceId: 'listings2' }]) }]);
	const amb = resolveIdentity({ identity: { ...p[0].identity, lat: null, lng: null } }, 'parcels', twin);
	assert.equal(amb.status, 'ambiguous'); assert.equal(amb.options.length, 2); assert.equal(amb.entityId, null);
	// a different identifier at the same address is a conflict, not a match
	const clash = new EntityIndex([{ entityId: 'q', type: 'property', label: null, keys: keysFrom([{ identity: { ...p[0].identity, ids: { parcelId: 'P-999' } }, sourceId: 'parcelsB' }]) }]);
	assert.equal(resolveIdentity(p[0], 'parcels', clash).status, 'conflict');
});

test('ingestion planning: unchanged content is not new information; snapshots retract, partial updates do not', () => {
	const { l } = build();
	const current = l.map((d) => ({ recordKey: d.recordKey, contentHash: draftHash(d), version: 1 }));
	const same = planIngestion(current, l.map((d) => ({ draft: d, hash: draftHash(d) })), 'snapshot');
	assert.deepEqual([same.added.length, same.changed.length, same.unchanged, same.retracted.length], [0, 0, 3, 0]);
	const edited = { ...l[0], attributes: { ...l[0].attributes, price: { value: { amount: 280000, currency: 'USD' }, raw: '280000', unit: 'USD' } } };
	const snap = planIngestion(current, [edited].map((d) => ({ draft: d, hash: draftHash(d) })), 'snapshot');
	assert.deepEqual([snap.changed.length, snap.retracted.length], [1, 2]);
	const part = planIngestion(current, [edited].map((d) => ({ draft: d, hash: draftHash(d) })), 'partial', ['L3']);
	assert.deepEqual([part.changed.length, part.retracted.map((r) => r.recordKey)], [1, ['L3']]);
});

const CRIT: CriteriaDefinition = validateCriteria({
	name: 'Under-assessed, low-tax homes', entityType: 'property', severity: 'warning',
	derive: [{ name: 'priceToAssessed', expr: { op: '/', args: [{ attr: 'price' }, { attr: 'assessedValue' }] } }],
	require: [{ attr: 'price', op: 'lte', value: 400000 }, { attr: 'annualPropertyTax', op: 'lt', value: 5000 }, { attr: 'priceToAssessed', op: 'lte', value: 1.1 }],
	exclude: [{ attr: 'floodZone', op: 'in', value: ['AE', 'VE'] }],
	prefer: [{ when: { attr: 'numberOfBedrooms', op: 'gte', value: 3 }, weight: 20 }],
});

function evidence(listing: ObservationDraft | null, parcel: ObservationDraft | null, opts: { parcelAt?: string; parcelSource?: Partial<SourceInfo>; link?: 'exact' | 'probable' } = {}): EntityEvidence {
	const records = [];
	if (listing) records.push({ source: src('listings'), link: { status: 'unmatched' as const, basis: 'none' as const, confidence: 1 }, current: stored(listing, 'listings'), history: [] });
	if (parcel) records.push({ source: src('parcels', opts.parcelSource), link: { status: opts.link ?? 'probable', basis: 'address+coordinates' as const, confidence: opts.link === 'exact' ? 1 : 0.9 }, current: stored(parcel, 'parcels', opts.parcelAt), history: [] });
	return { entity: { entityId: 'e', type: 'property', label: null, keys: keysFrom([]) }, records };
}

test('a cross-source match: every condition explained with its source, derived value lists its inputs', () => {
	const { l, p } = build();
	const o = evaluate(evidence(l[0], p[0]), CRIT, NOW);
	assert.equal(o.qualification, 'match', o.summary);
	assert.deepEqual(o.sources, ['listings', 'parcels']);
	const ratio = o.require[2].leaf!.values[0];
	assert.deepEqual(ratio.inputs!.map((i) => [i.attr, i.values[0].sourceName]), [['price', 'listings'], ['assessedValue', 'parcels']]);
	assert.equal(o.score, Math.round((100 + 20) * 1.25));
	assert.equal(o.confidence, 0.9, 'joined by a probable identity match');
	assert.equal(o.exclude[0].result, 'false');
});

test('missing is not negative: without the parcel record the finding is possible, not a non-match', () => {
	const { l } = build();
	const o = evaluate(evidence(l[0], null), CRIT, NOW);
	assert.equal(o.qualification, 'possible');
	assert.deepEqual(o.missing.sort(), ['annualPropertyTax', 'floodZone']);
	assert.equal(o.require[1].leaf!.reason, 'missing');
});

test('stale evidence does not count; a fresh-enough requirement is the user’s call', () => {
	const { l, p } = build();
	const o = evaluate(evidence(l[0], p[0], { parcelAt: '2024-01-01T00:00:00.000Z', parcelSource: { staleAfterDays: 365 } }), CRIT, NOW);
	assert.equal(o.qualification, 'possible');
	assert.ok(o.stale.includes('annualPropertyTax'));
	assert.equal(o.require[1].leaf!.reason, 'stale');
});

test('conflicting sources: unknown unless every value gives the same answer or trust decides', () => {
	const { l, p } = build();
	const second = { ...l[0], recordKey: 'X', attributes: { ...l[0].attributes, price: { value: { amount: 420000, currency: 'USD' }, raw: '420000' } } };
	const ev = evidence(l[0], p[0]);
	ev.records.push({ source: src('feed'), link: { status: 'exact', basis: 'identifier', confidence: 1 }, current: stored(second, 'feed'), history: [] });
	const o = evaluate(ev, CRIT, NOW);
	assert.equal(o.require[0].result, 'unknown'); assert.equal(o.require[0].leaf!.reason, 'conflict');
	assert.equal(o.conflicts[0].attr, 'price'); assert.equal(o.conflicts[0].resolvedBy, null);
	const trusted = evaluate(ev, { ...CRIT, trust: { price: ['feed'] } }, NOW);
	assert.equal(trusted.require[0].result, 'false');
	assert.equal(trusted.qualification, 'non_match');
});

test('exclusion disqualifies; price drop is measured within one record’s own history', () => {
	const { l, p } = build();
	assert.equal(evaluate(evidence(l[1], p[1]), CRIT, NOW).qualification, 'excluded');
	const drop: CriteriaDefinition = validateCriteria({ name: 'drop', entityType: 'property', severity: 'info', require: [{ attr: 'price', op: 'decreased_pct', value: 5, withinDays: 30 }] });
	const v1 = stored(l[0], 'listings', '2026-11-01T00:00:00.000Z', 1);
	const cheaper = { ...l[0], attributes: { ...l[0].attributes, price: { value: { amount: 270000, currency: 'USD' }, raw: '270000' } } };
	const ev: EntityEvidence = { entity: { entityId: 'e', type: 'property', label: null, keys: keysFrom([]) }, records: [{ source: src('listings'), link: { status: 'unmatched', basis: 'none', confidence: 1 }, current: { ...stored(cheaper, 'listings', '2026-11-15T00:00:00.000Z', 2), observationId: 'v2' }, history: [{ ...v1, status: 'superseded' }] }] };
	const o = evaluate(ev, drop, NOW);
	assert.equal(o.qualification, 'match');
	assert.match(o.require[0].leaf!.note!, /down 10\.0% from/);
	const first = evaluate({ ...ev, records: [{ ...ev.records[0], history: [] }] }, drop, NOW);
	assert.equal(first.require[0].result, 'unknown', 'first seen inside the window: history is insufficient, not "no drop"');
});

test('lifecycle: new → persistent (dedup) → changed (beyond threshold) → resolved → reopened → superseded', () => {
	const { l, p } = build();
	const crit = { ...CRIT, changeThresholds: { price: { pct: 2 } } };
	const cause = { kind: 'ingestion' as const, ref: 'i', label: 'test' };
	const o1 = evaluate(evidence(l[0], p[0]), crit, NOW);
	const d1 = decide(null, o1, cause, crit, 1);
	assert.equal(d1.event!.kind, 'new'); assert.equal(d1.notify, true);
	const d2 = decide(d1.next, o1, cause, crit, 1);
	assert.equal(d2.event, null, 'same outcome: no event');
	const small = { ...l[0], attributes: { ...l[0].attributes, price: { value: { amount: 299000, currency: 'USD' }, raw: '299000' } } };
	assert.equal(decide(d1.next, evaluate(evidence(small, p[0]), crit, NOW), cause, crit, 1).event, null, '0.3% is below the 2% threshold');
	const big = { ...l[0], attributes: { ...l[0].attributes, price: { value: { amount: 260000, currency: 'USD' }, raw: '260000' } } };
	const d3 = decide(d1.next, evaluate(evidence(big, p[0]), crit, NOW), cause, crit, 1);
	assert.equal(d3.event!.kind, 'changed'); assert.ok(d3.event!.diff.some((x) => x.what === 'price'));
	const pricey = { ...l[0], attributes: { ...l[0].attributes, price: { value: { amount: 600000, currency: 'USD' }, raw: '600000' } } };
	const d4 = decide(d3.next, evaluate(evidence(pricey, p[0]), crit, NOW), cause, crit, 1);
	assert.equal(d4.event!.kind, 'resolved'); assert.equal(d4.next!.status, 'resolved');
	const d5 = decide(d4.next, o1, cause, crit, 1);
	assert.equal(d5.event!.kind, 'reopened');
	const stricter = validateCriteria({ ...crit, require: [{ attr: 'price', op: 'lte', value: 200000 }] });
	const d6 = decide(d5.next, evaluate(evidence(l[0], p[0]), stricter, NOW), { kind: 'criteria', ref: 'v2', label: 'criteria v2' }, stricter, 2);
	assert.equal(d6.event!.kind, 'superseded');
	const d7 = decide(d5.next, evaluate(evidence(l[0], null), { ...crit, includePossible: false }, NOW), { kind: 'source_removed', ref: 'parcels', label: 'source removed' }, crit, 1);
	assert.equal(d7.event!.kind, 'invalid');
});

test('determinism: identical inputs give an identical outcome and digest', () => {
	const { l, p } = build();
	assert.equal(JSON.stringify(evaluate(evidence(l[0], p[0]), CRIT, NOW)), JSON.stringify(evaluate(evidence(l[0], p[0]), CRIT, NOW)));
});
