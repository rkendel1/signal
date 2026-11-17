/**
 * The extension's service worker: Signal's ambient runtime in the browser.
 *
 *  - Holds the session (extension storage, trusted contexts only). Overlays never see it: they send one of a
 *    fixed list of operations over a port, and this worker calls Signal as the person.
 *  - Pushes "something changed" to open overlays from FeltKit's change stream, while an overlay keeps it awake.
 *  - Every minute (chrome.alarms), while the browser runs: refreshes due feeds — server-acquired ones by asking
 *    Signal to fetch, browser-acquired ones by fetching here with the person's own session — and shows new
 *    notices as browser notifications (each once).
 *
 * Not possible here, and not claimed: delivery while the browser is closed (no server push channel exists in the
 * platform: GAP_REGISTER G-NOTIFY-2), and background polling when Chrome is not running.
 */
import { createClient, type FeltKitClient } from '@feltdb/feltkit/client';
import { api } from '../../feltkit/_generated/api.ts';
import { collectSiteEvidence } from '../../lib/site/collect.ts';
import { chromeTokenStore, errorText, pageLocator, savedInstance, snapshotTab } from './host.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const K = { sites: 'signal.sites', tick: 'signal.tickMinutes' } as const;
const SCRIPT_ID = 'signal-ambient';

const setup = async () => {
	await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined);
	await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
	const minutes = (await chrome.storage.local.get(K.tick))[K.tick] ?? 1;
	await chrome.alarms.create('signal.tick', { periodInMinutes: minutes });
	await syncContentScripts();
};
chrome.runtime.onInstalled.addListener(() => void setup());
chrome.runtime.onStartup.addListener(() => void setup());
void setup();

let cached: { origin: string; client: FeltKitClient } | null = null;
async function client(): Promise<{ origin: string; client: FeltKitClient } | null> {
	const origin = await savedInstance();
	if (!origin || !(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) return null;
	if (cached?.origin !== origin) cached = { origin, client: createClient({ url: origin, session: 'bearer', tokens: await chromeTokenStore() }) };
	return cached;
}

// ------------------------------------------------------------------ sites where the overlay runs (the person's choice)

export async function enabledSites(): Promise<string[]> { return (await chrome.storage.local.get(K.sites))[K.sites] ?? []; }
async function syncContentScripts() {
	const sites = (await enabledSites()).filter(Boolean);
	const granted: string[] = [];
	for (const o of sites) if (await chrome.permissions.contains({ origins: [`${o}/*`] })) granted.push(`${o}/*`);
	await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }).catch(() => undefined);
	if (granted.length) await chrome.scripting.registerContentScripts([{ id: SCRIPT_ID, matches: granted, js: ['overlay.js'], runAt: 'document_idle', persistAcrossSessions: true }]);
}
async function setSite(origin: string, on: boolean, tabId?: number) {
	const cur = await enabledSites();
	await chrome.storage.local.set({ [K.sites]: on ? [...new Set([...cur, origin])] : cur.filter((x) => x !== origin) });
	await syncContentScripts();
	if (on && tabId !== undefined) await chrome.scripting.executeScript({ target: { tabId }, files: ['overlay.js'] }).catch(() => undefined);
}

// ------------------------------------------------------------------ overlay relay (allow-listed operations)

const ports = new Set<chrome.runtime.Port>();
let stopChanges: (() => void) | null = null;
let changeTimer: ReturnType<typeof setTimeout> | undefined;
async function watchChanges() {
	if (stopChanges || !ports.size) return;
	const c = await client();
	if (!c) return;
	stopChanges = c.client.onChange(() => { clearTimeout(changeTimer); changeTimer = setTimeout(() => { for (const p of ports) p.postMessage({ type: 'changed' }); }, 150); });
}

async function op(name: string, args: Any, tab: chrome.tabs.Tab | undefined): Promise<unknown> {
	const c = await client();
	if (!c) throw new Error('Signal is not connected: open the Signal side panel to connect and sign in.');
	const k = c.client;
	switch (name) {
		case 'ping': return true;
		case 'context': return k.query(api.ambient.context, { url: pageLocator(String(args.url)) });
		case 'finding': return k.query(api.findings.get, { findingId: String(args.findingId) });
		case 'ackFinding': return k.mutation(api.findings.acknowledge, { findingId: String(args.findingId), acknowledged: Boolean(args.acknowledged) });
		case 'snoozeFinding': return k.mutation(api.notices.snoozeFinding, { findingId: String(args.findingId), hours: Number(args.hours) });
		case 'dismissFinding': return k.mutation(api.findings.dismiss, { findingId: String(args.findingId), reason: String(args.reason) });
		case 'ackNotice': return k.mutation(api.notices.acknowledge, { noticeId: String(args.noticeId) });
		case 'ackAllNotices': return k.mutation(api.notices.acknowledge, { all: true });
		case 'snoozeNotice': return k.mutation(api.notices.snooze, { noticeId: String(args.noticeId), hours: Number(args.hours) });
		case 'setCriteria': return k.mutation(api.criteria.setEnabled, { criteriaId: String(args.criteriaId), enabled: Boolean(args.enabled) });
		case 'refresh': return refreshSource(k, String(args.sourceId));
		case 'open': { await chrome.tabs.create({ url: `${c.origin}/#${String(args.path).startsWith('/') ? args.path : `/${args.path}`}`, active: true }); return true; }
		case 'disableSite': { if (tab?.url) await setSite(new URL(tab.url).origin, false); return true; }
		case 'analyze': {
			if (!tab?.id) throw new Error('No page.');
			return analyzeTab(k, tab);
		}
		case 'contribute': return k.mutation(api.sites.contributeCandidate, { analysisId: String(args.analysisId), candidateKey: String(args.candidateKey) });
		case 'connect': {
			const r = (await k.mutation(api.sites.connect, { feedId: String(args.feedId), ...(args.url ? { url: String(args.url) } : {}), ...(args.entityType ? { entityType: String(args.entityType).slice(0, 80) } : {}) })) as { sourceId: string; acquisition: string };
			const first = await refreshSource(k, r.sourceId).catch((e) => ({ status: 'error', error: errorText(e) }));
			return { ...r, first };
		}
		case 'capture': {
			if (!tab?.id) throw new Error('No page.');
			const snap = await snapshotTab(tab, false);
			return k.mutation(api.sources.capture, { sourceId: String(args.sourceId), html: snap.html!, url: pageLocator(snap.url) });
		}
		default: throw new Error(`Operation not allowed: ${name}`);
	}
}

chrome.runtime.onConnect.addListener((port) => {
	if (port.name !== 'signal.overlay' || !port.sender?.tab) return port.disconnect();
	ports.add(port);
	void watchChanges();
	port.onMessage.addListener(async (m: Any) => {
		if (typeof m?.id !== 'number' || typeof m?.op !== 'string') return;
		try { port.postMessage({ id: m.id, ok: true, value: await op(m.op, m.args ?? {}, port.sender?.tab) }); }
		catch (e) { port.postMessage({ id: m.id, ok: false, error: errorText(e) }); }
	});
	port.onDisconnect.addListener(() => { ports.delete(port); if (!ports.size && stopChanges) { stopChanges(); stopChanges = null; } });
});

/** Messages from the side panel (an extension page, trusted). */
chrome.runtime.onMessage.addListener((m: Any, sender, respond) => {
	// Extension pages only (the side panel, also when popped out into a tab), never content scripts.
	if (sender.id !== chrome.runtime.id || !String(sender.url ?? '').startsWith(chrome.runtime.getURL(''))) return;
	void (async () => {
		try {
			if (m?.type === 'signal.enableSite') { await setSite(String(m.origin), Boolean(m.on), m.tabId); return respond({ ok: true, value: await enabledSites() }); }
			if (m?.type === 'signal.sites') return respond({ ok: true, value: await enabledSites() });
			if (m?.type === 'signal.tick') return respond({ ok: true, value: await tick() });
			if (m?.type === 'signal.setTick') { await chrome.storage.local.set({ [K.tick]: Number(m.minutes) }); await chrome.alarms.create('signal.tick', { periodInMinutes: Number(m.minutes) }); return respond({ ok: true }); }
			respond({ ok: false, error: 'unknown message' });
		} catch (e) { respond({ ok: false, error: errorText(e) }); }
	})();
	return true;
});

// ------------------------------------------------------------------ site analysis (only when asked)

async function analyzeTab(k: FeltKitClient, tab: chrome.tabs.Tab) {
	const t0 = performance.now();
	const snap = await snapshotTab(tab, false).catch(() => null);
	const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id! }, world: 'MAIN', func: collectSiteEvidence, args: [{ maxFetches: 8, snapshot: snap?.html && snap.html.length < 700_000 ? snap.html : null, collector: `signal-extension/${chrome.runtime.getManifest().version}` }] });
	let evidence = JSON.stringify(res?.result ?? null);
	if (evidence.length > 1_850_000) { const e = JSON.parse(evidence); e.snapshot = null; evidence = JSON.stringify(e); }
	if (evidence.length > 1_850_000) throw new Error('This page loaded too much data to analyze in one request.');
	const collectMs = Math.round(performance.now() - t0);
	const a = (await k.mutation(api.sites.analyze, { evidence })) as Any;
	return { ...a, collectMs, totalMs: Math.round(performance.now() - t0) };
}

// ------------------------------------------------------------------ acquisition: server or the person's own browser session

async function refreshSource(k: FeltKitClient, sourceId: string, due?: Any) {
	const d = due ?? ((await k.query(api.sources.due, {})) as Any[]).find((x) => x.sourceId === sourceId) ?? (await k.query(api.sources.refreshContext, { sourceId }));
	if ((d.acquisition ?? 'server') !== 'browser') return k.action(api.sources.refresh, { sourceId });
	const url: string = d.url;
	const origin = new URL(url).origin;
	if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) return k.mutation(api.sources.recordFailure, { sourceId, code: 'NO_BROWSER_ACCESS', message: `the extension has no access to ${origin}: enable Signal on that site`, durationMs: 0 });
	const t0 = performance.now();
	try {
		const headers: Record<string, string> = { accept: 'application/json' };
		if (d.etag) headers['if-none-match'] = d.etag;
		if (d.lastModified) headers['if-modified-since'] = d.lastModified;
		const res = await fetch(url, { credentials: 'include', headers, cache: 'no-store' });
		const durationMs = Math.round(performance.now() - t0);
		if (res.status === 304) return k.mutation(api.sources.recordNotModified, { sourceId, finalUrl: res.url || url, durationMs });
		if (!res.ok) return k.mutation(api.sources.recordFailure, { sourceId, code: `HTTP_${res.status}`, message: res.status === 401 || res.status === 403 ? 'the site refused your session (sign in to it again)' : res.statusText || 'request failed', httpStatus: res.status, durationMs });
		const body = await res.text();
		const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, '0')).join('');
		return k.mutation(api.sources.recordFetch, { sourceId, body, hash, ...(res.headers.get('etag') ? { etag: res.headers.get('etag')! } : {}), ...(res.headers.get('last-modified') ? { lastModified: res.headers.get('last-modified')! } : {}), finalUrl: res.url || url, httpStatus: res.status, durationMs });
	} catch (e) {
		return k.mutation(api.sources.recordFailure, { sourceId, code: 'UNREACHABLE', message: errorText(e), durationMs: Math.round(performance.now() - t0) });
	}
}

let ticking = false;
async function tick() {
	if (ticking) return { skipped: true };
	ticking = true;
	try {
		const c = await client();
		if (!c) return { connected: false };
		const due = (await c.client.query(api.sources.due, {}).catch(() => [])) as Any[];
		const results = [];
		for (const d of due) results.push({ sourceId: d.sourceId, result: await refreshSource(c.client, d.sourceId, d).catch((e) => ({ status: 'error', error: errorText(e) })) });
		const shown = await notify(c);
		return { connected: true, refreshed: results.length, shown };
	} finally { ticking = false; }
}
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'signal.tick') void tick(); });

async function notify(c: { origin: string; client: FeltKitClient }) {
	const p = (await c.client.query(api.notices.pending, {}).catch(() => null)) as Any;
	const s = (await c.client.query(api.notices.summary, {}).catch(() => null)) as Any;
	if (s) { await chrome.action.setBadgeText({ text: s.active ? String(Math.min(s.active, 99)) : '' }).catch(() => undefined); await chrome.action.setBadgeBackgroundColor({ color: s.critical ? '#b91c1c' : '#2457d6' }).catch(() => undefined); }
	if (!p?.notices?.length) return 0;
	const shown: string[] = [];
	for (const n of p.notices.slice(0, 5).reverse()) {
		await chrome.notifications.create(`signal:${n.id}:${n.findingId ?? ''}`, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title: n.title.slice(0, 120), message: n.body.slice(0, 400), priority: n.severity === 'critical' ? 2 : n.severity === 'warning' ? 1 : 0 }).catch(() => undefined);
		shown.push(n.id);
	}
	// Older pending ones are marked too: the inbox has them; a burst of desktop notifications helps no one.
	await c.client.mutation(api.notices.delivered, { noticeIds: p.notices.map((n: Any) => n.id) });
	return shown.length;
}
chrome.notifications.onClicked.addListener(async (id) => {
	const [, , findingId] = id.split(':');
	const c = await client();
	if (c) await chrome.tabs.create({ url: `${c.origin}/#${findingId ? `/findings/${findingId}` : '/notifications'}` });
	chrome.notifications.clear(id);
});
