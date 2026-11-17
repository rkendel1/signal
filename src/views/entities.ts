import { api, go, m, q, route, type Any } from '../app.ts';
import { add, put, ago, badge, day, fmt, h, toast } from '../dom.ts';

export async function entitiesView(el: HTMLElement) {
	const { id, params } = route();
	const search = params.get('s') ?? '';
	const list: Any[] = await q(api.entities.list, { ...(search ? { search } : {}), limit: 300 });
	add(el, h('div', { class: 'toolbar' }, h('h1', null, 'Entities'),
		h('input', { type: 'search', placeholder: 'Search by name or address', value: search, onchange: (e: Event) => go(`#/entities${id ? '/' + id : ''}?s=${encodeURIComponent((e.target as HTMLInputElement).value)}`) }),
		h('span', { class: 'muted small' }, `${list.length} shown`)));
	const left = h('div', { class: 'pane' }, h('ul', { class: 'feed compact' }, list.map((e) => h('li', { class: `card ${e.id === id ? 'active' : ''}`, onclick: () => go(`#/entities/${e.id}${search ? `?s=${encodeURIComponent(search)}` : ''}`) },
		h('div', { class: 'row between' }, h('strong', null, e.label ?? e.id), e.openFindings ? badge(`${e.openFindings} finding${e.openFindings > 1 ? 's' : ''}`, 'accent') : null),
		h('div', { class: 'meta' }, `${e.type} · ${e.records} record${e.records === 1 ? '' : 's'} from ${e.sources} source${e.sources === 1 ? '' : 's'}`)))));
	const right = h('aside', { class: 'detail' });
	if (id) await detail(right, id); else right.append(h('p', { class: 'muted' }, 'An entity is what several sources describe. Each source’s record stays separate; here they are lined up.'));
	add(el, h('div', { class: 'split' }, left, right));
}

async function detail(el: HTMLElement, id: string) {
	const d: Any = await q(api.entities.get, { entityId: id });
	const e = d.entity;
	add(el, 
		h('h2', null, e.label ?? e.id),
		h('p', { class: 'muted' }, `${e.type}${e.lat !== null ? ` · ${e.lat.toFixed(5)}, ${e.lng.toFixed(5)}` : ''} · identifiers: ${Object.entries(e.keys.ids).map(([k, v]) => `${k} ${(v as string[]).join('/')}`).join(', ') || 'none'}`),
		d.findings.length ? h('div', { class: 'row wrap' }, d.findings.map((f: Any) => h('a', { href: `#/findings/${f.id}`, class: 'button' }, badge(f.qualification, f.qualification), ` ${f.status} — ${f.summary.slice(0, 60)}`))) : null,
		h('h3', null, 'What each source says'),
		h('div', { class: 'scrollx' }, h('table', { class: 'grid small matrix' },
			h('thead', null, h('tr', null, h('th', null, 'Attribute'), d.records.map((r: Any) => h('th', null, r.source?.name ?? '?', h('div', { class: 'muted' }, r.recordKey), r.source?.synthetic ? badge('synthetic', 'synthetic') : null, !r.current ? badge('withdrawn', 'closed') : null)))),
			h('tbody', null, d.matrix.map((row: Any) => h('tr', { class: row.agreement }, h('td', null, row.attr, row.agreement === 'conflict' ? h('div', null, badge('disagree', 'warn')) : row.agreement === 'agree' ? h('div', { class: 'muted' }, 'agree') : null),
				row.cells.map((c: Any) => h('td', { title: c ? `raw: ${c.raw ?? '—'} · ${c.transform ?? ''}` : 'not stated' }, c ? fmt(c.value) : h('span', { class: 'muted' }, '—')))))))),
		h('h3', null, 'Records and identity'),
		d.records.map((r: Any) => h('div', { class: 'record' },
			h('div', { class: 'row between' }, h('strong', null, `${r.source?.name} · ${r.recordKey}`), badge(r.link.status === 'unmatched' && d.records.length > 1 ? 'first record' : r.link.status, r.link.status === 'ambiguous' || r.link.status === 'conflict' ? 'warn' : r.link.status === 'manual' ? 'accent' : '')),
			h('p', { class: 'small' }, r.link.status === 'unmatched' && d.records.length > 1 ? 'This record created the entity; the other records were matched to it.' : `${r.link.basis}: ${r.link.reason}`, ` (${r.link.decidedBy === 'user' ? 'decided by a person' : 'decided by Signal'}, confidence ${Math.round(r.link.confidence * 100)}%)`),
			h('div', { class: 'row' },
				h('button', { onclick: async () => { const x = await m(api.entities.separate, { sourceId: r.source.id, recordKey: r.recordKey }); toast(x.unchanged ? 'Kept separate' : `Separated; ${x.entities} entities re-evaluated`); } }, 'Not the same thing'),
				r.link.options.map((o: Any) => h('button', { onclick: async () => { const x = await m(api.entities.assign, { sourceId: r.source.id, recordKey: r.recordKey, entityId: o.entityId }); toast(`Linked; ${x.entities} entities re-evaluated`); go(`#/entities/${o.entityId}`); } }, `Same as ${o.label ?? o.entityId}${o.distanceM !== null ? ` (${o.distanceM} m)` : ''}`))),
			h('details', null, h('summary', null, `${r.versions.length} version${r.versions.length === 1 ? '' : 's'}`),
				h('table', { class: 'grid small' }, h('thead', null, h('tr', null, ['Version', 'State', 'Observed', 'As of', 'Received by', 'Values'].map((x) => h('th', null, x)))),
					h('tbody', null, r.versions.map((v: Any) => h('tr', { class: v.status !== 'current' ? 'old' : '' }, h('td', null, `v${v.version}`), h('td', null, v.status, v.retractReason ? h('div', { class: 'muted' }, v.retractReason) : null), h('td', { title: v.observedAt }, day(v.observedAt)), h('td', null, day(v.validAt)), h('td', null, v.ingestion ? `${v.ingestion.trigger} ${ago(v.ingestion.at)}` : '—'),
						h('td', { class: 'mono' }, Object.entries(v.attributes).map(([k, a]: [string, Any]) => `${k}=${fmt(a.value)}`).join(' · '))))))))),
	);
}

export async function identityView(el: HTMLElement) {
	const queue: Any[] = await q(api.entities.identityQueue);
	add(el, h('div', { class: 'toolbar' }, h('h1', null, 'Identity decisions')),
		h('p', { class: 'muted' }, 'Records Signal did not merge because the evidence was ambiguous or contradictory. Nothing here is joined until you decide.'),
		queue.length ? h('ul', { class: 'feed' }, queue.map((x) => h('li', { class: 'card' },
			h('div', { class: 'row between' }, h('strong', null, x.label), badge(x.status, 'warn')),
			h('p', { class: 'small' }, `${x.sourceName} · ${x.recordKey}: ${x.reason}`),
			h('div', { class: 'row wrap' },
				x.options.map((o: Any) => h('button', { onclick: async () => { const r = await m(api.entities.assign, { sourceId: x.sourceId, recordKey: x.recordKey, entityId: o.entityId }); toast(`Linked; ${r.entities} entities re-evaluated`); } }, `Same as ${o.label ?? o.entityId}${o.distanceM !== null ? ` (${o.distanceM} m)` : ''} — ${o.why}`)),
				h('button', { onclick: async () => { await m(api.entities.separate, { sourceId: x.sourceId, recordKey: x.recordKey }); toast('Kept separate'); } }, 'Different things'),
				h('a', { class: 'button', href: `#/entities/${x.entityId}` }, 'Inspect'))))) : h('div', { class: 'empty' }, h('p', null, 'No identity decisions are waiting.')));
}
