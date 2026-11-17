/**
 * Signal overlay — makes Signal results actionable where the information is.
 *
 * Generalises Ghostpost's overlay (badge → reveal panel) from "hidden message
 * found" to any Signal result:
 *   • Alerts: events recorded for this page's URL, with matched values,
 *     previous values, excerpts and a link to the preserved evidence.
 *   • Embedded signals: Ghostpost envelopes in the page, decoded locally by the
 *     extracted codec (WASM); reveal is an explicit user action.
 *
 * Safety: page content and event content are rendered with textContent only,
 * inside a closed shadow root; nothing observed is ever executed or used as an
 * instruction. Usage:
 *   window.SignalOverlayConfig = { transport, codecBase, locator? }; then load overlay.js.
 *
 * The overlay holds no credentials and calls no API itself. `transport(op, args)` is
 * provided by its host. In the Signal extension (extension/), it messages the side panel,
 * which is the only context holding the FeltKit bearer session; the service worker holds none
 * (@feltdb/feltkit docs/EXTENSION-HOSTS.md). The panel allows only these ops, which map 1:1 to
 * Signal functions:
 *   'events:forPage' {sourceLocator} · 'events:evidence' {eventId} · 'events:acknowledge' {eventId}
 *   · 'watch:forPage' {} — what this page is being watched for (criteria labels, who is notified)
 * `codecBase` serves ghostpost_unicode_codec.js and _bg.wasm (extension: web_accessible_resources).
 */
(function () {
	'use strict';
	if (window.__signalOverlay) return;
	const cfg = Object.assign({ locator: location.href }, window.SignalOverlayConfig || {});
	const state = { events: [], signals: [], open: false, dismissed: new Set(), error: null, monitoring: true, watch: undefined, outlined: [], showMatches: true, lastEvents: [], everRelevant: false };

	// ---------------------------------------------------------------- UI shell
	const instance = `${Date.now()}-${Math.random()}`;
	const host = document.createElement('div');
	host.setAttribute('data-signal-overlay', '');
	const root = host.attachShadow({ mode: 'closed' });
	root.innerHTML = `<style>
		:host{all:initial}
		.badge{position:fixed;right:16px;bottom:16px;z-index:2147483646;display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:999px;border:0;
			font:600 13px/1 system-ui,-apple-system,Segoe UI,sans-serif;color:#fff;background:#4b5563;box-shadow:0 4px 16px rgba(0,0,0,.25);cursor:pointer}
		.badge[hidden]{display:none}
		.badge.alert{background:#b45309}.badge.critical{background:#b91c1c}.badge.signal{background:#4f46e5}
		.dot{width:8px;height:8px;border-radius:50%;background:currentColor;opacity:.9}
		.panel{position:fixed;right:16px;bottom:64px;z-index:2147483647;width:min(400px,calc(100vw - 32px));max-height:min(70vh,640px);overflow:auto;
			background:#fff;color:#111827;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.3);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
		.panel[hidden]{display:none}
		header{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid #e5e7eb;font-weight:600}
		h3{margin:12px 14px 6px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280}
		.item{margin:8px 14px;padding:10px;border:1px solid #e5e7eb;border-radius:8px}
		.item .t{font-weight:600}.sev{font-size:11px;padding:2px 6px;border-radius:4px;margin-left:6px;background:#fef3c7;color:#92400e}
		.sev.critical{background:#fee2e2;color:#991b1b}.sev.info{background:#e0e7ff;color:#3730a3}
		.kv{font:12px/1.4 ui-monospace,Menlo,monospace;color:#374151;margin-top:6px;white-space:pre-wrap;word-break:break-word}
		.ex{margin-top:6px;padding:6px 8px;background:#f9fafb;border-left:3px solid #d97706;font-size:13px;white-space:pre-wrap;word-break:break-word}
		.meta{margin-top:6px;font-size:12px;color:#6b7280}
		button.s{font:inherit;font-size:12px;margin:8px 6px 0 0;padding:4px 10px;border:1px solid #d1d5db;border-radius:6px;background:#fff;color:#111827;cursor:pointer}
		button.s:focus-visible,.badge:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
		.empty{margin:8px 14px 14px;color:#6b7280;font-size:13px}
		.match{margin-top:6px;padding:6px 8px;border-left:3px solid #059669;background:#ecfdf5;font-size:13px}
		.match a{color:#065f46;font-size:12px;margin-left:8px}
		.miss{margin-top:4px;font-size:12px;color:#92400e}
		.spot{position:fixed;z-index:2147483645;pointer-events:none;border:3px solid #059669;border-radius:10px;box-shadow:0 0 0 4px rgba(5,150,105,.25);animation:pulse 1s ease-in-out 3}
		.spot-label{position:fixed;z-index:2147483646;pointer-events:none;background:#065f46;color:#fff;font:600 12px/1.3 system-ui,-apple-system,Segoe UI,sans-serif;padding:4px 8px;border-radius:6px;max-width:360px;box-shadow:0 2px 8px rgba(0,0,0,.25)}
		@keyframes pulse{50%{box-shadow:0 0 0 12px rgba(5,150,105,.12)}}
		.crit{font-size:12px;color:#065f46}
		.secret{margin-top:6px;padding:6px 8px;background:#eef2ff;border-radius:6px;white-space:pre-wrap;word-break:break-word}
	</style>
	<button class="badge" part="badge" aria-expanded="false" aria-controls="p"><span class="dot"></span><span class="label">Signal</span></button>
	<section class="panel" id="p" role="dialog" aria-label="Signal" hidden>
		<header><span>Signal</span><button class="s close" aria-label="Close">✕</button></header>
		<h3>Watching</h3><div class="watch"></div>
		<h3>Alerts for this page</h3><div class="alerts"></div>
		<h3>Embedded signals</h3><div class="signals"></div>
	</section>`;
	const $ = (s) => root.querySelector(s);
	const badge = $('.badge'), panel = $('.panel');
	badge.addEventListener('click', () => { state.open = !state.open; render(); });
	$('.close').addEventListener('click', () => { state.open = false; render(); });

	function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
	function fmt(v) { return v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v); }

	function render() {
		const events = state.events.filter((e) => !state.dismissed.has(e.id));
		const unacked = events.filter((e) => !e.acknowledged);
		const okSignals = state.signals.filter((s) => s.ok);
		const label = $('.label');
		badge.className = 'badge';
		if (unacked.length) {
			badge.classList.add(unacked.some((e) => e.severity === 'critical') ? 'critical' : 'alert');
			label.textContent = `${unacked.length} alert${unacked.length > 1 ? 's' : ''}`;
		} else if (okSignals.length) {
			badge.classList.add('signal');
			label.textContent = `${okSignals.length} signal${okSignals.length > 1 ? 's' : ''} detected`;
		} else label.textContent = state.error ? 'Signal unavailable' : 'Watching';
		// Only on pages a person chose to monitor: shown when the page is watched or has alerts recorded.
		// Elsewhere (e.g. after "Show on page") only the spotlight appears, never a badge.
		// A failed refresh must not make the overlay vanish: once shown on a page it stays until a successful load says otherwise.
		const loaded = (state.watch && state.watch.length > 0) || events.length > 0;
		if (loaded) state.everRelevant = true;
		const relevant = loaded || (state.everRelevant && !!state.error);
		badge.hidden = !relevant;
		if (!relevant) state.open = false;
		badge.setAttribute('aria-expanded', String(state.open));
		panel.hidden = !state.open;

		const watch = $('.watch');
		watch.replaceChildren();
		if (state.watch === undefined) watch.append(el('div', 'empty', 'Checking…'));
		else if (!state.watch || !state.watch.length) watch.append(el('div', 'empty', 'Not watching this page. In the Signal panel, set filters and choose “Alert me when this matches”.'));
		else for (const w of state.watch) {
			const item = el('div', 'item');
			item.append(el('div', 't', w.name));
			item.append(el('div', 'crit', w.criteria.length ? `Alert when an item matches: ${w.criteria.join(' · ')}` : 'Alert when any item of this kind appears'));
			if (w.scope) item.append(el('div', 'meta', `Covers: ${w.scope}`));
			item.append(el('div', 'meta', `Notifies: ${w.notify.join(', ')} · alerts appear here, as a browser notification, and in your Signal inbox`));
			watch.append(item);
		}

		const alerts = $('.alerts');
		alerts.replaceChildren();
		if (state.error) alerts.append(el('div', 'empty', state.error));
		else if (!events.length) alerts.append(el('div', 'empty', 'No alerts recorded for this page.'));
		for (const e of events) {
			const item = el('div', 'item');
			const title = el('div', 't', e.criteriaName);
			title.append(el('span', `sev ${e.severity}`, e.severity));
			item.append(title);
			for (const m of e.matched || []) {
				if (m.op === 'discover' && Array.isArray(m.actual)) {
					item.append(el('div', 'kv', `${m.actual.length} matching item${m.actual.length === 1 ? '' : 's'}`));
					for (const x of m.actual.slice(0, 10)) {
						const row = el('div', 'match', `${x.name || x.key}${x.changed ? ` — changed: ${x.changed.join(', ')}` : ''}`);
						row.append(el('div', 'crit', x.criteria.join(' · ')));
						const go = el('button', 's', 'Show on page');
						go.addEventListener('click', () => {
							row.querySelector('.miss')?.remove();
							if (!showMatch(x)) row.append(el('div', 'miss', 'Not on the page right now: it may be further down a list that has not loaded yet, or the page only describes it in its data (no visible card).'));
						});
						row.append(go);
						if (/^https?:\/\//.test(String(x.key))) { const a = el('a', '', 'Open listing ↗'); a.href = x.key; a.target = '_blank'; a.rel = 'noopener noreferrer'; row.append(a); }
						item.append(row);
					}
					continue;
				}
				const name = (m.path.match(/field\(([^)]+)\)/) || [])[1] || m.op;
				const prev = m.previous !== undefined ? `  (was ${fmt(m.previous)})` : '';
				const what = m.op === 'text' || m.op === 'signal' ? `${m.op} ${fmt(m.expected)}` : `${name} ${m.op} ${fmt(m.expected)}`;
				item.append(el('div', 'kv', `${what} → ${fmt(m.actual)}${prev}`));
			}
			if (!(e.matched || []).some((m) => m.op === 'discover')) for (const x of e.excerpts || []) item.append(el('div', 'ex', x.text));
			item.append(el('div', 'meta', `Observed ${new Date(e.occurredAt).toLocaleString()} · criteria v${e.criteriaVersion} · evidence ${e.evidence.contentHash.slice(0, 12)}…${e.acknowledged ? ' · acknowledged' : ''}`));
			const ev = el('button', 's', 'Evidence');
			ev.addEventListener('click', () => showEvidence(e, item, ev));
			const ack = el('button', 's', e.acknowledged ? 'Acknowledged' : 'Acknowledge');
			ack.disabled = !!e.acknowledged;
			ack.addEventListener('click', () => acknowledge(e));
			const dis = el('button', 's', 'Dismiss');
			dis.addEventListener('click', () => { state.dismissed.add(e.id); render(); });
			item.append(ev, ack, dis);
			alerts.append(item);
		}

		outlineMatches(events);

		const sig = $('.signals');
		sig.replaceChildren();
		if (!state.signals.length) sig.append(el('div', 'empty', 'None found on this page.'));
		state.signals.forEach((s) => {
			const item = el('div', 'item');
			item.append(el('div', 't', s.ok ? `Ghostpost ${s.payload.kind.replace('_', ' ')}` : 'Unreadable embedded payload'));
			item.append(el('div', 'meta', `“${s.context}”`));
			if (!s.ok) item.append(el('div', 'kv', s.error));
			else {
				const btn = el('button', 's', 'Reveal');
				btn.addEventListener('click', () => {
					const p = s.payload;
					const shown = p.kind === 'text' ? p.text : p.kind === 'reference' ? `${p.refType} reference: ${p.refId}` : JSON.stringify(p, null, 1);
					item.append(el('div', 'secret', shown));
					btn.remove();
				});
				item.append(btn);
			}
			sig.append(item);
		});
	}

	// ---------------------------------------------------------------- API
	async function call(op, args) {
		if (typeof cfg.transport !== 'function') throw new Error('no transport');
		return cfg.transport(op, args);
	}
	async function loadEvents() {
		if (typeof cfg.transport !== 'function') return;
		try {
			state.events = await call('events:forPage', { sourceLocator: cfg.locator }); state.error = null;
		} catch (e) { state.error = 'Could not refresh alerts; showing the last ones.'; } // the last known alerts stay
		render();
	}
	async function acknowledge(e) {
		try { await call('events:acknowledge', { eventId: e.id }); e.acknowledged = true; } catch (_) { /* surfaced by unchanged button */ }
		render();
	}
	async function showEvidence(e, item, btn) {
		btn.disabled = true;
		try {
			const r = await call('events:evidence', { eventId: e.id });
			if (r.raw === null) {
				item.append(el('div', 'kv', `Evidence: the page's structure (revision ${String(r.pageRevision || '').slice(0, 12)}…) and visible text, recorded ${new Date(e.occurredAt).toLocaleString()}. The page itself is not stored.`));
				return;
			}
			const t = r.normalizedText;
			const ex = (e.excerpts[0] && e.excerpts[0].text) || '';
			const i = ex ? t.indexOf(ex) : -1;
			const ctx = i >= 0 ? t.slice(Math.max(0, i - 160), i + ex.length + 160) : t.slice(0, 400);
			item.append(el('div', 'kv', `Preserved evidence (sha256 ${e.evidence.contentHash.slice(0, 16)}…${r.verified ? ', hash verified' : ', HASH MISMATCH'}, ${e.provenance.httpStatus || ''} ${e.provenance.finalUrl || ''}):\n…${ctx}…`));
		} catch (_) { item.append(el('div', 'kv', 'Evidence unavailable.')); }
	}

	// ---------------------------------------------------------------- matches on the page
	// Outline the items the latest unacknowledged discovery alert matched, using the locators recorded with it.
	// Only the outline style of those elements is touched, and it is restored when the alert is acknowledged or closed.
	function outlineMatches(events) {
		state.lastEvents = events;
		for (const o of state.outlined) { o.el.style.outline = o.outline; o.el.style.outlineOffset = o.offset; }
		state.outlined = [];
		if (!state.showMatches) return;
		const latest = events.find((e) => !e.acknowledged && (e.matched || []).some((m) => m.op === 'discover'));
		if (!latest) return;
		for (const m of latest.matched.filter((x) => x.op === 'discover' && Array.isArray(x.actual))) {
			for (const x of m.actual) {
				const target = locate(x);
				if (!target) continue;
				state.outlined.push({ el: target, outline: target.style.outline, offset: target.style.outlineOffset });
				target.style.outline = '3px solid #059669';
				target.style.outlineOffset = '2px';
			}
		}
	}

	// Find a match on the live page: by its recorded position, else by its link, else by its name. Pages
	// re-render after a capture, so the recorded position alone is not enough.
	const visible = (e) => !!e && !host.contains(e) && e.getClientRects().length > 0;
	const sameUrl = (a, b) => { try { const x = new URL(a, location.href), y = new URL(b, location.href); return x.origin + x.pathname.replace(/\/$/, '') === y.origin + y.pathname.replace(/\/$/, ''); } catch (_) { return false; } };
	const norm = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
	// Every item the latest alert matched, plus any the panel passed: what a container must NOT also describe.
	const knownItems = (x) => {
		const out = [];
		for (const e of state.lastEvents || []) for (const m of e.matched || []) if (m.op === 'discover' && Array.isArray(m.actual)) out.push(...m.actual);
		for (const o of (x && x.others) || []) out.push(o);
		return out.filter((o) => o && (o.key !== (x && x.key)));
	};
	/** Does this element show this item: a link to it, or its name as text? */
	function describes(e, x) {
		if (/^https?:\/\//.test(String(x.key))) {
			if (e.matches && e.matches('a[href]') && sameUrl(e.href, x.key)) return true;
			for (const a of e.querySelectorAll('a[href]')) if (sameUrl(a.href, x.key)) return true;
		}
		const name = norm(x.name);
		return name.length >= 4 && norm(e.textContent).includes(name);
	}
	/** A container that also shows another matched item is not this item's card. */
	const showsOthers = (e, x) => knownItems(x).some((o) => describes(e, o));
	/** A frame over most of the window is a page region, not a listing. */
	const tooBig = (e) => { const r = e.getBoundingClientRect(); return r.width * r.height > 0.5 * window.innerWidth * window.innerHeight; };
	const acceptable = (e, x) => visible(e) && describes(e, x) && !showsOthers(e, x) && !tooBig(e);
	/** The largest ancestor (a few levels up) that still shows only this item. */
	function cardOf(e, x) {
		let best = e;
		for (let n = e, i = 0; n && n.parentElement && n.parentElement !== document.body && i < 8; i++) {
			n = n.parentElement;
			if (!visible(n) || showsOthers(n, x) || tooBig(n)) break;
			best = n;
		}
		return best;
	}
	// A recorded position is trusted only when what it finds really shows this item: after a re-render the same
	// selector can point at a different listing, or at a page region.
	function locate(x) {
		for (const loc of x.locators || []) {
			let t = null;
			try { t = document.querySelector(loc); } catch (_) { t = null; }
			if (t && acceptable(t, x)) return t;
		}
		if (/^https?:\/\//.test(String(x.key))) for (const a of document.querySelectorAll('a[href]')) if (visible(a) && sameUrl(a.href, x.key)) return cardOf(a, x);
		const name = norm(x.name);
		if (name.length >= 4) for (const e of document.querySelectorAll('address, h1, h2, h3, h4, h5, a, span, p, div')) {
			if (e.childElementCount <= 3 && visible(e) && norm(e.textContent) === name) return cardOf(e, x);
		}
		return null;
	}

	// Spotlight: scroll the item into view and frame it, with why it matched; the frame follows scrolling.
	const spot = el('div', 'spot'); const spotLabel = el('div', 'spot-label');
	let spotTarget = null, spotTimer = null;
	function placeSpot() {
		if (!spotTarget) return;
		const r = spotTarget.getBoundingClientRect();
		Object.assign(spot.style, { top: `${r.top - 6}px`, left: `${r.left - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 12}px` });
		const above = r.top > 40;
		Object.assign(spotLabel.style, { top: `${above ? r.top - 34 : r.bottom + 10}px`, left: `${Math.max(8, r.left - 6)}px` });
	}
	function clearSpot() { spotTarget = null; spot.remove(); spotLabel.remove(); }
	function showMatch(x) {
		const target = locate(x);
		if (!target) return false;
		spotTarget = target;
		spotLabel.textContent = `Signal match: ${(x.criteria || []).join(' · ') || x.name || ''}`;
		root.append(spot, spotLabel);
		spot.style.animation = 'none'; void spot.offsetWidth; spot.style.animation = '';
		target.scrollIntoView({ block: 'center', behavior: 'smooth' });
		placeSpot();
		let frames = 0; const follow = () => { placeSpot(); if (spotTarget && frames++ < 60) requestAnimationFrame(follow); }; requestAnimationFrame(follow);
		clearTimeout(spotTimer); spotTimer = setTimeout(clearSpot, 10000);
		return true;
	}
	window.addEventListener('scroll', placeSpot, { capture: true, passive: true });
	window.addEventListener('resize', placeSpot, { passive: true });

	async function loadWatch() {
		try { state.watch = await call('watch:forPage', {}); } catch (_) { if (state.watch === undefined) state.watch = null; state.error = state.error || 'Could not refresh.'; } // keep what was known
		render();
	}

	// ---------------------------------------------------------------- local decoding
	let codec = null;
	async function loadCodec() {
		if (codec || !cfg.codecBase) return codec;
		const base = cfg.codecBase.replace(/\/$/, '');
		const mod = await import(base + '/ghostpost_unicode_codec.js');
		await mod.default({ module_or_path: base + '/ghostpost_unicode_codec_bg.wasm' });
		return (codec = mod);
	}
	function collectBlocks(rootNode, out) {
		const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
		for (let n = walker.currentNode; n; n = walker.nextNode()) {
			if (n.nodeType === 1 && n.shadowRoot && n !== host) collectBlocks(n.shadowRoot, out);
			if (n.nodeType === 3 && n.data.includes('﻿')) {
				// Platforms split envelopes across nodes (Ghostpost XCOM_* notes): read the nearest block.
				let b = n.parentElement;
				while (b && b.parentElement && getComputedStyle(b).display === 'inline') b = b.parentElement;
				if (b && b !== host && !out.includes(b)) out.push(b);
			}
		}
		return out;
	}
	let scanTimer = null, outlineTimer = null;
	async function scan() {
		const blocks = collectBlocks(document.body, []);
		if (!blocks.length) { if (state.signals.length) { state.signals = []; render(); } return; }
		try { await loadCodec(); } catch (_) { return; }
		const found = [];
		for (const b of blocks) {
			const text = b.textContent || '';
			for (const env of JSON.parse(codec.inspect(text))) {
				const visible = text.replace(/[​-‏‪-‮⁠-⁤﻿]/g, '').trim();
				found.push({ ok: env.ok, payload: env.payload, error: env.error, context: visible.slice(0, 80) });
			}
		}
		state.signals = found;
		render();
	}
	const observer = new MutationObserver((muts) => {
		if (muts.every((m) => host.contains(m.target) || m.target === host)) return;
		clearTimeout(scanTimer);
		scanTimer = setTimeout(scan, 400);
		// Pages re-render their listings (a moved map, new filters): put the outlines back on the new elements.
		clearTimeout(outlineTimer);
		outlineTimer = setTimeout(() => outlineMatches(state.lastEvents.length ? state.lastEvents : state.events.filter((e) => !state.dismissed.has(e.id))), 500);
	});

	// One overlay per page. An overlay left by an earlier extension load lives in another script world, so the
	// window guard cannot see it: tell it to stop (DOM events cross worlds), remove its element, then take over.
	function retire() {
		observer.disconnect();
		clearTimeout(scanTimer); clearTimeout(spotTimer); clearTimeout(outlineTimer);
		for (const o of state.outlined) { o.el.style.outline = o.outline; o.el.style.outlineOffset = o.offset; }
		state.outlined = [];
		clearSpot();
		host.remove();
		if (window.__signalOverlay === api) window.__signalOverlay = undefined; // the next "show" injects afresh
	}
	document.addEventListener('signal-overlay:replace', (ev) => { if (ev.detail !== instance) retire(); });
	function start() {
		document.dispatchEvent(new CustomEvent('signal-overlay:replace', { detail: instance }));
		document.querySelectorAll('[data-signal-overlay]').forEach((n) => { if (n !== host) n.remove(); });
		document.documentElement.appendChild(host);
		render();
		loadEvents();
		loadWatch();
		scan();
		observer.observe(document.body, { childList: true, subtree: true, characterData: true });
	}
	// Only a refresh hook is exposed; alert data is not reachable from page scripts.
	// Reachable only from this extension's isolated world (the panel), not from page scripts.
	const api = { refresh: () => Promise.all([loadEvents(), loadWatch(), scan()]), show: (x) => showMatch(x) };
	window.__signalOverlay = api;
	if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
