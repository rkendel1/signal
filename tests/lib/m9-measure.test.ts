/**
 * Harness self-check (SYNTHETIC). These tests prove the M9 measurement arithmetic is right, using fixtures and
 * labels written for the purpose, including deliberately wrong expectations. They are not a measurement of Signal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractPage } from '../../lib/page/extract.ts';
import { applyMapping, inspectDataset, parseCsv } from '../../lib/datasets/dataset.ts';
import { candidateIdentities, resolveCandidates, type DatasetSource } from '../../lib/datasets/resolve.ts';
import type { DiscoveryIntent } from '../../lib/discovery/discover.ts';
import { confusion, inputProfile, judge, pinDistances, quantiles, resolutionTally, wilson, type Label } from '../../lib/validation/measure.ts';

const fx = (f: string) => readFileSync(new URL(`../fixtures/discovery/${f}`, import.meta.url), 'utf8');
const parsed = parseCsv(fx('parcels.csv'));
const records = applyMapping(parsed, inspectDataset(parsed).proposed).records;
const ds: DatasetSource = { id: 'd', name: 'd', versionId: 'v', mappingVersion: 1, freshness: 'static', dataAsOf: null, retrievedAt: '', records };
const page = extractPage({ html: fx('metro-p1.html'), locator: 'https://homes.example/s', baseUrl: 'https://homes.example/s', observationId: 'o', contentHash: 'o', contentType: 'text/html', observedAt: '2026-11-17T12:00:00.000Z' });
const intent: DiscoveryIntent = { schema: 'signal.intent/v1', id: 'i', version: 1, name: 'i', target: { type: ['RealEstateListing'] }, criteria: [] };
const idents = candidateIdentities({ intent, pages: [page] });
const resolutions = resolveCandidates(idents, ds);

test('candidateIdentities is what augment() resolves: same candidates, same outcomes', () => {
	assert.equal(idents.length, 11);
	assert.deepEqual(resolutionTally(resolutions).byStatus, { matched: 4, ambiguous: 1, conflict: 1, unmatched: 5 });
});

test('verdicts: a wrong join is a false match; refusing to choose is safe; unextracted listings are counted apart', () => {
	const labels: Label[] = [
		{ listing: '121 Elm St', expected: { parcelId: '12-001-001' } },        // joined that parcel → correct
		{ listing: '48 Oak Ave', expected: { parcelId: '12-999-999' } },        // reviewer says another parcel → FALSE match
		{ listing: '9 Pine Ct', expected: 'none' },                             // joined, but reviewer found none → FALSE match
		{ listing: '300 Birch Rd', expected: { parcelId: '12-001-004' } },      // ambiguous → safe, a lost match
		{ listing: '77 Cedar Ln', expected: { parcelId: '12-001-006' } },       // conflict → safe
		{ listing: '62 Aspen Way', expected: 'none' },                          // unmatched, correctly
		{ listing: '41 Alder Ct', expected: { parcelId: '12-777-777' } },       // unmatched though a parcel exists → safe lost match
		{ listing: '1 Missing Rd', expected: { parcelId: '12-000-000' } }       // not on the page at all
	];
	const j = judge(labels, idents, resolutions, records);
	assert.deepEqual(j.map((x) => x.verdict), ['correct_match', 'false_match', 'false_match', 'safe_ambiguous', 'safe_conflict', 'correct_unmatched', 'safe_unmatched', 'not_extracted']);
	const c = confusion(j);
	assert.equal(c.labelled, 8); assert.equal(c.extracted, 7);
	assert.equal(c.counts.false_match, 2);
	assert.equal(c.matchPrecision, 1 / 3);
	assert.equal(c.falseMatchRate, 2 / 7);
	assert.equal(c.recall, 1 / 5, '1 correct of the 5 extracted listings that have a parcel (Elm, Oak, Birch, Cedar, Alder)');
	assert.ok(c.falseMatchInterval![0] < 2 / 7 && c.falseMatchInterval![1] > 2 / 7);
	assert.equal(j[0].distanceM, 14, 'pin-to-parcel distance is recorded for matched listings');
});

test('an undecidable listing that Signal joined anyway is a false match; one it refused is not', () => {
	const j = judge([{ listing: '300 Birch Rd', expected: 'indistinguishable' }, { listing: '121 Elm St', expected: 'indistinguishable' }], idents, resolutions, records);
	assert.deepEqual(j.map((x) => x.verdict), ['safe_ambiguous', 'false_match']);
});

test('statistics: Wilson interval, quantiles, input profile, pin distances', () => {
	assert.equal(wilson(0, 0), null);
	const [lo, hi] = wilson(0, 20)!; assert.equal(lo, 0); assert.ok(hi > 0.1 && hi < 0.2, 'zero false matches in 20 does not mean a zero rate');
	assert.deepEqual(quantiles([5, 1, 3, 2, 4]), { n: 5, p50: 3, p90: 5, p99: 5, max: 5 });
	assert.equal(quantiles([]), null);
	const p = inputProfile(idents, records);
	assert.equal(p.listings.count, 11); assert.equal(p.listings.withCoordinates, 11);
	assert.equal(p.parcels.count, 9); assert.equal(p.parcels.addressKeysShared, 1); assert.equal(p.parcels.recordsOnSharedAddress, 2);
	assert.equal(pinDistances(idents, resolutions, records).length, 3, 'the address-only match has no parcel point to measure from');
});
