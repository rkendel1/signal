import { api, go, m, q, route, type Any } from '../app.ts';
import { add, ago, badge, h, toast } from '../dom.ts';

const KINDS: Array<[string, string]> = [['finding_new', 'New findings'], ['finding_changed', 'Materially changed findings'], ['finding_resolved', 'Resolved findings'], ['finding_reopened', 'Reopened findings'], ['finding_closed', 'Superseded or invalid findings'], ['source_failure', 'A source fails'], ['source_recovered', 'A source recovers'], ['source_stale', 'A source goes stale']];

export async function notificationsView(el: HTMLElement) {
	const { params } = route();
	const all = params.get('all') === '1';
	const [list, prefs] = await Promise.all([q(api.notices.list, { active: !all, limit: 200 }), q(api.notices.getPreferences)]);
	add(el, h('div', { class: 'toolbar' }, h('h1', null, 'Notifications'),
		h('label', { class: 'field inline' }, h('input', { type: 'checkbox', checked: all, onchange: (e: Event) => go(`#/notifications${(e.target as HTMLInputElement).checked ? '?all=1' : ''}`) }), h('span', null, 'include acknowledged and snoozed')),
		h('button', { onclick: async () => { const r = await m(api.notices.acknowledge, { all: true }); toast(`${r.acknowledged} acknowledged`); } }, 'Acknowledge all')));
	const left = h('div', { class: 'pane' }, list.length ? h('ul', { class: 'feed' }, list.map((n: Any) => h('li', { class: `card ${n.active ? '' : 'acked'}` },
		h('div', { class: 'row between' }, h('strong', null, n.title), h('span', { class: 'muted small', title: n.createdAt }, ago(n.createdAt))),
		h('div', { class: 'row wrap' }, badge(n.severity, n.severity === 'critical' ? 'warn' : n.severity === 'warning' ? 'changed' : ''), badge(n.kind.replace('_', ' ')), n.acknowledged ? badge('acknowledged', 'closed') : null, n.snoozedUntil && n.snoozedUntil > new Date().toISOString() ? badge(`snoozed until ${new Date(n.snoozedUntil).toLocaleString()}`, 'muted') : null, n.delivered ? badge('shown in browser', 'muted') : null),
		h('p', { class: 'summary' }, n.body),
		h('div', { class: 'row' },
			n.findingId ? h('a', { class: 'button', href: `#/findings/${n.findingId}` }, 'Open finding') : n.sourceId ? h('a', { class: 'button', href: `#/sources/${n.sourceId}` }, 'Open source') : null,
			n.active ? h('button', { onclick: () => m(api.notices.acknowledge, { noticeId: n.id }) }, 'Acknowledge') : null,
			n.active ? h('button', { onclick: () => m(api.notices.snooze, { noticeId: n.id, hours: 24 }) }, 'Snooze 24 h') : null)))) : h('div', { class: 'empty' }, h('p', null, 'Nothing new. Signal notifies on meaningful changes only: a new, changed, resolved or reopened finding, or a source problem.')));
	const p = { ...prefs, kinds: { ...prefs.kinds } };
	const right = h('aside', { class: 'detail', 'data-editing': '1' },
		h('h2', null, 'Preferences'),
		h('p', { class: 'small muted' }, 'Everything is kept in this inbox. These settings decide what is created and what reaches your browser as a notification (the extension shows them while the browser runs; nothing is sent while it is closed — no e-mail or mobile push channel exists yet).'),
		h('label', { class: 'field' }, h('span', null, 'Browser notifications from'), h('select', { onchange: (e: Event) => (p.minSeverity = (e.target as HTMLSelectElement).value) }, ['info', 'warning', 'critical'].map((s) => h('option', { value: s, ...(s === p.minSeverity ? { selected: true } : {}) }, `${s} and above`)))),
		...KINDS.map(([k, label]) => h('label', { class: 'field inline' }, h('input', { type: 'checkbox', checked: p.kinds[k], onchange: (e: Event) => (p.kinds[k] = (e.target as HTMLInputElement).checked) }), h('span', null, label))),
		h('label', { class: 'field inline' }, h('input', { type: 'checkbox', checked: p.includePossible, onchange: (e: Event) => (p.includePossible = (e.target as HTMLInputElement).checked) }), h('span', null, 'Also for “possible” findings (evidence missing)')),
		h('label', { class: 'field inline' }, h('input', { type: 'checkbox', checked: p.browser, onchange: (e: Event) => (p.browser = (e.target as HTMLInputElement).checked) }), h('span', null, 'Browser notifications')),
		h('label', { class: 'field inline' }, h('input', { type: 'checkbox', checked: p.contextual, onchange: (e: Event) => (p.contextual = (e.target as HTMLInputElement).checked) }), h('span', null, 'Show related findings on pages I visit')),
		h('div', { class: 'row' }, h('button', { class: 'primary', onclick: async () => { await m(api.notices.setPreferences, { prefs: JSON.stringify(p) }); toast('Saved'); } }, 'Save')));
	add(el, h('div', { class: 'split' }, left, right));
}
