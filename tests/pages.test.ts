/**
 * Universal Page Intelligence through the real FeltKit app (FeltDB, Files, Notifications)
 * and real HTTP; the dynamic page through real Chromium.
 */
process.env.SIGNAL_ALLOW_PRIVATE_HOSTS = '127.0.0.1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createTestApp } from '@feltdb/feltkit/testing';
import { api } from '../feltkit/_generated/api.js';
import { fixture } from './helpers.ts';

const page = (n: string) => readFileSync(new URL(`./fixtures/pages/${n}.html`, import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
let chromium: { launch: () => Promise<any> } | undefined;
try { chromium = require('playwright').chromium; } catch { chromium = undefined; }

async function setup(t: { after: (f: () => unknown) => void }) {
	const site = await fixture();
	t.after(() => site.close());
	site.set('/robots.txt', { body: '', type: 'text/plain' });
	const app = await createTestApp();
	t.after(() => app.close());
	return { site, app, ada: app.as('ada'), bob: app.as('bob') };
}

test('inspect an unfamiliar page: no adapter, no criteria, a durable evidence-backed representation', async (t) => {
	const { site, ada, bob } = await setup(t);
	site.set('/catalog', { body: page('products') });
	const sourceId = await ada.mutation(api.sources.register, { type: 'http_page', locator: `${site.url}/catalog`, strategy: 'manual' });
	const s1 = await ada.action(api.pages.inspect, { sourceId }) as { pageId: string; outcome: string; revision: string; entities: number };
	assert.equal(s1.outcome, 'represented');
	const rep = await ada.query(api.pages.get, { pageId: s1.pageId }) as any;
	assert.equal(rep.schema, 'signal.page/v1');
	assert.equal(rep.source.locator, `${site.url}/catalog`);
	const products = rep.entities.filter((e: any) => e.type === 'Product');
	assert.equal(products.length, 3);
	const canyon = products.find((p: any) => p.attributes.some((a: any) => a.name === 'name' && a.value === 'Canyon 1'));
	assert.deepEqual(canyon.attributes.find((a: any) => a.name === 'price').value, { amount: 179.99, currency: 'USD' });
	assert.ok(rep.evidence.length > 10);
	// identical page → identical revision; changed page → new revision
	const s2 = await ada.action(api.pages.inspect, { sourceId }) as { revision: string; pageId: string };
	assert.equal(s2.revision, s1.revision);
	assert.notEqual(s2.pageId, s1.pageId, 'each observation is its own durable record');
	site.set('/catalog', { body: page('products').replace('$179.99', '$149.99') });
	assert.notEqual(((await ada.action(api.pages.inspect, { sourceId })) as { revision: string }).revision, s1.revision);
	assert.equal((await ada.query(api.pages.list, { sourceId }) as unknown[]).length, 3);
	// authorization
	await assert.rejects(bob.query(api.pages.get, { pageId: s1.pageId }), { code: 'FORBIDDEN' });
	await assert.rejects(bob.action(api.pages.inspect, { sourceId }), { code: 'FORBIDDEN' });
});

test('entity criteria through the existing pipeline: events, evidence, duplicates, changes, notifications', async (t) => {
	const { site, ada } = await setup(t);
	site.set('/catalog', { body: page('products') });
	const sourceId = await ada.mutation(api.sources.register, { type: 'http_page', locator: `${site.url}/catalog`, strategy: 'manual' });
	await ada.mutation(api.criteria.define, { definition: JSON.stringify({ id: 'cheap', name: 'Any product under $200', severity: 'warning', condition: { entity: { type: 'Product', where: [{ attr: 'price', op: 'lt', value: 200 }] } } }) });
	await ada.mutation(api.criteria.define, { definition: JSON.stringify({ id: 'restock', name: 'A product changed availability', severity: 'info', condition: { entity: { type: 'Product', where: [{ attr: 'availability', op: 'changed' }] } } }) });
	const cheap = await ada.mutation(api.monitors.create, { sourceId, criteriaId: 'cheap', criteriaVersion: 1 });
	const restock = await ada.mutation(api.monitors.create, { sourceId, criteriaId: 'restock', criteriaVersion: 1 });

	const r1 = await ada.action(api.monitors.observe, { monitorId: cheap });
	assert.equal(r1.outcome, 'event_recorded');
	const ev = await ada.query(api.events.evidence, { eventId: r1.eventId! });
	const leaf = ev.event.matched.find((m: { op?: string }) => m.op === 'entity')!;
	assert.deepEqual((leaf.actual as Array<{ name: string }>).map((m) => m.name), ['Canyon 1']);
	assert.match(ev.event.excerpts.map((x: { text: string }) => x.text).join('\n'), /Product “Canyon 1”: price=USD 179\.99/);
	assert.ok(ev.event.evidence.pageRef?.startsWith('files:'), 'event links the page representation');
	assert.ok(ev.verified);
	const inbox = await ada.query(api.events.inbox, {});
	assert.equal(inbox.length, 1);

	// Re-rendered identical content → same matched entity values → suppressed
	site.set('/catalog', { body: page('products').replace('<main>', '<main><!-- ad -->') });
	assert.equal((await ada.action(api.monitors.observe, { monitorId: cheap })).outcome, 'suppressed_duplicate');
	// Price drop on the matched product → new event (on_change)
	site.set('/catalog', { body: page('products').replace('$179.99', '$159.99') });
	assert.equal((await ada.action(api.monitors.observe, { monitorId: cheap })).outcome, 'event_recorded');

	// availability change: baseline first, then the change on an existing entity
	assert.equal((await ada.action(api.monitors.observe, { monitorId: restock })).outcome, 'no_match');
	site.set('/catalog', { body: page('products').replace('$179.99', '$159.99').replace('Out of stock', 'In stock') });
	const r = await ada.action(api.monitors.observe, { monitorId: restock });
	assert.equal(r.outcome, 'event_recorded');
	const e2 = await ada.query(api.events.evidence, { eventId: r.eventId! });
	const m = (e2.event.matched[0].actual as Array<{ name: string; values: any; previous: any }>)[0];
	assert.equal(m.name, 'Canyon 1');
	assert.deepEqual([m.previous.availability, m.values.availability], [['OutOfStock'], ['InStock']]);

	// The legacy text/field criteria keep working on the same monitor pipeline (regression).
	await ada.mutation(api.criteria.define, { definition: JSON.stringify({ id: 'legacy', name: 'mentions Summit', severity: 'info', condition: { text: { contains: 'Summit Supply' } } }) });
	const legacy = await ada.mutation(api.monitors.create, { sourceId, criteriaId: 'legacy', criteriaVersion: 1 });
	assert.equal((await ada.action(api.monitors.observe, { monitorId: legacy })).outcome, 'event_recorded');
});

test('dynamic content: a static fetch sees the shell; a browser-rendered snapshot is represented the same way', { skip: !chromium && 'playwright not available' }, async (t) => {
	const { site, ada } = await setup(t);
	site.set('/deals', { body: page('dynamic') });
	const httpSource = await ada.mutation(api.sources.register, { type: 'http_page', locator: `${site.url}/deals`, strategy: 'manual' });
	const staticRep = await ada.query(api.pages.get, { pageId: ((await ada.action(api.pages.inspect, { sourceId: httpSource })) as { pageId: string }).pageId }) as any;
	assert.equal(staticRep.entities.filter((e: any) => e.type === 'Product').length, 0, 'scripts are not executed by Signal');

	const browser = await chromium!.launch();
	t.after(() => browser.close());
	const p = await (await browser.newContext()).newPage();
	await p.goto(`${site.url}/deals`);
	await p.waitForSelector('li.deal');
	const rendered = await p.content();

	const domSource = await ada.mutation(api.sources.register, { type: 'dom', locator: `${site.url}/deals`, strategy: 'event' });
	const summary = await ada.mutation(api.pages.push, { sourceId: domSource, html: rendered, baseUrl: `${site.url}/deals` });
	const rep = await ada.query(api.pages.get, { pageId: summary.pageId }) as any;
	const products = rep.entities.filter((e: any) => e.type === 'Product');
	assert.deepEqual(products.map((e: any) => e.attributes.find((a: any) => a.name === 'name').value), ['Trail Stove', 'Titanium Mug', 'Water Filter']);
	assert.equal(rep.observedAt.length > 0, true);

	await ada.mutation(api.criteria.define, { definition: JSON.stringify({ id: 'mug', name: 'Deal under $30', severity: 'info', condition: { entity: { type: 'Product', where: [{ attr: 'price', op: 'lt', value: 30 }] } } }) });
	const monitorId = await ada.mutation(api.monitors.create, { sourceId: domSource, criteriaId: 'mug', criteriaVersion: 1 });
	const r = await ada.mutation(api.monitors.push, { monitorId, content: rendered });
	assert.equal(r.outcome, 'event_recorded');
	const ev = await ada.query(api.events.evidence, { eventId: r.eventId! });
	assert.deepEqual((ev.event.matched[0].actual as Array<{ name: string }>).map((m) => m.name), ['Titanium Mug']);
});

test('every unrelated fixture becomes a representation through FeltKit (no site adapters)', async (t) => {
	const { ada } = await setup(t);
	const src = await ada.mutation(api.sources.register, { type: 'dom', locator: 'https://unfamiliar.example/page', strategy: 'event' });
	const expectations: Record<string, string> = { products: 'Product', job: 'JobPosting', article: 'Article', discussion: 'Comment', table: 'TableRow', 'jsonld-conflict': 'Offer', unknown: 'Unknown' };
	for (const [name, type] of Object.entries(expectations)) {
		const sum = await ada.mutation(api.pages.push, { sourceId: src, html: page(name), baseUrl: 'https://unfamiliar.example/page' });
		const rep = await ada.query(api.pages.get, { pageId: sum.pageId }) as any;
		assert.ok(rep.entities.some((e: any) => e.type === type), `${name} → ${type}`);
		assert.equal(sum.truncated, false);
	}
});

test('discovery over recorded pages: owner-only, read-only, previous pages give change detection', async (t) => {
	const { ada, bob } = await setup(t);
	const fx = (f: string) => readFileSync(new URL(`./fixtures/discovery/${f}`, import.meta.url), 'utf8');
	const base = 'https://homes.example/search?south=39.74&west=-105.00&north=39.77&east=-104.96&sort=newest';
	const sourceId = await ada.mutation(api.sources.register, { type: 'dom', locator: 'dom:riverside', strategy: 'manual' });
	const p1 = await ada.mutation(api.pages.push, { sourceId, html: fx('neighborhood.html'), baseUrl: base }) as { pageId: string };
	const p2 = await ada.mutation(api.pages.push, { sourceId, html: fx('neighborhood-later.html'), baseUrl: base }) as { pageId: string };
	const intent = JSON.stringify({
		schema: 'signal.intent/v1', id: 'riverside', version: 1, name: 'under 350k, 3+ beds', target: { type: ['RealEstateListing', 'SingleFamilyResidence'] },
		criteria: [{ id: 'price', label: '< 350k', where: { attr: 'price', op: 'lt', value: 350000 } }, { id: 'beds', label: '3+ beds', where: { attr: 'numberOfBedrooms', op: 'gte', value: 3 } }]
	});
	const r = await ada.query(api.discovery.evaluate, { pageIds: [p2.pageId], previousPageIds: [p1.pageId], intent }) as any;
	assert.equal(r.schema, 'signal.discovery/v1');
	const st = Object.fromEntries(r.candidates.map((c: any) => [c.key.split('/').pop(), c.status]));
	assert.deepEqual(st, { 'aspen-62': 'non_match', 'birch-300': 'possible', 'cedar-77': 'non_match', 'elm-121': 'match', 'juniper-3': 'match', 'maple-15': 'match', 'oak-48': 'match', 'pine-9': 'match' });
	assert.deepEqual(r.candidates.find((c: any) => c.key.endsWith('oak-48')).changed.fields, ['price']);
	assert.equal(r.coverage.exhaustive, true);
	await assert.rejects(bob.query(api.discovery.evaluate, { pageIds: [p1.pageId], intent }), { code: 'FORBIDDEN' });
	await assert.rejects(ada.query(api.discovery.evaluate, { pageIds: [p1.pageId], intent: '{' }), { code: 'INVALID_ARGUMENT' });
	await assert.rejects(ada.query(api.discovery.evaluate, { pageIds: [p1.pageId], intent: intent.replace('"lt"', '"decreased"') }), { code: 'INVALID_ARGUMENT' });
	assert.equal((await ada.query(api.pages.list, { sourceId }) as unknown[]).length, 2, 'discovery recorded nothing');
});

test('fetching is decided by source type: dom sources may name any page a person captured, but are never fetched', async (t) => {
	const { ada } = await setup(t);
	const intranet = 'http://10.0.0.5/reports/q3';
	await assert.rejects(ada.mutation(api.sources.register, { type: 'http_page', locator: intranet, strategy: 'manual' }), { code: 'INVALID_ARGUMENT' }, 'fetchable sources keep the outbound URL guard');
	const sourceId = await ada.mutation(api.sources.register, { type: 'dom', locator: intranet, strategy: 'manual' });
	await assert.rejects(ada.action(api.pages.inspect, { sourceId }), { code: 'FAILED_PRECONDITION' }, 'a dom source is push-only');
	await ada.mutation(api.criteria.define, { definition: JSON.stringify({ id: 'any', name: 'anything', severity: 'info', condition: { text: { contains: 'x' } } }) });
	const monitorId = await ada.mutation(api.monitors.create, { sourceId, criteriaId: 'any', criteriaVersion: 1 });
	await assert.rejects(ada.action(api.monitors.observe, { monitorId }), { code: 'FAILED_PRECONDITION' });
	const r = await ada.mutation(api.pages.push, { sourceId, html: '<h1>Q3</h1><table><tr><th>Region</th><th>Total</th></tr><tr><td>East</td><td>12</td></tr><tr><td>West</td><td>9</td></tr></table>', baseUrl: intranet }) as { outcome: string };
	assert.equal(r.outcome, 'represented');
});

test('a captured page larger than a stored file can be is represented: the structure is kept, the page is not', async (t) => {
	const { ada } = await setup(t);
	const sourceId = await ada.mutation(api.sources.register, { type: 'dom', locator: 'https://listings.example/search', strategy: 'manual' });
	const rows = Array.from({ length: 40 }, (_, i) => `<li class="card"><h3><a href="/homes/${i}">${i} Main St</a></h3><span class="price">$${(200 + i) * 1000}</span><p>${3 + (i % 2)} bd | 2 ba | 1,${400 + i} sqft</p></li>`).join('');
	const filler = `<div hidden>${'x'.repeat(1_400_000)}</div>`; // page bulk the structure does not need (over the 1 MiB file limit)
	const html = `<!doctype html><html><head><title>Homes</title></head><body><main><h1>Homes for sale</h1><ul>${rows}</ul>${filler}</main></body></html>`;
	assert.ok(html.length > 1_048_576);
	const r = await ada.mutation(api.pages.push, { sourceId, html, baseUrl: 'https://listings.example/search' }) as { pageId: string; outcome: string };
	assert.equal(r.outcome, 'represented');
	const rep = await ada.query(api.pages.get, { pageId: r.pageId }) as any;
	assert.equal(rep.entities.filter((e: any) => e.type === 'RealEstateListing').length, 40);
	assert.equal(rep.source.contentHash.length, 64, 'what was observed is identified by its hash');
});

test('a watched intent alerts through the existing pipeline: discover condition → event → notification; same matches do not re-alert', async (t) => {
	const { ada } = await setup(t);
	const fx = (f: string) => readFileSync(new URL(`./fixtures/discovery/${f}`, import.meta.url), 'utf8');
	const parent = 'https://homes.example/search'; // the watch covers the search, whatever the map position in the query
	const sourceId = await ada.mutation(api.sources.register, { type: 'dom', locator: parent, strategy: 'manual' });
	const intent = {
		schema: 'signal.intent/v1', id: 'watch', version: 1, name: 'homes', target: { type: ['RealEstateListing', 'SingleFamilyResidence'] },
		criteria: [{ id: 'price', label: 'Price $199,000–$349,000', where: { attr: 'price', op: 'between', value: [199000, 349000] } }, { id: 'numberOfBedrooms', label: 'Bedrooms 3–4', where: { attr: 'numberOfBedrooms', op: 'between', value: [3, 4] } }]
	};
	await ada.mutation(api.criteria.define, { definition: JSON.stringify({ id: 'watch.riverside', name: 'Homes: Price $199,000–$349,000 · Bedrooms 3–4', severity: 'info', condition: { discover: intent } }) });
	const monitorId = await ada.mutation(api.monitors.create, { sourceId, criteriaId: 'watch.riverside', criteriaVersion: 1 });
	const push = (f: string, q: string) => ada.mutation(api.monitors.push, { monitorId, content: fx(f), baseUrl: `${parent}?${q}` }) as Promise<{ outcome: string; eventId: string | null; pageId?: string | null }>;

	const first = await push('neighborhood.html', 'south=39.74&north=39.77');
	assert.equal(first.outcome, 'event_recorded', 'the current matches are the first alert');
	assert.ok(first.pageId, 'the capture is also a page record');
	const ev = await ada.query(api.events.evidence, { eventId: first.eventId! }) as any;
	const leaf = ev.event.matched.find((m: any) => m.op === 'discover');
	assert.deepEqual(leaf.actual.map((m: any) => m.name).sort(), ['121 Elm St', '15 Maple Dr', '48 Oak Ave', '9 Pine Ct'], '“possible” Birch Rd (no bedrooms shown) does not alert');
	assert.ok(leaf.actual.every((m: any) => m.locators.length > 0), 'each match carries where it is on the page');
	assert.equal(ev.raw, null, 'a captured page keeps its structure, not the page');
	assert.ok(ev.pageRevision);
	assert.equal((await ada.query(api.events.inbox, {}) as unknown[]).length, 1, 'notified');

	assert.equal((await push('neighborhood.html', 'south=39.70&north=39.80')).outcome, 'suppressed_duplicate', 'map moved, same matches: no new alert');
	const later = await push('neighborhood-later.html', 'south=39.74&north=39.77');
	assert.equal(later.outcome, 'event_recorded', 'a new listing and a price change: a new alert');
	const ev2 = await ada.query(api.events.evidence, { eventId: later.eventId! }) as any;
	const m2 = ev2.event.matched.find((m: any) => m.op === 'discover').actual;
	assert.ok(m2.some((m: any) => m.name === '3 Juniper Rd'));
	assert.deepEqual(m2.find((m: any) => m.name === '48 Oak Ave').changed, ['price']);
	assert.match((await ada.query(api.events.inbox, {}) as any[])[0].body, /^5 matches: /);

	await ada.mutation(api.monitors.setEnabled, { monitorId, enabled: false });
	await assert.rejects(push('neighborhood.html', 'x=1'), { code: 'FAILED_PRECONDITION' }, 'a stopped watch records nothing');
	await assert.rejects(ada.mutation(api.criteria.define, { definition: JSON.stringify({ id: 'bad', name: 'bad', severity: 'info', condition: { discover: { ...intent, criteria: [{ id: 'p', label: 'p', where: { attr: 'price', op: 'decreased' } }] } } }) }), { code: 'INVALID_ARGUMENT' });
});
