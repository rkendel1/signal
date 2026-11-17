import { api, go, m, q, route, type Any } from '../app.ts';
import { add, put, ago, badge, day, fmt, h, modal, svg, toast, tri } from '../dom.ts';

const CHANGE_LABEL: Record<string, string> = { new: 'new', changed: 'changed', persistent: 'unchanged', reopened: 'reopened', resolved: 'resolved', superseded: 'superseded', invalid: 'invalid' };

export async function findingsView(el: HTMLElement) {
	const { id, params } = route();
	const status = params.get('status') ?? 'open';
	const crit = params.get('criteria') ?? '';
	const qual = params.get('q') ?? '';
	const mode = params.get('view') ?? 'list';
	const flags = params.get('flags') ?? '';
	const [all, criteria] = await Promise.all([
		q(api.findings.list, { status, ...(crit ? { criteriaId: crit } : {}), ...(qual ? { qualification: qual } : {}), includeDismissed: params.get('dismissed') === '1' }),
		q(api.criteria.list),
	]);
	const list: Any[] = all.filter((f: Any) => !flags || (flags === 'conflict' && f.hasConflict) || (flags === 'stale' && f.hasStale) || (flags === 'missing' && f.hasMissing) || (flags === 'unacked' && !f.acknowledged));
	const set = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); go(`#/findings${id ? '/' + encodeURIComponent(id) : ''}?${p}`); };
	const open = (fid: string) => go(`#/findings/${encodeURIComponent(fid)}?${params}`);

	const sel = (k: string, value: string, options: Array<[string, string]>, label: string) => h('label', { class: 'field inline' }, h('span', null, label), h('select', { onchange: (e: Event) => set(k, (e.target as HTMLSelectElement).value) }, options.map(([v, l]) => h('option', { value: v, ...(v === value ? { selected: true } : {}) }, l))));
	add(el, 
		h('div', { class: 'toolbar' },
			h('h1', null, 'Findings'),
			sel('status', status, [['open', 'Open'], ['closed', 'Closed'], ['all', 'All']], 'Status'),
			sel('criteria', crit, [['', 'All criteria'], ...criteria.map((c: Any) => [c.id, c.name] as [string, string])], 'Criteria'),
			sel('q', qual, [['', 'Matches and possible'], ['match', 'Matches only'], ['possible', 'Possible only']], 'Show'),
			sel('flags', flags, [['', 'Any evidence'], ['unacked', 'Not acknowledged'], ['conflict', 'Conflicting evidence'], ['stale', 'Stale evidence'], ['missing', 'Missing evidence']], 'Filter'),
			h('div', { class: 'tabs', role: 'tablist' }, [['list', 'List'], ['table', 'Table'], ['map', 'Map'], ['timeline', 'Timeline']].map(([v, l]) => h('button', { role: 'tab', class: mode === v ? 'active' : '', 'aria-selected': String(mode === v), onclick: () => set('view', v === 'list' ? '' : v) }, l)))),
	);
	const left = h('div', { class: 'pane' });
	if (mode === 'timeline') left.append(await timeline(open));
	else if (!list.length) left.append(empty(criteria.length, status));
	else if (mode === 'table') left.append(table(list, open, id));
	else if (mode === 'map') left.append(map(list, open, id));
	else left.append(h('ul', { class: 'feed' }, list.map((f) => card(f, open, f.id === id))));
	const right = h('aside', { class: 'detail' });
	if (id) await detail(right, id); else right.append(h('p', { class: 'muted' }, list.length ? 'Select a finding to see why it was surfaced and the evidence behind it.' : ''));
	add(el, h('div', { class: 'split' }, left, right));
}

function empty(criteriaCount: number, status: string) {
	if (!criteriaCount) return h('div', { class: 'empty' }, h('p', null, 'No criteria yet. Findings appear when information meets what you define.'), h('a', { class: 'button primary', href: '#/criteria?new=1' }, 'Define criteria'));
	return h('div', { class: 'empty' }, h('p', null, status === 'open' ? 'Nothing currently meets your criteria. Signal keeps evaluating as sources change.' : 'No findings with this filter.'));
}

const qualBadge = (f: Any) => f.qualification === 'match' ? badge('match', 'match') : badge('possible', 'possible');
const flagsOf = (f: Any) => [f.hasConflict && badge('conflict', 'warn'), f.hasStale && badge('stale', 'warn'), f.hasMissing && badge('missing evidence', 'muted'), f.synthetic && badge('synthetic', 'synthetic'), ...(f.sourceIssues ?? []).map((s: string) => badge(s, 'warn'))];

function card(f: Any, open: (id: string) => void, active: boolean) {
	return h('li', { class: `card ${active ? 'active' : ''} ${f.acknowledged ? 'acked' : ''}`, tabindex: '0', onclick: () => open(f.id), onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') open(f.id); } },
		h('div', { class: 'row between' }, h('strong', null, f.entityLabel ?? f.entityId), h('span', { class: 'prio', title: f.priorityWhy }, String(f.priority))),
		h('div', { class: 'row wrap' }, qualBadge(f), f.status !== 'open' ? badge(CHANGE_LABEL[f.change], 'closed') : f.change !== 'persistent' ? badge(CHANGE_LABEL[f.change], f.change) : null, ...flagsOf(f)),
		h('p', { class: 'summary' }, f.summary),
		h('div', { class: 'meta' }, `${f.criteriaName} · ${f.sourceCount} source${f.sourceCount === 1 ? '' : 's'} · confidence ${Math.round(f.confidence * 100)}% · changed ${ago(f.lastChangedAt)}`));
}

function table(list: Any[], open: (id: string) => void, id: string | null) {
	return h('table', { class: 'grid' },
		h('thead', null, h('tr', null, ['Priority', 'Entity', 'Criteria', 'Result', 'State', 'Confidence', 'Sources', 'Evidence', 'Changed'].map((c) => h('th', null, c)))),
		h('tbody', null, list.map((f) => h('tr', { class: f.id === id ? 'active' : '', onclick: () => open(f.id) },
			h('td', { title: f.priorityWhy }, String(f.priority)), h('td', null, f.entityLabel ?? f.entityId), h('td', null, f.criteriaName), h('td', null, qualBadge(f)),
			h('td', null, CHANGE_LABEL[f.change]), h('td', null, `${Math.round(f.confidence * 100)}%`), h('td', null, String(f.sourceCount)), h('td', null, flagsOf(f)), h('td', null, ago(f.lastChangedAt))))));
}

/** Positions only: no basemap is loaded (no tile provider is configured). */
function map(list: Any[], open: (id: string) => void, id: string | null) {
	const pts = list.filter((f) => f.lat !== null && f.lng !== null);
	if (!pts.length) return h('div', { class: 'empty' }, h('p', null, 'None of these findings has a location. The map is only useful when sources provide coordinates.'));
	const W = 640, H = 420, pad = 24;
	const lats = pts.map((p) => p.lat), lngs = pts.map((p) => p.lng);
	const [la0, la1, ln0, ln1] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
	const kx = (W - 2 * pad) / Math.max(ln1 - ln0, 1e-6), ky = (H - 2 * pad) / Math.max(la1 - la0, 1e-6), k = Math.min(kx, ky);
	const x = (lng: number) => pad + (lng - ln0) * k, y = (lat: number) => H - pad - (lat - la0) * k;
	const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'map', role: 'img', 'aria-label': `${pts.length} findings by location` });
	for (const f of pts) {
		const c = svg('circle', { cx: x(f.lng).toFixed(1), cy: y(f.lat).toFixed(1), r: f.id === id ? 9 : 6, class: `pt ${f.qualification} ${f.id === id ? 'sel' : ''}` });
		c.appendChild(svg('title', {}, document.createTextNode(`${f.entityLabel} — ${f.summary}`)));
		c.addEventListener('click', () => open(f.id));
		s.appendChild(c);
	}
	return h('div', null, s, h('p', { class: 'muted small' }, `${pts.length} of ${list.length} findings have a location. Positions only — no basemap is loaded. `, h('span', { class: 'legend match' }, '● match'), ' ', h('span', { class: 'legend possible' }, '● possible')));
}

async function timeline(open: (id: string) => void) {
	const evs: Any[] = await q(api.findings.timeline, { limit: 200 });
	if (!evs.length) return h('div', { class: 'empty' }, h('p', null, 'No finding has changed yet.'));
	return h('ol', { class: 'timeline' }, evs.map((e) => h('li', { onclick: () => open(e.findingId) },
		h('div', { class: 'row between' }, h('span', null, badge(CHANGE_LABEL[e.kind] ?? e.kind, e.kind), ' ', h('strong', null, e.entityLabel ?? '?')), h('span', { class: 'muted small', title: e.at }, ago(e.at))),
		h('div', { class: 'small' }, e.criteriaName, ' — ', e.cause?.label ?? ''),
		e.diff?.length ? h('div', { class: 'small muted' }, e.diff.slice(0, 4).map((d: Any) => `${d.what}: ${fmt(d.from)} → ${fmt(d.to)}`).join(' · ')) : null)));
}

// ------------------------------------------------------------------ the evidence trail

function valueChip(v: Any) {
	if (v.inputs) return h('div', { class: 'derived' }, h('div', null, h('b', null, fmt(v.value)), ' ', badge('derived', 'muted')),
		v.inputs.map((i: Any) => h('div', { class: 'small' }, `${i.attr} = `, i.values.length ? i.values.map((x: Any) => h('span', { class: 'chip' }, fmt(x.value), h('em', null, ` ${x.sourceName}`))) : h('em', null, 'no usable value'))));
	return h('span', { class: `chip ${v.stale ? 'stale' : ''} ${v.result ?? ''}`, title: `observed ${v.observedAt}${v.validAt ? `, as of ${v.validAt}` : ''}; confirmed ${v.confirmedAt}; ${v.ageDays} days old; record ${v.recordKey} v${v.version}; identity ${v.link}` },
		v.result ? tri(v.result) : null, ' ', h('b', null, fmt(v.value)), h('em', null, ` ${v.sourceName}`),
		h('span', { class: 'age' }, ` ${v.ageDays < 1 ? 'today' : `${Math.round(v.ageDays)}d`}${v.stale ? ' · stale' : ''}${v.link === 'probable' ? ' · probable match' : ''}`));
}

function node(n: Any): HTMLElement {
	if (n.kind !== 'leaf') return h('li', { class: 'node' }, h('div', null, tri(n.result), ' ', h('b', null, n.kind === 'all' ? 'All of' : 'Any of')), h('ul', null, n.children.map(node)));
	const l = n.leaf;
	return h('li', { class: 'node' },
		h('div', null, tri(n.result), ' ', n.text, l.reason ? h('span', { class: 'reason' }, ` — ${{ missing: 'no source states it', stale: 'evidence too old', conflict: 'sources disagree', no_history: 'not enough history', unit: 'incomparable units', derived: 'cannot be computed' }[l.reason as string] ?? l.reason}`) : null, l.resolvedBy ? h('span', { class: 'muted small' }, ` (${l.resolvedBy})`) : null),
		l.note ? h('div', { class: 'small muted' }, l.note) : null,
		l.values.length ? h('div', { class: 'values' }, l.values.map(valueChip)) : null);
}

async function detail(el: HTMLElement, id: string) {
	let d: Any;
	try { d = await q(api.findings.get, { findingId: id }); } catch (e) { add(el, h('p', { class: 'error' }, (e as Error).message)); return; }
	const f = d.finding, x = d.explanation;
	const ack = async () => { await m(api.findings.acknowledge, { findingId: id, acknowledged: !f.acknowledgedAt }); };
	const dismiss = () => { const r = h('textarea', { rows: '3', placeholder: 'Why is this not relevant? (kept with the finding)' }); modal('Dismiss finding', r, [{ label: 'Dismiss', primary: true, run: async () => { await m(api.findings.dismiss, { findingId: id, reason: r.value }); toast('Dismissed'); } }]); };
	add(el, 
		h('div', { class: 'row between' }, h('h2', null, d.entity?.label ?? d.entity?.id), h('a', { href: '#/findings' }, 'Close')),
		h('div', { class: 'row wrap' }, f.qualification === 'match' ? badge('match', 'match') : badge('possible', 'possible'), badge(f.status), badge(CHANGE_LABEL[f.change] ?? f.change, f.change), f.synthetic ? badge('synthetic evidence', 'synthetic') : null),
		h('p', { class: 'lede' }, f.summary),
		h('div', { class: 'meta' }, `“${d.criteria.name}” v${f.criteriaVersion}${d.criteria.activeVersion && d.criteria.activeVersion !== f.criteriaVersion ? ` (current: v${d.criteria.activeVersion})` : ''} · first detected ${day(f.firstDetectedAt)} · last changed ${ago(f.lastChangedAt)} · evaluated ${ago(f.lastEvaluatedAt)}`),
		h('div', { class: 'row' },
			h('button', { onclick: ack }, f.acknowledgedAt ? 'Un-acknowledge' : 'Acknowledge'),
			f.dismissedAt ? h('button', { onclick: () => m(api.findings.dismiss, { findingId: id, dismissed: false }) }, 'Restore') : h('button', { onclick: dismiss }, 'Not relevant…'),
			d.entity ? h('a', { class: 'button', href: `#/entities/${d.entity.id}` }, 'Open entity') : null,
			h('a', { class: 'button', href: `#/criteria/${d.criteria.id}` }, 'Refine criteria')),
		f.dismissedAt ? h('p', { class: 'muted' }, `Dismissed ${ago(f.dismissedAt)}: ${f.dismissReason}`) : null,

		h('h3', null, 'Why'),
		h('ul', { class: 'tree' }, x.require.map(node)),
		x.exclude.length ? [h('h4', null, 'Disqualified if'), h('ul', { class: 'tree' }, x.exclude.map(node))] : null,
		x.prefer.length ? [h('h4', null, 'Preferences'), h('ul', { class: 'tree' }, x.prefer.map((p: Any) => { const li = node(p.node); li.firstChild!.appendChild(h('span', { class: 'muted small' }, ` (+${p.weight})`)); return li; }))] : null,
		x.conflicts.length ? [h('h4', null, 'Where sources disagree'), h('ul', null, x.conflicts.map((c: Any) => h('li', null, h('b', null, c.attr), ': ', c.values.map((v: Any) => `${fmt(v.value)} (${v.sourceName})`).join(' vs '), h('span', { class: 'muted' }, ` — ${c.resolvedBy ?? 'unresolved: the condition is unknown'}`))))] : null,
		x.missing.length || x.stale.length ? h('p', { class: 'muted' }, [x.missing.length ? `Not stated by any source: ${x.missing.join(', ')}. ` : '', x.stale.length ? `Too old to count: ${x.stale.join(', ')}.` : ''].join('')) : null,

		h('h3', null, 'Priority'),
		h('p', null, `Score ${x.score} × confidence ${Math.round(x.confidence * 100)}%`),
		h('ul', { class: 'small' }, x.breakdown.map((b: Any) => h('li', null, b.label, b.points !== undefined ? ` +${b.points}` : ` ×${b.factor}`))),

		h('h3', null, 'Evidence'),
		h('table', { class: 'grid small' }, h('thead', null, h('tr', null, ['Source', 'Record', 'Version', 'State', 'Observed', 'As of', 'Received by'].map((c) => h('th', null, c)))),
			h('tbody', null, d.evidence.map((o: Any) => h('tr', { class: o.status !== 'current' ? 'old' : '' },
				h('td', null, o.source.name, o.source.status !== 'connected' ? h('div', null, badge(o.source.status, 'warn')) : null), h('td', null, h('code', null, o.recordKey), h('div', { class: 'muted' }, o.locator ?? '')),
				h('td', null, `v${o.version}`), h('td', null, o.status), h('td', { title: o.observedAt }, day(o.observedAt)), h('td', null, day(o.validAt)),
				h('td', { class: 'muted', title: o.ingestion?.rawHash ? `raw sha256 ${o.ingestion.rawHash}` : '' }, o.ingestion ? `${o.ingestion.trigger} ${ago(o.ingestion.at)}` : '—'))))),

		h('h3', null, 'History'),
		h('ol', { class: 'timeline' }, [...d.history].reverse().map((e: Any) => h('li', null,
			h('div', { class: 'row between' }, h('span', null, badge(CHANGE_LABEL[e.kind] ?? e.kind, e.kind), ` v${e.criteriaVersion}`), h('span', { class: 'muted small', title: e.at }, ago(e.at))),
			h('div', { class: 'small' }, e.cause?.label),
			e.diff?.length ? h('div', { class: 'small muted' }, e.diff.map((x: Any) => `${x.what}: ${fmt(x.from)} → ${fmt(x.to)}`).join(' · ')) : null))),
	);
}
