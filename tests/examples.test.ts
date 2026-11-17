/** Every documented use case (examples/use-cases.json) runs through the real FeltKit app with pushed content. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestApp } from '@feltdb/feltkit/testing';
import { api } from '../feltkit/_generated/api.js';
import { ghostpostEncoder } from '../lib/codecs/ghostpost-unicode.ts';

const { cases } = JSON.parse(readFileSync(new URL('../examples/use-cases.json', import.meta.url), 'utf8'));
const content = (c: unknown) => (typeof c === 'string' ? c : ghostpostEncoder.encodeReference(...((c as { encodeReference: [string, 'ghostpost', string] }).encodeReference)));

test('documented use cases', async (t) => {
	const app = await createTestApp();
	t.after(() => app.close());
	const ada = app.as('ada');
	for (const [i, uc] of cases.entries()) {
		const type = uc.contentType === 'application/json' ? 'json' : uc.contentType === 'text/html' ? 'dom' : 'text';
		const run = async (sequence: unknown[], suffix: string) => {
			const sourceId = await ada.mutation(api.sources.register, { type, locator: `example:${i}:${suffix}`, strategy: 'event' });
			const monitorId = await ada.mutation(api.monitors.create, { sourceId, criteriaId: uc.criteria.id, criteriaVersion: 1 });
			let last;
			for (const c of sequence) last = await ada.mutation(api.monitors.push, { monitorId, content: content(c) });
			return last!.outcome;
		};
		await ada.mutation(api.criteria.define, { definition: JSON.stringify(uc.criteria) });
		const pre = uc.previous ? [uc.previous] : [];
		assert.equal(await run([...pre, uc.matches], 'yes'), 'event_recorded', `${uc.name}: should match`);
		assert.equal(await run([...pre, uc.doesNotMatch], 'no'), 'no_match', `${uc.name}: should not match`);
	}
});
