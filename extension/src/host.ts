/**
 * Signal's browser-extension host, following FeltKit's extension-host contract
 * (@feltdb/feltkit docs/EXTENSION-HOSTS.md):
 *  - the side panel is the only context that holds the session and calls the instance, using the
 *    app's own FeltKit client with a bearer session; the service worker and content scripts hold none;
 *  - the session token lives in memory, written through to chrome.storage.local locked to trusted contexts;
 *  - host access is requested for the one instance origin at connect time, and for a page's origin
 *    only when the person captures that page (activeTab covers the tab the toolbar button opened on).
 *
 * Everything here runs because the person did something: capturing reads the rendered DOM of the
 * current tab once, in their own browser session. Nothing is crawled, scheduled or fetched by Signal.
 */
import { createClient, FeltKitClientError, type FeltKitClient, type SessionInfo, type TokenStore } from '@feltdb/feltkit/client';
import { api } from '../../feltkit/_generated/api.ts';
import { redactUrlString } from '../../lib/page/values.ts';
import { snapshotPage, type Snapshot } from './snapshot.ts';
export type { Snapshot };

const K = { instance: 'signal.instance', token: 'signal.session', set: 'signal.workingSet', intent: 'signal.intentDraft' } as const;
/** FeltKit accepts request bodies up to 2 MiB; leave room for the JSON envelope and escaping. */
export const MAX_SNAPSHOT_BYTES = 1_800_000;

export async function lockStorage(): Promise<void> {
	await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined);
}

/** A synchronous TokenStore (what the FeltKit client needs) backed by memory, written through to storage. */
export async function chromeTokenStore(): Promise<TokenStore> {
	let token: string | null = (await chrome.storage.local.get(K.token))[K.token] ?? null;
	return {
		get: () => token,
		set: (t) => { token = t; void (t ? chrome.storage.local.set({ [K.token]: t }) : chrome.storage.local.remove(K.token)); }
	};
}

export function instanceOrigin(input: string): string {
	let u: URL;
	try { u = new URL(input.trim()); } catch { throw new Error('Enter the URL of your Signal instance, e.g. https://signal.example.com'); }
	if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname))) throw new Error('The instance must use https (http only for localhost).');
	return u.origin;
}

/** Does the session grant a permission? Grants may be wildcards: `signal.datasets.*`, `signal.*`, `*`. */
export function can(permissions: readonly string[] | undefined, needed: string): boolean {
	return (permissions ?? []).some((g) => g === '*' || g === needed || (g.endsWith('.*') && needed.startsWith(g.slice(0, -1))));
}

export interface Connection { client: FeltKitClient; origin: string; session: SessionInfo }

/** Connect to an instance: host permission for that one origin, then check it is a Signal app. */
export async function connect(origin: string, requestPermission = true): Promise<Connection> {
	const pattern = `${origin}/*`;
	let granted = false;
	if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
		if (!requestPermission || !(await chrome.permissions.request({ origins: [pattern] }))) throw new Error(`Access to ${origin} was not granted.`);
		granted = true;
	}
	const notSignal = async (why: string) => {
		if (granted) await chrome.permissions.remove({ origins: [pattern] }).catch(() => undefined); // do not keep access to a site that is not the instance
		return new Error(`${origin} is not a Signal instance (${why}). Enter the address where your Signal app runs, for example http://localhost:3000 after \`npm run dev\` — not the page you want to capture. Open that page in a tab and use “Capture this page”.`);
	};
	const client = createClient({ url: origin, session: 'bearer', tokens: await chromeTokenStore() });
	let session: SessionInfo;
	try { session = await client.session(); } catch (e) {
		if (e instanceof TypeError && /fetch/i.test(e.message)) throw new Error(`Could not reach ${origin}. Is your Signal app running there?`);
		throw await notSignal(e instanceof SyntaxError ? 'it answered with a web page, not the FeltKit session API' : errorText(e));
	}
	if (!session || typeof session !== 'object' || !('application' in session)) throw await notSignal('no FeltKit session API');
	if (session.application !== 'signal') throw await notSignal(`it is the FeltKit app "${session.application}"`);
	await chrome.storage.local.set({ [K.instance]: origin });
	return { client, origin, session };
}

export async function savedInstance(): Promise<string | null> {
	return (await chrome.storage.local.get(K.instance))[K.instance] ?? null;
}

export async function forgetInstance(client?: FeltKitClient): Promise<void> {
	if (client) await client.signOut().catch(() => undefined);
	await chrome.storage.local.remove([K.instance, K.token, K.set]);
}

// ------------------------------------------------------------------ capture

/**
 * The page the person is looking at: the active tab of the panel's window. When the panel itself is
 * open as a tab ("popped out"), the most recently used web tab in its window.
 */
export async function activeTab(): Promise<chrome.tabs.Tab> {
	const self = await chrome.tabs.getCurrent();
	const tab = self
		? (await chrome.tabs.query({ currentWindow: true })).filter((t) => t.id !== self.id && /^https?:/i.test(t.url ?? '')).sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0]
		: (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
	if (!tab?.id || !tab.url) throw new Error('No web page is open in this window.');
	if (!/^https?:/i.test(tab.url)) throw new Error('Signal captures web pages (http or https) only.');
	return tab;
}

/** Read the rendered DOM of a tab once. Asks for that page's origin only if activeTab does not cover it. */
export async function snapshotTab(tab: chrome.tabs.Tab, mayAsk = true): Promise<Snapshot> {
	const run = () => chrome.scripting.executeScript({ target: { tabId: tab.id! }, func: snapshotPage, args: [MAX_SNAPSHOT_BYTES] });
	let res;
	try { res = await run(); } catch (e) {
		if (!mayAsk) throw e; // automatic checks never prompt
		const origin = new URL(tab.url!).origin;
		if (!(await chrome.permissions.request({ origins: [`${origin}/*`] }))) throw new Error(`Signal needs your permission to read ${origin}.`);
		res = await run();
	}
	const snap = res[0]?.result;
	if (!snap) throw new Error('The page could not be read.');
	if (snap.html === null) throw new Error(`Even without scripts and styles this page is ${(snap.bytes / 1048576).toFixed(1)} MB; one capture can send up to ${(MAX_SNAPSHOT_BYTES / 1048576).toFixed(1)} MB.`);
	return snap;
}

/** The locator a page is recorded under: secrets redacted, fragment removed. */
export function pageLocator(url: string): string {
	const u = new URL(url);
	u.hash = '';
	return redactUrlString(u.toString());
}

/**
 * The "parent" of a page: its site and path without the query or fragment. Listing sites keep the map
 * position, zoom and filters in the query, so a watch scoped to the parent keeps applying as the map moves.
 */
export function parentLocator(url: string): string {
	const u = new URL(url);
	u.search = ''; u.hash = '';
	return u.toString();
}

export interface Captured { url: string; title: string; pageId: string; previousPageId?: string; capturedAt: string; entities: number; revision: string | null; unchanged: boolean }

async function domSource(client: FeltKitClient, locator: string): Promise<string> {
	const mine = (await client.query(api.sources.list, {})) as Array<{ id: string; type: string; locator: string }>;
	const found = mine.find((s) => s.type === 'dom' && s.locator === locator);
	return found ? found.id : (await client.mutation(api.sources.register, { type: 'dom', locator, strategy: 'manual' })) as string;
}

export interface Alerted { eventId: string; title: string; body: string }

/**
 * Record a snapshot as a dom observation of its page and add it to the working set. When the page is
 * watched, the capture goes through the watch's monitor, so the alert criteria are evaluated and an
 * alert is recorded (and notified) when the matching set changes.
 */
export async function capture(client: FeltKitClient, snap: Snapshot): Promise<Captured & { alert?: Alerted; truncated?: boolean }> {
	const locator = pageLocator(snap.url);
	const found = await findWatch(client, snap.url);
	const w = found?.watch;
	const sourceId = w ? found!.sourceId : await domSource(client, locator);
	let r: { pageId: string; outcome: string; revision: string | null; entities: number; truncated?: boolean };
	let alert: Alerted | undefined;
	if (w) {
		const m = (await client.mutation(api.monitors.push, { monitorId: w.monitorId, content: snap.html!, baseUrl: locator })) as { outcome: string; eventId: string | null; pageId?: string | null };
		if (!m.pageId) throw new Error(`Not represented: ${m.outcome}`);
		const pg = (await client.query(api.pages.list, { sourceId })) as Array<{ pageId: string; revision: string; entities: number; truncated: boolean }>;
		const rec = pg.find((x) => x.pageId === m.pageId);
		r = { pageId: m.pageId, outcome: 'represented', revision: rec?.revision ?? null, entities: rec?.entities ?? 0, truncated: rec?.truncated };
		if (m.eventId) {
			const [ev] = ((await client.query(api.events.forPage, { sourceLocator: found!.locator })) as Array<{ id: string; criteriaName: string; excerpts: Array<{ text: string }> }>).filter((e) => e.id === m.eventId);
			alert = { eventId: m.eventId, title: ev?.criteriaName ?? w.name, body: (ev?.excerpts ?? []).map((x) => x.text).slice(0, 4).join('\n') || 'Matches changed' };
		}
	} else {
		r = (await client.mutation(api.pages.push, { sourceId, html: snap.html!, baseUrl: locator })) as { pageId: string; outcome: string; revision: string | null; entities: number; truncated?: boolean };
		if (r.outcome !== 'represented' && r.outcome !== 'already_recorded') throw new Error(`Not represented: ${r.outcome}`);
	}
	const set = await workingSet();
	const prev = set.find((p) => p.url === locator);
	const entry: Captured = {
		url: locator, title: snap.title.slice(0, 200), pageId: r.pageId, capturedAt: new Date().toISOString(), entities: r.entities, revision: r.revision,
		unchanged: !!prev && prev.revision === r.revision,
		...(prev ? { previousPageId: prev.pageId } : {})
	};
	await saveWorkingSet([...set.filter((p) => p.url !== locator), entry]);
	return { ...entry, ...(alert ? { alert } : {}), ...(r.truncated ? { truncated: true } : {}) };
}

// ------------------------------------------------------------------ watches: an intent that alerts (a monitor whose criteria is a discover condition)

export interface Watch { monitorId: string; criteriaId: string; version: number; name: string; criteria: string[]; notify: string[] }
const watchId = (sourceId: string) => `watch.${sourceId.replace(/[^A-Za-z0-9_.-]/g, '_')}`.slice(0, 120);

/** The enabled watches on a page, read from the server (the authority), with their criteria in words. */
export async function watchesFor(client: FeltKitClient, locator: string, sourceId?: string): Promise<Watch[]> {
	const sid = sourceId ?? ((await client.query(api.sources.list, {})) as Array<{ id: string; type: string; locator: string }>).find((x) => x.type === 'dom' && x.locator === locator)?.id;
	if (!sid) return [];
	const ms = ((await client.query(api.monitors.list, {})) as Array<{ id: string; sourceId: string; criteriaId: string; criteriaVersion: number; enabled: boolean; notify: string[] }>)
		.filter((m) => m.sourceId === sid && m.enabled && m.criteriaId === watchId(sid));
	const out: Watch[] = [];
	for (const m of ms) {
		const c = (await client.query(api.criteria.get, { criteriaId: m.criteriaId, version: m.criteriaVersion })) as { name: string; condition: { discover?: { criteria: Array<{ label: string }> } } } | null;
		if (!c?.condition?.discover) continue;
		out.push({ monitorId: m.id, criteriaId: m.criteriaId, version: m.criteriaVersion, name: c.name, criteria: c.condition.discover.criteria.map((x) => x.label), notify: m.notify });
	}
	return out.sort((a, b) => b.version - a.version);
}

/**
 * Watch a page for an intent: publish the intent as a new immutable criteria version
 * ({ discover: intent }), create its monitor, and turn off the page's previous watch.
 */
export async function setWatch(client: FeltKitClient, locator: string, intent: DiscoveryIntent, name: string): Promise<Watch> {
	const sourceId = await domSource(client, locator);
	const id = watchId(sourceId);
	const previous = await watchesFor(client, locator, sourceId);
	let version = Math.max(0, ...previous.map((w) => w.version)) + 1;
	for (let tries = 0; ; tries++) {
		try {
			await client.mutation(api.criteria.define, { definition: JSON.stringify({ schema: 'signal.criteria/v1', id, version, name, severity: 'info', notify: 'on_change', condition: { discover: { ...intent, id, version } } }) });
			break;
		} catch (e) {
			if (tries < 20 && e instanceof FeltKitClientError && e.code === 'FAILED_PRECONDITION') { version++; continue; } // an earlier version exists without a monitor
			throw e;
		}
	}
	const monitorId = (await client.mutation(api.monitors.create, { sourceId, criteriaId: id, criteriaVersion: version })) as string;
	for (const w of previous) await client.mutation(api.monitors.setEnabled, { monitorId: w.monitorId, enabled: false });
	return (await watchesFor(client, locator, sourceId)).find((w) => w.monitorId === monitorId)!;
}

/** Locators of every page with an enabled watch (for the automatic check when such a page is opened). */
export async function watchedPages(client: FeltKitClient): Promise<Set<string>> {
	const srcs = new Map(((await client.query(api.sources.list, {})) as Array<{ id: string; type: string; locator: string }>).filter((x) => x.type === 'dom').map((x) => [x.id, x.locator]));
	const ms = (await client.query(api.monitors.list, {})) as Array<{ sourceId: string; criteriaId: string; enabled: boolean }>;
	return new Set(ms.filter((m) => m.enabled && m.criteriaId === watchId(m.sourceId) && srcs.has(m.sourceId)).map((m) => srcs.get(m.sourceId)!));
}

/** Locators of every page the person chose to monitor: any enabled monitor's source (watches and server monitors). */
export async function monitoredPages(client: FeltKitClient): Promise<Set<string>> {
	const srcs = new Map(((await client.query(api.sources.list, {})) as Array<{ id: string; locator: string }>).map((x) => [x.id, x.locator]));
	const ms = (await client.query(api.monitors.list, {})) as Array<{ sourceId: string; enabled: boolean }>;
	return new Set(ms.filter((m) => m.enabled && srcs.has(m.sourceId)).map((m) => srcs.get(m.sourceId)!));
}

/** Whether the overlay belongs on this page: it is monitored (exactly, or as part of a search), or has alerts. */
export async function isMonitored(client: FeltKitClient, url: string): Promise<boolean> {
	const set = await monitoredPages(client);
	if (set.has(pageLocator(url)) || set.has(parentLocator(url))) return true;
	for (const loc of [pageLocator(url), parentLocator(url)]) if (((await client.query(api.events.forPage, { sourceLocator: loc })) as unknown[]).length) return true;
	return false;
}

/** The watch that applies to a page: one on its parent (any query) first, else one on its exact address. */
export async function findWatch(client: FeltKitClient, url: string): Promise<{ watch: Watch; locator: string; sourceId: string; scope: 'parent' | 'exact' } | null> {
	const srcs = ((await client.query(api.sources.list, {})) as Array<{ id: string; type: string; locator: string }>).filter((x) => x.type === 'dom');
	for (const [scope, locator] of [['parent', parentLocator(url)], ['exact', pageLocator(url)]] as const) {
		const src = srcs.find((x) => x.locator === locator);
		if (!src) continue;
		const [watch] = await watchesFor(client, locator, src.id);
		if (watch) return { watch, locator, sourceId: src.id, scope };
	}
	return null;
}

/** Stop whichever watch applies to this page. */
export async function stopWatch(client: FeltKitClient, url: string): Promise<void> {
	const f = await findWatch(client, url);
	if (f) for (const w of await watchesFor(client, f.locator, f.sourceId)) await client.mutation(api.monitors.setEnabled, { monitorId: w.monitorId, enabled: false });
}

/** Turn off any other watch covering this page (the other scope), so one page never alerts twice. */
export async function clearOtherScope(client: FeltKitClient, url: string, keep: string): Promise<void> {
	for (const locator of [parentLocator(url), pageLocator(url)]) if (locator !== keep) for (const w of await watchesFor(client, locator)) await client.mutation(api.monitors.setEnabled, { monitorId: w.monitorId, enabled: false });
}

/** A browser notification for an alert this capture recorded. */
export async function notify(a: Alerted): Promise<void> {
	await chrome.notifications.create(`signal:${a.eventId}`, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title: `Signal: ${a.title}`.slice(0, 120), message: a.body.slice(0, 400), priority: 1 }).catch(() => undefined);
}

// ------------------------------------------------------------------ working set and intent (per-browser selections, not authority)

export async function workingSet(): Promise<Captured[]> { return (await chrome.storage.local.get(K.set))[K.set] ?? []; }
export async function saveWorkingSet(s: Captured[]): Promise<void> { await chrome.storage.local.set({ [K.set]: s }); }
export async function intentDraft(): Promise<string | null> { return (await chrome.storage.local.get(K.intent))[K.intent] ?? null; }
export async function saveIntentDraft(t: string): Promise<void> { await chrome.storage.local.set({ [K.intent]: t }); }

// ------------------------------------------------------------------ discovery

export type { Facets, Facet } from '../../lib/discovery/discover.ts';
import type { DiscoveryIntent, Facets } from '../../lib/discovery/discover.ts';

/** What the captured pages offer to filter on (types, ranges, categories), for the intent controls. */
export async function loadFacets(client: FeltKitClient, set: Captured[], types?: string[]): Promise<Facets> {
	return (await client.query(api.discovery.facetsOf, { pageIds: set.map((p) => p.pageId), ...(types !== undefined ? { types } : {}) })) as unknown as Facets; // [] means "nothing selected", not "no choice"
}

export interface DiscoveryView {
	candidates: Array<{ key: string; name: string | null; type: string; metrics?: Record<string, { value: number | null; possibleValues?: number[]; inputs: Array<{ attr: string; provenance: string; source?: string }> }>; status: 'match' | 'possible' | 'non_match' | 'out_of_scope'; missing: string[]; locators: string[]; changed?: { fields: string[] }; criteria: Array<{ id: string; label: string; result: 'true' | 'false' | 'unknown'; reason?: string }> }>;
	coverage: { declaredTotal: number | null; listed: number; discovered: number; notYetExamined: number | null; exhaustive: boolean; exhaustiveBasis: string; unavailable: Array<{ what: string; why: string }> };
	plan: Array<{ kind: string; target: string; reason: string; executesIn: 'browser-session' | 'background' | 'user'; priority: number }>;
	context: Record<string, { value: unknown; source: string; basis: string }>;
	resultDigest: string;
	/** Present only when datasets took part: how each property was matched and every value they added. */
	augmentation?: import('./datasets.ts').Augmentation;
}

/** Evaluate the intent over the working set; pages captured again are compared with their previous capture. */
export async function discover(client: FeltKitClient, intent: string, set: Captured[], datasetIds: string[] = []): Promise<DiscoveryView> {
	if (!set.length) throw new Error('Capture at least one page first.');
	try { JSON.parse(intent); } catch { throw new Error('The intent is not valid JSON.'); }
	const pageIds = set.map((p) => p.pageId);
	const withPrev = set.some((p) => p.previousPageId);
	const args = { pageIds, intent, ...(withPrev ? { previousPageIds: set.map((p) => p.previousPageId ?? p.pageId) } : {}), ...(datasetIds.length ? { datasetIds } : {}) };
	return (await client.query(api.discovery.evaluate, args)) as unknown as DiscoveryView;
}

/** A plan step the person may take in this browser: only http(s) navigation, never anything else. */
export function navigableTarget(target: string): string | null {
	try { const u = new URL(target); return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null; } catch { return null; }
}

// ------------------------------------------------------------------ overlay relay

const OVERLAY_OPS = new Set(['events:forPage', 'events:evidence', 'events:acknowledge', 'watch:forPage']);

/**
 * Relay for the in-page overlay. The overlay (our content script, isolated world) cannot hold a session;
 * it asks the panel. Only three read/acknowledge operations are allowed; for `events:forPage` the
 * locator is the sender tab's own URL, whatever the message says. Ownership is enforced by the server.
 */
export async function relayOverlay(client: FeltKitClient, msg: { op?: string; args?: Record<string, unknown> }, sender: chrome.runtime.MessageSender): Promise<unknown> {
	if (sender.id !== chrome.runtime.id || !sender.tab?.url) throw new Error('refused: not from this extension\'s overlay');
	if (!msg.op || !OVERLAY_OPS.has(msg.op)) throw new Error(`refused: ${String(msg.op)}`);
	const id = typeof msg.args?.eventId === 'string' ? msg.args.eventId : '';
	switch (msg.op) {
		case 'events:forPage': {
			// Alerts recorded for this exact address and for its parent (a watch that ignores map position).
			const seen = new Set<string>();
			const all = [...(await client.query(api.events.forPage, { sourceLocator: pageLocator(sender.tab.url) })) as Array<{ id: string; occurredAt: string }>, ...(await client.query(api.events.forPage, { sourceLocator: parentLocator(sender.tab.url) })) as Array<{ id: string; occurredAt: string }>];
			return all.filter((e) => !seen.has(e.id) && seen.add(e.id)).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
		}
		case 'events:evidence': return client.query(api.events.evidence, { eventId: id });
		case 'watch:forPage': {
			const f = await findWatch(client, sender.tab.url);
			return f ? [{ name: f.watch.name, criteria: f.watch.criteria, notify: f.watch.notify, scope: f.scope === 'parent' ? `${f.locator} (any map position or filters in the address)` : f.locator }] : [];
		}
		default: return client.mutation(api.events.acknowledge, { eventId: id });
	}
}

/** Show the overlay on a tab (or refresh it if it is there). Its transport messages the panel; it holds no credentials. */
export async function showOverlay(tabId: number): Promise<void> {
	const [present] = await chrome.scripting.executeScript({ target: { tabId }, func: () => { const o = (window as unknown as { __signalOverlay?: { refresh: () => unknown } }).__signalOverlay; if (o) void o.refresh(); return !!o; } });
	if (present?.result) return;
	await chrome.scripting.executeScript({
		target: { tabId },
		func: (codecBase: string) => {
			(window as unknown as { SignalOverlayConfig: unknown }).SignalOverlayConfig = {
				codecBase,
				transport: async (op: string, args: unknown) => {
					const r = await chrome.runtime.sendMessage<{ ok: boolean; value?: unknown; error?: string }>({ type: 'signal.overlay', op, args });
					if (!r?.ok) throw new Error(r?.error ?? 'Signal panel is closed');
					return r.value;
				}
			};
		},
		args: [chrome.runtime.getURL('codec')]
	});
	await chrome.scripting.executeScript({ target: { tabId }, files: ['overlay.js'] });
}

/** Scroll to an item on the tab and frame it, with why it matched. False when it is not on the page right now. */
export async function showOnPage(tabId: number, item: { key: string; name: string | null; locators: string[]; criteria: string[]; others?: Array<{ key: string; name: string | null }> }): Promise<boolean> {
	await showOverlay(tabId);
	const [r] = await chrome.scripting.executeScript({
		target: { tabId },
		func: (x: typeof item) => (window as unknown as { __signalOverlay?: { show: (v: unknown) => boolean } }).__signalOverlay?.show(x) ?? false,
		args: [item]
	});
	return r?.result === true;
}

export function errorText(e: unknown): string {
	if (e instanceof FeltKitClientError) return `${e.message}${e.code ? ` (${e.code})` : ''}`;
	return e instanceof Error ? e.message : String(e);
}
