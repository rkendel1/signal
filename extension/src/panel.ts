/** Side panel UI. All page-derived text is rendered with textContent; nothing observed is executed. */
import type { FeltKitClient, SessionInfo } from '@feltdb/feltkit/client';
import {
	activeTab, capture, connect, discover, errorText, forgetInstance, instanceOrigin, intentDraft, lockStorage, navigableTarget,
	relayOverlay, savedInstance, saveIntentDraft, saveWorkingSet, showOverlay, snapshotTab, workingSet, type Captured, type DiscoveryView
} from './host.ts';

const EXAMPLE_INTENT = {
	schema: 'signal.intent/v1', id: 'example', version: 1, name: 'In-stock products under $50',
	target: { type: ['Product'] },
	criteria: [
		{ id: 'price', label: 'price under $50', where: { attr: 'price', op: 'lt', value: 50 } },
		{ id: 'stock', label: 'in stock', where: { attr: 'availability', op: 'eq', value: 'InStock' } }
	]
};

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
			if (cand.changed) li.append(el('div', 'muted', `Changed: ${cand.changed.fields.join(', ')}`));
			if (cand.missing.length) li.append(el('div', 'muted', `Undecided: ${cand.missing.join('; ')}`));
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
			li.append(el('div', '', `${step.kind.replace('_', ' ')}: ${step.reason}`));
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
$('capture').addEventListener('click', () => void busy($<HTMLButtonElement>('capture'), 'Capturing…', async () => {
	const tab = await activeTab();
	const snap = await snapshotTab(tab);
	const c: Captured = await capture(conn!.client, snap);
	status(`Captured: ${c.entities} entities${c.unchanged ? ' (unchanged since last capture)' : ''}.`);
	await renderPages();
}));
$('overlay').addEventListener('click', () => void busy($<HTMLButtonElement>('overlay'), 'Opening alerts on the page…', async () => {
	const tab = await activeTab();
	await showOverlay(tab.id!);
	status('Alerts are shown on the page while this panel is open.');
}));
$('clear').addEventListener('click', async () => { await saveWorkingSet([]); $('results').replaceChildren(); await renderPages(); status('Cleared. Recorded pages stay in your Signal instance.'); });
$('example').addEventListener('click', () => { $<HTMLTextAreaElement>('intent').value = JSON.stringify(EXAMPLE_INTENT, null, 2); void saveIntentDraft($<HTMLTextAreaElement>('intent').value); });
$('intent').addEventListener('change', () => void saveIntentDraft($<HTMLTextAreaElement>('intent').value));
$('discover').addEventListener('click', () => void busy($<HTMLButtonElement>('discover'), 'Evaluating…', async () => {
	const intent = $<HTMLTextAreaElement>('intent').value;
	await saveIntentDraft(intent);
	const r = await discover(conn!.client, intent, await workingSet());
	renderResults(r);
	const n = (s: string) => r.candidates.filter((c) => c.status === s).length;
	status(`${n('match')} match · ${n('possible')} possible · ${n('non_match')} not a match`);
}));
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
	$<HTMLTextAreaElement>('intent').value = (await intentDraft()) ?? JSON.stringify(EXAMPLE_INTENT, null, 2);
	const origin = await savedInstance();
	if (!origin) return show('connect');
	try { conn = await connect(origin, false); await refreshSession(); } catch (e) { show('connect'); $<HTMLInputElement>('instance').value = origin; status(errorText(e), true); }
})();
