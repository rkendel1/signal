/**
 * Ambient intelligence + shared site intelligence, end to end: a real `feltkit dev` server (isolated state), real
 * Chromium with the built extension, and the SYNTHETIC "Example Homes" site (tests/e2e/fixture-site.ts) — a
 * single-page app whose JSON API requires the visitor's own cookie session. The Signal web app is never opened
 * until the very end (the "Open in Signal" link).
 *
 * Test-only differences from a real install, both stated in scripts/build-extension.ts and GAP_REGISTER:
 *  - the manifest pre-grants host access to 127.0.0.1 (automation cannot answer Chrome's permission prompt);
 *  - the overlay is built with an OPEN shadow root (SIGNAL_E2E=1) so automation can reach inside it;
 *  - the scheduler interval is shortened through the panel's own setting.
 */
process.env.SIGNAL_E2E = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@feltdb/feltkit/client';
import { api } from '../../feltkit/_generated/api.ts';
import { build, root, startSignal } from './harness.ts';
import { exampleHomes } from './fixture-site.ts';

const { chromium } = createRequire(import.meta.url)('playwright');
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

test('ambient: recognise → analyze → connect with own session → finding → change while working → overlay → evidence; a second user reuses the definition', { timeout: 300_000 }, async (t) => {
	const m: Record<string, number | string> = {};
	await build();
	const ext = mkdtempSync(join(tmpdir(), 'signal-ext-'));
	cpSync(join(root, 'extension/dist'), ext, { recursive: true });
	const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
	writeFileSync(join(ext, 'manifest.json'), JSON.stringify({ ...manifest, host_permissions: ['http://127.0.0.1/*'] }));
	t.after(() => rmSync(ext, { recursive: true, force: true }));

	const instance = await startSignal(t);
	const site = await exampleHomes();
	t.after(() => site.close());

	// Ada already uses Signal: criteria for listings exist before she ever visits the site.
	const ada = createClient({ url: instance, session: 'bearer' });
	await ada.signInAsDevUser('ada');
	const crit = (await ada.mutation(api.criteria.save, { definition: JSON.stringify({ name: 'Homes under $430k', entityType: 'listing', severity: 'warning', require: [{ attr: 'price', op: 'lte', value: 430000 }, { attr: 'status', op: 'eq', value: 'active' }] }) } as never)) as Any;

	const profile = mkdtempSync(join(tmpdir(), 'signal-profile-'));
	const ctx = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
	t.after(async () => { await ctx.close(); rmSync(profile, { recursive: true, force: true }); });
	const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
	const extId = new URL(sw.url()).host;

	// 1. The person opens the site (a normal visit: the site sets their session cookie).
	const page = await ctx.newPage();
	const pageErrors: string[] = [];
	page.on('pageerror', (e: Error) => pageErrors.push(e.message));
	page.on('dialog', async (d: Any) => { pageErrors.push(`unexpected dialog: ${d.message()}`); await d.dismiss(); });
	await page.goto(`${site.origin}/search`);
	await page.waitForSelector('li.card');
	const heap0 = await page.evaluate(() => (performance as Any).memory?.usedJSHeapSize ?? 0);

	// Connect the extension and show Signal on this site (side panel, popped out as a tab).
	const panel = await ctx.newPage();
	await panel.goto(`chrome-extension://${extId}/panel.html`);
	await panel.fill('#instance', instance);
	await panel.click('#connect-form button');
	await panel.waitForSelector('#signin:not([hidden])');
	await panel.click('#devusers button:has-text("Ada")');
	await panel.waitForSelector('#work:not([hidden])');
	await page.bringToFront();
	await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'signal.setTick', minutes: 0.05 }));
	await panel.click('#site-toggle');
	await panel.waitForFunction(() => /on for/.test(document.getElementById('site-state')!.textContent ?? ''), null, { timeout: 15_000 }).catch(async (e: Error) => { throw new Error(`${e.message} status=${await panel.textContent('#status')} state=${await panel.textContent('#site-state')}`); });

	// 2. Signal is present on the page, quietly.
	const overlay = page.locator('signal-ambient');
	await overlay.waitFor({ state: 'attached', timeout: 15_000 });
	await page.waitForFunction(() => document.querySelector('signal-ambient')?.getAttribute('data-context-ms') !== null, null, { timeout: 15_000 });
	m.recognizeMs = Number(await overlay.getAttribute('data-context-ms'));
	assert.equal(await overlay.getAttribute('data-here'), '0');

	// 3–4. Understand this site: structured feed vs page surface.
	await overlay.locator('button.badge').click();
	await overlay.locator('text=Understand this site').click();
	await overlay.locator('text=What Signal found on').waitFor({ timeout: 30_000 });
	m.analysisMs = Number(await overlay.getAttribute('data-analysis-ms'));
	const analysisText = await overlay.locator('.panel').innerText();
	assert.match(analysisText, /api\/listings|listings/);
	assert.match(analysisText, /feed/);
	assert.match(analysisText, /depends on the signed-in user's session/, 'the analyzer saw that the API needs this visitor\'s session');
	assert.match(analysisText, /Not shared: depends on your session/, 'session-bound structure is not shared without consent');
	assert.match(analysisText, /surface|page:/, 'the rendered page is listed as a separate, surface-only representation');
	// Share its structure (explicit consent), then connect it with Ada's own access.
	await overlay.locator('text=Share its structure').first().click();
	await overlay.locator('text=Shared as').waitFor();

	await overlay.locator('text=← back').click();
	await overlay.locator('text=This site').first().waitFor();
	await overlay.locator('.item.click', { hasText: '127.0.0.1' }).click();
	const t5 = Date.now();
	await overlay.locator('button:has-text("Connect…")').first().click();
	await overlay.locator('input[aria-label="Each record describes a"]').fill('listing');
	await overlay.locator('button.s.p:has-text("Connect")').click();
	await overlay.locator('text=Connected (browser)').waitFor({ timeout: 20_000 }).catch(async (e: Error) => { throw new Error(`${e.message}\nLAST: ${await overlay.getAttribute('data-last-message')}`); });
	m.connectAndFirstAcquisitionMs = Date.now() - t5;
	assert.ok(site.requests.some((r) => r.path.startsWith('/api/listings') && r.cookie), 'the feed was fetched with the person\'s own session, from their browser');

	// 6–8. Observations → existing criteria → a finding, shown on the page without the web app.
	const src = ((await ada.query(api.sources.list, {} as never)) as Any[]).find((s) => s.kind === 'site_feed')!;
	assert.equal(src.acquisition, 'browser'); assert.equal(src.entityType, 'listing'); assert.equal(src.records, 12);
	let open = (await ada.query(api.findings.list, { criteriaId: crit.criteriaId } as never)) as Any[];
	assert.equal(open.length, 1, 'EH-100 at $420k qualifies');
	await overlay.locator('header .x').click();
	await page.waitForFunction(() => document.querySelector('signal-ambient')?.getAttribute('data-site') === '1', null, { timeout: 15_000 });

	// 9–11. The person keeps working on the site; the site changes; Signal notices on its own (scheduler, no app open).
	const t11 = Date.now();
	site.update((ls) => ls.map((l) => (l.listingId === 'EH-103' ? { ...l, price: 399_000, updatedAt: '2026-11-17T12:00:00Z' } : l)));
	for (;;) { open = (await ada.query(api.findings.list, { criteriaId: crit.criteriaId } as never)) as Any[]; if (open.length === 2 || Date.now() - t11 > 120_000) break; await new Promise((r) => setTimeout(r, 200)); }
	m.changeToFindingMs = Date.now() - t11;
	assert.equal(open.length, 2, 'the price drop produced a new finding');
	// 12. The overlay updates without a reload.
	await page.waitForFunction(() => document.querySelector('signal-ambient')?.getAttribute('data-site') === '2', null, { timeout: 60_000 });
	m.changeToOverlayMs = Date.now() - t11;
	const ticksBefore = site.requests.filter((r) => r.path.startsWith('/api/listings') && r.conditional).length;

	// Duplicate behaviour: the next scheduled check (one feed interval later) finds nothing new → a conditional
	// request answered 304, no new observation, no new notice.
	const notices1 = ((await ada.query(api.notices.list, {} as never)) as Any[]).length;
	const deadline = Date.now() + 100_000;
	while (site.requests.filter((r) => r.path.startsWith('/api/listings') && r.conditional).length <= ticksBefore && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
	await new Promise((r) => setTimeout(r, 1000));
	const notices2 = ((await ada.query(api.notices.list, {} as never)) as Any[]);
	assert.ok(site.requests.filter((r) => r.path.startsWith('/api/listings') && r.conditional).length > ticksBefore, 'the repeat check was a conditional request');
	assert.equal(notices2.length, notices1, 'no duplicate notice while nothing changes');
	const ings = ((await ada.query(api.sources.get, { sourceId: (((await ada.query(api.sources.list, {} as never)) as Any[]).find((s) => s.kind === 'site_feed')!).id } as never)) as Any).ingestions;
	assert.equal(ings[0].status, 'not_modified', 'recorded as a refresh with no new information');
	assert.equal(((await ada.query(api.notices.pending, {} as never)) as Any).notices.length, 0, 'every notice was handed to the browser once');
	m.noticesForTwoFindings = notices2.filter((n) => n.kind.startsWith('finding')).length;

	// SPA navigation to the listing that changed: the overlay persists and becomes contextual.
	await page.locator('a', { hasText: '16 Sample Way' }).click();
	await page.waitForURL(/\/homes\/EH-103$/);
	await page.waitForFunction(() => document.querySelector('signal-ambient')?.getAttribute('data-here') === '1', null, { timeout: 15_000 });
	// Page redraws and a hostile script removing foreign elements: the overlay re-attaches.
	await page.locator('#redraw').click();
	await page.locator('#hostile').click();
	await page.waitForTimeout(300);
	assert.equal(await page.locator('signal-ambient').count(), 1, 'one overlay, re-attached after removal');

	// 13–14. Open the finding from the overlay: evidence, source, feed, criteria, history — then the full app.
	await overlay.locator('button.badge').click();
	await overlay.locator('.item.click', { hasText: '16 Sample Way' }).first().click();
	await overlay.locator('text=Evidence').waitFor();
	const drawer = await overlay.locator('.panel').innerText();
	assert.match(drawer, /Homes under \$430k/); assert.match(drawer, /399000/); assert.match(drawer, /127\.0\.0\.1/); assert.match(drawer, /new/);
	const [appTab] = await Promise.all([ctx.waitForEvent('page'), overlay.locator('text=Open in Signal').click()]);
	await appTab.waitForLoadState();
	assert.match(appTab.url(), /#\/findings\//);
	assert.ok(page.url().endsWith('/homes/EH-103'), 'the site page stayed where it was');

	// 15. A second user reuses the shared definition — without Ada's session, URL parameters or data.
	const bob = createClient({ url: instance, session: 'bearer' });
	await bob.signInAsDevUser('bob');
	const rec = (await bob.query(api.sites.recognize, { url: `${site.origin}/search` } as never)) as Any;
	const feed = rec.feeds.find((f: Any) => f.endpoint?.pathTemplate === '/api/listings')!;
	assert.ok(feed, 'bob\'s Signal recognises the site and knows its feed');
	assert.equal(feed.access.auth, 'session');
	assert.deepEqual(feed.connections, []);
	const detail = (await bob.query(api.sites.site, { siteId: rec.siteId } as never)) as Any;
	const shared = JSON.stringify(detail.feeds.map((f: Any) => f.definition));
	assert.doesNotMatch(shared, /session-of-this-visitor/, 'no cookie');
	assert.doesNotMatch(shared, /Sample Way|EH-10\d/, 'no records');
	assert.doesNotMatch(shared, /41\.8|41\.6/, 'no parameter values');
	await assert.rejects(bob.mutation(api.sites.connect, { feedId: feed.id, url: `${site.origin}/api/listings?page=1&north=41.8&south=41.6`, acquisition: 'server' } as never), /browser session/, 'Signal\'s server will not acquire a session-bound feed');
	const bconn = (await bob.mutation(api.sites.connect, { feedId: feed.id, url: `${site.origin}/api/listings?page=1&north=42&south=41`, entityType: 'listing' } as never)) as Any;
	assert.equal(bconn.acquisition, 'browser');
	assert.equal(((await bob.query(api.sources.get, { sourceId: bconn.sourceId } as never)) as Any).coverage.records, 0, 'bob has nothing until his own browser acquires it');
	await assert.rejects(bob.query(api.sources.get, { sourceId: src.id } as never), /FORBIDDEN|not the owner/);

	m.overlayHeapDeltaKB = Math.round(((await page.evaluate(() => (performance as Any).memory?.usedJSHeapSize ?? 0)) - heap0) / 1024);
	assert.deepEqual(pageErrors, [], 'the site kept working normally');
	console.log(`# ambient measurements: ${JSON.stringify(m)}`);
});
