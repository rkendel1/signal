/**
 * signal.criteria/v2 — what a user cares about, as explicit, inspectable, user-owned data.
 *
 *   require  every condition must hold for a match (missing evidence ⇒ "possible", never "no")
 *   exclude  any condition that holds disqualifies
 *   prefer   conditions that raise priority, with weights
 *   derive   arithmetic over attributes, possibly from different sources (e.g. yield = rent × 12 / price)
 *
 * Plus freshness (maxAgeDays), source restriction, per-attribute source trust for conflicts, the size of a
 * change that counts as meaningful, and which lifecycle transitions notify. Not a query language: conditions
 * are attribute/operator/value leaves combined with all/any.
 */
import { assertPermittedAttribute } from './policy.ts';
import type { Value } from './types.ts';

export type Op = 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'between' | 'in' | 'not_in' | 'contains' | 'exists' | 'missing' | 'decreased_pct' | 'increased_pct' | 'changed' | 'within';
export const OPS: Record<Op, { label: string; value: 'none' | 'scalar' | 'number' | 'range' | 'list' | 'pct' | 'area' }> = {
	eq: { label: 'is', value: 'scalar' }, neq: { label: 'is not', value: 'scalar' },
	lt: { label: '<', value: 'number' }, lte: { label: '≤', value: 'number' }, gt: { label: '>', value: 'number' }, gte: { label: '≥', value: 'number' },
	between: { label: 'between', value: 'range' }, in: { label: 'is one of', value: 'list' }, not_in: { label: 'is none of', value: 'list' },
	contains: { label: 'contains', value: 'scalar' }, exists: { label: 'is known', value: 'none' }, missing: { label: 'is unknown', value: 'none' },
	decreased_pct: { label: 'dropped by ≥ %', value: 'pct' }, increased_pct: { label: 'rose by ≥ %', value: 'pct' }, changed: { label: 'changed', value: 'none' },
	within: { label: 'is within', value: 'area' },
};

/**
 * A geographic area held in a source (a boundary in a GeoJSON file, a parcel…): the criteria name the record, not a
 * copy of its geometry, so the area keeps its provenance. Used with `{ attr: '@location', op: 'within' }`.
 */
export interface AreaRef { sourceId: string; recordKey: string; bufferKm?: number }
export const LOCATION = '@location';

export interface Leaf {
	attr: string;
	op: Op;
	value?: Value | Value[] | [number, number] | AreaRef;
	label?: string;
	/** Evidence older than this does not count (overrides the criteria and source defaults). */
	maxAgeDays?: number;
	/** Only evidence from these sources counts for this condition. */
	sources?: string[];
	/** For change operators: the window. */
	withinDays?: number;
	/** Required unit or currency of the value, e.g. "USD". Values in another unit are not compared. */
	unit?: string;
}
export type Condition = Leaf | { all: Condition[] } | { any: Condition[] };
export interface Preference { when: Condition; weight: number; label?: string }
export type Expr = { attr: string } | { const: number } | { op: '+' | '-' | '*' | '/'; args: [Expr, Expr] };
export interface Derived { name: string; label?: string; expr: Expr; unit?: string }
export type Transition = 'new' | 'changed' | 'resolved' | 'reopened' | 'superseded' | 'invalid';

export interface CriteriaDefinition {
	schema?: 'signal.criteria/v2';
	name: string;
	description?: string;
	entityType: string;
	severity: 'info' | 'warning' | 'critical';
	require: Condition[];
	exclude?: Condition[];
	prefer?: Preference[];
	derive?: Derived[];
	maxAgeDays?: number;
	sources?: string[];
	/** attribute → source ids, most trusted first. Used only when sources disagree about whether a condition holds. */
	trust?: Record<string, string[]>;
	/** attribute → the smallest change that counts as meaningful. Default: any change. */
	changeThresholds?: Record<string, { abs?: number; pct?: number }>;
	/** Default: new and reopened matches. Possible findings notify only if `notifyPossible`. */
	notifyOn?: Transition[];
	notifyPossible?: boolean;
	/** Keep findings whose required evidence is partly missing ("possible"). Default true. */
	includePossible?: boolean;
}

export const isLeaf = (c: Condition): c is Leaf => 'attr' in c;
const MAX_NODES = 200, MAX_DEPTH = 8;

function exprAttrs(e: Expr, out: Set<string>): Set<string> {
	if ('attr' in e) out.add(e.attr);
	else if ('op' in e) e.args.forEach((a) => exprAttrs(a, out));
	return out;
}
export function conditionAttrs(c: Condition, out = new Set<string>()): Set<string> {
	if (isLeaf(c)) { if (c.attr !== LOCATION) out.add(c.attr); }
	else ('all' in c ? c.all : c.any).forEach((x) => conditionAttrs(x, out));
	return out;
}
/** Every source attribute a criteria version reads (derived names expanded to their inputs). */
export function criteriaAttrs(d: CriteriaDefinition): string[] {
	const s = new Set<string>();
	for (const c of [...d.require, ...(d.exclude ?? []), ...(d.prefer ?? []).map((p) => p.when)]) conditionAttrs(c, s);
	const derived = new Map((d.derive ?? []).map((x) => [x.name, x]));
	for (const n of [...s]) { const dv = derived.get(n); if (dv) { s.delete(n); exprAttrs(dv.expr, s); } }
	return [...s].sort();
}

function validateExpr(e: Expr, depth = 0): void {
	if (depth > MAX_DEPTH) throw new Error('derived expression too deep');
	if ('attr' in e) { if (typeof e.attr !== 'string' || !e.attr) throw new Error('expression attr must be a name'); assertPermittedAttribute(e.attr, 'derive'); return; }
	if ('const' in e) { if (typeof e.const !== 'number' || !Number.isFinite(e.const)) throw new Error('expression const must be a number'); return; }
	if (!['+', '-', '*', '/'].includes(e.op) || !Array.isArray(e.args) || e.args.length !== 2) throw new Error('expression needs op (+ - * /) and two args');
	e.args.forEach((a) => validateExpr(a, depth + 1));
}

function validateCondition(c: Condition, where: string, depth: number, n: { v: number }): void {
	if (depth > MAX_DEPTH) throw new Error(`${where}: nesting deeper than ${MAX_DEPTH}`);
	if (++n.v > MAX_NODES) throw new Error(`more than ${MAX_NODES} conditions`);
	if (!c || typeof c !== 'object') throw new Error(`${where}: not a condition`);
	if ('all' in c || 'any' in c) {
		const list = 'all' in c ? c.all : c.any;
		if (!Array.isArray(list) || !list.length) throw new Error(`${where}: all/any needs a non-empty list`);
		list.forEach((x, i) => validateCondition(x, `${where}.${'all' in c ? 'all' : 'any'}[${i}]`, depth + 1, n));
		return;
	}
	if (!isLeaf(c) || typeof c.attr !== 'string' || !c.attr) throw new Error(`${where}: a condition needs attr and op`);
	assertPermittedAttribute(c.attr, where);
	const spec = OPS[c.op];
	if (!spec) throw new Error(`${where}: unknown operator ${String(c.op)}`);
	const v = c.value;
	if (spec.value === 'number' && typeof v !== 'number') throw new Error(`${where}: ${c.attr} ${spec.label} needs a number`);
	if (spec.value === 'pct' && (typeof v !== 'number' || v <= 0)) throw new Error(`${where}: ${c.op} needs a positive percentage`);
	if (spec.value === 'range' && !(Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number') && (v[0] as number) <= (v[1] as number))) throw new Error(`${where}: between needs [min, max]`);
	if (spec.value === 'list' && !(Array.isArray(v) && v.length > 0)) throw new Error(`${where}: ${c.op} needs a non-empty list`);
	if (spec.value === 'area') {
		if (c.attr !== LOCATION) throw new Error(`${where}: within applies to ${LOCATION}, the entity's location`);
		const a = v as AreaRef;
		if (!a || typeof a !== 'object' || typeof a.sourceId !== 'string' || typeof a.recordKey !== 'string') throw new Error(`${where}: within needs { sourceId, recordKey } of an area record`);
		if (a.bufferKm !== undefined && !(a.bufferKm >= 0 && a.bufferKm <= 2000)) throw new Error(`${where}: bufferKm must be 0–2000`);
	} else if (c.attr === LOCATION) throw new Error(`${where}: ${LOCATION} only supports within`);
	if (spec.value === 'scalar' && (v === undefined || v === null || Array.isArray(v))) throw new Error(`${where}: ${c.attr} ${spec.label} needs a value`);
	if (c.maxAgeDays !== undefined && !(c.maxAgeDays > 0)) throw new Error(`${where}: maxAgeDays must be positive`);
	if (c.withinDays !== undefined && !(c.withinDays > 0)) throw new Error(`${where}: withinDays must be positive`);
}

/** Throws a readable error for anything Signal would not evaluate deterministically or may not evaluate at all. */
export function validateCriteria(d: CriteriaDefinition): CriteriaDefinition {
	if (!d || typeof d !== 'object') throw new Error('criteria must be an object');
	if (typeof d.name !== 'string' || !d.name.trim()) throw new Error('name is required');
	if (typeof d.entityType !== 'string' || !d.entityType) throw new Error('entityType is required');
	if (!['info', 'warning', 'critical'].includes(d.severity)) throw new Error('severity must be info, warning or critical');
	if (!Array.isArray(d.require) || !d.require.length) throw new Error('at least one required condition is needed');
	const n = { v: 0 };
	d.require.forEach((c, i) => validateCondition(c, `require[${i}]`, 0, n));
	(d.exclude ?? []).forEach((c, i) => validateCondition(c, `exclude[${i}]`, 0, n));
	(d.prefer ?? []).forEach((p, i) => { validateCondition(p.when, `prefer[${i}]`, 0, n); if (typeof p.weight !== 'number' || !(p.weight > 0) || p.weight > 100) throw new Error(`prefer[${i}]: weight must be 1–100`); });
	const names = new Set<string>();
	for (const [i, x] of (d.derive ?? []).entries()) {
		if (!/^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(x.name ?? '')) throw new Error(`derive[${i}]: name must be an identifier`);
		if (names.has(x.name)) throw new Error(`derive[${i}]: ${x.name} defined twice`);
		assertPermittedAttribute(x.name, `derive[${i}]`);
		names.add(x.name);
		validateExpr(x.expr);
	}
	if (d.maxAgeDays !== undefined && !(d.maxAgeDays > 0)) throw new Error('maxAgeDays must be positive');
	for (const [a, t] of Object.entries(d.changeThresholds ?? {})) if ((t.abs !== undefined && !(t.abs >= 0)) || (t.pct !== undefined && !(t.pct >= 0))) throw new Error(`changeThresholds.${a}: abs/pct must be ≥ 0`);
	for (const [a, list] of Object.entries(d.trust ?? {})) if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) throw new Error(`trust.${a} must be a list of source ids`);
	return { ...d, schema: 'signal.criteria/v2' };
}

/** A readable sentence for a condition, for explanations. */
export function describe(c: Condition): string {
	if (!isLeaf(c)) return `${'all' in c ? 'all of' : 'any of'} (${('all' in c ? c.all : c.any).map(describe).join('; ')})`;
	if (c.label) return c.label;
	const fmt = (v: unknown): string => (Array.isArray(v) ? v.map(fmt).join(', ') : v && typeof v === 'object' && 'amount' in (v as object) ? String((v as { amount: number }).amount) : String(v));
	const spec = OPS[c.op];
	if (c.op === 'within') { const a = c.value as AreaRef; return `location is within ${a.bufferKm ? `${a.bufferKm} km of ` : ''}area ${a.recordKey}`; }
	const tail = spec.value === 'none' ? '' : spec.value === 'range' ? ` ${fmt((c.value as number[])[0])}–${fmt((c.value as number[])[1])}` : ` ${fmt(c.value)}`;
	return `${c.attr} ${spec.label}${tail}${c.withinDays ? ` within ${c.withinDays} days` : ''}`;
}
