/**
 * Overlay in a real browser (headless Chromium): events for the page, evidence,
 * acknowledgement, local Ghostpost decoding via WASM, dynamic content, and
 * that observed content is rendered as text (no script execution).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createApi } from '../src/api/server.ts';
import { SignalEngine } from '../src/runtime/engine.ts';
import { LocalPolicyAuthorizer, SignalService } from '../src/runtime/service.ts';
import { HttpSource } from '../src/sources/sources.ts';
import { InboxDispatcher } from '../src/delivery/dispatch.ts';
import { GhostpostUnicodeDecoder, ghostpostEncoder } from '../src/codecs/ghostpost-unicode.ts';
import { alice, fixture, instantRetry, tempStore, testNet } from './helpers.ts';

const require = createRequire(import.meta.url);
let chromium: { launch: () => Promise<any> } | undefined;
try { chromium = require('playwright').chromium; } catch { chromium = undefined; }

test('overlay shows evidence-backed alerts and decodes embedded signals', { skip: !chromium && 'playwright not available' }, async (t) => {
	const site = await fixture();
	t.after(() => site.close());
	const store = await tempStore();
	t.after(() => store.close());
	const svc = new SignalService(store, new LocalPolicyAuthorizer(), testNet);
	const engine = new SignalEngine({ store, sources: { http_page: new HttpSource('http_page', testNet) }, decoders: [new GhostpostUnicodeDecoder()], dispatchers: { inbox: new InboxDispatcher() }, deliveryPolicy: instantRetry });
	const api = createApi({ service: svc, engine, corsOrigins: [site.url], authenticate: (req) => (req.headers.authorization === 'Bearer tok_alice' ? alice : undefined) });
	await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
	t.after(() => new Promise<void>((r) => { api.closeAllConnections(); api.close(() => r()); }));
	const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

	const hidden = ghostpostEncoder.encodeText('Ask about our launch', 'Code WIDGET20 saves 20%');
	const page = (price: string) => `<!doctype html><html><head><title>Acme</title></head><body>
		<h1>Acme Widget &lt;img src=x onerror="window.__pwned=1"&gt;</h1>
		<p>Price: <b>$${price}</b></p><p id="promo">${hidden}</p>
		<script>window.SignalOverlayConfig={api:${JSON.stringify(apiUrl)},token:'tok_alice'};</script>
		<script src="${apiUrl}/overlay.js"></script></body></html>`;
	site.set('/robots.txt', { body: '', type: 'text/plain' });
	site.set('/widget', { body: page('129.00') });
	const source = await svc.registerSource(alice, { type: 'http_page', locator: `${site.url}/widget`, access: { authorization: 'public' }, observation: { strategy: 'manual' } });
	await svc.defineCriteria(alice, {
		id: 'crt_drop', name: 'Widget under $100', severity: 'critical',
		extract: [{ field: 'price', from: 'text', pattern: 'Price:\\s*\\$([0-9.,]+)', type: 'number' }],
		condition: { all: [{ field: 'price', op: 'lt', value: 100 }, { text: { matches: 'Acme Widget[^\\n]*' } }] }
	});
	const m = await svc.createMonitor(alice, { sourceId: source.id, criteriaId: 'crt_drop', criteriaVersion: 1, destinations: [{ id: 'inbox', type: 'inbox', target: alice.subjectId }] });
	await engine.runOnce(m.id);
	site.set('/widget', { body: page('95.00') });
	const run = await engine.runOnce(m.id);
	assert.equal(run.evaluation!.outcome, 'event_recorded');

	const browser = await chromium!.launch();
	t.after(() => browser.close());
	const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2 });
	const p = await ctx.newPage();
	const errors: string[] = [];
	p.on('pageerror', (e: Error) => errors.push(e.message));
	await p.goto(`${site.url}/widget`);
	// The overlay uses a *closed* shadow root (page scripts cannot read alert data), which Playwright
	// locators do not pierce. Read through the accessibility tree; click via CDP with pierce:true.
	const cdp = await ctx.newCDPSession(p);
	const click = async (label: string) => {
		const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
		const text = (n: any): string => n.nodeType === 3 ? n.nodeValue : [...(n.children ?? []), ...(n.shadowRoots ?? [])].map(text).join('');
		const findBtn = (n: any): any => {
			if (n.nodeName === 'BUTTON' && text(n).trim() === label) return n;
			for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) { const r = findBtn(c); if (r) return r; }
		};
		const btn = findBtn(root);
		assert.ok(btn, `button ${label} present`);
		await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: btn.backendNodeId });
		const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: btn.backendNodeId });
		const [x1, y1, , , x3, y3] = model.content;
		await p.mouse.click((x1 + x3) / 2, (y1 + y3) / 2);
	};
	await p.waitForFunction(() => document.querySelector('[data-signal-overlay]') !== null);
	const overlayText = async (): Promise<string> => {
		const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
		const out: string[] = [];
		const walk = (n: any, inOverlay: boolean) => {
			const isHost = n.attributes && n.attributes.includes('data-signal-overlay');
			const here = inOverlay || isHost;
			if (here && n.nodeType === 3 && n.parentId && n.nodeValue.trim()) out.push(n.nodeValue.trim());
			for (const c of [...(n.shadowRoots ?? []), ...(n.children ?? [])]) if (c.nodeName !== 'STYLE') walk(c, here);
		};
		walk(root, false);
		return out.join('\n');
	};
	await p.waitForTimeout(1500);
	assert.match(await overlayText(), /^1 alert$/m, 'badge announces the alert');

	await click('1 alert');
	await click('Evidence');
	await p.waitForTimeout(500);
	const all = await overlayText();
	assert.match(all, /Widget under \$100/);
	assert.match(all, /price lt 100 → 95 {2}\(was 129\)/);
	assert.match(all, /onerror="window\.__pwned=1"/, 'injection text shown as text');
	assert.match(all, /Preserved evidence \(sha256/);
	assert.match(all, /Ghostpost text/);
	assert.equal(await p.evaluate(() => (window as any).__pwned), undefined, 'observed content never executed');
	assert.equal(await p.evaluate(() => (document.querySelector('[data-signal-overlay]') as any).shadowRoot), null, 'page scripts cannot reach overlay DOM');

	mkdirSync('docs', { recursive: true });
	await click('Reveal');
	await p.waitForTimeout(200);
	assert.match(await overlayText(), /^Code WIDGET20 saves 20%$/m, 'reveal decodes via WASM in the browser');
	await p.screenshot({ path: 'docs/overlay.png' });

	await click('Acknowledge');
	await p.waitForTimeout(300);
	assert.equal((await store.listAcks(run.event!.eventId)).length, 1, 'acknowledgement is durable');

	// Dynamic content: a new embedded payload appears after load (feed-style).
	await p.evaluate((enc: string) => { const d = document.createElement('p'); d.textContent = enc; document.body.appendChild(d); }, ghostpostEncoder.encodeReference('Read more', 'external_url', 'https://example.com/a'));
	await p.waitForTimeout(1000);
	assert.match(await overlayText(), /^Ghostpost reference$/m, 'MutationObserver picked up the new payload');
	assert.deepEqual(errors, []);
});
