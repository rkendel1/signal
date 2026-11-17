/**
 * Discovery over page representations — signal.discovery/v1 (pure, deterministic).
 *
 * A page tells Signal what information is available. Context tells Signal where to look.
 * Intent tells Signal what matters. Discovery finds the candidates. Evidence explains every result.
 *
 * Implemented here (M7): context extraction with provenance, intent with derived metrics, candidate
 * reconciliation across descriptions, three-valued criteria (true / false / unknown), geographic scope,
 * external enrichments kept distinct from page facts, explicit coverage, change detection against a
 * previous result, and a deterministic scan plan (proposals only — nothing is executed here).
 */
import { canonicalJson, sha256 } from '../core/canonical.ts';
import { continuityOf, type AttrPredicate } from '../page/query.ts';
import type { AttributeValue, PageEntity, PageRepresentation } from '../page/types.ts';

// ------------------------------------------------------------------ contracts

export type ContextSource = 'page-explicit' | 'page-inferred' | 'user' | 'unknown';
export interface ContextValue<T = unknown> { value: T | null; source: ContextSource; basis: string; evidenceRef?: string }
export interface Bounds { south: number; west: number; north: number; east: number }

export interface DiscoveryContext {
	url: ContextValue<string>;
	query: ContextValue<string>;
	sort: ContextValue<string>;
	filters: Array<ContextValue<{ name: string; value: string }>>;
	bounds: ContextValue<Bounds>;
	declaredTotal: ContextValue<number>;
	shown: ContextValue<number>;
	nextPage: ContextValue<string>;
	viewportMarkers: ContextValue<number>;
	selection: ContextValue<string[]>;
}

export type Formula = { attr: string } | { const: number } | { mul: Formula[] } | { add: Formula[] } | { div: [Formula, Formula] } | { sub: [Formula, Formula] };
export interface MetricDefinition { name: string; formula: Formula; unit?: string }
export interface IntentCriterion {
	id: string;
	label: string;
	where: AttrPredicate;
	/** Metric criteria reference a metric name; `where.attr` is then informational. */
	metric?: string;
	/** What absence means. Default 'unknown' (missing information is never a match). 'false' is an explicit,
	 *  documented closed-world choice by the intent author, e.g. "price reduced" when the source always badges reductions. */
	absent?: 'unknown' | 'false';
}
export interface DiscoveryIntent {
	schema: 'signal.intent/v1';
	id: string;
	version: number;
	name: string;
	target: { type: string[] };
	criteria: IntentCriterion[];
	metrics?: MetricDefinition[];
	/** Ordering only; never used to include or exclude. */
	preferences?: Array<{ attr: string; direction: 'asc' | 'desc' }>;
}

/** Values from an authorized external source, joined by URL. Never treated as page facts. */
export interface Enrichment {
	source: { id: string; name: string; method: 'external-estimate' | 'external-record'; observedAt: string };
	records: Array<{ url: string; attribute: string; value: AttributeValue }>;
}

export interface DiscoveryScope { bounds?: Bounds; source: ContextSource }

export type Tri = 'true' | 'false' | 'unknown';
export interface CriterionResult { id: string; label: string; result: Tri; reason?: string; values: AttributeValue[]; provenance: string[] }
export interface Candidate {
	key: string; // reconciled identity (source URL when known, else entity id)
	entityIds: string[]; // all descriptions of this thing on the examined pages
	type: string;
	name: string | null;
	status: 'match' | 'possible' | 'non_match' | 'out_of_scope';
	criteria: CriterionResult[];
	missing: string[]; // criteria that could not be decided, and why
	metrics: Record<string, { value: number | null; /** several values when inputs conflict */ possibleValues?: number[]; provenance: 'calculated'; inputs: Array<{ attr: string; provenance: string; source?: string }> }>;
	changed?: { since: string; fields: string[] };
	evidenceRefs: string[];
	/** Where the candidate is on the page: CSS locators of visible elements (not JSON-LD), record element first. */
	locators: string[];
}

export interface DiscoveryCoverage {
	pagesExamined: number;
	declaredTotal: number | null; // what the source says exists (e.g. "of 87 homes")
	listed: number; // items shown in the examined result lists, of any type
	nonTarget: number; // listed items that are not of the intent's target type
	discovered: number; // target-type candidates represented
	extracted: number; // with at least one attribute
	categorized: number; // typed (not Unknown)
	inScope: number;
	evaluated: number; // every criterion decided
	partiallyEvaluated: number; // some criteria unknown
	ambiguous: number; // identity ambiguous or conflicting descriptions
	outOfScope: number;
	notYetExamined: number | null; // declaredTotal − discovered, when known
	unavailable: Array<{ what: string; why: string }>;
	exhaustive: boolean;
	exhaustiveBasis: string;
}

export interface ScanSuggestion { kind: 'next_page' | 'detail_page' | 'enrichment' | 'skip_unchanged' | 'expand_scope'; target: string; reason: string; executesIn: 'browser-session' | 'background' | 'user'; priority: number }

export interface DiscoveryResult {
	schema: 'signal.discovery/v1';
	intent: { id: string; version: number };
	context: DiscoveryContext;
	scope: DiscoveryScope;
	candidates: Candidate[];
	coverage: DiscoveryCoverage;
	plan: ScanSuggestion[];
	pages: Array<{ observationId: string; revision: string; factsRevision: string }>;
	resultDigest: string;
}

// ------------------------------------------------------------------ context

const attrOf = (e: PageEntity | undefined, name: string) => e?.attributes.find((a) => a.name === name);

export function extractContext(page: PageRepresentation, user: { bounds?: Bounds; selection?: string[] } = {}): DiscoveryContext {
	const wp = page.entities.find((e) => e.type === 'WebPage');
	const unknown = <T>(basis: string): ContextValue<T> => ({ value: null, source: 'unknown', basis });
	let url: URL | null = null;
	try { url = new URL(String(attrOf(wp, 'canonicalUrl')?.value ?? page.source.baseUrl ?? page.source.locator)); } catch { url = null; }
	const p = url?.searchParams;
	const param = (...names: string[]) => names.map((n) => p?.get(n)).find((v) => v !== null && v !== undefined) ?? null;
	const num = (v: string | null) => (v !== null && Number.isFinite(Number(v)) ? Number(v) : null);
	const urlBounds = (() => {
		const s = num(param('south', 'sw_lat', 's')), w = num(param('west', 'sw_lng', 'w')), n = num(param('north', 'ne_lat', 'n')), e = num(param('east', 'ne_lng', 'e'));
		if ([s, w, n, e].every((x) => x !== null)) return { south: s!, west: w!, north: n!, east: e! };
		const bbox = param('bbox')?.split(',').map(Number);
		return bbox && bbox.length === 4 && bbox.every(Number.isFinite) ? { west: bbox[0], south: bbox[1], east: bbox[2], north: bbox[3] } : null;
	})();
	const vp = attrOf(wp, 'viewportBounds');
	const vpBounds = vp && typeof vp.value === 'string' ? (JSON.parse(vp.value) as Bounds) : null;
	const known = new Set(['south', 'west', 'north', 'east', 'sw_lat', 'sw_lng', 'ne_lat', 'ne_lng', 'bbox', 'q', 'query', 'search', 'keywords', 'sort', 'order', 'page', 'p']);
	// "Showing 1–12 of 87 homes" / "87 results": a declared total, inferred from text.
	const texts = (wp?.attributes ?? []).filter((a) => a.name === 'text' || a.name === 'heading').map((a) => ({ t: String(a.value), ev: a.evidenceRefs[0] }));
	let declared: ContextValue<number> = unknown('no result count found on the page');
	let shown: ContextValue<number> = unknown('no result range found on the page');
	for (const { t, ev } of texts) {
		const m = /\b(?:showing|results?)?\s*(\d[\d,]*)\s*[-–]\s*(\d[\d,]*)\s+of\s+(\d[\d,]*)/i.exec(t) ?? null;
		if (m) { declared = { value: Number(m[3].replace(/,/g, '')), source: 'page-inferred', basis: `text "${t.slice(0, 60)}"`, evidenceRef: ev }; shown = { value: Number(m[2].replace(/,/g, '')) - Number(m[1].replace(/,/g, '')) + 1, source: 'page-inferred', basis: `text "${t.slice(0, 60)}"`, evidenceRef: ev }; break; }
		const n = /\b(\d[\d,]*)\s+(results|homes|listings|items|jobs|properties|products)\b/i.exec(t);
		if (n && declared.source === 'unknown') declared = { value: Number(n[1].replace(/,/g, '')), source: 'page-inferred', basis: `text "${t.slice(0, 60)}"`, evidenceRef: ev };
	}
	const selected = page.entities.filter((e) => attrOf(e, 'selected')?.value === true).map((e) => e.id);
	const next = attrOf(wp, 'nextPage');
	const markers = attrOf(wp, 'viewportMarkers');
	return {
		url: url ? { value: url.toString(), source: 'page-explicit', basis: attrOf(wp, 'canonicalUrl') ? 'canonical link' : 'observed URL' } : unknown('no URL'),
		query: param('q', 'query', 'search', 'keywords') !== null ? { value: param('q', 'query', 'search', 'keywords'), source: 'page-explicit', basis: 'URL query parameter' } : unknown('no query parameter'),
		sort: param('sort', 'order') !== null ? { value: param('sort', 'order'), source: 'page-explicit', basis: 'URL query parameter' } : unknown('no sort parameter'),
		filters: [...(p?.entries() ?? [])].filter(([k]) => !known.has(k)).map(([k, v]) => ({ value: { name: k, value: v }, source: 'page-explicit' as const, basis: 'URL query parameter' })),
		bounds: user.bounds ? { value: user.bounds, source: 'user', basis: 'drawn or selected by the user' }
			: urlBounds ? { value: urlBounds, source: 'page-explicit', basis: 'URL bounds parameters' }
			: vpBounds ? { value: vpBounds, source: 'page-explicit', basis: 'map element data attributes', evidenceRef: vp!.evidenceRefs[0] }
			: unknown('the page exposes no geographic bounds'),
		declaredTotal: declared,
		shown,
		nextPage: next ? { value: String(next.value), source: 'page-explicit', basis: 'rel=next link', evidenceRef: next.evidenceRefs[0] } : unknown('no rel=next link'),
		viewportMarkers: markers ? { value: Number(markers.value), source: 'page-explicit', basis: 'map markers with coordinates', evidenceRef: markers.evidenceRefs[0] } : unknown('no map markers'),
		selection: user.selection ? { value: user.selection, source: 'user', basis: 'selected by the user' } : selected.length ? { value: selected, source: 'page-explicit', basis: 'aria-selected / aria-current' } : unknown('nothing selected')
	};
}

// ------------------------------------------------------------------ evaluation

interface Group { key: string; entities: Array<{ e: PageEntity; page: PageRepresentation }> }

function resolve(page: PageRepresentation, e: PageEntity, path: string, depth = 0): PageEntity['attributes'] {
	const [head, ...rest] = path.split('.');
	if (!rest.length) {
		const own = e.attributes.filter((a) => a.name === head);
		if (own.length || depth > 0) return own;
		const alias: Record<string, string[]> = { price: ['offers.price'], latitude: ['geo.latitude'], longitude: ['geo.longitude'], numberOfBedrooms: ['numberOfRooms'] };
		for (const a of alias[head] ?? []) { const r = resolve(page, e, a, depth + 1); if (r.length) return r; }
		return [];
	}
	if (depth > 3) return [];
	return page.relationships.filter((r) => r.from === e.id && r.type === head).map((r) => page.entities.find((x) => x.id === r.to)).filter((x): x is PageEntity => !!x).flatMap((x) => resolve(page, x, rest.join('.'), depth + 1));
}

/** Numbers, money amounts and plain numeric strings (JSON-LD often states numbers as strings). */
const num = (v: AttributeValue): number | null => (typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v && typeof v === 'object' && 'amount' in v ? (v as { amount: number }).amount : null);

function triCompare(values: AttributeValue[], p: AttrPredicate): { result: Tri; reason?: string } {
	const present = values.filter((v) => v !== null);
	if (!present.length) return { result: 'unknown', reason: values.length ? 'value ambiguous' : 'not shown' };
	const test = (v: AttributeValue): boolean => {
		const n = num(v);
		switch (p.op) {
			case 'lt': return n !== null && n < Number(p.value);
			case 'lte': return n !== null && n <= Number(p.value);
			case 'gt': return n !== null && n > Number(p.value);
			case 'gte': return n !== null && n >= Number(p.value);
			case 'eq': return n !== null ? n === Number(p.value) : String(v).toLowerCase() === String(p.value).toLowerCase();
			case 'neq': return n !== null ? n !== Number(p.value) : String(v).toLowerCase() !== String(p.value).toLowerCase();
			case 'contains': return String(v).toLowerCase().includes(String(p.value).toLowerCase());
			case 'exists': return true;
			case 'between': { const [a, b] = p.value as number[]; return n !== null && n >= a && n <= b; }
			case 'in': return Array.isArray(p.value) && p.value.some((x) => (n !== null && typeof x === 'number' ? n === x : String(v).toLowerCase() === String(x).toLowerCase()));
			default: return false;
		}
	};
	const outcomes = new Set(present.map(test));
	// Conflicting descriptions that disagree on the outcome cannot decide the criterion.
	if (outcomes.size > 1) return { result: 'unknown', reason: 'descriptions disagree (conflict)' };
	return { result: outcomes.has(true) ? 'true' : 'false' };
}

/** Evaluates a formula over every combination of input values (conflicting descriptions yield several). */
function evalFormula(f: Formula, get: (attr: string) => { values: number[]; provenance: string; source?: string }, inputs: Candidate['metrics'][string]['inputs']): number[] {
	if ('const' in f) return [f.const];
	if ('attr' in f) { const g = get(f.attr); inputs.push({ attr: f.attr, provenance: g.provenance, ...(g.source ? { source: g.source } : {}) }); return g.values; }
	const parts = ('mul' in f ? f.mul : 'add' in f ? f.add : 'div' in f ? f.div : f.sub).map((x) => evalFormula(x, get, inputs));
	if (parts.some((x) => !x.length)) return [];
	let combos: number[][] = [[]];
	for (const p of parts) combos = combos.flatMap((c) => p.map((v) => [...c, v])).slice(0, 64);
	const out = combos.map((xs) => ('mul' in f ? xs.reduce((a, b) => a * b, 1) : 'add' in f ? xs.reduce((a, b) => a + b, 0) : 'div' in f ? (xs[1] === 0 ? NaN : xs[0] / xs[1]) : xs[0] - xs[1]));
	return out.some((x) => !Number.isFinite(x)) ? [] : [...new Set(out)];
}

export interface DiscoverInput {
	intent: DiscoveryIntent;
	pages: PageRepresentation[];
	scope?: DiscoveryScope;
	enrichments?: Enrichment[];
	previous?: DiscoveryResult;
	user?: { bounds?: Bounds; selection?: string[] };
}

const locatorCache = new WeakMap<PageRepresentation, Map<string, string>>();
/** The locator of an evidence item when it is a visible element (JSON-LD evidence points at a <script>). */
function visibleLocator(page: PageRepresentation, id: string): string | null {
	let m = locatorCache.get(page);
	if (!m) { m = new Map(page.evidence.filter((e) => e.method !== 'json-ld' && e.element !== 'script' && e.element !== 'meta').map((e) => [e.id, e.locator])); locatorCache.set(page, m); }
	return m.get(id) ?? null;
}

/**
 * Records whose type was not recognised (Unknown) or is only structural (ListItem, TableRow) are candidates only
 * when they are items of a repeated structure with at least two facts: "items in a list", not stray fragments.
 */
const GENERIC_TYPES = new Set(['Unknown', 'ListItem', 'TableRow']);
const NOT_FACTS = new Set(['text', 'latitude', 'longitude', 'url', 'image', 'selected', 'number']);
const isListedRecord = (e: PageEntity, members: Set<string>) => members.has(e.id) && e.attributes.filter((a) => !NOT_FACTS.has(a.name)).length >= 2;

/** Reconcile: descriptions of the same thing (sameAs, or the same source URL) form one candidate. */
function groupCandidates(pages: PageRepresentation[], targets: Set<string>): Map<string, Group> {
	const groups = new Map<string, Group>();
	const keyOf = new Map<string, string>();
	for (const page of pages) {
		const sameAs = new Map<string, string[]>();
		for (const r of page.relationships.filter((x) => x.type === 'sameAs')) { (sameAs.get(r.from) ?? sameAs.set(r.from, []).get(r.from)!).push(r.to); (sameAs.get(r.to) ?? sameAs.set(r.to, []).get(r.to)!).push(r.from); }
		const members = new Set(page.collections.flatMap((c) => c.members));
		for (const e of page.entities.filter((x) => targets.has(x.type) && (!GENERIC_TYPES.has(x.type) || isListedRecord(x, members)))) {
			const url = e.identity.strength === 'strong' && /^https?:/.test(e.identity.key) ? e.identity.key : null;
			const linked = (sameAs.get(e.id) ?? []).map((id) => keyOf.get(id)).find(Boolean);
			const key = linked ?? url ?? (String(e.attributes.find((a) => a.name === 'url')?.value ?? '') || e.id);
			keyOf.set(e.id, key);
			(groups.get(key) ?? groups.set(key, { key, entities: [] }).get(key)!).entities.push({ e, page });
		}
	}
	return groups;
}

const SUPPORTED_OPS = new Set(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'contains', 'exists', 'between', 'in']);

/** Rejects intents the evaluator cannot decide, instead of silently evaluating them as false. */
export function validateIntent(intent: DiscoveryIntent): string[] {
	const errors: string[] = [];
	if (intent.schema !== 'signal.intent/v1') errors.push('schema must be signal.intent/v1');
	if (!intent.target?.type?.length) errors.push('target.type is required');
	const metrics = new Set((intent.metrics ?? []).map((m) => m.name));
	for (const c of intent.criteria ?? []) {
		if (!SUPPORTED_OPS.has(c.where?.op)) errors.push(`${c.id}: op ${c.where?.op} is not supported in discovery (change ops belong to monitoring criteria)`);
		if (c.metric && !metrics.has(c.metric)) errors.push(`${c.id}: unknown metric ${c.metric}`);
	}
	return errors;
}

export function discover(input: DiscoverInput): DiscoveryResult {
	const { intent, pages } = input;
	const invalid = validateIntent(intent);
	if (invalid.length) throw new Error(`invalid intent: ${invalid.join('; ')}`);
	if (!pages.length) throw new Error('discovery needs at least one page');
	const context = extractContext(pages[0], input.user);
	const scope: DiscoveryScope = input.scope ?? (context.bounds.value ? { bounds: context.bounds.value, source: context.bounds.source } : { source: 'unknown' });
	const targets = new Set(intent.target.type);

	const groups = groupCandidates(pages, targets);
	const enrich = new Map<string, Array<{ attribute: string; value: AttributeValue; source: Enrichment['source'] }>>();
	for (const en of input.enrichments ?? []) for (const r of en.records) (enrich.get(r.url) ?? enrich.set(r.url, []).get(r.url)!).push({ attribute: r.attribute, value: r.value, source: en.source });

	const prevByKey = new Map((input.previous?.candidates ?? []).map((c) => [c.key, c]));
	const candidates: Candidate[] = [];
	for (const g of [...groups.values()].sort((a, b) => (a.key < b.key ? -1 : 1))) {
		const values = (path: string) => g.entities.flatMap(({ e, page }) => resolve(page, e, path));
		const ext = enrich.get(g.key) ?? [];
		// Page facts first; an external value is used only when the page does not state one, and is labelled as such.
		const getValue = (attr: string) => {
			const page = [...new Set(values(attr).map((a) => num(a.value)).filter((v): v is number => v !== null))];
			if (page.length) return { values: page, provenance: page.length === 1 ? 'page' : 'page-conflict' };
			const x = ext.filter((r) => r.attribute === attr).map((r) => ({ v: num(r.value), r }));
			const xs = [...new Set(x.map((y) => y.v).filter((v): v is number => v !== null))];
			return xs.length ? { values: xs, provenance: x[0].r.source.method, source: x[0].r.source.id } : { values: [], provenance: 'missing' };
		};
		const metrics: Candidate['metrics'] = {};
		for (const m of intent.metrics ?? []) {
			const inputs: Candidate['metrics'][string]['inputs'] = [];
			const vs = evalFormula(m.formula, getValue, inputs);
			metrics[m.name] = { value: vs.length === 1 ? vs[0] : null, ...(vs.length > 1 ? { possibleValues: vs } : {}), provenance: 'calculated', inputs };
		}
		const lat = num(values('latitude')[0]?.value ?? null), lng = num(values('longitude')[0]?.value ?? null);
		const inScope = !scope.bounds ? true : lat !== null && lng !== null && lat >= scope.bounds.south && lat <= scope.bounds.north && lng >= scope.bounds.west && lng <= scope.bounds.east;
		const scopeUnknown = !!scope.bounds && (lat === null || lng === null);
		const criteria: CriterionResult[] = intent.criteria.map((c) => {
			if (c.metric) {
				const m = metrics[c.metric];
				const missingInputs = m.inputs.filter((i) => i.provenance === 'missing' || i.provenance === 'page-conflict').map((i) => i.attr);
				const all = m.possibleValues ?? (m.value === null ? [] : [m.value]);
				const r = !all.length ? { result: 'unknown' as Tri, reason: `metric inputs missing: ${missingInputs.join(', ') || 'division by zero'}` } : triCompare(all, c.where);
				return { id: c.id, label: c.label, ...r, values: all, provenance: ['calculated', ...m.inputs.map((i) => `${i.attr}:${i.provenance}${i.source ? `(${i.source})` : ''}`)] };
			}
			const vs = values(c.where.attr);
			const r = vs.length ? triCompare(vs.map((a) => a.value), c.where)
				: ext.some((x) => x.attribute === c.where.attr) ? triCompare(ext.filter((x) => x.attribute === c.where.attr).map((x) => x.value), c.where)
				// Absence decides a criterion only when the intent explicitly declares it (e.g. a badge the source always shows when it applies).
				: c.absent === 'false' ? { result: 'false' as Tri, reason: 'not shown; the intent declares absence as false' }
				: { result: 'unknown' as Tri, reason: 'not shown' };
			return { id: c.id, label: c.label, ...r, values: vs.map((a) => a.value), provenance: vs.length ? [...new Set(vs.map((a) => `${a.provenance}:${a.method}`))] : ext.length ? ['external'] : ['missing'] };
		});
		const status: Candidate['status'] = !inScope && !scopeUnknown ? 'out_of_scope'
			: criteria.some((c) => c.result === 'false') ? 'non_match'
			: criteria.some((c) => c.result === 'unknown') || scopeUnknown ? 'possible' : 'match';
		const first = g.entities[0].e;
		const name = g.entities.map(({ e }) => e.attributes.find((a) => a.name === 'name')?.value).find((v) => typeof v === 'string') as string | undefined;

		const prev = prevByKey.get(g.key);
		// Compare normalized value sets: a fact restated by another description ("4" in JSON-LD, 4 on the card) is not a change.
		const norm = (vs: AttributeValue[] | undefined) => canonicalJson([...new Set((vs ?? []).map((v) => canonicalJson(num(v) ?? v)))].sort());
		const changedFields = prev ? intent.criteria.filter((c) => norm(prev.criteria.find((x) => x.id === c.id)?.values) !== norm(criteria.find((x) => x.id === c.id)!.values)).map((c) => c.id) : [];
		candidates.push({
			key: g.key, entityIds: g.entities.map(({ e }) => e.id), type: first.type, name: name ?? null, status, criteria,
			missing: [...criteria.filter((c) => c.result === 'unknown').map((c) => `${c.id}: ${c.reason}`), ...(scopeUnknown ? ['scope: no coordinates'] : [])],
			metrics, ...(prev && changedFields.length ? { changed: { since: input.previous!.resultDigest, fields: changedFields } } : {}),
			evidenceRefs: [...new Set(g.entities.flatMap(({ e }) => e.evidenceRefs.slice(0, 2)))],
			locators: [...new Set(g.entities.flatMap(({ e, page }) => e.evidenceRefs.map((id) => visibleLocator(page, id)).filter((l): l is string => !!l)))].slice(0, 3)
		});

	}
	// Preferences order results; they never include or exclude.
	const rank = { match: 0, possible: 1, non_match: 2, out_of_scope: 3 };
	candidates.sort((a, b) => rank[a.status] - rank[b.status] || (a.key < b.key ? -1 : 1));

	const inScope = candidates.filter((c) => c.status !== 'out_of_scope');
	const ambiguous = candidates.filter((c) => c.entityIds.some((id) => { for (const p of pages) { const e = p.entities.find((x) => x.id === id); if (e && continuityOf(e)) return true; } return false; }) || c.missing.some((m) => /conflict/.test(m))).length;
	const declared = context.declaredTotal.value;
	const discovered = candidates.length;
	// Items shown in the collections that hold candidates — including items that are not of the target type
	// (a lot in a list of homes). The declared total counts those too.
	const candidateIds = new Set(candidates.flatMap((c) => c.entityIds));
	const listedIds = new Set<string>();
	for (const p of pages) for (const col of p.collections) if (col.members.some((m) => candidateIds.has(m))) for (const m of col.members) listedIds.add(`${p.source.observationId}:${m}`);
	const listed = Math.max(listedIds.size, discovered);
	const allPagesSeen = context.nextPage.value === null;
	const exhaustive = declared !== null && listed >= declared && allPagesSeen;
	const unavailable: DiscoveryCoverage['unavailable'] = [];
	if (context.viewportMarkers.value !== null && context.viewportMarkers.value > listed) unavailable.push({ what: `${context.viewportMarkers.value - listed} map markers without a listing on this page`, why: 'markers are positions only; their listings are not in the examined pages' });
	for (const c of inScope) for (const m of c.missing) if (/inputs missing/.test(m)) { unavailable.push({ what: `${c.name ?? c.key}: ${m.split(':')[0]}`, why: 'needed input not on the page and not in any supplied enrichment' }); }
	const coverage: DiscoveryCoverage = {
		pagesExamined: pages.length, declaredTotal: declared, listed, nonTarget: listed - discovered, discovered,
		extracted: candidates.filter((c) => c.criteria.some((x) => x.values.length)).length,
		categorized: candidates.filter((c) => c.type !== 'Unknown').length,
		inScope: inScope.length,
		evaluated: inScope.filter((c) => c.criteria.every((x) => x.result !== 'unknown')).length,
		partiallyEvaluated: inScope.filter((c) => c.criteria.some((x) => x.result === 'unknown')).length,
		ambiguous, outOfScope: candidates.length - inScope.length,
		notYetExamined: declared !== null ? Math.max(0, declared - listed) : null,
		unavailable,
		exhaustive,
		exhaustiveBasis: exhaustive ? `the page declares ${declared} and all ${listed} were examined (${listed - discovered} not of the target type), with no further pages` : declared === null ? 'the source does not state how many exist' : `the source declares ${declared}; ${listed} examined${allPagesSeen ? '' : '; more pages exist (rel=next)'}`
	};

	const plan: ScanSuggestion[] = [];
	if (context.nextPage.value) plan.push({ kind: 'next_page', target: context.nextPage.value, reason: `${coverage.notYetExamined ?? 'unknown number of'} candidates declared but not yet examined`, executesIn: 'browser-session', priority: 1 });
	for (const c of inScope.filter((x) => x.status === 'possible')) {
		const pageGaps = c.criteria.filter((x) => x.result === 'unknown' && !(intent.criteria.find((ic) => ic.id === x.id)?.metric)).map((x) => x.id);
		const url = c.key.startsWith('http') ? c.key : null;
		if (pageGaps.length && url) plan.push({ kind: 'detail_page', target: url, reason: `may resolve: ${pageGaps.join(', ')}`, executesIn: 'browser-session', priority: 2 });
		const extGaps = c.criteria.filter((x) => x.result === 'unknown' && intent.criteria.find((ic) => ic.id === x.id)?.metric).map((x) => x.id);
		if (extGaps.length) plan.push({ kind: 'enrichment', target: c.key, reason: `metric needs data not on the page: ${extGaps.join(', ')}`, executesIn: 'background', priority: 3 });
	}
	const prevRevs = new Map((input.previous?.pages ?? []).map((p) => [p.observationId, p.factsRevision]));
	for (const p of pages) if ([...prevRevs.values()].includes(p.factsRevision)) plan.push({ kind: 'skip_unchanged', target: p.source.locator, reason: 'facts unchanged since the previous result (same factsRevision)', executesIn: 'browser-session', priority: 9 });
	plan.sort((a, b) => a.priority - b.priority || (a.target < b.target ? -1 : 1));

	const body = { intent: { id: intent.id, version: intent.version }, scope, candidates: candidates.map((c) => [c.key, c.status, c.criteria.map((x) => [x.id, x.result, x.values])]) };
	return {
		schema: 'signal.discovery/v1', intent: { id: intent.id, version: intent.version }, context, scope, candidates, coverage, plan,
		pages: pages.map((p) => ({ observationId: p.source.observationId, revision: p.revision, factsRevision: p.factsRevision })),
		resultDigest: sha256(canonicalJson(body)).slice(0, 16)
	};
}

// ------------------------------------------------------------------ facets: what an intent can be built from

/**
 * What the captured pages offer to filter on, so an intent can be built with controls instead of JSON.
 * Computed with the same reconciliation and attribute resolution the evaluator uses, so a range shown
 * here is exactly the range criteria will be tested against. Counts are candidates, not entities.
 */
export interface FacetType {
	type: string; candidates: number; inCollections: number;
	/** How to show the type: its name, or a plain description for records whose type was not recognised. */
	label: string;
	/** Up to two example items, as "name — fact, fact, fact", so a person can tell what the type is on this page. */
	sample: string[];
}
export interface Facet {
	attr: string;
	label: string;
	kind: 'range' | 'category' | 'boolean' | 'presence'; // presence: a fact only some candidates have ("has a price reduction")
	present: number; // candidates with a decidable value
	of: number; // candidates of the selected types
	min?: number; max?: number; currency?: string | null; unit?: 'money' | 'number' | 'percent' | 'rating';
	values?: Array<{ value: string | number | boolean; count: number }>;
}
export interface Facets { types: FacetType[]; selected: string[]; candidates: number; facets: Facet[] }

const show = (v: AttributeValue): string => (v && typeof v === 'object' ? ('amount' in v ? `${(v as { currency: string | null }).currency === 'USD' ? '$' : ''}${(v as { amount: number }).amount.toLocaleString('en-US')}` : 'value' in v ? String((v as { value: number }).value) : 'url' in v ? '' : '') : String(v));
function sampleOf(g: Group): string {
	const attrs = g.entities.flatMap(({ e }) => e.attributes);
	const name = attrs.find((a) => a.name === 'name' || a.name === 'headline')?.value;
	const facts = attrs.filter((a) => !NOT_FILTERABLE.has(a.name) && a.value !== null && a.dataType !== 'image' && a.dataType !== 'url').slice(0, 4).map((a) => `${humanize(a.name)} ${show(a.value)}`.trim());
	return `${typeof name === 'string' ? name : 'Unnamed item'}${facts.length ? ` — ${facts.join(', ')}` : ''}`.slice(0, 160);
}

/** Attributes that identify or describe rather than qualify; geography is handled by scope. */
const NOT_FILTERABLE = new Set(['name', 'url', 'image', 'description', 'text', 'heading', 'title', 'latitude', 'longitude', 'sku', 'gtin', 'gtin13', 'identifier', 'sameAs', 'canonicalUrl', 'inLanguage', 'nextPage', 'previousPage', 'viewportBounds', 'viewportMarkers', 'selected', 'headline', 'priceCurrency']);
const ALIAS_ROOTS = ['price', 'latitude', 'longitude'];
const NON_TARGET_TYPES = new Set(['WebPage', 'Offer', 'GeoCoordinates', 'PostalAddress', 'ImageObject', 'AggregateRating', 'Rating', 'QuantitativeValue', 'MonetaryAmount', 'BreadcrumbList', 'SearchAction', 'EntryPoint', 'WebSite']);
const TYPE_LABEL: Record<string, string> = { Unknown: 'Repeated items (type not recognised)', ListItem: 'List items', TableRow: 'Table rows' };
const ACRONYMS = new Set(['hoa', 'sku', 'url', 'isbn', 'gpu', 'cpu', 'ram', 'ssd', 'tv', 'id']);

export function humanize(attr: string): string {
	const words = attr.replace(/^numberOf(?=[A-Z])/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_.-]+/g, ' ').trim().split(/\s+/);
	return words.map((w, i) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : i === 0 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join(' ');
}

export function facets(pages: PageRepresentation[], types?: string[]): Facets {
	const all = new Map<string, FacetType>();
	for (const p of pages) {
		const members = new Set(p.collections.flatMap((c) => c.members));
		for (const e of p.entities) {
			if (NON_TARGET_TYPES.has(e.type) || (GENERIC_TYPES.has(e.type) && !isListedRecord(e, members))) continue;
			const t = all.get(e.type) ?? all.set(e.type, { type: e.type, candidates: 0, inCollections: 0, label: TYPE_LABEL[e.type] ?? e.type.replace(/([a-z])([A-Z])/g, '$1 $2'), sample: [] }).get(e.type)!;
			if (members.has(e.id)) t.inCollections++;
		}
	}
	for (const t of all.values()) {
		const gs = [...groupCandidates(pages, new Set([t.type])).values()];
		t.candidates = gs.length;
		t.sample = gs.slice(0, 2).map((g) => sampleOf(g));
	}
	const typeList = [...all.values()].sort((a, b) => b.inCollections - a.inCollections || b.candidates - a.candidates || (a.type < b.type ? -1 : 1));
	// Without a selection: the type the page lists most (a result list is what people filter), plus types linked to
	// it by sameAs (JSON-LD records of the listed cards). With a selection, exactly that selection, even empty:
	// a person's choice is never extended or shrunk silently (a chosen type absent here shows with 0).
	let selected: string[];
	if (types !== undefined) {
		selected = [...types];
		for (const t of selected) if (!all.has(t)) typeList.push({ type: t, candidates: 0, inCollections: 0, label: TYPE_LABEL[t] ?? t.replace(/([a-z])([A-Z])/g, '$1 $2'), sample: [] });
	} else {
		const top = typeList.find((t) => !GENERIC_TYPES.has(t.type) && t.inCollections > 0) ?? typeList[0];
		const chosen = top ? [top.type] : [];
		const linked = new Set(chosen);
		for (const p of pages) {
			const typeOf = new Map(p.entities.map((e) => [e.id, e.type]));
			for (const r of p.relationships) if (r.type === 'sameAs') {
				const [a, b] = [typeOf.get(r.from), typeOf.get(r.to)];
				if (a && b && chosen.includes(a) && all.has(b)) linked.add(b);
				if (a && b && chosen.includes(b) && all.has(a)) linked.add(a);
			}
		}
		selected = [...linked];
	}
	const groups = [...groupCandidates(pages, new Set(selected)).values()];
	const names = new Set<string>(ALIAS_ROOTS);
	for (const g of groups) for (const { e } of g.entities) for (const a of e.attributes) names.add(a.name);
	const out: Facet[] = [];
	for (const attr of [...names].sort()) {
		if (NOT_FILTERABLE.has(attr)) continue;
		const per = groups.map((g) => g.entities.flatMap(({ e, page }) => resolve(page, e, attr)));
		const withAny = per.filter((as) => as.length);
		if (!withAny.length) continue;
		const types = new Set(withAny.flat().map((a) => a.dataType));
		// Distinct values per candidate, compared as the evaluator compares them ("3" from JSON-LD equals 3 on the card).
		const vals = withAny.map((as) => { const m = new Map<string, AttributeValue>(); for (const a of as) if (a.value !== null) m.set(canonicalJson(num(a.value) ?? a.value), a.value); return [...m.values()]; });
		const decidable = vals.filter((vs) => vs.length === 1); // conflicting or ambiguous descriptions are not counted as having a value
		if (!decidable.length) continue;
		const base = { attr, label: humanize(attr), present: decidable.length, of: groups.length };
		const numeric = types.has('money') || types.has('number') || types.has('percent') || types.has('rating');
		if (numeric) {
			const ns = decidable.map((vs) => num(vs[0])).filter((n): n is number => n !== null);
			if (ns.length) {
				const lo = Math.min(...ns), hi = Math.max(...ns);
				if (lo === hi) { if (ns.length < groups.length) out.push({ ...base, kind: 'presence', present: ns.length }); continue; }
				const currencies = new Set(decidable.map((vs) => (vs[0] && typeof vs[0] === 'object' && 'currency' in vs[0] ? (vs[0] as { currency: string | null }).currency : null)).filter(Boolean));
				out.push({ ...base, kind: 'range', present: ns.length, min: Math.min(...ns), max: Math.max(...ns), unit: types.has('money') ? 'money' : types.has('percent') ? 'percent' : types.has('rating') ? 'rating' : 'number', ...(types.has('money') ? { currency: currencies.size === 1 ? [...currencies][0] as string : null } : {}) });
				continue;
			}
		}
		// Dates are not categories (each value is a distinct timestamp); a date-range control is future work (G-EXT-8).
		if (types.has('date') || types.has('datetime')) continue;
		const flat = decidable.map((vs) => vs[0]).filter((v) => typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number') as Array<string | number | boolean>;
		if (!flat.length) continue;
		if (flat.every((v) => typeof v === 'boolean')) {
			out.push({ ...base, kind: 'boolean', values: [true, false].map((v) => ({ value: v, count: flat.filter((x) => x === v).length })) });
			continue;
		}
		const counts = new Map<string, { value: string | number | boolean; count: number }>();
		for (const v of flat) { const k = String(v).toLowerCase(); const c = counts.get(k) ?? counts.set(k, { value: v, count: 0 }).get(k)!; c.count++; }
		// A category is a small set of repeated values; free text that is unique per item is not a filter.
		if (counts.size >= 2 && counts.size <= 12 && counts.size < flat.length) out.push({ ...base, kind: 'category', values: [...counts.values()].sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value))) });
		// One value everywhere filters nothing, unless it is a normalized vocabulary (availability) worth requiring for later captures.
		else if (counts.size === 1 && types.has('availability')) out.push({ ...base, kind: 'category', values: [...counts.values()] });
		else if (counts.size === 1 && decidable.length < groups.length) out.push({ ...base, kind: 'presence' });
	}
	// Most widely present first: those are the filters that apply to most candidates.
	out.sort((a, b) => b.present - a.present || a.label.localeCompare(b.label));
	return { types: typeList, selected, candidates: groups.length, facets: out };
}
