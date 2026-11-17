/**
 * Finding lifecycle (pure): previous finding state + new outcome + what caused the evaluation → next state,
 * and whether that is an event worth recording and announcing.
 *
 *   new        first qualifying evaluation
 *   changed    still qualifying, and something meaningful changed (a condition result, match ↔ possible,
 *              or a relevant value beyond the criteria's change threshold)
 *   persistent still qualifying, nothing meaningful changed (no event, no notification: the dedup rule)
 *   resolved   no longer qualifies because the observed values changed
 *   superseded no longer qualifies because the user's criteria changed
 *   invalid    no longer qualifies because its evidence was withdrawn (source removed, record retracted,
 *              identity link corrected) or expired
 *   reopened   qualifies again after being closed
 */
import type { CriteriaDefinition, Transition } from './criteria.ts';
import { num, type Node, type Outcome } from './evaluate.ts';

export type FindingStatus = 'open' | 'resolved' | 'superseded' | 'invalid';
export type ChangeKind = 'new' | 'changed' | 'persistent' | 'reopened' | 'resolved' | 'superseded' | 'invalid';
export type CauseKind = 'ingestion' | 'criteria' | 'identity' | 'source_removed' | 'retraction' | 'mapping' | 'time' | 'source_status';
export interface Cause { kind: CauseKind; ref: string; label: string }

export interface FindingState {
	status: FindingStatus;
	change: ChangeKind;
	qualification: 'match' | 'possible';
	criteriaVersion: number;
	/** Condition results at the last event, path → result. */
	results: Record<string, string>;
	/** Relevant values at the last event (what the user was last told). */
	eventValues: Record<string, unknown>;
}

export interface Diff { what: string; from: unknown; to: unknown }
export interface Decision {
	next: FindingState | null;
	/** An event to append to the finding's history (null: nothing meaningful happened). */
	event: { kind: ChangeKind; diff: Diff[]; reason: string } | null;
	notify: boolean;
}

export function results(o: Outcome): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (n: Node) => { out[n.path] = n.result; n.children?.forEach(walk); };
	[...o.require, ...o.exclude, ...o.prefer.map((p) => p.node)].forEach(walk);
	return out;
}

const valueEq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function meaningfulValueChange(attr: string, from: unknown, to: unknown, crit: CriteriaDefinition): boolean {
	if (valueEq(from, to)) return false;
	const t = crit.changeThresholds?.[attr];
	const a = typeof from === 'object' && from && !Array.isArray(from) ? num(from as never) : typeof from === 'number' ? from : null;
	const b = typeof to === 'object' && to && !Array.isArray(to) ? num(to as never) : typeof to === 'number' ? to : null;
	if (!t || a === null || b === null) return true;
	const d = Math.abs(b - a);
	return (t.abs !== undefined && d >= t.abs) || (t.pct !== undefined && a !== 0 && (d / Math.abs(a)) * 100 >= t.pct) || (t.abs === undefined && t.pct === undefined);
}

const notifies = (kind: ChangeKind, qual: 'match' | 'possible' | null, crit: CriteriaDefinition) =>
	(crit.notifyOn ?? ['new', 'reopened']).includes(kind as Transition) && (qual !== 'possible' || crit.notifyPossible === true);

export function decide(prev: FindingState | null, o: Outcome, cause: Cause, crit: CriteriaDefinition, criteriaVersion: number): Decision {
	const qualifies = o.qualification === 'match' || o.qualification === 'possible';
	const qual = qualifies ? (o.qualification as 'match' | 'possible') : null;
	const res = results(o);

	if (!prev || prev.status !== 'open') {
		if (!qualifies) return { next: null, event: null, notify: false };
		const kind: ChangeKind = prev ? 'reopened' : 'new';
		return {
			next: { status: 'open', change: kind, qualification: qual!, criteriaVersion, results: res, eventValues: o.relevant },
			event: { kind, diff: prev ? Object.keys(o.relevant).filter((k) => !valueEq(prev.eventValues[k], o.relevant[k])).map((k) => ({ what: k, from: prev.eventValues[k] ?? null, to: o.relevant[k] })) : [], reason: `${o.summary} (${cause.label})` },
			notify: notifies(kind, qual, crit),
		};
	}

	if (!qualifies) {
		const kind: ChangeKind = cause.kind === 'criteria' ? 'superseded'
			: ['source_removed', 'retraction', 'identity'].includes(cause.kind) ? 'invalid'
			: cause.kind === 'time' && o.stale.length ? 'invalid' : 'resolved';
		const diff = Object.keys({ ...prev.eventValues, ...o.relevant }).filter((k) => !valueEq(prev.eventValues[k], o.relevant[k])).map((k) => ({ what: k, from: prev.eventValues[k] ?? null, to: o.relevant[k] ?? null }));
		return { next: { ...prev, status: kind === 'resolved' ? 'resolved' : kind === 'superseded' ? 'superseded' : 'invalid', change: kind, criteriaVersion, results: res, eventValues: o.relevant }, event: { kind, diff, reason: `${o.summary} (${cause.label})` }, notify: notifies(kind, prev.qualification, crit) };
	}

	const diff: Diff[] = [];
	if (prev.qualification !== qual) diff.push({ what: 'qualification', from: prev.qualification, to: qual });
	for (const [p, r] of Object.entries(res)) if (prev.results[p] !== undefined && prev.results[p] !== r) diff.push({ what: `condition ${p}`, from: prev.results[p], to: r });
	// A derived value changes whenever its inputs do; its inputs' own changes are what count, unless it has its own threshold.
	const derivedNames = new Set((crit.derive ?? []).map((d) => d.name).filter((n) => !crit.changeThresholds?.[n]));
	for (const k of new Set([...Object.keys(prev.eventValues), ...Object.keys(o.relevant)])) if (!derivedNames.has(k) && meaningfulValueChange(k, prev.eventValues[k] ?? null, o.relevant[k] ?? null, crit)) diff.push({ what: k, from: prev.eventValues[k] ?? null, to: o.relevant[k] ?? null });
	if (prev.criteriaVersion !== criteriaVersion && !diff.length) {
		// Re-evaluated under a new criteria version and still qualifies the same way: record it, do not announce it.
		return { next: { ...prev, change: 'persistent', criteriaVersion, results: res }, event: { kind: 'persistent', diff: [{ what: 'criteria version', from: prev.criteriaVersion, to: criteriaVersion }], reason: `still qualifies under criteria v${criteriaVersion}` }, notify: false };
	}
	if (!diff.length) return { next: { ...prev, change: 'persistent', criteriaVersion, results: res }, event: null, notify: false };
	return { next: { status: 'open', change: 'changed', qualification: qual!, criteriaVersion, results: res, eventValues: o.relevant }, event: { kind: 'changed', diff, reason: `${o.summary} (${cause.label})` }, notify: notifies('changed', qual, crit) };
}

/** Attention order for a feed: score × confidence, plus recency of the last meaningful change. Explained. */
export function priority(f: { score: number; confidence: number; lastChangedAt: string; status: FindingStatus; acknowledged: boolean }, nowIso: string): { value: number; why: string } {
	if (f.status !== 'open') return { value: 0, why: 'closed' };
	const hours = (Date.parse(nowIso) - Date.parse(f.lastChangedAt)) / 3_600_000;
	const recency = hours < 24 ? 25 : hours < 24 * 7 ? 10 : 0;
	const base = f.score * f.confidence;
	const value = Math.round((base + recency) * (f.acknowledged ? 0.3 : 1));
	return { value, why: `score ${f.score} × confidence ${f.confidence}${recency ? ` + ${recency} (changed ${hours < 24 ? 'today' : 'this week'})` : ''}${f.acknowledged ? ' × 0.3 (acknowledged)' : ''}` };
}
