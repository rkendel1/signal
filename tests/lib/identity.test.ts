/**
 * Identity and change detection on a real page structure (books.toscrape.com catalog, retained
 * fixture) and controlled edits of it. Identity must not depend on visible text alone, DOM position
 * or list order; where it cannot be established, uncertainty is represented, not invented continuity.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { extractPage } from '../../lib/page/extract.ts';
import type { PageRepresentation } from '../../lib/page/types.ts';
import { pageToDrafts } from '../../lib/sources/page.ts';
import { planIngestion } from '../../lib/engine/identity.ts';
import { draftHash } from '../../lib/engine/mapping.ts';

/** What a capture of `after` tells Signal relative to a capture of `before` (the ingestion path every capture takes). */
function changes(after: PageRepresentation, before: PageRepresentation, mode: 'snapshot' | 'partial' = 'snapshot') {
	const d = (r: PageRepresentation) => pageToDrafts(r, { entityType: 'book', pageTypes: ['Product'] }).drafts;
	const prev = d(before).map((x) => ({ recordKey: x.recordKey, contentHash: draftHash(x), version: 1 }));
	const plan = planIngestion(prev, d(after).map((x) => ({ draft: x, hash: draftHash(x) })), mode);
	const name = (x: { attributes: Record<string, { value: unknown }> }) => String(x.attributes.name?.value ?? '');
	return {
		added: plan.added.map(name), changed: plan.changed.map((c) => ({ name: name(c.draft), draft: c.draft, before: d(before).find((b) => b.recordKey === c.draft.recordKey)! })),
		retracted: plan.retracted.map((r) => name(d(before).find((b) => b.recordKey === r.recordKey)!)), skipped: pageToDrafts(after, { entityType: 'book', pageTypes: ['Product'] }).skipped,
	};
}

const real = readFileSync(new URL('../fixtures/real/books-catalog.html', import.meta.url), 'utf8');
const m5 = readFileSync(new URL('../fixtures/pages/products.html', import.meta.url), 'utf8');
const rep = (html: string, obs = 'o1') => extractPage({ html, locator: 'https://books.toscrape.com/', baseUrl: 'https://books.toscrape.com/', observationId: obs, contentHash: 'h', contentType: 'text/html', observedAt: '2026-11-17T12:00:00.000Z' });
const products = (r: PageRepresentation) => r.entities.filter((e) => e.type === 'Product');
const byName = (r: PageRepresentation, n: string) => products(r).find((e) => String(e.attributes.find((a) => a.name === 'name')?.value).startsWith(n))!;
const edit = (html: string, f: ($: ReturnType<typeof load>) => void) => { const $ = load(html); f($); return $.html(); };
const base = rep(real);

test('real catalog identities are strong (source URLs), not text or position', () => {
	assert.equal(products(base).length, 20);
	for (const p of products(base)) {
		assert.equal(p.identity.basis, 'url');
		assert.equal(p.identity.strength, 'strong');
		assert.equal(p.identity.ambiguous, undefined);
	}
});

test('price change: same entity, new digest, detected as a change with previous value', () => {
	const after = rep(real.replace('£51.77', '£45.00'), 'o2');
	const a = byName(base, 'A Light in the'), b = byName(after, 'A Light in the');
	assert.equal(a.id, b.id);
	assert.notEqual(a.digest, b.digest);
	assert.notEqual(after.factsRevision, base.factsRevision);
	const c = changes(after, base);
	assert.equal(c.changed.length, 1);
	assert.deepEqual(c.changed[0].before.attributes.price.value, { amount: 51.77, currency: 'GBP' });
	assert.deepEqual(c.changed[0].draft.attributes.price.value, { amount: 45, currency: 'GBP' });
});

test('availability change on an existing listing', () => {
	const after = rep(edit(real, ($) => { $('article.product_pod').eq(2).find('.availability').html('<i class="icon-remove"></i> Out of stock'); }), 'o2');
	const c = changes(after, base);
	assert.equal(c.changed.length, 1);
	assert.equal(c.changed[0].draft.attributes.availability.value, 'OutOfStock');
});

test('seller change: relationship target changes, entity identity does not', () => {
	const before = rep(m5), after = rep(m5.replace('Sold by: Valley Gear', 'Sold by: Granite Outfitters'), 'o2');
	const seller = (r: PageRepresentation) => r.relationships.filter((x) => x.type === 'seller').map((x) => [x.from, r.entities.find((e) => e.id === x.to)?.attributes.find((a) => a.name === 'name')?.value]);
	assert.deepEqual(seller(after).map((x) => x[0]), seller(before).map((x) => x[0]), 'same products');
	assert.ok(seller(before).some((x) => x[1] === 'Valley Gear') && seller(after).some((x) => x[1] === 'Granite Outfitters'));
});

test('new listing appears, a listing disappears', () => {
	const added = rep(edit(real, ($) => { const c = $('article.product_pod').last().parent().clone(); c.find('h3 a').attr('href', 'catalogue/new-book_9999/index.html').attr('title', 'A Brand New Book').text('A Brand New Book'); $('ol.row').append(c); }), 'o2');
	assert.deepEqual(changes(added, base).added, ['A Brand New Book']);
	const removed = rep(edit(real, ($) => { $('article.product_pod').eq(0).parent().remove(); }), 'o2');
	assert.equal(changes(removed, base, 'partial').retracted.length, 0, 'a capture is partial: absence is not removal');
	const r = changes(removed, base, 'snapshot').retracted;
	assert.equal(r.length, 1);
	assert.match(r[0], /^A Light in the/);
});

test('reordering and a layout-only change keep identities and facts', () => {
	const reordered = rep(edit(real, ($) => { const ol = $('ol.row'); const items = ol.children('li').toArray().reverse(); ol.empty(); for (const li of items) ol.append(li); }), 'o2');
	assert.deepEqual(products(reordered).map((e) => e.id).sort(), products(base).map((e) => e.id).sort());
	assert.equal(reordered.factsRevision, base.factsRevision, 'facts unchanged by order');
	const c = changes(reordered, base);
	assert.deepEqual([c.added.length, c.changed.length, c.retracted.length], [0, 0, 0], 'reordering is not new information');
	const relayout = rep(edit(real, ($) => { $('article.product_pod').each((_, a) => { $(a).attr('class', 'book-tile'); $(a).wrap('<div class="tile-wrap"></div>'); }); }), 'o3');
	assert.notEqual(relayout.revision, base.revision, 'the document changed');
	assert.equal(relayout.factsRevision, base.factsRevision, 'the facts did not');
	assert.deepEqual(products(relayout).map((e) => e.id).sort(), products(base).map((e) => e.id).sort());
});

test('one item shown by two cards is one entity with two occurrences', () => {
	const dup = rep(edit(real, ($) => { $('ol.row').append($('article.product_pod').first().parent().clone()); }), 'o2');
	assert.equal(products(dup).length, 20);
	const e = byName(dup, 'A Light in the');
	assert.equal(e.identity.occurrences, 2);
	assert.ok(e.evidenceRefs.length >= 2);
	assert.equal(changes(dup, base).added.length, 0);
});

test('an entity moving between collections keeps its identity', () => {
	// Real catalog split into two lists ("Featured" + the rest); a different set of books is featured later.
	const split = (featured: number[]) => edit(real, ($) => {
		const items = $('ol.row').children('li').toArray();
		const fol = $('<ol class="row featured" aria-label="Featured"></ol>');
		$('ol.row').first().before(fol);
		for (const i of featured) fol.append(items[i]);
	});
	const before = rep(split([0, 1, 2, 3, 4])), after = rep(split([5, 6, 7, 8, 9]), 'o2');
	const ids = (r: PageRepresentation) => products(r).map((e) => e.id).sort();
	assert.deepEqual(ids(after), ids(before));
	const c = changes(after, before);
	assert.deepEqual([c.added.length, c.retracted.length], [0, 0]);
	const featuredOf = (r: PageRepresentation) => r.collections.filter((c) => c.name === 'Featured').flatMap((c) => c.members).sort();
	assert.equal(featuredOf(before).length, 5);
	assert.notDeepEqual(featuredOf(after), featuredOf(before), 'membership changed, identities did not');
});

test('similar names: distinct URLs stay distinct; name-only lookalikes are marked ambiguous, never merged or tracked', () => {
	const twins = rep(edit(real, ($) => { const c = $('article.product_pod').first().parent().clone(); c.find('h3 a').attr('href', 'catalogue/a-light-in-the-attic-paperback_2000/index.html'); $('ol.row').append(c); }), 'o2');
	const lights = products(twins).filter((e) => String(e.attributes.find((a) => a.name === 'name')?.value).startsWith('A Light in the'));
	assert.equal(lights.length, 2, 'same title, different source URLs ⇒ two entities');
	assert.ok(lights.every((e) => e.identity.strength === 'strong' && !e.identity.ambiguous));
	const noUrl = (html: string) => html.replace(/<a href="[^"]*"/g, '<a').replace(/<img src="[^"]*"/g, '<img');
	const plain = (h: string, o: string) => rep(noUrl(h), o);
	const twinsNoUrl = edit(m5, ($) => { $('.grid').append($('.card').eq(1).clone().attr('class', 'card c4')); });
	const p1 = plain(twinsNoUrl, 'o1');
	const canyons = products(p1).filter((e) => e.attributes.some((a) => a.name === 'name' && a.value === 'Canyon 1'));
	assert.equal(canyons.length, 2);
	assert.ok(canyons.every((e) => e.identity.ambiguous === true && e.identity.strength === 'weak'));
	assert.ok(p1.relationships.some((r) => r.type === 'possiblySameAs' && r.classification === 'unknown'));
	const p2 = plain(twinsNoUrl.replace('$179.99', '$169.99'), 'o2');
	const c = changes(p2, p1);
	assert.ok(!c.changed.some((x) => x.name === 'Canyon 1'), 'no invented continuity');
	assert.ok(c.skipped.some((x) => /same name/.test(x.reason)), 'ambiguous lookalikes are not observed as records at all');
});
