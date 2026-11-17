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
