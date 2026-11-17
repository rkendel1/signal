/**
 * The site analyzer (pure, deterministic): what information does this site make available, how is it
 * structured, how does it change, and can Signal use it reliably and appropriately?
 *
 * Input is SiteEvidence collected in the user's own browser when they asked (lib/site/collect.ts). Nothing here
 * fetches. A JSON response is not assumed to be a feed: it must contain a collection of records that share a
 * structure, ideally with identifiers, before it is ranked as one.
 */
import { canonicalJson, sha256 } from '../core/canonical.ts';
import { extractPage } from '../page/extract.ts';
import { pageTypeSummary } from '../sources/page.ts';
import { robotsAllows } from '../sources/robots.ts';
import { profileFields, proposeMapping } from '../engine/mapping.ts';
import { protectedTerm } from '../engine/policy.ts';
import type { Cell, ParsedDataset } from '../sources/records.ts';
import type { Candidate, CandidateKind, EvidenceResponse, FieldInfo, FieldRole, FieldType, ParamInfo, SiteAnalysis, SiteEvidence } from './types.ts';

export const ANALYZER_VERSION = 'site-analyzer/1.0.0';

// ------------------------------------------------------------------ URLs

export const siteDomain = (host: string) => host.toLowerCase().replace(/^www\./, '');

/** Path segments that carry data (ids, hashes, long numbers) become {placeholders}. */
export function pathTemplate(path: string): string {
	return path.split('/').map((seg) => {
		if (!seg) return seg;
		const [base, ext] = seg.match(/^(.*?)(\.[a-z0-9]{2,8})?$/i)!.slice(1) as [string, string | undefined];
		const dataLike = /\d{4,}/.test(base) || /^[0-9a-f]{16,}$/i.test(base) || /^[0-9a-f-]{32,36}$/i.test(base) || /^[a-z]{2}\d[a-z0-9]{5,}$/i.test(base) || base.includes('@')
			|| (base.length >= 10 && /\d/.test(base) && /[a-z]/.test(base) && /[A-Z]/.test(base)); // opaque ids: org keys, hashes
		return dataLike ? `{${ext ? 'id' : 'segment'}}${ext ?? ''}` : seg;
	}).join('/');
}
export function templateRegex(t: string): RegExp {
	return new RegExp('^' + t.split(/\{[a-z]+\}/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+') + '$');
}

const SENSITIVE = /^(token|access_?token|id_?token|refresh_?token|api_?key|apikey|key|auth|authorization|signature|sig|session|sessionid|sid|jwt|password|passwd|secret|code|state|nonce|email|user|userid|user_id|uid|account|accountid|phone|ssn|client_secret|x-amz-.*|awsaccesskeyid|policy|expires)$/i;
const TRACKING = /^(utm_.*|gclid|fbclid|mc_.*|_ga|_gl|ref|referrer|v|_|cb|cachebust|ts|t|rnd|random)$/i;

export function classifyParam(name: string, value: string): ParamInfo {
	const n = name.toLowerCase();
	const role: ParamInfo['role'] = SENSITIVE.test(name) ? 'credential'
		: TRACKING.test(name) ? 'tracking'
		: /^(page|p|pagenum|pagenumber|page_number|pg)$/.test(n) ? 'page'
		: /^(offset|start|skip|from|startindex)$/.test(n) ? 'offset'
		: /^(cursor|after|before|pagetoken|page_token|next|continuation|scrollid)$/.test(n) ? 'cursor'
		: /^(limit|size|per_?page|pagesize|page_size|num|count|rows|num_homes|max|maxresults)$/.test(n) ? 'size'
		: /(bbox|bounds|poly|polygon|viewport|north|south|east|west|minlat|maxlat|minlon|maxlon|minlng|maxlng|minlatitude|maxlatitude|minlongitude|maxlongitude|latitude|longitude|radius|maxradius|ne_?lat|sw_?lat)/.test(n) ? 'bbox'
		: /^(q|query|search|term|keyword|keywords|text|location)$/.test(n) ? 'query'
		: /^(sort|order|orderby|sort_?by|ord)$/.test(n) ? 'sort'
		: /^(f|format|output|type|callback)$/.test(n) ? 'format'
		: 'filter';
	return { name, role, sensitive: role === 'credential' || /[A-Za-z0-9_-]{32,}/.test(value) && role !== 'bbox', value };
}

// ------------------------------------------------------------------ record collections inside JSON

type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

interface Collection { path: string; records: Rec[]; total: number; keyed: boolean; geojson: boolean }

function flatten(o: Rec, prefix = '', out: Record<string, Cell> = {}, depth = 0): Record<string, Cell> {
	for (const [k, v] of Object.entries(o)) {
		const name = prefix ? `${prefix}.${k}` : k;
		if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[name] = v as Cell;
		else if (isObj(v) && depth < 2) flatten(v, name, out, depth + 1);
		else if (v !== undefined) out[name] = JSON.stringify(v).slice(0, 200);
	}
	return out;
}

/** Shared keys across records: a real collection's members look alike. */
function similarity(records: Rec[]): number {
	if (records.length < 2) return 1;
	const sets = records.slice(0, 20).map((r) => new Set(Object.keys(r)));
	const all = new Set(sets.flatMap((s) => [...s]));
	const common = [...all].filter((k) => sets.filter((s) => s.has(k)).length >= sets.length * 0.6);
	return all.size ? common.length / all.size : 0;
}

/** Every plausible collection of records in a JSON document (arrays of objects, GeoJSON features, keyed maps). */
export function findCollections(doc: unknown, truncated: Record<string, number> = {}): Collection[] {
	const out: Collection[] = [];
	const walk = (v: unknown, path: string, depth: number) => {
		if (depth > 7) return;
		if (Array.isArray(v)) {
			const objs = v.filter(isObj);
			if (objs.length >= 1 && objs.length >= v.length * 0.8) {
				const geojson = objs.every((f) => f.type === 'Feature' && isObj(f.properties));
				const records = geojson ? objs.map((f) => ({ ...(f.id !== undefined ? { id: f.id } : {}), ...(f.properties as Rec), ...(isObj(f.geometry) ? { geometry: f.geometry } : {}) })) : objs;
				out.push({ path, records, total: truncated[path] ?? v.length, keyed: false, geojson });
			}
			v.slice(0, 3).forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1));
			return;
		}
		if (!isObj(v)) return;
		// keyed collections: { "Listing:1": {...}, "Listing:2": {...} } (normalized client state)
		const vals = Object.values(v);
		if (vals.length >= 3 && vals.every(isObj) && similarity(vals as Rec[]) >= 0.5) out.push({ path: path ? `${path}.*` : '*', records: vals as Rec[], total: vals.length, keyed: true, geojson: false });
		for (const [k, x] of Object.entries(v).slice(0, 200)) walk(x, path ? `${path}.${k}` : k, depth + 1);
	};
	walk(doc, '', 0);
	return out;
}

// ------------------------------------------------------------------ fields and roles

const ISO = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
function typeOf(path: string, v: Cell): FieldType {
	if (v === null) return 'null';
	if (typeof v === 'number') return /(^|[._])(time|updated|modified|created|date|timestamp|ts)$/i.test(path) && v > 1e11 && v < 4e12 ? 'datetime' : 'number';
	if (typeof v === 'boolean') return 'boolean';
	if (/^https?:\/\//i.test(v)) return 'url';
	if (ISO.test(v)) return 'datetime';
	if (v.startsWith('{') || v.startsWith('[')) return v.startsWith('[') ? 'array' : 'object';
	return 'string';
}

function roleOf(path: string, type: FieldType, distinct: number, presence: number, n: number): FieldRole | undefined {
	const leaf = path.split('.').pop()!.toLowerCase();
	if (/^(id|uuid|guid|key|@id|code|slug|sku|mlsid|mls|zpid|listingid|propertyid|propertyId|objectid|eventid)$/i.test(leaf) && presence === 1 && (distinct === 1 || n < 2)) return 'id';
	if (type === 'url') return /detail|api|json|geojson/.test(leaf) ? 'detail_link' : 'url';
	if (/^(updated|updatedat|updated_at|modified|lastmodified|last_modified|lastupdated|last_updated|datemodified)$/.test(leaf)) return 'updated';
	if (/^(time|date|created|createdat|created_at|listdate|listed|published|datepublished|starttime)$/.test(leaf)) return 'time';
	if (/^(lat|latitude)$/.test(leaf)) return 'latitude';
	if (/^(lng|lon|long|longitude)$/.test(leaf)) return 'longitude';
	if (leaf === 'geometry' || leaf === 'coordinates') return 'geometry';
	if (/^(address|streetaddress|street|fulladdress|addressline1)$/.test(leaf)) return 'address';
	if (/^(name|title|headline|place)$/.test(leaf)) return 'name';
	if (/price|amount|cost/.test(leaf) && type === 'number') return 'price';
	if (/^(status|state|listingstatus)$/.test(leaf)) return 'status';
	return undefined;
}

function fieldsOf(records: Rec[]): { fields: FieldInfo[]; flat: Array<Record<string, Cell>> } {
	const flat = records.map((r) => flatten(r));
	const names = [...new Set(flat.flatMap((f) => Object.keys(f)))].slice(0, 150);
	const fields = names.map((path) => {
		const vals = flat.map((f) => f[path]).filter((v) => v !== null && v !== undefined);
		const type = vals.length ? typeOf(path, vals[0] as Cell) : 'null';
		const presence = flat.length ? vals.length / flat.length : 0;
		const distinct = vals.length ? new Set(vals.map(String)).size / vals.length : 0;
		const role = roleOf(path, type, distinct, presence, flat.length);
		return { path, type, presence: Math.round(presence * 100) / 100, distinct: Math.round(distinct * 100) / 100, ...(role ? { role } : {}), samples: [...new Set(vals.map((v) => String(v).slice(0, 80)))].slice(0, 3) };
	}).filter((f) => !protectedTerm(f.path));
	return { fields, flat };
}

// ------------------------------------------------------------------ candidates

const PAGINATION_FIELDS = /^(next|nextpage|next_page|nextcursor|next_cursor|cursor|hasmore|has_more|hasnextpage|total|totalcount|total_count|totalresults|count|pages|totalpages|metadata\.count|paging|pageinfo)$/i;

function responseFields(doc: unknown): string[] {
	if (!isObj(doc)) return [];
	const found: string[] = [];
	const walk = (o: Rec, prefix: string, d: number) => { for (const [k, v] of Object.entries(o)) { const p = prefix ? `${prefix}.${k}` : k; if (PAGINATION_FIELDS.test(k) || PAGINATION_FIELDS.test(p)) found.push(p); if (isObj(v) && d < 2) walk(v, p, d + 1); } };
	walk(doc, '', 0);
	return found.slice(0, 10);
}
function declaredTotal(doc: unknown): number | null {
	if (!isObj(doc)) return null;
	for (const p of ['total', 'totalCount', 'total_count', 'totalResults', 'count', 'metadata.count', 'payload.total', 'data.total']) {
		const v = p.split('.').reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), doc);
		if (typeof v === 'number') return v;
	}
	return null;
}

function bestCollection(cols: Collection[]): Collection | null {
	const scored = cols.map((c) => ({ c, s: Math.min(c.total, 200) * (1 + Object.keys(c.records[0] ?? {}).length / 10) * similarity(c.records) }));
	scored.sort((a, b) => b.s - a.s);
	return scored[0]?.c ?? null;
}

function scoreCandidate(c: Omit<Candidate, 'score' | 'breakdown'>): Pick<Candidate, 'score' | 'breakdown'> {
	const typed = c.fields.filter((f) => f.presence >= 0.5 && f.type !== 'null').length;
	const f = (factor: string, value: number, weight: number, why: string) => ({ factor, value: Math.round(value * 100) / 100, weight, why });
	const structured = { json_endpoint: 1, geojson_endpoint: 1, download: 0.9, embedded_state: 0.8, json_ld: 0.6, dom: 0.3 }[c.kind];
	const breakdown = [
		f('structure', structured, 0.15, c.kind.replace('_', ' ')),
		f('semantic richness', Math.min(1, typed / 12), 0.15, `${typed} consistently present fields`),
		f('records', Math.min(1, c.recordCount / 20), 0.1, `${c.declaredTotal ?? c.recordCount} records${c.declaredTotal && c.declaredTotal > c.recordCount ? ` declared, ${c.recordCount} returned` : ''}`),
		f('stable identifiers', c.identifier ? 1 : 0, 0.15, c.identifier ? `${c.identifier.path} (${c.identifier.basis})` : 'no field identifies records'),
		f('change detection', Math.min(1, (c.change.conditional ? 0.5 : 0) + (c.change.recordUpdatedField ? 0.5 : 0) + (c.change.live ? 0.5 : 0)), 0.15, [c.change.conditional && `conditional GET (${c.change.conditional})`, c.change.recordUpdatedField && `per-record ${c.change.recordUpdatedField}`, c.change.live].filter(Boolean).join(', ') || 'none observed'),
		f('traversal', c.pagination.kind === 'unknown' ? 0.3 : c.pagination.kind === 'none' ? (c.completeness === 'complete' ? 0.8 : 0.4) : 1, 0.1, c.pagination.kind === 'none' ? `no pagination; ${c.completeness}` : `${c.pagination.kind} pagination`),
		f('access', !c.access.automatable ? 0 : c.access.auth === 'public' ? 1 : c.access.auth === 'session' ? 0.5 : 0.6, 0.2, `${c.access.auth} access, robots ${c.access.robots}`),
	];
	return { score: Math.round(breakdown.reduce((s, b) => s + b.value * b.weight, 0) * 100) / 100, breakdown };
}

function suggestAttributes(flat: Array<Record<string, Cell>>, fields: FieldInfo[]): void {
	if (!flat.length) return;
	const names = fields.map((f) => f.path);
	const ds: ParsedDataset = { format: 'json', fields: names, rows: flat.slice(0, 50).map((props, index) => ({ index, props: Object.fromEntries(names.map((n) => [n, props[n] ?? null])) })) };
	const { proposals } = proposeMapping(ds, 'record', profileFields(ds));
	for (const p of proposals) { const fi = fields.find((x) => x.path === p.source); if (fi && p.include !== false && fi.role !== 'id' && !(p.role && ['latitude', 'longitude'].includes(p.role) && fi.role !== p.role)) fi.suggestedAttribute = p.attribute; }
}

interface Ctx { ev: SiteEvidence; origin: string; domain: string; robots: (url: URL) => 'allowed' | 'disallowed' | 'unknown' }

function makeCandidate(ctx: Ctx, kind: CandidateKind, label: string, doc: unknown, truncated: Record<string, number>, extra: { response?: EvidenceResponse; embedded?: { kind: string; name: string } }): Candidate | null {
	// A GeoJSON Feature at the root is one record (an entity detail), whatever arrays it contains.
	const col = isObj(doc) && doc.type === 'Feature' && isObj(doc.properties)
		? { path: '', records: [{ ...(doc.id !== undefined ? { id: doc.id } : {}), ...(doc.properties as Rec), ...(isObj(doc.geometry) ? { geometry: doc.geometry } : {}) }], total: 1, keyed: false, geojson: true }
		: bestCollection(findCollections(doc, truncated));
	const r = extra.response;
	const u = r ? new URL(r.url) : null;
	const params = u ? [...u.searchParams].map(([n, v]) => classifyParam(n, v)) : [];
	const endpoint = u ? { origin: u.origin, pathTemplate: pathTemplate(u.pathname), params, url: r!.url } : null;
	const why: string[] = [], limitations: string[] = [];
	const records = col?.records ?? [];
	const { fields, flat } = fieldsOf(records);
	suggestAttributes(flat, fields);
	const idField = fields.find((f) => f.role === 'id');
	const identifier = idField ? { path: idField.path, basis: col?.geojson && idField.path === 'id' ? 'GeoJSON feature id' : records.length > 1 ? 'unique and always present in this response' : 'named like an identifier (one record: uniqueness not verified)' } : null;
	const updated = fields.find((f) => f.role === 'updated');
	const relations = fields.filter((f) => f.role === 'detail_link' || f.role === 'url').map((f) => {
		const s = f.samples?.[0]; let t = '';
		try { const x = new URL(s!); t = `${x.origin}${pathTemplate(x.pathname)}`; } catch { /* not a URL */ }
		return { field: f.path, kind: f.role === 'detail_link' ? 'detail_link' as const : 'page_link' as const, targetTemplate: t };
	}).filter((x) => x.targetTemplate.includes('{')); // a link without a varying part is a constant URL, not a relation
	const pagParams = params.filter((p) => ['page', 'offset', 'cursor', 'size'].includes(p.role));
	const respFields = responseFields(doc);
	const pagination = { kind: (pagParams.find((p) => p.role === 'cursor') || respFields.some((f) => /cursor|next/i.test(f)) ? 'cursor' : pagParams.find((p) => p.role === 'page') ? 'page' : pagParams.find((p) => p.role === 'offset') ? 'offset' : respFields.length || !endpoint ? 'none' : 'unknown') as Candidate['pagination']['kind'], params: pagParams.map((p) => p.name), responseFields: respFields };
	const total = declaredTotal(doc);
	const returned = col ? col.total : 0;
	const completeness: Candidate['completeness'] = total !== null ? (total <= returned ? 'complete' : 'partial') : pagination.kind === 'none' && endpoint ? 'complete' : 'unknown';
	const maxAge = r?.cacheControl ? Number(/max-age=(\d+)/.exec(r.cacheControl)?.[1] ?? NaN) : NaN;
	const change: Candidate['change'] = { conditional: r?.etag ? 'etag' : r?.lastModified ? 'last-modified' : null, maxAgeSeconds: Number.isFinite(maxAge) ? maxAge : null, recordUpdatedField: updated?.path ?? null, live: null }; // push channels (WebSocket, SSE) are not observable from the page: SiteEvidence.observed
	const robots = u ? ctx.robots(u) : 'allowed';
	const auth: Candidate['access']['auth'] = !r ? 'unknown' : r.anonymous === null ? 'unknown' : r.anonymous.status >= 400 || (r.records !== null && r.anonymous.records !== null && r.anonymous.records < r.records) ? 'session' : r.anonymous.status < 300 ? 'public' : 'unknown';
	const needsCredential = params.some((p) => p.role === 'credential' || p.sensitive);
	const access = { auth: needsCredential && auth === 'public' ? 'session' as const : auth, robots, automatable: robots !== 'disallowed', sameOrigin: !u || u.origin === ctx.origin };

	let verdict: Candidate['verdict'];
	if (!col || !records.length) { verdict = 'not_records'; why.push('no collection of records in the response'); }
	else if (robots === 'disallowed') { verdict = 'disallowed'; why.push('the site\'s robots.txt disallows automated access to this path'); }
	else if (records.length === 1 && fields.length >= 5) { verdict = 'detail'; why.push('a single record with many fields: an entity detail representation'); }
	else if (!identifier && !fields.some((f) => f.role && f.role !== 'status')) { verdict = 'metadata'; why.push('records without identifiers, names, times or locations: configuration or enumerations, not entities'); }
	else if (similarity(records) < 0.4) { verdict = 'not_records'; why.push('array members do not share a structure'); }
	else { verdict = 'feed'; why.push(`${col.total} records sharing ${fields.filter((f) => f.presence >= 0.9).length} fields`); }
	if (verdict === 'feed' && !identifier) limitations.push('no stable identifier: changes cannot be tracked per record');
	if (col && col.total > records.length) why.push(`collector trimmed ${col.total} records to ${records.length} for analysis`);
	if (completeness === 'partial') limitations.push(`returns ${returned} of ${total} declared records; traversal needed for completeness`);
	if (access.auth === 'session') limitations.push('depends on the signed-in user\'s session: each user must use their own access, from their browser');
	if (needsCredential) limitations.push('the request carries a credential-like parameter; its value is never shared');
	if (!change.conditional && !change.recordUpdatedField && verdict === 'feed') limitations.push('no change mechanism observed: every refresh must be compared in full');
	if (kind === 'embedded_state') limitations.push('embedded in the page: available only when the page is loaded (capture), not as a separate request');
	if (kind === 'json_ld') limitations.push('JSON-LD describes the page\'s main subject; usually one entity per page');
	const key = sha256(canonicalJson([ctx.domain, kind, endpoint ? `${endpoint.origin}${endpoint.pathTemplate}` : extra.embedded?.name ?? label, [...params.map((p) => p.name)].sort(), col?.path ?? null])).slice(0, 24);
	const base = {
		key, kind, label, endpoint, embedded: extra.embedded ?? null, recordsPath: col?.path ?? null, format: col?.geojson ? 'geojson' as const : endpoint ? 'json' as const : null,
		responsePrefix: r?.prefix ?? null, recordCount: records.length, declaredTotal: total ?? (col && col.total !== records.length ? col.total : null),
		entityHint: col && col.path ? (col.path.split(/[.[\]*]/).filter((s) => s && !/^\d+$/.test(s)).pop() ?? null) : null,
		fields, identifier, relations, pagination, filters: params.filter((p) => ['bbox', 'query', 'filter', 'sort'].includes(p.role)).map((p) => ({ param: p.name, kind: p.role })),
		change, access, completeness, verdict, why, limitations, duplicates: [], idSample: idField ? flat.map((f) => String(f[idField.path])).slice(0, 200) : [],
	};
	return { ...base, ...scoreCandidate(base) };
}

export function analyzeSite(ev: SiteEvidence): SiteAnalysis {
	const t0 = performance.now();
	const page = new URL(ev.url);
	const ctx: Ctx = {
		ev, origin: page.origin, domain: siteDomain(page.hostname),
		robots: (u) => {
			if (u.origin !== page.origin) return 'unknown'; // another host's robots.txt was not read
			if (!ev.robots) return 'unknown';
			if (ev.robots.status >= 400 && ev.robots.status < 500) return 'allowed'; // RFC 9309: no robots.txt, no restrictions
			if (ev.robots.status >= 500 || ev.robots.text === null) return 'unknown';
			return robotsAllows(ev.robots.text, u.pathname + u.search) ? 'allowed' : 'disallowed';
		},
	};
	const candidates: Candidate[] = [];
	for (const r of ev.responses) {
		if (r.skipped || r.json === null || r.json === undefined) continue;
		const isGeo = isObj(r.json) && r.json.type === 'FeatureCollection';
		const c = makeCandidate(ctx, isGeo ? 'geojson_endpoint' : 'json_endpoint', new URL(r.url).pathname.split('/').filter(Boolean).slice(-2).join('/') || r.url, r.json, r.truncated, { response: r });
		if (c) candidates.push(c);
	}
	for (const e of ev.embedded) {
		const c = makeCandidate(ctx, 'embedded_state', `${e.kind}: ${e.name}`, e.json, e.truncated, { embedded: { kind: e.kind, name: e.name } });
		if (c) candidates.push(c);
	}
	const jsonLdTypes = [...new Set(ev.jsonLd.flatMap((j) => (Array.isArray(j) ? j : isObj(j) && Array.isArray(j['@graph']) ? j['@graph'] : [j])).filter(isObj).map((o) => String(o['@type'] ?? '')).filter(Boolean))];
	if (ev.jsonLd.length) { const c = makeCandidate(ctx, 'json_ld', 'JSON-LD', { items: ev.jsonLd.flatMap((j) => (isObj(j) && Array.isArray(j['@graph']) ? j['@graph'] : Array.isArray(j) ? j : [j])) }, {}, {}); if (c) candidates.push(c); }

	let surface: SiteAnalysis['surface'] = { types: [], entities: 0, jsonLdTypes };
	if (ev.snapshot) {
		const rep = extractPage({ html: ev.snapshot, locator: ev.url, baseUrl: ev.url, observationId: 'analysis', contentHash: sha256(ev.snapshot), contentType: 'text/html', observedAt: ev.collectedAt });
		surface = { types: pageTypeSummary(rep).map(({ type, count }) => ({ type, count })).slice(0, 12), entities: rep.entities.length, jsonLdTypes };
		const listed = surface.types.filter((t) => !['WebPage', 'Unknown', 'BreadcrumbList', 'SiteNavigationElement', 'WPHeader', 'WPFooter'].includes(t.type));
		if (listed.length) {
			const base = {
				key: sha256(canonicalJson([ctx.domain, 'dom', pathTemplate(page.pathname)])).slice(0, 24), kind: 'dom' as const, label: `page: ${listed.slice(0, 3).map((t) => `${t.type} ×${t.count}`).join(', ')}`,
				endpoint: null, embedded: null, recordsPath: null, format: null, responsePrefix: null, recordCount: listed.reduce((n, t) => n + t.count, 0), declaredTotal: null, entityHint: listed[0].type,
				fields: [], identifier: null, relations: [], pagination: { kind: 'unknown' as const, params: [], responseFields: [] }, filters: [],
				change: { conditional: null, maxAgeSeconds: null, recordUpdatedField: null, live: null }, access: { auth: 'session' as const, robots: 'allowed' as const, automatable: false, sameOrigin: true },
				completeness: 'partial' as const, verdict: 'surface' as const, why: ['items recognised in the rendered page'], limitations: ['what the page displayed to this user, captured by them: partial and user-initiated'], duplicates: [],
			};
			candidates.push({ ...base, ...scoreCandidate(base) });
		}
	}
	// The same endpoint requested with different parameter values (map tiles, pages) is one candidate: keep the richest.
	const byKey = new Map<string, Candidate>();
	for (const c of candidates) { const k = byKey.get(c.key); if (!k || c.recordCount > k.recordCount) byKey.set(c.key, c); }
	candidates.splice(0, candidates.length, ...byKey.values());
	// Duplicate feeds: different representations of the same records (by identifier values; private samples).
	for (const a of candidates) for (const b of candidates) {
		if (a === b || !a.idSample?.length || !b.idSample?.length) continue;
		const sb = new Set(b.idSample);
		const overlap = a.idSample.filter((x) => sb.has(x)).length / Math.min(a.idSample.length, b.idSample.length);
		if (overlap >= 0.5) a.duplicates.push(b.key);
	}
	const order = { feed: 0, detail: 1, surface: 2, disallowed: 3, metadata: 4, not_records: 5 };
	candidates.sort((a, b) => order[a.verdict] - order[b.verdict] || b.score - a.score);
	return {
		site: { domain: ctx.domain, origin: page.origin }, page: { url: ev.url, pathTemplate: pathTemplate(page.pathname), title: ev.title.slice(0, 200) },
		candidates, surface, observed: ev.observed, analyzerVersion: ANALYZER_VERSION, durationMs: Math.round(performance.now() - t0),
	};
}
