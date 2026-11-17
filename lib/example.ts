/**
 * A SYNTHETIC example workspace, generated deterministically. Every record is invented: the street names,
 * prices, parcels and coordinates describe no real place ("Example City" sits on made-up coordinates).
 * It exists so a new user can see the whole workflow, and so tests are repeatable. It is labelled synthetic
 * wherever it appears, and nothing derived from it may be presented as real-world validation.
 *
 * Built-in situations (by listing index):
 *   0–33  a listing and its parcel agree on address; coordinates within ~10 m        → probable identity match
 *   34    the parcel shares the listing's parcel id                                   → exact identity match
 *   35    no parcel record                                                            → evidence missing ("possible")
 *   36    a parcel with the same address but 600 m away                               → identity conflict, not merged
 *   37    two parcels (a duplex) at the same address and location                    → ambiguous, not merged
 *   every 7th parcel is in flood zone AE                                             → exclusion
 */
const STREETS = ['Alder', 'Birch', 'Cedar', 'Dogwood', 'Elm', 'Fir', 'Gum', 'Hawthorn', 'Ironwood', 'Juniper'];
const BASE = { lat: 40.0, lng: -100.0 };

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

export interface ExampleListing { listing_id: string; address: string; lat: number; lng: number; price: number; beds: number; baths: number; sqft: number; status: string; parcel_ref: string }

export function exampleData() {
	const r = rng(20261117);
	const listings: ExampleListing[] = [];
	const parcels: Array<{ parcel_id: string; site_address: string; lat: number; lng: number; assessed_value: number; annual_tax: number; year_built: number; flood_zone: string; land_use: string }> = [];
	for (let i = 0; i < 38; i++) {
		const street = STREETS[i % STREETS.length];
		const no = 10 + i * 4;
		const lat = +(BASE.lat + (i % 8) * 0.004 + r() * 0.0005).toFixed(6);
		const lng = +(BASE.lng + Math.floor(i / 8) * 0.005 + r() * 0.0005).toFixed(6);
		const assessed = Math.round((220_000 + r() * 260_000) / 1000) * 1000;
		const price = Math.round((assessed * (0.85 + r() * 0.35)) / 1000) * 1000;
		listings.push({ listing_id: `EX-${1000 + i}`, address: `${no} ${street} Street, Example City`, lat, lng, price, beds: 2 + (i % 4), baths: 1 + (i % 3), sqft: 1100 + Math.round(r() * 1400), status: 'active', parcel_ref: i === 34 ? `P-${5000 + i}` : '' });
		if (i === 35) continue;
		const jitter = () => (r() - 0.5) * 0.00015; // ±8 m
		const parcel = { parcel_id: `P-${5000 + i}`, site_address: `${no} ${street} St`, lat: +(lat + jitter()).toFixed(6), lng: +(lng + jitter()).toFixed(6), assessed_value: assessed, annual_tax: Math.round(assessed * (0.012 + r() * 0.012)), year_built: 1950 + Math.round(r() * 70), flood_zone: i % 7 === 3 ? 'AE' : 'X', land_use: 'residential' };
		if (i === 34) parcel.site_address = `${no + 1000} Unrelated Rd`; // only the parcel id connects them
		if (i === 36) { parcel.lat = +(lat + 0.0054).toFixed(6); } // ~600 m north
		parcels.push(parcel);
		if (i === 37) parcels.push({ ...parcel, parcel_id: `P-${5000 + i}-B`, lat: +(lat + 0.00003).toFixed(6), assessed_value: Math.round(assessed * 0.6) });
	}
	return { listings, parcels };
}

export function listingsCsv(listings: ExampleListing[]): string {
	const cols = ['listing_id', 'address', 'lat', 'lng', 'price', 'beds', 'baths', 'sqft', 'status', 'parcel_ref'] as const;
	return [cols.join(','), ...listings.map((l) => cols.map((c) => (typeof l[c] === 'string' && String(l[c]).includes(',') ? `"${l[c]}"` : String(l[c]))).join(','))].join('\n') + '\n';
}

export function parcelsGeoJson(parcels: ReturnType<typeof exampleData>['parcels']): string {
	return JSON.stringify({ type: 'FeatureCollection', features: parcels.map(({ lat, lng, ...props }) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: props })) });
}

export const LISTINGS_MAPPING = {
	version: 1, entityType: 'property',
	fields: [
		{ source: 'listing_id', attribute: 'listingId', type: 'text', role: 'key' },
		{ source: 'address', attribute: 'address', type: 'text', role: 'address' },
		{ source: 'lat', attribute: 'latitude', type: 'number', role: 'latitude' },
		{ source: 'lng', attribute: 'longitude', type: 'number', role: 'longitude' },
		{ source: 'parcel_ref', attribute: 'parcelId', type: 'text', role: 'id' },
		{ source: 'price', attribute: 'price', type: 'money', currency: 'USD' },
		{ source: 'beds', attribute: 'numberOfBedrooms', type: 'number' },
		{ source: 'baths', attribute: 'numberOfBathrooms', type: 'number' },
		{ source: 'sqft', attribute: 'floorSize', type: 'number', unit: 'sqft' },
		{ source: 'status', attribute: 'status', type: 'text' },
	],
};

export const PARCELS_MAPPING = {
	version: 1, entityType: 'property',
	fields: [
		{ source: 'parcel_id', attribute: 'parcelId', type: 'text', role: 'id' },
		{ source: 'site_address', attribute: 'address', type: 'text', role: 'address' },
		{ source: 'assessed_value', attribute: 'assessedValue', type: 'money', currency: 'USD' },
		{ source: 'annual_tax', attribute: 'annualPropertyTax', type: 'money', currency: 'USD' },
		{ source: 'year_built', attribute: 'yearBuilt', type: 'number' },
		{ source: 'flood_zone', attribute: 'floodZone', type: 'text' },
		{ source: 'land_use', attribute: 'landUse', type: 'text' },
	],
};

export const EXAMPLE_CRITERIA = {
	name: 'Priced at or below assessment, outside flood zones',
	description: 'Active listings priced no higher than the county assessment, with moderate taxes; flood-zone parcels excluded. Bigger and newer homes first.',
	entityType: 'property', severity: 'warning',
	derive: [{ name: 'priceToAssessed', label: 'Price ÷ assessed value', expr: { op: '/', args: [{ attr: 'price' }, { attr: 'assessedValue' }] } }],
	require: [
		{ attr: 'status', op: 'eq', value: 'active' },
		{ attr: 'price', op: 'lte', value: 450000 },
		{ attr: 'priceToAssessed', op: 'lte', value: 1.0, label: 'price at or below the assessed value' },
		{ attr: 'annualPropertyTax', op: 'lt', value: 7000 },
	],
	exclude: [{ attr: 'floodZone', op: 'in', value: ['AE', 'VE', 'A'] }],
	prefer: [
		{ when: { attr: 'numberOfBedrooms', op: 'gte', value: 4 }, weight: 15, label: '4+ bedrooms' },
		{ when: { attr: 'yearBuilt', op: 'gte', value: 1990 }, weight: 10, label: 'built 1990 or later' },
	],
	changeThresholds: { price: { pct: 1 } },
	notifyOn: ['new', 'reopened', 'changed'],
};
