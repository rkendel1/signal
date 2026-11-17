/**
 * Deterministic value typing. Every function is pure: same input → same output.
 * Nothing here fetches, evaluates or executes anything taken from a page.
 */
import { parseNumber } from '../interpret/extract.ts';
import type { AttributeValue, DataType, Money, MoneyRange, PageAttribute, ValueProvenance } from './types.ts';

export interface Typed {
	value: AttributeValue;
	dataType: DataType;
	provenance: ValueProvenance;
	ambiguity?: PageAttribute['ambiguity'];
}

const SYMBOL_CURRENCY: Record<string, string> = { '$': 'USD', 'US$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', 'C$': 'CAD', 'A$': 'AUD', 'CHF': 'CHF' };
const CODES = 'USD|EUR|GBP|JPY|INR|CAD|AUD|CHF|CNY|SEK|NOK|DKK|NZD|MXN|BRL';
const SYM = '(?:US\\$|C\\$|A\\$|\\$|€|£|¥|₹)';
// Grouped thousands need at least one separator; otherwise plain digits (so "1033.99" is not read as "103").
const NUM = '\\d{1,3}(?:[,.\\u00a0 ]\\d{3})+(?:[.,]\\d{1,2})?(?!\\d)|\\d+(?:[.,]\\d{1,2})?';
const MONEY_RE = new RegExp(`(?:(${SYM})\\s?(${NUM})(\\s?[kK])?|(${NUM})(\\s?[kK])?\\s?(${SYM}|${CODES})|(${CODES})\\s?(${NUM})(\\s?[kK])?)`);
const RANGE_RE = new RegExp(`(${SYM}|${CODES})?\\s?(${NUM})(\\s?[kK])?\\s*(?:-|–|—|to)\\s*(${SYM}|${CODES})?\\s?(${NUM})(\\s?[kK])?`, 'i');
const PERIOD_RE = /\b(?:per|\/|a|an)\s*(hour|hr|year|yr|annum|month|mo|week|wk|day)\b/i;

function currencyOf(token: string | undefined): string | null {
	if (!token) return null;
	return SYMBOL_CURRENCY[token] ?? (new RegExp(`^(${CODES})$`).test(token) ? token : null);
}
function amount(n: string, k?: string): number | null {
	const v = parseNumber(n.replace(/[\u00a0 ]/g, ''));
	return v === null ? null : k ? v * 1000 : v;
}
function period(text: string): string | undefined {
	const m = PERIOD_RE.exec(text);
	if (!m) return undefined;
	const p = m[1].toLowerCase();
	return p.startsWith('h') ? 'hour' : p.startsWith('y') || p === 'annum' ? 'year' : p.startsWith('mo') ? 'month' : p.startsWith('w') ? 'week' : 'day';
}

export function parseMoney(text: string): Money | null {
	const m = MONEY_RE.exec(text);
	if (!m) return null;
	if (m[2] !== undefined) { const a = amount(m[2], m[3]); return a === null ? null : { amount: a, currency: currencyOf(m[1]) }; }
	if (m[4] !== undefined) { const a = amount(m[4], m[5]); return a === null ? null : { amount: a, currency: currencyOf(m[6]) }; }
	const a = amount(m[8], m[9]);
	return a === null ? null : { amount: a, currency: currencyOf(m[7]) };
}

export function parseMoneyRange(text: string): MoneyRange | null {
	const m = RANGE_RE.exec(text);
	if (!m || (!m[1] && !m[4])) return null; // a range needs a currency marker to be money
	const lo = amount(m[2], m[3] ?? m[6]), hi = amount(m[5], m[6]);
	if (lo === null || hi === null || hi < lo) return null;
	return { min: lo, max: hi, currency: currencyOf(m[1] ?? m[4]), ...(period(text) ? { period: period(text) } : {}) };
}

// schema.org ItemAvailability, plus the visible phrases that map to it.
const AVAILABILITY: Array<[RegExp, string]> = [
	[/\b(pre-?order)\b/i, 'PreOrder'],
	[/\b(back-?order(ed)?)\b/i, 'BackOrder'],
	[/\b(sold out)\b/i, 'SoldOut'],
	[/\b(out of stock|unavailable|currently unavailable)\b/i, 'OutOfStock'],
	[/\b(discontinued)\b/i, 'Discontinued'],
	[/\b(only \d+ left|limited (stock|availability)|few left|low stock)\b/i, 'LimitedAvailability'],
	[/\b(in stock|available now|in-stock|ships today)\b/i, 'InStock'],
	[/\b(online only)\b/i, 'OnlineOnly'],
	[/\b(in store only)\b/i, 'InStoreOnly']
];
export function parseAvailability(text: string): string | null {
	const url = /schema\.org\/(\w+)$/.exec(text.trim());
	if (url) return url[1];
	if (/^(InStock|OutOfStock|PreOrder|BackOrder|SoldOut|Discontinued|LimitedAvailability|OnlineOnly|InStoreOnly|PreSale)$/.test(text.trim())) return text.trim();
	for (const [re, v] of AVAILABILITY) if (re.test(text)) return v;
	return null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');
function validYmd(y: number, m: number, d: number): boolean {
	if (m < 1 || m > 12 || d < 1) return false;
	return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/**
 * Dates. ISO forms are observed values normalized to ISO strings. "03/04/2026" is
 * ambiguous (MM/DD vs DD/MM) unless only one reading is valid: the value is then null
 * with both candidates. Relative forms ("3 hours ago") are resolved against the
 * observation time and marked inferred.
 */
export function parseDate(text: string, observedAt: string): Typed | null {
	const t = text.trim();
	let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/.exec(t);
	if (m) {
		if (!validYmd(+m[1], +m[2], +m[3])) return null;
		if (!m[4]) return { value: iso(+m[1], +m[2], +m[3]), dataType: 'date', provenance: 'normalized' };
		const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}${m[7] ? m[7].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2') : 'Z'}`);
		if (isNaN(+d)) return null;
		return { value: d.toISOString(), dataType: 'datetime', provenance: 'normalized' };
	}
	m = /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b/i.exec(t);
	if (m) { const mo = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1; if (validYmd(+m[3], mo, +m[1])) return { value: iso(+m[3], mo, +m[1]), dataType: 'date', provenance: 'normalized' }; }
	m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i.exec(t);
	if (m) { const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1; if (validYmd(+m[3], mo, +m[2])) return { value: iso(+m[3], mo, +m[2]), dataType: 'date', provenance: 'normalized' }; }
	m = /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/.exec(t);
	if (m) {
		const a = +m[1], b = +m[2], y = +m[3];
		const us = validYmd(y, a, b) ? iso(y, a, b) : null;
		const eu = validYmd(y, b, a) ? iso(y, b, a) : null;
		if (us && eu && us !== eu) return { value: null, dataType: 'date', provenance: 'normalized', ambiguity: { reason: 'format', candidates: [{ value: us, source: 'MM/DD/YYYY' }, { value: eu, source: 'DD/MM/YYYY' }] } };
		const v = us ?? eu;
		if (v) return { value: v, dataType: 'date', provenance: 'normalized' };
	}
	m = /\b(\d+)\s+(second|minute|hour|day|week)s?\s+ago\b/i.exec(t);
	if (m) {
		const unit = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800 }[m[2].toLowerCase() as 'day'];
		const base = Date.parse(observedAt);
		if (!isNaN(base)) return { value: new Date(base - +m[1] * unit * 1000).toISOString(), dataType: 'datetime', provenance: 'inferred', ambiguity: { reason: 'relative', candidates: [{ value: t, source: `relative to observation ${observedAt}` }] } };
	}
	if (/^(yesterday|today)$/i.test(t)) {
		const base = new Date(Date.parse(observedAt) - (/yesterday/i.test(t) ? 86400000 : 0));
		if (!isNaN(+base)) return { value: base.toISOString().slice(0, 10), dataType: 'date', provenance: 'inferred', ambiguity: { reason: 'relative', candidates: [{ value: t, source: `relative to observation ${observedAt}` }] } };
	}
	return null;
}

export function parseRating(text: string): { value: number; best: number } | null {
	let m = /(\d(?:\.\d)?)\s*(?:out of|\/)\s*(\d+)/i.exec(text);
	if (m) return { value: +m[1], best: +m[2] };
	m = /^(★+)(☆*)$/.exec(text.trim());
	if (m) return { value: m[1].length, best: m[1].length + m[2].length };
	return null;
}

const SECRET_PARAM = /^(token|access_token|id_token|auth|authorization|session|sessionid|sid|key|api_key|apikey|signature|sig|password|pass|secret|code|otp|jwt)$/i;
const TRACKING_PARAM = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|_ga)$/i;

/**
 * Resolve a page-supplied URL for *representation only*. It is never fetched.
 * Non-http(s) schemes (javascript:, data:, file:, …) are not retained as links.
 * Secret-looking query parameters are redacted; tracking parameters dropped;
 * fragment removed; parameters sorted (normalization from rkendel1/web-monitor
 * semantic-monitor.js normalizeTargetUrl, extended with redaction).
 */
export function safeUrl(raw: string | undefined | null, base: string | null): string | null {
	if (!raw) return null;
	const trimmed = raw.trim();
	if (!trimmed || /^(javascript|data|vbscript|file|blob):/i.test(trimmed)) return null;
	let u: URL;
	try { u = base ? new URL(trimmed, base) : new URL(trimmed); } catch { return null; }
	if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
	u.username = ''; u.password = ''; u.hash = '';
	for (const k of [...u.searchParams.keys()]) {
		if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
		else if (SECRET_PARAM.test(k)) u.searchParams.set(k, 'REDACTED');
	}
	u.searchParams.sort();
	return u.toString();
}

/** Redact secret-looking query parameters inside a URL string without resolving it. */
export function redactUrlString(raw: string): string {
	return raw.replace(/([?&;])([^=&#;]+)=([^&#;]*)/g, (m, sep: string, k: string) => (SECRET_PARAM.test(decodeURIComponent(k)) ? `${sep}${k}=REDACTED` : m));
}

export const EMAIL_RE = /^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[a-z]{2,24}$/i;

/** Type a free-text value without a hint. Order matters and is part of the contract. */
export function inferText(raw: string, observedAt: string): Typed {
	const t = raw.trim();
	const range = parseMoneyRange(t);
	if (range) return { value: range, dataType: 'money_range', provenance: 'normalized' };
	const money = parseMoney(t);
	if (money && t.length <= 40) return { value: money, dataType: 'money', provenance: 'normalized' };
	const avail = parseAvailability(t);
	if (avail && t.length <= 60) return { value: avail, dataType: 'availability', provenance: 'normalized' };
	if (t.length <= 60) {
		const d = parseDate(t, observedAt);
		if (d) return d;
	}
	const rating = t.length <= 20 ? parseRating(t) : null;
	if (rating) return { value: rating, dataType: 'rating', provenance: 'normalized' };
	if (/^-?\d+(?:[.,]\d+)?\s?%$/.test(t)) return { value: parseNumber(t), dataType: 'percent', provenance: 'normalized' };
	if (/^-?\d{1,3}(?:,\d{3})*(?:\.\d+)?$|^-?\d+(?:\.\d+)?$/.test(t)) return { value: parseNumber(t), dataType: 'number', provenance: 'normalized' };
	if (EMAIL_RE.test(t)) return { value: t.toLowerCase(), dataType: 'email', provenance: 'normalized' };
	return { value: t, dataType: 'text', provenance: 'observed' };
}

/** "3 bd | 2 ba | 1,540 sqft" → quantities, using the UNITS table. Unknown units are not guessed. */
export function parseQuantities(text: string, units: Array<{ re: RegExp; attribute: string; unit: string }>): Array<{ attribute: string; value: number; unit: string; raw: string }> {
	const out: Array<{ attribute: string; value: number; unit: string; raw: string }> = [];
	// Separators are | · • or ", " — never a bare comma, which is a thousands separator ("1,540 sqft").
	for (const part of text.split(/\s*[|·•]\s*|,\s+(?=\d)|\s{2,}/)) {
		const m = /^(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*([A-Za-z²][A-Za-z².\s]{0,14})$/.exec(part.trim());
		if (!m) continue;
		const u = units.find((x) => x.re.test(m[2].trim()));
		if (u) out.push({ attribute: u.attribute, value: Number(m[1].replace(/,/g, '')), unit: u.unit, raw: part.trim() });
	}
	return out;
}
