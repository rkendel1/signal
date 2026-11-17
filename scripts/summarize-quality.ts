/**
 * Prints per-category and per-method tables from docs/page-quality.json (no aggregate across categories).
 * `node scripts/summarize-quality.ts [file]` — used to produce the tables in PAGE_QUALITY.md.
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? new URL('../docs/page-quality.json', import.meta.url).pathname;
const { pages } = JSON.parse(readFileSync(file, 'utf8')) as { pages: Array<Record<string, any>> };
type Tally = Record<string, number>;
const add = (a: Tally, b: Tally) => { for (const [k, v] of Object.entries(b ?? {})) a[k] = (a[k] ?? 0) + (v as number); };
const f = (x: number | null) => (x === null || Number.isNaN(x) ? '–' : x.toFixed(3));

const byCat = new Map<string, Array<Record<string, any>>>();
for (const p of pages) (byCat.get(p.category) ?? byCat.set(p.category, []).get(p.category)!).push(p);
console.log('| category | pages | attribute outcomes (correct / not understood / ambiguous / missed / not accessible) | attr recall | attr precision |');
console.log('|---|---|---|---|---|');
for (const [cat, ps] of [...byCat].sort()) {
	const t: Tally = {};
	for (const p of ps) add(t, p.attributes);
	const labelled = (t.correct ?? 0) + (t.not_understood ?? 0) + (t.ambiguous ?? 0) + (t.missed ?? 0);
	const extracted = (t.correct ?? 0) + (t.not_understood ?? 0);
	console.log(`| ${cat} | ${ps.map((p) => p.id).join(', ')} | ${t.correct ?? 0} / ${t.not_understood ?? 0} / ${t.ambiguous ?? 0} / ${t.missed ?? 0} / ${t.not_accessible ?? 0} | ${f(labelled ? (t.correct ?? 0) / labelled : null)} | ${f(extracted ? (t.correct ?? 0) / extracted : null)} |`);
}
console.log('\n| method | correct | not understood | ambiguous | precision |');
console.log('|---|---|---|---|---|');
const m = new Map<string, Tally>();
for (const p of pages) for (const [k, v] of Object.entries(p.byMethod ?? {})) add(m.get(k) ?? m.set(k, {}).get(k)!, v as Tally);
for (const [k, t] of [...m].sort()) {
	const n = (t.correct ?? 0) + (t.not_understood ?? 0);
	console.log(`| ${k} | ${t.correct ?? 0} | ${t.not_understood ?? 0} | ${t.ambiguous ?? 0} | ${f(n ? (t.correct ?? 0) / n : null)} |`);
}
