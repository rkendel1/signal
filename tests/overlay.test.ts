/**
 * The overlay in headless Chromium against the real FeltKit app.
 * The host transport is a Playwright-exposed function standing in for an extension's
 * content-script → service-worker channel (the overlay itself holds no credentials).
 * Note: an exposed function is reachable by page scripts; a real extension bridge lives
 * in the isolated world and is not (GAP_REGISTER G-OVL-1).
 */
process.env.SIGNAL_ALLOW_PRIVATE_HOSTS = '127.0.0.1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { createTestApp } from '@feltdb/feltkit/testing';
import { api } from '../feltkit/_generated/api.js';
import { ghostpostEncoder } from '../lib/codecs/ghostpost-unicode.ts';
import { fixture } from './helpers.ts';

const require = createRequire(import.meta.url);
let chromium: { launch: () => Promise<any> } | undefined;
try { chromium = require('playwright').chromium; } catch { chromium = undefined; }
const file = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('overlay: evidence-backed alerts for the page, acknowledgement, local Ghostpost decoding', { skip: !chromium && 'playwright not available' }, async (t) => {
	const site = await fixture();
	t.after(() => site.close());
	const app = await createTestApp();
	t.after(() => app.close());
	const ada = app.as('ada');

	site.set('/robots.txt', { body: '', type: 'text/plain' });
	site.set('/overlay.js', { body: file('../lib/overlay/overlay.js'), type: 'text/javascript' });
	site.set('/codec/ghostpost_unicode_codec.js', { body: file('../codecs/ghostpost-unicode/pkg/ghostpost_unicode_codec.js'), type: 'text/javascript' });
	site.set('/codec/ghostpost_unicode_codec_bg.wasm', { body: readFileSync(new URL('../codecs/ghostpost-unicode/pkg/ghostpost_unicode_codec_bg.wasm', import.meta.url)) as unknown as string, type: 'application/wasm' });
	const hidden = ghostpostEncoder.encodeText('Ask about our launch', 'Code WIDGET20 saves 20%');
	const page = (price: string) => `<!doctype html><html><head><title>Acme</title></head><body>
		<h1>Acme Widget &lt;img src=x onerror="window.__pwned=1"&gt;</h1>
		<p>Price: <b>$${price}</b></p><p id="promo">${hidden}</p>
		<script>window.SignalOverlayConfig={codecBase:'/codec',transport:(op,args)=>window.__signalHost(op,args)};</script>
		<script src="/overlay.js"></script></body></html>`;
	site.set('/widget', { body: page('129.00') });

	const sourceId = await ada.mutation(api.sources.register, { type: 'http_page', locator: `${site.url}/widget`, strategy: 'manual' });
	await ada.mutation(api.criteria.define, { definition: JSON.stringify({
		id: 'drop', name: 'Widget under $100', severity: 'critical',
		extract: [{ field: 'price', from: 'text', pattern: 'Price:\\s*\\$([0-9.,]+)', type: 'number' }],
		condition: { all: [{ field: 'price', op: 'lt', value: 100 }, { text: { matches: 'Acme Widget[^\\n]*' } }] }
	}) });
	const monitorId = await ada.mutation(api.monitors.create, { sourceId, criteriaId: 'drop', criteriaVersion: 1 });
	await ada.action(api.monitors.observe, { monitorId });
	site.set('/widget', { body: page('95.00') });
	const hit = await ada.action(api.monitors.observe, { monitorId });
	assert.equal(hit.outcome, 'event_recorded');

	const browser = await chromium!.launch();
	t.after(() => browser.close());
	const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2 });
	const p = await ctx.newPage();
	const ops: Record<string, (a: any) => Promise<unknown>> = {
		'events:forPage': (a) => ada.query(api.events.forPage, a),
		'events:evidence': (a) => ada.query(api.events.evidence, a),
		'events:acknowledge': (a) => ada.mutation(api.events.acknowledge, a),
	};
	await p.exposeFunction('__signalHost', (op: string, args: unknown) => ops[op](args));
	const errors: string[] = [];
	p.on('pageerror', (e: Error) => errors.push(e.message));
	await p.goto(`${site.url}/widget`);

	// Closed shadow root (page scripts cannot read alert data): read and click through CDP with pierce:true.
	const cdp = await ctx.newCDPSession(p);
	const text = (n: any): string => (n.nodeType === 3 ? n.nodeValue : [...(n.children ?? []), ...(n.shadowRoots ?? [])].map(text).join(''));
	const overlayText = async (): Promise<string> => {
		const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
		const out: string[] = [];
		const walk = (n: any, inside: boolean) => {
			const here = inside || (n.attributes ?? []).includes('data-signal-overlay');
			if (here && n.nodeType === 3 && n.nodeValue.trim()) out.push(n.nodeValue.trim());
			for (const c of [...(n.shadowRoots ?? []), ...(n.children ?? [])]) if (c.nodeName !== 'STYLE') walk(c, here);
		};
		walk(root, false);
		return out.join('\n');
	};
	const click = async (label: string) => {
		const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
		const find = (n: any): any => (n.nodeName === 'BUTTON' && text(n).trim() === label ? n : [...(n.children ?? []), ...(n.shadowRoots ?? [])].map(find).find(Boolean));
		const btn = find(root);
		assert.ok(btn, `button "${label}" present`);
		await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: btn.backendNodeId });
		const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: btn.backendNodeId });
		await p.mouse.click((model.content[0] + model.content[4]) / 2, (model.content[1] + model.content[5]) / 2);
	};

	await p.waitForTimeout(1500);
	assert.match(await overlayText(), /^1 alert$/m);
	await click('1 alert');
	await click('Evidence');
	await p.waitForTimeout(500);
	const all = await overlayText();
	assert.match(all, /Widget under \$100/);
	assert.match(all, /price lt 100 → 95 {2}\(was 129\)/);
	assert.match(all, /onerror="window\.__pwned=1"/, 'injected markup shown as text');
	assert.match(all, /hash verified/);
	assert.match(all, /Ghostpost text/);
	assert.equal(await p.evaluate(() => (window as any).__pwned), undefined, 'observed content never executed');
	assert.equal(await p.evaluate(() => (document.querySelector('[data-signal-overlay]') as any).shadowRoot), null);

	await click('Reveal');
	await p.waitForTimeout(200);
	assert.match(await overlayText(), /^Code WIDGET20 saves 20%$/m, 'decoded in the browser by the extracted WASM codec');
	mkdirSync('docs', { recursive: true });
	await p.screenshot({ path: 'docs/overlay.png' });

	await click('Acknowledge');
	await p.waitForTimeout(300);
	assert.equal((await ada.query(api.events.list, {}))[0].acknowledged, true, 'acknowledged durably in FeltKit');

	await p.evaluate((enc: string) => { const d = document.createElement('p'); d.textContent = enc; document.body.appendChild(d); }, ghostpostEncoder.encodeReference('Read more', 'external_url', 'https://example.com/a'));
	await p.waitForTimeout(1000);
	assert.match(await overlayText(), /^Ghostpost reference$/m, 'dynamic content picked up by MutationObserver');
	assert.deepEqual(errors, []);
});
