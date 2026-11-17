/** Page representations are stored as gzip of the canonical JSON; pre-M7 uncompressed files still read. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { readPage, storePage } from '../feltkit/_shared.ts';

test('storePage writes gzip; readPage reads gzip and legacy JSON identically', async () => {
	const files = new Map<string, Uint8Array>();
	const ctx = {
		services: { files: {
			upload: async (f: { content: Uint8Array }) => { const id = `f${files.size}`; files.set(id, f.content); return { id }; },
			read: async (id: string) => { const b = files.get(id)!; return { bytes: b, text: () => new TextDecoder().decode(b) }; }
		} },
		db: { insert: async () => 'rec1' }
	};
	const html = readFileSync(new URL('./fixtures/pages/products.html', import.meta.url), 'utf8');
	const obs = { schema: 'signal.observation/v1', observationId: 'obs_1', tenantId: 't', sourceId: 'src', observedAt: '2026-11-17T12:00:00.000Z', status: 'ok', contentHash: 'h', contentType: 'text/html', provenance: { adapter: 'test', method: 'PUSH' } };
	const { representation, ref } = await storePage(ctx as never, obs as never, html, { id: 'src', locator: 'https://shop.example/' }, 'ada');
	const stored = files.get(ref.slice('files:'.length))!;
	assert.deepEqual([stored[0], stored[1]], [0x1f, 0x8b], 'gzip magic');
	const json = gunzipSync(stored).toString('utf8');
	assert.ok(stored.byteLength < json.length / 3, `compressed ${stored.byteLength} vs ${json.length}`);
	assert.deepEqual(await readPage(ctx as never, ref), representation);
	files.set('legacy', new TextEncoder().encode(json));
	assert.deepEqual(await readPage(ctx as never, 'files:legacy'), representation);
});
