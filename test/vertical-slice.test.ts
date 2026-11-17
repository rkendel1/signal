/**
 * The vertical slice, end to end, against real HTTP and a real FeltDB file store:
 *  1 register an authorized source        6 durable matched event
 *  2 read an accessible webpage            7 evidence + provenance preserved
 *  3 extract its content                   8 webhook delivery (signed, idempotent)
 *  4 detect a relevant change              9 event visible to the application API
 *  5 evaluate a user-defined criterion    10 duplicate alerts suppressed
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { SignalEngine } from '../src/runtime/engine.ts';
import { LocalPolicyAuthorizer, SignalService } from '../src/runtime/service.ts';
import { HttpSource } from '../src/sources/sources.ts';
import { InboxDispatcher, WebhookDispatcher } from '../src/delivery/dispatch.ts';
import { GhostpostUnicodeDecoder } from '../src/codecs/ghostpost-unicode.ts';
import { InvisibleUnicodeDetector } from '../src/codecs/invisible-unicode.ts';
import { alice, fixture, instantRetry, productPage, tempStore, testNet } from './helpers.ts';

test('vertical slice: price-drop monitor over a live webpage', async (t) => {
	const site = await fixture();
	t.after(() => site.close());
	site.set('/robots.txt', { body: 'User-agent: *\nDisallow: /private\n', type: 'text/plain' });
	site.set('/widget', { body: productPage('129.00'), etag: '"v1"' });
	site.set('/hook', { body: 'ok', type: 'text/plain' });

	const store = await tempStore();
	t.after(() => store.close());
	const svc = new SignalService(store, new LocalPolicyAuthorizer(), testNet);
	const secrets = async (ref: string) => (ref === 'secret://hooks/acme' ? 's3cret' : undefined);
	const engine = new SignalEngine({
		store,
		sources: { http_page: new HttpSource('http_page', testNet) },
		decoders: [new GhostpostUnicodeDecoder(), new InvisibleUnicodeDetector()],
		dispatchers: { webhook: new WebhookDispatcher(secrets, testNet), inbox: new InboxDispatcher() },
		deliveryPolicy: instantRetry
	});

	// 1. register source + criteria + monitor
	const source = await svc.registerSource(alice, { type: 'http_page', locator: `${site.url}/widget`, access: { authorization: 'public' }, observation: { strategy: 'poll', intervalSeconds: 600 } });
	const criteria = await svc.defineCriteria(alice, {
		id: 'crt_price_drop', name: 'Widget under $100', severity: 'warning',
		extract: [{ field: 'price', from: 'text', pattern: 'Price:\\s*\\$([0-9][0-9,.]*)', type: 'number' }],
		condition: { all: [{ field: 'price', op: 'lt', value: 100 }, { not: { text: { contains: 'out of stock' } } }] }
	});
	const monitor = await svc.createMonitor(alice, {
		sourceId: source.id, criteriaId: criteria.id, criteriaVersion: 1,
		destinations: [
			{ id: 'd_hook', type: 'webhook', target: `${site.url}/hook`, secretRef: 'secret://hooks/acme' },
			{ id: 'd_inbox', type: 'inbox', target: alice.subjectId }
		]
	});

	// 2–5. first observation: $129 → no match, baseline recorded
	const r1 = await engine.runOnce(monitor.id);
	assert.equal(r1.observation.status, 'ok');
	assert.equal(r1.observation.provenance.robots, 'allowed');
	assert.equal(r1.interpretation!.fields[0].value, 129);
	assert.equal(r1.evaluation!.outcome, 'no_match');
	assert.equal(r1.event, undefined);

	// unchanged page: conditional GET → 304, nothing re-evaluated
	const r2 = await engine.runOnce(monitor.id);
	assert.equal(r2.observation.status, 'not_modified');
	assert.equal(site.requests.filter((q) => q.path === '/widget').at(-1)!.headers['if-none-match'], '"v1"');

	// price drops to $95 → match → durable event → delivered
	site.set('/widget', { body: productPage('95.00'), etag: '"v2"' });
	const r3 = await engine.runOnce(monitor.id);
	assert.equal(r3.evaluation!.outcome, 'event_recorded');
	const ev = r3.event!;
	assert.ok(ev);
	assert.equal(ev.criteriaVersion, 1);
	assert.deepEqual(ev.matched.find((m) => m.op === 'lt')!.actual, 95);
	assert.deepEqual(ev.matched.find((m) => m.op === 'lt')!.previous, 129, 'previous value is recorded');
	assert.match(ev.excerpts[0].text, /Price: \$95\.00/);

	// 6–7. evidence: the exact bytes observed are retrievable and hash-verified
	const raw = new TextDecoder().decode(await store.getEvidence(ev.evidence.observationRef));
	assert.equal(raw, productPage('95.00'));
	assert.equal(ev.evidence.observationRef, `sha256:${ev.evidence.contentHash}`);
	assert.equal(ev.provenance.finalUrl, `${site.url}/widget`);
	assert.equal(ev.provenance.httpStatus, 200);
	const stored = await store.getEvent(ev.eventId);
	assert.deepEqual(stored, JSON.parse(JSON.stringify(ev)), 'event is durable');

	// 8. webhook delivered, signed, with idempotency key
	const hooks = site.requests.filter((q) => q.path === '/hook');
	assert.equal(hooks.length, 1);
	const h = hooks[0];
	const expected = 'sha256=' + createHmac('sha256', 's3cret').update(`${h.headers['x-signal-timestamp']}.${h.body}`).digest('hex');
	assert.equal(h.headers['x-signal-signature'], expected);
	assert.equal(JSON.parse(h.body).eventId, ev.eventId);
	const deliveries = await store.listDeliveries(ev.eventId);
	assert.deepEqual(deliveries.map((d) => [d.destinationId, d.status]).sort(), [['d_hook', 'delivered'], ['d_inbox', 'delivered']]);

	// 9. application-facing read + evidence + acknowledgement
	const visible = await svc.listEvents(alice, { sourceLocator: `${site.url}/widget` });
	assert.equal(visible.length, 1);
	assert.equal(visible[0].acknowledged, false);
	const evidence = await svc.getEvidence(alice, ev.eventId);
	assert.match(evidence.normalizedText, /Acme Widget/);
	assert.doesNotMatch(evidence.normalizedText, /var price/, 'scripts are not part of normalized text');
	await svc.acknowledge(alice, ev.eventId);
	assert.equal((await svc.listEvents(alice))[0].acknowledged, true);

	// 10. same condition, page re-rendered (new etag, same price) → suppressed duplicate
	site.set('/widget', { body: productPage('95.00', '<!-- ad rotation -->'), etag: '"v3"' });
	const r4 = await engine.runOnce(monitor.id);
	assert.equal(r4.evaluation!.matched, true);
	assert.equal(r4.evaluation!.outcome, 'suppressed_duplicate');
	assert.equal(r4.event, undefined);
	assert.equal(site.requests.filter((q) => q.path === '/hook').length, 1, 'no second webhook');

	// further drop while still matched → new event (on_change policy)
	site.set('/widget', { body: productPage('89.00'), etag: '"v4"' });
	const r5 = await engine.runOnce(monitor.id);
	assert.equal(r5.evaluation!.outcome, 'event_recorded');
	assert.equal(site.requests.filter((q) => q.path === '/hook').length, 2);

	// leaves the condition, then re-enters at the original matched value → alerts again
	site.set('/widget', { body: productPage('120.00'), etag: '"v5"' });
	assert.equal((await engine.runOnce(monitor.id)).evaluation!.outcome, 'no_match');
	site.set('/widget', { body: productPage('95.00'), etag: '"v6"' });
	assert.equal((await engine.runOnce(monitor.id)).evaluation!.outcome, 'event_recorded');

	// reprocessing a stored observation is idempotent: no duplicate event or notification
	const before = site.requests.filter((q) => q.path === '/hook').length;
	const re = await engine.reprocess(monitor.id, r3.observation.observationId);
	assert.equal(re.commit, 'already_committed');
	assert.equal(re.event!.eventId, ev.eventId);
	assert.equal(site.requests.filter((q) => q.path === '/hook').length, before);

	// full evaluation history is durable, including non-matches and suppressions
	const history = (await store.listEvaluations(monitor.id)).map((e) => e.outcome);
	assert.deepEqual(history, ['no_match', 'event_recorded', 'suppressed_duplicate', 'event_recorded', 'no_match', 'event_recorded']);
});

test('vertical slice: embedded Ghostpost payload through the same boundary', async (t) => {
	const { ghostpostEncoder } = await import('../src/codecs/ghostpost-unicode.ts');
	const site = await fixture();
	t.after(() => site.close());
	const post = ghostpostEncoder.encodeText('Big news coming soon!', 'Launch date: 2026-12-01');
	site.set('/robots.txt', { body: '', type: 'text/plain' });
	site.set('/feed', { body: `<html><body><article><p>${post}</p></article></body></html>` });

	const store = await tempStore();
	t.after(() => store.close());
	const svc = new SignalService(store, new LocalPolicyAuthorizer(), testNet);
	const engine = new SignalEngine({
		store, sources: { http_page: new HttpSource('http_page', testNet) },
		decoders: [new GhostpostUnicodeDecoder(), new InvisibleUnicodeDetector()],
		dispatchers: { inbox: new InboxDispatcher() }, deliveryPolicy: instantRetry
	});
	const source = await svc.registerSource(alice, { type: 'http_page', locator: `${site.url}/feed`, access: { authorization: 'public' }, observation: { strategy: 'manual' } });
	await svc.defineCriteria(alice, {
		id: 'crt_gp', name: 'Ghostpost payload mentioning launch', severity: 'info',
		condition: { signal: { codec: 'ghostpost-unicode/v1', kind: 'text', payloadContains: 'launch' } }
	});
	const m = await svc.createMonitor(alice, { sourceId: source.id, criteriaId: 'crt_gp', criteriaVersion: 1, destinations: [{ id: 'd', type: 'inbox', target: alice.subjectId }] });
	const r = await engine.runOnce(m.id);
	const gp = r.interpretation!.signals.find((s) => s.codec === 'ghostpost-unicode/v1')!;
	assert.equal(gp.payload!.text, 'Launch date: 2026-12-01');
	assert.ok(r.interpretation!.signals.some((s) => s.codec === 'invisible-unicode/v1'), 'format-agnostic detector also reports the cluster');
	assert.equal(r.evaluation!.outcome, 'event_recorded');
	assert.equal(r.event!.confidence, 1);
});
