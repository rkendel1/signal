/**
 * Measurements for ACCEPTANCE_REPORT.md: `npm run bench`.
 * Library hot paths in-process; full cycles through the real FeltKit app (FeltDB + AppPort
 * Services, in-process test runtime) against a loopback HTTP page. Prints JSON.
 */
process.env.SIGNAL_ALLOW_PRIVATE_HOSTS = '127.0.0.1';
import { readFileSync } from 'node:fs';
import * as wasm from '../codecs/ghostpost-unicode/pkg/ghostpost_unicode_codec.js';
import { GhostpostUnicodeDecoder, ghostpostEncoder } from '../lib/codecs/ghostpost-unicode.ts';
import { InvisibleUnicodeDetector } from '../lib/codecs/invisible-unicode.ts';
import { DeterministicEvaluator } from '../lib/core/evaluate.ts';
import { createTestApp } from '@feltdb/feltkit/testing';
import { api } from '../feltkit/_generated/api.ts';
import { fixture, priceCriteria, productPage } from '../tests/helpers.ts';

const stats = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	const q = (p: number) => +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(3);
	return { n: s.length, p50: q(0.5), p95: q(0.95), max: +s.at(-1)!.toFixed(3) };
};
const time = (f: () => unknown, n: number) => { const o: number[] = []; for (let i = 0; i < n; i++) { const t = performance.now(); f(); o.push(performance.now() - t); } return stats(o); };
const out: Record<string, unknown> = { node: process.version, platform: `${process.platform}/${process.arch}` };

// codec
const bytes = readFileSync(new URL('../codecs/ghostpost-unicode/pkg/ghostpost_unicode_codec_bg.wasm', import.meta.url));
let t = performance.now();
wasm.initSync({ module: new WebAssembly.Module(bytes) });
out.wasmInitMs = +(performance.now() - t).toFixed(3);
out.wasmBytes = bytes.byteLength;
const dec = new GhostpostUnicodeDecoder();
out.decodeSmallMs = time(() => dec.detect({ text: ghostpostEncoder.encodeText('carrier text', 'a short secret message') }), 2000);
const tenKb = ghostpostEncoder.encodeText('carrier', 'lorem ipsum '.repeat(850));
out.decode10KbCompressedMs = time(() => dec.detect({ text: tenKb }), 500);
const page = Array.from({ length: 2000 }, (_, i) => (i % 40 === 0 ? ghostpostEncoder.encodeText(`post ${i}`, `secret ${i}`) : `ordinary paragraph ${i} with some text 👋`)).join('\n');
out.pageChars = page.length;
out.scanPage_ghostpostMs = time(() => dec.detect({ text: page }), 50);
out.scanPage_invisibleMs = time(() => new InvisibleUnicodeDetector().detect({ text: page }), 50);
out.payloadsFoundOnPage = dec.detect({ text: page }).length;

// criteria
const ev = new DeterministicEvaluator();
const interp = { schema: 'signal.interpretation/v1', interpretationId: 'i', tenantId: 't', observationId: 'o', sourceId: 's', interpretedAt: '', normalizedTextHash: 'h', normalizedTextRef: 'r', extractionVersion: 'x', fields: [{ field: 'price', value: 95 }, { field: 'title', value: 'Acme widget' }], signals: [] } as never;
const crit = { schema: 'signal.criteria/v1', id: 'c', version: 1, name: 'n', severity: 'info', condition: { all: [{ field: 'price', op: 'lt', value: 100 }, { any: [{ field: 'title', op: 'contains', value: 'acme' }, { text: { fuzzy: { term: 'widgte', maxDistance: 1 } } }] }, { not: { text: { contains: 'out of stock' } } }] } } as never;
const text = productPage('95.00').repeat(20);
out.evaluateMs = time(() => ev.evaluate(interp, interp, crit, { now: '', normalizedText: text, contentChanged: true }), 2000);

// full cycles on FeltKit
const site = await fixture();
site.set('/robots.txt', { body: '', type: 'text/plain' });
const app = await createTestApp();
const ada = app.as('ada');
const sourceId = await ada.mutation(api.sources.register, { type: 'http_page', locator: `${site.url}/p`, strategy: 'manual' });
await ada.mutation(api.criteria.define, { definition: priceCriteria() });
const monitorId = await ada.mutation(api.monitors.create, { sourceId, criteriaId: 'price-drop', criteriaVersion: 1 });
const cycle: number[] = [];
const outcomes: Record<string, number> = {};
const N = 60;
const heap0 = process.memoryUsage().heapUsed;
for (let i = 0; i < N; i++) {
	// Every cycle matches. Per 6 cycles: one value repeated 3× (2 duplicates), then 3 distinct values.
	const price = i % 6 < 3 ? '95.00' : (90 - (i % 10)).toFixed(2);
	site.set('/p', { body: productPage(price, `<!-- render ${i} -->`) });
	t = performance.now();
	const r = await ada.action(api.monitors.observe, { monitorId });
	cycle.push(performance.now() - t);
	outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
}
out.observeCycleMs = stats(cycle);
out.outcomes = outcomes;
out.expected = { event_recorded: 40, suppressed_duplicate: 20 };
out.notifications = (await ada.query(api.events.inbox, {})).length;
out.heapDeltaMb = +((process.memoryUsage().heapUsed - heap0) / 1e6).toFixed(1);
out.rssMb = +(process.memoryUsage().rss / 1e6).toFixed(1);
const pushes: number[] = [];
const src2 = await ada.mutation(api.sources.register, { type: 'text', locator: 'bench:push', strategy: 'event' });
const m2 = await ada.mutation(api.monitors.create, { sourceId: src2, criteriaId: 'price-drop', criteriaVersion: 1 });
for (let i = 0; i < 60; i++) { t = performance.now(); await ada.mutation(api.monitors.push, { monitorId: m2, content: `Price: $${100 + i}` }); pushes.push(performance.now() - t); }
out.pushCycleMs = stats(pushes);
await app.close();
await site.close();
console.log(JSON.stringify(out, null, 2));
