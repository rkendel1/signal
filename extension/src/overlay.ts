/**
 * Signal's ambient overlay: a content script on sites the person enabled.
 *
 * Recovered from the previous overlay: badge → panel, a closed shadow root, text-only rendering (nothing from a
 * page or a finding is ever parsed as HTML), and no credentials in the page: every operation goes to the
 * extension's service worker over a port, which allows a fixed list of them. New here: it reads the same durable
 * findings, notices and site knowledge as the web app (ambient:context), stays alive across client-side routing and
 * page redraws, updates live while visible, and lets the person act (acknowledge, snooze, dismiss, connect a feed,
 * capture) without leaving the page.
 */
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
declare global { interface Window { __signalAmbient?: boolean } }
/** 'closed' in every real build; the e2e build sets 'open' so automation can reach inside (scripts/build-extension.ts). */
declare const __SHADOW_MODE__: 'open' | 'closed';

(() => {
	if (window.__signalAmbient) return;
	window.__signalAmbient = true;

	// ------------------------------------------------------------------ transport (service worker, allow-listed ops)
	let port: chrome.runtime.Port | null = null;
	let seq = 0;
	const waiting = new Map<number, { ok: (v: Any) => void; fail: (e: Error) => void }>();
	const connectPort = () => {
		try { port = chrome.runtime.connect({ name: 'signal.overlay' }); } catch { port = null; return; } // extension reloaded: this page's copy is orphaned
		port.onMessage.addListener((m: Any) => {
			if (m?.type === 'changed') { scheduleRefresh(150); return; }
			const w = waiting.get(m?.id); if (!w) return; waiting.delete(m.id);
			if (m.ok) w.ok(m.value); else w.fail(new Error(m.error ?? 'failed'));
		});
		port.onDisconnect.addListener(() => { port = null; for (const w of waiting.values()) w.fail(new Error('Signal reconnecting')); waiting.clear(); setTimeout(connectPort, 1000); });
	};
	const call = (op: string, args: Record<string, unknown> = {}): Promise<Any> => new Promise((ok, fail) => {
		if (!port) connectPort();
		if (!port) return fail(new Error('Signal is not available (extension reloaded: refresh the page)'));
		const id = ++seq; waiting.set(id, { ok, fail });
		port.postMessage({ id, op, args });
		setTimeout(() => { if (waiting.delete(id)) fail(new Error('Signal did not answer')); }, 60_000);
	});
	connectPort();

	// ------------------------------------------------------------------ shell (closed shadow root, re-attached after redraws)
	const host = document.createElement('signal-ambient');
	host.setAttribute('data-signal-ambient', '');
	const root = host.attachShadow({ mode: typeof __SHADOW_MODE__ === 'string' ? __SHADOW_MODE__ : 'closed' });
	const style = document.createElement('style');
	style.textContent = `
		:host{all:initial}
		*{box-sizing:border-box}
		.badge{position:fixed;right:16px;bottom:16px;z-index:2147483646;display:flex;align-items:center;gap:6px;padding:7px 12px;border-radius:999px;border:0;cursor:pointer;
			font:600 12px/1 system-ui,-apple-system,Segoe UI,sans-serif;color:#fff;background:#4b5563;box-shadow:0 4px 14px rgba(0,0,0,.25);opacity:.92}
		.badge.quiet{padding:7px;opacity:.55}.badge.quiet .lbl{display:none}.badge:hover{opacity:1}
		.badge.context{background:#2457d6}.badge.warn{background:#b45309}.badge.critical{background:#b91c1c}
		.dot{width:8px;height:8px;border-radius:50%;background:#fff}
		.panel{position:fixed;right:16px;bottom:60px;z-index:2147483647;width:min(420px,calc(100vw - 32px));max-height:min(78vh,720px);overflow:auto;background:#fff;color:#111827;
			border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.3);font:13px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
		.panel[hidden]{display:none}
		header{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid #e5e7eb;position:sticky;top:0;background:#fff}
		header b{font-size:14px} .tabs{display:flex;gap:2px;padding:6px 8px;border-bottom:1px solid #e5e7eb}
		.tabs button{border:0;background:none;padding:5px 8px;border-radius:6px;cursor:pointer;font:inherit;color:#374151}.tabs button.on{background:#e8eefc;color:#2457d6;font-weight:600}
		section{padding:8px 12px}
		h4{margin:10px 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280}
		.item{border:1px solid #e5e7eb;border-radius:8px;padding:8px;margin:6px 0;cursor:default}
		.item.click{cursor:pointer}.item.click:hover{border-color:#2457d6}
		.t{font-weight:600}.m{color:#6b7280;font-size:12px}.err{color:#b91c1c;font-size:12px}
		.b{display:inline-block;font-size:11px;padding:1px 6px;border-radius:9px;background:#eef0f3;margin-right:4px}
		.b.match,.b.new,.b.reopened,.b.verified,.b.production{background:#e3f4ea;color:#1d7a46}.b.possible,.b.discovered{background:#e8eefc;color:#2457d6}
		.b.changed,.b.warn,.b.warning,.b.needs_reanalysis{background:#fdf1dc;color:#9a5b00}.b.critical,.b.broken,.b.disallowed{background:#fde8e6;color:#b42318}
		button.s{font:inherit;font-size:12px;margin:6px 6px 0 0;padding:3px 9px;border:1px solid #d1d5db;border-radius:6px;background:#fff;color:#111827;cursor:pointer}
		button.s.p{background:#2457d6;border-color:#2457d6;color:#fff} button.s:disabled{opacity:.5}
		button.x{border:0;background:none;font-size:16px;cursor:pointer;color:#6b7280}
		.tri{display:inline-block;width:16px;text-align:center;font-weight:700}.tri.true{color:#1d7a46}.tri.false{color:#b42318}.tri.unknown{color:#9a5b00}
		.v{font-size:12px;color:#374151;margin-left:20px}
		input.r{width:100%;font:inherit;padding:4px 6px;border:1px solid #d1d5db;border-radius:6px;margin-top:6px}
		a{color:#2457d6}
		@media (prefers-color-scheme: dark){.panel,header{background:#191d23;color:#e6e9ee}.item{border-color:#2a3038}header,.tabs{border-color:#2a3038}.tabs button{color:#c9d1d9}
			button.s{background:#191d23;color:#e6e9ee;border-color:#3a414b}.m{color:#98a3b1}.b{background:#2a3038;color:#e6e9ee}.v{color:#c9d1d9}}`;
	const badge = document.createElement('button');
	badge.className = 'badge quiet'; badge.setAttribute('aria-label', 'Signal');
	const panel = document.createElement('div');
	panel.className = 'panel'; panel.hidden = true; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Signal');
	root.append(style, badge, panel);
	const attach = () => { if (!host.isConnected) document.documentElement.appendChild(host); };
	attach();
	// Pages that replace <body> or rebuild the document keep the overlay: it lives on <html> and re-attaches.
	new MutationObserver(attach).observe(document.documentElement, { childList: true });

	// ------------------------------------------------------------------ tiny DOM helpers (text only)
	const el = (tag: string, cls = '', ...kids: Array<Node | string | null | false | undefined>) => {
		const e = document.createElement(tag); if (cls) e.className = cls;
		for (const k of kids) if (k !== null && k !== false && k !== undefined) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
		return e;
	};
	const btn = (label: string, run: () => Promise<unknown> | void, primary = false) => {
		const b = el('button', `s${primary ? ' p' : ''}`, label) as HTMLButtonElement;
		b.onclick = async (e) => { e.stopPropagation(); b.disabled = true; try { await run(); } catch (x) { flash((x as Error).message, true); } finally { b.disabled = false; } };
		return b;
	};
	const fmt = (v: unknown): string => (v === null || v === undefined ? '—' : typeof v === 'object' && v && 'amount' in (v as object) ? String((v as { amount: number }).amount) : typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 80));
	const ago = (iso: string | null) => { if (!iso) return '—'; const s = (Date.now() - Date.parse(iso)) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
	let flashMsg: { text: string; error: boolean } | null = null;
	const flash = (text: string, error = false) => { flashMsg = { text, error }; host.setAttribute('data-last-message', `${error ? 'error: ' : ''}${text}`.slice(0, 300)); render(); setTimeout(() => { flashMsg = null; render(); }, error ? 7000 : 3500); };

	// ------------------------------------------------------------------ state
	type View = { kind: 'home' } | { kind: 'finding'; id: string; data?: Any } | { kind: 'site' } | { kind: 'analysis'; data: Any };
	const state: { url: string; ctx: Any | null; error: string | null; tab: 'page' | 'notices' | 'monitor'; view: View; loading: boolean } = { url: location.href, ctx: null, error: null, tab: 'page', view: { kind: 'home' }, loading: false };
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	const scheduleRefresh = (ms = 0) => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, ms); };
	async function refresh() {
		if (document.visibilityState === 'hidden') return;
		state.url = location.href;
		try {
			const t0 = performance.now();
			state.ctx = await call('context', { url: state.url });
			state.error = null;
			(window as unknown as { __signalLastContextMs?: number }).__signalLastContextMs = Math.round(performance.now() - t0); // read by the e2e test via the DOM attribute below
			host.setAttribute('data-context-ms', String(Math.round(performance.now() - t0)));
			if (state.view.kind === 'finding') state.view.data = await call('finding', { findingId: state.view.id }).catch(() => state.view.kind === 'finding' ? state.view.data : undefined);
		} catch (e) { state.error = (e as Error).message; }
		render();
	}

	// Client-side routing changes the address without a page load; content scripts cannot see pushState, so watch it.
	setInterval(() => { if (location.href !== state.url) { if (state.view.kind !== 'finding') state.view = { kind: 'home' }; scheduleRefresh(300); } }, 800);
	document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleRefresh(); });
	// While visible, keep the service worker (and its live change stream) awake.
	setInterval(() => { if (document.visibilityState === 'visible') call('ping').catch(() => undefined); }, 20_000);

	// ------------------------------------------------------------------ rendering
	function renderBadge() {
		const c = state.ctx;
		const openHere = c ? c.findings.filter((f: Any) => f.status === 'open' && !f.snoozedUntil).length : 0;
		const onSite = c ? c.siteFindings.length : 0;
		const active = c ? c.notices.active : 0;
		const critical = c ? c.notices.items.some((n: Any) => n.severity === 'critical') : false;
		badge.replaceChildren(el('span', 'dot'), el('span', 'lbl', openHere ? `${openHere} here` : active ? `${active} new` : onSite ? `${onSite} on this site` : state.error ? 'Signal offline' : 'Signal'));
		badge.className = `badge ${openHere ? 'context' : critical ? 'critical' : active ? 'warn' : onSite ? 'context' : 'quiet'}`;
		badge.title = state.error ?? `${openHere} findings about this page · ${onSite} on this site · ${active} unread notifications`;
		host.setAttribute('data-here', String(openHere)); host.setAttribute('data-site', String(onSite)); host.setAttribute('data-active', String(active));
	}
	badge.onclick = () => { panel.hidden = !panel.hidden; if (!panel.hidden) scheduleRefresh(); render(); };

	function render() {
		renderBadge();
		if (panel.hidden) return;
		const c = state.ctx;
		const close = el('button', 'x', '×'); close.onclick = () => { panel.hidden = true; render(); }; close.setAttribute('aria-label', 'Close');
		const head = el('header', '', el('b', '', 'Signal'), el('span', 'm', c?.site?.known ? c.site.domain : new URL(state.url).hostname), close);
		const tabs = el('div', 'tabs', ...(['page', 'notices', 'monitor'] as const).map((t) => { const b = el('button', state.tab === t && state.view.kind === 'home' ? 'on' : '', { page: 'This page', notices: `Notifications${c?.notices.active ? ` (${c.notices.active})` : ''}`, monitor: 'Monitoring' }[t]); b.onclick = () => { state.tab = t; state.view = { kind: 'home' }; render(); }; return b; }));
		const body = el('section');
		if (flashMsg) body.append(el('p', flashMsg.error ? 'err' : 'm', flashMsg.text));
		if (state.error && !c) body.append(el('p', 'err', state.error));
		else if (!c) body.append(el('p', 'm', 'Loading…'));
		else if (state.view.kind === 'finding') renderFinding(body, state.view);
		else if (state.view.kind === 'site') renderSite(body, c);
		else if (state.view.kind === 'analysis') renderAnalysis(body, state.view.data);
		else if (state.tab === 'page') renderPage(body, c);
		else if (state.tab === 'notices') renderNotices(body, c);
		else renderMonitor(body, c);
		panel.replaceChildren(head, tabs, body);
	}

	const findingItem = (f: Any) => {
		const it = el('div', 'item click', el('div', 't', f.entityLabel ?? 'Finding'), el('div', '', el('span', `b ${f.qualification}`, f.qualification), el('span', `b ${f.change}`, f.status === 'open' ? f.change : f.status), f.snoozedUntil ? el('span', 'b', 'snoozed') : null), el('div', '', f.summary), el('div', 'm', `${f.criteriaName} · changed ${ago(f.lastChangedAt)}`));
		it.onclick = () => openFinding(f.id);
		return it;
	};
	async function openFinding(id: string) { state.view = { kind: 'finding', id }; render(); try { const data = await call('finding', { findingId: id }); if (state.view.kind === 'finding' && state.view.id === id) { state.view.data = data; render(); } } catch (e) { flash((e as Error).message, true); } }

	function renderPage(body: HTMLElement, c: Any) {
		const here = c.findings;
		body.append(el('h4', '', 'About this page'));
		if (here.length) here.forEach((f: Any) => body.append(findingItem(f)));
		else body.append(el('p', 'm', c.entities ? `Signal has ${c.entities} item(s) from this page; none is part of a finding.` : 'Nothing Signal tracks is about this page.'));
		if (c.siteFindings.length) { body.append(el('h4', '', 'On this site')); c.siteFindings.slice(0, 8).forEach((f: Any) => body.append(findingItem(f))); }
		body.append(el('h4', '', 'This site'));
		const s = c.site;
		if (s?.known) {
			const usable = s.feeds.filter((f: Any) => ['feed', 'detail'].includes(f.verdict) && f.access.automatable);
			const it = el('div', 'item click', el('div', 't', s.domain), el('div', 'm', `${s.feeds.length} known information source(s), ${usable.length} usable feed(s) · ${s.analyses} analyses`),
				...s.feeds.slice(0, 3).map((f: Any) => el('div', '', el('span', `b ${f.status}`, f.status), `${f.label} `, el('span', 'm', `(${f.verdict}${s.pageFeeds.includes(f.id) ? ', used by this page' : ''})`))));
			it.onclick = () => { state.view = { kind: 'site' }; render(); };
			body.append(it);
		} else body.append(el('p', 'm', 'Signal has not analyzed this site yet.'));
		body.append(btn('Understand this site', analyze, !s?.known));
		if (c.captureSources.length) body.append(btn(`Capture this page → ${c.captureSources[0].name}`, async () => { const r = await call('capture', { sourceId: c.captureSources[0].id }); flash(`${r.received} items read: ${r.added} new, ${r.changed} changed`); scheduleRefresh(); }));
		body.append(btn('Open Signal', () => call('open', { path: '/findings' })));
	}

	function renderNotices(body: HTMLElement, c: Any) {
		if (!c.notices.items.length) { body.append(el('p', 'm', 'No unread notifications.')); return; }
		body.append(btn('Acknowledge all', async () => { await call('ackAllNotices'); scheduleRefresh(); }));
		for (const n of c.notices.items) {
			const it = el('div', `item${n.findingId ? ' click' : ''}`, el('div', 't', n.title), el('div', '', el('span', `b ${n.severity}`, n.severity), n.contextual ? el('span', 'b match', 'this page') : null, el('span', 'm', ago(n.createdAt))), el('div', 'm', n.body),
				el('div', '', btn('Acknowledge', async () => { await call('ackNotice', { noticeId: n.id }); scheduleRefresh(); }), btn('Snooze 4 h', async () => { await call('snoozeNotice', { noticeId: n.id, hours: 4 }); scheduleRefresh(); })));
			if (n.findingId) it.onclick = () => openFinding(n.findingId);
			body.append(it);
		}
	}

	function renderMonitor(body: HTMLElement, c: Any) {
		body.append(el('h4', '', 'Your sources on this site'));
		if (!c.sources.length) body.append(el('p', 'm', 'None. Connect a feed from “This site”, or capture pages.'));
		for (const s of c.sources) body.append(el('div', 'item', el('div', 't', s.name), el('div', '', el('span', `b ${s.status === 'connected' ? 'verified' : 'warn'}`, s.status), el('span', 'm', `${s.records} records · ${s.acquisition ?? s.kind} · last success ${ago(s.lastSuccessAt)}${s.nextRefreshAt ? ` · next ${new Date(s.nextRefreshAt).toLocaleTimeString()}` : ''}`)), s.statusReason ? el('div', 'err', s.statusReason) : null, el('div', 'm', s.refresh),
			s.kind === 'site_feed' ? btn('Refresh now', async () => { const r = await call('refresh', { sourceId: s.id }); flash(r?.status === 'not_modified' ? 'Not modified' : `${r?.added ?? 0} new, ${r?.changed ?? 0} changed`); scheduleRefresh(); }) : null));
		body.append(el('h4', '', 'Criteria watching them'));
		if (!c.watching.length) body.append(el('p', 'm', 'None. Define criteria in Signal.'));
		for (const w of c.watching) body.append(el('div', 'item', el('div', 't', w.name), el('div', 'm', `v${w.version} · ${w.enabled ? 'monitoring' : 'paused'}`), btn(w.enabled ? 'Pause' : 'Resume', async () => { await call('setCriteria', { criteriaId: w.id, enabled: !w.enabled }); scheduleRefresh(); }), btn('Edit in Signal', () => call('open', { path: `/criteria/${w.id}` }))));
		body.append(btn('Hide Signal on this site', () => call('disableSite')));
	}

	function renderFinding(body: HTMLElement, v: { id: string; data?: Any }) {
		const back = el('a', '', '← back'); back.setAttribute('href', '#'); back.onclick = (e) => { e.preventDefault(); state.view = { kind: 'home' }; render(); };
		body.append(back);
		const d = v.data;
		if (!d) { body.append(el('p', 'm', 'Loading…')); return; }
		const f = d.finding, x = d.explanation;
		body.append(el('div', 't', d.entity?.label ?? 'Finding'), el('div', '', el('span', `b ${f.qualification}`, f.qualification), el('span', `b ${f.change}`, f.status === 'open' ? f.change : f.status), f.synthetic ? el('span', 'b', 'synthetic') : null),
			el('p', '', f.summary), el('div', 'm', `“${d.criteria.name}” v${f.criteriaVersion} · confidence ${Math.round(f.confidence * 100)}% · changed ${ago(f.lastChangedAt)}`));
		const reason = el('input', 'r') as HTMLInputElement; reason.placeholder = 'Why is this not relevant?';
		body.append(btn(f.acknowledgedAt ? 'Un-acknowledge' : 'Acknowledge', async () => { await call('ackFinding', { findingId: v.id, acknowledged: !f.acknowledgedAt }); await openFinding(v.id); }),
			btn(f.snoozedUntil ? 'Unsnooze' : 'Snooze 24 h', async () => { await call('snoozeFinding', { findingId: v.id, hours: f.snoozedUntil ? 0 : 24 }); await openFinding(v.id); scheduleRefresh(); }),
			btn('Open in Signal', () => call('open', { path: `/findings/${v.id}` }), true));
		body.append(el('h4', '', 'Why'));
		const leaves = (n: Any): Any[] => (n.kind === 'leaf' ? [n] : n.children.flatMap(leaves));
		for (const n of [...x.require, ...x.exclude].flatMap(leaves)) {
			body.append(el('div', '', el('span', `tri ${n.result}`, n.result === 'true' ? '✓' : n.result === 'false' ? '✗' : '?'), n.text));
			for (const val of n.leaf.values.slice(0, 3)) body.append(el('div', 'v', `${fmt(val.value)} — ${val.sourceName}${val.stale ? ' (stale)' : ''}${val.link === 'probable' ? ' (probable match)' : ''}`));
			if (n.leaf.note) body.append(el('div', 'v m', n.leaf.note));
		}
		body.append(el('h4', '', 'Evidence'));
		for (const o of d.evidence.slice(0, 8)) body.append(el('div', 'v', `${o.source.name} · ${o.recordKey} v${o.version} (${o.status}) · observed ${ago(o.observedAt)}${o.source.status !== 'connected' ? ` · source ${o.source.status}` : ''}`));
		body.append(el('h4', '', 'History'));
		for (const e of [...d.history].reverse().slice(0, 8)) body.append(el('div', 'v', `${e.kind} · ${ago(e.at)} · ${e.cause?.label ?? ''}`));
		body.append(el('h4', '', 'Not relevant?'), reason, btn('Dismiss (kept with its reason)', async () => { if (!reason.value.trim()) throw new Error('Say why.'); await call('dismissFinding', { findingId: v.id, reason: reason.value }); state.view = { kind: 'home' }; scheduleRefresh(); }));
	}

	let confirming: string | null = null;
	/** Connecting is explicit: an inline review of what will happen, the entity type, then a confirming click. */
	function connectButton(f: Any) {
		if (!['feed', 'detail'].includes(f.verdict) || !f.access.automatable || ['deprecated', 'broken'].includes(f.status) || f.connections.length) return null;
		const how = f.access.auth === 'public' ? `Signal's server will fetch it about every ${Math.max(1, Math.ceil((f.change.maxAgeSeconds ?? 300) / 60))} min` : 'your browser will fetch it with your own session, about every minute while the browser is open';
		if (confirming !== f.id) return btn('Connect…', () => { confirming = f.id; render(); });
		const generic = ['results', 'items', 'data', 'records', 'features', 'hits', 'list', 'rows', 'entries', 'payload'];
		const type = el('input', 'r') as HTMLInputElement;
		type.value = f.entityHint && !generic.includes(f.entityHint) ? f.entityHint.replace(/s$/, '') : 'record';
		type.setAttribute('aria-label', 'Each record describes a');
		return el('div', 'item', el('div', 't', 'Connect this feed?'), el('div', 'm', `${how}. Its records become observations evaluated by your criteria. Nothing else is enabled, and nothing about your session is shared.`),
			el('div', 'm', 'Each record describes a… (the word your criteria use: listing, property, earthquake…)'), type,
			btn('Connect', async () => {
				const r = await call('connect', { feedId: f.id, entityType: type.value.trim() || 'record' });
				confirming = null;
				flash(`Connected (${r.acquisition}). First acquisition: ${r.first?.status ?? 'scheduled'}${r.first?.added !== undefined ? `, ${r.first.added} records` : ''}`); scheduleRefresh();
			}, true), btn('Cancel', () => { confirming = null; render(); }));
	}

	function renderSite(body: HTMLElement, c: Any) {
		const back = el('a', '', '← back'); back.setAttribute('href', '#'); back.onclick = (e) => { e.preventDefault(); state.view = { kind: 'home' }; render(); };
		const s = c.site;
		body.append(back, el('div', 't', s.domain), el('div', 'm', `Shared knowledge from ${s.analyses} analyses. Definitions describe structure only; connecting uses your own access.`));
		for (const f of s.feeds) {
			body.append(el('div', 'item', el('div', 't', f.label), el('div', '', el('span', `b ${f.status}`, f.status), el('span', 'b', f.verdict), el('span', 'b', `score ${f.score}`), f.access.robots === 'disallowed' ? el('span', 'b disallowed', 'robots: disallowed') : null),
				el('div', 'm', `${f.kind.replace('_', ' ')} · ${f.fields} fields · id: ${f.identifier?.path ?? 'none'} · access: ${f.access.auth}`),
				el('div', 'm', `changes: ${[f.change.conditional && `conditional GET (${f.change.conditional})`, f.change.recordUpdatedField && `per-record ${f.change.recordUpdatedField}`].filter(Boolean).join(', ') || 'none observed'} · ${f.completeness}`),
				f.limitations.length ? el('div', 'm', `Limits: ${f.limitations.join('; ')}`) : null,
				f.connections.length ? el('div', 'm', `Connected: ${f.connections.map((x: Any) => x.name).join(', ')}`) : null,
				connectButton(f)));
		}
		body.append(btn('Analyze this page again', analyze));
	}

	function renderAnalysis(body: HTMLElement, a: Any) {
		const back = el('a', '', '← back'); back.setAttribute('href', '#'); back.onclick = (e) => { e.preventDefault(); state.view = { kind: 'home' }; scheduleRefresh(); };
		body.append(back, el('div', 't', `What Signal found on ${a.site.domain}`), el('div', 'm', `${a.candidates.length} candidate source(s) in ${a.durationMs} ms. Structured feeds are preferred over page content.`));
		for (const c of a.candidates.slice(0, 10)) {
			body.append(el('div', 'item', el('div', 't', c.label), el('div', '', el('span', `b ${c.verdict === 'feed' || c.verdict === 'detail' ? 'verified' : c.verdict === 'disallowed' ? 'disallowed' : ''}`, c.verdict), el('span', 'b', c.kind.replace('_', ' ')), el('span', 'b', `score ${c.score}`), c.contribution?.status ? el('span', `b ${c.contribution.status}`, `catalog: ${c.contribution.status}`) : null),
				el('div', 'm', c.why.join('; ')), c.limitations.length ? el('div', 'm', c.limitations.join('; ')) : null,
				c.contribution?.reason ? el('div', 'm', `Not shared: ${c.contribution.reason}`) : null,
				!c.contribution?.feedId && ['feed', 'detail'].includes(c.verdict) && c.access.auth !== 'public' ? btn('Share its structure (no data, no session)', async () => { const r = await call('contribute', { analysisId: a.analysisId, candidateKey: c.key }); flash(`Shared as ${r.outcome}`); }) : null));
		}
	}

	async function analyze() {
		flash('Reading what this page loaded (only requests it already made)…');
		const a = await call('analyze');
		host.setAttribute('data-analysis-ms', String(a.totalMs ?? ''));
		state.view = { kind: 'analysis', data: a }; panel.hidden = false; render();
	}

	refresh();
})();
export {};
