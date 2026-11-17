/**
 * Ground truth for the real-world evaluation, written WITHOUT the extractor under test.
 *
 * Each labeller below uses site-specific selectors chosen by reading the page source
 * (an oracle), plus hand-entered facts. It imports nothing from lib/page. Output:
 * tests/fixtures/real/labels/<id>.json. Labels were committed before the extractor
 * was run on these pages (see git history).
 *
 * Label format:
 *   entities[]: { match: {attr, value}, acceptTypes[], attributes: { <label>: { paths[], value, compare, accessible? } },
 *                 relationships[]: { types[], to: {attr, value} } }
 *   compare: 'text' (case/space-insensitive equality) | 'prefix' (extracted may be a truncation, ≥ 8 chars)
 *            | 'contains' | 'number' | 'money' | 'date' (YYYY-MM-DD prefix) | 'availability'
 *   accessible: false marks facts the page shows only visually (e.g. stars as CSS classes).
 */
import { load } from 'cheerio';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const dir = new URL('../tests/fixtures/real/', import.meta.url);
mkdirSync(new URL('labels/', dir), { recursive: true });
const html = (id: string) => load(readFileSync(new URL(`${id}.html`, dir), 'utf8'));
const t = (s: string) => s.replace(/\s+/g, ' ').trim();
type Attr = { paths: string[]; value: unknown; compare: string; accessible?: boolean };
type Ent = { match: { attr: string; value: string; compare?: string }; acceptTypes: string[]; attributes: Record<string, Attr>; relationships?: Array<{ types: string[]; to: { attr: string; value: string } }> };
const save = (id: string, category: string, entities: Ent[], notes: string[], extra: Record<string, unknown> = {}) => {
	writeFileSync(new URL(`labels/${id}.json`, dir), JSON.stringify({ id, category, labeledWith: 'scripts/label-real-pages.ts (site-specific oracle; independent of lib/page)', notes, ...extra, entities }, null, 1) + '\n');
	console.log(id, entities.length);
};
const STARS: Record<string, number> = { One: 1, Two: 2, Three: 3, Four: 4, Five: 5 };
const PRICE = ['price', 'offers.price'];
const AVAIL = ['availability', 'offers.availability'];

// 1. books.toscrape catalog
{
	const $ = html('books-catalog');
	const ents: Ent[] = $('article.product_pod').toArray().map((el) => {
		const a = $(el).find('h3 a');
		const price = t($(el).find('.price_color').text()).replace('£', '');
		const stars = ($(el).find('.star-rating').attr('class') ?? '').split(' ')[1];
		return {
			match: { attr: 'name', value: a.attr('title')!, compare: 'prefix' }, acceptTypes: ['Product', 'Book'],
			attributes: {
				price: { paths: PRICE, value: { amount: Number(price), currency: 'GBP' }, compare: 'money' },
				availability: { paths: AVAIL, value: 'InStock', compare: 'availability' },
				rating: { paths: ['rating', 'ratingValue', 'aggregateRating.ratingValue'], value: STARS[stars], compare: 'number', accessible: false },
				url: { paths: ['url'], value: a.attr('href'), compare: 'contains' }
			}
		};
	});
	save('books-catalog', 'product_listing', ents, ['Visible titles are truncated ("A Light in the ..."); the full title is in the link title attribute.', 'Star ratings exist only as CSS classes (star-rating Three) — not accessible text.']);
}

// 2. books.toscrape detail
{
	const $ = html('books-detail');
	const row = (h: string) => t($(`th:contains("${h}")`).next('td').text());
	save('books-detail', 'product_detail', [{
		match: { attr: 'name', value: t($('.product_main h1').text()) }, acceptTypes: ['Product', 'Book'],
		attributes: {
			price: { paths: [...PRICE, 'price_incl_tax', 'price_excl_tax'], value: { amount: Number(row('Price (incl. tax)').replace('£', '')), currency: 'GBP' }, compare: 'money' },
			availability: { paths: AVAIL, value: 'InStock', compare: 'availability' },
			sku: { paths: ['sku', 'upc', 'gtin'], value: row('UPC'), compare: 'text' },
			reviews: { paths: ['number_of_reviews', 'reviewCount', 'aggregateRating.reviewCount'], value: Number(row('Number of reviews')), compare: 'number' },
			rating: { paths: ['rating', 'ratingValue', 'aggregateRating.ratingValue'], value: STARS[($('.product_main .star-rating').attr('class') ?? '').split(' ')[1]], compare: 'number', accessible: false },
			description: { paths: ['description'], value: t($('#product_description').next('p').text()).slice(0, 40), compare: 'contains' }
		}
	}], ['Product facts are a two-column table (UPC, prices, availability, reviews).']);
}

// 3. webscraper.io laptops (microdata)
{
	const $ = html('webscraper-laptops');
	const ents: Ent[] = $('[itemtype="https://schema.org/Product"]').toArray().map((el) => ({
		match: { attr: 'name', value: $(el).find('a.title').attr('title')! }, acceptTypes: ['Product'],
		attributes: {
			price: { paths: PRICE, value: { amount: Number(t($(el).find('[itemprop=price]').text()).replace('$', '')), currency: 'USD' }, compare: 'money' },
			description: { paths: ['description'], value: t($(el).find('[itemprop=description]').text()).slice(0, 30), compare: 'contains' },
			reviews: { paths: ['reviewCount', 'aggregateRating.reviewCount'], value: Number(t($(el).find('[itemprop=reviewCount]').text())), compare: 'number' },
			rating: { paths: ['rating', 'ratingValue', 'aggregateRating.ratingValue'], value: Number($(el).find('[data-rating]').attr('data-rating')), compare: 'number', accessible: false }
		}
	}));
	save('webscraper-laptops', 'product_listing', ents, ['Microdata puts itemprop="name" on an <a>; by the HTML microdata rules its value is the href, not the title. The full name is in the title attribute; visible text is truncated.', 'Rating exists only as a data-rating attribute and star icons.']);
}

// 4. fake jobs
{
	const $ = html('fake-jobs');
	const ents: Ent[] = $('.card-content').toArray().map((el) => ({
		match: { attr: 'name', value: t($(el).find('h2.title').text()) }, acceptTypes: ['JobPosting'],
		attributes: {
			location: { paths: ['location', 'jobLocation.name', 'jobLocation.address'], value: t($(el).find('.location').text()), compare: 'text' },
			date: { paths: ['date', 'datePosted'], value: $(el).find('time').attr('datetime'), compare: 'date' },
			url: { paths: ['url'], value: $(el).find('a:contains("Apply")').attr('href'), compare: 'contains' }
		},
		relationships: [{ types: ['hiringOrganization'], to: { attr: 'name', value: t($(el).find('h3.company').text()) } }]
	}));
	save('fake-jobs', 'job_listing', ents, ['Job titles repeat across cards (e.g. several "Senior Python Developer"); identity must not merge them.', 'Company is a styled subtitle (h3.company) without a label.']);
}

// 5. quotes
{
	const $ = html('quotes');
	const ents: Ent[] = $('.quote').toArray().map((el) => ({
		match: { attr: 'text', value: t($(el).find('.text').text()).slice(1, 41), compare: 'contains' }, acceptTypes: ['CreativeWork', 'Quotation', 'SocialMediaPosting', 'Article'],
		attributes: { keywords: { paths: ['keywords'], value: $(el).find('meta.keywords').attr('content') ?? '', compare: 'text' } },
		relationships: [{ types: ['author'], to: { attr: 'name', value: t($(el).find('.author').text()) } }]
	}));
	save('quotes', 'posts_with_authors', ents, ['Microdata CreativeWork with itemprop text/author/keywords; author is a plain text property (not an itemscope).'], { relationshipNote: 'author may be represented either as a relationship or as an author attribute; both are accepted' });
}

// 6. Wikipedia article (JSON-LD parsed directly)
{
	const $ = html('wiki-night-train');
	const ld = JSON.parse($('script[type="application/ld+json"]').first().text());
	save('wiki-night-train', 'article', [{
		match: { attr: 'name', value: ld.name }, acceptTypes: ['Article'],
		attributes: {
			url: { paths: ['url'], value: 'wikipedia.org/wiki/Night_Train', compare: 'contains' },
			datePublished: { paths: ['datePublished', 'date'], value: String(ld.datePublished).slice(0, 10), compare: 'date' },
			dateModified: { paths: ['dateModified'], value: String(ld.dateModified).slice(0, 10), compare: 'date' }
		},
		relationships: [{ types: ['author'], to: { attr: 'name', value: ld.author.name } }, { types: ['publisher'], to: { attr: 'name', value: ld.publisher.name } }]
	}], ['Facts from the page JSON-LD; the visible title is h1#firstHeading.'], { pageAttributes: { title: { value: t($('title').text()), compare: 'text' } } });
}

// 7. Wikipedia population table
{
	const $ = html('wiki-population');
	const table = $('table.wikitable').first();
	const headers = table.find('tr').first().find('th').toArray().map((h) => t($(h).text()));
	const iLoc = headers.findIndex((h) => /location/i.test(h)), iPop = headers.findIndex((h) => /^population/i.test(h));
	const ents: Ent[] = [];
	table.find('tr').slice(1).each((_, tr) => {
		const cells = $(tr).children('td,th').toArray();
		if (cells.length < Math.max(iLoc, iPop) + 1) return;
		const loc = t($(cells[iLoc]).text()).replace(/\[[^\]]*\]/g, '').trim();
		const pop = Number(t($(cells[iPop]).text()).replace(/[^\d]/g, ''));
		if (!loc || !pop) return;
		ents.push({ match: { attr: 'name', value: loc }, acceptTypes: ['TableRow', 'Place', 'Country'], attributes: { population: { paths: ['population'], value: pop, compare: 'number' } } });
	});
	save('wiki-population', 'data_table', ents, [`${ents.length} body rows of the first wikitable; footnote markers stripped from names.`, 'The first row is the World total.']);
}

// 8. arXiv abstract (citation_* meta tags)
{
	const $ = html('arxiv-abs');
	const m = (n: string) => $(`meta[name="${n}"]`).toArray().map((x) => $(x).attr('content')!);
	save('arxiv-abs', 'research_publication', [{
		match: { attr: 'name', value: m('citation_title')[0] }, acceptTypes: ['ScholarlyArticle', 'Article', 'CreativeWork', 'WebPage'],
		attributes: {
			datePublished: { paths: ['datePublished', 'date', 'citation_date'], value: m('citation_date')[0].replace(/\//g, '-'), compare: 'date' },
			identifier: { paths: ['identifier', 'citation_arxiv_id', 'sku'], value: m('citation_arxiv_id')[0], compare: 'text' }
		},
		relationships: m('citation_author').map((a) => ({ types: ['author'], to: { attr: 'name', value: a } }))
	}], ['Bibliographic facts are in Highwire Press citation_* meta tags; no JSON-LD.', 'Abstract text removed for retention (license).']);
}

// 9. Hacker News item (sanitized)
{
	const $ = html('hn-item');
	const story = { match: { attr: 'name', value: t($('.titleline a').first().text()) }, acceptTypes: ["SocialMediaPosting", "DiscussionForumPosting", "Article"], attributes: {
		score: { paths: ['score', 'points', 'upvoteCount'], value: Number(t($('.score').text()).replace(/\D/g, '')), compare: 'number' },
		date: { paths: ['date', 'datePublished'], value: ($('.subline .age').attr('title') ?? '').slice(0, 10), compare: 'date' }
	}, relationships: [{ types: ['author'], to: { attr: 'name', value: t($('.subline a[href^="user?id="]').text()) } }] } as Ent;
	const rows = $('tr.athing.comtr').toArray().map((tr) => ({ id: $(tr).attr('id')!, indent: Number($(tr).find('td.ind').attr('indent')), user: t($(tr).find('.comhead a[href^="user?id="]').first().text()), date: ($(tr).find('.age').attr('title') ?? '').slice(0, 10) }));
	const comments: Ent[] = rows.map((r, i) => {
		const parent = r.indent === 0 ? null : [...rows.slice(0, i)].reverse().find((x) => x.indent === r.indent - 1)!;
		return {
			match: { attr: 'author', value: r.user }, acceptTypes: ['Comment', 'SocialMediaPosting', 'DiscussionForumPosting'],
			attributes: { date: { paths: ['date', 'dateCreated', 'datePublished'], value: r.date, compare: 'date' } },
			relationships: [{ types: ['inReplyTo', 'isPartOf'], to: parent ? { attr: 'author', value: parent.user } : { attr: 'name', value: 'Y Combinator' } }]
		};
	});
	save('hn-item', 'discussion', [story, ...comments], ['Reply nesting is expressed by td.ind[indent] in flat table rows, not by DOM nesting.', 'Usernames replaced (user1..3) and comment bodies removed during sanitization.']);
}

// 10. usa.gov agency directory
{
	const $ = html('usagov-agencies');
	const ents: Ent[] = $('h2.usa-accordion__heading button.usa-accordion__button[data-agency-name]').toArray().map((b) => {
		const panel = $(`[id="${$(b).attr("aria-controls")}"]`);
		const site = panel.find('.field--name-field-website a').attr('href');
		const phone = t(panel.find('.field--name-field-phone-number').first().text());
		return {
			match: { attr: 'name', value: t($(b).text()) }, acceptTypes: ['Organization', 'GovernmentOrganization'],
			attributes: {
				...(site ? { url: { paths: ['url', 'website'], value: site, compare: 'contains' } } : {}),
				...(phone ? { telephone: { paths: ['telephone', 'phone_number', 'phone'], value: phone, compare: 'text' } } : {})
			}
		};
	});
	save('usagov-agencies', 'directory', ents, ['Each agency is an accordion button + a panel with hidden="until-found" (collapsed but findable and expandable by the user — accessible information).', 'Fields are "Label:" paragraphs (Website, Phone number, Contact).']);
}

// ================================================================== HELD-OUT pages (labelled before any evaluation)

// 11. scrapethissite countries (250 cards)
{
	const $ = html('heldout-countries');
	const ents: Ent[] = $('.country').toArray().map((el) => ({
		match: { attr: 'name', value: t($(el).find('.country-name').text()) }, acceptTypes: ['Country', 'Place', 'Unknown', 'Organization'],
		attributes: {
			capital: { paths: ['capital'], value: t($(el).find('.country-capital').text()), compare: 'text' },
			population: { paths: ['population'], value: Number(t($(el).find('.country-population').text())), compare: 'number' },
			area: { paths: ['area', 'area_km2', 'area_km'], value: Number(t($(el).find('.country-area').text())), compare: 'number' }
		}
	}));
	save('heldout-countries', 'directory', ents, ['Fields are <strong>Label:</strong> followed by a span value.', 'No type cue exists on the page beyond the heading; Unknown is an acceptable type.']);
}

// 12. scrapethissite hockey table (class-named cells, empty <th> header)
{
	const $ = html('heldout-hockey');
	const ents: Ent[] = $('tr.team').toArray().map((tr) => ({
		match: { attr: 'name', value: t($(tr).find('.name').text()) }, acceptTypes: ['TableRow', 'SportsTeam', 'Unknown'],
		attributes: {
			year: { paths: ['year'], value: Number(t($(tr).find('.year').text())), compare: 'number' },
			wins: { paths: ['wins'], value: Number(t($(tr).find('.wins').text())), compare: 'number' },
			losses: { paths: ['losses'], value: Number(t($(tr).find('.losses').text())), compare: 'number' }
		}
	}));
	save('heldout-hockey', 'data_table', ents, ['Header cells are present but their text is in nested links/whitespace; cells carry class names (name, year, wins).', 'Team names repeat (one row per season).']);
}

// 13. webscraper.io tables (two Bootstrap tables)
{
	const $ = html('heldout-wstables');
	const ents: Ent[] = [];
	$('table').each((_, tb) => {
		const heads = $(tb).find('thead th').toArray().map((x) => t($(x).text()));
		$(tb).find('tbody tr').each((__, tr) => {
			const c = $(tr).children('td').toArray().map((x) => t($(x).text()));
			const iu = heads.indexOf('Username'), fi = heads.indexOf('First Name'), li = heads.indexOf('Last Name');
			if (iu < 0 || !c[iu]) return;
			ents.push({ match: { attr: 'username', value: c[iu] }, acceptTypes: ['TableRow', 'Person', 'Unknown'], attributes: {
				first_name: { paths: ['first_name', 'givenName'], value: c[fi], compare: 'text' },
				last_name: { paths: ['last_name', 'familyName'], value: c[li], compare: 'text' }
			} });
		});
	});
	save('heldout-wstables', 'data_table', ents, ['Usernames repeat across the two tables.']);
}

// 14. python.org events
{
	const $ = html('heldout-pyevents');
	const ents: Ent[] = $('.list-recent-events li').toArray().map((li) => ({
		match: { attr: 'name', value: t($(li).find('.event-title a').text()) }, acceptTypes: ['Event', 'Unknown', 'Article', 'ListItem'],
		attributes: {
			startDate: { paths: ['startDate', 'date'], value: ($(li).find('time').attr('datetime') ?? '').slice(0, 10), compare: 'date' },
			location: { paths: ['location'], value: t($(li).find('.event-location').text()), compare: 'text' },
			url: { paths: ['url'], value: $(li).find('.event-title a').attr('href'), compare: 'contains' }
		}
	}));
	save('heldout-pyevents', 'event_listing', ents, ['Dates are a <time datetime> with split visible text; location is a class-named span with no label.']);
}

// 15. PyPI project page
{
	const $ = html('heldout-pypi');
	const title = t($('h1').first().text());
	const [pkg, version] = title.split(' ');
	const author = t($('strong:contains("Author:")').parent().find('a').first().text());
	save('heldout-pypi', 'product_detail', [{
		match: { attr: 'name', value: title, compare: 'contains' }, acceptTypes: ['SoftwareApplication', 'Product', 'Article', 'WebPage', 'Unknown'],
		attributes: { released: { paths: ['date', 'datePublished', 'released'], value: ($('strong:contains("Released:")').parent().find('time').attr('datetime') ?? '').slice(0, 10), compare: 'date' } },
		relationships: [{ types: ['author'], to: { attr: 'name', value: author } }]
	}], [`Package ${pkg} version ${version}.`, 'Author is a mailto link after an <strong>Author:</strong> label.']);
}

// 16. Wikipedia tallest buildings: the main 98-row table (two-row header: Height m | ft)
{
	const $ = html('heldout-tallest');
	const table = $('table.wikitable').toArray().find((tb) => /Name/.test($(tb).find('tr').first().text()) && /Height/.test($(tb).find('tr').first().text()))!;
	const ents: Ent[] = [];
	// Correction after the first held-out run: the original oracle ignored rowspan (a country cell spanning
	// several rows), producing impossible labels such as country "2018". Expand spans into a grid.
	const trs = $(table).find('tr').toArray();
	const grid: string[][] = [];
	trs.forEach((tr, ri) => {
		grid[ri] ??= [];
		let ci = 0;
		for (const cell of $(tr).children('td,th').toArray()) {
			while (grid[ri][ci] !== undefined) ci++;
			const rs = Number($(cell).attr('rowspan')) || 1, cs = Number($(cell).attr('colspan')) || 1;
			const v = t($(cell).text()).replace(/\[[^\]]*\]/g, '').trim();
			for (let dr = 0; dr < rs && ri + dr < trs.length; dr++) for (let dc = 0; dc < cs; dc++) (grid[ri + dr] ??= [])[ci + dc] = v;
			ci += cs;
		}
	});
	grid.slice(2).forEach((c) => {
		if (c.length < 9 || !c[1]) return;
		// columns: rank | name | m | ft | floors | image | city | country | year | comments | ref
		ents.push({ match: { attr: 'name', value: c[1] }, acceptTypes: ['TableRow', 'Place', 'LandmarksOrHistoricalBuildings', 'Unknown'], attributes: {
			city: { paths: ['city'], value: c[6], compare: 'text' },
			country: { paths: ['country'], value: c[7], compare: 'text' },
			year: { paths: ['year'], value: Number(c[8]), compare: 'number' }
		} });
	});
	save('heldout-tallest', 'data_table', ents, ['Two-row header (Height: m | ft) shifts column positions; same buildings appear in several tables on the page.', 'LABEL CORRECTION after the first held-out run: rowspan now expanded in the oracle (see docs/page-quality.heldout-first-run.json for the uncorrected run).'], { precisionScope: 'matched-collections' });
}
