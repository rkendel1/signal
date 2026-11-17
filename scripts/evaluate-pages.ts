/**
 * Real-world page quality evaluation: `node scripts/evaluate-pages.ts [out.json]`
 * Runs the extractor on every retained real page and scores it against the independent labels.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { extractPage } from '../lib/page/extract.ts';
import { scorePage, summarize, type Label } from '../tests/eval/score.ts';
import { GhostpostUnicodeDecoder } from '../lib/codecs/ghostpost-unicode.ts';

const dir = new URL('../tests/fixtures/real/', import.meta.url);
const out: Record<string, unknown>[] = [];
for (const f of readdirSync(new URL('labels/', dir)).filter((x) => x.endsWith('.json')).sort()) {
	const label = JSON.parse(readFileSync(new URL(`labels/${f}`, dir), 'utf8')) as Label;
	const prov = JSON.parse(readFileSync(new URL(`${label.id}.provenance.json`, dir), 'utf8'));
	const html = readFileSync(new URL(`${label.id}.html`, dir), 'utf8');
	const t = performance.now();
	const rep = extractPage({ html, locator: prov.url, baseUrl: prov.finalUrl ?? prov.url, observationId: `eval_${label.id}`, contentHash: prov.sha256, contentType: prov.contentType, observedAt: prov.fetchedAt, decoders: [new GhostpostUnicodeDecoder()] });
	const ms = performance.now() - t;
	const s = summarize(scorePage(label, rep, html));
	out.push({ ...s, split: prov.split ?? 'tuning', extractMs: +ms.toFixed(1), htmlBytes: Buffer.byteLength(html), representationBytes: Buffer.byteLength(JSON.stringify(rep)), truncated: rep.stats.truncated, entitiesExtracted: rep.entities.length });
}
const file = process.argv[2] ?? 'docs/page-quality.json';
writeFileSync(file, JSON.stringify({ evaluatedAt: new Date().toISOString(), pages: out }, null, 1) + '\n');
for (const p of out as Array<Record<string, any>>) {
	console.log(`${String(p.split).padEnd(8)} ${p.id.padEnd(20)} ent R ${p.entityRecall} det ${p.entityDetection} P ${p.entityPrecision} dup ${p.duplicateRate} | attr R ${p.attributeRecall} P ${p.attributePrecision} | rel R ${p.relationshipRecall} P ${p.relationshipPrecision} | trace ${p.traceability} cov ${p.textCoverage} | ${p.extractMs}ms ${p.representationBytes}B`);
}
