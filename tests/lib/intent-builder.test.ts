/** The panel's control → intent mapping, end to end with real facets and the real evaluator. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractPage } from '../../lib/page/extract.ts';
import { discover, facets } from '../../lib/discovery/discover.ts';
import { buildIntent, defaultFilter, formatValue, niceStep, reconcile, type EditorState } from '../../extension/src/intent-builder.ts';

const hood = extractPage({ html: readFileSync(new URL('../fixtures/discovery/neighborhood.html', import.meta.url), 'utf8'), locator: 'https://homes.example/search', baseUrl: 'https://homes.example/search', observationId: 'o', contentHash: 'h', contentType: 'text/html', observedAt: '2026-11-17T12:00:00.000Z' });

test('controls build an intent; untouched controls add no criteria', () => {
	const f = facets([hood]);
	let state: EditorState = reconcile({ types: f.selected, filters: {} }, f.facets);
	assert.deepEqual(buildIntent(state, f.facets).criteria, [], 'nothing switched on, nothing required');
	state.filters.price = { ...(state.filters.price as any), on: true, hi: 300000 };
	state.filters.numberOfBedrooms = { ...(state.filters.numberOfBedrooms as any), on: true, lo: 3 };
	state.filters.priceReduction = { ...(state.filters.priceReduction as any), on: true };
	const intent = buildIntent(state, f.facets);
	assert.deepEqual(intent.criteria.map((c) => [c.id, c.where.op, c.where.value, c.absent ?? null, c.label]), [
		['numberOfBedrooms', 'between', [3, 4], null, 'Bedrooms 3–4'],
		['price', 'between', [199000, 300000], null, 'Price $199,000–$300,000'],
		['priceReduction', 'exists', undefined, 'false', 'Has price reduction']
	]);
	const r = discover({ intent, pages: [hood] });
	assert.deepEqual(r.candidates.filter((c) => c.status === 'match').map((c) => c.name), ['9 Pine Ct']);
	// Presence filters treat absence as "no" by default; switched to unknown, absence makes candidates possible instead.
	state.filters.priceReduction = { kind: 'presence', on: true, missing: 'unknown' };
	const open = discover({ intent: buildIntent(state, f.facets), pages: [hood] });
	assert.ok(open.candidates.some((c) => c.name === '121 Elm St' && c.status === 'possible'));
});

test('categories become an "in" criterion; settings survive recomputed facets', () => {
	const fake = [{ attr: 'availability', label: 'Availability', kind: 'category' as const, present: 3, of: 3, values: [{ value: 'InStock', count: 2 }, { value: 'OutOfStock', count: 1 }] }];
	const s = reconcile({ types: ['Product'], filters: {} }, fake);
	s.filters.availability = { kind: 'category', on: true, values: ['InStock'], missing: 'unknown' };
	assert.deepEqual(buildIntent(s, fake).criteria[0].where, { attr: 'availability', op: 'in', value: ['InStock'] });
	const again = reconcile(s, fake);
	assert.deepEqual(again.filters.availability, s.filters.availability);
	assert.equal(defaultFilter({ attr: 'x', label: 'X', kind: 'presence', present: 1, of: 2 }).missing, 'false');
});

test('formatting and slider steps', () => {
	assert.equal(formatValue({ unit: 'money', currency: 'GBP' }, 13.99), '£13.99');
	assert.equal(formatValue({ unit: 'money', currency: 'USD' }, 300000), '$300,000');
	assert.equal(formatValue({ unit: 'number' }, 1986), '1986');
	assert.equal(niceStep({ attr: 'p', label: 'P', kind: 'range', present: 1, of: 1, min: 199000, max: 410000 }), 5000);
	assert.equal(niceStep({ attr: 'b', label: 'B', kind: 'range', present: 1, of: 1, min: 2, max: 4 }), 1);
	assert.equal(niceStep({ attr: 'p', label: 'P', kind: 'range', present: 1, of: 1, min: 13.99, max: 57.25 }), 0.5);
});
