import type { ExtractedField, ExtractionRule } from '../contracts/types.ts';

const MAX_PATTERN_LENGTH = 512;

/** Parse "1,299.99", "$95", "95,00 €" style numbers deterministically. */
export function parseNumber(raw: string): number | null {
	const cleaned = raw.replace(/[^\d.,\-]/g, '');
	if (!cleaned) return null;
	let n: string;
	const lastComma = cleaned.lastIndexOf(',');
	const lastDot = cleaned.lastIndexOf('.');
	if (lastComma > lastDot && cleaned.length - lastComma - 1 !== 3) {
		n = cleaned.replace(/\./g, '').replace(',', '.'); // European decimal comma
	} else {
		n = cleaned.replace(/,/g, '');
	}
	const v = Number(n);
	return Number.isFinite(v) ? v : null;
}

function coerce(raw: string, type: ExtractionRule['type']): string | number | boolean | null {
	if (type === 'number') return parseNumber(raw);
	if (type === 'boolean') return /^(true|yes|1|in stock|available)$/i.test(raw.trim());
	return raw.trim();
}

/** RFC 6901 JSON Pointer. */
export function jsonPointer(doc: unknown, pointer: string): unknown {
	if (pointer === '') return doc;
	if (!pointer.startsWith('/')) throw new Error(`Invalid JSON pointer: ${pointer}`);
	let cur: unknown = doc;
	for (const raw of pointer.slice(1).split('/')) {
		const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
		if (cur === null || typeof cur !== 'object') return undefined;
		cur = (cur as Record<string, unknown>)[key];
	}
	return cur;
}

export function validateRule(rule: ExtractionRule): void {
	if (!/^[A-Za-z_][\w.-]{0,63}$/.test(rule.field)) throw new Error(`Invalid field name: ${rule.field}`);
	if (rule.from === 'text') {
		if (!rule.pattern || rule.pattern.length > MAX_PATTERN_LENGTH) throw new Error(`Rule ${rule.field}: pattern required (<= ${MAX_PATTERN_LENGTH} chars)`);
		if (rule.flags && !/^[imsu]*$/.test(rule.flags)) throw new Error(`Rule ${rule.field}: only i,m,s,u flags allowed`);
		new RegExp(rule.pattern, rule.flags); // throws on invalid syntax
	} else if (rule.from === 'json') {
		if (rule.pointer === undefined) throw new Error(`Rule ${rule.field}: pointer required`);
	} else {
		throw new Error(`Rule ${(rule as ExtractionRule).field}: unknown source ${(rule as ExtractionRule).from}`);
	}
}

/**
 * Apply extraction rules. A rule that finds nothing yields `value: null` (the
 * field is *absent*), which criteria can test explicitly with `absent`.
 */
export function extractFields(rules: ExtractionRule[], normalizedText: string, rawBody: string): ExtractedField[] {
	const out: ExtractedField[] = [];
	let parsedJson: unknown;
	let jsonError: string | undefined;
	for (const rule of rules) {
		validateRule(rule);
		if (rule.from === 'text') {
			const re = new RegExp(rule.pattern!, (rule.flags ?? '').replace(/g/g, ''));
			const m = re.exec(normalizedText);
			if (!m) {
				out.push({ field: rule.field, value: null });
				continue;
			}
			const raw = m[1] ?? m[0];
			const start = m.index + (m[1] !== undefined ? m[0].indexOf(m[1]) : 0);
			out.push({ field: rule.field, value: coerce(raw, rule.type), excerpt: m[0], span: [start, start + raw.length] });
		} else {
			if (parsedJson === undefined && jsonError === undefined) {
				try {
					parsedJson = JSON.parse(rawBody);
				} catch (e) {
					jsonError = (e as Error).message;
				}
			}
			const v = jsonError ? undefined : jsonPointer(parsedJson, rule.pointer!);
			if (v === undefined || v === null || typeof v === 'object') {
				out.push({ field: rule.field, value: null, excerpt: jsonError ? `invalid JSON: ${jsonError}` : undefined });
				continue;
			}
			out.push({ field: rule.field, value: coerce(String(v), rule.type), excerpt: `${rule.pointer} = ${JSON.stringify(v)}` });
		}
	}
	return out;
}
