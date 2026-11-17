/**
 * Service worker: what Signal does on pages while the panel is closed.
 *
 *  - Relays the in-page overlay's requests (an allow-list of four operations) to the instance, so alerts,
 *    "Watching" and "Show on page" work on the page without the panel.
 *  - When a watched search is opened, shows the overlay and (if the setting is on) checks the page once it has
 *    loaded: capture → alert → browser notification.
 *
 * The session token is read from extension storage, locked to trusted contexts (extension pages and this worker;
 * never content scripts or pages). FeltKit's reference host keeps the session out of the worker; Signal holds it
 * here because alerts must reach the page with the panel closed. The worker never prompts for permissions and
 * reads only pages whose access was already granted and that are covered by a watch.
 */
import { createClient, type FeltKitClient } from '@feltdb/feltkit/client';
import { capture, chromeTokenStore, errorText, monitoredPages, notify, pageLocator, parentLocator, relayOverlay, savedInstance, showOverlay, snapshotTab, watchedPages } from './host.ts';

const lock = () => chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined);
const setup = () => {
	void lock();
	void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
};
chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);
setup();

/** A client for the connected instance, or null (not connected, or access to it was withdrawn). */
async function client(): Promise<FeltKitClient | null> {
	const origin = await savedInstance();
	if (!origin || !(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) return null;
	return createClient({ url: origin, session: 'bearer', tokens: await chromeTokenStore() });
}

// ------------------------------------------------------------------ overlay relay

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
	if (msg?.type === 'signal.watchesChanged') { watchedCache = null; return; }
	if (msg?.type !== 'signal.overlay') return;
	void (async () => {
		const c = await client();
		if (!c) return respond({ ok: false, error: 'Signal is not connected (open the Signal panel to connect)' });
		try { respond({ ok: true, value: await relayOverlay(c, msg, sender) }); } catch (e) { respond({ ok: false, error: errorText(e) }); }
	})();
	return true;
});

// ------------------------------------------------------------------ watched pages

let watchedCache: { at: number; set: Set<string>; monitored: Set<string> } | null = null;
async function watched(c: FeltKitClient): Promise<Set<string>> {
	if (!watchedCache || Date.now() - watchedCache.at > 30_000) watchedCache = { at: Date.now(), set: await watchedPages(c), monitored: await monitoredPages(c) };
	return watchedCache.set;
}
async function monitored(c: FeltKitClient): Promise<Set<string>> { await watched(c); return watchedCache!.monitored; }
const coveredBy = (url: string, set: Set<string>): string | null => {
	try { const exact = pageLocator(url), parent = parentLocator(url); return set.has(exact) ? exact : set.has(parent) ? parent : null; } catch { return null; }
};
const recent = new Map<string, number>();

/**
 * Check a watched search once its page has settled. Called after a page load and after a single-page app moves
 * (a map pan or zoom rewrites the address without loading a page, so no `complete` event follows).
 */
async function checkTab(tabId: number, settleMs: number): Promise<void> {
	const tab = await chrome.tabs.get(tabId).catch(() => null);
	if (!tab?.url || !/^https?:/i.test(tab.url)) return;
	const c = await client();
	if (!c) return;
	// Only pages the person chose to monitor get the overlay; only watched searches are checked automatically.
	const shown = coveredBy(tab.url, await monitored(c).catch(() => new Set<string>()));
	if (!shown) return;
	if (!(await chrome.permissions.contains({ origins: [`${new URL(tab.url).origin}/*`] }))) return; // never prompts
	await showOverlay(tabId).catch(() => undefined); // existing alerts, on the page, right away
	const scope = coveredBy(tab.url, await watched(c).catch(() => new Set<string>()));
	if (!scope) return;
	const auto = (await chrome.storage.local.get('signal.autocheck'))['signal.autocheck'] ?? true;
	const exact = pageLocator(tab.url);
	if (!auto || Date.now() - (recent.get(exact) ?? 0) < 15_000) return;
	recent.set(exact, Date.now());
	await new Promise((r) => setTimeout(r, settleMs)); // let the page render its listings
	const now = await chrome.tabs.get(tabId).catch(() => null);
	if (!now?.url || coveredBy(now.url, new Set([scope])) !== scope) return; // the person moved on: read nothing
	const snap = await snapshotTab(now, false);
	const r = await capture(c, snap);
	if (r.alert) await notify(r.alert);
	await showOverlay(tabId).catch(() => undefined);
	await chrome.runtime.sendMessage({ type: 'signal.captured', url: exact, alert: !!r.alert, entities: r.entities }).catch(() => undefined); // the panel, if open
}

const moving = new Map<number, ReturnType<typeof setTimeout>>();
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
	if (!tab.url || !/^https?:/i.test(tab.url)) return;
	if (change.status === 'complete') { void checkTab(tabId, 2500).catch(() => undefined); return; }
	if (change.url) {
		// A single-page app moved (map pan/zoom, filters). Wait until it stops moving, then check what it now shows.
		clearTimeout(moving.get(tabId));
		moving.set(tabId, setTimeout(() => { moving.delete(tabId); void checkTab(tabId, 1500).catch(() => undefined); }, 2500));
	}
});
