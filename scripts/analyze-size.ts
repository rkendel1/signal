/**
 * Where do signal.page/v1 bytes go? `node scripts/analyze-size.ts` → docs/size-analysis.json
 * Measures component shares on real pages and the synthetic 1,000-product catalog.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { extractPage } from '../lib/page/extract.ts';
import type { PageRepresentation } from '../lib/page/types.ts';

const dir = new URL('../tests/fixtures/real/', import.meta.url);
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
const card = (i: number) => `<div class="card"><img src="/i/${i}.jpg" alt="item ${i}"><h3><a href="/p/${i}">Item ${i}</a></h3><span class="price">$${(10 + (i % 300)).toFixed(2)}</span><p class="stock">${i % 5 ? 'In stock' : 'Out of stock'}</p><p>Sold by: Seller ${i % 20}</p></div>`;
const pages: Array<[string, string, string]> = [
	['synthetic-1000-products', `<!doctype html><html lang="en"><head><title>Catalog</title></head><body><h1>Catalog</h1><div class="grid">${Array.from({ length: 1000 }, (_, i) => card(i)).join('')}</div></body></html>`, 'https://bench.example/catalog'],
	...['webscraper-laptops', 'wiki-population', 'fake-jobs', 'heldout-countries'].map((id) => {
		const prov = JSON.parse(readFileSync(new URL(`${id}.provenance.json`, dir), 'utf8'));
		return [id, readFileSync(new URL(`${id}.html`, dir), 'utf8'), prov.url] as [string, string, string];
	})
];

function analyze(rep: PageRepresentation, html: string) {
	const total = bytes(rep);
	const attrs = rep.entities.flatMap((e) => e.attributes);
	const evid = rep.evidence;
	const sum = (xs: unknown[]) => xs.reduce((n: number, x) => n + bytes(x), 0);
	const locators = evid.map((e) => e.locator);
	const uniqueStepBytes = new Set(locators.flatMap((l) => l.split('>'))).size;
	const part = {
		evidenceTotal: sum(evid),
		evidenceText: sum(evid.map((e) => e.text)),
		evidenceLocator: sum(locators),
		evidenceAttributes: sum(evid.map((e) => e.attributes)),
		attributesTotal: sum(attrs),
		attributeRaw: sum(attrs.map((a) => a.raw)),
		attributeRawEqualToValue: sum(attrs.filter((a) => typeof a.value === 'string' && a.value === a.raw).map((a) => a.raw)),
		attributeValue: sum(attrs.map((a) => a.value)),
		attributeEvidenceRefs: sum(attrs.map((a) => a.evidenceRefs)),
		attributeMetadata: sum(attrs.map((a) => ({ n: a.name, d: a.dataType, p: a.provenance, m: a.method, c: a.confidence }))),
		entityMetadata: sum(rep.entities.map((e) => ({ id: e.id, type: e.type, classification: e.classification, typeBasis: e.typeBasis, identity: e.identity, evidenceRefs: e.evidenceRefs }))),
		relationships: sum(rep.relationships),
		collections: sum(rep.collections),
		signals: sum(rep.signals)
	};
	const keyBytes = (JSON.stringify(rep).match(/"[A-Za-z]+":/g) ?? []).reduce((n, k) => n + k.length, 0);
	return {
		htmlBytes: Buffer.byteLength(html), representationBytes: total, ratio: +(total / Buffer.byteLength(html)).toFixed(2),
		entities: rep.entities.length, attributes: attrs.length, evidence: evid.length,
		shares: Object.fromEntries(Object.entries(part).map(([k, v]) => [k, { bytes: v, share: +(v / total).toFixed(3) }])),
		jsonKeyBytes: { bytes: keyBytes, share: +(keyBytes / total).toFixed(3) },
		locatorRedundancy: { locatorBytes: part.evidenceLocator, distinctSteps: uniqueStepBytes, avgLocatorChars: Math.round(locators.reduce((n, l) => n + l.length, 0) / Math.max(1, locators.length)) }
	};
}

const out: Record<string, unknown> = {};
for (const [id, html, url] of pages) {
	const rep = extractPage({ html, locator: url, baseUrl: url, observationId: 'o', contentHash: 'h', contentType: 'text/html', observedAt: '2026-11-17T00:00:00Z' });
	out[id] = analyze(rep, html);
}
writeFileSync('docs/size-analysis.json', JSON.stringify(out, null, 1) + '\n');
for (const [id, a] of Object.entries(out) as Array<[string, any]>) {
	console.log(`\n${id}: html ${a.htmlBytes} rep ${a.representationBytes} (${a.ratio}x) entities ${a.entities} attrs ${a.attributes} evidence ${a.evidence}`);
	for (const [k, v] of Object.entries(a.shares) as Array<[string, any]>) console.log(`   ${k.padEnd(26)} ${String(v.bytes).padStart(9)}  ${(v.share * 100).toFixed(1)}%`);
	console.log(`   ${'jsonKeys'.padEnd(26)} ${String(a.jsonKeyBytes.bytes).padStart(9)}  ${(a.jsonKeyBytes.share * 100).toFixed(1)}%   avg locator ${a.locatorRedundancy.avgLocatorChars} chars`);
}
