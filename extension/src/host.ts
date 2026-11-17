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
export async function snapshotTab(tab: chrome.tabs.Tab): Promise<Snapshot> {
	const run = () => chrome.scripting.executeScript({ target: { tabId: tab.id! }, func: snapshotPage, args: [MAX_SNAPSHOT_BYTES] });
	let res;
	try { res = await run(); } catch {
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

export interface Captured { url: string; title: string; pageId: string; previousPageId?: string; capturedAt: string; entities: number; revision: string | null; unchanged: boolean }

async function domSource(client: FeltKitClient, locator: string): Promise<string> {
	const mine = (await client.query(api.sources.list, {})) as Array<{ id: string; type: string; locator: string }>;
	const found = mine.find((s) => s.type === 'dom' && s.locator === locator);
	return found ? found.id : (await client.mutation(api.sources.register, { type: 'dom', locator, strategy: 'manual' })) as string;
}

/** Record a snapshot as a dom observation of its page and add it to the working set. */
export async function capture(client: FeltKitClient, snap: Snapshot): Promise<Captured> {
	const locator = pageLocator(snap.url);
	const sourceId = await domSource(client, locator);
	const r = (await client.mutation(api.pages.push, { sourceId, html: snap.html!, baseUrl: locator })) as { pageId: string; outcome: string; revision: string | null; entities: number };
	if (r.outcome !== 'represented' && r.outcome !== 'already_recorded') throw new Error(`Not represented: ${r.outcome}`);
	const set = await workingSet();
	const prev = set.find((p) => p.url === locator);
	const entry: Captured = {
		url: locator, title: snap.title.slice(0, 200), pageId: r.pageId, capturedAt: new Date().toISOString(), entities: r.entities, revision: r.revision,
		unchanged: !!prev && prev.revision === r.revision,
		...(prev ? { previousPageId: prev.pageId } : {})
	};
	await saveWorkingSet([...set.filter((p) => p.url !== locator), entry]);
	return entry;
}

// ------------------------------------------------------------------ working set and intent (per-browser selections, not authority)

export async function workingSet(): Promise<Captured[]> { return (await chrome.storage.local.get(K.set))[K.set] ?? []; }
export async function saveWorkingSet(s: Captured[]): Promise<void> { await chrome.storage.local.set({ [K.set]: s }); }
export async function intentDraft(): Promise<string | null> { return (await chrome.storage.local.get(K.intent))[K.intent] ?? null; }
export async function saveIntentDraft(t: string): Promise<void> { await chrome.storage.local.set({ [K.intent]: t }); }

// ------------------------------------------------------------------ discovery

export interface DiscoveryView {
	candidates: Array<{ key: string; name: string | null; type: string; status: 'match' | 'possible' | 'non_match' | 'out_of_scope'; missing: string[]; changed?: { fields: string[] }; criteria: Array<{ id: string; label: string; result: 'true' | 'false' | 'unknown'; reason?: string }> }>;
	coverage: { declaredTotal: number | null; listed: number; discovered: number; notYetExamined: number | null; exhaustive: boolean; exhaustiveBasis: string; unavailable: Array<{ what: string; why: string }> };
	plan: Array<{ kind: string; target: string; reason: string; executesIn: 'browser-session' | 'background' | 'user'; priority: number }>;
	context: Record<string, { value: unknown; source: string; basis: string }>;
	resultDigest: string;
}

/** Evaluate the intent over the working set; pages captured again are compared with their previous capture. */
export async function discover(client: FeltKitClient, intent: string, set: Captured[]): Promise<DiscoveryView> {
	if (!set.length) throw new Error('Capture at least one page first.');
	try { JSON.parse(intent); } catch { throw new Error('The intent is not valid JSON.'); }
	const pageIds = set.map((p) => p.pageId);
	const withPrev = set.some((p) => p.previousPageId);
	const args = { pageIds, intent, ...(withPrev ? { previousPageIds: set.map((p) => p.previousPageId ?? p.pageId) } : {}) };
	return (await client.query(api.discovery.evaluate, args)) as unknown as DiscoveryView;
}

/** A plan step the person may take in this browser: only http(s) navigation, never anything else. */
export function navigableTarget(target: string): string | null {
	try { const u = new URL(target); return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null; } catch { return null; }
}

// ------------------------------------------------------------------ overlay relay

const OVERLAY_OPS = new Set(['events:forPage', 'events:evidence', 'events:acknowledge']);

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
		case 'events:forPage': return client.query(api.events.forPage, { sourceLocator: pageLocator(sender.tab.url) });
		case 'events:evidence': return client.query(api.events.evidence, { eventId: id });
		default: return client.mutation(api.events.acknowledge, { eventId: id });
	}
}

/** Show the overlay on a tab. Its transport messages the panel; it holds no credentials. */
export async function showOverlay(tabId: number): Promise<void> {
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

export function errorText(e: unknown): string {
	if (e instanceof FeltKitClientError) return `${e.message}${e.code ? ` (${e.code})` : ''}`;
	return e instanceof Error ? e.message : String(e);
}
