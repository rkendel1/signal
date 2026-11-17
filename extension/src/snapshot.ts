/**
 * The page snapshot a capture sends: the rendered DOM, reduced to what structure extraction reads.
 *
 * Kept: every element, its attributes (classes, ARIA, microdata/RDFa, data-*, hidden/style for
 * visibility), its text, JSON-LD, and <link rel=canonical|next|prev|alternate>.
 * Removed: executable and presentational payload the extractor never reads — the content of scripts
 * other than JSON-LD (the empty elements stay, so positions do not shift), styles, stylesheet/preload links, noscript, templates, iframes, comments, SVG drawing data,
 * srcset lists and inline data: URIs.
 *
 * Rendered visibility (default): the browser knows what the person sees, the server only guesses from markup.
 * Elements the page's CSS does not display are dropped; elements marked aria-hidden/hidden that are in fact
 * displayed lose that marker, so their content is not discarded as invisible.
 *
 * Must stay self-contained (no imports, no closures): chrome.scripting serializes it into the page.
 */
export interface Snapshot {
	url: string; title: string; html: string | null; chars: number; originalChars: number; bytes: number;
	/** Diagnostics: elements in the page, dropped as not displayed, and displayed despite aria-hidden/hidden. */
	elements: number; notDisplayed: number; revealed: number;
}

/** `maxBytes`: the largest UTF-8 snapshot that fits one request to the instance. */
export function snapshotPage(maxBytes: number, rendered = true): Snapshot {
	const live = Array.from(document.documentElement.querySelectorAll('*'));
	const clone = document.documentElement.cloneNode(true) as HTMLElement;
	const copies = Array.from(clone.querySelectorAll('*'));
	const originalChars = clone.outerHTML.length;
	let notDisplayed = 0, revealed = 0;
	if (rendered && live.length === copies.length && document.body) {
		// Never judged by display: data-carrying and inert elements (JSON-LD in <body> is display:none).
		const DATA = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'META', 'LINK', 'TITLE', 'HEAD', 'BR', 'WBR']);
		const drop: Element[] = [];
		for (let i = 0; i < live.length; i++) {
			const el = live[i];
			if (DATA.has(el.tagName.toUpperCase()) || !document.body.contains(el) || el.closest('[data-signal-overlay], svg')) continue;
			const cs = getComputedStyle(el);
			if (cs.display === 'none') { drop.push(copies[i]); continue; }
			const shown = el.getClientRects().length > 0 && cs.visibility !== 'hidden';
			if (shown && (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('hidden'))) {
				copies[i].removeAttribute('aria-hidden');
				copies[i].removeAttribute('hidden');
				revealed++;
			}
		}
		for (const c of drop) { if (c.isConnected || c.parentNode) { c.remove(); notDisplayed++; } }
	}
	const drop = [
		'[data-signal-overlay]', // never capture Signal's own UI
		'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'canvas', 'video', 'audio',
		'link:not([rel~="canonical"]):not([rel~="next"]):not([rel~="prev"]):not([rel~="alternate"])'
	];
	clone.querySelectorAll(drop.join(',')).forEach((n) => n.remove());
	// Other scripts are emptied, not removed: JSON-LD records without an @id are identified by their
	// position among scripts (script:nth-of-type), which removal would shift.
	clone.querySelectorAll('script:not([type="application/ld+json"])').forEach((n) => { for (const a of [...n.attributes]) n.removeAttribute(a.name); n.textContent = ''; });
	clone.querySelectorAll('svg').forEach((svg) => {
		const title = svg.querySelector('title');
		svg.replaceChildren(...(title ? [title] : []));
	});
	clone.querySelectorAll('[srcset]').forEach((n) => n.removeAttribute('srcset'));
	clone.querySelectorAll('source').forEach((n) => n.remove());
	clone.querySelectorAll('[src^="data:"],[href^="data:"]').forEach((n) => { if (n.hasAttribute('src')) n.setAttribute('src', 'data:'); if (n.getAttribute('href')?.startsWith('data:')) n.setAttribute('href', 'data:'); });
	const comments: Node[] = [];
	const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
	for (let c = walker.nextNode(); c; c = walker.nextNode()) comments.push(c);
	comments.forEach((c) => c.parentNode?.removeChild(c));
	const html = '<!doctype html>\n' + clone.outerHTML;
	const bytes = new TextEncoder().encode(html).length;
	return { url: location.href, title: document.title, html: bytes > maxBytes ? null : html, chars: html.length, originalChars, bytes, elements: live.length, notDisplayed, revealed };
}
