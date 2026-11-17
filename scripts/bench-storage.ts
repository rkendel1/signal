/**
 * Storage alternatives for signal.page/v1, measured: `node scripts/bench-storage.ts` → docs/storage-options.json
 *   A   canonical v1 JSON (M5)
 *   A+  gzip(canonical v1 JSON)                      — same document, compressed
 *   D   compact columnar (strings table, locator trie, tuple attributes, evidence text omitted: re-derivable from raw)
 *   D+  gzip(D)
 * For each: stored bytes (and base64 for a text-only store), encode ms, decode-to-v1 ms, entity-criteria ms after decode.
 */
import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { extractPage } from '../lib/page/extract.ts';
import { evaluateEntityCondition } from '../lib/page/query.ts';
import { canonicalJson } from '../lib/core/canonical.ts';
import { compactPage, expandPage } from './compact-page.ts';

const dir = new URL('../tests/fixtures/real/', import.meta.url);
const card = (i: number) => `<div class="card"><img src="/i/${i}.jpg" alt="item ${i}"><h3><a href="/p/${i}">Item ${i}</a></h3><span class="price">$${(10 + (i % 300)).toFixed(2)}</span><p class="stock">${i % 5 ? 'In stock' : 'Out of stock'}</p><p>Sold by: Seller ${i % 20}</p></div>`;
const inputs: Array<[string, string, string]> = [
	['synthetic-1000-products', `<!doctype html><html lang="en"><head><title>Catalog</title></head><body><h1>Catalog</h1><div class="grid">${Array.from({ length: 1000 }, (_, i) => card(i)).join('')}</div></body></html>`, 'https://bench.example/catalog'],
	...['webscraper-laptops', 'wiki-population', 'fake-jobs', 'heldout-countries', 'books-catalog'].map((id) => [id, readFileSync(new URL(`${id}.html`, dir), 'utf8'), JSON.parse(readFileSync(new URL(`${id}.provenance.json`, dir), 'utf8')).url] as [string, string, string])
];
const time = <T>(f: () => T, n = 5): [T, number] => { let r!: T; const ts: number[] = []; for (let i = 0; i < n; i++) { const t = performance.now(); r = f(); ts.push(performance.now() - t); } ts.sort((a, b) => a - b); return [r, +ts[Math.floor(n / 2)].toFixed(2)]; };
const crit = { type: ['Product', 'TableRow', 'JobPosting', 'Unknown'], where: [{ attr: 'name', op: 'contains' as const, value: 'a' }] };

const out: Record<string, unknown> = {};
for (const [id, html, url] of inputs) {
	const rep = extractPage({ html, locator: url, baseUrl: url, observationId: 'o', contentHash: 'h', contentType: 'text/html', observedAt: '2026-11-17T00:00:00Z' });
	const json = canonicalJson(rep);
	const [gz, gzEnc] = time(() => gzipSync(json, { level: 6 }));
	const [, gzDec] = time(() => JSON.parse(gunzipSync(gz).toString('utf8')));
	const [compact, cEnc] = time(() => canonicalJson(compactPage(rep)));
	const [expanded, cDec] = time(() => expandPage(JSON.parse(compact), html));
	const [cgz, cgzEnc] = time(() => gzipSync(compact, { level: 6 }));
	const [, cgzDec] = time(() => expandPage(JSON.parse(gunzipSync(cgz).toString('utf8')), html));
	const [, qMs] = time(() => evaluateEntityCondition(crit, rep, undefined));
	const lossless = canonicalJson(expanded) === json;
	out[id] = {
		htmlBytes: Buffer.byteLength(html), entities: rep.entities.length,
		A_json: { bytes: Buffer.byteLength(json), ratioToHtml: +(Buffer.byteLength(json) / Buffer.byteLength(html)).toFixed(2) },
		Aplus_gzip: { bytes: gz.length, base64Bytes: Math.ceil(gz.length / 3) * 4, ratioToHtml: +(gz.length / Buffer.byteLength(html)).toFixed(3), encodeMs: gzEnc, decodeMs: gzDec },
		D_compact: { bytes: Buffer.byteLength(compact), encodeMs: cEnc, decodeWithEvidenceTextMs: cDec, losslessAfterRederivingEvidenceText: lossless },
		Dplus_compact_gzip: { bytes: cgz.length, base64Bytes: Math.ceil(cgz.length / 3) * 4, ratioToHtml: +(cgz.length / Buffer.byteLength(html)).toFixed(3), encodeMs: cgzEnc, decodeMs: cgzDec },
		queryMsOnDecoded: qMs
	};
	const o = out[id] as Record<string, any>;
	console.log(`${id.padEnd(24)} html ${o.htmlBytes} | A ${o.A_json.bytes} | A+ ${o.Aplus_gzip.bytes} (${o.Aplus_gzip.encodeMs}/${o.Aplus_gzip.decodeMs}ms) | D ${o.D_compact.bytes} lossless=${lossless} (${o.D_compact.decodeWithEvidenceTextMs}ms) | D+ ${o.Dplus_compact_gzip.bytes} (${o.Dplus_compact_gzip.decodeMs}ms) | q ${qMs}ms`);
}
writeFileSync('docs/storage-options.json', JSON.stringify(out, null, 1) + '\n');
