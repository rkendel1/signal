/**
 * The side panel: a capture client for Signal. Connect → sign in → choose a browser-capture source →
 * capture the page you are viewing → see which of your findings its items are part of. Criteria, sources and
 * investigation live in the Signal app; the panel does not duplicate them.
 */
import type { FeltKitClient } from '@feltdb/feltkit/client';
import { activeTab, affected, can, capture, captureSources, chooseSource, chosenSource, connect, createCaptureSource, errorText, forgetInstance, instanceOrigin, lockStorage, savedInstance, snapshotTab, type Connection } from './host.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (text: string, error = false) => { const s = $('status'); s.textContent = text; s.classList.toggle('error', error); };
const show = (id: 'connect' | 'signin' | 'work') => { for (const s of ['connect', 'signin', 'work']) $(s).hidden = s !== id; };
let conn: Connection | null = null;

function el(tag: string, props: Record<string, string> = {}, ...children: Array<Node | string | null>) {
	const e = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) e.setAttribute(k, v);
	for (const c of children) if (c !== null) e.append(c);
	return e;
}

async function start() {
	await lockStorage();
	const origin = await savedInstance();
	if (!origin) return show('connect');
	try { conn = await connect(origin, false); } catch (e) { status(errorText(e), true); return show('connect'); }
	await afterConnect();
}

async function afterConnect() {
	const s = conn!.session;
	if (!s.principal) {
		show('signin');
		const dev = $('devusers'); dev.replaceChildren();
		if (!s.environment.production) for (const [id, label] of [['ada', 'Ada (member)'], ['bob', 'Bob (member)']]) {
			const b = el('button', { type: 'button', class: 'secondary' }, `Development: ${label}`);
			b.onclick = async () => { try { await conn!.client.signInAsDevUser(id); conn = await connect(conn!.origin, false); await afterConnect(); } catch (e) { status(errorText(e), true); } };
			dev.append(b);
		}
		return;
	}
	$('who').textContent = s.principal.displayName ?? s.principal.id;
	($('open-app') as HTMLAnchorElement).href = conn!.origin;
	show('work');
	const writable = can(s.permissions, 'signal.write');
	($('capture') as HTMLButtonElement).disabled = !writable;
	if (!writable) status('Your account can read Signal but not add information (it needs the member role).', true);
	await loadSources();
}

async function loadSources(select?: string) {
	const c = conn!.client;
	const list = await captureSources(c);
	const sel = $<HTMLSelectElement>('source');
	sel.replaceChildren(...list.map((x) => el('option', { value: x.id }, `${x.name} — ${x.records} items${x.status !== 'connected' ? ` (${x.status})` : ''}`)));
	if (!list.length) { sel.append(el('option', { value: '' }, 'No capture source yet — create one below')); ($('new-source') as HTMLDetailsElement).open = true; }
	const want = select ?? (await chosenSource());
	if (want && list.some((x) => x.id === want)) sel.value = want;
	await chooseSource(sel.value || null);
}

function renderResult(r: Awaited<ReturnType<typeof capture>>) {
	const run = r.run;
	$('result').replaceChildren(el('p', {}, `${r.title ?? r.url}: ${r.received} item${r.received === 1 ? '' : 's'} read — `,
		r.newInformation ? `${r.added} new, ${r.changed} changed` : 'nothing new since the last capture',
		run ? `. ${run.entities} re-evaluated: ${run.created} new, ${run.changed} changed, ${run.closed} closed finding${run.closed === 1 ? '' : 's'}.` : '.'));
}

async function renderAffected(sourceId: string, keys: string[]) {
	const list = await affected(conn!.client, sourceId, keys);
	const ul = $('affected');
	if (!list.length) { ul.replaceChildren(el('li', { class: 'muted' }, keys.length ? 'None of the items on this page is part of an open finding.' : 'Signal found no items of the chosen types on this page.')); return; }
	ul.replaceChildren(...list.map((f) => {
		const a = el('a', { href: `${conn!.origin}/#/findings/${encodeURIComponent(f.id)}`, target: '_blank', rel: 'noopener' }, f.entityLabel ?? f.recordKey);
		return el('li', { class: 'cand' }, el('div', { class: 'head' }, a, el('span', { class: `badge ${f.qualification}` }, f.qualification)), el('div', { class: 'muted' }, `${f.criteriaName} · ${f.change} · ${f.sourceCount} source${f.sourceCount === 1 ? '' : 's'}`), el('div', {}, f.summary));
	}));
}

$('connect-form').addEventListener('submit', async (e) => {
	e.preventDefault();
	try { status('Connecting…'); conn = await connect(instanceOrigin($<HTMLInputElement>('instance').value)); status(''); await afterConnect(); } catch (x) { status(errorText(x), true); }
});
$('signin-form').addEventListener('submit', async (e) => {
	e.preventDefault();
	try { await conn!.client.signIn({ email: $<HTMLInputElement>('email').value, password: $<HTMLInputElement>('password').value }); conn = await connect(conn!.origin, false); status(''); await afterConnect(); } catch (x) { status(errorText(x), true); }
});
$('source').addEventListener('change', () => void chooseSource($<HTMLSelectElement>('source').value || null));
$('source-form').addEventListener('submit', async (e) => {
	e.preventDefault();
	try {
		const types = $<HTMLInputElement>('src-types').value.split(',').map((x) => x.trim()).filter(Boolean);
		const id = await createCaptureSource(conn!.client, $<HTMLInputElement>('src-name').value, $<HTMLInputElement>('src-entity').value.trim(), types);
		($('new-source') as HTMLDetailsElement).open = false;
		await loadSources(id); status('Capture source created.');
	} catch (x) { status(errorText(x), true); }
});
$('capture').addEventListener('click', async () => {
	const btn = $<HTMLButtonElement>('capture');
	const sourceId = $<HTMLSelectElement>('source').value;
	if (!sourceId) return status('Create or choose a capture source first.', true);
	btn.disabled = true;
	try {
		status('Reading the page…');
		const snap = await snapshotTab(await activeTab());
		status('Sending to Signal…');
		const r = await capture(conn!.client as FeltKitClient, sourceId, snap);
		renderResult(r);
		await renderAffected(sourceId, r.recordKeys);
		await loadSources(sourceId);
		status('Captured.');
	} catch (e) { status(errorText(e), true); } finally { btn.disabled = false; }
});
$('signout').addEventListener('click', async () => { await conn?.client.signOut().catch(() => undefined); conn = await connect(conn!.origin, false); await afterConnect(); });
for (const id of ['disconnect', 'disconnect-signin']) $(id).addEventListener('click', async () => { await forgetInstance(conn?.client); conn = null; status(''); show('connect'); });

// ------------------------------------------------------------------ ambient: which sites show the overlay
const send = <T>(m: Record<string, unknown>) => chrome.runtime.sendMessage<{ ok: boolean; value?: T; error?: string }>(m);
async function siteState() {
	const sites = (await send<string[]>({ type: 'signal.sites' })).value ?? [];
	let origin: string | null = null;
	try { origin = new URL((await activeTab()).url!).origin; } catch { /* no web page */ }
	const on = !!origin && sites.includes(origin);
	$('site-toggle').textContent = on ? 'Hide Signal on this site' : 'Show Signal on this site';
	($('site-toggle') as HTMLButtonElement).disabled = !origin;
	$('site-state').textContent = origin ? (on ? `on for ${new URL(origin).host}` : '') : 'open a web page';
	$('sites-list').textContent = sites.length ? `Enabled on: ${sites.map((o) => new URL(o).host).join(', ')}` : '';
	return { origin, on };
}
$('site-toggle').addEventListener('click', async () => {
	const { origin, on } = await siteState();
	if (!origin) return;
	// The permission prompt needs this click (a user gesture in an extension page).
	if (!on && !(await chrome.permissions.request({ origins: [`${origin}/*`] }))) return status(`Access to ${origin} was not granted.`, true);
	const tab = await activeTab();
	const r = await send({ type: 'signal.enableSite', origin, on: !on, tabId: tab.id });
	if (!r.ok) return status(r.error ?? 'failed', true);
	await siteState();
	status(on ? 'Signal hidden on this site.' : 'Signal is now shown on this site.');
});
$('tick').addEventListener('click', async () => {
	$('tick-state').textContent = 'checking…';
	const r = await send<{ refreshed?: number; shown?: number; connected?: boolean }>({ type: 'signal.tick' });
	$('tick-state').textContent = r.ok ? (r.value?.connected === false ? 'not connected' : `${r.value?.refreshed ?? 0} feeds refreshed, ${r.value?.shown ?? 0} notifications`) : r.error ?? 'failed';
});

void start().then(() => siteState()).catch(() => undefined);
