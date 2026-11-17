/**
 * Signal's web app. One coherent workflow — Connect, Understand, Define, Evaluate, Monitor, Surface,
 * Investigate, Refine, Act — over one model. Views are projections of the same sources, criteria and
 * findings; none has intelligence of its own. Live: the page re-renders when FeltDB reports a change.
 */
import { act, api, client, go, q, route, type Any } from './app.ts';
import { badge, h, toast } from './dom.ts';
import { findingsView } from './views/findings.ts';
import { sourcesView } from './views/sources.ts';
import { criteriaView } from './views/criteria.ts';
import { entitiesView, identityView } from './views/entities.ts';
import { activityView } from './views/activity.ts';

const root = document.getElementById('app')!;
let principal: Any = null;
let rendering = false, again = false;

const NAV: Array<[string, string, string]> = [
	['findings', 'Findings', 'What deserves attention now'],
	['sources', 'Sources', 'What Signal can see'],
	['criteria', 'Criteria', 'What you care about'],
	['entities', 'Entities', 'Everything sources describe'],
	['identity', 'Identity', 'Matches waiting for a decision'],
	['activity', 'Activity', 'What Signal did, and why'],
];

async function render() {
	if (rendering) { again = true; return; }
	rendering = true;
	try {
		do {
			again = false;
			const { view } = route();
			const [summary, queue] = await Promise.all([q(api.engine.summary), q(api.entities.identityQueue)]);
			const body = h('main', { class: 'content' });
			const shell = h('div', { class: 'shell' },
				h('header', { class: 'top' },
					h('a', { class: 'brand', href: '#/findings' }, h('span', { class: 'dot' }), 'Signal'),
					h('div', { class: 'chips' },
						badge(`${summary.openFindings} open findings`, summary.unacknowledged ? 'accent' : ''),
						badge(`${summary.sources} sources · ${summary.records.toLocaleString('en-US')} records`),
						summary.sourcesWithIssues ? badge(`${summary.sourcesWithIssues} source${summary.sourcesWithIssues > 1 ? 's' : ''} need attention`, 'warn') : null,
						summary.synthetic ? badge('includes synthetic data', 'synthetic') : null),
					h('div', { class: 'who' }, principal?.displayName ?? principal?.id, ' ', h('button', { class: 'link', onclick: async () => { await client.signOut(); location.reload(); } }, 'Sign out'))),
				h('nav', { class: 'side', 'aria-label': 'Sections' }, NAV.map(([id, label, hint]) => h('a', { href: `#/${id}`, class: view === id ? 'active' : '', title: hint }, label, id === 'identity' && queue.length ? h('span', { class: 'count' }, String(queue.length)) : null))),
				body);
			const scroll = document.querySelector('.content')?.scrollTop ?? 0;
			const detailScroll = document.querySelector('.detail')?.scrollTop ?? 0;
			const views: Record<string, (el: HTMLElement) => Promise<void>> = { findings: findingsView, sources: sourcesView, criteria: criteriaView, entities: entitiesView, identity: identityView, activity: activityView };
			if (!summary.sources && view === 'findings') await welcome(body);
			else await (views[view] ?? findingsView)(body);
			root.replaceChildren(shell);
			body.scrollTop = scroll;
			const d = document.querySelector('.detail'); if (d) d.scrollTop = detailScroll;
		} while (again);
	} catch (e) {
		root.replaceChildren(h('div', { class: 'content' }, h('p', { class: 'error' }, (e as Error).message)));
	} finally { rendering = false; }
}

async function welcome(el: HTMLElement) {
	el.append(
		h('section', { class: 'welcome' },
			h('h1', null, 'What is important right now?'),
			h('p', { class: 'lede' }, 'Signal brings together the sources you connect, evaluates them continuously against criteria you define, and surfaces findings you can trace back to every piece of evidence.'),
			h('ol', { class: 'steps' },
				h('li', null, h('b', null, 'Connect'), ' files, APIs, systems that push records, pages you capture in your browser, or records you enter.'),
				h('li', null, h('b', null, 'Understand'), ' what each source covers, how fresh it is, and how its records match other sources.'),
				h('li', null, h('b', null, 'Define'), ' what matters: required conditions, exclusions, preferences, freshness.'),
				h('li', null, h('b', null, 'Monitor'), ' — every change in a source is evaluated as it arrives. Findings appear, change and resolve with their history.')),
			h('div', { class: 'row' },
				h('button', { class: 'primary', onclick: () => go('#/sources?add=1') }, 'Connect a source'),
				h('button', { onclick: async (e: Event) => {
					(e.currentTarget as HTMLButtonElement).disabled = true;
					try { await act(api.workspace.loadExample); toast('Synthetic example loaded'); } catch (x) { toast((x as Error).message, 'error'); }
				} }, 'Load a synthetic example')),
			h('p', { class: 'muted small' }, 'The example is invented data (a fictional city): two sources, one criteria. It is labelled synthetic everywhere it appears.')));
}

async function signIn() {
	const s = await client.session();
	if (s.principal) { principal = s.principal; return true; }
	const devUsers: Array<[string, string]> = [['ada', 'Ada (member, admin)'], ['bob', 'Bob (member)'], ['grace', 'Grace (viewer)']];
	const email = h('input', { type: 'email', placeholder: 'Email', autocomplete: 'username' });
	const pw = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
	const err = h('p', { class: 'error' });
	root.replaceChildren(h('div', { class: 'signin' },
		h('h1', null, h('span', { class: 'dot' }), 'Signal'),
		h('form', { onsubmit: async (e: Event) => { e.preventDefault(); try { await client.signIn({ email: email.value, password: pw.value }); location.reload(); } catch (x) { err.textContent = (x as Error).message; } } },
			email, pw, h('button', { class: 'primary', type: 'submit' }, 'Sign in'), err),
		s.environment.production ? null : h('div', null, h('p', { class: 'muted small' }, 'Development: sign in as a declared user'),
			h('div', { class: 'row' }, devUsers.map(([id, label]) => h('button', { onclick: async () => { await client.signInAsDevUser(id); location.reload(); } }, label))))));
	return false;
}

let timer: ReturnType<typeof setTimeout> | undefined;
/** Live updates never clobber work in progress: while a form or dialog is open, offer the update instead. */
function schedule() {
	clearTimeout(timer);
	timer = setTimeout(() => {
		const busy = document.querySelector('.modal-back') || (document.activeElement && document.activeElement.closest('[data-editing]'));
		if (!busy) { document.querySelector('.banner')?.remove(); render(); return; }
		if (!document.querySelector('.banner')) document.body.appendChild(h('button', { class: 'banner primary', onclick: () => { document.querySelector('.banner')?.remove(); render(); } }, 'New information arrived — refresh view'));
	}, 120);
}

(async () => {
	await client.handleRedirect().catch(() => null);
	if (!(await signIn())) return;
	window.addEventListener('hashchange', render);
	// Live: any committed change to Signal's state (a push from another system, a refresh, another tab) re-renders.
	client.onChange(() => schedule());
	await render();
})();
