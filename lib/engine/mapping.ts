/**
 * Source mappings (pure, deterministic): how a source's raw records become observations.
 *
 * `proposeMapping` suggests (a fixed synonym table, no model); a person accepts or edits; `applyMapping`
 * executes the accepted mapping. A mapping change is a new mapping version; observations made under the
 * earlier version keep their meaning, and re-applying the new one to the stored raw bytes produces new
 * observation versions only where the result actually differs.
 */
import { canonicalJson, sha256 } from '../core/canonical.ts';
import type { Cell, ParsedDataset, RawRow } from '../sources/records.ts';
import { assertPermittedAttribute } from './policy.ts';
import type { Geometry, IdentityHints, ObservationDraft, ObservedValue, Value } from './types.ts';

export type FieldType = 'text' | 'number' | 'money' | 'boolean' | 'date';
/** key: the record's own key in this source. id: a shared identifier scheme (named by the attribute). */
export type Role = 'key' | 'id' | 'address' | 'latitude' | 'longitude' | 'name' | 'validAt';
export interface FieldMapping { source: string; attribute: string; type: FieldType; unit?: string; currency?: string; role?: Role }
export interface SourceMapping { version: number; entityType: string; fields: FieldMapping[] }

// ------------------------------------------------------------------ values

const NUM = /^-?\$?\s*\d[\d,]*(\.\d+)?$|^-?\$?\s*\.\d+$/;
export function parseNumber(v: Cell): number | null {
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	if (typeof v !== 'string' || !NUM.test(v.trim())) return null;
	const n = Number(v.replace(/[$,\s]/g, ''));
	return Number.isFinite(n) ? n : null;
}
export function parseBoolean(v: Cell): boolean | null {
	if (typeof v === 'boolean') return v;
	if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : null;
	if (typeof v !== 'string') return null;
	const s = v.trim().toLowerCase();
	return ['true', 'yes', 'y', '1'].includes(s) ? true : ['false', 'no', 'n', '0'].includes(s) ? false : null;
}
export function parseDateValue(v: Cell): string | null {
	if (typeof v !== 'string' && typeof v !== 'number') return null;
	const s = String(v).trim();
	if (!/^\d{4}-\d{2}-\d{2}/.test(s) && !/^\d{4}$/.test(s)) return null; // ISO 8601 only: "03/04/2026" is ambiguous
	const t = Date.parse(/^\d{4}$/.test(s) ? `${s}-01-01` : s);
	return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const SUFFIX: Record<string, string> = { street: 'st', avenue: 'ave', road: 'rd', drive: 'dr', court: 'ct', lane: 'ln', boulevard: 'blvd', place: 'pl', terrace: 'ter', circle: 'cir', highway: 'hwy', parkway: 'pkwy', way: 'way', trail: 'trl' };
const DIR: Record<string, string> = { north: 'n', south: 's', east: 'e', west: 'w', northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw' };
/** A comparison key, not a display value. Street address only: text after the first comma (city, state, zip) is dropped. */
export function normalizeAddress(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const street = raw.split(',')[0].toLowerCase().replace(/[.#]/g, ' ').replace(/\b(apt|unit|suite|ste)\b\s*/g, 'unit ').replace(/[^a-z0-9 ]/g, ' ');
	const words = street.split(/\s+/).filter(Boolean).map((w) => SUFFIX[w] ?? DIR[w] ?? w);
	return words.length >= 2 && /^\d/.test(words[0]) ? words.join(' ') : null; // needs a house number and a street
}

// ------------------------------------------------------------------ profiling and proposals

export interface FieldProfile { name: string; type: 'text' | 'number' | 'boolean'; present: number; of: number; samples: string[]; min?: number; max?: number }

export function profileFields(ds: ParsedDataset): FieldProfile[] {
	return ds.fields.map((name) => {
		const vals = ds.rows.map((r) => r.props[name]).filter((v) => v !== null && v !== undefined);
		const nums = vals.map(parseNumber);
		const allNum = vals.length > 0 && nums.filter((n) => n !== null).length / vals.length >= 0.8;
		const allBool = vals.length > 0 && vals.every((v) => parseBoolean(v) !== null && typeof v !== 'number');
		const type = allBool ? 'boolean' : allNum ? 'number' : 'text';
		const ns = nums.filter((n): n is number => n !== null);
		return { name, type, present: vals.length, of: ds.rows.length, samples: [...new Set(vals.map(String))].slice(0, 3), ...(type === 'number' ? { min: ns.reduce((a, b) => (b < a ? b : a), Infinity), max: ns.reduce((a, b) => (b > a ? b : a), -Infinity) } : {}) };
	});
}

/** A fixed vocabulary matched on the normalized column name. A proposal, never a decision. */
const SYNONYMS: Array<{ attribute: string; type: FieldType; role?: Role; names: string[] }> = [
	{ attribute: 'parcelId', type: 'text', role: 'id', names: ['parcelid', 'parcelno', 'parcelnumber', 'parcel', 'apn', 'pin', 'pid', 'taxid', 'accountnumber'] },
	{ attribute: 'listingId', type: 'text', role: 'key', names: ['listingid', 'mlsid', 'mlsnumber', 'mls', 'id', 'key', 'recordid', 'uuid'] },
	{ attribute: 'address', type: 'text', role: 'address', names: ['address', 'siteaddr', 'siteaddress', 'situsaddress', 'streetaddress', 'propertyaddress', 'location'] },
	{ attribute: 'latitude', type: 'number', role: 'latitude', names: ['latitude', 'lat', 'y', 'ycoord'] },
	{ attribute: 'longitude', type: 'number', role: 'longitude', names: ['longitude', 'lng', 'lon', 'long', 'x', 'xcoord'] },
	{ attribute: 'name', type: 'text', role: 'name', names: ['name', 'title'] },
	{ attribute: 'asOf', type: 'date', role: 'validAt', names: ['asof', 'dataasof', 'updatedat', 'lastupdated', 'effectivedate'] },
	{ attribute: 'price', type: 'money', names: ['price', 'listprice', 'askingprice', 'listingprice'] },
	{ attribute: 'status', type: 'text', names: ['status', 'listingstatus', 'state'] },
	{ attribute: 'assessedValue', type: 'money', names: ['assessedvalue', 'assessedtotal', 'totalassessed', 'assessment', 'assessedval', 'totalvalue'] },
	{ attribute: 'annualPropertyTax', type: 'money', names: ['annualpropertytax', 'propertytax', 'taxannual', 'annualtax', 'taxamount', 'taxes', 'tax'] },
	{ attribute: 'floorSize', type: 'number', names: ['floorsize', 'grosslivingarea', 'livingarea', 'sqft', 'squarefeet', 'buildingsqft'] },
	{ attribute: 'yearBuilt', type: 'number', names: ['yearbuilt', 'yrbuilt', 'builtyear', 'yearconstructed'] },
	{ attribute: 'numberOfBedrooms', type: 'number', names: ['bedrooms', 'beds', 'numberofbedrooms', 'bedroomcount'] },
	{ attribute: 'lotSize', type: 'number', names: ['lotsize', 'lotsqft', 'lotarea', 'acres'] },
	{ attribute: 'estimatedMonthlyRent', type: 'money', names: ['estimatedmonthlyrent', 'estimatedrent', 'monthlyrent', 'rentestimate', 'rent'] },
	{ attribute: 'zoning', type: 'text', names: ['zoning', 'zone', 'zoningcode'] },
	{ attribute: 'floodZone', type: 'text', names: ['floodzone', 'femazone', 'flood'] },
];
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const camel = (s: string) => s.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : '')).replace(/^[A-Z]/, (c) => c.toLowerCase()) || 'field';

export interface MappingProposal extends FieldMapping { basis: string; include?: boolean }

/** Columns that look like personal data (owners, contact details) are proposed but not included unless a person opts in. */
const PERSONAL = /(^|[^a-z])(owner|owners|taxpayer|mailing|mail|email|phone|ssn|grantee|grantor|buyer|seller_?name|occupant)([^a-z]|$)/i;

/** Propose a mapping: vocabulary matches first, then every remaining column under its own name and profiled type. */
export function proposeMapping(ds: ParsedDataset, entityType: string, profiles: FieldProfile[] = profileFields(ds)): { mapping: SourceMapping; proposals: MappingProposal[]; skipped: Array<{ column: string; reason: string }> } {
	const used = new Set<string>();
	const proposals: MappingProposal[] = [];
	const skipped: Array<{ column: string; reason: string }> = [];
	for (const syn of SYNONYMS) {
		const hit = profiles.find((p) => !used.has(p.name) && syn.names.includes(norm(p.name)) && (!['number', 'money'].includes(syn.type) || p.type === 'number'));
		if (!hit || proposals.some((x) => x.attribute === syn.attribute || (syn.role && x.role === syn.role))) continue;
		used.add(hit.name);
		proposals.push({ source: hit.name, attribute: syn.attribute, type: syn.type, ...(syn.type === 'money' ? { currency: 'USD' } : {}), ...(syn.role ? { role: syn.role } : {}), basis: `column "${hit.name}" matches the vocabulary for ${syn.attribute}` });
	}
	for (const p of profiles) {
		if (used.has(p.name)) continue;
		const attribute = camel(p.name);
		try { assertPermittedAttribute(attribute, 'mapping'); assertPermittedAttribute(p.name, 'mapping'); } catch (e) { skipped.push({ column: p.name, reason: (e as Error).message }); continue; }
		if (proposals.some((x) => x.attribute === attribute)) { skipped.push({ column: p.name, reason: `attribute ${attribute} already mapped` }); continue; }
		const personal = PERSONAL.test(p.name.replace(/([a-z])([A-Z])/g, '$1_$2'));
		proposals.push({ source: p.name, attribute, type: p.type, basis: personal ? 'looks like personal data (owner or contact details): not included unless you choose to' : `kept under its own name (${p.type}, ${p.present} of ${p.of} rows)`, ...(personal ? { include: false } : {}) });
	}
	return { mapping: { version: 1, entityType, fields: proposals.filter((x) => x.include !== false).map(({ basis: _b, include: _i, ...f }) => f) }, proposals, skipped };
}

export function validateMapping(m: SourceMapping, ds?: ParsedDataset): string[] {
	const errors: string[] = [];
	if (!Number.isInteger(m.version) || m.version < 1) errors.push('version must be a positive integer');
	if (!m.entityType || typeof m.entityType !== 'string') errors.push('entityType is required');
	const roles = new Set<string>(), attrs = new Set<string>();
	for (const f of m.fields ?? []) {
		if (!f.source || !f.attribute) { errors.push('every field needs a source column and an attribute'); continue; }
		if (!/^[A-Za-z][A-Za-z0-9_.]{0,79}$/.test(f.attribute)) errors.push(`attribute "${f.attribute}" must start with a letter and use letters, digits, _ or .`);
		if (!['text', 'number', 'money', 'boolean', 'date'].includes(f.type)) errors.push(`${f.attribute}: unknown type ${f.type}`);
		if (f.role) { if (roles.has(f.role) && f.role !== 'id') errors.push(`role ${f.role} is mapped twice`); roles.add(f.role); }
		if (attrs.has(f.attribute)) errors.push(`attribute ${f.attribute} is mapped twice`);
		attrs.add(f.attribute);
		try { assertPermittedAttribute(f.attribute, 'mapping'); } catch (e) { errors.push((e as Error).message); }
		if (ds && !ds.fields.includes(f.source)) errors.push(`column "${f.source}" is not in the source`);
		if (f.role && ['latitude', 'longitude'].includes(f.role) && f.type !== 'number') errors.push(`${f.role} must be a number`);
	}
	if (!(m.fields ?? []).some((f) => !f.role || ['id', 'address', 'name'].includes(f.role))) errors.push('the mapping has no fact columns: map at least one attribute that is not only a key or a location');
	return errors;
}

// ------------------------------------------------------------------ applying a mapping

export interface MappingIssue { row: number; field: string; problem: string; raw: string }
export interface MappedRecords { drafts: ObservationDraft[]; issues: MappingIssue[]; unmapped: string[] }

function convert(f: FieldMapping, raw: Cell): { ok: true; v: ObservedValue } | { ok: false; problem: string } {
	const rawText = raw === null ? null : String(raw);
	let value: Value;
	switch (f.type) {
		case 'text': value = String(raw); break;
		case 'number': { const n = parseNumber(raw); if (n === null) return { ok: false, problem: 'not a number' }; value = n; break; }
		case 'money': { const n = parseNumber(raw); if (n === null) return { ok: false, problem: 'not an amount' }; value = { amount: n, currency: f.currency ?? 'USD' }; break; }
		case 'boolean': { const b = parseBoolean(raw); if (b === null) return { ok: false, problem: 'not yes/no' }; value = b; break; }
		case 'date': { const d = parseDateValue(raw); if (d === null) return { ok: false, problem: 'not an ISO 8601 date' }; value = d; break; }
	}
	return { ok: true, v: { value, raw: rawText, ...(f.unit ? { unit: f.unit } : f.type === 'money' ? { unit: f.currency ?? 'USD' } : {}), transform: f.type === 'money' ? `money(${f.currency ?? 'USD'})` : f.type } };
}

const centroid = (g: Geometry): { lat: number; lng: number } | null => {
	if (g.point) return g.point;
	const ring = g.polygons?.[0]?.[0];
	if (!ring?.length) return null;
	return { lat: ring.reduce((a, p) => a + p[1], 0) / ring.length, lng: ring.reduce((a, p) => a + p[0], 0) / ring.length };
};

export function mapRow(r: RawRow, mapping: SourceMapping, issues: MappingIssue[]): ObservationDraft {
	const attributes: Record<string, ObservedValue> = {};
	const identity: IdentityHints = { ids: {}, address: null, addressKey: null, lat: null, lng: null, name: null };
	let key: string | null = null, validAt: string | null = null;
	for (const f of mapping.fields) {
		const raw = r.props[f.source];
		if (raw === null || raw === undefined || raw === '') continue;
		const c = convert(f, raw);
		if (!c.ok) { issues.push({ row: r.index, field: f.source, problem: c.problem, raw: String(raw) }); continue; }
		const v = c.v;
		switch (f.role) {
			case 'key': key = String(raw); break;
			case 'id': identity.ids[f.attribute] = String(raw); break;
			case 'address': identity.address = String(raw); identity.addressKey = normalizeAddress(String(raw)); break;
			case 'name': identity.name = String(raw); break;
			case 'latitude': identity.lat = v.value as number; continue;
			case 'longitude': identity.lng = v.value as number; continue;
			case 'validAt': validAt = v.value as string; continue;
		}
		attributes[f.attribute] = v;
	}
	if (identity.lat !== null && (identity.lat < -90 || identity.lat > 90)) { issues.push({ row: r.index, field: 'latitude', problem: 'latitude out of range', raw: String(identity.lat) }); identity.lat = null; }
	if (identity.lng !== null && (identity.lng < -180 || identity.lng > 180)) { issues.push({ row: r.index, field: 'longitude', problem: 'longitude out of range (projected coordinates?)', raw: String(identity.lng) }); identity.lng = null; }
	if ((identity.lat === null) !== (identity.lng === null)) { identity.lat = null; identity.lng = null; }
	if (r.geometry) {
		identity.geometry = r.geometry;
		if (identity.lat === null) { const c = centroid(r.geometry); if (c) { identity.lat = c.lat; identity.lng = c.lng; } }
	}
	const idEntry = Object.entries(identity.ids)[0];
	const recordKey = key ?? (idEntry ? `${idEntry[0]}:${idEntry[1]}` : `row-${r.index}`);
	return {
		recordKey, keyBasis: key ? 'source-key' : idEntry ? 'identifier' : 'position', entityType: mapping.entityType, attributes, identity, validAt,
		locator: r.pointer ?? `row ${r.index + 1}`,
	};
}

export function applyMapping(ds: ParsedDataset, mapping: SourceMapping): MappedRecords {
	const errors = validateMapping(mapping, ds);
	if (errors.length) throw new Error(`invalid mapping: ${errors.join('; ')}`);
	const issues: MappingIssue[] = [];
	const seen = new Set<string>();
	const drafts: ObservationDraft[] = [];
	for (const r of ds.rows) {
		const d = mapRow(r, mapping, issues);
		if (seen.has(d.recordKey)) { issues.push({ row: r.index, field: '(key)', problem: `duplicate record key ${d.recordKey}; the first row is kept`, raw: d.recordKey }); continue; }
		seen.add(d.recordKey);
		drafts.push(d);
	}
	const mapped = new Set(mapping.fields.map((f) => f.source));
	return { drafts, issues, unmapped: ds.fields.filter((f) => !mapped.has(f)) };
}

/**
 * Hash of what an observation states — not when it was retrieved, and not the provider's as-of date: a newer
 * as-of with identical values re-confirms the record (it changes freshness, not the information).
 */
export function draftHash(d: ObservationDraft): string {
	return sha256(canonicalJson({ t: d.entityType, a: d.attributes, i: { ...d.identity, geometry: d.identity.geometry ?? null } }));
}
