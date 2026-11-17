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
 * current tab once, in their own browser session, and sends it to one of their browser-capture sources.
 * Nothing is crawled, scheduled or fetched by Signal.
 */
import { createClient, FeltKitClientError, type FeltKitClient, type SessionInfo, type TokenStore } from '@feltdb/feltkit/client';
import { api } from '../../feltkit/_generated/api.ts';
import { redactUrlString } from '../../lib/page/values.ts';
import { snapshotPage, type Snapshot } from './snapshot.ts';
export type { Snapshot };

const K = { instance: 'signal.instance', token: 'signal.session', source: 'signal.captureSource' } as const;
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

/** Does the session grant a permission? Grants may be wildcards: `signal.*`, `*`. */
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
	await chrome.storage.local.remove([K.instance, K.token, K.source]);
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

export interface CaptureSource { id: string; name: string; status: string; records: number; pageTypes: string[] }
export interface Captured { url: string; title: string | null; received: number; added: number; changed: number; unchanged: number; newInformation: boolean; recordKeys: string[]; run: { entities: number; created: number; changed: number; closed: number; reopened: number; durationMs: number } | null }
export interface Affected { id: string; recordKey: string; entityLabel: string | null; criteriaName: string; qualification: string; change: string; summary: string; sourceCount: number; lastChangedAt: string }

/** The person's browser-capture sources (kind page_capture). */
export async function captureSources(client: FeltKitClient): Promise<CaptureSource[]> {
	const list = (await client.query(api.sources.list, {})) as Array<{ id: string; name: string; kind: string; status: string; records: number }>;
	const out: CaptureSource[] = [];
	for (const s of list.filter((x) => x.kind === 'page_capture')) {
		const d = (await client.query(api.sources.get, { sourceId: s.id })) as { mapping: { pageTypes?: string[] } };
		out.push({ id: s.id, name: s.name, status: s.status, records: s.records, pageTypes: d.mapping.pageTypes ?? [] });
	}
	return out;
}

export async function createCaptureSource(client: FeltKitClient, name: string, entityType: string, pageTypes: string[]): Promise<string> {
	return (await client.mutation(api.sources.create, { name, kind: 'page_capture', entityType, mapping: JSON.stringify({ entityType, pageTypes }) })) as string;
}

/**
 * Send what the person sees to a capture source. Signal extracts the page's items, versions what changed,
 * matches them with the person's other sources and re-evaluates affected findings — in one transaction.
 */
export async function capture(client: FeltKitClient, sourceId: string, snap: Snapshot): Promise<Captured> {
	const url = pageLocator(snap.url);
	const r = (await client.mutation(api.sources.capture, { sourceId, html: snap.html!, url })) as Omit<Captured, 'url'>;
	return { ...r, url };
}

export async function affected(client: FeltKitClient, sourceId: string, recordKeys: string[]): Promise<Affected[]> {
	return recordKeys.length ? ((await client.query(api.findings.forRecords, { sourceId, recordKeys: recordKeys.slice(0, 2000) })) as Affected[]) : [];
}

export function errorText(e: unknown): string {
	if (e instanceof FeltKitClientError) return `${e.message}${e.code ? ` (${e.code})` : ''}`;
	return e instanceof Error ? e.message : String(e);
}

export async function chosenSource(): Promise<string | null> { return (await chrome.storage.local.get(K.source))[K.source] ?? null; }
export async function chooseSource(id: string | null): Promise<void> { if (id) await chrome.storage.local.set({ [K.source]: id }); else await chrome.storage.local.remove(K.source); }
