/**
 * The browser extension end to end: a real FeltKit dev server (isolated state), real Chromium with the built
 * extension loaded, a real page served over HTTP, and the panel driven the way a person uses it.
 *
 *   npm run test:e2e
 *
 * Test-only difference from a real install: the test manifest grants host access to 127.0.0.1, because
 * Chrome's permission prompt cannot be answered by automation (GAP_REGISTER G-EXT-1). The panel runs in a
 * tab ("popped out") because automation cannot open the side panel (G-EXT-2).
 * Data is SYNTHETIC: a page built to a real results page's structure, with invented addresses.
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

const { chromium } = createRequire(import.meta.url)('playwright');
const cards = readFileSync(new URL('../fixtures/pages/embedded-cards.html', import.meta.url), 'utf8');
const parcelsCsv = 'parcel_no,site_addr,assessed_total,tax_annual,lat,lon\n77-001,"12 EXAMPLE ROAD",$281000,$3400,41.70012,-71.50011\n77-002,"34 SAMPLE AVENUE",$392000,$4800,41.71021,-71.51021\n77-003,"56 PLACEHOLDER LANE",$241000,$2900,41.75,-71.6\n';

test('extension: connect, sign in, create a capture source, capture a rendered page, see the findings it affects', { timeout: 240_000 }, async (t) => {
	await build();
	const ext = mkdtempSync(join(tmpdir(), 'signal-ext-'));
	cpSync(join(root, 'extension/dist'), ext, { recursive: true });
	const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
	writeFileSync(join(ext, 'manifest.json'), JSON.stringify({ ...manifest, host_permissions: ['http://127.0.0.1/*'] })); // test-only, see header
	t.after(() => rmSync(ext, { recursive: true, force: true }));

	const instance = await startSignal(t);
	const site = await fixture();
	t.after(() => site.close());
	site.set('/homes/', { body: cards.replaceAll('https://listings.example', site.url) });

	// The person already has a parcel file and criteria that need both the page and the parcels.
	const api_ = createClient({ url: instance, session: 'bearer' });
	await api_.signInAsDevUser('ada');
	await api_.mutation(api.sources.create, { name: 'Parcels (synthetic)', kind: 'file', entityType: 'property', config: JSON.stringify({ format: 'csv' }), content: parcelsCsv, synthetic: true, mapping: JSON.stringify({ version: 1, entityType: 'property', fields: [
		{ source: 'parcel_no', attribute: 'parcelId', type: 'text', role: 'id' }, { source: 'site_addr', attribute: 'address', type: 'text', role: 'address' },
		{ source: 'assessed_total', attribute: 'assessedValue', type: 'money', currency: 'USD' }, { source: 'tax_annual', attribute: 'annualPropertyTax', type: 'money', currency: 'USD' },
		{ source: 'lat', attribute: 'latitude', type: 'number', role: 'latitude' }, { source: 'lon', attribute: 'longitude', type: 'number', role: 'longitude' },
	] }) } as never);
	await api_.mutation(api.criteria.save, { definition: JSON.stringify({ name: 'Listed under $500k with known taxes', entityType: 'property', severity: 'info', require: [{ attr: 'price', op: 'lte', value: 500000 }, { attr: 'annualPropertyTax', op: 'lt', value: 6000 }] }) } as never);

	const profile = mkdtempSync(join(tmpdir(), 'signal-profile-'));
	const ctx = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
	t.after(async () => { await ctx.close(); rmSync(profile, { recursive: true, force: true }); });
	const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
	const extId = new URL(sw.url()).host;

	const page = await ctx.newPage();
	await page.goto(`${site.url}/homes/`);
	const panel = await ctx.newPage();
	const errors: string[] = [];
	panel.on('pageerror', (e: Error) => errors.push(e.message));
	await panel.goto(`chrome-extension://${extId}/panel.html`);

	// A page address entered by mistake is explained, not a JSON error.
	site.set('/api/session', { status: 404, body: '<!DOCTYPE html><html><body>Page not found</body></html>' });
	await panel.fill('#instance', `${site.url}/homes/`);
	await panel.click('#connect-form button');
	await panel.waitForFunction(() => document.getElementById('status')!.classList.contains('error'));
	assert.match(String(await panel.textContent('#status')), /is not a Signal instance/);

	await panel.fill('#instance', instance);
	await panel.click('#connect-form button');
	await panel.waitForSelector('#signin:not([hidden])');
	await panel.click('#devusers button:has-text("Ada")');
	await panel.waitForSelector('#work:not([hidden])');
	assert.match(String(await panel.textContent('#who')), /Ada/);

	// No capture source yet: create one for listing cards.
	await panel.fill('#src-name', 'Listings I browse');
	await panel.fill('#src-types', 'RealEstateListing');
	await panel.click('#source-form button');
	await panel.waitForFunction(() => /created/.test(document.getElementById('status')!.textContent ?? ''));

	// Capture the rendered page the person is looking at.
	await page.bringToFront();
	await panel.click('#capture');
	await panel.waitForFunction(() => /Captured\.|error/i.test(document.getElementById('status')!.textContent ?? '') || document.getElementById('status')!.classList.contains('error'));
	assert.equal(await panel.textContent('#status'), 'Captured.', String(await panel.textContent('#status')));
	assert.match(String(await panel.textContent('#result')), /3 items read — 3 new, 0 changed\. 3 re-evaluated/);
	const affected: string[] = await panel.$$eval('#affected li.cand', (els: Element[]) => els.map((e) => e.textContent ?? ''));
	assert.equal(affected.length, 3, JSON.stringify(affected));
	assert.equal(affected.filter((x) => /match.*2 sources/.test(x)).length, 2, 'two listings match their parcels and qualify, supported by the page and the parcel file');
	assert.ok(affected.some((x) => /possible.*annualPropertyTax missing/.test(x)), "the third's parcel is 6 km away (identity conflict, not merged): its tax is unknown, so it is possible, not rejected");

	// The same page again: nothing new, nothing re-evaluated.
	await panel.click('#capture');
	await panel.waitForFunction(() => /nothing new/.test(document.getElementById('result')!.textContent ?? ''));

	// Signal itself agrees: the findings exist, cite both sources, and the session never reached the page.
	const findings = (await api_.query(api.findings.list, {} as never)) as Array<{ sourceCount: number; qualification: string }>;
	assert.equal(findings.filter((f) => f.qualification === 'match' && f.sourceCount === 2).length, 2);
	const leaked = await page.evaluate(() => JSON.stringify({ ...localStorage }) + document.cookie);
	assert.doesNotMatch(leaked, /fks_|session/i, 'the page under capture sees no Signal session');
	assert.deepEqual(errors, []);
});
