/**
 * Universal page extraction against unfamiliar, unrelated page structures.
 * Assertions are about facts in the fixtures (which product has which price), not snapshots.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { extractPage, type PageInput } from '../../lib/page/extract.ts';
import type { PageEntity, PageRepresentation } from '../../lib/page/types.ts';
import { parseDate, parseMoney, parseMoneyRange, safeUrl } from '../../lib/page/values.ts';
import { GhostpostUnicodeDecoder, ghostpostEncoder } from '../../lib/codecs/ghostpost-unicode.ts';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/pages/${name}.html`, import.meta.url), 'utf8');
const run = (name: string, over: Partial<PageInput> = {}) => extractPage({
	html: over.html ?? fixture(name), locator: `https://site.example/${name}`, baseUrl: `https://site.example/${name}`,
	observationId: 'obs_a', contentHash: 'h', contentType: 'text/html', observedAt: '2026-11-17T12:00:00.000Z', ...over
});
const of = (r: PageRepresentation, type: string) => r.entities.filter((e) => e.type === type);
const val = (e: PageEntity, name: string) => e.attributes.find((a) => a.name === name)?.value;
const byName = (r: PageRepresentation, type: string, name: string) => of(r, type).find((e) => val(e, 'name') === name)!;
const related = (r: PageRepresentation, from: string, type: string) => r.relationships.filter((x) => x.from === from && x.type === type).map((x) => r.entities.find((e) => e.id === x.to)!);

test('product listing: each product keeps its own price, availability and seller', () => {
	const r = run('products');
	const products = of(r, 'Product');
	assert.equal(products.length, 3);
	const a = byName(r, 'Product', 'Ridgeline 2'), b = byName(r, 'Product', 'Canyon 1'), c = byName(r, 'Product', 'Basecamp 4');
	assert.deepEqual(val(a, 'price'), { amount: 249.99, currency: 'USD' });
	assert.deepEqual(val(b, 'price'), { amount: 179.99, currency: 'USD' });
	assert.equal(val(a, 'availability'), 'InStock');
	assert.equal(val(b, 'availability'), 'OutOfStock');
	assert.equal(val(c, 'availability'), 'LimitedAvailability');
	assert.equal(val(related(r, a.id, 'seller')[0], 'name'), 'Summit Supply Co.');
	assert.equal(val(related(r, b.id, 'seller')[0], 'name'), 'Valley Gear');
	assert.equal(related(r, a.id, 'seller')[0].id, related(r, c.id, 'seller')[0].id, 'one Summit Supply Co. entity, related to two products');
	const col = r.collections.find((x) => x.kind === 'repeated')!;
	assert.deepEqual(col.members, [a.id, b.id, c.id]);
	assert.equal(col.itemType, 'Product');
	assert.equal(a.classification, 'inferred', 'type from a rule, not claimed as a page fact');
	assert.match(a.typeBasis.rule, /^T2/);
	assert.deepEqual(val(a, 'image'), { url: 'https://site.example/img/ridge2.jpg', alt: 'Ridgeline 2 tent' });
	assert.equal(of(r, 'ListItem').length, 0, 'navigation menus are not content');
});

test('job listing: employer, location, compensation range and requirements per job', () => {
	const r = run('job');
	const jobs = of(r, 'JobPosting');
	assert.equal(jobs.length, 2);
	const pm = byName(r, 'JobPosting', 'Senior AI Product Manager');
	assert.deepEqual(val(pm, 'compensation'), { min: 165000, max: 195000, currency: 'USD', period: 'year' });
	assert.equal(val(pm, 'location'), 'Remote (US)');
	assert.equal(val(pm, 'date'), '2026-11-02');
	assert.match(String(val(pm, 'requirements')), /ML platform/);
	assert.equal(val(related(r, pm.id, 'hiringOrganization')[0], 'name'), 'Lumen Analytics');
	const de = byName(r, 'JobPosting', 'Data Engineer');
	assert.deepEqual(val(de, 'compensation'), { min: 120000, max: 140000, currency: 'USD', period: 'year' });
	assert.equal(related(r, pm.id, 'hiringOrganization')[0].id, related(r, de.id, 'hiringOrganization')[0].id);
});

test('article: title, author (as a related person), publication date, body; OpenGraph on the page', () => {
	const r = run('article');
	const [art] = of(r, 'Article');
	assert.equal(val(art, 'name'), 'The quiet return of the night train');
	assert.equal(val(art, 'date'), '2026-11-10T08:00:00.000Z');
	assert.equal(val(related(r, art.id, 'author')[0], 'name'), 'Ines Albrecht');
	assert.match(String(val(art, 'description')), /overnight rail routes/);
	const page = of(r, 'WebPage')[0];
	assert.equal(val(page, 'datePublished'), '2026-11-10T08:00:00.000Z');
	assert.equal(page.attributes.find((a) => a.name === 'datePublished')!.method, 'opengraph');
});

test('discussion: posts, replies linked to the post they answer, authors, timestamps', () => {
	const r = run('discussion');
	const posts = of(r, 'SocialMediaPosting'), comments = of(r, 'Comment');
	assert.equal(posts.length, 2);
	assert.equal(comments.length, 2);
	const author = (e: PageEntity) => val(related(r, e.id, 'author')[0], 'name');
	const p1 = posts.find((p) => author(p) === 'trailnewbie')!;
	for (const c of comments) assert.deepEqual(related(r, c.id, 'inReplyTo').map((x) => x.id), [p1.id], 'reply → its parent post');
	assert.deepEqual(comments.map(author).sort(), ['mossyboots', 'ridgewalker']);
	assert.equal(val(p1, 'date'), '2026-11-15T10:00:00.000Z', 'machine datetime preferred over "2 days ago"');
	assert.ok(r.collections.some((c) => c.kind === 'thread' && c.itemType === 'Comment'));
	assert.ok(!r.relationships.some((x) => x.type === 'hasPart' && comments.some((c) => c.id === x.to)), 'replies are not top-level parts of the page');
});

test('table: repeated records keyed by header; ambiguous dates are kept as candidates, not guessed', () => {
	const r = run('table');
	const rows = of(r, 'TableRow');
	assert.equal(rows.length, 3);
	const airport = byName(r, 'TableRow', 'Airport Rd');
	assert.deepEqual(val(airport, 'price'), { amount: 3.89, currency: 'USD' });
	const d = airport.attributes.find((a) => a.name === 'date')!;
	assert.equal(d.value, null);
	assert.equal(d.ambiguity!.reason, 'format');
	assert.deepEqual(d.ambiguity!.candidates.map((c) => c.value).sort(), ['2026-03-04', '2026-04-03']);
	assert.equal(val(byName(r, 'TableRow', 'Riverside'), 'date'), '2026-11-16');
	const col = r.collections.find((c) => c.kind === 'table')!;
	assert.equal(col.name, 'Fuel prices by station');
	assert.equal(of(r, 'Product').length, 0, 'a price alone does not make a product');
});

test('JSON-LD vs visible content: both kept, linked, and the conflicts made explicit', () => {
	const r = run('jsonld-conflict');
	const declared = of(r, 'Product').find((e) => e.classification === 'declared')!;
	const visible = of(r, 'Product').find((e) => e.classification !== 'declared')!;
	assert.ok(declared && visible);
	const [offer] = related(r, declared.id, 'offers');
	assert.deepEqual(val(offer, 'price'), { amount: 39.95, currency: 'USD' });
	assert.equal(val(related(r, offer.id, 'seller')[0], 'name'), 'Lumo Direct');
	assert.equal(val(related(r, declared.id, 'brand')[0], 'name'), 'Lumo');
	assert.deepEqual(val(visible, 'price'), { amount: 44.95, currency: 'USD' });
	const same = r.relationships.find((x) => x.type === 'sameAs')!;
	assert.deepEqual(same.conflicts!.map((c) => c.attribute).sort(), ['availability', 'price']);
	assert.equal(visible.attributes.find((a) => a.name === 'price')!.ambiguity!.reason, 'conflict');
	assert.ok(r.signals.some((s) => s.codec === 'page-structure/v1' && s.kind === 'json_ld_invalid' && !s.ok), 'invalid JSON-LD reported, not silently skipped');
});

test('unknown structures stay representable; nothing visible is silently dropped', () => {
	const r = run('unknown');
	const unknown = of(r, 'Unknown');
	assert.equal(unknown.length, 3);
	assert.ok(unknown.every((e) => e.classification === 'unknown'));
	assert.deepEqual(unknown.map((e) => val(e, 'v')), ['M31', 'NGC 7000', 'M42']);
	assert.ok(r.collections.some((c) => c.itemType === 'Unknown' && c.members.length === 3));
	const page = of(r, 'WebPage')[0];
	assert.ok(page.attributes.some((a) => a.name === 'text' && /4\.2e-13/.test(String(a.value))), 'unclassified block retained on the page');
	assert.doesNotMatch(JSON.stringify(r), /javascript:/i, 'javascript: URLs are not retained as links');
});

test('dynamic page, static fetch: only the server-sent shell is visible (no script execution)', () => {
	const r = run('dynamic');
	assert.equal(of(r, 'Product').length, 0);
	assert.doesNotMatch(JSON.stringify(r), /Trail Stove/, 'script source is never treated as content');
});

test('every attribute is traceable to evidence that resolves to the source element', () => {
	for (const name of ['products', 'job', 'article', 'discussion', 'table', 'jsonld-conflict', 'unknown']) {
		const r = run(name);
		const $ = load(fixture(name));
		const ev = new Map(r.evidence.map((e) => [e.id, e]));
		for (const e of r.entities) {
			assert.ok(e.evidenceRefs.length > 0, `${name}: entity ${e.id} has evidence`);
			for (const a of e.attributes) {
				assert.ok(a.evidenceRefs.length > 0, `${name}: ${e.type}.${a.name} has evidence`);
				for (const ref of a.evidenceRefs) {
					const x = ev.get(ref);
					assert.ok(x, `${name}: evidence ${ref} exists`);
					const el = $(x!.locator.replace(/>/g, ' > '));
					assert.equal(el.length, 1, `${name}: locator ${x!.locator} resolves to exactly one element`);
					if (a.method === 'json-ld') assert.ok(x!.pointer, 'json-ld evidence carries a JSON pointer');
				}
				assert.ok(['observed', 'normalized', 'inferred'].includes(a.provenance));
			}
		}
		for (const rel of r.relationships) assert.ok(rel.evidenceRefs.every((x) => ev.has(x)), `${name}: relationship evidence`);
	}
});

test('deterministic: identical input ⇒ identical representation; a change moves only what changed', () => {
	const a = run('products'), b = run('products');
	assert.equal(JSON.stringify(a), JSON.stringify(b));
	const c = run('products', { observationId: 'obs_b', observedAt: '2026-12-01T00:00:00.000Z' });
	assert.equal(c.revision, a.revision, 'revision independent of which observation saw it');
	const changed = run('products', { html: fixture('products').replace('$179.99', '$159.99') });
	assert.notEqual(changed.revision, a.revision);
	const ids = (r: PageRepresentation) => of(r, 'Product').map((e) => e.id);
	assert.deepEqual(ids(changed), ids(a), 'entity identities are stable across content changes');
	assert.deepEqual(val(byName(changed, 'Product', 'Canyon 1'), 'price'), { amount: 159.99, currency: 'USD' });
});

test('security: no secrets, no form values, no executable URLs; bounded work', () => {
	const r = run('products');
	const s = JSON.stringify(r);
	assert.doesNotMatch(s, /SECRET-CSRF-123/, 'csrf meta never copied');
	assert.doesNotMatch(s, /hunter2/, 'form values never read');
	assert.doesNotMatch(s, /abc123/, 'session query parameter redacted');
	assert.match(s, /session=REDACTED/);
	assert.ok(r.signals.some((x) => x.codec === 'page-access/v1' && x.kind === 'login_form'));
	assert.equal(safeUrl('javascript:alert(1)', 'https://a.example/'), null);
	assert.equal(safeUrl('/x?token=abc&utm_source=y&b=1', 'https://a.example/'), 'https://a.example/x?b=1&token=REDACTED');
	const bounded = run('products', { limits: { maxEntities: 2 } });
	assert.equal(bounded.entities.length, 2);
	assert.equal(bounded.stats.truncated, true);
	const huge = '<html><body>' + '<div class="row"><b>x</b><i>$1</i></div>'.repeat(30000) + '</body></html>';
	const t = performance.now();
	const big = run('products', { html: huge });
	assert.equal(big.stats.truncated, true);
	assert.ok(performance.now() - t < 20000, 'bounded');
});

test('Ghostpost is a specialized interpreter: a typed signal with evidence, independent of extraction', () => {
	const post = ghostpostEncoder.encodeText('Big news soon', 'Launch date: 2026-12-01');
	const html = `<html><body><article><h2>Update</h2><p>${post}</p></article></body></html>`;
	const plain = run('x', { html });
	assert.equal(plain.signals.filter((s) => s.codec === 'ghostpost-unicode/v1').length, 0, 'no decoder injected → no codec dependency');
	const r = run('x', { html, decoders: [new GhostpostUnicodeDecoder()] });
	const [sig] = r.signals.filter((s) => s.codec === 'ghostpost-unicode/v1');
	assert.equal(sig.payload!.text, 'Launch date: 2026-12-01');
	const ev = r.evidence.find((e) => e.id === sig.evidenceRefs[0])!;
	assert.equal(ev.element, 'p');
	assert.ok(of(r, 'Article').length === 1, 'the page is still represented normally');
});

test('value typing: money, ranges, dates (relative dates inferred, never claimed as observed)', () => {
	assert.deepEqual(parseMoney('Now €1.299,00'), { amount: 1299, currency: 'EUR' });
	assert.deepEqual(parseMoney('USD 45'), { amount: 45, currency: 'USD' });
	assert.deepEqual(parseMoneyRange('$80k – $95k a year'), { min: 80000, max: 95000, currency: 'USD', period: 'year' });
	assert.equal(parseMoneyRange('pages 10 - 20'), null, 'numbers without a currency are not money');
	const rel = parseDate('3 hours ago', '2026-11-17T12:00:00.000Z')!;
	assert.equal(rel.value, '2026-11-17T09:00:00.000Z');
	assert.equal(rel.provenance, 'inferred');
	assert.equal(rel.ambiguity!.reason, 'relative');
	assert.equal(parseDate('31/02/2026', '2026-11-17T12:00:00Z'), null, 'impossible dates rejected');
	assert.equal(parseDate('13/02/2026', '2026-11-17T12:00:00Z')!.value, '2026-02-13', 'only one valid reading ⇒ not ambiguous');
});
