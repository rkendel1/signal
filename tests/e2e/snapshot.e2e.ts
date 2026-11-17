/**
 * The capture reduction (extension/src/snapshot.ts) must not change what is understood: for every retained
 * real page, rendered in Chromium as a person's browser would (scripting on, so <noscript> is not content;
 * all network blocked except the page itself), the representation of the reduced snapshot has the same facts (factsRevision: entity ids, fact digests, relationships) as the full DOM.
 *
 *   node --test tests/e2e/snapshot.e2e.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extractPage } from '../../lib/page/extract.ts';
import type { PageRepresentation } from '../../lib/page/types.ts';
import { snapshotPage } from '../../extension/src/snapshot.ts';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const dir = new URL('../fixtures/real/', import.meta.url);
const ids = readdirSync(new URL('labels/', dir)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();

test('reduced snapshots keep every fact on all retained real pages, and are smaller', { timeout: 300_000 }, async (t) => {
	const browser = await chromium.launch();
	t.after(() => browser.close());
	const ctx = await browser.newContext(); // scripting on, as in a real capture; full and reduced are taken from the same DOM
	const rows: string[] = [];
	for (const id of ids) {
		const prov = JSON.parse(readFileSync(new URL(`${id}.provenance.json`, dir), 'utf8'));
		const html = readFileSync(new URL(`${id}.html`, dir), 'utf8');
		const url: string = prov.finalUrl ?? prov.url;
		const page = await ctx.newPage();
		await page.route('**/*', (r: any) => (r.request().url() === url ? r.fulfill({ body: html, contentType: 'text/html; charset=utf-8' }) : r.abort()));
		await page.goto(url, { waitUntil: 'domcontentloaded' });
		await page.evaluate(`globalThis.__snap = ${snapshotPage.toString()}`);
		const full: string = await page.evaluate(() => '<!doctype html>\n' + document.documentElement.outerHTML);
		// Structural reduction only: rendered visibility is tested separately below (it changes facts on purpose).
		const snap = await page.evaluate(([max, rendered]: [number, boolean]) => (globalThis as any).__snap(max, rendered), [50_000_000, false] as [number, boolean]);
		await page.close();
		const rep = (h: string): PageRepresentation => extractPage({ html: h, locator: prov.url, baseUrl: url, observationId: 'o', contentHash: 'h', contentType: 'text/html', observedAt: prov.fetchedAt });
		const a = rep(full), b = rep(snap.html!);
		if (a.factsRevision !== b.factsRevision) {
			const da = new Map(a.entities.map((e) => [e.id, e.digest])), db = new Map(b.entities.map((e) => [e.id, e.digest]));
			const attrs = (r: PageRepresentation, k: string) => new Set((r.entities.find((e) => e.id === k)?.attributes ?? []).map((x) => `${x.name}=${JSON.stringify(x.value)}`));
			const diff = [...new Set([...da.keys(), ...db.keys()])].filter((k) => da.get(k) !== db.get(k)).slice(0, 5).map((k) => {
				const x = attrs(a, k), y = attrs(b, k);
				return `${k}: only in full ${JSON.stringify([...x].filter((v) => !y.has(v)))}; only in reduced ${JSON.stringify([...y].filter((v) => !x.has(v)))}`;
			});
			assert.fail(`${id}: facts differ after reduction (${a.entities.length} vs ${b.entities.length} entities)\n${diff.join('\n')}`);
		}
		assert.ok(snap.chars <= full.length, `${id}: reduced is not larger`);
		rows.push(`${id.padEnd(20)} full ${String(full.length).padStart(8)}  reduced ${String(snap.chars).padStart(8)}  (${Math.round((1 - snap.chars / full.length) * 100)}% smaller)  entities ${b.entities.length}`);
	}
	console.log(rows.join('\n'));
});

test('rendered visibility: what the page does not display is dropped; what it displays despite aria-hidden is kept', { timeout: 60_000 }, async (t) => {
	const browser = await chromium.launch();
	t.after(() => browser.close());
	const page = await (await browser.newContext()).newPage();
	await page.setContent(`<!doctype html><html><head><style>.collapsed{display:none}</style>
		<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme Realty"}</script></head><body><main><h1>Homes</h1>
		<ul class="cards">
			<li class="card"><a href="/h/1">1 Main St</a><span class="price" aria-hidden="true">$300,000</span><span>3 bd</span></li>
			<li class="card"><a href="/h/2">2 Main St</a><span class="price" aria-hidden="true">$310,000</span><span>3 bd</span></li>
			<li class="card"><a href="/h/3">3 Main St</a><span class="price" aria-hidden="true">$320,000</span><span>4 bd</span></li>
		</ul>
		<div class="collapsed"><p>Sold: 9 Old Rd for $1</p></div>
		<p aria-hidden="true" style="display:none">not shown either</p>
		<script type="application/ld+json">{"@context":"https://schema.org","@type":"Place","name":"In-body JSON-LD stays"}</script>
		</main></body></html>`);
	const snap = await page.evaluate(snapshotPage, 50_000_000);
	assert.ok(snap.revealed >= 3, 'displayed prices are no longer marked hidden');
	assert.ok(snap.notDisplayed >= 2, 'CSS-hidden content is dropped');
	assert.ok(!snap.html!.includes('Sold: 9 Old Rd'));
	assert.ok(snap.html!.includes('In-body JSON-LD stays'), 'JSON-LD in <body> is data, not display');
	const rep = extractPage({ html: snap.html!, locator: 'https://x.example/', baseUrl: 'https://x.example/', observationId: 'o', contentHash: 'h', contentType: 'text/html', observedAt: '2026-11-17T12:00:00Z' });
	const prices = rep.entities.flatMap((e) => e.attributes.filter((a) => a.name === 'price').map((a) => (a.value as { amount: number }).amount)).sort();
	assert.deepEqual(prices, [300000, 310000, 320000], 'visible prices extracted (they were discarded as aria-hidden before)');
	assert.ok(rep.entities.some((e) => e.type === 'Place'));
	const plain = extractPage({ html: await page.content(), locator: 'https://x.example/', baseUrl: 'https://x.example/', observationId: 'o', contentHash: 'h', contentType: 'text/html', observedAt: '2026-11-17T12:00:00Z' });
	assert.equal(plain.entities.flatMap((e) => e.attributes.filter((a) => a.name === 'price')).length, 0, 'without rendered visibility the prices are lost');
});
