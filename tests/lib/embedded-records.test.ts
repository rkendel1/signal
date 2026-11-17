/**
 * Listing cards that carry their own record as JSON in a data-* attribute, on a SYNTHETIC page built to the
 * structure of a real results page (fake addresses). Found on a real page: the cards were extracted but stayed
 * typed Unknown, and the embedded record (coordinates, assessed value, beds, baths) was never read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractPage } from '../../lib/page/extract.ts';
import { applyMapping, inspectDataset, parseCsv } from '../../lib/datasets/dataset.ts';
import { discoverAugmented, type DatasetSource } from '../../lib/datasets/resolve.ts';
import type { DiscoveryIntent } from '../../lib/discovery/discover.ts';

const html = readFileSync(new URL('../fixtures/pages/embedded-cards.html', import.meta.url), 'utf8');
const url = 'https://listings.example/homes/';
const page = extractPage({ html, locator: url, baseUrl: url, observationId: 'o', contentHash: 'o', contentType: 'text/html', observedAt: '2026-11-17T12:00:00.000Z' });
const listings = page.entities.filter((e) => e.type === 'RealEstateListing');
const val = (e: (typeof listings)[number], n: string) => e.attributes.find((a) => a.name === n)?.value;
const amount = (v: unknown) => (v && typeof v === 'object' ? (v as { amount: number }).amount : v);

test('each card is one listing, typed as such, even when its facts arrive from several places', () => {
	assert.equal(listings.length, 3, 'one listing per card: not zero (Unknown), not six (a copy per source)');
	assert.equal(page.entities.filter((e) => e.type === 'Unknown').length, 0, 'no card is left untyped');
	const byAddr = Object.fromEntries(listings.map((e) => [String(val(e, 'address')).split(',')[0], e]));
	assert.deepEqual(Object.keys(byAddr).sort(), ['12 Example Rd', '34 Sample Ave', '56 Placeholder Ln']);
	// the first card also has a JSON-LD event for the same URL: it adds no second listing
	const first = byAddr['12 Example Rd'];
	assert.equal(first.identity.basis, 'url');
	assert.match(first.typeBasis.rule, /T1b/);
	assert.ok(page.entities.some((e) => e.type === 'Event'), 'the event is kept, as an event');
});

test('the embedded record is read: coordinates, assessed value, beds, baths, floor area, property type', () => {
	const e = listings.find((x) => String(val(x, 'address')).startsWith('34 Sample'))!;
	assert.deepEqual([val(e, 'latitude'), val(e, 'longitude')], [41.7102, -71.5102]);
	assert.equal(amount(val(e, 'taxAssessedValue')), 390000);
	assert.equal(amount(val(e, 'price')), 450000);
	assert.deepEqual([val(e, 'numberOfBedrooms'), val(e, 'numberOfBathrooms'), val(e, 'floorSize')], [4, 3, 2100]);
	assert.equal(val(e, 'propertyType'), 'MULTI_FAMILY');
	assert.equal(val(e, 'listingId'), '900002');
	// URL-encoded and plain JSON attributes are both read
	assert.equal(amount(val(listings.find((x) => String(val(x, 'address')).startsWith('56 Placeholder'))!, 'taxAssessedValue')), 240000, 'a plain-JSON attribute');
	// the site's own estimates keep the site's names; they are not presented as anything else
	assert.equal(amount(val(listings.find((x) => String(val(x, 'address')).startsWith('12 Example'))!, 'zestimate')), 305000);
});

test('keys outside the allow-list are not read; owner-occupancy in particular', () => {
	for (const e of listings) assert.ok(!e.attributes.some((a) => /owner|occup/i.test(a.name)), 'no owner-related attribute');
	assert.ok(!page.entities.some((e) => e.attributes.some((a) => a.name === 'isNonOwnerOccupied')));
});

test('virtualized placeholders are not listings, and the page says how many exist', () => {
	assert.equal(page.entities.filter((e) => e.type === 'ListItem' && e.attributes.length === 0).length, 0, 'empty placeholder rows leave no entity');
	const wp = page.entities.find((e) => e.type === 'WebPage')!;
	assert.ok(JSON.stringify(wp.attributes).includes('40 results') || page.title?.includes('40'), 'the declared total (40) is on the page, though 3 cards are');
});

test('end to end: coordinates read from the card match a parcel with no address in common to normalize', () => {
	const csv = 'parcel_no,site_addr,assessed_total,tax_annual,lat,lon\n77-001,"12 EXAMPLE ROAD",$281000,$3400,41.70012,-71.50011\n77-002,"34 SAMPLE AVENUE",$392000,$4800,41.71021,-71.51021\n77-003,"56 PLACEHOLDER LANE",$241000,$2900,41.75,-71.6\n';
	const parsed = parseCsv(csv);
	const ds: DatasetSource = { id: 'd', name: 'parcels', versionId: 'v', mappingVersion: 1, freshness: 'static', dataAsOf: null, retrievedAt: '', records: applyMapping(parsed, inspectDataset(parsed).proposed).records };
	const intent: DiscoveryIntent = { schema: 'signal.intent/v1', id: 'i', version: 1, name: 'i', target: { type: ['RealEstateListing'] }, criteria: [] };
	const { result, augmentation } = discoverAugmented({ intent, pages: [page], datasets: [ds] });
	assert.equal(result.candidates.length, 3, 'discovery now sees the three cards');
	const by = Object.fromEntries(augmentation.resolutions[0].resolutions.map((r) => [r.candidateKey.split('/').filter(Boolean).pop()!, r]));
	const status = Object.values(by).map((r) => `${r.status}:${r.basis ?? ''}`).sort();
	assert.deepEqual(status, ['conflict:', 'matched:address+coordinates', 'matched:address+coordinates'], 'two confirmed by address and location; the third has the address but its parcel is ~6 km away: a conflict, not a match');
});
