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
	const state = { events: [], signals: [], open: false, dismissed: new Set(), error: null, monitoring: true, watch: undefined, outlined: [], showMatches: true };

	// ---------------------------------------------------------------- UI shell
	const host = document.createElement('div');
	host.setAttribute('data-signal-overlay', '');
	const root = host.attachShadow({ mode: 'closed' });
	root.innerHTML = `<style>
		:host{all:initial}
		.badge{position:fixed;right:16px;bottom:16px;z-index:2147483646;display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:999px;border:0;
			font:600 13px/1 system-ui,-apple-system,Segoe UI,sans-serif;color:#fff;background:#4b5563;box-shadow:0 4px 16px rgba(0,0,0,.25);cursor:pointer}
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
		} else label.textContent = state.error ? 'Signal unavailable' : 'Monitoring';
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
		} catch (e) { state.error = 'Could not load alerts.'; }
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
		for (const o of state.outlined) { o.el.style.outline = o.outline; o.el.style.outlineOffset = o.offset; }
		state.outlined = [];
		if (!state.showMatches) return;
		const latest = events.find((e) => !e.acknowledged && (e.matched || []).some((m) => m.op === 'discover'));
		if (!latest) return;
		for (const m of latest.matched.filter((x) => x.op === 'discover' && Array.isArray(x.actual))) {
			for (const x of m.actual) {
				for (const loc of x.locators || []) {
					let target = null;
					try { target = document.querySelector(loc); } catch (_) { target = null; }
					if (!target || target === host || host.contains(target) || !target.getClientRects().length) continue; // only what is visible
					state.outlined.push({ el: target, outline: target.style.outline, offset: target.style.outlineOffset });
					target.style.outline = '3px solid #059669';
					target.style.outlineOffset = '2px';
					break; // one outline per item: its record element
				}
			}
		}
	}
	async function loadWatch() {
		try { state.watch = await call('watch:forPage', {}); } catch (_) { state.watch = null; }
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
	let scanTimer = null;
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
	});

	function start() {
		document.documentElement.appendChild(host);
		render();
		loadEvents();
		loadWatch();
		scan();
		observer.observe(document.body, { childList: true, subtree: true, characterData: true });
	}
	// Only a refresh hook is exposed; alert data is not reachable from page scripts.
	window.__signalOverlay = { refresh: () => Promise.all([loadEvents(), loadWatch(), scan()]) };
	if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
