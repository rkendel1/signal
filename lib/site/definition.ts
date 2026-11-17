/**
 * Shared site knowledge (pure). A FeedDefinition describes HOW a site exposes information; it never carries a
 * user's values, parameters, session material or records. `toDefinition` drops private fields by construction
 * and `assertShareable` checks the result independently against everything the user's browser observed.
 */
import { canonicalJson, sha256 } from '../core/canonical.ts';
import type { SourceMapping, FieldMapping } from '../engine/mapping.ts';
import { pathTemplate, templateRegex } from './analyze.ts';
import type { Candidate, FeedDefinition, SiteAnalysis, SiteEvidence } from './types.ts';

export function structureHash(c: Pick<Candidate, 'fields' | 'recordsPath' | 'identifier'>): string {
	return sha256(canonicalJson([c.recordsPath, c.identifier?.path ?? null, c.fields.filter((f) => f.presence >= 0.5).map((f) => [f.path, f.type]).sort()])).slice(0, 24);
}

export function toDefinition(c: Candidate, a: SiteAnalysis): FeedDefinition {
	return {
		schema: 'signal.site-feed/v1', site: a.site.domain, kind: c.kind, label: c.label,
		endpoint: c.endpoint ? { origin: c.endpoint.origin, pathTemplate: c.endpoint.pathTemplate, params: c.endpoint.params.map(({ name, role, sensitive }) => ({ name, role, sensitive })) } : null,
		embedded: c.embedded, recordsPath: c.recordsPath, format: c.format, responsePrefix: c.responsePrefix && KNOWN_PREFIXES.includes(c.responsePrefix.trim()) ? c.responsePrefix.trim() : null,
		entityHint: c.entityHint, fields: c.fields.map(({ samples: _s, ...f }) => f), identifier: c.identifier, relations: c.relations,
		pagination: c.pagination, filters: c.filters, change: c.change, access: c.access, completeness: c.completeness, verdict: c.verdict,
		limitations: c.limitations, score: c.score, breakdown: c.breakdown, pages: [a.page.pathTemplate], structureHash: structureHash(c),
		provenance: { analyzerVersion: a.analyzerVersion, discoveredAt: new Date().toISOString().slice(0, 10) },
	};
}

/** Anti-JSON-hijacking prefixes some APIs put before JSON. Anything else is not shared. */
export const KNOWN_PREFIXES = ['{}&&', ")]}'", 'while(1);', 'for(;;);'];

const SECRETISH = [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, /[A-Za-z0-9+_-]{40,}/, /[0-9a-f]{32,}/i, /[^\s@/]+@[^\s@/]+\.[a-z]{2,}/i];
/** Keys whose strings come from the site (not from Signal's own vocabulary). Only these are checked against observed values. */
const FREE = new Set(['label', 'pathTemplate', 'targetTemplate', 'pages']);

/** Every string the user's browser observed that is not structure: values, parameters, the page URL's query. */
export function privateStrings(ev: SiteEvidence): Set<string> {
	const out = new Set<string>();
	const add = (s: unknown) => { if (typeof s === 'string' && s.length >= 6) out.add(s); else if (typeof s === 'number' && String(s).length >= 6) out.add(String(s)); };
	const walk = (v: unknown, d = 0) => { if (d > 8) return; if (Array.isArray(v)) v.slice(0, 60).forEach((x) => walk(x, d + 1)); else if (v && typeof v === 'object') Object.values(v).forEach((x) => walk(x, d + 1)); else add(v); };
	for (const u of [ev.url, ...ev.responses.map((r) => r.url), ...ev.resources.map((r) => r.url)]) { try { const x = new URL(u); for (const [, val] of x.searchParams) add(val); } catch { /* ignore */ } }
	ev.responses.forEach((r) => walk(r.json)); ev.embedded.forEach((e) => walk(e.json)); walk(ev.jsonLd);
	return out;
}

/**
 * Throws if a definition carries anything that looks like private data or a secret. Strings that come from the
 * site's structure (labels, templates, record paths) must not equal a value the user's browser observed; no
 * string anywhere may look like a token, key or e-mail address. Field and parameter names may coincide with
 * values (schemas list their own field names) but may not look like secrets.
 */
export function assertShareable(def: FeedDefinition, priv: Set<string>): void {
	const problems: string[] = [];
	const walk = (v: unknown, at: string, free: boolean) => {
		if (typeof v === 'string') {
			if (free && priv.has(v)) problems.push(`${at}: a value observed in the user's data`);
			for (const piece of v.split('/')) for (const re of SECRETISH) if (re.test(piece) && !/^\{.*\}$/.test(piece)) problems.push(`${at}: looks like a secret, token or address`);
		} else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`, free));
		else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, at ? `${at}.${k}` : k, FREE.has(k) && !/^(endpoint\.params|fields)/.test(at));
	};
	walk({ ...def, structureHash: '', provenance: {}, limitations: [], breakdown: [] }, '', false);
	if (problems.length) throw new Error(`not shareable: ${[...new Set(problems)].slice(0, 5).join('; ')}`);
}

/** Does a user's concrete URL instantiate this definition? Their parameter VALUES are theirs; names must be known. */
export function matchesDefinition(def: FeedDefinition, url: string): { ok: boolean; reason?: string } {
	if (!def.endpoint) return { ok: false, reason: 'this definition is not a requestable endpoint (embedded data or page content: use page capture)' };
	let u: URL;
	try { u = new URL(url); } catch { return { ok: false, reason: 'not a URL' }; }
	if (u.origin !== def.endpoint.origin) return { ok: false, reason: `expected ${def.endpoint.origin}` };
	if (!templateRegex(def.endpoint.pathTemplate).test(u.pathname)) return { ok: false, reason: `path does not match ${def.endpoint.pathTemplate}` };
	const known = new Set(def.endpoint.params.map((p) => p.name));
	const unknown = [...u.searchParams.keys()].filter((k) => !known.has(k));
	if (unknown.length) return { ok: false, reason: `unknown parameters: ${unknown.join(', ')}` };
	return { ok: true };
}

/** A starting mapping for a user's connection, from the definition's field roles and suggested attributes. */
export function mappingFor(def: FeedDefinition, entityType: string): SourceMapping {
	const fields: FieldMapping[] = [];
	const used = new Set<string>();
	const push = (f: FieldMapping) => {
		if (used.has(f.attribute) || fields.some((x) => x.source === f.source)) return;
		if (f.role && fields.some((x) => x.role === f.role)) { const { role: _r, ...plain } = f; f = plain; } // one field per identity role
		used.add(f.attribute); fields.push(f);
	};
	if (def.identifier) push({ source: def.identifier.path, attribute: def.identifier.path.split('.').pop()!.replace(/^@/, '') || 'id', type: 'text', role: 'key' });
	for (const f of def.fields) {
		if (f.presence < 0.2 || ['object', 'array', 'null'].includes(f.type) || f.role === 'geometry' || (def.format === 'geojson' && f.path.startsWith('geometry'))) continue; // GeoJSON geometry gives the location
		const attribute = (f.suggestedAttribute ?? f.path.replace(/[^A-Za-z0-9]+(.)?/g, (_m, ch: string | undefined) => (ch ? ch.toUpperCase() : ''))).replace(/^[^A-Za-z]+/, '') || 'field';
		const role = f.role === 'latitude' ? 'latitude' : f.role === 'longitude' ? 'longitude' : f.role === 'address' ? 'address' : f.role === 'name' ? 'name' : undefined;
		const type = f.type === 'number' ? 'number' : f.type === 'boolean' ? 'boolean' : f.type === 'datetime' ? (fieldIsEpoch(f.path, def) ? 'number' : 'date') : 'text';
		push({ source: f.path, attribute, type, ...(role ? { role } : {}) });
	}
	return { version: 1, entityType, fields: fields.slice(0, 60) };
}
const fieldIsEpoch = (path: string, def: FeedDefinition) => /(^|[._])(time|updated|modified|created|date|timestamp|ts)$/i.test(path) && def.fields.find((f) => f.path === path)?.type === 'datetime' && def.format === 'geojson';

/**
 * Verification against an actual acquisition: do the records still have the structure the definition describes?
 * `records` are flattened source rows (what the mapping reads).
 */
export function conformance(def: FeedDefinition, records: Array<Record<string, unknown>>): { ok: boolean; score: number; missing: string[]; identifierOk: boolean; records: number } {
	if (!records.length) return { ok: false, score: 0, missing: [], identifierOk: false, records: 0 };
	// GeoJSON geometry is read as the record's location, not as properties.
	const expected = def.fields.filter((f) => f.presence >= 0.9 && f.type !== 'null' && !(def.format === 'geojson' && f.path.startsWith('geometry')));
	const missing = expected.filter((f) => records.filter((r) => r[f.path] !== undefined && r[f.path] !== null).length / records.length < Math.max(0, f.presence - 0.2)).map((f) => f.path);
	const score = expected.length ? (expected.length - missing.length) / expected.length : 1;
	const ids = def.identifier ? records.map((r) => r[def.identifier!.path]) : [];
	const identifierOk = !def.identifier || (ids.every((x) => x !== undefined && x !== null) && new Set(ids.map(String)).size === ids.length);
	return { ok: score >= 0.8 && identifierOk, score: Math.round(score * 100) / 100, missing, identifierOk, records: records.length };
}

export { pathTemplate };
