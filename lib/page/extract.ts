/**
 * Universal page extraction: HTML → signal.page/v1. Site-agnostic and deterministic.
 *
 * Stages (in order; earlier, more explicit sources take precedence for identity and type):
 *   1. JSON-LD (schema.org)          → declared entities, attributes, relationships
 *   2. Microdata / RDFa              → declared entities
 *   3. Metadata (title, meta, OpenGraph, canonical) → the WebPage entity
 *   4. Semantic HTML + ARIA          → tables (rows), lists, articles (threads), headings, time
 *   5. Repeated structures           → records in collections (product cards, job rows, posts)
 *   6. Field extraction per record   → labels, class hints, typed leaf values, related entities
 *   7. Identity across sources       → sameAs links, with conflicts recorded, never resolved silently
 *   8. Specialized interpreters      → injected SignalDecoders (e.g. Ghostpost), page-access signals
 *
 * Never executes scripts, never fetches page-derived URLs, never reads form values.
 * Hidden content ([hidden], aria-hidden="true", inline display:none) is not treated as visible.
 */
import { load, type CheerioAPI } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import type { SignalDecoder } from '../contracts/types.ts';
import { canonicalJson, sha256 } from '../core/canonical.ts';
import {
	DEFAULT_PAGE_LIMITS, EXTRACTOR_VERSION, PAGE_SCHEMA,
	type AttributeValue, type Classification, type DataType, type ExtractionMethod, type PageAttribute, type PageCollection,
	type PageEntity, type PageEvidence, type PageLimits, type PageRelationship, type PageRepresentation, type PageSignal
} from './types.ts';
import { ENTITY_PROPERTIES, LABELS, META, PROPERTY_TYPES, SECRET_META } from './vocab.ts';
import { inferText, parseAvailability, parseDate, parseMoney, parseMoneyRange, parseRating, redactUrlString, safeUrl, type Typed } from './values.ts';

export interface PageInput {
	html: string;
	locator: string;
	baseUrl: string | null;
	observationId: string;
	contentHash: string;
	contentType: string | null;
	observedAt: string;
	decoders?: SignalDecoder[];
	limits?: Partial<PageLimits>;
}

const h = (v: unknown, n = 16) => sha256(canonicalJson(v)).slice(0, n);
const collapse = (s: string) => s.replace(/[ \t\r\n\f\v ]+/g, ' ').trim();
const INVISIBLE = /[​-‏‪-‮⁠-⁤﻿]/g;
const visibleText = (s: string) => collapse(s.replace(INVISIBLE, ''));
const isEl = (n: AnyNode | null | undefined): n is Element => !!n && (n.type === 'tag' || n.type === 'script' || n.type === 'style');
const CLASS_RANK: Record<Classification, number> = { declared: 3, semantic: 2, inferred: 1, unknown: 0 };
const EVIDENCE_ATTRS = ['id', 'class', 'href', 'src', 'alt', 'datetime', 'itemprop', 'itemtype', 'itemscope', 'typeof', 'property', 'role', 'aria-label', 'title', 'content', 'name', 'lang', 'type', 'rel'];
const SKIP_CONTAINERS = new Set(['nav', 'header', 'footer', 'form', 'select', 'button', 'svg', 'math']);
const BLOCK = new Set(['p', 'div', 'li', 'td', 'th', 'article', 'section', 'blockquote', 'dd', 'dt', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figcaption', 'main', 'aside', 'body', 'tr', 'span']);

interface Field {
	name: string;
	typed: Typed;
	raw: string;
	el: Element;
	method: ExtractionMethod;
	confidence: number;
	relate?: { type: string; rel: string };
}

class Builder {
	readonly $: CheerioAPI;
	readonly input: PageInput;
	readonly limits: PageLimits;
	readonly entities = new Map<string, PageEntity>();
	readonly entityEl = new Map<string, Element>();
	readonly elEntity = new Map<Element, string>();
	readonly rels = new Map<string, PageRelationship>();
	readonly collections: PageCollection[] = [];
	readonly signals: PageSignal[] = [];
	readonly evidence = new Map<string, PageEvidence>();
	private locators = new Map<Element, string>();
	elementsVisited = 0;
	truncated = false;

	constructor($: CheerioAPI, input: PageInput) {
		this.$ = $;
		this.input = input;
		this.limits = { ...DEFAULT_PAGE_LIMITS, ...(input.limits ?? {}) };
	}

	/** Visible text of an element: never includes script/style/template source. */
	text(el: Element): string {
		const out: string[] = [];
		let budget = this.limits.maxTextLength * 4;
		const walk = (n: AnyNode) => {
			if (budget <= 0) return;
			if (n.type === 'text') { const d = (n as unknown as { data: string }).data; out.push(d); budget -= d.length; return; }
			if (!isEl(n) || n.type === 'script' || n.type === 'style' || ['noscript', 'template', 'svg'].includes(n.tagName)) return;
			for (const c of n.children ?? []) walk(c);
			if (BLOCK.has(n.tagName)) out.push(' ');
		};
		walk(el);
		return visibleText(out.join('')).slice(0, this.limits.maxTextLength);
	}

	locator(el: Element): string {
		const cached = this.locators.get(el);
		if (cached) return cached;
		const parts: string[] = [];
		let cur: Element | null = el;
		while (cur && isEl(cur)) {
			const id = cur.attribs?.id;
			if (id && /^[A-Za-z][\w-]{0,63}$/.test(id)) { parts.unshift(`${cur.tagName}#${id}`); break; }
			const parent: AnyNode | null = cur.parent;
			let idx = 1;
			if (isEl(parent)) for (const sib of parent.children) { if (sib === cur) break; if (isEl(sib) && sib.tagName === cur.tagName) idx++; }
			parts.unshift(cur.tagName === 'html' ? 'html' : `${cur.tagName}:nth-of-type(${idx})`);
			cur = isEl(parent) ? parent : null;
		}
		const loc = parts.join('>');
		this.locators.set(el, loc);
		return loc;
	}

	ev(el: Element, method: ExtractionMethod, pointer?: string): string {
		const locator = this.locator(el);
		const id = `ev_${h({ locator, method, pointer: pointer ?? null }, 12)}`;
		if (!this.evidence.has(id)) {
			const attributes: Record<string, string> = {};
			for (const a of EVIDENCE_ATTRS) {
				const v = el.attribs?.[a];
				if (v === undefined) continue;
				if (a === 'href' || a === 'src') { const u = safeUrl(v, this.input.baseUrl); if (u) attributes[a] = u; continue; }
				if (a === 'content' && el.tagName === 'meta' && SECRET_META.test(`${el.attribs.name ?? ''}${el.attribs.property ?? ''}`)) continue;
				attributes[a] = v.slice(0, 200);
			}
			const own = el.tagName === 'script' ? null : this.text(el).slice(0, 300) || null;
			this.evidence.set(id, { id, locator, element: el.tagName, attributes, text: own, method, ...(pointer ? { pointer } : {}) });
		}
		return id;
	}

	entity(args: {
		type: string; classification: Classification; method: ExtractionMethod; rule: string;
		identity: PageEntity['identity']; el?: Element; evidenceRefs: string[]; unique?: boolean;
	}): string | null {
		let id = `ent_${h({ type: args.type, key: args.identity.key })}`;
		const existing = this.entities.get(id);
		if (existing && args.unique && args.el && this.entityEl.get(id) !== args.el) {
			// Same type and identity key, different element (e.g. two cards with the same name): keep both.
			let n = 2;
			while (this.entities.has(`${id}_${n}`)) n++;
			id = `${id}_${n}`;
		} else if (existing) {
			for (const r of args.evidenceRefs) if (!existing.evidenceRefs.includes(r)) existing.evidenceRefs.push(r);
			if (CLASS_RANK[args.classification] > CLASS_RANK[existing.classification]) {
				existing.classification = args.classification;
				existing.typeBasis = { method: args.method, rule: args.rule };
			}
			if (args.el && !this.elEntity.has(args.el)) this.elEntity.set(args.el, id);
			return id;
		}
		if (this.entities.size >= this.limits.maxEntities) { this.truncated = true; return null; }
		this.entities.set(id, {
			id, type: args.type, classification: args.classification, typeBasis: { method: args.method, rule: args.rule },
			identity: args.identity, attributes: [], evidenceRefs: [...args.evidenceRefs]
		});
		if (args.el) { this.entityEl.set(id, args.el); if (!this.elEntity.has(args.el)) this.elEntity.set(args.el, id); }
		return id;
	}

	attr(entityId: string | null, a: Omit<PageAttribute, 'raw'> & { raw: string | null }): void {
		if (!entityId) return;
		const e = this.entities.get(entityId)!;
		// "As observed" never includes credentials: URL-shaped raw strings get the same redaction as values.
		const raw = a.raw === null ? null : (a.dataType === 'url' || a.dataType === 'image' ? redactUrlString(a.raw) : a.raw).slice(0, this.limits.maxTextLength);
		const sig = canonicalJson([a.name, a.value, a.method]);
		if (e.attributes.some((x) => canonicalJson([x.name, x.value, x.method]) === sig)) return;
		if (e.attributes.length >= this.limits.maxAttributesPerEntity) { this.truncated = true; return; }
		e.attributes.push({ ...a, raw });
	}

	rel(from: string | null, to: string | null, type: string, method: ExtractionMethod, classification: Classification, confidence: number, evidenceRefs: string[]): void {
		if (!from || !to || from === to) return;
		const id = `rel_${h({ from, to, type })}`;
		const existing = this.rels.get(id);
		if (existing) { for (const r of evidenceRefs) if (!existing.evidenceRefs.includes(r)) existing.evidenceRefs.push(r); return; }
		this.rels.set(id, { id, from, to, type, method, classification, confidence, evidenceRefs: [...evidenceRefs] });
	}
}

// ------------------------------------------------------------------ typing helpers

function typeByHint(hint: DataType | undefined, raw: string, observedAt: string, base: string | null): Typed {
	const t = raw.trim();
	switch (hint) {
		case 'money': {
			const range = parseMoneyRange(t);
			if (range) return { value: range, dataType: 'money_range', provenance: 'normalized' };
			const m = parseMoney(t);
			if (m) return { value: m, dataType: 'money', provenance: 'normalized' };
			const n = Number(t);
			return Number.isFinite(n) && t !== '' ? { value: { amount: n, currency: null }, dataType: 'money', provenance: 'normalized' } : { value: null, dataType: 'money', provenance: 'observed', ambiguity: { reason: 'format', candidates: [{ value: t, source: 'unparsed' }] } };
		}
		case 'number': { const n = Number(t.replace(/,/g, '')); return Number.isFinite(n) && t !== '' ? { value: n, dataType: 'number', provenance: 'normalized' } : { value: t, dataType: 'text', provenance: 'observed' }; }
		case 'datetime': case 'date': return parseDate(t, observedAt) ?? { value: null, dataType: hint, provenance: 'observed', ambiguity: { reason: 'format', candidates: [{ value: t, source: 'unparsed' }] } };
		case 'availability': return { value: parseAvailability(t), dataType: 'availability', provenance: parseAvailability(t) ? 'normalized' : 'observed' };
		case 'url': return { value: safeUrl(t, base), dataType: 'url', provenance: 'normalized' };
		case 'image': return { value: { url: safeUrl(t, base), alt: null }, dataType: 'image', provenance: 'normalized' };
		case 'email': return { value: t.replace(/^mailto:/i, '').toLowerCase(), dataType: 'email', provenance: 'normalized' };
		case 'boolean': return { value: /^(true|yes|1)$/i.test(t), dataType: 'boolean', provenance: 'normalized' };
		default: return { value: t, dataType: 'text', provenance: 'observed' };
	}
}

const shortType = (t: unknown): string | null => {
	const s = Array.isArray(t) ? t[0] : t;
	if (typeof s !== 'string' || !s) return null;
	return s.replace(/^.*[/#:]/, '').slice(0, 80) || null;
};

function itemValue(b: Builder, el: Element): string {
	const a = el.attribs ?? {};
	if (el.tagName === 'meta') return a.content ?? '';
	if (['a', 'link', 'area'].includes(el.tagName) && a.href) return a.href;
	if (['img', 'audio', 'video', 'source', 'iframe', 'embed', 'track'].includes(el.tagName) && a.src) return a.src;
	if (el.tagName === 'object' && a.data) return a.data;
	if (el.tagName === 'time' && a.datetime) return a.datetime;
	if (['data', 'meter'].includes(el.tagName) && a.value) return a.value;
	if (a.content !== undefined) return a.content;
	return b.text(el);
}

function isHidden(el: Element): boolean {
	const a = el.attribs ?? {};
	return a.hidden !== undefined || a['aria-hidden'] === 'true' || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(a.style ?? '');
}

// ------------------------------------------------------------------ stage 1: JSON-LD

function jsonLd(b: Builder, pageId: string | null): void {
	const { $, input } = b;
	let nodes = 0;
	const pendingRefs: Array<{ from: string; ref: string; prop: string; ev: string }> = [];
	const byAtId = new Map<string, string>();

	const walk = (obj: Record<string, unknown>, script: Element, pointer: string, depth: number): string | null => {
		if (depth > 8 || ++nodes > b.limits.maxJsonLdNodes) { b.truncated = true; return null; }
		const type = shortType(obj['@type']) ?? 'Unknown';
		const ev = b.ev(script, 'json-ld', pointer || '/');
		const atId = typeof obj['@id'] === 'string' ? obj['@id'] : null;
		const url = typeof obj.url === 'string' ? safeUrl(obj.url, input.baseUrl) : null;
		const sku = typeof obj.sku === 'string' ? obj.sku : typeof obj.gtin13 === 'string' ? obj.gtin13 : null;
		const name = typeof obj.name === 'string' ? collapse(obj.name) : typeof obj.headline === 'string' ? collapse(obj.headline) : null;
		const identity: PageEntity['identity'] = atId ? { key: atId, basis: '@id' } : url ? { key: url, basis: 'url' } : sku ? { key: sku, basis: 'sku' } : name ? { key: name.toLowerCase(), basis: 'name' } : { key: `${b.locator(script)}#${pointer}`, basis: 'locator' };
		const id = b.entity({ type, classification: obj['@type'] ? 'declared' : 'unknown', method: 'json-ld', rule: obj['@type'] ? 'json-ld @type' : 'json-ld object without @type', identity, evidenceRefs: [ev] });
		if (!id) return null;
		if (atId) byAtId.set(atId, id);
		const types = Array.isArray(obj['@type']) ? obj['@type'] : [];
		for (const extra of types.slice(1)) b.attr(id, { name: 'additionalType', value: shortType(extra), raw: String(extra), dataType: 'text', provenance: 'observed', method: 'json-ld', confidence: 1, evidenceRefs: [ev] });

		for (const [key, rawVal] of Object.entries(obj)) {
			if (key.startsWith('@')) continue;
			const values = Array.isArray(rawVal) ? rawVal : [rawVal];
			values.forEach((v, i) => {
				const ptr = `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}${Array.isArray(rawVal) ? `/${i}` : ''}`;
				const vev = b.ev(script, 'json-ld', ptr);
				if (v && typeof v === 'object') {
					const o = v as Record<string, unknown>;
					const onlyRef = Object.keys(o).length === 1 && typeof o['@id'] === 'string';
					if (onlyRef) { pendingRefs.push({ from: id, ref: o['@id'] as string, prop: key, ev: vev }); return; }
					if (o['@type'] || ENTITY_PROPERTIES.has(key)) {
						const child = walk(o, script, ptr, depth + 1);
						b.rel(id, child, key === 'itemListElement' ? 'hasPart' : key, 'json-ld', 'declared', 1, [vev]);
						return;
					}
					b.attr(id, { name: key, value: canonicalJson(o).slice(0, b.limits.maxTextLength), raw: null, dataType: 'unknown', provenance: 'observed', method: 'json-ld', confidence: 1, evidenceRefs: [vev] });
					return;
				}
				if (v === null || v === undefined) return;
				const raw = String(v);
				let typed = typeByHint(PROPERTY_TYPES[key], raw, input.observedAt, input.baseUrl);
				if (key === 'price' && typed.dataType === 'money' && typed.value && typeof obj.priceCurrency === 'string') {
					typed = { ...typed, value: { ...(typed.value as { amount: number }), currency: obj.priceCurrency } as AttributeValue };
				}
				b.attr(id, { name: key, value: typed.value, raw, dataType: typed.dataType, provenance: typed.provenance === 'observed' ? 'observed' : typed.provenance, method: 'json-ld', confidence: 1, evidenceRefs: [vev], ...(typed.ambiguity ? { ambiguity: typed.ambiguity } : {}) });
			});
		}
		// MonetaryAmount / QuantitativeValue → a single comparable `amount` (deterministic projection).
		if (type === 'MonetaryAmount') {
			const val = obj.value as Record<string, unknown> | number | undefined;
			const cur = typeof obj.currency === 'string' ? obj.currency : null;
			const unit = val && typeof val === 'object' && typeof val.unitText === 'string' ? val.unitText.toLowerCase() : undefined;
			let amount: AttributeValue = null;
			if (typeof val === 'number') amount = { amount: val, currency: cur };
			else if (val && typeof val === 'object') {
				const lo = Number(val.minValue ?? val.value), hi = Number(val.maxValue ?? val.value);
				if (Number.isFinite(lo) && Number.isFinite(hi)) amount = lo === hi ? { amount: lo, currency: cur } : { min: lo, max: hi, currency: cur, ...(unit ? { period: unit } : {}) };
			}
			if (amount) b.attr(id, { name: 'amount', value: amount, raw: canonicalJson(obj.value ?? null), dataType: 'min' in (amount as object) ? 'money_range' : 'money', provenance: 'normalized', method: 'json-ld', confidence: 1, evidenceRefs: [ev] });
		}
		if (pageId && depth === 0) b.rel(pageId, id, 'mainEntity', 'json-ld', 'declared', 1, [ev]);
		return id;
	};

	$('script[type="application/ld+json"]').each((i, el) => {
		const script = el as Element;
		const raw = $(script).text();
		if (raw.length > b.limits.maxJsonLdBytes) {
			b.truncated = true;
			b.signals.push({ id: `sig_${h({ s: b.locator(script), k: 'oversized' })}`, codec: 'page-structure/v1', kind: 'json_ld_oversized', ok: false, error: `JSON-LD block exceeds ${b.limits.maxJsonLdBytes} bytes; not parsed`, confidence: 1, evidenceRefs: [b.ev(script, 'json-ld')] });
			return;
		}
		let doc: unknown;
		try { doc = JSON.parse(raw); } catch (e) {
			b.signals.push({ id: `sig_${h({ s: b.locator(script), k: 'invalid' })}`, codec: 'page-structure/v1', kind: 'json_ld_invalid', ok: false, error: (e as Error).message.slice(0, 200), confidence: 1, evidenceRefs: [b.ev(script, 'json-ld')] });
			return;
		}
		const roots: Array<[unknown, string]> = [];
		const push = (d: unknown, p: string) => {
			if (Array.isArray(d)) d.forEach((x, j) => push(x, `${p}/${j}`));
			else if (d && typeof d === 'object') {
				const g = (d as Record<string, unknown>)['@graph'];
				if (Array.isArray(g)) g.forEach((x, j) => push(x, `${p}/@graph/${j}`));
				else roots.push([d, p]);
			}
		};
		push(doc, '');
		for (const [r, p] of roots) walk(r as Record<string, unknown>, script, p, 0);
		void i;
	});
	for (const p of pendingRefs) {
		let to = byAtId.get(p.ref);
		if (!to) to = b.entity({ type: 'Unknown', classification: 'unknown', method: 'json-ld', rule: 'referenced @id not described on page', identity: { key: p.ref, basis: '@id' }, evidenceRefs: [p.ev] }) ?? undefined;
		b.rel(p.from, to ?? null, p.prop, 'json-ld', 'declared', 1, [p.ev]);
	}
}

// ------------------------------------------------------------------ stage 2: microdata + RDFa

function scoped(b: Builder, scopeSel: string, propAttr: string, typeAttr: string, method: 'microdata' | 'rdfa'): void {
	const { $ } = b;
	const scopes = $(scopeSel).toArray() as Element[];
	const nearestScope = (el: Element): Element | null => {
		let p = el.parent;
		while (isEl(p)) { if (p.attribs?.[method === 'microdata' ? 'itemscope' : 'typeof'] !== undefined) return p; p = p.parent; }
		return null;
	};
	const ids = new Map<Element, string | null>();
	for (const scope of scopes) {
		if (isHidden(scope)) continue;
		const type = shortType((scope.attribs[typeAttr] ?? '').split(/\s+/)[0]) ?? 'Unknown';
		const ev = b.ev(scope, method);
		const props = ($(scope).find(`[${propAttr}]`).toArray() as Element[]).filter((p) => nearestScope(p) === scope);
		const nameEl = props.find((p) => (p.attribs[propAttr] ?? '').split(/\s+/).includes('name'));
		const urlEl = props.find((p) => (p.attribs[propAttr] ?? '').split(/\s+/).includes('url'));
		const name = nameEl ? collapse(itemValue(b, nameEl)) : null;
		const url = urlEl ? safeUrl(itemValue(b, urlEl), b.input.baseUrl) : null;
		const itemid = scope.attribs.itemid ?? scope.attribs.resource;
		const identity: PageEntity['identity'] = itemid ? { key: itemid, basis: '@id' } : url ? { key: url, basis: 'url' } : name ? { key: name.toLowerCase(), basis: 'name' } : { key: b.locator(scope), basis: 'locator' };
		ids.set(scope, b.entity({ type, classification: scope.attribs[typeAttr] ? 'declared' : 'unknown', method, rule: `${method} ${typeAttr}`, identity, el: scope, evidenceRefs: [ev], unique: true }));
	}
	for (const scope of scopes) {
		const id = ids.get(scope);
		if (!id) continue;
		const props = ($(scope).find(`[${propAttr}]`).toArray() as Element[]).filter((p) => nearestScope(p) === scope);
		const currency = props.find((p) => /\bpriceCurrency\b/.test(p.attribs[propAttr] ?? ''));
		for (const p of props) {
			if (isHidden(p) && p.tagName !== 'meta' && p.tagName !== 'link') continue;
			const pev = b.ev(p, method);
			for (const nameRaw of (p.attribs[propAttr] ?? '').split(/\s+/).filter(Boolean)) {
				const name = nameRaw.replace(/^.*[/#:]/, '');
				if (p.attribs[method === 'microdata' ? 'itemscope' : 'typeof'] !== undefined) {
					b.rel(id, ids.get(p) ?? null, name, method, 'declared', 1, [pev]);
					continue;
				}
				const raw = itemValue(b, p);
				let typed = typeByHint(PROPERTY_TYPES[name], raw, b.input.observedAt, b.input.baseUrl);
				if (name === 'image' && p.tagName === 'img') typed = { value: { url: safeUrl(p.attribs.src, b.input.baseUrl), alt: p.attribs.alt ?? null }, dataType: 'image', provenance: 'normalized' };
				if (name === 'price' && typed.dataType === 'money' && typed.value && currency) {
					typed = { ...typed, value: { ...(typed.value as { amount: number }), currency: itemValue(b, currency) || (typed.value as { currency: string | null }).currency } as AttributeValue };
				}
				b.attr(id, { name, value: typed.value, raw, dataType: typed.dataType, provenance: typed.provenance, method, confidence: 1, evidenceRefs: [pev], ...(typed.ambiguity ? { ambiguity: typed.ambiguity } : {}) });
			}
		}
	}
}

// ------------------------------------------------------------------ stage 3: metadata → WebPage

function pageEntity(b: Builder): string | null {
	const { $, input } = b;
	const html = $('html').get(0) as Element | undefined;
	const head = ($('head').get(0) as Element | undefined) ?? html;
	if (!head) return null;
	const id = b.entity({ type: 'WebPage', classification: 'semantic', method: 'meta', rule: 'the observed document', identity: { key: input.locator, basis: 'page' }, evidenceRefs: [b.ev(head, 'meta')] });
	const title = $('title').first().get(0) as Element | undefined;
	if (title) b.attr(id, { name: 'title', value: b.text(title), raw: b.text(title), dataType: 'text', provenance: 'observed', method: 'meta', confidence: 1, evidenceRefs: [b.ev(title, 'meta')] });
	const lang = html?.attribs?.lang;
	if (lang) b.attr(id, { name: 'inLanguage', value: lang, raw: lang, dataType: 'text', provenance: 'observed', method: 'meta', confidence: 1, evidenceRefs: [b.ev(html!, 'meta')] });
	const canonical = $('link[rel="canonical"]').get(0) as Element | undefined;
	if (canonical) b.attr(id, { name: 'canonicalUrl', value: safeUrl(canonical.attribs.href, input.baseUrl), raw: canonical.attribs.href ?? null, dataType: 'url', provenance: 'normalized', method: 'meta', confidence: 1, evidenceRefs: [b.ev(canonical, 'meta')] });
	$('meta').each((_, m) => {
		const el = m as Element;
		const key = (el.attribs.property ?? el.attribs.name ?? '').toLowerCase();
		if (!key || SECRET_META.test(key)) return;
		const map = META[key];
		if (!map || el.attribs.content === undefined) return;
		const typed = typeByHint(map.type, el.attribs.content, input.observedAt, input.baseUrl);
		b.attr(id, { name: map.attribute, value: typed.value, raw: el.attribs.content, dataType: typed.dataType, provenance: typed.provenance, method: key.startsWith('og:') || key.includes(':') ? 'opengraph' : 'meta', confidence: 1, evidenceRefs: [b.ev(el, key.startsWith('og:') ? 'opengraph' : 'meta')] });
	});
	let n = 0;
	$('h1, h2, h3, [role="heading"]').each((_, x) => {
		const el = x as Element;
		if (n >= 50 || isHidden(el) || inSkipped(el)) return;
		const t = b.text(el);
		if (!t) return;
		n++;
		b.attr(id, { name: 'heading', value: t, raw: t, dataType: 'text', provenance: 'observed', method: 'html', confidence: 1, evidenceRefs: [b.ev(el, 'html')] });
	});
	return id;
}

function inSkipped(el: Element): boolean {
	let p: AnyNode | null = el;
	while (isEl(p)) {
		if (SKIP_CONTAINERS.has(p.tagName) || p.attribs?.role === 'navigation' || isHidden(p)) return true;
		p = p.parent;
	}
	return false;
}

// ------------------------------------------------------------------ stage 6: fields of a record element

const CLASS_HINTS: Array<[RegExp, string]> = [
	[/(^|[-_ ])(price|amount|cost)([-_ ]|$)/i, 'price'], [/(author|byline|username|user-name|poster)/i, 'author'],
	[/(seller|vendor|merchant|sold-?by|store-?name)/i, 'seller'], [/(company|employer|org(anization)?-?name)/i, 'hiringOrganization'],
	[/(salary|compensation|pay-?range)/i, 'compensation'], [/(location|address|city)/i, 'location'],
	[/(availability|stock|status)/i, 'availability'], [/(^|[-_ ])(date|time|timestamp|posted)([-_ ]|$)/i, 'date'],
	[/(rating|stars|score)/i, 'rating'], [/(title|name|headline)/i, 'name'], [/(description|summary|excerpt|body|content|text)/i, 'description']
];

function labelFor(label: string) {
	const l = collapse(label).replace(/[:：]$/, '');
	return LABELS.find((x) => x.re.test(l));
}
const slug = (s: string) => collapse(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'field';

function recordFields(b: Builder, root: Element, opts: { excludeNested?: Set<Element> } = {}): Field[] {
	const { $, input } = b;
	const fields: Field[] = [];
	const consumed = new Set<Element>();
	const within = (el: Element) => {
		let p: AnyNode | null = el;
		while (isEl(p) && p !== root) { if (opts.excludeNested?.has(p)) return false; p = p.parent; }
		return true;
	};
	const all = ($(root).find('*').toArray() as Element[]).filter((e) => isEl(e) && !isHidden(e) && within(e) && !['script', 'style', 'noscript', 'template', 'svg'].includes(e.tagName));
	const add = (f: Field) => { fields.push(f); };
	const typedFor = (name: string, raw: string): Typed => {
		if (name === 'price' || name === 'listPrice') { const m = parseMoney(raw); return m ? { value: m, dataType: 'money', provenance: 'normalized' } : inferText(raw, input.observedAt); }
		if (name === 'compensation') { const r = parseMoneyRange(raw); if (r) return { value: r, dataType: 'money_range', provenance: 'normalized' }; const m = parseMoney(raw); return m ? { value: m, dataType: 'money', provenance: 'normalized' } : inferText(raw, input.observedAt); }
		if (name === 'availability') { const a = parseAvailability(raw); return a ? { value: a, dataType: 'availability', provenance: 'normalized' } : { value: raw, dataType: 'text', provenance: 'observed' }; }
		if (name === 'date') return parseDate(raw, input.observedAt) ?? { value: raw, dataType: 'text', provenance: 'observed' };
		if (name === 'rating') { const r = parseRating(raw); return r ? { value: r, dataType: 'rating', provenance: 'normalized' } : inferText(raw, input.observedAt); }
		if (['author', 'seller', 'hiringOrganization', 'brand', 'location', 'name', 'description', 'requirements', 'employmentType', 'sku'].includes(name)) return { value: raw, dataType: 'text', provenance: 'observed' };
		return inferText(raw, input.observedAt);
	};

	// name: first heading
	const heading = all.find((e) => /^h[1-6]$/.test(e.tagName) || e.attribs.role === 'heading');
	if (heading && b.text(heading)) { add({ name: 'name', typed: { value: b.text(heading), dataType: 'text', provenance: 'observed' }, raw: b.text(heading), el: heading, method: 'html', confidence: 0.9 }); consumed.add(heading); }
	// time elements
	for (const t of all.filter((e) => e.tagName === 'time')) {
		const raw = t.attribs.datetime ?? b.text(t);
		const d = parseDate(raw, input.observedAt);
		if (d) { add({ name: 'date', typed: d, raw, el: t, method: 'html', confidence: 0.9 }); consumed.add(t); }
	}
	// definition lists and "Label: value" pairs
	for (const dt of all.filter((e) => e.tagName === 'dt')) {
		let dd: AnyNode | null = dt.next;
		while (dd && !(isEl(dd) && dd.tagName === 'dd')) dd = dd.next;
		if (!isEl(dd)) continue;
		const lab = labelFor(b.text(dt));
		const name = lab?.attribute ?? slug(b.text(dt));
		const raw = b.text(dd);
		if (!raw) continue;
		add({ name, typed: typedFor(name, raw), raw, el: dd, method: 'label', confidence: 0.9, relate: lab?.relate });
		consumed.add(dt); consumed.add(dd);
	}
	const leafish = all.filter((e) => !consumed.has(e) && !['dt', 'dd'].includes(e.tagName) && (e.children ?? []).every((c) => !isEl(c) || ['b', 'strong', 'em', 'i', 'span', 'a', 'small', 'time', 'abbr', 'br', 'sup', 'sub', 'data'].includes(c.tagName)));
	for (const el of leafish) {
		if ([...consumed].some((c) => c !== el && $(c).find(el as never).length > 0)) continue;
		const text = b.text(el);
		if (!text || text.length > 400) continue;
		const lv = /^([A-Za-z][A-Za-z /&-]{1,30})\s*[:：]\s*(.+)$/.exec(text) ?? /^(sold by|posted by|written by|by)\s+(.{2,80})$/i.exec(text);
		if (lv) {
			const lab = labelFor(lv[1]);
			const name = lab?.attribute ?? slug(lv[1]);
			const raw = collapse(lv[2]);
			add({ name, typed: typedFor(name, raw), raw, el, method: 'label', confidence: lab ? 0.9 : 0.6, relate: lab?.relate });
			consumed.add(el);
			continue;
		}
		const cls = `${el.attribs.class ?? ''} ${el.attribs['data-testid'] ?? ''}`;
		const hint = cls.trim() ? CLASS_HINTS.find(([re]) => re.test(cls))?.[1] : undefined;
		if (hint && hint !== 'name') {
			const lab = LABELS.find((x) => x.attribute === hint);
			add({ name: hint, typed: typedFor(hint, text), raw: text, el, method: 'structure', confidence: 0.6, relate: lab?.relate });
			consumed.add(el);
			continue;
		}
		const typed = inferText(text, input.observedAt);
		if (typed.dataType !== 'text') {
			const name = typed.dataType === 'money' ? (fields.some((f) => f.name === 'price') ? 'money' : 'price')
				: typed.dataType === 'money_range' ? 'compensation' : typed.dataType === 'availability' ? 'availability'
				: typed.dataType === 'date' || typed.dataType === 'datetime' ? 'date' : typed.dataType;
			add({ name, typed, raw: text, el, method: 'text', confidence: 0.6 });
			consumed.add(el);
		} else if (el.tagName !== 'a' && el.tagName !== 'p' && el.tagName !== 'blockquote' && !/^h[1-6]$/.test(el.tagName) && fields.filter((f) => f.method === 'structure' && f.typed.dataType === 'text').length < 10) {
			// Unclassified text is retained, named by the element's own class (observed), never discarded.
			const cls = (el.attribs.class ?? '').split(/\s+/).filter(Boolean)[0];
			add({ name: cls ? slug(cls) : 'text', typed, raw: text, el, method: 'structure', confidence: 0.3 });
			consumed.add(el);
		}
	}
	// links and media
	const link = all.find((e) => e.tagName === 'a' && e.attribs.href && safeUrl(e.attribs.href, input.baseUrl));
	if (link) {
		add({ name: 'url', typed: { value: safeUrl(link.attribs.href, input.baseUrl), dataType: 'url', provenance: 'normalized' }, raw: link.attribs.href, el: link, method: 'html', confidence: 0.9 });
		if (!fields.some((f) => f.name === 'name') && b.text(link).length >= 3) add({ name: 'name', typed: { value: b.text(link), dataType: 'text', provenance: 'observed' }, raw: b.text(link), el: link, method: 'structure', confidence: 0.6 });
	}
	const img = all.find((e) => e.tagName === 'img' && e.attribs.src);
	if (img) add({ name: 'image', typed: { value: { url: safeUrl(img.attribs.src, input.baseUrl), alt: img.attribs.alt ?? null }, dataType: 'image', provenance: 'normalized' }, raw: img.attribs.src, el: img, method: 'html', confidence: 0.9 });
	// remaining body text (first paragraph) as description
	if (!fields.some((f) => f.name === 'description')) {
		const p = all.find((e) => (e.tagName === 'p' || e.tagName === 'blockquote') && !consumed.has(e) && b.text(e).length >= 20);
		if (p) add({ name: 'description', typed: { value: b.text(p), dataType: 'text', provenance: 'observed' }, raw: b.text(p), el: p, method: 'html', confidence: 0.9 });
	}
	return fields;
}

/** Ordered, documented type rules for a record (first match wins). */
function classifyRecord(fields: Field[], ctx: { element: string; nestedInRecord: boolean; inCollection: boolean; row: boolean }): { type: string; classification: Classification; rule: string } {
	const has = (n: string) => fields.some((f) => f.name === n && f.typed.value !== null);
	const hasType = (t: DataType) => fields.some((f) => f.typed.dataType === t);
	if (has('compensation') || (has('hiringOrganization') && has('location'))) return { type: 'JobPosting', classification: 'inferred', rule: 'T1: compensation, or employer + location' };
	const productCue = fields.some((f) => f.typed.dataType === 'availability') || ['image', 'seller', 'brand', 'sku', 'rating'].some(has);
	if (has('price') && hasType('money') && productCue) return { type: 'Product', classification: 'inferred', rule: 'T2: a price plus a product cue (availability, image, seller, brand, sku or rating)' };
	if (has('author') && has('date')) {
		if (ctx.nestedInRecord) return { type: 'Comment', classification: 'inferred', rule: 'T3a: author + date, nested in another record' };
		return ctx.inCollection || ctx.element !== 'article' ? { type: 'SocialMediaPosting', classification: 'inferred', rule: 'T3b: author + date in a repeated structure' } : { type: 'Article', classification: 'inferred', rule: 'T3c: article element with author + date' };
	}
	if (ctx.element === 'article' && has('name')) return { type: 'Article', classification: 'semantic', rule: 'T4: <article> with a heading' };
	if (ctx.row) return { type: 'TableRow', classification: 'semantic', rule: 'T5: table row' };
	if (ctx.element === 'li') return { type: 'ListItem', classification: 'semantic', rule: 'T6: list item' };
	return { type: 'Unknown', classification: 'unknown', rule: 'no rule matched; structure retained' };
}

function addRecord(b: Builder, el: Element, ctx: { nestedInRecord: boolean; inCollection: boolean; row?: boolean; fields?: Field[]; method: ExtractionMethod }): string | null {
	const existing = b.elEntity.get(el);
	if (existing && b.entities.get(existing)!.classification === 'declared') return existing; // structured data already describes it
	const fields = ctx.fields ?? recordFields(b, el);
	if (fields.length === 0) return null;
	const cls = classifyRecord(fields, { element: el.tagName, nestedInRecord: ctx.nestedInRecord, inCollection: ctx.inCollection, row: !!ctx.row });
	const name = fields.find((f) => f.name === 'name')?.typed.value;
	const url = fields.find((f) => f.name === 'url')?.typed.value;
	const sku = fields.find((f) => f.name === 'sku')?.typed.value;
	const identity: PageEntity['identity'] = typeof sku === 'string' ? { key: sku, basis: 'sku' } : typeof url === 'string' && cls.type !== 'TableRow' ? { key: url, basis: 'url' } : typeof name === 'string' ? { key: name.toLowerCase(), basis: 'name' } : { key: b.locator(el), basis: 'locator' };
	const id = existing ?? b.entity({ type: cls.type, classification: cls.classification, method: ctx.method, rule: cls.rule, identity, el, evidenceRefs: [b.ev(el, ctx.method)], unique: true });
	if (!id) return null;
	for (const f of fields) {
		const ev = b.ev(f.el, f.method);
		b.attr(id, { name: f.name, value: f.typed.value, raw: f.raw, dataType: f.typed.dataType, provenance: f.method === 'label' && f.typed.provenance === 'observed' ? 'observed' : f.typed.provenance, method: f.method, confidence: f.typed.ambiguity ? Math.min(0.3, f.confidence) : f.confidence, evidenceRefs: [ev], ...(f.typed.ambiguity ? { ambiguity: f.typed.ambiguity } : {}) });
		if (f.relate && typeof f.typed.value === 'string' && f.typed.value) {
			const related = b.entity({ type: f.relate.type, classification: 'inferred', method: f.method, rule: `named by label "${f.name}"`, identity: { key: f.typed.value.toLowerCase(), basis: 'name' }, evidenceRefs: [ev] });
			b.attr(related, { name: 'name', value: f.typed.value, raw: f.raw, dataType: 'text', provenance: 'observed', method: f.method, confidence: f.confidence, evidenceRefs: [ev] });
			b.rel(id, related, f.relate.rel, f.method, 'inferred', f.confidence, [ev]);
		}
	}
	return id;
}

// ------------------------------------------------------------------ stage 4/5: tables, lists, articles, repeated structures

function signature(el: Element): string {
	const cls = (el.attribs.class ?? '').split(/\s+/).map((c) => c.replace(/\d+/g, '#')).filter((c) => c && !/^#+$/.test(c)).sort().join('.');
	// Tag + classes. Child structure is deliberately excluded: a post with replies and one without are the same kind of record.
	return `${el.tagName}${cls ? '.' + cls : ''}`;
}

function tables(b: Builder, pageId: string | null): void {
	const { $ } = b;
	$('table').each((_, t) => {
		const table = t as Element;
		if (isHidden(table) || inSkipped(table)) return;
		const rows = $(table).find('tr').toArray() as Element[];
		const headerRow = rows.find((r) => (r.children ?? []).filter(isEl).some((c) => c.tagName === 'th')) ?? null;
		if (!headerRow || rows.length < 2) return;
		const headers = (headerRow.children ?? []).filter(isEl).filter((c) => c.tagName === 'th' || c.tagName === 'td').map((c) => b.text(c));
		const captionEl = $(table).find('caption').get(0) as Element | undefined;
		const name = captionEl ? b.text(captionEl) : table.attribs['aria-label'] ?? null;
		const members: string[] = [];
		for (const row of rows) {
			if (row === headerRow) continue;
			const cells = (row.children ?? []).filter(isEl).filter((c) => c.tagName === 'td' || c.tagName === 'th');
			if (!cells.length) continue;
			const fields: Field[] = cells.map((c, i) => {
				const header = headers[i] ?? `column_${i + 1}`;
				const lab = labelFor(header);
				const nm = lab?.attribute ?? slug(header);
				const raw = b.text(c);
				const base = inferText(raw, b.input.observedAt);
				const typed: Typed = nm === 'price' || nm === 'listPrice' ? (parseMoney(raw) ? { value: parseMoney(raw), dataType: 'money', provenance: 'normalized' } : base)
					: nm === 'availability' ? { value: parseAvailability(raw) ?? raw, dataType: parseAvailability(raw) ? 'availability' : 'text', provenance: parseAvailability(raw) ? 'normalized' : 'observed' } : base;
				return { name: nm, typed, raw, el: c, method: 'table' as const, confidence: 0.9, relate: lab?.relate };
			}).filter((f) => f.raw !== '');
			const first = fields[0];
			if (first && !fields.some((f) => f.name === 'name') && first.typed.dataType === 'text') fields.unshift({ ...first, name: 'name' });
			const id = addRecord(b, row, { nestedInRecord: false, inCollection: true, row: true, fields, method: 'table' });
			if (id) members.push(id);
		}
		if (members.length) {
			const types = new Set(members.map((m) => b.entities.get(m)!.type));
			b.collections.push({ id: `col_${h({ k: 'table', l: b.locator(table) })}`, kind: 'table', name, itemType: types.size === 1 ? [...types][0] : null, members, method: 'table', evidenceRefs: [b.ev(table, 'table')] });
			if (pageId) for (const m of members) b.rel(pageId, m, 'hasPart', 'table', 'semantic', 0.9, [b.ev(table, 'table')]);
		}
	});
}

function repeated(b: Builder, pageId: string | null): void {
	const { $ } = b;
	const body = ($('body').get(0) as Element | undefined) ?? ($.root().children().get(0) as Element | undefined);
	if (!body) return;
	const recordEls = new Map<Element, string>();
	const groups: Array<{ parent: Element; sig: string; members: Element[] }> = [];
	const visit = (el: Element, depth: number) => {
		if (++b.elementsVisited > b.limits.maxElements) { b.truncated = true; return; }
		if (depth > 64 || isHidden(el) || SKIP_CONTAINERS.has(el.tagName) || el.attribs?.role === 'navigation' || el.tagName === 'table') return;
		const kids = (el.children ?? []).filter(isEl).filter((k) => !isHidden(k) && !['script', 'style', 'template', 'noscript'].includes(k.tagName));
		const bySig = new Map<string, Element[]>();
		for (const k of kids) { const s = signature(k); bySig.set(s, [...(bySig.get(s) ?? []), k]); }
		for (const [sig, members] of bySig) {
			const min = /^(li|article|tr)/.test(sig) || el.attribs?.role === 'feed' || el.attribs?.role === 'list' ? 2 : 3;
			if (members.length >= min) groups.push({ parent: el, sig, members });
		}
		for (const k of kids) visit(k, depth + 1);
	};
	visit(body, 0);
	// Articles not in a repeated group are still records (single article pages).
	// Singular records: <article>/role=article, or an element whose class/id carries a record token
	// (deterministic vocabulary, site-agnostic). Kept only if it yields a name plus a typed value.
	const RECORD_TOKEN = /(^|[-_ ])(product|item|listing|offer|job|posting|vacancy|post|entry|card|result|event|review|comment)([-_ ]|$)/i;
	const tokenEls = (($('[class], [id]').toArray() as Element[]).filter((e) => RECORD_TOKEN.test(`${e.attribs.class ?? ''} ${e.attribs.id ?? ''}`) && !['body', 'html', 'main', 'span', 'a', 'img', 'li', 'tr', 'td'].includes(e.tagName)));
	const singles = [...new Set([...($('article, [role="article"]').toArray() as Element[]), ...tokenEls])]
		.filter((a) => !isHidden(a) && !inSkipped(a) && !groups.some((g) => g.members.includes(a)))
		.filter((a) => a.tagName === 'article' || a.attribs.role === 'article' || (() => { const f = recordFields(b, a); return f.some((x) => x.name === 'name') && f.some((x) => x.typed.dataType !== 'text'); })());

	// Record-like groups: members must yield at least two fields, including a name or a typed value.
	const accepted: Array<{ parent: Element; sig: string; members: Element[]; fields: Field[][] }> = [];
	for (const g of groups) {
		const fields = g.members.map((m) => recordFields(b, m));
		const recordLike = fields.filter((f) => f.length >= 2 && f.some((x) => x.name === 'name' || x.typed.dataType !== 'text')).length;
		if (recordLike >= Math.ceil(g.members.length * 0.6)) accepted.push({ ...g, fields });
		else if (g.members.every((m) => m.tagName === 'li') && g.members.length >= 2) accepted.push({ ...g, fields });
		else if (g.members.length >= 3 && fields.every((f) => f.length >= 2)) accepted.push({ ...g, fields }); // unknown but structured: keep it
	}
	// Outer groups first so nesting (posts → replies, products → reviews) can be related.
	const depthOf = (el: Element) => { let d = 0; let p: AnyNode | null = el.parent; while (isEl(p)) { d++; p = p.parent; } return d; };
	accepted.sort((x, y) => depthOf(x.parent) - depthOf(y.parent));
	const nearestRecord = (el: Element): string | null => {
		let p: AnyNode | null = el.parent;
		while (isEl(p)) { const id = recordEls.get(p); if (id) return id; p = p.parent; }
		return null;
	};
	const allMembers = new Set(accepted.flatMap((g) => g.members).concat(singles));
	for (const g of accepted) {
		const members: string[] = [];
		g.members.forEach((m, i) => {
			const nestedInRecord = nearestRecord(m) !== null || (m.tagName === 'article' && $(m).parents('article').length > 0);
			// Exclude nested records' content from this record's fields.
			const nested = new Set(($(m).find('*').toArray() as Element[]).filter((d) => allMembers.has(d)));
			const fields = nested.size ? recordFields(b, m, { excludeNested: nested }) : g.fields[i];
			const id = addRecord(b, m, { nestedInRecord, inCollection: true, fields, method: 'structure' });
			if (!id) return;
			recordEls.set(m, id);
			members.push(id);
			const parentRec = nearestRecord(m);
			if (parentRec) {
				const t = b.entities.get(id)!.type;
				b.rel(id, parentRec, t === 'Comment' ? 'inReplyTo' : 'isPartOf', 'structure', 'inferred', 0.6, [b.ev(m, 'structure')]);
			} else if (pageId) b.rel(pageId, id, 'hasPart', 'structure', 'inferred', 0.6, [b.ev(m, 'structure')]);
		});
		if (members.length) {
			const types = new Set(members.map((x) => b.entities.get(x)!.type));
			const kind: PageCollection['kind'] = g.members[0].tagName === 'li' && types.size === 1 && types.has('ListItem') ? 'list' : types.has('Comment') || types.has('SocialMediaPosting') ? 'thread' : 'repeated';
			const nameEl = $(g.parent).prevAll('h1,h2,h3,h4').first().get(0) as Element | undefined;
			b.collections.push({ id: `col_${h({ k: kind, l: b.locator(g.parent), s: g.sig })}`, kind, name: g.parent.attribs['aria-label'] ?? (nameEl ? b.text(nameEl) : null), itemType: types.size === 1 ? [...types][0] : null, members, signature: g.sig, method: 'structure', evidenceRefs: [b.ev(g.parent, 'structure')] });
		}
	}
	for (const a of singles) {
		const nested = new Set(($(a).find('*').toArray() as Element[]).filter((d) => allMembers.has(d)));
		const id = addRecord(b, a, { nestedInRecord: $(a).parents('article').length > 0, inCollection: false, fields: recordFields(b, a, { excludeNested: nested }), method: 'html' });
		if (!id) continue;
		recordEls.set(a, id);
		const parentRec = nearestRecord(a);
		if (parentRec) b.rel(id, parentRec, b.entities.get(id)!.type === 'Comment' ? 'inReplyTo' : 'isPartOf', 'html', 'semantic', 0.9, [b.ev(a, 'html')]);
		else if (pageId) b.rel(pageId, id, 'hasPart', 'html', 'semantic', 0.9, [b.ev(a, 'html')]);
	}
	// Re-parent: a record whose container record was created later gets that relationship now,
	// and loses the provisional page → record hasPart link.
	for (const [el, id] of recordEls) {
		const parentRec = nearestRecord(el);
		if (!parentRec) continue;
		if (![...b.rels.values()].some((r) => r.from === id && r.to === parentRec)) {
			b.rel(id, parentRec, b.entities.get(id)!.type === 'Comment' ? 'inReplyTo' : 'isPartOf', 'structure', 'inferred', 0.6, [b.ev(el, 'structure')]);
		}
		if (pageId) for (const [rid, r] of b.rels) if (r.from === pageId && r.to === id && r.type === 'hasPart') b.rels.delete(rid);
	}
}

// ------------------------------------------------------------------ stage 7: identity across sources

function identities(b: Builder): void {
	const nameOf = (e: PageEntity) => {
		const a = e.attributes.find((x) => x.name === 'name' && typeof x.value === 'string');
		return a ? (a.value as string).toLowerCase() : null;
	};
	const comparable = (v: AttributeValue) => (v && typeof v === 'object' && 'amount' in v ? (v as { amount: number }).amount : v);
	const list = [...b.entities.values()].filter((e) => e.type !== 'WebPage' && nameOf(e));
	for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
		const x = list[i], y = list[j];
		if (x.type !== y.type || nameOf(x) !== nameOf(y) || x.typeBasis.method === y.typeBasis.method) continue;
		const conflicts: NonNullable<PageRelationship['conflicts']> = [];
		// Offer-level facts are compared through the `offers` relationship (schema.org puts price on the Offer).
		const viaOffers = (e: PageEntity, attr: string) => e.attributes.find((a) => a.name === attr)
			?? [...b.rels.values()].filter((r) => r.from === e.id && r.type === 'offers').map((r) => b.entities.get(r.to)?.attributes.find((a) => a.name === attr)).find(Boolean);
		for (const attr of ['price', 'availability', 'datePublished', 'date', 'author', 'seller']) {
			const ax = viaOffers(x, attr), ay = viaOffers(y, attr);
			if (!ax || !ay || ax.value === null || ay.value === null) continue;
			if (canonicalJson(comparable(ax.value)) !== canonicalJson(comparable(ay.value))) {
				conflicts.push({ attribute: attr, values: [{ entity: x.id, value: ax.value }, { entity: y.id, value: ay.value }] });
				ax.ambiguity = { reason: 'conflict', candidates: [{ value: ay.value, source: `${y.id} (${y.typeBasis.method})` }] };
				ay.ambiguity = { reason: 'conflict', candidates: [{ value: ax.value, source: `${x.id} (${x.typeBasis.method})` }] };
			}
		}
		const id = `rel_${h({ from: x.id, to: y.id, type: 'sameAs' })}`;
		b.rels.set(id, { id, from: x.id, to: y.id, type: 'sameAs', method: 'identity', classification: 'inferred', confidence: 0.6, evidenceRefs: [...new Set([...x.evidenceRefs.slice(0, 1), ...y.evidenceRefs.slice(0, 1)])], ...(conflicts.length ? { conflicts } : {}) });
	}
}

// ------------------------------------------------------------------ stage 8: specialized interpreters

function interpreters(b: Builder, decoders: SignalDecoder[]): void {
	const { $ } = b;
	const blocks = new Set<Element>();
	$('body *').each((_, n) => {
		const el = n as Element;
		if (['script', 'style', 'template'].includes(el.tagName)) return;
		const own = (el.children ?? []).filter((c) => c.type === 'text').map((c) => (c as unknown as { data: string }).data).join('');
		if (!/[​-‏‪-‮⁠-⁤﻿]/.test(own)) return;
		let blk: Element = el;
		while (!BLOCK.has(blk.tagName) && isEl(blk.parent)) blk = blk.parent;
		blocks.add(blk);
	});
	for (const blk of blocks) {
		const text = collapse($(blk).text()); // keeps invisible characters
		const ev = b.ev(blk, 'decoder');
		for (const d of decoders) for (const s of d.detect({ text })) {
			b.signals.push({ id: `sig_${h({ l: b.locator(blk), c: s.codec, k: s.kind, span: s.span ?? null })}`, codec: s.codec, kind: s.kind, ok: s.ok, ...(s.payload ? { payload: s.payload } : {}), ...(s.error ? { error: s.error } : {}), confidence: s.confidence, evidenceRefs: [ev], ...(s.warnings?.length ? { warnings: s.warnings } : {}) });
		}
	}
	// Access boundary (adapted from rkendel1/web-monitor auth-detection.js, narrowed to
	// structural evidence: a password field). Signal does not attempt to sign in.
	$('input[type="password"]').each((_, n) => {
		const el = n as Element;
		let form: AnyNode | null = el.parent;
		while (isEl(form) && form.tagName !== 'form') form = form.parent;
		const anchor = isEl(form) ? form : el;
		b.signals.push({ id: `sig_${h({ l: b.locator(anchor), k: 'login' })}`, codec: 'page-access/v1', kind: 'login_form', ok: true, payload: { action: isEl(form) ? safeUrl(form.attribs.action, b.input.baseUrl) : null }, confidence: 0.6, evidenceRefs: [b.ev(anchor, 'html')] });
	});
}

// ------------------------------------------------------------------ residual: nothing visible is silently dropped

function residualText(b: Builder, pageId: string | null): void {
	if (!pageId) return;
	const { $ } = b;
	const taken = new Set<Element>();
	const covered = (el: Element) => { let p: AnyNode | null = el; while (isEl(p)) { if (b.elEntity.has(p) || taken.has(p)) return true; p = p.parent; } return false; };
	let n = 0;
	($('body *').toArray() as Element[]).forEach((el) => {
		if (n >= 100 || !isEl(el) || /^h[1-3]$/.test(el.tagName) || ['script', 'style', 'template', 'noscript', 'title', 'th', 'caption', 'thead'].includes(el.tagName)) return;
		const own = visibleText((el.children ?? []).filter((c) => c.type === 'text').map((c) => (c as unknown as { data: string }).data).join(' '));
		if (own.length < 2 || inSkipped(el) || covered(el)) return;
		const text = b.text(el);
		n++;
		taken.add(el);
		b.attr(pageId, { name: 'text', value: text, raw: text, dataType: 'text', provenance: 'observed', method: 'html', confidence: 0.3, evidenceRefs: [b.ev(el, 'html')] });
	});
}

// ------------------------------------------------------------------ entry point

export function extractPage(input: PageInput): PageRepresentation {
	const $ = load(input.html, { scriptingEnabled: false } as never);
	const b = new Builder($, input);
	const elements = $('*').length;
	if (elements > b.limits.maxElements) b.truncated = true;
	const pageId = pageEntity(b);
	jsonLd(b, pageId);
	scoped(b, '[itemscope]', 'itemprop', 'itemtype', 'microdata');
	scoped(b, '[typeof]', 'property', 'typeof', 'rdfa');
	tables(b, pageId);
	repeated(b, pageId);
	residualText(b, pageId);
	identities(b);
	interpreters(b, input.decoders ?? []);

	const entities = [...b.entities.values()];
	const byClassification = { declared: 0, semantic: 0, inferred: 0, unknown: 0 } as Record<Classification, number>;
	for (const e of entities) byClassification[e.classification]++;
	const titleAttr = pageId ? b.entities.get(pageId)?.attributes.find((a) => a.name === 'title') : undefined;
	const langAttr = pageId ? b.entities.get(pageId)?.attributes.find((a) => a.name === 'inLanguage') : undefined;
	const rep: PageRepresentation = {
		schema: PAGE_SCHEMA, extractorVersion: EXTRACTOR_VERSION,
		source: { locator: input.locator, baseUrl: input.baseUrl, observationId: input.observationId, contentHash: input.contentHash, contentType: input.contentType },
		observedAt: input.observedAt, revision: '',
		language: (langAttr?.value as string) ?? null, title: (titleAttr?.value as string) ?? null,
		entities, relationships: [...b.rels.values()], collections: b.collections, signals: b.signals, evidence: [...b.evidence.values()],
		stats: { elements, elementsVisited: b.elementsVisited, truncated: b.truncated, limits: b.limits, byClassification }
	};
	rep.revision = pageRevision(rep);
	return rep;
}

/** Content revision: identical page content ⇒ identical revision, independent of which observation saw it. */
export function pageRevision(rep: PageRepresentation): string {
	const { revision: _r, observedAt: _o, source, ...rest } = rep;
	return sha256(canonicalJson({ ...rest, source: { ...source, observationId: null } }));
}
