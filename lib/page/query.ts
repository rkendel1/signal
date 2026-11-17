/**
 * Deterministic evaluation of `entity` conditions against signal.page/v1.
 * The criteria never need to know which website produced the representation.
 */
import { canonicalJson } from '../core/canonical.ts';
import type { AttributeValue, PageAttribute, PageEntity, PageRepresentation } from './types.ts';

export type EntityOp =
	| 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'contains' | 'not_contains' | 'matches' | 'in'
	| 'exists' | 'absent' | 'changed' | 'unchanged' | 'increased' | 'decreased' | 'between' | 'overlaps';

export interface AttrPredicate {
	/** Attribute name, or a dotted path through relationships: `offers.price`, `hiringOrganization.name`. */
	attr: string;
	op: EntityOp;
	value?: unknown;
	caseSensitive?: boolean;
	/** For money values: only values in this currency satisfy the predicate. */
	currency?: string;
}

export interface EntitySpec {
	type?: string | string[];
	where?: AttrPredicate[];
	related?: Array<{ rel: string; direction?: 'out' | 'in'; entity?: EntitySpec }>;
	inCollection?: { kind?: string; itemType?: string };
}

export interface EntityCondition extends EntitySpec {
	/** present (default): in this observation. added / removed: compared with the previous observation, by entity id. */
	state?: 'present' | 'added' | 'removed';
	quantifier?: 'any' | 'all' | 'none';
	count?: { op: 'eq' | 'gt' | 'gte' | 'lt' | 'lte'; value: number };
}

/**
 * Documented aliases: when an entity lacks the attribute itself, these paths are tried, in order.
 * schema.org puts price and availability on the Offer, and salary on a MonetaryAmount.
 */
export const ATTRIBUTE_ALIASES: Record<string, string[]> = {
	price: ['offers.price', 'offers.lowPrice'],
	priceCurrency: ['offers.priceCurrency'],
	availability: ['offers.availability'],
	seller: ['seller.name', 'offers.seller.name'],
	compensation: ['baseSalary.amount', 'estimatedSalary.amount'],
	hiringOrganization: ['hiringOrganization.name'],
	author: ['author.name'],
	date: ['datePublished', 'datePosted', 'dateCreated'],
	datePublished: ['date'],
	name: ['headline', 'title']
};

export interface EntityMatch {
	id: string;
	type: string;
	name: string | null;
	values: Record<string, AttributeValue[]>;
	previous?: Record<string, AttributeValue[]>;
	evidenceRefs: string[];
}

export interface EntityResult {
	matched: boolean;
	note?: string;
	candidates: number;
	matches: EntityMatch[];
	/** Entities whose continuity across observations cannot be established (ambiguous or positional identity):
	 *  never reported as added/removed/changed. */
	uncertain: Array<{ id: string; reason: string }>;
}

/** Continuity across observations needs a non-ambiguous, non-positional identity. */
export function continuityOf(e: PageEntity): string | null {
	if (e.identity?.ambiguous) return 'ambiguous identity: another entity on the page has the same type and name';
	if (e.identity?.strength === 'positional') return 'positional identity: tied to the DOM path, which moves with the layout';
	return null;
}

class Index {
	readonly page: PageRepresentation;
	readonly byId: Map<string, PageEntity>;
	constructor(page: PageRepresentation) {
		this.page = page;
		this.byId = new Map(page.entities.map((e) => [e.id, e]));
	}
	out(id: string, rel: string): PageEntity[] {
		return this.page.relationships.filter((r) => r.from === id && r.type === rel).map((r) => this.byId.get(r.to)).filter((e): e is PageEntity => !!e);
	}
	in(id: string, rel: string): PageEntity[] {
		return this.page.relationships.filter((r) => r.to === id && r.type === rel).map((r) => this.byId.get(r.from)).filter((e): e is PageEntity => !!e);
	}
	/** All attributes reachable by `path` from entity `e` (own first, then aliases). */
	resolve(e: PageEntity, path: string, depth = 0): PageAttribute[] {
		if (depth > 4) return [];
		const parts = path.split('.');
		if (parts.length === 1) {
			const own = e.attributes.filter((a) => a.name === path);
			if (own.length || depth > 0) return own;
			for (const alias of ATTRIBUTE_ALIASES[path] ?? []) {
				const r = this.resolve(e, alias, depth + 1);
				if (r.length) return r;
			}
			return [];
		}
		const [head, ...rest] = parts;
		return this.out(e.id, head).flatMap((x) => this.resolve(x, rest.join('.'), depth + 1));
	}
}

const numeric = (v: AttributeValue, currency?: string): number | [number, number] | null => {
	if (typeof v === 'number') return v;
	if (v && typeof v === 'object') {
		if ('amount' in v) return currency && v.currency && v.currency !== currency ? null : (v as { amount: number }).amount;
		if ('min' in v) return currency && v.currency && v.currency !== currency ? null : [(v as { min: number }).min, (v as { max: number }).max];
		if ('best' in v) return (v as { value: number }).value;
	}
	if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) { const t = Date.parse(v); return isNaN(t) ? null : t; }
	return null;
};
const target = (x: unknown): number | null => {
	if (typeof x === 'number') return x;
	if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x)) { const t = Date.parse(x); return isNaN(t) ? null : t; }
	return null;
};
const asText = (v: AttributeValue): string => (v === null ? '' : typeof v === 'object' ? ('url' in v ? String((v as { url: string | null }).url ?? '') : canonicalJson(v)) : String(v));

/** Does one attribute value satisfy a (non-change) predicate? */
function valueSatisfies(v: AttributeValue, p: AttrPredicate): boolean {
	if (v === null) return false;
	const cs = p.caseSensitive ?? false;
	const norm = (s: string) => (cs ? s : s.toLowerCase());
	switch (p.op) {
		case 'eq': return typeof p.value === 'string' ? norm(asText(v)) === norm(p.value) : canonicalJson(v) === canonicalJson(p.value) || numeric(v, p.currency) === p.value;
		case 'neq': return !valueSatisfies(v, { ...p, op: 'eq' });
		case 'contains': return norm(asText(v)).includes(norm(String(p.value)));
		case 'not_contains': return !norm(asText(v)).includes(norm(String(p.value)));
		case 'matches': return new RegExp(String(p.value), cs ? '' : 'i').test(asText(v));
		case 'in': return Array.isArray(p.value) && p.value.some((x) => valueSatisfies(v, { ...p, op: 'eq', value: x }));
		case 'lt': case 'lte': case 'gt': case 'gte': {
			const n = numeric(v, p.currency), t = target(p.value);
			if (n === null || t === null) return false;
			// Ranges: "below t" if the range starts below t; "above t" if it reaches above t.
			const lo = Array.isArray(n) ? n[0] : n, hi = Array.isArray(n) ? n[1] : n;
			return p.op === 'lt' ? lo < t : p.op === 'lte' ? lo <= t : p.op === 'gt' ? hi > t : hi >= t;
		}
		case 'between': case 'overlaps': {
			const n = numeric(v, p.currency);
			const [a, b] = Array.isArray(p.value) ? p.value.map(target) : [null, null];
			if (n === null || a === null || b === null) return false;
			const lo = Array.isArray(n) ? n[0] : n, hi = Array.isArray(n) ? n[1] : n;
			return p.op === 'between' ? lo >= a && hi <= b : hi >= a && lo <= b;
		}
		default: return false;
	}
}

function predicate(ix: Index, prevIx: Index | null, e: PageEntity, p: AttrPredicate): { ok: boolean; values: AttributeValue[]; previous?: AttributeValue[]; uncertain?: true } {
	const attrs = ix.resolve(e, p.attr);
	const values = attrs.map((a) => a.value);
	if (p.op === 'exists') return { ok: values.some((v) => v !== null), values };
	if (p.op === 'absent') return { ok: values.every((v) => v === null), values };
	if (['changed', 'unchanged', 'increased', 'decreased'].includes(p.op)) {
		if (continuityOf(e)) return { ok: false, values, uncertain: true };
		const before = prevIx?.byId.get(e.id);
		if (!before) return { ok: false, values };
		const prev = prevIx!.resolve(before, p.attr).map((a) => a.value);
		if (p.op === 'changed') return { ok: canonicalJson(values) !== canonicalJson(prev), values, previous: prev };
		if (p.op === 'unchanged') return { ok: canonicalJson(values) === canonicalJson(prev), values, previous: prev };
		const a = values.map((v) => numeric(v, p.currency)).find((x) => typeof x === 'number') as number | undefined;
		const b = prev.map((v) => numeric(v, p.currency)).find((x) => typeof x === 'number') as number | undefined;
		if (a === undefined || b === undefined) return { ok: false, values, previous: prev };
		return { ok: p.op === 'increased' ? a > b : a < b, values, previous: prev };
	}
	return { ok: values.some((v) => valueSatisfies(v, p)), values };
}

function typeMatches(e: PageEntity, t: EntitySpec['type']): boolean {
	if (!t) return true;
	const types = Array.isArray(t) ? t : [t];
	return types.includes(e.type) || e.attributes.some((a) => a.name === 'additionalType' && types.includes(String(a.value)));
}

function specMatches(ix: Index, prevIx: Index | null, e: PageEntity, spec: EntitySpec, depth = 0): { ok: boolean; values: Record<string, AttributeValue[]>; previous: Record<string, AttributeValue[]>; uncertain?: true } {
	const values: Record<string, AttributeValue[]> = {};
	const previous: Record<string, AttributeValue[]> = {};
	if (!typeMatches(e, spec.type)) return { ok: false, values, previous };
	for (const p of spec.where ?? []) {
		const r = predicate(ix, prevIx, e, p);
		values[p.attr] = r.values;
		if (r.previous) previous[p.attr] = r.previous;
		if (!r.ok) return { ok: false, values, previous, ...(r.uncertain ? { uncertain: true as const } : {}) };
	}
	for (const r of spec.related ?? []) {
		if (depth > 3) return { ok: false, values, previous };
		const others = r.direction === 'in' ? ix.in(e.id, r.rel) : ix.out(e.id, r.rel);
		const hit = others.find((o) => !r.entity || specMatches(ix, prevIx, o, r.entity, depth + 1).ok);
		if (!hit) return { ok: false, values, previous };
		values[`${r.direction === 'in' ? '<' : ''}${r.rel}`] = [hit.attributes.find((a) => a.name === 'name')?.value ?? hit.id];
	}
	if (spec.inCollection) {
		const c = spec.inCollection;
		if (!ix.page.collections.some((col) => col.members.includes(e.id) && (!c.kind || col.kind === c.kind) && (!c.itemType || col.itemType === c.itemType))) return { ok: false, values, previous };
	}
	return { ok: true, values, previous };
}

export function evaluateEntityCondition(c: EntityCondition, page: PageRepresentation | undefined, previous: PageRepresentation | undefined): EntityResult {
	if (!page) return { matched: false, note: 'no page representation for this observation', candidates: 0, matches: [], uncertain: [] };
	const ix = new Index(page);
	const prevIx = previous ? new Index(previous) : null;
	const state = c.state ?? 'present';
	if (state !== 'present' && !prevIx) return { matched: false, note: 'no previous observation (baseline)', candidates: 0, matches: [], uncertain: [] };
	const uncertain: EntityResult['uncertain'] = [];
	let pool: PageEntity[];
	let poolIx = ix;
	if (state === 'added' || state === 'removed') {
		const [from, other] = state === 'added' ? [page.entities, prevIx!] : [previous!.entities, ix];
		poolIx = state === 'added' ? ix : prevIx!;
		pool = [];
		for (const e of from.filter((x) => !other.byId.has(x.id) && typeMatches(x, c.type))) {
			const why = continuityOf(e);
			if (why) uncertain.push({ id: e.id, reason: why }); else pool.push(e);
		}
	} else pool = page.entities;
	const candidates = pool.filter((e) => typeMatches(e, c.type));
	const matches: EntityMatch[] = [];
	for (const e of candidates) {
		const r = specMatches(poolIx, state === 'removed' ? null : prevIx, e, c);
		if (r.uncertain) uncertain.push({ id: e.id, reason: continuityOf(e) ?? 'continuity unknown' });
		if (!r.ok) continue;
		const name = e.attributes.find((a) => a.name === 'name')?.value;
		const attrNames = new Set((c.where ?? []).map((p) => p.attr));
		const evidenceRefs = [...new Set([...e.evidenceRefs.slice(0, 1), ...e.attributes.filter((a) => attrNames.has(a.name)).flatMap((a) => a.evidenceRefs)])];
		matches.push({ id: e.id, type: e.type, name: typeof name === 'string' ? name : null, values: r.values, ...(Object.keys(r.previous).length ? { previous: r.previous } : {}), evidenceRefs });
	}
	const q = c.quantifier ?? 'any';
	let matched = q === 'any' ? matches.length > 0 : q === 'all' ? candidates.length > 0 && matches.length === candidates.length : matches.length === 0;
	if (c.count) {
		const n = matches.length, v = c.count.value;
		matched = { eq: n === v, gt: n > v, gte: n >= v, lt: n < v, lte: n <= v }[c.count.op];
	}
	return { matched, candidates: candidates.length, matches, uncertain, ...(uncertain.length ? { note: `${uncertain.length} entit${uncertain.length === 1 ? 'y' : 'ies'} with uncertain continuity not evaluated for change` } : {}) };
}

export function validateEntityCondition(c: EntityCondition, depth = 0): void {
	if (depth > 3) throw new Error('entity condition nesting exceeds 3');
	const ops = new Set(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'contains', 'not_contains', 'matches', 'in', 'exists', 'absent', 'changed', 'unchanged', 'increased', 'decreased', 'between', 'overlaps']);
	if (c.type !== undefined && !(typeof c.type === 'string' || (Array.isArray(c.type) && c.type.every((t) => typeof t === 'string')))) throw new Error('entity.type must be a string or string[]');
	if (c.state && !['present', 'added', 'removed'].includes(c.state)) throw new Error(`entity.state ${c.state} is not supported`);
	if (c.quantifier && !['any', 'all', 'none'].includes(c.quantifier)) throw new Error(`entity.quantifier ${c.quantifier} is not supported`);
	if (c.count && (!['eq', 'gt', 'gte', 'lt', 'lte'].includes(c.count.op) || typeof c.count.value !== 'number')) throw new Error('entity.count needs op and numeric value');
	for (const p of c.where ?? []) {
		if (typeof p.attr !== 'string' || !/^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*){0,3}$/.test(p.attr)) throw new Error(`invalid attribute path ${p.attr}`);
		if (!ops.has(p.op)) throw new Error(`unknown op ${p.op}`);
		if (p.op === 'matches') new RegExp(String(p.value));
		if ((p.op === 'between' || p.op === 'overlaps') && !(Array.isArray(p.value) && p.value.length === 2)) throw new Error(`${p.op} needs [low, high]`);
		if (p.op === 'in' && !Array.isArray(p.value)) throw new Error('in needs an array');
	}
	for (const r of c.related ?? []) if (r.entity) validateEntityCondition(r.entity, depth + 1);
}
