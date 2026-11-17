import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Condition, CriteriaDefinition, Interpretation } from '../../lib/contracts/types.ts';
import { DeterministicEvaluator, fuzzyContains, validateCondition } from '../../lib/core/evaluate.ts';
import { extractFields, parseNumber, jsonPointer } from '../../lib/interpret/extract.ts';
import { htmlToText } from '../../lib/interpret/normalize.ts';

const ev = new DeterministicEvaluator();
function interp(fields: Record<string, unknown>, signals: Interpretation['signals'] = []): Interpretation {
	return {
		schema: 'signal.interpretation/v1', interpretationId: 'i', tenantId: 't', observationId: 'o', sourceId: 's', interpretedAt: '',
		normalizedTextHash: 'h', normalizedTextRef: 'r', extractionVersion: 'x',
		fields: Object.entries(fields).map(([field, value]) => ({ field, value: value as never })), signals
	};
}
function crit(condition: Condition): CriteriaDefinition {
	return { schema: 'signal.criteria/v1', id: 'c', version: 1, name: 'n', severity: 'info', condition };
}
const run = (cur: Interpretation, c: Condition, opts: { prev?: Interpretation; text?: string; changed?: boolean } = {}) =>
	ev.evaluate(cur, opts.prev, crit(c), { now: '2026-01-01T00:00:00Z', normalizedText: opts.text ?? '', contentChanged: opts.changed });

test('exact, numeric, and set comparisons', () => {
	const i = interp({ price: 95, title: 'Senior AI Product Manager', remote: true });
	assert.equal(run(i, { field: 'price', op: 'lt', value: 100 }).matched, true);
	assert.equal(run(i, { field: 'price', op: 'gte', value: 100 }).matched, false);
	assert.equal(run(i, { field: 'title', op: 'contains', value: 'ai product' }).matched, true);
	assert.equal(run(i, { field: 'title', op: 'contains', value: 'ai product', caseSensitive: true }).matched, false);
	assert.equal(run(i, { field: 'remote', op: 'eq', value: true }).matched, true);
	assert.equal(run(i, { field: 'title', op: 'in', value: ['x', 'senior ai product manager'] }).matched, true);
	assert.equal(run(i, { field: 'title', op: 'matches', value: '^senior' }).matched, true);
});

test('AND / OR / NOT composition and exclusions, with complete trace', () => {
	const i = interp({ price: 95, stock: 'out of stock' });
	const c: Condition = { all: [{ field: 'price', op: 'lt', value: 100 }, { not: { field: 'stock', op: 'contains', value: 'out of stock' } }] };
	const r = run(i, c);
	assert.equal(r.matched, false);
	assert.ok(r.trace.find((t) => t.path === '$.all[0].field(price)')!.result, 'first branch evaluated and traced');
	assert.equal(run(i, { any: [{ field: 'price', op: 'gt', value: 200 }, { field: 'price', op: 'lt', value: 100 }] }).matched, true);
});

test('missing fields: comparisons are false, absent is explicit', () => {
	const i = interp({ price: null });
	const r = run(i, { field: 'price', op: 'lt', value: 100 });
	assert.equal(r.matched, false);
	assert.equal(r.trace[0].note, 'non-numeric or missing value');
	assert.equal(run(i, { field: 'price', op: 'absent' }).matched, true);
	assert.equal(run(i, { field: 'nope', op: 'exists' }).matched, false);
});

test('change detection: baseline, changed, unchanged, increased, decreased', () => {
	const prev = interp({ price: 120 });
	const cur = interp({ price: 95 });
	assert.equal(run(cur, { field: 'price', op: 'changed' }).matched, false, 'no previous ⇒ baseline, not a change');
	assert.equal(run(cur, { field: 'price', op: 'changed' }, { prev }).matched, true);
	assert.equal(run(cur, { field: 'price', op: 'decreased' }, { prev }).matched, true);
	assert.equal(run(cur, { field: 'price', op: 'increased' }, { prev }).matched, false);
	assert.equal(run(prev, { field: 'price', op: 'unchanged' }, { prev }).matched, true);
	assert.equal(run(cur, { content: 'changed' }, { changed: true }).matched, true);
	assert.equal(run(cur, { content: 'changed' }).matched, false);
	const r = run(cur, { field: 'price', op: 'decreased' }, { prev });
	assert.equal(r.trace[0].previous, 120);
});

test('text matching: contains, regex, fuzzy (typo tolerant)', () => {
	const text = 'The agency issued a new regulation on autonomous vehicles.';
	assert.equal(run(interp({}), { text: { contains: 'REGULATION' } }, { text }).matched, true);
	assert.equal(run(interp({}), { text: { matches: 'autonom\\w+ veh' } }, { text }).matched, true);
	assert.equal(run(interp({}), { text: { fuzzy: { term: 'regulaton', maxDistance: 1 } } }, { text }).matched, true);
	assert.equal(run(interp({}), { text: { fuzzy: { term: 'deregulated', maxDistance: 1 } } }, { text }).matched, false);
	assert.equal(fuzzyContains('kitten', 'sitting', 3).found, true);
});

test('signal conditions match decoded payloads', () => {
	const i = interp({}, [{ codec: 'ghostpost-unicode/v1', kind: 'reference', ok: true, confidence: 1, payload: { refId: 'promo-2026' } }]);
	assert.equal(run(i, { signal: { codec: 'ghostpost-unicode/v1', payloadContains: 'promo' } }).matched, true);
	assert.equal(run(i, { signal: { kind: 'text' } }).matched, false);
});

test('determinism: same inputs ⇒ identical result and matchedValues', () => {
	const i = interp({ price: 95 });
	const c: Condition = { all: [{ field: 'price', op: 'lt', value: 100 }, { text: { contains: 'widget' } }] };
	assert.deepEqual(run(i, c, { text: 'a widget' }), run(i, c, { text: 'a widget' }));
});

test('validation rejects unsafe or malformed criteria', () => {
	assert.throws(() => validateCondition({ all: [] }), /non-empty/);
	assert.throws(() => validateCondition({ field: 'x', op: 'lt' }), /requires value/);
	assert.throws(() => validateCondition({ field: 'x', op: 'matches', value: '(' }));
	let deep: Condition = { field: 'x', op: 'exists' };
	for (let i = 0; i < 20; i++) deep = { not: deep };
	assert.throws(() => validateCondition(deep), /nesting/);
	assert.throws(() => validateCondition({ bogus: 1 } as never), /Unknown condition/);
});

test('extraction: numbers, JSON pointers, absence', () => {
	assert.equal(parseNumber('$1,299.99'), 1299.99);
	assert.equal(parseNumber('95,00 €'), 95);
	assert.equal(parseNumber('1.234,50'), 1234.5);
	assert.equal(jsonPointer({ a: { 'b/c': [1, 2] } }, '/a/b~1c/1'), 2);
	const f = extractFields(
		[{ field: 'price', from: 'text', pattern: 'Price: \\$([\\d.,]+)', type: 'number' }, { field: 'v', from: 'json', pointer: '/info/version', type: 'string' }, { field: 'missing', from: 'text', pattern: 'nope(\\d)', type: 'number' }],
		'Price: $42.50 today', '{"info":{"version":"2.1.0"}}'
	);
	assert.deepEqual(f.map((x) => x.value), [42.5, '2.1.0', null]);
	assert.deepEqual(f[0].span, [8, 13]);
	assert.throws(() => extractFields([{ field: 'bad name!', from: 'text', pattern: 'x', type: 'string' }], '', ''), /Invalid field/);
});

test('normalization strips markup/scripts but preserves invisible signal characters', () => {
	const t = htmlToText('<p>Hi&nbsp;<b>there</b>&#33;</p><script>evil()</script><div>a​‌﻿b</div>');
	assert.equal(t, 'Hi there !\na​‌﻿b');
});
