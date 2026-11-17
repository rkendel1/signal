/**
 * BENCHMARK ARTIFACT (rejected storage alternative D, kept to reproduce docs/storage-options.json).
 * Compact columnar encoding of signal.page/v1 ("signal.page.store/1"), used only to evaluate
 * storage alternatives (scripts/bench-storage.ts). Lossless: expandPage(compactPage(rep), html)
 * reproduces the canonical v1 document byte-for-byte, re-deriving evidence text from the raw HTML.
 */
import { load } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import type { PageRepresentation } from '../lib/page/types.ts';

export interface CompactPage { schema: 'signal.page.store/1'; strings: string[]; steps: Array<[number, number]>; doc: unknown }

export function compactPage(rep: PageRepresentation): CompactPage {
	const strings: string[] = [];
	const si = new Map<string, number>();
	const S = (s: string) => { let i = si.get(s); if (i === undefined) { i = strings.length; strings.push(s); si.set(s, i); } return i; };
	const steps: Array<[number, number]> = []; // [parentStepIndex | -1, stringIndex of segment]
	const stepIdx = new Map<string, number>();
	const L = (locator: string) => {
		let parent = -1;
		let path = '';
		for (const seg of locator.split('>')) {
			path = path ? `${path}>${seg}` : seg;
			let i = stepIdx.get(path);
			if (i === undefined) { i = steps.length; steps.push([parent, S(seg)]); stepIdx.set(path, i); }
			parent = i;
		}
		return parent;
	};
	const evIndex = new Map(rep.evidence.map((e, i) => [e.id, i]));
	const R = (refs: string[]) => refs.map((r) => evIndex.get(r)!);
	const doc = {
		...rep,
		evidence: rep.evidence.map((e) => [S(e.id), L(e.locator), S(e.element), Object.entries(e.attributes).map(([k, v]) => [S(k), S(v)]), S(e.method), e.pointer === undefined ? null : S(e.pointer), e.text === null ? 0 : 1]),
		entities: rep.entities.map((e) => [S(e.id), S(e.type), S(e.classification), S(e.typeBasis.method), S(e.typeBasis.rule), S(e.identity.key), S(e.identity.basis), R(e.evidenceRefs),
			e.attributes.map((a) => [S(a.name), a.value, a.raw === null ? null : typeof a.value === 'string' && a.raw === a.value ? 1 : S(a.raw), S(a.dataType), S(a.provenance), S(a.method), a.confidence, R(a.evidenceRefs), a.ambiguity ?? null])]),
		relationships: rep.relationships.map((r) => [S(r.id), S(r.from), S(r.to), S(r.type), S(r.method), S(r.classification), r.confidence, R(r.evidenceRefs), r.conflicts ?? null]),
		collections: rep.collections.map((c) => ({ ...c, evidenceRefs: R(c.evidenceRefs) })),
		signals: rep.signals.map((s) => ({ ...s, evidenceRefs: R(s.evidenceRefs) }))
	};
	return { schema: 'signal.page.store/1', strings, steps, doc };
}

/** Same algorithm as the extractor's Builder.text(), truncated as evidence text is (300 chars). */
function evidenceText(el: Element, maxTextLength = 1000): string {
	const isEl = (n: AnyNode | null | undefined): n is Element => !!n && (n.type === 'tag' || n.type === 'script' || n.type === 'style');
	const BLOCK = new Set(['p', 'div', 'li', 'td', 'th', 'article', 'section', 'blockquote', 'dd', 'dt', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figcaption', 'main', 'aside', 'body', 'tr', 'span']);
	const out: string[] = [];
	let budget = maxTextLength * 4;
	const walk = (n: AnyNode) => {
		if (budget <= 0) return;
		if (n.type === 'text') { const d = (n as unknown as { data: string }).data; out.push(d); budget -= d.length; return; }
		if (!isEl(n) || n.type === 'script' || n.type === 'style' || ['noscript', 'template', 'svg'].includes(n.tagName)) return;
		for (const c of n.children ?? []) walk(c);
		if (BLOCK.has(n.tagName)) out.push(' ');
	};
	walk(el);
	return out.join('').replace(/[​-‏‪-‮⁠-⁤﻿]/g, '').replace(/[ \t\r\n\f\v ]+/g, ' ').trim().slice(0, maxTextLength);
}

export function expandPage(c: CompactPage, html?: string): PageRepresentation {
	const s = c.strings;
	const locOf = (i: number): string => { const parts: string[] = []; for (let x = i; x !== -1; x = c.steps[x][0]) parts.unshift(s[c.steps[x][1]]); return parts.join('>'); };
	const d = c.doc as Record<string, any>;
	const $ = html ? load(html, { scriptingEnabled: false } as never) : null;
	const evidence = (d.evidence as any[]).map(([id, loc, el, attrs, method, pointer, hasText]) => {
		const locator = locOf(loc);
		let text: string | null = null;
		if (hasText && $) { const node = $(locator.replace(/>/g, ' > ')).get(0) as Element | undefined; text = node ? evidenceText(node).slice(0, 300) || null : null; }
		return { id: s[id], locator, element: s[el], attributes: Object.fromEntries((attrs as Array<[number, number]>).map(([k, v]) => [s[k], s[v]])), text, method: s[method], ...(pointer === null ? {} : { pointer: s[pointer] }) };
	});
	const ref = (xs: number[]) => xs.map((i) => evidence[i].id);
	return {
		...d,
		evidence,
		entities: (d.entities as any[]).map(([id, type, cls, tbm, tbr, key, basis, refs, attrs]) => ({
			id: s[id], type: s[type], classification: s[cls], typeBasis: { method: s[tbm], rule: s[tbr] }, identity: { key: s[key], basis: s[basis] },
			attributes: (attrs as any[]).map(([n, value, raw, dt, prov, m, conf, r, amb]) => ({ name: s[n], value, raw: raw === null ? null : raw === 1 ? value : s[raw], dataType: s[dt], provenance: s[prov], method: s[m], confidence: conf, evidenceRefs: ref(r), ...(amb ? { ambiguity: amb } : {}) })),
			evidenceRefs: ref(refs)
		})),
		relationships: (d.relationships as any[]).map(([id, from, to, type, method, cls, conf, refs, conflicts]) => ({ id: s[id], from: s[from], to: s[to], type: s[type], method: s[method], classification: s[cls], confidence: conf, evidenceRefs: ref(refs), ...(conflicts ? { conflicts } : {}) })),
		collections: (d.collections as any[]).map((x) => ({ ...x, evidenceRefs: ref(x.evidenceRefs) })),
		signals: (d.signals as any[]).map((x) => ({ ...x, evidenceRefs: ref(x.evidenceRefs) }))
	} as PageRepresentation;
}
