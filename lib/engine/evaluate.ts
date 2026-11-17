/**
 * The single deterministic evaluator: one entity's evidence × one criteria version → an explained outcome.
 *
 * Pure function of (evidence, criteria, now). No I/O, no clock reads, no model calls.
 * Three-valued: a condition is true, false, or unknown (missing, stale, conflicting, insufficient history,
 * incomparable units). Unknown is never treated as false.
 */
import { canonicalJson, sha256 } from '../core/canonical.ts';
import { describe, isLeaf, LOCATION, type AreaRef, type Condition, type CriteriaDefinition, type Derived, type Expr, type Leaf } from './criteria.ts';
import type { EntityEvidence, EvidenceRecord, Geometry, LinkStatus, Value } from './types.ts';
import { distanceM, inGeometry } from './identity.ts';

/** Areas referenced by criteria, resolved by the caller from their source records (sourceId:recordKey → geometry). */
export type Areas = Map<string, { geometry: Geometry; label: string; sourceName: string; observationId: string } | null>;
export const areaKey = (a: AreaRef) => `${a.sourceId}\u0000${a.recordKey}`;

/** 0 inside the area; otherwise the distance in km to its nearest vertex (an upper bound on the distance to its edge). */
export function kmFromArea(lat: number, lng: number, g: Geometry): number {
	if (inGeometry(lat, lng, g)) return 0;
	let best = Infinity;
	for (const poly of g.polygons ?? []) for (const ring of poly) for (const [x, y] of ring) best = Math.min(best, distanceM({ lat, lng }, { lat: y, lng: x }));
	if (g.point) best = Math.min(best, distanceM({ lat, lng }, g.point));
	return Math.round(best / 10) / 100;
}

export type Tri = 'true' | 'false' | 'unknown';
export type UnknownReason = 'missing' | 'stale' | 'conflict' | 'no_history' | 'unit' | 'derived';

export interface EvidenceValue {
	sourceId: string; sourceName: string; synthetic: boolean;
	observationId: string; recordKey: string; version: number;
	value: Value; raw: string | null; unit: string | null;
	observedAt: string; validAt: string | null; confirmedAt: string;
	ageDays: number; stale: boolean;
	link: LinkStatus; linkConfidence: number;
	/** For derived values: the inputs it was computed from. */
	inputs?: Array<{ attr: string; values: EvidenceValue[] }>;
	/** The result of the condition on this value alone. */
	result?: Tri;
}

export interface Node {
	path: string;
	kind: 'all' | 'any' | 'leaf';
	result: Tri;
	text: string;
	children?: Node[];
	leaf?: { attr: string; op: string; expected: unknown; values: EvidenceValue[]; reason?: UnknownReason; note?: string; resolvedBy?: string };
}

export type Qualification = 'match' | 'possible' | 'non_match' | 'excluded' | 'insufficient';

export interface Outcome {
	qualification: Qualification;
	require: Node[];
	exclude: Node[];
	prefer: Array<{ node: Node; weight: number }>;
	derived: Array<{ name: string; label: string; value: number | null; reason?: string; inputs: Array<{ attr: string; values: EvidenceValue[] }> }>;
	/** Attributes where fresh values from different records disagree (even if every value satisfies the condition). */
	conflicts: Array<{ attr: string; values: Array<{ sourceName: string; value: Value }>; resolvedBy: string | null }>;
	missing: string[];
	stale: string[];
	score: number;
	confidence: number;
	breakdown: Array<{ label: string; points?: number; factor?: number }>;
	/** The value of every attribute the criteria reads, as evaluated (for meaningful-change comparison). */
	relevant: Record<string, unknown>;
	evidenceIds: string[];
	sources: string[];
	summary: string;
	digest: string;
}

const DAY = 86_400_000;
export const num = (v: Value): number | null => (typeof v === 'number' ? v : v && typeof v === 'object' && 'amount' in v ? v.amount : null);
const unitOf = (v: Value, declared: string | null | undefined): string | null => (v && typeof v === 'object' && 'currency' in v && v.currency ? v.currency : declared ?? null);
const same = (a: Value, b: Value) => (num(a) !== null && num(b) !== null ? num(a) === num(b) : typeof a === 'string' && typeof b === 'string' ? a.trim().toLowerCase() === b.trim().toLowerCase() : canonicalJson(a) === canonicalJson(b));
const show = (v: Value): string => (v === null ? '—' : typeof v === 'object' ? `${v.currency ?? ''} ${v.amount.toLocaleString('en-US')}`.trim() : typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 4 }) : String(v));

interface Ctx { areas: Areas; ev: EntityEvidence; crit: CriteriaDefinition; now: number; derived: Map<string, Derived>; derivedCache: Map<string, { value: number | null; reason?: string; inputs: Array<{ attr: string; values: EvidenceValue[] }> }> }

function confirmedAt(r: EvidenceRecord): string { return r.current?.confirmedAt ?? r.current?.observedAt ?? ''; }

/** Fresh and stale values of an attribute across the entity's current records, within the allowed sources. */
function valuesOf(ctx: Ctx, attr: string, leaf?: Leaf): EvidenceValue[] {
	const allowed = leaf?.sources ?? ctx.crit.sources;
	const out: EvidenceValue[] = [];
	for (const r of ctx.ev.records) {
		const o = r.current;
		if (!o || r.source.status === 'removed' || (allowed && !allowed.includes(r.source.id))) continue;
		const a = o.attributes[attr];
		if (!a || a.value === null) continue;
		const maxAge = leaf?.maxAgeDays ?? ctx.crit.maxAgeDays ?? r.source.staleAfterDays ?? null;
		const asOf = o.validAt ?? confirmedAt(r);
		const ageDays = Math.max(0, (ctx.now - Date.parse(asOf)) / DAY);
		out.push({
			sourceId: r.source.id, sourceName: r.source.name, synthetic: r.source.synthetic, observationId: o.observationId, recordKey: o.recordKey, version: o.version,
			value: a.value, raw: a.raw, unit: unitOf(a.value, a.unit), observedAt: o.observedAt, validAt: o.validAt, confirmedAt: confirmedAt(r),
			ageDays: Math.round(ageDays * 10) / 10, stale: maxAge !== null && ageDays > maxAge, link: r.link.status, linkConfidence: r.link.confidence,
		});
	}
	return out;
}

/** One value for an attribute, if the fresh evidence agrees (or trust decides). */
function resolveNumber(ctx: Ctx, attr: string): { value: number | null; reason?: string; values: EvidenceValue[] } {
	if (ctx.derived.has(attr)) { const d = evalDerived(ctx, attr); return { value: d.value, reason: d.reason, values: [] }; }
	const vals = valuesOf(ctx, attr);
	const fresh = vals.filter((v) => !v.stale && num(v.value) !== null);
	if (!vals.length) return { value: null, reason: `${attr} missing`, values: vals };
	if (!fresh.length) return { value: null, reason: `${attr} stale or not numeric`, values: vals };
	const distinct = [...new Set(fresh.map((v) => num(v.value)!))];
	if (distinct.length === 1) return { value: distinct[0], values: fresh };
	const trusted = (ctx.crit.trust?.[attr] ?? []).map((s) => fresh.find((v) => v.sourceId === s)).find(Boolean);
	if (trusted) return { value: num(trusted.value), values: [trusted] };
	return { value: null, reason: `${attr} conflicts (${distinct.map((d) => show(d)).join(' vs ')})`, values: fresh };
}

function evalExpr(ctx: Ctx, e: Expr, inputs: Array<{ attr: string; values: EvidenceValue[] }>): { value: number | null; reason?: string } {
	if ('const' in e) return { value: e.const };
	if ('attr' in e) { const r = resolveNumber(ctx, e.attr); inputs.push({ attr: e.attr, values: r.values }); return r; }
	const a = evalExpr(ctx, e.args[0], inputs), b = evalExpr(ctx, e.args[1], inputs);
	if (a.value === null || b.value === null) return { value: null, reason: a.reason ?? b.reason };
	if (e.op === '/' && b.value === 0) return { value: null, reason: 'division by zero' };
	const v = e.op === '+' ? a.value + b.value : e.op === '-' ? a.value - b.value : e.op === '*' ? a.value * b.value : a.value / b.value;
	return { value: Math.round(v * 1e6) / 1e6 };
}

function evalDerived(ctx: Ctx, name: string) {
	const hit = ctx.derivedCache.get(name);
	if (hit) return hit;
	const inputs: Array<{ attr: string; values: EvidenceValue[] }> = [];
	ctx.derivedCache.set(name, { value: null, reason: 'circular definition', inputs }); // guards recursion
	const r = evalExpr(ctx, ctx.derived.get(name)!.expr, inputs);
	const out = { ...r, inputs };
	ctx.derivedCache.set(name, out);
	return out;
}

function predicate(c: Leaf, v: Value): Tri {
	const n = num(v);
	const x = c.value;
	switch (c.op) {
		case 'eq': return same(v, x as Value) ? 'true' : 'false';
		case 'neq': return same(v, x as Value) ? 'false' : 'true';
		case 'lt': case 'lte': case 'gt': case 'gte': {
			if (n === null) return 'unknown';
			const t = x as number;
			return (c.op === 'lt' ? n < t : c.op === 'lte' ? n <= t : c.op === 'gt' ? n > t : n >= t) ? 'true' : 'false';
		}
		case 'between': { if (n === null) return 'unknown'; const [lo, hi] = x as [number, number]; return n >= lo && n <= hi ? 'true' : 'false'; }
		case 'in': return (x as Value[]).some((y) => same(v, y)) ? 'true' : 'false';
		case 'not_in': return (x as Value[]).some((y) => same(v, y)) ? 'false' : 'true';
		case 'contains': return String(typeof v === 'object' && v ? show(v) : v).toLowerCase().includes(String(x).toLowerCase()) ? 'true' : 'false';
		default: return 'unknown';
	}
}

/** Change operators look at one record's own history: a change is only meaningful within the same source record. */
function changeResult(ctx: Ctx, c: Leaf, r: EvidenceRecord): { result: Tri; note: string } {
	const o = r.current!;
	const window = (c.withinDays ?? 30) * DAY;
	const since = ctx.now - window;
	const versions = [...r.history, o].filter((h) => h.attributes[c.attr] && h.attributes[c.attr].value !== null);
	const first = r.history[0] ?? o;
	const coversWindow = Date.parse(first.observedAt) <= since;
	const inWindow = versions.filter((h) => Date.parse(h.observedAt) >= since || h === o);
	// The value in force at the start of the window counts too.
	const before = versions.filter((h) => Date.parse(h.observedAt) < since).pop();
	const span = before ? [before, ...inWindow] : inWindow;
	const cur = o.attributes[c.attr]?.value ?? null;
	if (c.op === 'changed') {
		const changed = span.some((h) => !same(h.attributes[c.attr].value, cur));
		if (changed) return { result: 'true', note: `was ${show(span[0].attributes[c.attr].value)}` };
		return coversWindow ? { result: 'false', note: 'unchanged over the window' } : { result: 'unknown', note: `observed only since ${first.observedAt.slice(0, 10)}` };
	}
	const nums = span.map((h) => num(h.attributes[c.attr].value)).filter((x): x is number => x !== null);
	const n = num(cur);
	if (n === null || !nums.length) return { result: 'unknown', note: 'not numeric' };
	const ref = c.op === 'decreased_pct' ? Math.max(...nums) : Math.min(...nums);
	const pct = ref === 0 ? 0 : (c.op === 'decreased_pct' ? (ref - n) / ref : (n - ref) / ref) * 100;
	if (pct >= (c.value as number)) return { result: 'true', note: `${c.op === 'decreased_pct' ? 'down' : 'up'} ${pct.toFixed(1)}% from ${show(ref)}` };
	return coversWindow || pct > 0 ? { result: coversWindow ? 'false' : 'unknown', note: `${pct.toFixed(1)}% change since ${(before ?? first).observedAt.slice(0, 10)}` } : { result: 'unknown', note: `observed only since ${first.observedAt.slice(0, 10)}` };
}

function evalLeaf(ctx: Ctx, c: Leaf, path: string): Node {
	const text = describe(c);
	const base = { path, kind: 'leaf' as const, text };
	const mk = (result: Tri, values: EvidenceValue[], extra: Partial<NonNullable<Node['leaf']>> = {}): Node => ({ ...base, result, leaf: { attr: c.attr, op: c.op, expected: c.value ?? null, values, ...extra } });

	if (c.attr === LOCATION) {
		const ref = c.value as AreaRef;
		const area = ctx.areas.get(areaKey(ref));
		if (!area) return mk('unknown', [], { reason: 'missing', note: `area ${ref.recordKey} is not available (its source was removed or the record withdrawn)` });
		const pts = ctx.ev.records.filter((r) => r.current && r.source.status !== 'removed' && r.current.identity.lat !== null && (!c.sources || c.sources.includes(r.source.id)));
		if (!pts.length) return mk('unknown', [], { reason: 'missing', note: 'no source gives this entity a location' });
		const vals: EvidenceValue[] = pts.map((r) => {
			const o = r.current!;
			const km = kmFromArea(o.identity.lat!, o.identity.lng!, area.geometry);
			return { sourceId: r.source.id, sourceName: r.source.name, synthetic: r.source.synthetic, observationId: o.observationId, recordKey: o.recordKey, version: o.version, value: km, raw: `${o.identity.lat}, ${o.identity.lng}`, unit: 'km from area', observedAt: o.observedAt, validAt: o.validAt, confirmedAt: confirmedAt(r), ageDays: 0, stale: false, link: r.link.status, linkConfidence: r.link.confidence, result: km <= (ref.bufferKm ?? 0) ? 'true' : 'false' };
		});
		const rs = [...new Set(vals.map((v) => v.result))];
		return mk(rs.length === 1 ? rs[0]! : 'unknown', vals, { note: `area: ${area.label} (${area.sourceName})`, ...(rs.length > 1 ? { reason: 'conflict' as const } : {}) });
	}
	if (ctx.derived.has(c.attr)) {
		const d = evalDerived(ctx, c.attr);
		const dv: EvidenceValue[] = d.value === null ? [] : [{ sourceId: 'derived', sourceName: 'derived', synthetic: d.inputs.some((i) => i.values.some((v) => v.synthetic)), observationId: '', recordKey: '', version: 0, value: d.value, raw: null, unit: ctx.derived.get(c.attr)!.unit ?? null, observedAt: '', validAt: null, confirmedAt: '', ageDays: 0, stale: false, link: 'exact', linkConfidence: Math.min(1, ...d.inputs.flatMap((i) => i.values.map((v) => v.linkConfidence))), inputs: d.inputs }];
		if (c.op === 'missing') return mk(d.value === null ? 'true' : 'false', dv);
		if (c.op === 'exists') return mk(d.value === null ? 'false' : 'true', dv);
		if (d.value === null) return mk('unknown', dv, { reason: 'derived', note: d.reason });
		const r = predicate(c, d.value);
		dv[0].result = r;
		return mk(r, dv);
	}

	const vals = valuesOf(ctx, c.attr, c);
	const fresh = vals.filter((v) => !v.stale);
	if (c.op === 'missing') return mk(fresh.length ? 'false' : 'true', vals);
	if (c.op === 'exists') return mk(fresh.length ? 'true' : vals.length ? 'unknown' : 'false', vals, vals.length && !fresh.length ? { reason: 'stale' } : {});
	if (!vals.length) return mk('unknown', vals, { reason: 'missing', note: `no source states ${c.attr}` });
	if (!fresh.length) return mk('unknown', vals, { reason: 'stale', note: `only stale evidence (oldest ${Math.max(...vals.map((v) => v.ageDays))} days)` });

	if (c.op === 'changed' || c.op === 'decreased_pct' || c.op === 'increased_pct') {
		const notes: string[] = [];
		for (const v of fresh) {
			const r = ctx.ev.records.find((x) => x.current?.observationId === v.observationId)!;
			const cr = changeResult(ctx, c, r);
			v.result = cr.result;
			notes.push(`${v.sourceName}: ${cr.note}`);
		}
		const rs = fresh.map((v) => v.result!);
		const result: Tri = rs.includes('true') ? 'true' : rs.every((r) => r === 'false') ? 'false' : 'unknown';
		return mk(result, vals, { note: notes.join('; '), ...(result === 'unknown' ? { reason: 'no_history' as const } : {}) });
	}

	for (const v of fresh) v.result = c.unit && v.unit && v.unit !== c.unit ? 'unknown' : predicate(c, v.value);
	const comparable = fresh.filter((v) => v.result !== 'unknown');
	if (!comparable.length) return mk('unknown', vals, { reason: 'unit', note: `values are not comparable (${[...new Set(fresh.map((v) => v.unit))].join(', ')} vs ${c.unit ?? 'number'})` });
	const results = [...new Set(comparable.map((v) => v.result!))];
	if (results.length === 1) return mk(results[0], vals, { resolvedBy: comparable.length > 1 ? 'agreement' : undefined });
	const trusted = (ctx.crit.trust?.[c.attr] ?? []).map((s) => comparable.find((v) => v.sourceId === s)).find(Boolean);
	if (trusted) return mk(trusted.result!, vals, { resolvedBy: `trust: ${trusted.sourceName}`, note: 'sources disagree; the more trusted source decides' });
	return mk('unknown', vals, { reason: 'conflict', note: `sources disagree: ${comparable.map((v) => `${v.sourceName} says ${show(v.value)}`).join(', ')}` });
}

function evalCond(ctx: Ctx, c: Condition, path: string): Node {
	if (isLeaf(c)) return evalLeaf(ctx, c, path);
	const kind = 'all' in c ? 'all' : 'any';
	const children = ('all' in c ? c.all : c.any).map((x, i) => evalCond(ctx, x, `${path}.${kind}[${i}]`));
	const rs = children.map((n) => n.result);
	const result: Tri = kind === 'all'
		? (rs.includes('false') ? 'false' : rs.includes('unknown') ? 'unknown' : 'true')
		: (rs.includes('true') ? 'true' : rs.includes('unknown') ? 'unknown' : 'false');
	return { path, kind, result, text: describe(c), children };
}

const leaves = (n: Node): Node[] => (n.kind === 'leaf' ? [n] : (n.children ?? []).flatMap(leaves));

export function evaluate(ev: EntityEvidence, crit: CriteriaDefinition, nowIso: string, areas: Areas = new Map()): Outcome {
	const ctx: Ctx = { areas, ev, crit, now: Date.parse(nowIso), derived: new Map((crit.derive ?? []).map((d) => [d.name, d])), derivedCache: new Map() };
	const require = crit.require.map((c, i) => evalCond(ctx, c, `require[${i}]`));
	const exclude = (crit.exclude ?? []).map((c, i) => evalCond(ctx, c, `exclude[${i}]`));
	const prefer = (crit.prefer ?? []).map((p, i) => ({ node: evalCond(ctx, p.when, `prefer[${i}]`), weight: p.weight, label: p.label }));

	const req: Tri = require.some((n) => n.result === 'false') ? 'false' : require.some((n) => n.result === 'unknown') ? 'unknown' : 'true';
	let qualification: Qualification;
	if (exclude.some((n) => n.result === 'true')) qualification = 'excluded';
	else if (req === 'true') qualification = 'match';
	else if (req === 'false') qualification = 'non_match';
	else qualification = require.some((n) => n.result === 'true') && crit.includePossible !== false ? 'possible' : 'insufficient';

	// Uncertainty, visible rather than hidden.
	const allLeaves = [...require, ...exclude, ...prefer.map((p) => p.node)].flatMap(leaves);
	const missing = [...new Set(allLeaves.filter((l) => l.leaf?.reason === 'missing').map((l) => l.leaf!.attr))];
	const stale = [...new Set(allLeaves.filter((l) => l.leaf?.values.some((v) => v.stale)).map((l) => l.leaf!.attr))];
	const conflicts: Outcome['conflicts'] = [];
	for (const l of allLeaves) {
		const fresh = (l.leaf?.values ?? []).filter((v) => !v.stale && v.sourceId !== 'derived');
		if (fresh.length < 2 || conflicts.some((c) => c.attr === l.leaf!.attr)) continue;
		if (fresh.every((v) => same(v.value, fresh[0].value))) continue;
		conflicts.push({ attr: l.leaf!.attr, values: fresh.map((v) => ({ sourceName: v.sourceName, value: v.value })), resolvedBy: l.leaf!.reason === 'conflict' ? null : l.leaf!.resolvedBy ?? 'every value gives the same result' });
	}
	const derived = (crit.derive ?? []).map((d) => { const r = evalDerived(ctx, d.name); return { name: d.name, label: d.label ?? d.name, value: r.value, ...(r.reason ? { reason: r.reason } : {}), inputs: r.inputs }; });

	// Prioritization: explicit and explained.
	const breakdown: Outcome['breakdown'] = [];
	let score = qualification === 'match' ? 100 : qualification === 'possible' ? 40 : 0;
	if (score) breakdown.push({ label: qualification === 'match' ? 'all required conditions hold' : 'some required evidence is missing', points: score });
	for (const p of prefer) if (p.node.result === 'true' && score) { score += p.weight; breakdown.push({ label: `preferred: ${p.label ?? p.node.text}`, points: p.weight }); }
	const sev = crit.severity === 'critical' ? 1.5 : crit.severity === 'warning' ? 1.25 : 1;
	if (sev !== 1 && score) breakdown.push({ label: `severity ${crit.severity}`, factor: sev });
	score = Math.round(score * sev);

	let confidence = 1;
	const used = require.flatMap(leaves).filter((l) => l.result === 'true').flatMap((l) => l.leaf!.values.flatMap((v) => (v.inputs ? v.inputs.flatMap((i) => i.values) : [v])));
	const weakest = used.reduce((m, v) => Math.min(m, v.linkConfidence), 1);
	if (weakest < 1) { confidence *= weakest; breakdown.push({ label: 'evidence joined by a probable (not exact) identity match', factor: weakest }); }
	const unresolved = conflicts.filter((c) => !c.resolvedBy).length;
	if (unresolved) { const f = Math.pow(0.8, unresolved); confidence *= f; breakdown.push({ label: `${unresolved} unresolved conflict${unresolved > 1 ? 's' : ''}`, factor: f }); }
	const exUnknown = exclude.filter((n) => n.result === 'unknown').length;
	if (exUnknown && score) { const f = Math.pow(0.9, exUnknown); confidence *= f; breakdown.push({ label: `${exUnknown} exclusion${exUnknown > 1 ? 's' : ''} could not be checked`, factor: f }); }
	if (qualification === 'possible') { confidence *= 0.7; breakdown.push({ label: 'required evidence missing or unusable', factor: 0.7 }); }
	confidence = Math.round(confidence * 1000) / 1000;

	const relevant: Record<string, unknown> = {};
	for (const l of allLeaves) {
		const vs = l.leaf!.values.filter((v) => !v.stale).map((v) => v.value);
		relevant[l.leaf!.attr] = vs.length === 1 ? vs[0] : vs.length ? vs : null;
	}
	for (const d of derived) relevant[d.name] = d.value;
	const evidenceIds = [...new Set(allLeaves.flatMap((l) => l.leaf!.values.flatMap((v) => (v.inputs ? v.inputs.flatMap((i) => i.values) : [v]))).map((v) => v.observationId).filter(Boolean))].sort();
	const sources = [...new Set(allLeaves.flatMap((l) => l.leaf!.values.flatMap((v) => (v.inputs ? v.inputs.flatMap((i) => i.values) : [v]))).map((v) => v.sourceName))].sort();

	const held = require.filter((n) => n.result === 'true').length;
	const unknownWhy = [...new Set(require.filter((n) => n.result === 'unknown').flatMap(leaves).filter((l) => l.result === 'unknown').map((l) => `${l.leaf!.attr} ${l.leaf!.reason === 'derived' ? 'needs ' + (l.leaf!.note ?? 'inputs') : l.leaf!.reason ?? 'unknown'}`))].join(', ');
	const summary = qualification === 'match' ? `All ${require.length} required condition${require.length > 1 ? 's' : ''} hold${sources.length > 1 ? ` across ${sources.length} sources` : ''}`
		: qualification === 'possible' ? `${held} of ${require.length} required conditions hold; ${require.length - held} cannot be checked (${unknownWhy || 'insufficient evidence'})`
		: qualification === 'excluded' ? `Excluded: ${exclude.filter((n) => n.result === 'true').map((n) => n.text).join('; ')}`
		: qualification === 'non_match' ? `Does not meet: ${require.filter((n) => n.result === 'false').map((n) => n.text).join('; ')}`
		: 'Not enough evidence to evaluate';

	const shape = (n: Node): unknown => [n.path, n.result, n.children?.map(shape) ?? null];
	const digest = sha256(canonicalJson({ q: qualification, r: require.map(shape), x: exclude.map(shape), p: prefer.map((p) => shape(p.node)), v: relevant }));
	return { qualification, require, exclude, prefer: prefer.map(({ node, weight }) => ({ node, weight })), derived, conflicts, missing, stale, score, confidence, breakdown, relevant, evidenceIds, sources, summary, digest };
}
