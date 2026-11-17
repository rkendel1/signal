/**
 * Turns the panel's controls into a signal.intent/v1. Pure (no DOM, no chrome), so it is unit-tested.
 * Controls are generated from facets (lib/discovery facets()): what the captured pages actually contain.
 */
import type { DiscoveryIntent, Facet, IntentCriterion } from '../../lib/discovery/discover.ts';

export type Missing = 'unknown' | 'false';
export type FilterState =
	| { kind: 'range'; on: boolean; lo: number; hi: number; missing: Missing }
	| { kind: 'category'; on: boolean; values: Array<string | number | boolean>; missing: Missing }
	| { kind: 'boolean'; on: boolean; value: boolean; missing: Missing }
	| { kind: 'presence'; on: boolean; missing: Missing };
export interface EditorState { types: string[]; filters: Record<string, FilterState> }

/** The initial state of a control: off, spanning everything observed. Presence filters count absence as "no". */
export function defaultFilter(f: Facet): FilterState {
	switch (f.kind) {
		case 'range': return { kind: 'range', on: false, lo: f.min!, hi: f.max!, missing: 'unknown' };
		case 'category': return { kind: 'category', on: false, values: [], missing: 'unknown' };
		case 'boolean': return { kind: 'boolean', on: false, value: true, missing: 'unknown' };
		default: return { kind: 'presence', on: false, missing: 'false' };
	}
}

/** Keep a person's settings when facets are recomputed (a new capture); a kind change resets that one control. */
export function reconcile(state: EditorState, facets: Facet[]): EditorState {
	const filters: Record<string, FilterState> = {};
	for (const f of facets) {
		const prev = state.filters[f.attr];
		filters[f.attr] = prev && prev.kind === f.kind ? prev : defaultFilter(f);
	}
	return { ...state, filters };
}

export function formatValue(f: Pick<Facet, 'unit' | 'currency'>, n: number): string {
	if (f.unit === 'money') {
		try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: f.currency ?? 'USD', maximumFractionDigits: n % 1 ? 2 : 0 }).format(n); } catch { return n.toLocaleString('en-US'); }
	}
	if (f.unit === 'percent') return `${n}%`;
	return Number.isInteger(n) && Math.abs(n) >= 1000 && Math.abs(n) < 3000 ? String(n) : n.toLocaleString('en-US'); // years read as years
}

/** A slider step that lands on round numbers: about 100 positions across the observed range. */
export function niceStep(f: Facet): number {
	const span = (f.max ?? 0) - (f.min ?? 0);
	if (span <= 0) return 1;
	const raw = span / 100;
	const pow = 10 ** Math.floor(Math.log10(raw));
	const step = [1, 2, 5, 10].map((m) => m * pow).find((x) => x >= raw)!;
	const integral = Number.isInteger(f.min) && Number.isInteger(f.max);
	return integral ? Math.max(1, Math.round(step)) : step;
}

export function buildIntent(state: EditorState, facets: Facet[], name = 'Captured pages'): DiscoveryIntent {
	const criteria: IntentCriterion[] = [];
	for (const f of facets) {
		const s = state.filters[f.attr];
		if (!s?.on) continue;
		const absent = s.missing === 'false' ? { absent: 'false' as const } : {};
		if (s.kind === 'range') {
			const lo = Math.min(s.lo, s.hi), hi = Math.max(s.lo, s.hi);
			criteria.push({ id: f.attr, label: `${f.label} ${formatValue(f, lo)}–${formatValue(f, hi)}`, where: { attr: f.attr, op: 'between', value: [lo, hi] }, ...absent });
		} else if (s.kind === 'category') {
			if (!s.values.length) continue;
			criteria.push({ id: f.attr, label: `${f.label}: ${s.values.map(String).join(' or ')}`, where: { attr: f.attr, op: 'in', value: s.values }, ...absent });
		} else if (s.kind === 'boolean') {
			criteria.push({ id: f.attr, label: `${f.label}: ${s.value ? 'yes' : 'no'}`, where: { attr: f.attr, op: 'eq', value: s.value }, ...absent });
		} else {
			criteria.push({ id: f.attr, label: `Has ${f.label.toLowerCase()}`, where: { attr: f.attr, op: 'exists' }, ...absent });
		}
	}
	return { schema: 'signal.intent/v1', id: 'panel', version: 1, name, target: { type: state.types }, criteria };
}
