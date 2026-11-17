/**
 * Deterministic content normalization. The normalized text is what criteria and
 * decoders run against; the raw bytes remain the evidence.
 *
 * Invariant: invisible Unicode (U+200B–U+200F, U+202C–U+202D, U+2060, U+FEFF) is
 * preserved — stripping it would destroy embedded signals (Ghostpost learned this
 * on X.com/Facebook, see XCOM_API_BEHAVIOR.md in rkendel1/ghostpost).
 */

const ENTITIES: Record<string, string> = {
	amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
	copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', yen: '¥', cent: '¢',
	mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»', zwj: '‍', zwnj: '‌'
};

export function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
		if (e[0] === '#') {
			const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
		}
		return ENTITIES[e.toLowerCase()] ?? m;
	});
}

const BLOCK = /<\/?(p|div|br|li|ul|ol|tr|td|th|h[1-6]|section|article|header|footer|main|nav|aside|table|blockquote|pre|hr)\b[^>]*>/gi;

/** HTML → visible text. Not a full HTML parser; deterministic and dependency-free. */
export function htmlToText(html: string): string {
	let s = html
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ')
		.replace(BLOCK, '\n')
		.replace(/<[^>]+>/g, ' ');
	s = decodeEntities(s);
	return collapse(s);
}

function collapse(s: string): string {
	return s
		.replace(/\r\n?/g, '\n')
		.replace(/[ \t\f\v ]+/g, ' ')
		.replace(/ *\n */g, '\n')
		.replace(/\n{2,}/g, '\n')
		.trim();
}

export function normalizeContent(body: string, contentType: string | undefined): string {
	const ct = (contentType ?? '').toLowerCase();
	if (ct.includes('html') || (!ct && /^\s*<(!doctype|html|body|div|p)\b/i.test(body))) return htmlToText(body);
	if (ct.includes('json')) return body; // structured rules use the JSON itself
	return collapse(body);
}
