import type {
	Condition, ConditionTrace, CriteriaDefinition, CriteriaEvaluator, EvaluationResult, ExtractedField, Interpretation
} from '../contracts/types.ts';
import type { PageRepresentation } from '../page/types.ts';
import { evaluateEntityCondition, validateEntityCondition } from '../page/query.ts';
import { canonicalJson } from './canonical.ts';
import { discover, validateIntent } from '../discovery/discover.ts';

/**
 * Deterministic criteria evaluation. Pure function of
 * (current interpretation, previous interpretation, criteria, context).
 * No I/O, no clock reads (time comes from ctx.now), no model calls.
 */

const MAX_DEPTH = 16;
const MAX_NODES = 256;

function fieldMap(i: Interpretation | undefined): Map<string, ExtractedField> {
	return new Map((i?.fields ?? []).map((f) => [f.field, f]));
}

/** Levenshtein-bounded search: does `term` occur in `text` with ≤ maxDistance edits? */
export function fuzzyContains(text: string, term: string, maxDistance: number): { found: boolean; distance: number } {
	const t = term.toLowerCase();
	const s = text.toLowerCase();
	if (!t) return { found: true, distance: 0 };
	// Sellers' variant of Levenshtein: best match of `t` against any substring of `s`.
	let prev = new Array(t.length + 1).fill(0).map((_, j) => j);
	let best = prev[t.length];
	for (let i = 1; i <= s.length; i++) {
		const cur = [0];
		for (let j = 1; j <= t.length; j++) {
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
		}
		best = Math.min(best, cur[t.length]);
		prev = cur;
	}
	return { found: best <= maxDistance, distance: best };
}

function cmpEq(a: unknown, b: unknown, caseSensitive: boolean): boolean {
	if (typeof a === 'string' && typeof b === 'string' && !caseSensitive) return a.toLowerCase() === b.toLowerCase();
	return a === b;
}

export function validateCondition(c: Condition, depth = 0, count = { n: 0 }): void {
	if (depth > MAX_DEPTH) throw new Error(`Criteria nesting exceeds ${MAX_DEPTH}`);
	if (++count.n > MAX_NODES) throw new Error(`Criteria exceeds ${MAX_NODES} conditions`);
	if ('all' in c || 'any' in c) {
		const list = 'all' in c ? c.all : c.any;
		if (!Array.isArray(list) || list.length === 0) throw new Error('all/any requires a non-empty list');
		list.forEach((x) => validateCondition(x, depth + 1, count));
	} else if ('not' in c) validateCondition(c.not, depth + 1, count);
	else if ('field' in c) {
		const needsValue = !['exists', 'absent', 'changed', 'unchanged', 'increased', 'decreased'].includes(c.op);
		if (needsValue && c.value === undefined) throw new Error(`Condition on ${c.field}: op ${c.op} requires value`);
		if (c.op === 'matches') new RegExp(String(c.value));
		if (c.op === 'in' && !Array.isArray(c.value)) throw new Error(`Condition on ${c.field}: op in requires an array`);
	} else if ('text' in c) {
		if (c.text.matches) new RegExp(c.text.matches, c.text.flags);
		if (!c.text.contains && !c.text.matches && !c.text.fuzzy) throw new Error('text condition needs contains, matches or fuzzy');
	} else if ('entity' in c) {
		if (!c.entity || typeof c.entity !== 'object') throw new Error('entity condition needs an object');
		validateEntityCondition(c.entity);
	} else if ('discover' in c) {
		if (!c.discover || typeof c.discover !== 'object') throw new Error('discover condition needs an intent');
		const errors = validateIntent(c.discover);
		if (errors.length) throw new Error(`discover: ${errors.join('; ')}`);
	} else if (!('signal' in c) && !('content' in c)) throw new Error(`Unknown condition: ${JSON.stringify(c)}`);
}

export class DeterministicEvaluator implements CriteriaEvaluator {
	evaluate(
		current: Interpretation,
		previous: Interpretation | undefined,
		criteria: CriteriaDefinition,
		ctx: { now: string; normalizedText: string; contentChanged: boolean | undefined; page?: PageRepresentation; previousPage?: PageRepresentation }
	): EvaluationResult {
		validateCondition(criteria.condition);
		const cur = fieldMap(current);
		const prev = fieldMap(previous);
		const trace: ConditionTrace[] = [];
		const matchedValues: Record<string, unknown> = {};

		const walk = (c: Condition, path: string): boolean => {
			if ('all' in c) {
				// Evaluate every child (no short-circuit) so the trace is complete.
				const r = c.all.map((x, i) => walk(x, `${path}.all[${i}]`)).every(Boolean);
				trace.push({ path, op: 'all', result: r });
				return r;
			}
			if ('any' in c) {
				const r = c.any.map((x, i) => walk(x, `${path}.any[${i}]`)).some(Boolean);
				trace.push({ path, op: 'any', result: r });
				return r;
			}
			if ('not' in c) {
				const r = !walk(c.not, `${path}.not`);
				trace.push({ path, op: 'not', result: r });
				return r;
			}
			if ('field' in c) {
				const f = cur.get(c.field);
				const p = prev.get(c.field);
				const actual = f?.value ?? null;
				const before = previous ? (p?.value ?? null) : undefined;
				const cs = c.caseSensitive ?? false;
				let r: boolean;
				let note: string | undefined;
				switch (c.op) {
					case 'exists': r = actual !== null; break;
					case 'absent': r = actual === null; break;
					case 'eq': r = actual !== null && cmpEq(actual, c.value, cs); break;
					case 'neq': r = actual !== null && !cmpEq(actual, c.value, cs); break;
					case 'lt': case 'lte': case 'gt': case 'gte': {
						if (typeof actual !== 'number' || typeof c.value !== 'number') { r = false; note = 'non-numeric or missing value'; break; }
						r = c.op === 'lt' ? actual < c.value : c.op === 'lte' ? actual <= c.value : c.op === 'gt' ? actual > c.value : actual >= c.value;
						break;
					}
					case 'contains': case 'not_contains': {
						const has = actual !== null && (cs ? String(actual).includes(String(c.value)) : String(actual).toLowerCase().includes(String(c.value).toLowerCase()));
						r = c.op === 'contains' ? has : actual !== null && !has;
						break;
					}
					case 'matches': r = actual !== null && new RegExp(String(c.value), cs ? '' : 'i').test(String(actual)); break;
					case 'in': r = actual !== null && (c.value as unknown[]).some((v) => cmpEq(actual, v, cs)); break;
					case 'changed': case 'unchanged': case 'increased': case 'decreased': {
						if (before === undefined) { r = false; note = 'no previous observation (baseline)'; break; }
						if (c.op === 'changed') r = actual !== before;
						else if (c.op === 'unchanged') r = actual === before;
						else if (typeof actual !== 'number' || typeof before !== 'number') { r = false; note = 'non-numeric or missing value'; }
						else r = c.op === 'increased' ? actual > before : actual < before;
						break;
					}
					default: r = false; note = `unknown op ${(c as { op: string }).op}`;
				}
				trace.push({ path: `${path}.field(${c.field})`, op: c.op, expected: c.value, actual, previous: before, result: r, note });
				if (r) matchedValues[`field:${c.field}`] = actual;
				return r;
			}
			if ('text' in c) {
				const text = ctx.normalizedText;
				const parts: boolean[] = [];
				let actual: unknown;
				if (c.text.contains !== undefined) {
					const i = text.toLowerCase().indexOf(c.text.contains.toLowerCase());
					parts.push(i >= 0);
					if (i >= 0) actual = text.slice(i, i + c.text.contains.length);
				}
				if (c.text.matches !== undefined) {
					const m = new RegExp(c.text.matches, (c.text.flags ?? 'i').replace(/g/g, '')).exec(text);
					parts.push(!!m);
					if (m) actual = m[0];
				}
				if (c.text.fuzzy) {
					const f = fuzzyContains(text, c.text.fuzzy.term, c.text.fuzzy.maxDistance);
					parts.push(f.found);
					if (f.found) actual = `${c.text.fuzzy.term} (edit distance ${f.distance})`;
				}
				const r = parts.every(Boolean);
				trace.push({ path: `${path}.text`, op: 'text', expected: c.text, actual: actual ?? null, result: r });
				if (r) matchedValues[`text:${JSON.stringify(c.text)}`] = actual ?? null;
				return r;
			}
			if ('entity' in c) {
				const r = evaluateEntityCondition(c.entity, ctx.page, ctx.previousPage);
				const shown = r.matches.slice(0, 20).map((m) => ({ id: m.id, type: m.type, name: m.name, values: m.values, ...(m.previous ? { previous: m.previous } : {}), evidenceRefs: m.evidenceRefs }));
				trace.push({ path: `${path}.entity`, op: 'entity', expected: c.entity, actual: shown, result: r.matched, note: r.note ?? `${r.matches.length} of ${r.candidates} candidate entities matched` });
				if (r.matched) matchedValues[`entity:${canonicalJson(c.entity)}`] = r.matches.map((m) => ({ id: m.id, values: m.values })).sort((a, b) => a.id.localeCompare(b.id));
				return r.matched;
			}
			if ('discover' in c) {
				if (!ctx.page) { trace.push({ path: `${path}.discover`, op: 'discover', expected: c.discover.name, actual: null, result: false, note: 'no page representation (not HTML)' }); return false; }
				const previous = ctx.previousPage ? discover({ intent: c.discover, pages: [ctx.previousPage] }) : undefined;
				const r = discover({ intent: c.discover, pages: [ctx.page], ...(previous ? { previous } : {}) });
				const matches = r.candidates.filter((x) => x.status === 'match');
				const shown = matches.slice(0, 20).map((m) => ({
					key: m.key, name: m.name, type: m.type, criteria: m.criteria.map((x) => x.label),
					values: Object.fromEntries(m.criteria.map((x) => [x.id, x.values])), ...(m.changed ? { changed: m.changed.fields } : {}),
					locators: m.locators
				}));
				const ok = matches.length > 0;
				trace.push({ path: `${path}.discover`, op: 'discover', expected: c.discover.name, actual: shown, result: ok, note: `${matches.length} match, ${r.candidates.filter((x) => x.status === 'possible').length} possible, of ${r.candidates.length} candidates` });
				// The matched set and its values: a new match, a lost match or a changed value is a new alert; the same set is a duplicate.
				if (ok) matchedValues[`discover:${c.discover.id}`] = matches.map((m) => ({ key: m.key, values: m.criteria.map((x) => [x.id, x.values]) })).sort((a, b) => a.key.localeCompare(b.key));
				return ok;
			}
			if ('signal' in c) {
				const hits = current.signals.filter((s) =>
					s.ok &&
					(!c.signal.codec || s.codec === c.signal.codec) &&
					(!c.signal.kind || s.kind === c.signal.kind) &&
					(!c.signal.payloadContains || JSON.stringify(s.payload ?? {}).toLowerCase().includes(c.signal.payloadContains.toLowerCase()))
				);
				const r = hits.length > 0;
				trace.push({ path: `${path}.signal`, op: 'signal', expected: c.signal, actual: hits.map((h) => ({ codec: h.codec, kind: h.kind, payload: h.payload })), result: r });
				if (r) matchedValues[`signal:${JSON.stringify(c.signal)}`] = hits.map((h) => h.payload);
				return r;
			}
			// content changed / unchanged
			const changed = ctx.contentChanged;
			const r = changed === undefined ? false : c.content === 'changed' ? changed : !changed;
			trace.push({ path: `${path}.content`, op: `content_${c.content}`, actual: changed ?? null, result: r, note: changed === undefined ? 'no previous observation (baseline)' : undefined });
			if (r) matchedValues['content'] = current.normalizedTextHash;
			return r;
		};

		const matched = walk(criteria.condition, '$');
		return { matched, trace, matchedValues: matched ? matchedValues : {} };
	}
}

/** Leaves that were true, for the event body. */
export function matchedLeaves(trace: ConditionTrace[]): ConditionTrace[] {
	return trace.filter((t) => t.result && !['all', 'any', 'not'].includes(String(t.op)));
}
