/** Side panel UI. All page-derived text is rendered with textContent; nothing observed is executed. */
import type { FeltKitClient, SessionInfo } from '@feltdb/feltkit/client';
import {
	activeTab, capture, connect, discover, errorText, forgetInstance, instanceOrigin, intentDraft, loadFacets, lockStorage, navigableTarget,
	relayOverlay, savedInstance, saveIntentDraft, saveWorkingSet, showOverlay, snapshotTab, workingSet, type DiscoveryView, type Facet, type Facets,
	clearOtherScope, findWatch, notify, pageLocator, parentLocator, setWatch, stopWatch, watchedPages
} from './host.ts';
import { buildIntent, formatValue, niceStep, reconcile, type EditorState, type FilterState } from './intent-builder.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = (tag: string, cls?: string, text?: string) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
let conn: { client: FeltKitClient; origin: string; session: SessionInfo } | null = null;

function status(text: string, error = false) { const s = $('status'); s.textContent = text; s.classList.toggle('error', error); }
function show(view: 'connect' | 'signin' | 'work') { for (const v of ['connect', 'signin', 'work']) $(v).hidden = v !== view; }
async function busy<T>(button: HTMLButtonElement, label: string, f: () => Promise<T>): Promise<T | undefined> {
	button.disabled = true; status(label);
	try { return await f(); } catch (e) { status(errorText(e), true); return undefined; } finally { button.disabled = false; }
}

async function refreshSession() {
	if (!conn) return show('connect');
	conn.session = await conn.client.session();
	const p = conn.session.principal;
	$('who').textContent = p ? `${p.displayName ?? p.id} · ${new URL(conn.origin).host}` : new URL(conn.origin).host;
	if (!p) return renderSignIn();
	show('work');
	await renderPages();
	await refreshFacets().catch((e) => status(errorText(e), true));
	watched = await watchedPages(conn.client).catch(() => new Set<string>());
	await renderWatch().catch(() => undefined);
}

function renderSignIn() {
	show('signin');
	const box = $('devusers'); box.replaceChildren();
	if (conn && !conn.session.environment.production && conn.session.devUsers.length) {
		box.append(el('p', 'muted', 'Development instance: sign in as'));
		for (const u of conn.session.devUsers) {
			const b = el('button', 'secondary', u.name) as HTMLButtonElement; b.type = 'button';
			b.addEventListener('click', () => busy(b, 'Signing in…', async () => { await conn!.client.signInAsDevUser(u.id); status(''); await refreshSession(); }));
			box.append(b, document.createTextNode(' '));
		}
	}
}

async function renderPages() {
	const set = await workingSet();
	$('count').textContent = set.length ? `(${set.length})` : '';
	const ul = $('pages'); ul.replaceChildren();
	for (const p of set) {
		const li = el('li');
		li.append(el('div', '', p.title || p.url), el('div', 'muted', `${p.entities} entities · ${new Date(p.capturedAt).toLocaleTimeString()}${p.previousPageId ? (p.unchanged ? ' · unchanged since last capture' : ' · changed since last capture') : ''}`));
		ul.append(li);
	}
	if (!set.length) ul.append(el('li', 'muted', 'Nothing captured yet. Open a page and choose “Capture this page”.'));
}

const MARK = { true: ['✓', 't'], false: ['✗', 'f'], unknown: ['?', 'u'] } as const;
const STATUS_LABEL = { match: 'match', possible: 'possible — missing information', non_match: 'not a match', out_of_scope: 'outside the area' } as const;
const BADGE = { match: 'match', possible: 'possible', non_match: 'not a match', out_of_scope: 'outside area' } as const;

/** Criterion ids are attribute names; show the person's labels instead. */
function labelled(text: string): string {
	const labels = new Map((facetData?.facets ?? []).map((f) => [f.attr, f.label]));
	return text.replace(/\b[A-Za-z][A-Za-z0-9]*\b/g, (w) => labels.get(w) ?? w);
}

function renderResults(r: DiscoveryView) {
	const box = $('results'); box.replaceChildren();
	const c = r.coverage;
	const cov = el('div', 'coverage');
	cov.append(el('div', '', c.exhaustive ? `Complete: ${c.exhaustiveBasis}.` : `Not complete: ${c.exhaustiveBasis}.`));
	if (c.notYetExamined) cov.append(el('div', 'muted', `${c.notYetExamined} not yet examined.`));
	for (const u of c.unavailable.slice(0, 5)) cov.append(el('div', 'muted', `${u.what} — ${u.why}`));
	box.append(el('h2', '', 'Coverage'), cov);

	const groups: Array<keyof typeof STATUS_LABEL> = ['match', 'possible', 'non_match', 'out_of_scope'];
	for (const g of groups) {
		const items = r.candidates.filter((x) => x.status === g);
		if (!items.length) continue;
		box.append(el('h2', '', `${STATUS_LABEL[g]} (${items.length})`));
		const ul = el('ul', 'list');
		for (const cand of items) {
			const li = el('li', 'cand');
			const head = el('div', 'head');
			const url = navigableTarget(cand.key);
			const name = el(url ? 'a' : 'span', '', cand.name ?? cand.key);
			if (url) { (name as HTMLAnchorElement).href = url; (name as HTMLAnchorElement).target = '_blank'; (name as HTMLAnchorElement).rel = 'noopener noreferrer'; }
			head.append(name, el('span', `badge ${g}`, cand.changed ? `${BADGE[g]} · changed` : BADGE[g]));
			const crit = el('div', 'crit');
			for (const x of cand.criteria) { const [m, cls] = MARK[x.result]; const s = el('span', cls, `${m} ${x.label}`); if (x.reason) s.title = x.reason; crit.append(s); }
			li.append(head, crit);
			if (cand.changed) li.append(el('div', 'muted', `Changed: ${labelled(cand.changed.fields.join(', '))}`));
			if (cand.missing.length) li.append(el('div', 'muted', `Undecided: ${labelled(cand.missing.join('; '))}`));
			ul.append(li);
		}
		box.append(ul);
	}
	if (!r.candidates.length) box.append(el('p', 'muted', 'No entities of the intent’s target type on the captured pages.'));

	if (r.plan.length) {
		box.append(el('h2', '', 'Next steps'));
		const ul = el('ul', 'list');
		for (const step of r.plan.filter((s) => s.kind !== 'skip_unchanged').slice(0, 12)) {
			const li = el('li');
			li.append(el('div', '', `${step.kind.replace('_', ' ')}: ${labelled(step.reason)}`));
			const url = navigableTarget(step.target);
			if (step.executesIn === 'browser-session' && url) {
				const b = el('button', 'secondary', 'Open here, then capture') as HTMLButtonElement; b.type = 'button';
				b.addEventListener('click', async () => { const tab = await activeTab().catch(() => null); if (tab?.id) await chrome.tabs.update(tab.id, { url }); });
				li.append(b);
			} else li.append(el('div', 'muted', step.executesIn === 'background' ? 'Needs data from outside the page (not run by the extension).' : step.target));
			ul.append(li);
		}
		box.append(ul);
	}
}


// ------------------------------------------------------------------ intent editor (controls generated from the captured pages)

let facetData: Facets | null = null;
let editor: EditorState = { types: [], filters: {} };
let jsonMode = false;
let liveTimer: ReturnType<typeof setTimeout> | undefined;

function currentIntent(): string {
	return jsonMode ? $<HTMLTextAreaElement>('intent').value : JSON.stringify(buildIntent(editor, facetData?.facets ?? []), null, 2);
}
async function persistEditor() {
	await saveIntentDraft(JSON.stringify({ editor, jsonMode, json: jsonMode ? $<HTMLTextAreaElement>('intent').value : undefined }));
}
function changed(evaluate = true) {
	if (!jsonMode) $<HTMLTextAreaElement>('intent').value = currentIntent();
	void persistEditor();
	if (evaluate && $<HTMLInputElement>('live').checked && facetData) { clearTimeout(liveTimer); liveTimer = setTimeout(() => void runDiscovery(), 350); }
}

async function refreshFacets(types?: string[], evaluate = true) {
	const set = await workingSet();
	if (!conn || !set.length) { facetData = null; renderEditor(); return; }
	facetData = await loadFacets(conn.client, set, types ?? (editor.types.length ? editor.types : undefined));
	editor = reconcile({ types: facetData.selected, filters: editor.filters }, facetData.facets);
	renderEditor();
	changed(evaluate);
}

function renderEditor() {
	const types = $('types'); types.replaceChildren();
	const filters = $('filters'); filters.replaceChildren();
	if (!facetData) { filters.append(el('p', 'muted', 'Capture a page to see what you can filter on.')); $('filter-count').textContent = ''; $<HTMLTextAreaElement>('intent').value = currentIntent(); return; }
	for (const t of facetData.types) {
		const b = el('button', 'chip', `${humanType(t.type)} · ${t.candidates}`) as HTMLButtonElement;
		b.type = 'button';
		b.setAttribute('aria-pressed', String(editor.types.includes(t.type)));
		b.addEventListener('click', () => {
			const next = editor.types.includes(t.type) ? editor.types.filter((x) => x !== t.type) : [...editor.types, t.type];
			if (!next.length) return; // something must be looked for
			void refreshFacets(next).catch((e) => status(errorText(e), true));
		});
		types.append(b);
	}
	$('filter-count').textContent = `(${facetData.candidates} ${facetData.candidates === 1 ? 'item' : 'items'})`;
	if (!facetData.facets.length) filters.append(el('p', 'muted', 'Nothing on these items varies enough to filter on.'));
	for (const f of facetData.facets) filters.append(filterRow(f, editor.filters[f.attr]));
	$<HTMLTextAreaElement>('intent').value = currentIntent();
}

const humanType = (t: string) => t.replace(/([a-z])([A-Z])/g, '$1 $2');
let uid = 0;

function filterRow(f: Facet, s: FilterState): HTMLElement {
	const row = el('div', `filter${s.on ? '' : ' off'}`);
	const id = `f${uid++}`;
	const top = el('div', 'top');
	const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.id = id; toggle.checked = s.on;
	const lab = el('label') as HTMLLabelElement; lab.htmlFor = id; lab.append(toggle, document.createTextNode(f.kind === 'presence' ? `Has ${f.label.toLowerCase()}` : f.label));
	top.append(lab, el('span', 'muted', `${f.present} of ${f.of} show it`));
	row.append(top);
	const body = el('div', 'body');
	const on = () => { if (!s.on) { s.on = true; toggle.checked = true; row.classList.remove('off'); } };
	toggle.addEventListener('change', () => { s.on = toggle.checked; row.classList.toggle('off', !s.on); changed(); });

	if (s.kind === 'range') {
		const step = niceStep(f);
		const value = el('div', 'range-value');
		const show = () => { value.textContent = `${formatValue(f, Math.min(s.lo, s.hi))} – ${formatValue(f, Math.max(s.lo, s.hi))}`; };
		const slider = (which: 'lo' | 'hi', text: string) => {
			const r = document.createElement('input');
			r.type = 'range'; r.min = String(f.min); r.max = String(f.max); r.step = String(step); r.value = String(s[which]);
			r.setAttribute('aria-label', `${f.label} ${text}`); r.dataset.attr = f.attr; r.dataset.bound = which;
			r.addEventListener('input', () => { s[which] = Number(r.value); on(); show(); changed(); });
			const line = el('div', 'range-row'); line.append(el('span', '', text), r); return line;
		};
		body.append(slider('lo', 'from'), slider('hi', 'to'), value);
		show();
	} else if (s.kind === 'category') {
		const opts = el('div', 'opts');
		for (const v of f.values ?? []) {
			const c = document.createElement('input'); c.type = 'checkbox'; c.checked = s.values.some((x) => String(x) === String(v.value));
			c.dataset.attr = f.attr; c.value = String(v.value);
			c.addEventListener('change', () => { s.values = c.checked ? [...s.values, v.value] : s.values.filter((x) => String(x) !== String(v.value)); if (s.values.length) on(); changed(); });
			const l = el('label'); l.append(c, document.createTextNode(`${humanType(String(v.value))} (${v.count})`)); opts.append(l);
		}
		body.append(opts);
	} else if (s.kind === 'boolean') {
		const opts = el('div', 'opts');
		for (const v of [true, false]) {
			const r = document.createElement('input'); r.type = 'radio'; r.name = id + 'b'; r.checked = s.value === v;
			r.addEventListener('change', () => { s.value = v; on(); changed(); });
			const l = el('label'); l.append(r, document.createTextNode(v ? 'Yes' : 'No')); opts.append(l);
		}
		body.append(opts);
	}
	if (f.present < f.of || f.kind === 'presence') {
		const miss = document.createElement('input'); miss.type = 'checkbox'; miss.checked = s.missing === 'false';
		miss.addEventListener('change', () => { s.missing = miss.checked ? 'false' : 'unknown'; changed(); });
		const l = el('label', 'missing'); l.append(miss, document.createTextNode(f.kind === 'presence' ? `Items that don’t show it are not a match (${f.of - f.present})` : `Items that don’t show it are not a match (otherwise “possible”, ${f.of - f.present})`));
		body.append(l);
	}
	row.append(body);
	return row;
}

async function runDiscovery(prefix = ''): Promise<void> {
	if (!conn) return;
	const r = await discover(conn.client, currentIntent(), await workingSet()).catch((e) => { status(errorText(e), true); return null; });
	if (!r) return;
	renderResults(r);
	const n = (s: string) => r.candidates.filter((c) => c.status === s).length;
	status(`${prefix}${n('match')} match · ${n('possible')} possible · ${n('non_match')} not a match`);
}

// ------------------------------------------------------------------ alerts (watches)

let watched = new Set<string>();

/** What the open page is watched for, in words, and where alerts go. Read from the server each time. */
async function renderWatch() {
	const box = $('watch-state'); const btn = $<HTMLButtonElement>('watch'); const stop = $('unwatch');
	const tab = await activeTab().catch(() => null);
	const set = await workingSet();
	const locator = tab?.url ? pageLocator(tab.url) : null;
	const captured = !!locator && set.some((p) => p.url === locator);
	box.replaceChildren();
	if (!conn || !locator || !captured) { box.append(document.createTextNode('Capture this page to set alerts on it.')); btn.disabled = true; stop.hidden = true; return; }
	const found = await findWatch(conn.client, tab!.url!);
	const w = found?.watch;
	const parent = parentLocator(tab!.url!);
	$('scope-parent').textContent = `This search, wherever the map is (${parent.replace(/^https?:\/\//, '')})`;
	for (const r of document.querySelectorAll<HTMLInputElement>('#scope input')) if (found) r.checked = r.value === found.scope;
	btn.disabled = false;
	if (!w) {
		box.append(document.createTextNode('Not watching this page. Set the filters above, then choose “Alert me when this matches”.'));
		btn.textContent = 'Alert me when this matches'; stop.hidden = true; return;
	}
	const d = el('div', 'watching');
	d.append(el('strong', '', found!.scope === 'parent' ? `Watching ${found!.locator.replace(/^https?:\/\//, '')} — any map position or filters in the address. You are alerted when an item matches:` : 'Watching exactly this address. You are alerted when an item matches:'));
	const ul = el('ul');
	for (const c of w.criteria.length ? w.criteria : ['any item of the selected kind']) ul.append(el('li', '', c));
	d.append(ul);
	d.append(el('div', 'muted', `Where: outlined on this page, a browser notification, and your Signal inbox (${w.notify.join(', ')}). When: each time this page is captured${$<HTMLInputElement>('autocheck').checked ? ', including automatically when you open it while this panel is open' : ''}. A new alert is recorded when the set of matching items or their values changes. “Possible” items (missing information) never alert.`));
	box.append(d);
	btn.textContent = 'Update alert to the current filters'; stop.hidden = false;
}

$('watch').addEventListener('click', () => void busy($<HTMLButtonElement>('watch'), 'Saving alert…', async () => {
	const tab = await activeTab();
	const intent = JSON.parse(currentIntent());
	const kinds = (intent.target?.type ?? []).map(humanType).join(' / ');
	const what = (intent.criteria ?? []).map((c: { label: string }) => c.label).join(' · ');
	const scope = document.querySelector<HTMLInputElement>('#scope input:checked')?.value === 'exact' ? 'exact' : 'parent';
	const target = scope === 'parent' ? parentLocator(tab.url!) : pageLocator(tab.url!);
	await setWatch(conn!.client, target, intent, `${kinds}${what ? `: ${what}` : ''}`.slice(0, 200));
	await clearOtherScope(conn!.client, tab.url!, target); // one page, one watch
	watched = await watchedPages(conn!.client);
	await captureTab(tab); // evaluate now: the current matches are the first alert
}));
$('unwatch').addEventListener('click', () => void busy($<HTMLButtonElement>('unwatch'), 'Stopping alerts…', async () => {
	const tab = await activeTab();
	await stopWatch(conn!.client, tab.url!);
	watched = await watchedPages(conn!.client);
	await renderWatch();
	status('Alerts stopped for this page. Earlier alerts are kept.');
}));
$('autocheck').addEventListener('change', () => { void chrome.storage.local.set({ 'signal.autocheck': $<HTMLInputElement>('autocheck').checked }); void renderWatch(); });

// Automatic check: a watched page opened in this window is captured once it has loaded, so alerts do not
// depend on remembering to press Capture. Runs only while the panel is open, only for watched pages, and
// only where access was already granted (it never asks for permission on its own).
const recent = new Map<string, number>();
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
	if (change.status !== 'complete' || !conn || !tab.url || !$<HTMLInputElement>('autocheck').checked) return;
	let locator: string; try { locator = pageLocator(tab.url); } catch { return; }
	void renderWatch();
	const scopeKey = watched.has(locator) ? locator : watched.has(parentLocator(tab.url)) ? parentLocator(tab.url) : null;
	if (!scopeKey || Date.now() - (recent.get(locator) ?? 0) < 15_000) return;
	recent.set(locator, Date.now()); // per exact address: panning to a new map position is a new check
	setTimeout(() => void (async () => {
		// Only if the tab is still on the watched search: never read a page the person navigated to meanwhile.
		const now = await chrome.tabs.get(tabId).catch(() => null);
		if (!now?.url) return;
		const still = pageLocator(now.url) === scopeKey || parentLocator(now.url) === scopeKey;
		if (still) await captureTab(now, true);
	})().catch(() => undefined), 2500); // let the page render its listings
});

// ------------------------------------------------------------------ wiring

$('connect-form').addEventListener('submit', (ev) => {
	ev.preventDefault();
	void busy($('connect-form').querySelector('button')!, 'Connecting…', async () => {
		conn = await connect(instanceOrigin($<HTMLInputElement>('instance').value));
		status('');
		await refreshSession();
	});
});
$('signin-form').addEventListener('submit', (ev) => {
	ev.preventDefault();
	void busy($('signin-form').querySelector('button')!, 'Signing in…', async () => {
		await conn!.client.signIn({ email: $<HTMLInputElement>('email').value, password: $<HTMLInputElement>('password').value });
		$<HTMLInputElement>('password').value = '';
		status(''); await refreshSession();
	});
});
/**
 * Capture a tab: record its structure (through the page's watch when it has one), notify about a recorded
 * alert, show the overlay on the page, and refresh facets and results.
 */
async function captureTab(tab: chrome.tabs.Tab, quiet = false): Promise<void> {
	const snap = await snapshotTab(tab, !quiet);
	const c = await capture(conn!.client, snap);
	if (c.alert) await notify(c.alert);
	await showOverlay(tab.id!).catch(() => undefined); // alerts and matches shown on the page itself
	const kb = (n: number) => `${Math.round(n / 1024).toLocaleString()} KB`;
	const message = `${quiet ? 'Checked automatically. ' : ''}${c.alert ? 'Alert recorded. ' : ''}Captured: ${c.entities} entities${c.unchanged ? ' (unchanged since last capture)' : ''}. Page ${kb(snap.originalChars)}, structure-relevant part ${kb(snap.chars)} sent; Signal keeps the structure, not the page.`;
	await renderPages();
	await refreshFacets(undefined, false);
	if (facetData) await runDiscovery(`${message} `); else status(message);
	await renderWatch();
}
$('capture').addEventListener('click', () => void busy($<HTMLButtonElement>('capture'), 'Capturing…', async () => captureTab(await activeTab())));
$('overlay').addEventListener('click', () => void busy($<HTMLButtonElement>('overlay'), 'Opening alerts on the page…', async () => {
	const tab = await activeTab();
	await showOverlay(tab.id!);
	status('Alerts are shown on the page while this panel is open.');
}));
$('clear').addEventListener('click', async () => { await saveWorkingSet([]); $('results').replaceChildren(); await renderPages(); await refreshFacets(); status('Cleared. Recorded pages stay in your Signal instance.'); });
$('intent-form').addEventListener('submit', (ev) => ev.preventDefault());
$('json-mode').addEventListener('change', () => {
	jsonMode = $<HTMLInputElement>('json-mode').checked;
	$<HTMLTextAreaElement>('intent').readOnly = !jsonMode;
	$<HTMLFieldSetElement>('controls').disabled = jsonMode;
	if (!jsonMode) $<HTMLTextAreaElement>('intent').value = currentIntent();
	void persistEditor();
});
$('intent').addEventListener('change', () => void persistEditor());
$('discover').addEventListener('click', () => void busy($<HTMLButtonElement>('discover'), 'Evaluating…', runDiscovery));
$('signout').addEventListener('click', async () => { await conn?.client.signOut().catch(() => undefined); await refreshSession(); });
const disconnect = async () => { await forgetInstance(conn?.client); conn = null; $('results').replaceChildren(); show('connect'); $('who').textContent = ''; };
$('disconnect').addEventListener('click', disconnect);
$('disconnect-signin').addEventListener('click', disconnect);

// The overlay on a page asks this panel (the only holder of the session) to call Signal.
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
	if (msg?.type !== 'signal.overlay') return;
	if (!conn) { respond({ ok: false, error: 'Signal is not connected' }); return; }
	relayOverlay(conn.client, msg, sender).then((value) => respond({ ok: true, value }), (e) => respond({ ok: false, error: errorText(e) }));
	return true;
});

(async () => {
	await lockStorage();
	$<HTMLInputElement>('autocheck').checked = (await chrome.storage.local.get('signal.autocheck'))['signal.autocheck'] ?? true;
	try {
		const draft = JSON.parse((await intentDraft()) ?? 'null') as { editor?: EditorState; jsonMode?: boolean; json?: string } | null;
		if (draft?.editor?.filters) editor = draft.editor;
		if (draft?.jsonMode && draft.json) { jsonMode = true; $<HTMLInputElement>('json-mode').checked = true; $<HTMLTextAreaElement>('intent').readOnly = false; $<HTMLFieldSetElement>('controls').disabled = true; $<HTMLTextAreaElement>('intent').value = draft.json; }
	} catch { /* an older draft format: start fresh */ }
	const origin = await savedInstance();
	if (!origin) return show('connect');
	try { conn = await connect(origin, false); await refreshSession(); } catch (e) { show('connect'); $<HTMLInputElement>('instance').value = origin; status(errorText(e), true); }
})();
