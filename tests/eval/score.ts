/**
 * Scoring signal.page/v1 against independent labels (tests/fixtures/real/labels).
 * Resolution of label paths is implemented here (own attribute, or relationship hops),
 * deliberately NOT reusing lib/page/query.ts aliases, so the scorer does not inherit
 * the extractor's assumptions.
 *
 * Outcome taxonomy for every expected fact:
 *   correct                — extracted and equal under the label's comparison
 *   not_understood         — extracted but wrong value/type/normalization
 *   ambiguous              — extracted as ambiguous (null + candidates)
 *   missed                 — present in the page's accessible content, not extracted
 *   not_accessible         — present only visually (CSS class, icon); reported separately
 *   not_present            — the page does not contain it (label-declared)
 */
import { load } from 'cheerio';
import type { PageEntity, PageRepresentation } from '../../lib/page/types.ts';

export type Outcome = 'correct' | 'not_understood' | 'ambiguous' | 'missed' | 'not_accessible' | 'not_present';
interface LabelAttr { paths: string[]; value: unknown; compare: string; accessible?: boolean }
interface LabelEnt { match: { attr: string; value: string; compare?: string }; acceptTypes: string[]; attributes: Record<string, LabelAttr>; relationships?: Array<{ types: string[]; to: { attr: string; value: string } }> }
export interface Label { id: string; category: string; entities: LabelEnt[]; precisionScope?: 'page' | 'matched-collections' }

const norm = (s: unknown) => String(s ?? '').replace(/[​-‏﻿]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

function resolve(rep: PageRepresentation, e: PageEntity, path: string, depth = 0): PageEntity['attributes'] {
	const [head, ...rest] = path.split('.');
	if (!rest.length) return e.attributes.filter((a) => a.name === head);
	if (depth > 3) return [];
	return rep.relationships.filter((r) => r.from === e.id && r.type === head)
		.map((r) => rep.entities.find((x) => x.id === r.to)).filter((x): x is PageEntity => !!x)
		.flatMap((x) => resolve(rep, x, rest.join('.'), depth + 1));
}

export function compareValue(actual: unknown, expected: unknown, mode: string): boolean {
	if (actual === null || actual === undefined) return false;
	switch (mode) {
		case 'money': {
			const a = actual as { amount?: number; currency?: string | null }, e = expected as { amount: number; currency: string };
			return typeof a === 'object' && Math.abs((a.amount ?? NaN) - e.amount) < 0.005 && (!a.currency || a.currency === e.currency);
		}
		case 'number': {
			const n = typeof actual === 'number' ? actual : typeof actual === 'object' && actual && 'value' in actual ? (actual as { value: number }).value : Number(String(actual).replace(/[^\d.-]/g, ''));
			return Math.abs(n - Number(expected)) < 1e-6;
		}
		case 'date': return String(actual).slice(0, 10) === String(expected).slice(0, 10);
		case 'availability': return String(actual) === String(expected);
		case 'contains': return norm(typeof actual === 'object' && actual && 'url' in actual ? (actual as { url: string }).url : actual).includes(norm(expected));
		case 'prefix': { const a = norm(actual).replace(/\s*(\.\.\.|…)$/, ''); return a === norm(expected) || (a.length >= 8 && norm(expected).startsWith(a)); }
		default: return norm(actual) === norm(expected);
	}
}

export interface PageScore {
	id: string; category: string;
	entities: { expected: number; found: number; foundWrongType: number; missed: number; duplicates: number; falseEntities: number; targetTypedExtracted: number; declaredUnlabeled?: number };
	attributes: Record<Outcome, number>;
	attributesByMethod: Record<string, { correct: number; not_understood: number; ambiguous: number }>;
	attributesByCompare: Record<string, { correct: number; total: number }>;
	relationships: { expected: number; correct: number; attributeOnly: number; missed: number; extractedFromMatched: number; extractedCorrect: number };
	traceability: { attributes: number; resolved: number };
	textCoverage: number;
	examples: Array<{ outcome: string; entity: string; detail: string }>;
}

export function scorePage(label: Label, rep: PageRepresentation, html: string): PageScore {
	const $ = load(html);
	const visibleSource = norm($('body').text());
	// Precision is about entities that *claim* a labelled type. 'Unknown' claims nothing, so it is never a
	// false entity (metric correction made after the first held-out run; see PAGE_QUALITY.md).
	const targetTypes = new Set(label.entities.flatMap((e) => e.acceptTypes).filter((t) => t !== 'WebPage' && t !== 'Unknown'));
	const s: PageScore = {
		id: label.id, category: label.category,
		entities: { expected: label.entities.length, found: 0, foundWrongType: 0, missed: 0, duplicates: 0, falseEntities: 0, targetTypedExtracted: 0 },
		attributes: { correct: 0, not_understood: 0, ambiguous: 0, missed: 0, not_accessible: 0, not_present: 0 },
		attributesByMethod: {}, attributesByCompare: {},
		relationships: { expected: 0, correct: 0, attributeOnly: 0, missed: 0, extractedFromMatched: 0, extractedCorrect: 0 },
		traceability: { attributes: 0, resolved: 0 }, textCoverage: 0, examples: []
	};
	const ex = (outcome: string, entity: string, detail: string) => { if (s.examples.filter((x) => x.outcome === outcome).length < 4) s.examples.push({ outcome, entity, detail }); };
	const matchedIds = new Set<string>();
	const matchesKey = (e: PageEntity, m: LabelEnt['match']) => {
		const paths = m.attr === 'author' ? ['author', 'author.name'] : m.attr === 'name' ? ['name', 'headline', 'title'] : [m.attr];
		return paths.some((p) => resolve(rep, e, p).some((a) => compareValue(a.value ?? a.raw, m.value, m.compare ?? 'text') || (m.compare === 'contains' && compareValue(a.raw, m.value, 'contains'))));
	};
	const usedForMatch = new Set<string>();
	for (const le of label.entities) {
		const cands = rep.entities.filter((e) => e.type !== 'WebPage' && !usedForMatch.has(e.id) && matchesKey(e, le.match));
		const typed = cands.filter((e) => le.acceptTypes.includes(e.type));
		const all = rep.entities.filter((e) => e.type !== 'WebPage' && le.acceptTypes.includes(e.type) && matchesKey(e, le.match));
		// When several extracted entities share the key (same name in several tables), pick the one with the
		// most correct labelled attributes, so an entity is credited if it is correctly represented anywhere.
		const fit = (e: PageEntity) => Object.values(le.attributes).filter((la) => la.paths.some((p) => resolve(rep, e, p).some((a) => compareValue(a.value, la.value, la.compare)))).length;
		const best = (xs: PageEntity[]) => xs.map((e, i) => ({ e, f: fit(e), i })).sort((a, b) => b.f - a.f || a.i - b.i)[0]?.e;
		const pick = best(typed) ?? best(cands) ?? (le.acceptTypes.includes('WebPage') ? rep.entities.find((e) => e.type === 'WebPage' && matchesKey(e, le.match)) : undefined);
		if (!pick) {
			s.entities.missed++;
			ex('entity_missed', le.match.value, visibleSource.includes(norm(le.match.value).slice(0, 20)) ? 'key text is visible on the page' : 'key text not in visible text');
			for (const [, la] of Object.entries(le.attributes)) s.attributes[la.accessible === false ? 'not_accessible' : 'missed']++;
			for (const _r of le.relationships ?? []) { s.relationships.expected++; s.relationships.missed++; }
			continue;
		}
		usedForMatch.add(pick.id);
		matchedIds.add(pick.id);
		if (le.acceptTypes.includes(pick.type)) s.entities.found++; else { s.entities.foundWrongType++; ex('wrong_type', le.match.value, `typed ${pick.type} (${pick.typeBasis.rule}); accepted ${le.acceptTypes.join('/')}`); }
		// Duplicates: more extracted entities match this key than the labels expect entities with that key.
		const sameKey = label.entities.filter((x) => x.match.attr === le.match.attr && norm(x.match.value) === norm(le.match.value)).length;
		if (all.length > sameKey) s.entities.duplicates += (all.length - sameKey) / sameKey;
		for (const [name, la] of Object.entries(le.attributes)) {
			const got = la.paths.flatMap((p) => resolve(rep, pick, p));
			const cmp = (s.attributesByCompare[la.compare] ??= { correct: 0, total: 0 });
			cmp.total++;
			if (!got.length) {
				const outcome: Outcome = la.accessible === false ? 'not_accessible' : 'missed';
				s.attributes[outcome]++;
				ex(`attr_${outcome}`, le.match.value, `${name} (paths ${la.paths.join('|')})`);
				continue;
			}
			const ok = got.find((a) => compareValue(a.value, la.value, la.compare));
			const amb = got.find((a) => a.value === null && a.ambiguity);
			const outcome: Outcome = ok ? 'correct' : amb ? 'ambiguous' : 'not_understood';
			s.attributes[outcome]++;
			if (ok) cmp.correct++;
			const m = (s.attributesByMethod[(ok ?? got[0]).method] ??= { correct: 0, not_understood: 0, ambiguous: 0 });
			m[outcome === 'correct' ? 'correct' : outcome === 'ambiguous' ? 'ambiguous' : 'not_understood']++;
			if (!ok) ex(`attr_${outcome}`, le.match.value, `${name}: got ${JSON.stringify(got[0].value)?.slice(0, 80)} expected ${JSON.stringify(la.value)?.slice(0, 80)}`);
		}
		for (const lr of le.relationships ?? []) {
			s.relationships.expected++;
			const targets = rep.relationships.filter((r) => r.from === pick.id && lr.types.includes(r.type)).map((r) => rep.entities.find((e) => e.id === r.to)!).filter(Boolean);
			const hit = targets.find((t) => matchesKey(t, lr.to));
			if (hit) { s.relationships.correct++; continue; }
			const asAttr = lr.types.some((t) => pick.attributes.some((a) => a.name === t && compareValue(a.value, lr.to.value, 'text')));
			if (asAttr) { s.relationships.attributeOnly++; ex('rel_attribute_only', le.match.value, `${lr.types[0]} → ${lr.to.value} kept as a text attribute`); }
			else { s.relationships.missed++; ex('rel_missed', le.match.value, `${lr.types[0]} → ${lr.to.value}`); }
		}
		const relTypes = new Set((le.relationships ?? []).flatMap((r) => r.types));
		for (const r of rep.relationships.filter((x) => x.from === pick.id && relTypes.has(x.type))) {
			s.relationships.extractedFromMatched++;
			const to = rep.entities.find((e) => e.id === r.to);
			if (to && (le.relationships ?? []).some((lr) => lr.types.includes(r.type) && matchesKey(to, lr.to))) s.relationships.extractedCorrect++;
		}
	}
	// precisionScope 'matched-collections': only collections containing a labelled entity are judged (the label
	// covers one table of several on the page).
	const inScope = label.precisionScope === 'matched-collections'
		? new Set(rep.collections.filter((c) => c.members.some((m) => matchedIds.has(m))).flatMap((c) => c.members))
		: null;
	for (const e of rep.entities) {
		if (!targetTypes.has(e.type)) continue;
		if (inScope && !inScope.has(e.id)) continue;
		// Entities the page itself declares (JSON-LD, microdata) but the labels do not list (e.g. the site's own
		// publisher Organization) are page facts, not extractor inventions: reported, not counted as false.
		if (e.classification === 'declared' && !matchedIds.has(e.id)) { s.entities.declaredUnlabeled = (s.entities.declaredUnlabeled ?? 0) + 1; continue; }
		s.entities.targetTypedExtracted++;
		if (!matchedIds.has(e.id)) {
			s.entities.falseEntities++;
			ex('false_entity', String(e.attributes.find((a) => a.name === 'name')?.value ?? e.id), `${e.type} via ${e.typeBasis.rule}`);
		}
	}
	// Evidence traceability: every attribute's evidence locator resolves to exactly one element.
	const ev = new Map(rep.evidence.map((x) => [x.id, x]));
	for (const e of rep.entities) for (const a of e.attributes) {
		s.traceability.attributes++;
		if (a.evidenceRefs.length && a.evidenceRefs.every((r) => { const x = ev.get(r); return !!x && $(x.locator.replace(/>/g, ' > ')).length === 1; })) s.traceability.resolved++;
	}
	// Text coverage: share of distinct visible words (outside nav/header/footer/script) present in the representation's values.
	$('script,style,noscript,template,nav,header,footer').remove();
	const words = new Set(norm($('body').text()).split(/[^a-z0-9£$€.]+/).filter((w) => w.length >= 4));
	const repText = norm(rep.entities.flatMap((e) => e.attributes.map((a) => `${a.raw ?? ''} ${typeof a.value === 'string' ? a.value : ''}`)).join(' '));
	const repWords = new Set(repText.split(/[^a-z0-9£$€.]+/));
	s.textCoverage = words.size ? [...words].filter((w) => repWords.has(w)).length / words.size : 1;
	return s;
}

export function rate(n: number, d: number): number | null { return d ? +(n / d).toFixed(3) : null; }

export function summarize(p: PageScore) {
	const attrTotal = p.attributes.correct + p.attributes.not_understood + p.attributes.ambiguous + p.attributes.missed;
	return {
		id: p.id, category: p.category,
		entityRecall: rate(p.entities.found, p.entities.expected),
		entityDetection: rate(p.entities.found + p.entities.foundWrongType, p.entities.expected),
		entityPrecision: rate(p.entities.targetTypedExtracted - p.entities.falseEntities, p.entities.targetTypedExtracted),
		falseEntityRate: rate(p.entities.falseEntities, p.entities.targetTypedExtracted),
		wrongTypeRate: rate(p.entities.foundWrongType, p.entities.found + p.entities.foundWrongType),
		duplicateRate: p.entities.found + p.entities.foundWrongType ? +(p.entities.duplicates / (p.entities.found + p.entities.foundWrongType)).toFixed(3) : null,
		attributeRecall: rate(p.attributes.correct, attrTotal),
		attributePrecision: rate(p.attributes.correct, p.attributes.correct + p.attributes.not_understood),
		relationshipRecall: rate(p.relationships.correct, p.relationships.expected),
		relationshipPrecision: rate(p.relationships.extractedCorrect, p.relationships.extractedFromMatched),
		traceability: rate(p.traceability.resolved, p.traceability.attributes),
		textCoverage: +p.textCoverage.toFixed(3),
		attributes: p.attributes, entities: p.entities, relationships: p.relationships,
		byMethod: p.attributesByMethod, byCompare: p.attributesByCompare, examples: p.examples
	};
}
