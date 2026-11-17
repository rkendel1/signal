/**
 * A single-page listing site moves its map without loading a page: the address is rewritten in place and the
 * listings are re-drawn (and later re-ordered). Reported on a real map site: the alert list never updated, the
 * overlay disappeared, and "Show on page" framed the same wrong place.
 *
 * SYNTHETIC page (a local server). It reproduces the mechanism, not any real site.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@feltdb/feltkit/client';
import { api } from '../../feltkit/_generated/api.ts';
import { fixture } from '../helpers.ts';
import { build, root, startSignal } from './harness.ts';

const PAGE = `<!doctype html><html lang="en"><head><title>Homes for sale</title></head><body><main>
<h1>Homes for sale</h1><p class="result-count">Showing homes</p>
<div class="map-wrap" style="position:relative;min-height:1200px;background:#dde"><ul class="results" style="list-style:none;padding:0"></ul></div></main>
<script>
const A = [['elm-121','121 Elm St',289000,3,1540,39.751,-104.981],['oak-48','48 Oak Ave',335000,4,1890,39.762,-104.972],['pine-9','9 Pine Ct',249000,3,1320,39.748,-104.99]];
const B = [['juniper-3','3 Juniper Rd',279000,3,1480,39.746,-104.977], ...A];
let current = A;
const card = ([id, addr, price, bd, sqft, lat, lng]) => '<li class="listing-card" data-lat="' + lat + '" data-lng="' + lng + '" style="margin:12px;padding:8px;border:1px solid #999;width:360px;background:#fff"><h3><a href="/homes/' + id + '">' + addr + '</a></h3><span class="listing-price">$' + price.toLocaleString('en-US') + '</span><p class="facts">' + bd + ' bd | 2 ba | ' + sqft + ' sqft</p></li>';
const draw = () => { document.querySelector('.results').innerHTML = current.map(card).join(''); };
window.moveMap = () => { history.replaceState(null, '', '/map?v=2'); setTimeout(() => { current = B; draw(); }, 300); };   // no page load
window.reshuffle = () => { current = [...current].reverse(); draw(); };                                                     // positions change, URL does not
draw();
</script></body></html>`;

test('a map that moves without a page load: the page is re-checked, the list updates, the overlay stays, matches are framed where they are', { timeout: 240_000 }, async (t) => {
	const { chromium } = createRequire(import.meta.url)('playwright');
	await build();
	const ext = mkdtempSync(join(tmpdir(), 'signal-ext-'));
	cpSync(join(root, 'extension/dist'), ext, { recursive: true });
	const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
	writeFileSync(join(ext, 'manifest.json'), JSON.stringify({ ...manifest, host_permissions: ['http://127.0.0.1/*'] }));
	t.after(() => rmSync(ext, { recursive: true, force: true }));

	const instance = await startSignal(t);
	const site = await fixture();
	t.after(() => site.close());
	site.set('/map', { body: PAGE });

	const profile = mkdtempSync(join(tmpdir(), 'signal-profile-'));
	const ctx = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
	t.after(async () => { await ctx.close(); rmSync(profile, { recursive: true, force: true }); });
	const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
	const page = await ctx.newPage();
	await page.setViewportSize({ width: 1000, height: 700 });
	await page.goto(`${site.url}/map?v=1`);
	const panel = await ctx.newPage();
	const errors: string[] = [];
	panel.on('pageerror', (e: Error) => errors.push(e.message));
	await panel.goto(`chrome-extension://${new URL(sw.url()).host}/panel.html`);

	await panel.fill('#instance', instance); await panel.click('#connect-form button');
	await panel.waitForSelector('#signin:not([hidden])'); await panel.click('#devusers button:has-text("Ada Lovelace")');
	await panel.waitForSelector('#work:not([hidden])');
	await page.bringToFront();
	await panel.click('#capture');
	await panel.waitForFunction(() => /^Analyzed: \d+ entities/.test(document.getElementById('status')!.textContent ?? ''));
	await panel.click('#watch');
	await panel.waitForFunction(() => /Watching /.test(document.getElementById('watch-state')!.textContent ?? ''));

	const watcher = createClient({ url: instance, session: 'bearer', tokens: (() => { let v: string | null = null; return { get: () => v, set: (x: string | null) => { v = x; } }; })() });
	await watcher.signInAsDevUser('ada');
	const source = ((await watcher.query(api.sources.list, {})) as Array<{ id: string; type: string; locator: string }>).find((x) => x.type === 'dom' && x.locator === `${site.url}/map`)!;
	const captures = async () => ((await watcher.query(api.pages.list, { sourceId: source.id })) as unknown[]).length;
	const alerts = async () => ((await watcher.query(api.events.forPage, { sourceLocator: `${site.url}/map` })) as unknown[]).length;
	const until = async (f: () => Promise<boolean> | boolean, ms = 25_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await f()) return true; await page.waitForTimeout(250); } return false; };
	const overlayText = async () => {
		const c = await ctx.newCDPSession(page);
		const { root: d } = await c.send('DOM.getDocument', { depth: -1, pierce: true });
		const out: string[] = [];
		const walk = (n: any, inside: boolean) => { const here = inside || (n.attributes ?? []).includes('data-signal-overlay'); if (here && n.nodeType === 3 && n.nodeValue.trim()) out.push(n.nodeValue.trim()); for (const k of [...(n.shadowRoots ?? []), ...(n.children ?? [])]) if (k.nodeName !== 'STYLE') walk(k, here); };
		walk(d, false); await c.detach();
		return out.join('\n');
	};
	const outlinedNames = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('li.listing-card')].filter((e) => e.style.outline.includes('5, 150, 105')).map((e) => e.querySelector('h3 a')!.textContent));

	assert.ok(await until(async () => (await outlinedNames()).length === 3), 'the three listings are outlined after the first alert');
	assert.equal(await alerts(), 1);
	const before = await captures();

	// ---- the map moves: the address changes, no page loads. Nothing is clicked in Signal.
	await page.evaluate(() => (window as any).moveMap());
	assert.equal(new URL(page.url()).search, '?v=2', 'the address changed in place');
	assert.ok(await until(async () => (await captures()) > before), 'the moved page was checked automatically, without a page load');
	assert.ok(await until(async () => (await alerts()) === 2), 'a new listing appeared, so a new alert was recorded');
	assert.ok(await until(async () => /2 alerts/.test(await overlayText())), `the overlay is still there and shows the update: ${await overlayText()}`);
	assert.match(await overlayText(), /4 matching items/, 'the list shows what the moved page now shows');
	assert.ok(await until(async () => (await outlinedNames()).length === 4), 'the new set is outlined on the re-drawn page');

	// ---- the page re-orders its listings (positions change; nothing else does)
	await page.evaluate(() => (window as any).reshuffle());
	assert.ok(await until(async () => { const n = await outlinedNames(); return n.length === 4 && new Set(n).size === 4; }), 'outlines follow the listings to their new positions, not the old positions');
	assert.match(await overlayText(), /^2 alerts$/m, 'the overlay did not disappear');

	// ---- "Show on page" frames that listing's own card, not another one and not a page region
	await page.bringToFront();
	await panel.click('.cand:has(.head > :first-child:text-is("121 Elm St")) button:text("Show on page")');
	let box: { x: number; y: number; w: number; h: number } | null = null;
	for (let i = 0; i < 40 && !box; i++) {
		await page.waitForTimeout(150);
		const c = await ctx.newCDPSession(page);
		const { root: d } = await c.send('DOM.getDocument', { depth: -1, pierce: true });
		let id: number | null = null;
		const walk = (n: any) => { const a: string[] = n.attributes ?? []; if (n.nodeType === 1 && a[a.indexOf('class') + 1] === 'spot') id = n.nodeId; for (const k of [...(n.shadowRoots ?? []), ...(n.children ?? [])]) walk(k); };
		walk(d);
		if (id !== null) { const m = await c.send('DOM.getBoxModel', { nodeId: id }).catch(() => null); if (m) { const q = m.model.border; box = { x: q[0], y: q[1], w: q[2] - q[0], h: q[5] - q[1] }; } }
		await c.detach();
	}
	assert.ok(box, 'a frame was drawn');
	await page.waitForTimeout(900); // the smooth scroll settles and the frame follows
	const card = await page.evaluate(() => { const li = [...document.querySelectorAll('li.listing-card')].find((e) => e.querySelector('h3 a')!.textContent === '121 Elm St')!; const r = li.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
	const c2 = await ctx.newCDPSession(page);
	const { root: d2 } = await c2.send('DOM.getDocument', { depth: -1, pierce: true });
	let id2: number | null = null;
	const walk2 = (n: any) => { const a: string[] = n.attributes ?? []; if (n.nodeType === 1 && a[a.indexOf('class') + 1] === 'spot') id2 = n.nodeId; for (const k of [...(n.shadowRoots ?? []), ...(n.children ?? [])]) walk2(k); };
	walk2(d2);
	const m2 = (await c2.send('DOM.getBoxModel', { nodeId: id2! })).model.border; await c2.detach();
	const frame = { x: m2[0], y: m2[1], w: m2[2] - m2[0], h: m2[5] - m2[1] };
	const cx = frame.x + frame.w / 2, cy = frame.y + frame.h / 2;
	assert.ok(cx >= card.x && cx <= card.x + card.w && cy >= card.y && cy <= card.y + card.h, `the frame is on Elm St's card (frame ${JSON.stringify(frame)}, card ${JSON.stringify(card)})`);
	assert.ok(frame.w < card.w + 40 && frame.h < card.h + 40, 'and it is the size of the card, not of a page region');
	assert.deepEqual(errors, []);
});
