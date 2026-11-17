/**
 * Measurements for ACCEPTANCE_REPORT.md. Local loopback HTTP + FeltDB file store.
 * Prints JSON. Numbers are from this machine, not estimates.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import * as wasm from '../codecs/ghostpost-unicode/pkg/ghostpost_unicode_codec.js';
import { GhostpostUnicodeDecoder, ghostpostEncoder } from '../src/codecs/ghostpost-unicode.ts';
import { InvisibleUnicodeDetector } from '../src/codecs/invisible-unicode.ts';
import { DeterministicEvaluator } from '../src/core/evaluate.ts';
import { SignalEngine } from '../src/runtime/engine.ts';
import { LocalPolicyAuthorizer, SignalService } from '../src/runtime/service.ts';
import { HttpSource } from '../src/sources/sources.ts';
import { InboxDispatcher, WebhookDispatcher } from '../src/delivery/dispatch.ts';
import { createApi } from '../src/api/server.ts';
import { alice, fixture, productPage, tempStore, testNet } from '../test/helpers.ts';

const stats = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	const q = (p: number) => +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(3);
	return { n: s.length, p50: q(0.5), p95: q(0.95), max: +s.at(-1)!.toFixed(3) };
};
const time = (f: () => unknown, n: number) => { const out: number[] = []; for (let i = 0; i < n; i++) { const t = performance.now(); f(); out.push(performance.now() - t); } return stats(out); };
const out: Record<string, unknown> = { node: process.version, platform: `${process.platform}/${process.arch}` };

// --- codec ------------------------------------------------------------------
const bytes = readFileSync(new URL('../codecs/ghostpost-unicode/pkg/ghostpost_unicode_codec_bg.wasm', import.meta.url));
let t = performance.now();
wasm.initSync({ module: new WebAssembly.Module(bytes) });
out.wasmInitMs = +(performance.now() - t).toFixed(3);
out.wasmBytes = bytes.byteLength;
const dec = new GhostpostUnicodeDecoder();
const small = ghostpostEncoder.encodeText('carrier text', 'a short secret message');
const tenKb = ghostpostEncoder.encodeText('carrier', 'lorem ipsum '.repeat(850));
out.decodeSmallMs = time(() => dec.detect({ text: small }), 2000);
out.decode10KbCompressedMs = time(() => dec.detect({ text: tenKb }), 500);
const page = Array.from({ length: 2000 }, (_, i) => (i % 40 === 0 ? ghostpostEncoder.encodeText(`post ${i}`, `secret ${i}`) : `ordinary paragraph ${i} with some text 👋`)).join('\n');
out.pageChars = page.length;
out.scanPage83kChars_ghostpostMs = time(() => dec.detect({ text: page }), 50);
out.scanPage83kChars_invisibleMs = time(() => new InvisibleUnicodeDetector().detect({ text: page }), 50);
out.payloadsFound = dec.detect({ text: page }).length;

// --- criteria ---------------------------------------------------------------
const ev = new DeterministicEvaluator();
const interp = { schema: 'signal.interpretation/v1', interpretationId: 'i', tenantId: 't', observationId: 'o', sourceId: 's', interpretedAt: '', normalizedTextHash: 'h', normalizedTextRef: 'r', extractionVersion: 'x', fields: [{ field: 'price', value: 95 }, { field: 'title', value: 'Acme widget' }], signals: [] } as never;
const crit = { schema: 'signal.criteria/v1', id: 'c', version: 1, name: 'n', severity: 'info', condition: { all: [{ field: 'price', op: 'lt', value: 100 }, { any: [{ field: 'title', op: 'contains', value: 'acme' }, { text: { fuzzy: { term: 'widgte', maxDistance: 1 } } }] }, { not: { text: { contains: 'out of stock' } } }] } } as never;
const text = productPage('95.00').repeat(20);
out.evaluateMs = time(() => ev.evaluate(interp, interp, crit, { now: '', normalizedText: text, contentChanged: true }), 2000);

// --- full cycle ---------------------------------------------------------------
const site = await fixture();
site.set('/robots.txt', { body: '', type: 'text/plain' });
site.set('/hook', { body: 'ok' });
const store = await tempStore();
const svc = new SignalService(store, new LocalPolicyAuthorizer(), testNet);
const engine = new SignalEngine({
	store, sources: { http_page: new HttpSource('http_page', testNet) }, decoders: [dec, new InvisibleUnicodeDetector()],
	dispatchers: { webhook: new WebhookDispatcher(async () => 'k', testNet), inbox: new InboxDispatcher() }
});
const src = await svc.registerSource(alice, { type: 'http_page', locator: `${site.url}/p`, access: { authorization: 'public' }, observation: { strategy: 'poll', intervalSeconds: 300 } });
await svc.defineCriteria(alice, { id: 'c', name: 'drop', severity: 'warning', extract: [{ field: 'price', from: 'text', pattern: 'Price:\\s*\\$([\\d.,]+)', type: 'number' }], condition: { field: 'price', op: 'lt', value: 100 } });
const mon = await svc.createMonitor(alice, { sourceId: src.id, criteriaId: 'c', criteriaVersion: 1, destinations: [{ id: 'h', type: 'webhook', target: `${site.url}/hook` }, { id: 'i', type: 'inbox', target: 'u_alice' }] });
const stages: Record<string, number[]> = {};
const cycle: number[] = [];
let events = 0, suppressed = 0;
const N = 60;
const heap0 = process.memoryUsage().heapUsed;
for (let i = 0; i < N; i++) {
	// Price oscillates: 10 distinct "matched" states, re-rendered pages in between (new bytes, same condition).
	const price = i % 6 < 3 ? '95.00' : (90 - (i % 10)).toFixed(2);
	site.set('/p', { body: productPage(price, `<!-- render ${i} -->`) });
	t = performance.now();
	const r = await engine.runOnce(mon.id);
	cycle.push(performance.now() - t);
	for (const [k, v] of Object.entries(r.timings)) (stages[k] ??= []).push(v);
	if (r.evaluation?.outcome === 'event_recorded') events++;
	if (r.evaluation?.outcome === 'suppressed_duplicate') suppressed++;
}
out.cycleMs = stats(cycle);
out.stageMs = Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, stats(v)]));
out.duplicateSuppression = { cycles: N, matchedCycles: N, eventsRecorded: events, suppressedDuplicates: suppressed, webhooksSent: site.requests.filter((q) => q.path === '/hook').length };
out.heapDeltaMb = +((process.memoryUsage().heapUsed - heap0) / 1e6).toFixed(1);
out.rssMb = +(process.memoryUsage().rss / 1e6).toFixed(1);

// --- browser overlay: scan + mutation cost ----------------------------------------
try {
	const { chromium } = createRequire(import.meta.url)('playwright');
	const api = createApi({ service: svc, engine, corsOrigins: '*', authenticate: () => alice });
	await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
	const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
	const html = `<!doctype html><body>${page.split('\n').map((l) => `<p><span>${l.slice(0, 3)}</span>${l.slice(3)}</p>`).join('')}
		<script>window.SignalOverlayConfig={api:${JSON.stringify(apiUrl)},token:'x'}</script><script src="${apiUrl}/overlay.js"></script></body>`;
	site.set('/feed', { body: html });
	const browser = await chromium.launch();
	const p = await (await browser.newContext()).newPage();
	await p.goto(`${site.url}/feed`);
	await p.waitForFunction(() => (window as any).__signalOverlay);
	await p.waitForTimeout(800);
	out.overlayFullScanMs = await p.evaluate(async () => { const r: number[] = []; for (let i = 0; i < 10; i++) { const t = performance.now(); await (window as any).__signalOverlay.refresh(); r.push(performance.now() - t); } r.sort((a, b) => a - b); return +r[5].toFixed(1); });
	out.overlayPage = { paragraphs: 2000, payloads: 50, note: 'refresh() = events fetch + full DOM scan + WASM inspect of every FEFF block' };
	out.overlay500InsertsWhileObservedMs = await p.evaluate(async () => {
		// Cost of observing: time to append 500 nodes with and without the overlay's observer active is not separable
		// from inside the page, so report the time for the page itself to absorb 500 inserts while observed.
		const t = performance.now();
		for (let i = 0; i < 500; i++) { const e = document.createElement('p'); e.textContent = 'new item ' + i; document.body.appendChild(e); }
		await new Promise((r) => setTimeout(r, 0));
		return +(performance.now() - t).toFixed(1);
	});
	out.overlayJsHeapMb = await p.evaluate(() => +(((performance as any).memory?.usedJSHeapSize ?? 0) / 1e6).toFixed(1));
	await browser.close();
	api.closeAllConnections(); api.close();
} catch (e) {
	out.overlay = `not measured: ${(e as Error).message}`;
}
await store.close();
await site.close();
console.log(JSON.stringify(out, null, 2));
