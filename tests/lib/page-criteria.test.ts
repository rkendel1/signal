/** Criteria over signal.page/v1 — none of these criteria know which website produced the page. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractPage } from '../../lib/page/extract.ts';
import { evaluateEntityCondition, type EntityCondition } from '../../lib/page/query.ts';
import { DeterministicEvaluator, validateCondition } from '../../lib/core/evaluate.ts';
import type { CriteriaDefinition, Interpretation } from '../../lib/contracts/types.ts';

const fixture = (n: string) => readFileSync(new URL(`../fixtures/pages/${n}.html`, import.meta.url), 'utf8');
const page = (html: string, obs = 'obs_1') => extractPage({ html, locator: 'https://unfamiliar.example/x', baseUrl: 'https://unfamiliar.example/x', observationId: obs, contentHash: 'h', contentType: 'text/html', observedAt: '2026-11-17T12:00:00.000Z' });
const names = (r: ReturnType<typeof evaluateEntityCondition>) => r.matches.map((m) => m.name).sort();

test('any product costs less than $200 — the right product, with its own price', () => {
	const r = evaluateEntityCondition({ type: 'Product', where: [{ attr: 'price', op: 'lt', value: 200, currency: 'USD' }] }, page(fixture('products')), undefined);
	assert.equal(r.matched, true);
	assert.deepEqual(names(r), ['Canyon 1']);
	assert.deepEqual(r.matches[0].values.price, [{ amount: 179.99, currency: 'USD' }]);
	assert.ok(r.matches[0].evidenceRefs.length >= 2, 'entity and attribute evidence');
});

test('relationships and combinations: products under $300 sold by Summit Supply Co. and in stock', () => {
	const c: EntityCondition = { type: 'Product', where: [{ attr: 'price', op: 'lt', value: 300 }, { attr: 'availability', op: 'eq', value: 'InStock' }], related: [{ rel: 'seller', entity: { type: 'Organization', where: [{ attr: 'name', op: 'contains', value: 'summit' }] } }] };
	assert.deepEqual(names(evaluateEntityCondition(c, page(fixture('products')), undefined)), ['Ridgeline 2']);
	// Quantifiers and counts
	assert.equal(evaluateEntityCondition({ type: 'Product', quantifier: 'all', where: [{ attr: 'price', op: 'gt', value: 100 }] }, page(fixture('products')), undefined).matched, true);
	assert.equal(evaluateEntityCondition({ type: 'Product', quantifier: 'none', where: [{ attr: 'availability', op: 'eq', value: 'Discontinued' }] }, page(fixture('products')), undefined).matched, true);
	assert.equal(evaluateEntityCondition({ type: 'Product', count: { op: 'gte', value: 3 } }, page(fixture('products')), undefined).matched, true);
	assert.equal(evaluateEntityCondition({ type: 'Product', inCollection: { kind: 'repeated', itemType: 'Product' } }, page(fixture('products')), undefined).matches.length, 3);
});

test('a job matching a title and a compensation range', () => {
	const c: EntityCondition = { type: 'JobPosting', where: [{ attr: 'name', op: 'matches', value: 'product manager' }, { attr: 'compensation', op: 'overlaps', value: [150000, 170000] }] };
	assert.deepEqual(names(evaluateEntityCondition(c, page(fixture('job')), undefined)), ['Senior AI Product Manager']);
	const outside: EntityCondition = { type: 'JobPosting', where: [{ attr: 'compensation', op: 'between', value: [100000, 150000] }] };
	assert.deepEqual(names(evaluateEntityCondition(outside, page(fixture('job')), undefined)), ['Data Engineer']);
	const byEmployer: EntityCondition = { type: 'JobPosting', where: [{ attr: 'hiringOrganization.name', op: 'eq', value: 'Lumen Analytics' }, { attr: 'location', op: 'contains', value: 'remote' }] };
	assert.deepEqual(names(evaluateEntityCondition(byEmployer, page(fixture('job')), undefined)), ['Senior AI Product Manager']);
});

test('a page adds a new organization (entity added between observations)', () => {
	const before = page(fixture('products'), 'obs_1');
	const after = page(fixture('products').replace('Sold by: Valley Gear', 'Sold by: Granite Outfitters'), 'obs_2');
	const r = evaluateEntityCondition({ type: 'Organization', state: 'added' }, after, before);
	assert.deepEqual(r.matches.map((m) => m.name), ['Granite Outfitters']);
	assert.deepEqual(evaluateEntityCondition({ type: 'Organization', state: 'removed' }, after, before).matches.map((m) => m.name), ['Valley Gear']);
	assert.equal(evaluateEntityCondition({ type: 'Organization', state: 'added' }, after, undefined).note, 'no previous observation (baseline)');
});

test("a document's publication date changes", () => {
	const before = page(fixture('article'));
	const after = page(fixture('article').replace(/2026-11-10T08:00:00Z/g, '2026-11-12T08:00:00Z'));
	const r = evaluateEntityCondition({ type: 'Article', where: [{ attr: 'datePublished', op: 'changed' }] }, after, before);
	assert.equal(r.matched, true);
	assert.deepEqual(r.matches[0].previous!.datePublished, ['2026-11-10T08:00:00.000Z']);
	assert.equal(evaluateEntityCondition({ type: 'Article', where: [{ attr: 'datePublished', op: 'changed' }] }, before, page(fixture('article'))).matched, false, 'unchanged');
});

test('a discussion contains a post matching criteria (and replies are distinguishable)', () => {
	const p = page(fixture('discussion'));
	const r = evaluateEntityCondition({ type: ['SocialMediaPosting', 'Comment'], where: [{ attr: 'description', op: 'contains', value: 'sells out' }] }, p, undefined);
	assert.equal(r.matches.length, 1);
	assert.equal(r.matches[0].type, 'Comment');
	const reply = evaluateEntityCondition({ type: 'Comment', related: [{ rel: 'inReplyTo', entity: { where: [{ attr: 'author', op: 'eq', value: 'trailnewbie' }] } }] }, p, undefined);
	assert.equal(reply.matches.length, 2, 'both replies answer trailnewbie');
});

test('an existing product changes availability (same entity across observations)', () => {
	const before = page(fixture('products'));
	const after = page(fixture('products').replace('Out of stock', 'In stock'));
	const r = evaluateEntityCondition({ type: 'Product', where: [{ attr: 'availability', op: 'changed' }] }, after, before);
	assert.deepEqual(names(r), ['Canyon 1']);
	assert.deepEqual([r.matches[0].previous!.availability, r.matches[0].values.availability], [['OutOfStock'], ['InStock']]);
});

test('structured-data aliases: price lives on the Offer, criteria still say `price`', () => {
	const p = page(fixture('jsonld-conflict'));
	const declared = evaluateEntityCondition({ type: 'Product', where: [{ attr: 'price', op: 'lt', value: 40 }] }, p, undefined);
	assert.equal(declared.matches.length, 1, 'declared $39.95 (via offers.price)');
	assert.deepEqual(declared.matches[0].values.price, [{ amount: 39.95, currency: 'USD' }]);
	const visible = evaluateEntityCondition({ type: 'Product', where: [{ attr: 'price', op: 'gt', value: 40 }] }, p, undefined);
	assert.equal(visible.matches.length, 1, 'visible $44.95 is evaluated separately; the conflict is not hidden');
});

test('ambiguous values never satisfy comparisons; unknown structures are still queryable', () => {
	const t = page(fixture('table'));
	assert.deepEqual(names(evaluateEntityCondition({ type: 'TableRow', where: [{ attr: 'date', op: 'lt', value: '2026-12-31' }] }, t, undefined)), ['North Hill', 'Riverside']);
	assert.deepEqual(names(evaluateEntityCondition({ type: 'TableRow', where: [{ attr: 'date', op: 'absent' }] }, t, undefined)), ['Airport Rd']);
	const u = page(fixture('unknown'));
	assert.equal(evaluateEntityCondition({ type: 'Unknown', where: [{ attr: 'v', op: 'eq', value: 'M42' }] }, u, undefined).matches.length, 1);
});

test('the existing evaluator runs entity conditions with a complete, deterministic trace', () => {
	const crit: CriteriaDefinition = { schema: 'signal.criteria/v1', id: 'c', version: 1, name: 'cheap tents', severity: 'info', condition: { all: [{ entity: { type: 'Product', where: [{ attr: 'price', op: 'lt', value: 200 }] } }, { text: { contains: 'tents' } }] } };
	validateCondition(crit.condition);
	const interp = { schema: 'signal.interpretation/v1', fields: [], signals: [] } as unknown as Interpretation;
	const p = page(fixture('products'));
	const ev = new DeterministicEvaluator();
	const a = ev.evaluate(interp, undefined, crit, { now: '', normalizedText: 'tents', contentChanged: undefined, page: p });
	const b = ev.evaluate(interp, undefined, crit, { now: '', normalizedText: 'tents', contentChanged: undefined, page: p });
	assert.equal(a.matched, true);
	assert.deepEqual(a, b);
	assert.match(a.trace.find((x) => x.op === 'entity')!.note!, /1 of 3 candidate entities matched/);
	assert.throws(() => validateCondition({ entity: { type: 'Product', where: [{ attr: 'price;drop', op: 'lt', value: 1 }] } }), /invalid attribute path/);
	assert.throws(() => validateCondition({ entity: { where: [{ attr: 'price', op: 'between', value: 5 }] } }), /needs \[low, high\]/);
});
