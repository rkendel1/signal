/**
 * Page intelligence measurements: `node scripts/bench-pages.ts` → docs/bench-pages.json.
 * Extraction latency and representation size per fixture, plus synthetic scale pages.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { extractPage } from '../lib/page/extract.ts';

const dir = new URL('../tests/fixtures/pages/', import.meta.url);
const stats = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const q = (p: number) => +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2); return { p50: q(0.5), p95: q(0.95) }; };
const measure = (html: string, n: number) => {
	const times: number[] = [];
	let rep;
	for (let i = 0; i < n; i++) {
		const t = performance.now();
		rep = extractPage({ html, locator: 'https://bench.example/p', baseUrl: 'https://bench.example/p', observationId: 'o', contentHash: 'h', contentType: 'text/html', observedAt: '2026-11-17T12:00:00Z' });
		times.push(performance.now() - t);
	}
	const json = JSON.stringify(rep!);
	return { htmlBytes: Buffer.byteLength(html), ms: stats(times), representationBytes: Buffer.byteLength(json), entities: rep!.entities.length, relationships: rep!.relationships.length, collections: rep!.collections.length, evidence: rep!.evidence.length, truncated: rep!.stats.truncated, byClassification: rep!.stats.byClassification, rep: rep! };
};

const out: Record<string, unknown> = { node: process.version };
const fixtures: Record<string, unknown> = {};
for (const f of readdirSync(dir).filter((x) => x.endsWith('.html')).sort()) {
	const { rep: _r, ...m } = measure(readFileSync(new URL(f, dir), 'utf8'), 30);
	fixtures[f.replace('.html', '')] = m;
}
out.fixtures = fixtures;

const card = (i: number) => `<div class="card"><img src="/i/${i}.jpg" alt="item ${i}"><h3><a href="/p/${i}">Item ${i}</a></h3><span class="price">$${(10 + (i % 300)).toFixed(2)}</span><p class="stock">${i % 5 ? 'In stock' : 'Out of stock'}</p><p>Sold by: Seller ${i % 20}</p></div>`;
for (const n of [100, 500, 1000]) {
	const html = `<!doctype html><html lang="en"><head><title>Catalog</title></head><body><h1>Catalog</h1><div class="grid">${Array.from({ length: n }, (_, i) => card(i)).join('')}</div></body></html>`;
	const m = measure(html, 5);
	const { rep: _r, ...rest } = m;
	out[`synthetic_${n}_products`] = rest;
}
console.log(JSON.stringify(out, null, 2));
