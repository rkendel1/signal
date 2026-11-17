import { api, m, q, type Any } from '../app.ts';
import { add, put, ago, badge, h, toast } from '../dom.ts';

export async function activityView(el: HTMLElement) {
	const a: Any = await q(api.engine.activity, { limit: 60 });
	add(el, 
		h('div', { class: 'toolbar' }, h('h1', null, 'Activity'),
			h('button', { onclick: async () => { const r = await m(api.engine.sweep, {}); toast(`Freshness sweep: ${r.entities} entities, ${r.closed} closed, ${r.changed} changed`); }, title: 'Re-evaluate entities with open findings now: evidence ages even when no source changes. A FeltKit schedule can run this as the signal.sweep job.' }, 'Run freshness sweep')),
		h('p', { class: 'muted' }, 'Refreshes are not new information; new information is not necessarily a meaningful change; a meaningful change is not necessarily a finding. Each is recorded separately.'),
		h('div', { class: 'cols' },
			h('section', null, h('h2', null, 'Evaluations'),
				h('table', { class: 'grid small' }, h('thead', null, h('tr', null, ['When', 'Cause', 'Entities', 'New', 'Changed', 'Closed', 'Reopened', 'ms'].map((x) => h('th', null, x)))),
					h('tbody', null, a.runs.map((r: Any) => h('tr', null, h('td', { title: r.at }, ago(r.at)), h('td', null, badge(r.cause.kind), ' ', r.cause.label), h('td', null, String(r.entities)), h('td', null, String(r.created)), h('td', null, String(r.changed)), h('td', null, String(r.closed)), h('td', null, String(r.reopened)), h('td', null, String(r.durationMs))))))),
			h('section', null, h('h2', null, 'Source refreshes'),
				h('table', { class: 'grid small' }, h('thead', null, h('tr', null, ['When', 'Source', 'Trigger', 'Result', 'New', 'Changed', 'Same', 'Withdrawn'].map((x) => h('th', null, x)))),
					h('tbody', null, a.ingestions.map((i: Any) => h('tr', null, h('td', { title: i.at }, ago(i.at)), h('td', null, i.sourceName), h('td', null, i.trigger), h('td', null, i.status === 'ok' ? (i.added + i.changed + i.retracted ? 'new information' : 'nothing new') : badge(i.status, 'warn'), i.error ? h('div', { class: 'error' }, i.error) : null), h('td', null, String(i.added)), h('td', null, String(i.changed)), h('td', null, String(i.unchanged)), h('td', null, String(i.retracted)))))))),
	);
}
