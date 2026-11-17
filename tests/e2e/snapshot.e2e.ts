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
		const full: string = await page.evaluate(() => '<!doctype html>\n' + document.documentElement.outerHTML);
		const snap = await page.evaluate(snapshotPage, 50_000_000);
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
