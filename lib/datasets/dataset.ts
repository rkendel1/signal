/**
 * User-owned datasets — parse, inspect, map (pure, deterministic).
 *
 * A dataset is an independent observation of a source that is NOT a page: a county parcel file,
 * a rent survey, an export from the user's own database. It is never written into signal.page/v1.
 * Its facts reach discovery as `Enrichment`s, labelled external, with the dataset version and the
 * mapping version that produced each value.
 *
 * Mapping is reviewable and versioned: `inspectDataset` PROPOSES (a fixed synonym table, no model),
 * the user accepts or edits, and `applyMapping` executes the accepted mapping deterministically.
 * A new mapping is a new version; observations made under an earlier mapping keep their meaning.
 */
import type { AttributeValue } from '../page/types.ts';

// ------------------------------------------------------------------ parsing

export type Cell = string | number | boolean | null;
export interface Geometry { point?: { lat: number; lng: number }; polygons?: Array<Array<Array<[number, number]>>> /* polygon → rings → [lng,lat] */ }
export interface RawRow { index: number; props: Record<string, Cell>; geometry?: Geometry }
export interface ParsedDataset { format: 'csv' | 'geojson'; fields: string[]; rows: RawRow[] }

export const MAX_ROWS = 200_000;

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF/LF, embedded newlines. A BOM is ignored. */
export function parseCsv(text: string): ParsedDataset {
	const src = text.replace(/^﻿/, '');
	const table: string[][] = [];
	let row: string[] = [], cur = '', quoted = false;
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (quoted) {
			if (ch === '"') { if (src[i + 1] === '"') { cur += '"'; i++; } else quoted = false; } else cur += ch;
		} else if (ch === '"' && cur === '') quoted = true;
		else if (ch === ',') { row.push(cur); cur = ''; }
		else if (ch === '\n' || ch === '\r') {
			if (ch === '\r' && src[i + 1] === '\n') i++;
			row.push(cur); cur = '';
			if (row.some((c) => c !== '')) table.push(row);
			row = [];
		} else cur += ch;
	}
	if (quoted) throw new Error('csv: unterminated quoted field');
	row.push(cur);
	if (row.some((c) => c !== '')) table.push(row);
	if (!table.length) throw new Error('csv: no header row');
	const fields = table[0].map((h) => h.trim());
	if (fields.some((f) => !f)) throw new Error('csv: every column needs a header');
	if (new Set(fields).size !== fields.length) throw new Error('csv: duplicate column names');
	if (table.length - 1 > MAX_ROWS) throw new Error(`dataset: more than ${MAX_ROWS} rows`);
	const rows: RawRow[] = table.slice(1).map((r, index) => ({ index, props: Object.fromEntries(fields.map((f, i) => [f, r[i] === undefined || r[i].trim() === '' ? null : r[i].trim()])) }));
	return { format: 'csv', fields, rows };
}

const isPos = (c: unknown): c is [number, number] => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]) && Math.abs(c[1]) <= 90 && Math.abs(c[0]) <= 180;

/** GeoJSON FeatureCollection (or single Feature) of Point / Polygon / MultiPolygon. Other geometries are kept as rows without geometry. */
export function parseGeoJson(text: string): ParsedDataset {
	const doc = JSON.parse(text) as { type?: string; features?: unknown[] };
	const features = doc.type === 'FeatureCollection' ? (doc.features ?? []) : doc.type === 'Feature' ? [doc] : null;
	if (!features) throw new Error('geojson: expected a FeatureCollection or Feature');
	if (features.length > MAX_ROWS) throw new Error(`dataset: more than ${MAX_ROWS} rows`);
	const fieldSet = new Set<string>();
	const rows: RawRow[] = features.map((f, index) => {
		const feat = f as { properties?: Record<string, unknown> | null; geometry?: { type?: string; coordinates?: unknown } | null };
		const props: Record<string, Cell> = {};
		for (const [k, v] of Object.entries(feat.properties ?? {})) { props[k] = v === null || ['string', 'number', 'boolean'].includes(typeof v) ? (v as Cell) : JSON.stringify(v); fieldSet.add(k); }
		const g = feat.geometry;
		let geometry: Geometry | undefined;
		if (g?.type === 'Point' && isPos(g.coordinates)) geometry = { point: { lat: g.coordinates[1], lng: g.coordinates[0] } };
		else if (g?.type === 'Polygon' && Array.isArray(g.coordinates) && (g.coordinates as unknown[][]).every((r) => r.every(isPos))) geometry = { polygons: [g.coordinates as Array<Array<[number, number]>>] };
		else if (g?.type === 'MultiPolygon' && Array.isArray(g.coordinates) && (g.coordinates as unknown[][][]).every((p) => p.every((r) => r.every(isPos)))) geometry = { polygons: g.coordinates as Array<Array<Array<[number, number]>>> };
		return { index, props, ...(geometry ? { geometry } : {}) };
	});
	return { format: 'geojson', fields: [...fieldSet], rows };
}

export function parseDataset(text: string, format: 'csv' | 'geojson'): ParsedDataset {
	return format === 'csv' ? parseCsv(text) : parseGeoJson(text);
}

// ------------------------------------------------------------------ inspection and proposed mapping

export type FieldType = 'text' | 'number' | 'boolean';
export interface FieldProfile { name: string; type: FieldType; present: number; of: number; samples: string[]; min?: number; max?: number }
export type Role = 'id' | 'address' | 'latitude' | 'longitude';
export type MappedType = 'text' | 'number' | 'money';
export interface FieldMapping { source: string; attribute: string; type: MappedType; currency?: string; role?: Role }
export interface DatasetMapping { version: number; fields: FieldMapping[] }
export interface MappingProposal extends FieldMapping { basis: string }

const NUM = /^-?\$?\s*\d[\d,]*(\.\d+)?$|^-?\$?\s*\.\d+$/;
export const parseNumber = (v: Cell): number | null => {
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	if (typeof v !== 'string' || !NUM.test(v.trim())) return null;
	const n = Number(v.replace(/[$,\s]/g, ''));
	return Number.isFinite(n) ? n : null;
};

export function profileFields(ds: ParsedDataset): FieldProfile[] {
	return ds.fields.map((name) => {
		const vals = ds.rows.map((r) => r.props[name]).filter((v) => v !== null && v !== undefined);
		const nums = vals.map(parseNumber);
		// Numeric when at least 80% of values parse; the stragglers surface as mapping issues instead of demoting the column.
		const allNum = vals.length > 0 && nums.filter((n) => n !== null).length / vals.length >= 0.8;
		const allBool = vals.length > 0 && vals.every((v) => typeof v === 'boolean');
		const type: FieldType = allBool ? 'boolean' : allNum ? 'number' : 'text';
		const ns = nums.filter((n): n is number => n !== null);
		return { name, type, present: vals.length, of: ds.rows.length, samples: [...new Set(vals.map(String))].slice(0, 3), ...(type === 'number' ? { min: ns.reduce((a, b) => (b < a ? b : a), Infinity), max: ns.reduce((a, b) => (b > a ? b : a), -Infinity) } : {}) }; // not Math.min(...ns): spreading ~125k arguments throws RangeError
	});
}

/** A fixed vocabulary, matched on the normalized column name. A proposal, never a decision. */
const SYNONYMS: Array<{ attribute: string; type: MappedType; role?: Role; names: string[] }> = [
	{ attribute: 'parcelId', type: 'text', role: 'id', names: ['parcelid', 'parcelno', 'parcelnumber', 'parcel', 'apn', 'pin', 'pid', 'taxid', 'accountnumber'] },
	{ attribute: 'address', type: 'text', role: 'address', names: ['address', 'siteaddr', 'siteaddress', 'situsaddress', 'streetaddress', 'propertyaddress', 'location'] },
	{ attribute: 'latitude', type: 'number', role: 'latitude', names: ['latitude', 'lat', 'y', 'ycoord'] },
	{ attribute: 'longitude', type: 'number', role: 'longitude', names: ['longitude', 'lng', 'lon', 'long', 'x', 'xcoord'] },
	{ attribute: 'assessedValue', type: 'money', names: ['assessedvalue', 'assessedtotal', 'totalassessed', 'assessment', 'assessedval', 'totalvalue'] },
	{ attribute: 'annualPropertyTax', type: 'money', names: ['annualpropertytax', 'propertytax', 'taxannual', 'annualtax', 'taxamount', 'taxes', 'tax'] },
	{ attribute: 'floorSize', type: 'number', names: ['floorsize', 'grosslivingarea', 'livingarea', 'sqft', 'squarefeet', 'buildingsqft'] },
	{ attribute: 'yearBuilt', type: 'number', names: ['yearbuilt', 'yrbuilt', 'builtyear', 'yearconstructed'] },
	{ attribute: 'numberOfBedrooms', type: 'number', names: ['bedrooms', 'beds', 'numberofbedrooms', 'bedroomcount'] },
	{ attribute: 'lotSize', type: 'number', names: ['lotsize', 'lotsqft', 'lotarea', 'acres'] },
	{ attribute: 'estimatedMonthlyRent', type: 'money', names: ['estimatedmonthlyrent', 'estimatedrent', 'monthlyrent', 'rentestimate', 'rent'] },
	{ attribute: 'zoning', type: 'text', names: ['zoning', 'zone', 'zoningcode'] },
];
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function proposeMapping(ds: ParsedDataset, profiles: FieldProfile[] = profileFields(ds)): { proposals: MappingProposal[]; unmapped: string[] } {
	const used = new Set<string>();
	const proposals: MappingProposal[] = [];
	for (const syn of SYNONYMS) {
		// A role is claimed once, by the first (most specific) synonym that appears in the file.
		const hit = profiles.find((p) => !used.has(p.name) && syn.names.includes(norm(p.name)) && (syn.type === 'text' || p.type === 'number') );
		if (!hit || proposals.some((x) => x.attribute === syn.attribute)) continue;
		used.add(hit.name);
		proposals.push({ source: hit.name, attribute: syn.attribute, type: syn.type, ...(syn.type === 'money' ? { currency: 'USD' } : {}), ...(syn.role ? { role: syn.role } : {}), basis: `column "${hit.name}" matches the vocabulary for ${syn.attribute}` });
	}
	// A GeoJSON file's coordinates come from its geometry, not from columns.
	return { proposals, unmapped: profiles.map((p) => p.name).filter((n) => !used.has(n)) };
}

export interface DatasetInspection { format: 'csv' | 'geojson'; rows: number; withGeometry: number; fields: FieldProfile[]; proposed: DatasetMapping; proposals: MappingProposal[]; unmapped: string[] }

export function inspectDataset(ds: ParsedDataset): DatasetInspection {
	const fields = profileFields(ds);
	const { proposals, unmapped } = proposeMapping(ds, fields);
	return {
		format: ds.format, rows: ds.rows.length, withGeometry: ds.rows.filter((r) => r.geometry).length, fields, proposals, unmapped,
		proposed: { version: 1, fields: proposals.map(({ basis: _b, ...m }) => m) },
	};
}

export function validateMapping(m: DatasetMapping, ds?: ParsedDataset): string[] {
	const errors: string[] = [];
	if (!Number.isInteger(m.version) || m.version < 1) errors.push('version must be a positive integer');
	const roles = new Set<string>(), attrs = new Set<string>();
	for (const f of m.fields ?? []) {
		if (!f.source || !f.attribute) errors.push('every field needs a source column and an attribute');
		if (!['text', 'number', 'money'].includes(f.type)) errors.push(`${f.attribute}: unknown type ${f.type}`);
		if (f.role) { if (roles.has(f.role)) errors.push(`role ${f.role} is mapped twice`); roles.add(f.role); }
		if (attrs.has(f.attribute)) errors.push(`attribute ${f.attribute} is mapped twice`);
		attrs.add(f.attribute);
		if (ds && !ds.fields.includes(f.source)) errors.push(`column "${f.source}" is not in the dataset`);
		if (f.role && ['latitude', 'longitude'].includes(f.role) && f.type !== 'number') errors.push(`${f.role} must be a number`);
	}
	return errors;
}

// ------------------------------------------------------------------ applying a mapping

export interface DatasetRecord {
	/** The id column's value when mapped, else `row-<index>`: stable for a dataset version. */
	recordId: string;
	hasId: boolean;
	row: number;
	address: string | null;
	addressKey: string | null;
	lat: number | null;
	lng: number | null;
	geometry?: Geometry;
	attributes: Record<string, AttributeValue>;
}
export interface MappingIssue { row: number; field: string; problem: string; raw: string }
export interface MappedDataset { records: DatasetRecord[]; issues: MappingIssue[]; unmapped: string[] }

const SUFFIX: Record<string, string> = { street: 'st', avenue: 'ave', road: 'rd', drive: 'dr', court: 'ct', lane: 'ln', boulevard: 'blvd', place: 'pl', terrace: 'ter', circle: 'cir', highway: 'hwy', parkway: 'pkwy', way: 'way', trail: 'trl' };
const DIR: Record<string, string> = { north: 'n', south: 's', east: 'e', west: 'w', northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw' };
/** A comparison key, not a display value. Street address only: text after the first comma (city, state, zip) is dropped. */
export function normalizeAddress(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const street = raw.split(',')[0].toLowerCase().replace(/[.#]/g, ' ').replace(/\b(apt|unit|suite|ste)\b\s*/g, 'unit ').replace(/[^a-z0-9 ]/g, ' ');
	const words = street.split(/\s+/).filter(Boolean).map((w) => SUFFIX[w] ?? DIR[w] ?? w);
	return words.length >= 2 && /^\d/.test(words[0]) ? words.join(' ') : null; // needs a house number and a street
}

const centroid = (g: Geometry): { lat: number; lng: number } | null => {
	if (g.point) return g.point;
	const ring = g.polygons?.[0]?.[0];
	if (!ring?.length) return null;
	return { lat: ring.reduce((a, p) => a + p[1], 0) / ring.length, lng: ring.reduce((a, p) => a + p[0], 0) / ring.length };
};

export function applyMapping(ds: ParsedDataset, mapping: DatasetMapping): MappedDataset {
	const errors = validateMapping(mapping, ds);
	if (errors.length) throw new Error(`invalid mapping: ${errors.join('; ')}`);
	const role = (r: Role) => mapping.fields.find((f) => f.role === r);
	const issues: MappingIssue[] = [];
	const records: DatasetRecord[] = ds.rows.map((r) => {
		const attributes: Record<string, AttributeValue> = {};
		let id: string | null = null, address: string | null = null, lat: number | null = null, lng: number | null = null;
		for (const f of mapping.fields) {
			const raw = r.props[f.source];
			if (raw === null || raw === undefined) continue;
			let v: AttributeValue;
			if (f.type === 'text') v = String(raw);
			else {
				const n = parseNumber(raw);
				if (n === null) { issues.push({ row: r.index, field: f.source, problem: `not a number`, raw: String(raw) }); continue; }
				v = f.type === 'money' ? { amount: n, currency: f.currency ?? 'USD' } : n;
			}
			if (f.role === 'id') id = String(raw);
			else if (f.role === 'address') address = String(raw);
			else if (f.role === 'latitude') { lat = v as number; continue; }
			else if (f.role === 'longitude') { lng = v as number; continue; }
			attributes[f.attribute] = v;
		}
		if (lat !== null && (lat < -90 || lat > 90)) { issues.push({ row: r.index, field: role('latitude')!.source, problem: 'latitude out of range', raw: String(lat) }); lat = null; }
		if (lng !== null && (lng < -180 || lng > 180)) { issues.push({ row: r.index, field: role('longitude')!.source, problem: 'longitude out of range', raw: String(lng) }); lng = null; }
		if ((lat === null) !== (lng === null)) { lat = null; lng = null; }
		if (lat === null && r.geometry) { const c = centroid(r.geometry); if (c) { lat = c.lat; lng = c.lng; } }
		return { recordId: id ?? `row-${r.index}`, hasId: id !== null, row: r.index, address, addressKey: normalizeAddress(address), lat, lng, ...(r.geometry ? { geometry: r.geometry } : {}), attributes };
	});
	const mappedCols = new Set(mapping.fields.map((f) => f.source));
	return { records, issues, unmapped: ds.fields.filter((f) => !mappedCols.has(f)) };
}
