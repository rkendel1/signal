/**
 * Milestone 1B acceptance: the parcel-dataset workflow, entirely from the extension panel, against a real
 * FeltKit server and real Chromium. All data is SYNTHETIC (tests/fixtures/discovery); nothing here says
 * how it performs on a real county file or a real listing site.
 *
 *   npm run test:e2e   (needs Playwright; see extension.e2e.ts for the test-only manifest difference)
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

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const fx = (f: string) => readFileSync(new URL(`../fixtures/discovery/${f}`, import.meta.url), 'utf8');
const served = (f: string, origin: string) => fx(f).replaceAll('https://homes.example', origin);
/** A FeltKit client outside the extension, signed in as a dev user: what a script calling the API directly can do. */
async function apiAs(origin: string, user: string) {
	let token: string | null = null;
	const c = createClient({ url: origin, session: 'bearer', tokens: { get: () => token, set: (t: string | null) => { token = t; } } });
	await c.signInAsDevUser(user);
	return c;
}

const INTENT = JSON.stringify({
	schema: 'signal.intent/v1', id: 'low-tax', version: 1, name: 'Under $350k, tax rate under 1.08%', target: { type: ['RealEstateListing', 'SingleFamilyResidence'] },
	metrics: [
		{ name: 'taxRate', formula: { div: [{ attr: 'annualPropertyTax' }, { attr: 'price' }] } },
		{ name: 'priceToAssessed', formula: { div: [{ attr: 'price' }, { attr: 'assessedValue' }] } }
	],
	criteria: [
		{ id: 'price', label: 'price under $350,000', where: { attr: 'price', op: 'lt', value: 350000 } },
		{ id: 'tax', label: 'tax rate under 1.08%', metric: 'taxRate', where: { attr: 'taxRate', op: 'lt', value: 0.0108 } }
	]
});

test('parcel dataset workflow in the extension: import → review → approve → select → discover → provenance → remove', { timeout: 300_000 }, async (t) => {
	await build();
	const ext = mkdtempSync(join(tmpdir(), 'signal-ext-'));
	cpSync(join(root, 'extension/dist'), ext, { recursive: true });
	const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
	writeFileSync(join(ext, 'manifest.json'), JSON.stringify({ ...manifest, host_permissions: ['http://127.0.0.1/*'] }));
	t.after(() => rmSync(ext, { recursive: true, force: true }));

	const instance = await startSignal(t);
	const site = await fixture();
	t.after(() => site.close());
	site.set('/robots.txt', { body: '', type: 'text/plain' });
	site.set('/search', { body: served('metro-p1.html', site.url) });

	const files = mkdtempSync(join(tmpdir(), 'signal-files-'));
	t.after(() => rmSync(files, { recursive: true, force: true }));
	writeFileSync(join(files, 'parcels.csv'), fx('parcels.csv'));
	writeFileSync(join(files, 'notes.txt'), 'not data');
	writeFileSync(join(files, 'huge.csv'), `a,b\n${'1234567890,abcdefghij\n'.repeat(100_000)}`); // ~2.2 MB

	const profile = mkdtempSync(join(tmpdir(), 'signal-profile-'));
	const ctx = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
	t.after(async () => { await ctx.close(); rmSync(profile, { recursive: true, force: true }); });
	const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
	const extId = new URL(sw.url()).host;
	const listing = await ctx.newPage();
	await listing.goto(`${site.url}/search`);
	const panel = await ctx.newPage();
	const errors: string[] = [];
	panel.on('pageerror', (e: Error) => errors.push(e.message));
	await panel.goto(`chrome-extension://${extId}/panel.html`);
	const status = () => panel.textContent('#status');
	const waitStatus = (re: RegExp) => panel.waitForFunction((src: string) => new RegExp(src).test(document.getElementById('status')!.textContent ?? ''), re.source, { timeout: 30_000 });

	// ---- 1. open the extension, connect, sign in
	await panel.fill('#instance', instance);
	await panel.click('#connect-form button');
	await panel.waitForSelector('#signin:not([hidden])');
	// A viewer (Grace) can read alerts but not capture or import: the panel says so and offers nothing that would fail with a raw 403.
	await panel.click('#devusers button:has-text("Grace Hopper")');
	await panel.waitForSelector('#work:not([hidden])');
	await panel.waitForSelector('#access:not([hidden])');
	assert.match(String(await panel.textContent('#access')), /Grace Hopper \(viewer\) cannot capture pages or import data\. Sign out and sign in with a member account/);
	assert.equal(await panel.isDisabled('#capture'), true);
	assert.equal(await panel.isDisabled('#import-go'), true);
	assert.equal(await panel.isHidden('#mydata'), true);
	await panel.click('#signout');
	await panel.waitForSelector('#signin:not([hidden])');
	await panel.click('#devusers button:has-text("Ada Lovelace")');
	await panel.waitForSelector('#work:not([hidden])');
	assert.equal(await panel.isHidden('#access'), true, 'a member sees no access notice');
	assert.equal(await panel.isDisabled('#capture'), false);
	await panel.waitForFunction(() => /You have not imported any data yet/.test(document.getElementById('datasets')!.textContent ?? ''));
	assert.match(String(await panel.textContent('#dataset-chips')), /^$/, 'no data: nothing about datasets is shown in discovery');

	// ---- 2. import: unsupported and oversized files are refused before anything is sent
	await panel.click('#import-box summary');
	const importNote = () => panel.textContent('#import-note');
	await panel.setInputFiles('#import-file', join(files, 'notes.txt'));
	await panel.click('#import-go');
	await panel.waitForSelector('#import-note.error');
	assert.match(String(await importNote()), /not a CSV or GeoJSON file/);
	await panel.setInputFiles('#import-file', join(files, 'huge.csv'));
	await panel.click('#import-go');
	await panel.waitForFunction(() => /split it by area/.test(document.getElementById('import-note')!.textContent ?? ''));
	assert.match(String(await importNote()), /MB[^]*does not cut files down/);
	assert.match(String(await panel.textContent('#datasets')), /You have not imported any data yet/, 'a refused file imports nothing');

	await panel.setInputFiles('#import-file', join(files, 'parcels.csv'));
	assert.equal(await panel.inputValue('#import-name'), 'parcels', 'the name defaults to the file name');
	await panel.fill('#import-name', 'County parcels');
	await panel.fill('#import-asof', '2026-01-01');
	await panel.click('#import-go');
	await panel.waitForSelector('#review:not([hidden]) .mrow');

	// ---- 3. review the proposed mapping
	assert.match(String(await panel.textContent('#datasets .dataset')), /County parcels[^]*Needs your approval[^]*CSV · 9 records · version 1 · data as of 2026-01-01/);
	/** [column + role, attribute it becomes, examples, kind, why] for one mapped column. */
	const cells = async (source: string) => panel.$eval(`#review .mrow[data-source="${source}"]`, (r: Element) => [r.querySelector('.src')!.textContent!, (r.querySelector('input.attr') as HTMLInputElement).value, r.querySelector('.samples')!.textContent!, r.querySelector('.kind')!.textContent!, r.querySelector('.why')!.textContent!]);
	const [col, becomes, sample, kind, why] = await cells('assessed_total');
	assert.match(col, /assessed_total/); assert.equal(becomes, 'assessedValue'); assert.match(sample, /\$241,000/); assert.equal(kind, 'Kind: Money (USD)'); assert.match(why, /matches the vocabulary for assessedValue/);
	assert.equal((await cells('tax_annual'))[1], 'annualPropertyTax');
	assert.match((await cells('parcel_no'))[0], /used to match: parcel ID/);
	assert.match(String(await panel.textContent('#review .unmapped')), /Not used \(1\)[^]*owner_name/, 'a column Signal does not know is shown, not silently mapped');
	assert.match(String(await panel.textContent('#review .checks')), /1 value could not be read[^]*Row 9 · assessed_total: not a number \(“n\/a”\)/);
	assert.match(String(await panel.textContent('#review .preview')), /Your file: parcel_no = 12-001-001[^]*Signal reads:/);
	assert.match(String(await panel.textContent('#review .head .badge')), /Needs your approval/);
	assert.match(String(await panel.textContent('#review')), /Nothing from this file is used until you approve/);

	if (process.env.SIGNAL_SHOTS) { await panel.setViewportSize({ width: 420, height: 1000 }); await panel.locator('#mydata').screenshot({ path: join(process.env.SIGNAL_SHOTS, 'review.png') }); }
	// An unapproved dataset cannot be chosen for discovery.
	const pick = (name: string) => `#dataset-pick label.pick:has-text("${name}") input`;
	assert.equal(await panel.isDisabled(pick('County parcels')), true);
	assert.match(String(await panel.textContent('#dataset-pick')), /Its mapping has not been approved yet/);

	// ---- 4. approve (creates version 2); then change the mapping (creates version 3; version 2 is kept as it was)
	await panel.click('#approve');
	await waitStatus(/Approved “County parcels” as version 2/);
	assert.match(String(await panel.textContent('#datasets .dataset')), /Approved[^]*version 2/);
	assert.equal(await panel.isDisabled('#approve'), true, 'nothing to approve until something changes');
	await panel.fill('#review .mrow[data-source="gross_living_area"] input.attr', 'livingArea');
	await panel.dispatchEvent('#review .mrow[data-source="gross_living_area"] input.attr', 'change');
	assert.match(String(await panel.textContent('#approve')), /Save my changes and approve \(new version\)/);
	await panel.click('#approve');
	await waitStatus(/as version 3/);
	assert.deepEqual(await panel.$$eval('#review-version option', (o: Element[]) => o.map((x) => x.textContent)), ['Version 3 (latest)', 'Version 2', 'Version 1']);
	await panel.selectOption('#review-version', '2');
	await panel.waitForFunction(() => /Version 2 \(earlier\)/.test(document.querySelector('#review .head .badge')!.textContent ?? ''));
	assert.equal((await cells('gross_living_area'))[1], 'floorSize', 'version 2 still means what it meant');
	await panel.selectOption('#review-version', '3');
	await panel.waitForFunction(() => /^Approved$/.test(document.querySelector('#review .head .badge')!.textContent ?? ''));
	assert.equal((await cells('gross_living_area'))[1], 'livingArea');

	// A second import left unapproved is listed and cannot be selected.
	await panel.setInputFiles('#import-file', join(files, 'parcels.csv'));
	await panel.fill('#import-name', 'Draft parcels');
	await panel.click('#import-go');
	await panel.waitForFunction(() => /Draft parcels/.test(document.getElementById('datasets')!.textContent ?? ''));
	assert.equal(await panel.isDisabled(pick('Draft parcels')), true);
	assert.equal(await panel.isDisabled(pick('County parcels')), false);

	// ---- 5. capture the listing page
	await listing.bringToFront();
	await panel.click('#capture');
	await waitStatus(/^Analyzed: \d+ entities/);

	// ---- 6/7. the existing criteria (as JSON: derived metrics), without any dataset: the original behaviour
	await panel.click('#advanced summary');
	await panel.click('#json-mode');
	await panel.fill('#intent', INTENT);
	await panel.click('#discover');
	await waitStatus(/\d+ match · \d+ possible · \d+ not a match$/);
	const rows = async () => Object.fromEntries(await panel.$$eval('.cand', (els: Element[]) => els.map((e) => [e.querySelector('.head > :first-child')!.textContent!, e.querySelector('.badge:not(.ds-approved)')!.textContent!])) as Array<[string, string]>);
	const before = await rows();
	assert.equal(before['48 Oak Ave'], 'possible', 'tax is not on the page, so the metric is unknown');
	assert.equal(before['62 Aspen Way'], 'not a match');
	assert.equal(await panel.$$eval('.cand .facts', (e: Element[]) => e.length), 0, 'no dataset: no external facts are shown');
	assert.doesNotMatch(String(await status()), /your dataset/);

	// ---- 8. select the approved dataset
	await panel.check(pick('County parcels'));
	await waitStatus(/using 1 of your dataset$/);
	assert.match(String(await panel.textContent('#dataset-chips')), /The next evaluation will use: County parcels \(v3\)/);
	const after = await rows();
	assert.equal(after['48 Oak Ave'], 'match'); assert.equal(after['15 Maple Dr'], 'match');
	assert.equal(after['121 Elm St'], 'not a match'); assert.equal(after['9 Pine Ct'], 'not a match');
	assert.equal(after['300 Birch Rd'], 'possible', 'ambiguous: not enriched, not decided');
	assert.equal(after['77 Cedar Ln'], 'possible', 'address and location disagree: not enriched, not decided');

	if (process.env.SIGNAL_SHOTS) { await panel.locator('.cand:has(.head :text-is("300 Birch Rd"))').screenshot({ path: join(process.env.SIGNAL_SHOTS, 'birch.png') }); await panel.locator('.cand:has(.head :text-is("48 Oak Ave"))').screenshot({ path: join(process.env.SIGNAL_SHOTS, 'oak.png') }); }
	// ---- 9/10/11. enriched with assessed value and annual tax; metric from external values; provenance visible
	const factsOf = (name: string) => panel.textContent(`.cand:has(.head :text-is("${name}")) details.facts`);
	const oak = String(await factsOf('48 Oak Ave'));
	assert.match(oak, /Your data added \d+ facts/);
	assert.match(oak, /Annual Property Tax: \$3,600/); assert.match(oak, /Assessed Value: \$270,000/);
	assert.match(oak, /County parcels · mapping version 3 · data as of 2026-01-01 · a snapshot that does not change, received \d{4}-\d\d-\d\d/);
	assert.match(oak, /Record 12-001-002, matched by the same address, at the same location/);
	assert.match(oak, /Matched by the same address, at the same location/);
	assert.match(oak, /Tax Rate: 0\.0107[^]*Annual Property Tax from your data: County parcels · Price from the listing page/);
	assert.match(oak, /Price To Assessed: 1\.2407[^]*Assessed Value from your data: County parcels/);
	assert.match(oak, /Year Built: 1,979[^]*The listing page says 1,978\. Signal uses the page’s value/, 'a disagreement is shown, and the page keeps precedence');
	assert.match(oak, /From your data \(not shown on the listing page\)/, 'external facts are separate from page facts');
	const maple = String(await factsOf('15 Maple Dr'));
	assert.match(maple, /matched by the same address \(no location to confirm it\)|Matched by the same address \(no location to confirm it\)/);
	assert.match(maple, /medium confidence/);

	// ---- 12. an ambiguous property is not enriched, and the panel says why
	const birch = String(await factsOf('300 Birch Rd'));
	assert.match(birch, /Could be more than one property — not used/);
	assert.match(birch, /Could be record 12-001-004[^]*Could be record 12-001-005/);
	assert.match(birch, /Missing: Annual Property Tax/);
	assert.equal(await panel.$$eval('.cand:has(.head :text-is("300 Birch Rd")) .fact.external', (e: Element[]) => e.length), 0);
	assert.match(String(await factsOf('77 Cedar Ln')), /The address and location disagree — not used/);
	assert.equal(await panel.$$eval('.cand:has(.head :text-is("62 Aspen Way")) .fact.external', (e: Element[]) => e.length), 0, 'no record: nothing is invented');

	// ---- 13. remove the dataset: the original behaviour returns
	await panel.click('#dataset-chips button:has-text("Remove")');
	await panel.waitForFunction(() => !/your dataset/.test(document.getElementById('status')!.textContent ?? '') && document.querySelectorAll('.cand .facts').length === 0);
	assert.deepEqual(await rows(), before, 'the same results as before any dataset was chosen');
	assert.match(String(await panel.textContent('#dataset-chips')), /Not using your data: results come from the page alone/);
	assert.equal(await panel.isChecked(pick('County parcels')), false);

	// ---- security and ownership, against the real server
	const ada = await apiAs(instance, 'ada'), bob = await apiAs(instance, 'bob');
	const [src] = (await ada.query(api.sources.list, {})) as Array<{ id: string }>;
	const [pg] = (await ada.query(api.pages.list, { sourceId: src.id })) as Array<{ pageId: string }>;
	const mine = (await ada.query(api.datasets.list, {})) as Array<{ id: string; name: string }>;
	const draft = mine.find((d) => d.name === 'Draft parcels')!, county = mine.find((d) => d.name === 'County parcels')!;
	await assert.rejects(ada.query(api.discovery.evaluate, { pageIds: [pg.pageId], intent: INTENT, datasetIds: [draft.id] }), { code: 'FAILED_PRECONDITION' }, 'an unapproved mapping cannot be used by bypassing the panel');
	await assert.rejects(bob.query(api.discovery.evaluate, { pageIds: [pg.pageId], intent: INTENT, datasetIds: [county.id] }), { code: 'FORBIDDEN' });
	assert.deepEqual(await bob.query(api.datasets.list, {}), [], 'another user cannot enumerate datasets');
	await assert.rejects(bob.query(api.datasets.inspect, { datasetId: county.id }), { code: 'FORBIDDEN' });

	// The file's contents and the session stay out of the listing page and out of extension storage.
	const pageHtml = await listing.content();
	assert.doesNotMatch(pageHtml, /12-001-00\d|ELM STREET|County parcels|assessed/i, 'nothing from the dataset reaches the page the person is viewing');
	const stored = JSON.stringify(await panel.evaluate(() => chrome.storage.local.get(null)));
	assert.doesNotMatch(stored, /12-001-00\d|ELM STREET|OAK AVENUE|assessed_total/, 'file contents are not kept in extension storage');
	assert.match(stored, /signal\.datasets\.selected/, 'only the choice of dataset ids is kept');
	assert.deepEqual(errors, [], 'no uncaught errors in the panel');
});
