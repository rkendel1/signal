/**
 * M9: run a REAL parcel file (and optionally a REAL saved page snapshot) through the actual extension panel and
 * record what happens. It asserts nothing about accuracy: it records outcomes, and fails only on uncaught panel errors.
 * Skipped unless SIGNAL_M9_PARCELS is set.
 *
 *   SIGNAL_M9_PARCELS=/path/parcels.csv  [SIGNAL_M9_SNAPSHOT=/path/read.html  SIGNAL_M9_SNAPSHOT_URL=https://site/page]
 *   [SIGNAL_M9_OUT=/path/out.json]  node --test tests/e2e/m9-real.e2e.ts
 *
 * The snapshot is the file the panel's "Download what Signal read" saved from a page you opened in your own browser.
 * Here it is REPLAYED from a local server and captured through the panel: this exercises the extension and the
 * pipeline on real page structure, but it is not itself a live capture. Do not commit the inputs or the output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from '../helpers.ts';
import { build, root, startSignal } from './harness.ts';

const parcels = process.env.SIGNAL_M9_PARCELS;
const snapshot = process.env.SIGNAL_M9_SNAPSHOT;

test('M9: a real parcel file through the extension (import, mapping review, approval, discovery)', { skip: !parcels && 'set SIGNAL_M9_PARCELS', timeout: 900_000 }, async (t) => {
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
	if (snapshot) site.set('/listings', { body: readFileSync(snapshot, 'utf8') });
	else site.set('/listings', { body: '<html><body><p>no snapshot given</p></body></html>' });

	const profile = mkdtempSync(join(tmpdir(), 'signal-profile-'));
	const ctx = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
	t.after(async () => { await ctx.close(); rmSync(profile, { recursive: true, force: true }); });
	const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
	const listing = await ctx.newPage();
	await listing.goto(`${site.url}/listings`);
	const panel = await ctx.newPage();
	const errors: string[] = [];
	panel.on('pageerror', (e: Error) => errors.push(e.message));
	await panel.goto(`chrome-extension://${new URL(sw.url()).host}/panel.html`);

	const out: Record<string, unknown> = { measuredAt: new Date().toISOString(), parcelFile: { path: parcels, bytes: statSync(parcels!).size } };
	await panel.fill('#instance', instance); await panel.click('#connect-form button');
	await panel.waitForSelector('#signin:not([hidden])'); await panel.click('#devusers button:has-text("Ada Lovelace")');
	await panel.waitForSelector('#work:not([hidden])');

	// ---- import through the panel
	await panel.click('#import-box summary');
	await panel.setInputFiles('#import-file', parcels!);
	const t0 = Date.now();
	await panel.click('#import-go');
	await panel.waitForFunction(() => { const n = document.getElementById('import-note')!; return n.classList.contains('error') || !document.getElementById('review')!.hidden; }, null, { timeout: 600_000 });
	const importMs = Date.now() - t0;
	const refused = await panel.$('#import-note.error');
	if (refused) {
		out.import = { outcome: 'refused', ms: importMs, message: await panel.textContent('#import-note') };
	} else {
		const text = (sel: string) => panel.$$eval(sel, (e: Element[]) => e.map((x) => x.textContent!.trim()));
		out.import = { outcome: 'imported', ms: importMs, note: await panel.textContent('#import-note') };
		out.mapping = {
			columnsMapped: (await text('#review .mrow .src strong')),
			attributes: await panel.$$eval('#review .mrow input.attr', (e: Element[]) => e.map((x) => (x as HTMLInputElement).value)),
			notUsed: (await text('#review .unmapped-row > span:first-child')),
			checks: (await panel.textContent('#review .checks'))?.trim(),
			warnings: await text('#review ul.warnings li')
		};
		const a0 = Date.now();
		await panel.click('#approve');
		await panel.waitForFunction(() => /Approved “/.test(document.getElementById('status')!.textContent ?? ''), null, { timeout: 120_000 });
		out.approveMs = Date.now() - a0;

		if (snapshot) {
			await listing.bringToFront();
			await panel.click('#capture');
			await panel.waitForFunction(() => /Analyzed:|error/i.test(document.getElementById('status')!.textContent ?? '') || document.getElementById('status')!.classList.contains('error'), null, { timeout: 120_000 });
			out.capture = { status: await panel.textContent('#status'), diagnostics: (await panel.textContent('#diag'))?.trim() };
			const rowsOf = () => panel.$$eval('.cand .badge:not(.ds-approved)', (e: Element[]) => e.reduce((m: Record<string, number>, x) => { const k = x.textContent!; m[k] = (m[k] ?? 0) + 1; return m; }, {}));
			out.withoutDataset = { candidates: await panel.$$eval('.cand', (e: Element[]) => e.length), byStatus: await rowsOf() };
			const pick = panel.locator('#dataset-pick input[type=checkbox]').first();
			const d0 = Date.now();
			await pick.check();
			await panel.waitForFunction(() => /using 1 of your dataset/.test(document.getElementById('status')!.textContent ?? ''), null, { timeout: 300_000 });
			out.evaluateWithDatasetMs = Date.now() - d0;
			out.withDataset = {
				byStatus: await rowsOf(),
				resolutions: await panel.$$eval('details.facts .link', (e: Element[]) => e.reduce((m: Record<string, number>, x) => { const k = (x as HTMLElement).dataset.status!; m[k] = (m[k] ?? 0) + 1; return m; }, {})),
				candidatesEnriched: await panel.$$eval('.cand .badge.ds-approved', (e: Element[]) => e.length)
			};
			await panel.click('#dataset-chips button:has-text("Remove")');
			await panel.waitForFunction(() => !/your dataset/.test(document.getElementById('status')!.textContent ?? '') && document.querySelectorAll('.cand .facts').length === 0);
			out.afterRemoval = { byStatus: await rowsOf() };
			out.removalRestoresOriginal = JSON.stringify((out.afterRemoval as { byStatus: unknown }).byStatus) === JSON.stringify((out.withoutDataset as { byStatus: unknown }).byStatus);
		}
	}
	out.panelErrors = errors;
	const dest = process.env.SIGNAL_M9_OUT;
	if (dest) writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
	console.log(JSON.stringify(out, null, 2));
	assert.deepEqual(errors, [], 'no uncaught errors in the panel');
});
