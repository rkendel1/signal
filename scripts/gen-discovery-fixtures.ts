/**
 * SYNTHETIC real-estate discovery fixtures (no real listing site is used: their terms prohibit automated
 * access). `node scripts/gen-discovery-fixtures.ts` writes tests/fixtures/discovery/.
 * truth.json is computed here from the generator's own data, never from the extractor.
 */
import { mkdirSync, writeFileSync } from 'node:fs';

interface Home { id: string; address: string; lat: number; lng: number; price: number; beds?: number; baths: number; sqft?: number; acres?: number; yearBuilt?: number; hoa?: number | null; cut?: { amount: number; date: string }; kind: 'house' | 'condo' | 'lot' }
const H = (id: string, address: string, lat: number, lng: number, price: number, o: Partial<Home> = {}): Home => ({ id, address, lat, lng, price, baths: 2, kind: 'house', ...o });

// Metro area: lat 39.70–39.85, lng -105.10 – -104.85. Neighborhood: lat 39.74–39.77, lng -105.00 – -104.96.
const homes: Home[] = [
	H('elm-121', '121 Elm St', 39.751, -104.981, 289000, { beds: 3, sqft: 1540, yearBuilt: 1986, hoa: null }),
	H('oak-48', '48 Oak Ave', 39.762, -104.972, 335000, { beds: 4, sqft: 1890, yearBuilt: 1978, hoa: 45 }),
	H('pine-9', '9 Pine Ct', 39.748, -104.990, 249000, { beds: 3, sqft: 1320, yearBuilt: 1995, hoa: 0, cut: { amount: 10000, date: '2026-11-10' } }),
	H('birch-300', '300 Birch Rd', 39.755, -104.965, 315000, { sqft: 1610, yearBuilt: 1988, hoa: 0 }), // beds not shown
	H('cedar-77', '77 Cedar Ln', 39.744, -104.998, 199000, { beds: 2, sqft: 980, yearBuilt: 1972, hoa: 120, kind: 'condo' }),
	H('maple-15', '15 Maple Dr', 39.769, -104.961, 342000, { beds: 3, sqft: 1700, hoa: 0 }), // yearBuilt unknown
	H('aspen-62', '62 Aspen Way', 39.758, -104.985, 410000, { beds: 4, sqft: 2200, yearBuilt: 2004, hoa: 0 }),
	H('lot-5', '5 Ridge Lot', 39.752, -104.969, 95000, { acres: 0.5, kind: 'lot' }),
	// outside the neighborhood, inside the metro area
	H('spruce-2', '2 Spruce Pl', 39.712, -105.071, 265000, { beds: 3, sqft: 1450, yearBuilt: 1999, hoa: 0 }),
	H('willow-88', '88 Willow St', 39.821, -104.902, 305000, { beds: 3, sqft: 1500, yearBuilt: 1983, hoa: 30 }),
	H('fir-14', '14 Fir Ave', 39.835, -105.020, 360000, { beds: 5, sqft: 2600, yearBuilt: 2010, hoa: 0 }),
	H('alder-41', '41 Alder Ct', 39.705, -104.880, 230000, { beds: 3, sqft: 1250, yearBuilt: 1979, hoa: null })
];
const rent: Record<string, number> = { 'elm-121': 2350, 'oak-48': 2400, 'pine-9': 2290, 'cedar-77': 1500, 'maple-15': 2500, 'aspen-62': 2900, 'spruce-2': 2050, 'fir-14': 2700, 'alder-41': 1980 }; // birch-300, willow-88, lot-5: no estimate
const later: Home[] = [...homes.filter((h) => h.lat >= 39.74 && h.lat <= 39.77 && h.lng >= -105 && h.lng <= -104.96).map((h) => h.id === 'oak-48' ? { ...h, price: 309000, cut: { amount: 26000, date: '2026-11-16' } } : h),
	H('juniper-3', '3 Juniper Rd', 39.746, -104.977, 279000, { beds: 3, sqft: 1480, yearBuilt: 1991, hoa: 0 })];
rent['juniper-3'] = 2300;

const base = 'https://homes.example';
const usd = (n: number) => `$${n.toLocaleString('en-US')}`;
function card(h: Home): string {
	const facts = h.kind === 'lot' ? `${h.acres} acres` : [h.beds !== undefined ? `${h.beds} bd` : null, `${h.baths} ba`, h.sqft ? `${h.sqft.toLocaleString('en-US')} sqft` : null].filter(Boolean).join(' | ');
	return `<li class="listing-card" data-lat="${h.lat}" data-lng="${h.lng}">
  <img src="/img/${h.id}.jpg" alt="${h.address}">
  <h3><a href="/homes/${h.id}">${h.address}</a></h3>
  <span class="listing-price">${usd(h.price)}</span>
  <p class="facts">${facts}</p>
  ${h.yearBuilt ? `<p class="detail">Built ${h.yearBuilt}</p>` : ''}
  ${h.hoa === undefined ? '' : `<p class="detail">${h.hoa === null || h.hoa === 0 ? 'No HOA' : `HOA ${usd(h.hoa)}/mo`}</p>`}
  ${h.cut ? `<p class="badge">Price cut ${usd(h.cut.amount)} on ${h.cut.date}</p>` : ''}
</li>`;
}
function page(title: string, url: string, bounds: { south: number; west: number; north: number; east: number }, shown: Home[], total: number, markers: Home[], next: string | null, jsonld: Home[] = [], staleJsonLdPrice: Record<string, number> = {}) {
	const ld = jsonld.length ? `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': jsonld.map((h) => ({ '@type': 'SingleFamilyResidence', '@id': `${base}/homes/${h.id}`, name: h.address, url: `${base}/homes/${h.id}`, numberOfBedrooms: h.beds, yearBuilt: h.yearBuilt, geo: { '@type': 'GeoCoordinates', latitude: h.lat, longitude: h.lng }, offers: { '@type': 'Offer', price: staleJsonLdPrice[h.id] ?? h.price, priceCurrency: 'USD' } })) })}</script>` : '';
	return `<!doctype html><html lang="en"><head><title>${title}</title><link rel="canonical" href="${url}">${next ? `<link rel="next" href="${next}">` : ''}${ld}</head><body>
<header><nav><a href="/">Homes</a></nav></header>
<main>
<h1>${title}</h1>
<p class="result-count">Showing 1–${shown.length} of ${total} homes</p>
<div class="map" role="region" aria-label="Map" data-south="${bounds.south}" data-west="${bounds.west}" data-north="${bounds.north}" data-east="${bounds.east}">
${markers.map((h) => `<span class="marker" data-lat="${h.lat}" data-lng="${h.lng}" aria-label="${h.address}"></span>`).join('')}
</div>
<ul class="results">
${shown.map(card).join('\n')}
</ul>
${next ? `<a rel="next" href="${next}">Next page</a>` : ''}
</main></body></html>`;
}
const metroB = { south: 39.70, west: -105.10, north: 39.85, east: -104.85 };
const hoodB = { south: 39.74, west: -105.00, north: 39.77, east: -104.96 };
const inB = (h: Home, b: typeof metroB) => h.lat >= b.south && h.lat <= b.north && h.lng >= b.west && h.lng <= b.east;
const hood = homes.filter((h) => inB(h, hoodB));
// the metro marker layer shows 20 markers: the 12 listed homes + 8 unlisted marker-only positions
const extraMarkers: Home[] = Array.from({ length: 8 }, (_, i) => H(`m${i}`, `marker ${i}`, 39.72 + i * 0.015, -105.05 + i * 0.02, 0));

const dir = new URL('../tests/fixtures/discovery/', import.meta.url);
mkdirSync(dir, { recursive: true });
const metroUrl = `${base}/search?south=39.70&west=-105.10&north=39.85&east=-104.85&sort=newest`;
const hoodUrl = `${base}/search?south=39.74&west=-105.00&north=39.77&east=-104.96&sort=newest`;
writeFileSync(new URL('metro-p1.html', dir), page('Homes for sale in Metro County', metroUrl, metroB, homes, 87, [...homes, ...extraMarkers], `${base}/search?south=39.70&west=-105.10&north=39.85&east=-104.85&sort=newest&page=2`));
writeFileSync(new URL('neighborhood.html', dir), page('Homes for sale in Riverside', hoodUrl, hoodB, hood, hood.length, hood, null, hood.filter((h) => ['elm-121', 'oak-48'].includes(h.id)), { 'elm-121': 279000 }));
writeFileSync(new URL('neighborhood-later.html', dir), page('Homes for sale in Riverside', hoodUrl, hoodB, later, later.length, later, null));
writeFileSync(new URL('rent-estimates.json', dir), JSON.stringify({
	source: { id: 'metro-rent-survey-2026', name: 'Metro Rent Survey 2026 (synthetic)', method: 'external-estimate', observedAt: '2026-11-01T00:00:00Z', note: 'An authorized external dataset; values are estimates, not listing facts.' },
	records: Object.entries(rent).map(([id, monthly]) => ({ url: `${base}/homes/${id}`, attribute: 'estimatedMonthlyRent', value: { amount: monthly, currency: 'USD' } }))
}, null, 1) + '\n');

// ---------------- truth (from generator data; tri-state: missing ⇒ unknown ⇒ "possible", never a match)
type T = 'match' | 'possible' | 'non_match' | 'out_of_scope';
const tri = (v: number | undefined | null, f: (x: number) => boolean) => (v === undefined || v === null ? 'unknown' : f(v) ? 'true' : 'false');
function status(h: Home, crit: Array<(h: Home) => string>, scope: typeof metroB): T {
	if (!inB(h, scope)) return 'out_of_scope';
	const r = crit.map((c) => c(h));
	return r.includes('false') ? 'non_match' : r.includes('unknown') ? 'possible' : 'match';
}
const y = (h: Home) => (rent[h.id] === undefined ? undefined : (rent[h.id] * 12) / h.price);
const intent1 = [(h: Home) => tri(h.price, (p) => p < 350000), (h: Home) => tri(h.beds, (b) => b >= 3), (h: Home) => tri(y(h), (v) => v > 0.08)];
const intent2 = [...intent1.slice(0, 2), (h: Home) => tri(h.yearBuilt, (v) => v > 1980), (h: Home) => tri(h.hoa === null ? 0 : h.hoa, (v) => v === 0), (h: Home) => tri(y(h), (v) => v > 0.10), (h: Home) => (h.cut ? 'true' : 'false')];
const residential = homes.filter((h) => h.kind !== 'lot');
writeFileSync(new URL('truth.json', dir), JSON.stringify({
	note: 'Expected discovery statuses computed from generator data (scripts/gen-discovery-fixtures.ts). Lots are not residential listings and are not candidates.',
	metroIntent1: Object.fromEntries(residential.map((h) => [`${base}/homes/${h.id}`, status(h, intent1, metroB)])),
	neighborhoodScopeIntent1: Object.fromEntries(residential.map((h) => [`${base}/homes/${h.id}`, status(h, intent1, hoodB)])),
	neighborhoodIntent2: Object.fromEntries(hood.filter((h) => h.kind !== 'lot').map((h) => [`${base}/homes/${h.id}`, status(h, intent2, hoodB)])),
	laterIntent2: Object.fromEntries(later.filter((h) => h.kind !== 'lot').map((h) => [`${base}/homes/${h.id}`, status(h, intent2, hoodB)])),
	declared: { metroTotal: 87, metroShown: homes.length, metroMarkers: homes.length + extraMarkers.length, neighborhoodTotal: hood.length }
}, null, 1) + '\n');
console.log('homes', homes.length, 'neighborhood', hood.length, 'later', later.length);
