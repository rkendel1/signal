/**
 * The browser extension end to end: a real FeltKit dev server (isolated state), real Chromium with the
 * built extension loaded, and the panel driven the way a person uses it.
 *
 *   npm run test:extension
 *
 * Test-only difference from a real install: the test manifest grants host access to 127.0.0.1, because
 * Chrome's permission prompt cannot be answered by automation. The prompt path itself
 * (chrome.permissions.request) is therefore not exercised here.
 * The panel runs in a tab ("popped out") rather than the side panel, which automation cannot open.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@feltdb/feltkit/client';
import { api } from '../../feltkit/_generated/api.ts';
import { ghostpostEncoder } from '../../lib/codecs/ghostpost-unicode.ts';
import { fixture, priceCriteria } from '../helpers.ts';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = new URL('../../', import.meta.url).pathname;
const fx = (f: string) => readFileSync(new URL(`../fixtures/discovery/${f}`, import.meta.url), 'utf8');
/** The fixtures name https://homes.example; served from the test origin, their URLs must say so, or JSON-LD and cards are (correctly) different things. */
const served = (f: string, origin: string) => fx(f).replaceAll('https://homes.example', origin);

const freePort = () => new Promise<number>((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

async function startSignal(t: { after: (f: () => unknown) => void }) {
	const port = await freePort();
	const state = mkdtempSync(join(tmpdir(), 'signal-e2e-state-'));
	const proc = spawn(join(root, 'node_modules/.bin/feltkit'), ['dev', '--port', String(port)], { cwd: root, detached: true, env: { ...process.env, FELTKIT_STATE_DIR: state, SIGNAL_ALLOW_PRIVATE_HOSTS: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
	let log = '';
	await new Promise<void>((ok, fail) => {
		const timer = setTimeout(() => fail(new Error(`feltkit dev did not start:\n${log}`)), 60_000);
		const on = (d: Buffer) => { log += d; if (/Ready in/.test(log)) { clearTimeout(timer); ok(); } };
		proc.stdout.on('data', on); proc.stderr.on('data', on);
		proc.on('exit', (c) => { clearTimeout(timer); fail(new Error(`feltkit dev exited ${c}:\n${log}`)); });
		proc.unref();
	});
	t.after(() => { try { process.kill(-proc.pid!, 'SIGTERM'); } catch { /* already gone */ } rmSync(state, { recursive: true, force: true }); });
	return `http://127.0.0.1:${port}`;
}

function buildExtension(): string {
	const r = spawn('node', ['scripts/build-extension.ts'], { cwd: root, stdio: 'inherit' });
	return new Promise((ok, fail) => r.on('exit', (c) => (c === 0 ? ok(c) : fail(new Error('build failed'))))) as unknown as string;
}

test('extension: connect, sign in, capture rendered pages, discover, re-capture for change, overlay alerts; session stays out of pages', { timeout: 240_000 }, async (t) => {
	await buildExtension();
	const ext = mkdtempSync(join(tmpdir(), 'signal-ext-'));
	cpSync(join(root, 'extension/dist'), ext, { recursive: true });
	const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
	writeFileSync(join(ext, 'manifest.json'), JSON.stringify({ ...manifest, host_permissions: ['http://127.0.0.1/*'] })); // test-only, see header
	t.after(() => rmSync(ext, { recursive: true, force: true }));

	const instance = await startSignal(t);
	const site = await fixture();
	t.after(() => site.close());
	site.set('/robots.txt', { body: '', type: 'text/plain' });
	site.set('/search', { body: served('neighborhood.html', site.url) });

	const profile = mkdtempSync(join(tmpdir(), 'signal-profile-'));
	const ctx = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
	t.after(async () => { await ctx.close(); rmSync(profile, { recursive: true, force: true }); });
	const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
	const extId = new URL(sw.url()).host;

	const page = await ctx.newPage();
	const pageErrors: string[] = [];
	page.on('pageerror', (e: Error) => pageErrors.push(e.message));
	await page.goto(`${site.url}/search`);
	const panel = await ctx.newPage();
	const panelErrors: string[] = [];
	panel.on('pageerror', (e: Error) => panelErrors.push(e.message));
	await panel.goto(`chrome-extension://${extId}/panel.html`);
	const statusText = () => panel.textContent('#status');

	// A page address entered by mistake (an ordinary site answering /api/session with an HTML 404) is explained, not a JSON error.
	site.set('/api/session', { status: 404, body: '<!DOCTYPE html><html><body>Page not found</body></html>' });
	await panel.fill('#instance', `${site.url}/search`);
	await panel.click('#connect-form button');
	await panel.waitForFunction(() => document.getElementById('status')!.classList.contains('error'));
	const wrong = String(await statusText());
	assert.match(wrong, /is not a Signal instance \(it answered with a web page, not the FeltKit session API\)/);
	assert.match(wrong, /not the page you want to capture/);
	assert.doesNotMatch(wrong, /Unexpected token|JSON/);

	// Connect and sign in (development instance: dev users).
	await panel.fill('#instance', instance);
	await panel.click('#connect-form button');
	await panel.waitForSelector('#signin:not([hidden])');
	await panel.click('#devusers button:has-text("Ada Lovelace")');
	await panel.waitForSelector('#work:not([hidden])');
	assert.match(String(await panel.textContent('#who')), /Ada Lovelace/);

	// Capture the rendered page the person is looking at.
	await page.bringToFront();
	await panel.click('#capture');
	await panel.waitForFunction(() => /Captured:.*match ·|error/i.test(document.getElementById('status')!.textContent ?? '') || document.getElementById('status')!.classList.contains('error'));
	assert.match(String(await statusText()), /^Captured: \d+ entities\. Page [\d,]+ KB, structure-relevant part [\d,]+ KB sent; Signal keeps the structure, not the page\. 7 match · 0 possible · 0 not a match$/, 'with no filters on, everything found is listed');

	// The controls come from what the page contains: types as chips, attributes as sliders and toggles.
	assert.deepEqual(await panel.$$eval('#types .chip', (els: Element[]) => els.map((e) => [e.textContent, e.getAttribute('aria-pressed')])), [
		['Real Estate Listing · 7', 'true'], ['Product · 1', 'false'], ['Single Family Residence · 2', 'true']
	]);
	assert.deepEqual(await panel.$$eval('#filters .filter .top label', (els: Element[]) => els.map((e) => e.textContent)), ['Floor size', 'HOA fee', 'Bedrooms', 'Price', 'Year built', 'Has price reduction']);
	assert.equal(await panel.$$eval('#intent', (els: Element[]) => (els[0] as HTMLTextAreaElement).readOnly), true, 'JSON is shown, not required');

	const rows = async () => {
		const r: Array<[string, string]> = await panel.$$eval('.cand', (els: Element[]) => els.map((e) => [e.querySelector('.head > :first-child')!.textContent!, e.querySelector('.badge')!.textContent!]));
		assert.equal(new Set(r.map((x) => x[0])).size, r.length, `one candidate per home: ${JSON.stringify(r)}`);
		return Object.fromEntries(r);
	};
	/** Drag a slider the way a person does: the value snaps to the slider's step, then results update live. */
	const slide = async (attr: string, bound: 'lo' | 'hi', value: number) => {
		await panel.evaluate(() => { document.getElementById('status')!.textContent = ''; });
		await panel.$eval(`input[type=range][data-attr="${attr}"][data-bound="${bound}"]`, (r: Element, v: number) => { (r as HTMLInputElement).value = String(v); r.dispatchEvent(new Event('input', { bubbles: true })); }, value);
		await panel.waitForFunction(() => / match · /.test(document.getElementById('status')!.textContent ?? ''));
	};
	await slide('price', 'hi', 350000); // snaps to $349,000 (199,000 + n × 5,000)
	await slide('numberOfBedrooms', 'lo', 3);
	assert.match(String(await panel.textContent('#filters')), /\$199,000 – \$349,000/);
	const first = await rows();
	assert.deepEqual(first, {
		'121 Elm St': 'match', '48 Oak Ave': 'match', '9 Pine Ct': 'match', '15 Maple Dr': 'match',
		'300 Birch Rd': 'possible', '77 Cedar Ln': 'not a match', '62 Aspen Way': 'not a match'
	});
	assert.match(String(await statusText()), /^4 match · 1 possible · 2 not a match$/);
	assert.match(String(await panel.textContent('#results')), /Complete: the page declares 8 and all 8 were examined \(1 not of the target type\)/);
	assert.match(String(await panel.textContent('#results')), /Undecided: Bedrooms: not shown/);
	// "Items that don't show it are not a match": Birch (no bedrooms shown) moves from possible to not a match.
	await panel.evaluate(() => { document.getElementById('status')!.textContent = ''; });
	await panel.click('.filter:has(input[data-attr="numberOfBedrooms"]) .missing input');
	await panel.waitForFunction(() => / match · /.test(document.getElementById('status')!.textContent ?? ''));
	assert.equal((await rows())['300 Birch Rd'], 'not a match');
	await panel.evaluate(() => { document.getElementById('status')!.textContent = ''; });
	await panel.click('.filter:has(input[data-attr="numberOfBedrooms"]) .missing input');
	await panel.waitForFunction(() => / match · /.test(document.getElementById('status')!.textContent ?? ''));
	const intentJson = JSON.parse(String(await panel.$eval('#intent', (t: Element) => (t as HTMLTextAreaElement).value)));
	assert.deepEqual(intentJson.criteria.map((c: any) => [c.where.attr, c.where.op, c.where.value]), [['numberOfBedrooms', 'between', [3, 4]], ['price', 'between', [199000, 349000]]]);

	// "Alert me": the current filters become this search's alert criteria, stated in words, with where alerts go.
	assert.match(String(await panel.textContent('#watch-state')), /Not watching this page/);
	await panel.evaluate(() => { document.getElementById('status')!.textContent = ''; });
	await panel.click('#watch');
	await panel.waitForFunction(() => /^Alert recorded\. Captured:.*match ·/.test(document.getElementById('status')!.textContent ?? '') || document.getElementById('status')!.classList.contains('error'));
	assert.match(String(await statusText()), /^Alert recorded\. /, 'the current matches are the first alert');
	const host = site.url.replace(/^https?:\/\//, '');
	await panel.waitForFunction(() => /Watching /.test(document.getElementById('watch-state')!.textContent ?? ''));
	const watchText = String(await panel.textContent('#watch-state'));
	assert.ok(watchText.includes(`Watching ${host}/search — any map position or filters in the address`), `watch text: ${JSON.stringify(watchText)} status: ${await statusText()}`);
	assert.match(watchText, /Price \$199,000–\$349,000/);
	assert.match(watchText, /Bedrooms 3–4/);
	assert.match(watchText, /Where: outlined on this page, a browser notification, and your Signal inbox/);
	assert.match(watchText, /“Possible” items \(missing information\) never alert/);
	// On the page itself: the matching listings are outlined (4: Elm, Oak, Pine, Maple; Birch is only "possible").
	const outlined = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('body *')].filter((e) => e.style.outline.includes('5, 150, 105')).length);
	let n = 0;
	for (let i = 0; i < 40 && n !== 4; i++) { await page.waitForTimeout(250); n = await outlined(); }
	assert.equal(n, 4, 'matching items outlined on the page');

	// "Show on page": the listing is scrolled into view and framed with why it matched.
	const shadowText = async () => {
		const c = await ctx.newCDPSession(page);
		const { root: d } = await c.send('DOM.getDocument', { depth: -1, pierce: true });
		const out: string[] = [];
		const walk = (nd: any, inside: boolean) => { const here = inside || (nd.attributes ?? []).includes('data-signal-overlay'); if (here && nd.nodeType === 3 && nd.nodeValue.trim()) out.push(nd.nodeValue.trim()); for (const k of [...(nd.shadowRoots ?? []), ...(nd.children ?? [])]) if (k.nodeName !== 'STYLE') walk(k, here); };
		walk(d, false);
		await c.detach();
		return out.join('\n');
	};
	await page.setViewportSize({ width: 900, height: 500 }); // short window: the last match starts below the fold
	await page.evaluate(() => window.scrollTo(0, 0));
	await panel.click('.cand:has(.head > :first-child:text-is("15 Maple Dr")) button:text("Show on page")');
	let spotted = '';
	for (let i = 0; i < 40 && !/Signal match:/.test(spotted); i++) { await page.waitForTimeout(150); spotted = await shadowText(); }
	assert.match(spotted, /^Signal match: Bedrooms 3–4 · Price \$199,000–\$349,000$/m, 'framed on the page with why it matched');
	await page.waitForTimeout(800); // smooth scroll
	const inView = await page.evaluate(() => {
		const a = [...document.querySelectorAll('a')].find((x) => x.textContent === '15 Maple Dr')!;
		const r = a.getBoundingClientRect();
		return r.top >= 0 && r.bottom <= window.innerHeight;
	});
	assert.ok(inView, 'scrolled to where the listing is');
	if (process.env.SIGNAL_SCREENSHOTS) { await page.setViewportSize({ width: 900, height: 700 }); await page.waitForTimeout(300); await page.screenshot({ path: join(process.env.SIGNAL_SCREENSHOTS, 'extension-page.png') }); }

	// One overlay per page, even when an older one is left behind in another script world (an extension reload).
	await panel.evaluate(async (url: string) => {
		const [tab] = await chrome.tabs.query({ url: `${url}/*` });
		await chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ['overlay.js'], world: 'MAIN' }); // stands in for the orphan
	}, site.url);
	await page.waitForTimeout(300);
	await panel.click('#overlay');
	await panel.waitForFunction(() => /Alerts are shown/.test(document.getElementById('status')!.textContent ?? ''));
	let hosts = 0;
	for (let i = 0; i < 20; i++) { await page.waitForTimeout(150); hosts = await page.evaluate(() => document.querySelectorAll('[data-signal-overlay]').length); if (hosts === 1 && /1 alert/.test(await shadowText())) break; }
	assert.equal(hosts, 1, 'exactly one overlay');
	assert.match(await shadowText(), /^1 alert$/m, 'and it is the working one');
	await page.setViewportSize({ width: 1280, height: 720 });

	// The page changes; the person captures it again: changes are detected against the previous capture.
	site.set('/search', { body: served('neighborhood-later.html', site.url) });
	await page.reload();
	await page.bringToFront();
	await panel.evaluate(() => { document.getElementById('status')!.textContent = ''; });
	await panel.click('#capture');
	await panel.waitForFunction(() => /Captured:.*match ·/.test(document.getElementById('status')!.textContent ?? ''));
	assert.match(String(await panel.textContent('#pages')), /changed since last capture/);
	assert.match(String(await statusText()), /^Alert recorded\. /, 'a new listing and a price change: a new alert');
	const second = await rows(); // the same filters, kept across the new capture, re-evaluated automatically
	assert.equal(second['48 Oak Ave'], 'match · changed');
	assert.equal(second['3 Juniper Rd'], 'match');
	assert.equal(second['9 Pine Ct'], 'match', 'an unchanged listing is not flagged');
	// Elm St: the first page also stated a stale $279,000 in JSON-LD; the later page states only $289,000.
	// The set of stated prices changed, so it is reported (as "Changed: price"), not hidden.
	assert.equal(second['121 Elm St'], 'match · changed');
	assert.match(String(await panel.textContent('#results')), /Changed: Price/);
	assert.match(String(await panel.textContent('#results')), /detail page: may resolve: Bedrooms/);
	if (process.env.SIGNAL_SCREENSHOTS) { // optional: `SIGNAL_SCREENSHOTS=<dir> npm run test:extension`
		await panel.setViewportSize({ width: 400, height: 1400 });
		await panel.screenshot({ path: join(process.env.SIGNAL_SCREENSHOTS, 'extension-panel.png'), fullPage: true });
	}

	// The map moves (new coordinates in the address): the watch still applies, and is checked automatically on load.
	const watcher = createClient({ url: instance, session: 'bearer', tokens: (() => { let v: string | null = null; return { get: () => v, set: (x: string | null) => { v = x; } }; })() });
	await watcher.signInAsDevUser('ada');
	const parentSource = ((await watcher.query(api.sources.list, {})) as Array<{ id: string; type: string; locator: string }>).find((x) => x.type === 'dom' && x.locator === `${site.url}/search`)!;
	const capturesOfSearch = async () => ((await watcher.query(api.pages.list, { sourceId: parentSource.id })) as unknown[]).length;
	const before = await capturesOfSearch();
	await page.goto(`${site.url}/search?south=39.70&west=-105.05&north=39.80&east=-104.90&zoom=13`);
	let after = before;
	for (let i = 0; i < 40 && after === before; i++) { await page.waitForTimeout(250); after = await capturesOfSearch(); }
	assert.equal(after, before + 1, 'opening the watched search at a new map position was checked automatically');
	await panel.waitForFunction(() => /^Checked automatically\. Captured:.*match ·/.test(document.getElementById('status')!.textContent ?? ''));
	const alerts = (await watcher.query(api.events.forPage, { sourceLocator: `${site.url}/search` })) as unknown[];
	assert.equal(alerts.length, 2, 'same matches as the last check: no third alert');
	let overlay = '';
	for (let i = 0; i < 40 && !/2 alerts/.test(overlay); i++) {
		await page.waitForTimeout(250);
		overlay = await page.evaluate(() => (document.querySelector('[data-signal-overlay]') ? 'present' : '')) ? 'present' : '';
		if (overlay) {
			const cdp0 = await ctx.newCDPSession(page);
			const { root: d } = await cdp0.send('DOM.getDocument', { depth: -1, pierce: true });
			const out: string[] = [];
			const walk = (nd: any, inside: boolean) => { const here = inside || (nd.attributes ?? []).includes('data-signal-overlay'); if (here && nd.nodeType === 3 && nd.nodeValue.trim()) out.push(nd.nodeValue.trim()); for (const c of [...(nd.shadowRoots ?? []), ...(nd.children ?? [])]) if (c.nodeName !== 'STYLE') walk(c, here); };
			walk(d, false);
			overlay = out.join('\n');
			await cdp0.detach();
		}
	}
	assert.match(overlay, /^2 alerts$/m, 'alerts recorded for the search show on the page at its new address');
	assert.ok(overlay.includes(`Covers: ${site.url}/search (any map position or filters in the address)`), overlay);
	assert.match(overlay, /Alert when an item matches: Bedrooms 3–4 · Price \$199,000–\$349,000/);

	// Alerts on a monitored page, through the overlay → panel relay.
	const node = createClient({ url: instance, session: 'bearer', tokens: (() => { let v: string | null = null; return { get: () => v, set: (x: string | null) => { v = x; } }; })() });
	await node.signInAsDevUser('ada');
	const hidden = ghostpostEncoder.encodeText('Ask about our launch', 'Code WIDGET20 saves 20%');
	const widget = (price: string) => `<!doctype html><html><head><title>Acme</title></head><body><h1>Acme Widget</h1><p>Price: <b>$${price}</b></p><p>${hidden}</p></body></html>`;
	site.set('/widget', { body: widget('129.00') });
	const sourceId = await node.mutation(api.sources.register, { type: 'http_page', locator: `${site.url}/widget`, strategy: 'manual' });
	await node.mutation(api.criteria.define, { definition: priceCriteria('drop') });
	const monitorId = await node.mutation(api.monitors.create, { sourceId, criteriaId: 'drop', criteriaVersion: 1 });
	await node.action(api.monitors.observe, { monitorId });
	site.set('/widget', { body: widget('95.00') });
	assert.equal((await node.action(api.monitors.observe, { monitorId }) as { outcome: string }).outcome, 'event_recorded');

	await page.goto(`${site.url}/widget`);
	await page.bringToFront();
	await panel.click('#overlay');
	await panel.waitForFunction(() => /Alerts are shown/.test(document.getElementById('status')!.textContent ?? ''));
	const cdp = await ctx.newCDPSession(page);
	const overlayText = async () => {
		const { root: doc } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
		const out: string[] = [];
		const walk = (n: any, inside: boolean) => {
			const here = inside || (n.attributes ?? []).includes('data-signal-overlay');
			if (here && n.nodeType === 3 && n.nodeValue.trim()) out.push(n.nodeValue.trim());
			for (const c of [...(n.shadowRoots ?? []), ...(n.children ?? [])]) if (c.nodeName !== 'STYLE') walk(c, here);
		};
		walk(doc, false);
		return out.join('\n');
	};
	let text = '';
	for (let i = 0; i < 40 && !/1 alert/.test(text); i++) { await page.waitForTimeout(250); text = await overlayText(); }
	assert.match(text, /^1 alert$/m, 'the event for this page reached the overlay through the panel');
	assert.match(text, /Widget under \$100/);
	assert.match(text, /Ghostpost text/, 'embedded signal decoded locally by the packaged WASM codec');

	// Security: page scripts cannot reach the extension; content scripts cannot read the session; the relay is an allow-list.
	assert.equal(await page.evaluate(() => typeof (window as any).chrome?.runtime?.sendMessage), 'undefined', 'page scripts have no channel to the extension');
	const probe = await panel.evaluate(async (url: string) => {
		const [tab] = await chrome.tabs.query({ url: `${url}/*` });
		const [storage] = await chrome.scripting.executeScript({ target: { tabId: tab.id! }, func: async () => { try { await chrome.storage.local.get(null); return 'readable'; } catch (e) { return String((e as Error).message); } } });
		const [relay] = await chrome.scripting.executeScript({ target: { tabId: tab.id! }, func: async () => chrome.runtime.sendMessage({ type: 'signal.overlay', op: 'pages:get', args: { pageId: 'x' } }) });
		const token = (await chrome.storage.local.get('signal.session'))['signal.session'] as string;
		return { storage: storage.result, relay: relay.result, token };
	}, site.url);
	assert.match(String(probe.storage), /not allowed/i, 'session storage is locked to trusted contexts');
	assert.deepEqual(probe.relay, { ok: false, error: 'refused: pages:get' });
	assert.ok(probe.token && probe.token.length > 10, 'the panel holds a bearer session');
	assert.ok(site.requests.every((r) => !JSON.stringify(r.headers).includes(probe.token)), 'the session never reaches a page origin');
	const reps = await node.query(api.sources.list, {}) as Array<{ type: string; locator: string }>;
	assert.ok(reps.some((s) => s.type === 'dom' && s.locator === `${site.url}/search`), 'captures recorded as dom sources of the page');

	assert.deepEqual(pageErrors, []);
	assert.deepEqual(panelErrors, []);
});
