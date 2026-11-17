import { api, go, m, q, route, type Any } from '../app.ts';
import { add, ago, badge, h, modal, toast } from '../dom.ts';

const statusKind = (s: string) => (s === 'production' || s === 'verified' ? 'match' : s === 'discovered' ? 'possible' : s === 'deprecated' ? 'closed' : 'warn');

export async function sitesView(el: HTMLElement) {
	const { id } = route();
	const list: Any[] = await q(api.sites.catalog);
	add(el, h('div', { class: 'toolbar' }, h('h1', null, 'Sites'), h('span', { class: 'muted small' }, 'Shared knowledge of how websites expose information. Structure only — never anyone\'s data or session.')));
	const left = h('div', { class: 'pane' }, list.length ? h('ul', { class: 'feed' }, list.map((s) => h('li', { class: `card ${s.id === id ? 'active' : ''}`, onclick: () => go(`#/sites/${s.id}`) },
		h('div', { class: 'row between' }, h('strong', null, s.domain), s.usable ? badge(`${s.usable} usable feed${s.usable > 1 ? 's' : ''}`, 'match') : badge('no usable feed', 'muted')),
		h('div', { class: 'row wrap' }, s.production ? badge(`${s.production} production`, 'match') : null, s.verified ? badge(`${s.verified} verified`, 'match') : null, s.discovered ? badge(`${s.discovered} discovered`, 'possible') : null, s.broken ? badge(`${s.broken} broken / changed`, 'warn') : null),
		h('div', { class: 'meta' }, `${s.analyses} analyses · last ${ago(s.lastAnalyzedAt)}${s.best ? ` · best: ${s.best.label} (${s.best.score})` : ''}`)))) : h('div', { class: 'empty' }, h('p', null, 'No site has been analyzed yet. In the browser extension, open a site and choose “Understand this site”.')));
	const right = h('aside', { class: 'detail' });
	if (id) await detail(right, id); else add(right, h('p', { class: 'muted' }, 'A site is supported when Signal understands a useful information structure, can reach it with your authorized access, and can monitor it — not when it can parse a page.'));
	add(el, h('div', { class: 'split' }, left, right));
}

async function detail(el: HTMLElement, id: string) {
	const d: Any = await q(api.sites.site, { siteId: id });
	const session: Any = await q(api.notices.getPreferences).catch(() => null);
	void session;
	add(el, h('h2', null, d.domain), h('p', { class: 'muted' }, `${d.analyses} analyses since ${ago(d.firstSeenAt)}. Feeds are ranked by usefulness for monitoring.`));
	for (const f of d.feeds) {
		const def = f.definition;
		add(el, h('div', { class: 'record' },
			h('div', { class: 'row between' }, h('strong', null, f.label), h('span', null, badge(f.status, statusKind(f.status)), ' ', badge(f.verdict), ' ', badge(`score ${f.score}`))),
			h('p', { class: 'small' }, `${def.kind.replace('_', ' ')} · v${f.version} · ${def.endpoint ? `${def.endpoint.origin}${def.endpoint.pathTemplate}` : def.embedded ? `embedded ${def.embedded.name}` : 'rendered page'}`),
			h('dl', { class: 'facts small' },
				h('dt', null, 'Records'), h('dd', null, `${def.recordsPath ?? '—'} · identifier ${def.identifier ? `${def.identifier.path} (${def.identifier.basis})` : 'none'} · ${def.completeness}`),
				h('dt', null, 'Changes'), h('dd', null, [def.change.conditional && `conditional GET (${def.change.conditional})`, def.change.recordUpdatedField && `per-record ${def.change.recordUpdatedField}`, def.change.maxAgeSeconds && `cache ${def.change.maxAgeSeconds}s`].filter(Boolean).join(' · ') || 'none observed'),
				h('dt', null, 'Traversal'), h('dd', null, `${def.pagination.kind}${def.pagination.params.length ? ` (${def.pagination.params.join(', ')})` : ''}${def.filters.length ? ` · filters: ${def.filters.map((x: Any) => `${x.param} (${x.kind})`).join(', ')}` : ''}`),
				h('dt', null, 'Access'), h('dd', null, `${def.access.auth}${def.access.auth === 'session' ? ' — each user\'s own session, from their browser' : ''} · robots ${def.access.robots}${def.endpoint?.params.some((p: Any) => p.sensitive) ? ' · has credential-like parameters (values never shared)' : ''}`),
				h('dt', null, 'Relations'), h('dd', null, def.relations.map((r: Any) => `${r.field} → ${r.targetTemplate}`).join('; ') || '—'),
				h('dt', null, 'Verification'), h('dd', null, `${f.verifications} acquisitions matched · ${f.failures} failures${f.lastVerifiedAt ? ` · last verified ${ago(f.lastVerifiedAt)}` : ''}${f.lastFailure ? ` · last failure: ${f.lastFailure}` : ''}`)),
			def.limitations.length ? h('p', { class: 'small warn' }, def.limitations.join(' · ')) : null,
			h('details', null, h('summary', null, `${def.fields.length} fields`), h('table', { class: 'grid small' }, h('thead', null, h('tr', null, ['Field', 'Type', 'Present', 'Role'].map((x) => h('th', null, x)))), h('tbody', null, def.fields.slice(0, 80).map((x: Any) => h('tr', null, h('td', null, h('code', null, x.path)), h('td', null, x.type), h('td', null, `${Math.round(x.presence * 100)}%`), h('td', null, x.role ?? '')))))),
			h('details', null, h('summary', null, 'Verification history'), h('ul', { class: 'small' }, f.checks.map((c: Any) => h('li', null, `${ago(c.at)} · ${c.kind} · ${c.ok ? 'ok' : 'failed'} · ${c.detail}`)))),
			f.connections.length ? h('p', { class: 'small' }, 'Your connections: ', f.connections.map((c: Any) => h('a', { href: `#/sources/${c.sourceId}` }, `${c.name} (${c.acquisition})`))) : null,
			h('div', { class: 'row wrap' },
				['feed', 'detail'].includes(f.verdict) && def.access.automatable && !['deprecated', 'broken'].includes(f.status) ? h('button', { class: 'primary', onclick: () => connect(f, def) }, 'Connect with my access') : null,
				h('button', { onclick: () => report(f.id) }, 'Report a problem'),
				h('button', { onclick: () => curate(f.id, 'promote') }, 'Promote (curator)'), h('button', { onclick: () => curate(f.id, 'deprecate') }, 'Deprecate (curator)'))));
	}
	if (d.myAnalyses.length) add(el, h('h3', null, 'Your analyses (private)'), h('ul', { class: 'small' }, d.myAnalyses.map((a: Any) => h('li', null, `${ago(a.at)} · ${a.url} · ${a.durationMs} ms`))));
}

function connect(f: Any, def: Any) {
	const type = h('input', { value: f.entityHint && !['results', 'items', 'data', 'features', 'records'].includes(f.entityHint) ? f.entityHint.replace(/s$/, '') : 'record' });
	const url = h('input', { type: 'url', placeholder: def.endpoint.params.length || /\{/.test(def.endpoint.pathTemplate) ? 'your URL for this feed (blank: the one from your latest analysis)' : `${def.endpoint.origin}${def.endpoint.pathTemplate}` });
	modal('Connect with your own access', h('div', null,
		h('p', null, def.access.auth === 'public' ? 'Signal\'s server will fetch this public feed on its schedule (while a browser with the extension, or a person, triggers refreshes: FeltKit cannot schedule outbound fetches).' : 'This feed depends on your session on the site. Your browser fetches it (the Signal extension), with your own session, while the browser runs. Signal\'s server never sees your session.'),
		h('label', { class: 'field' }, h('span', null, 'Each record describes a'), type), h('label', { class: 'field' }, h('span', null, 'URL (optional)'), url)),
		[{ label: 'Connect', primary: true, run: async () => { const r = await m(api.sites.connect, { feedId: f.id, entityType: type.value.trim(), ...(url.value ? { url: url.value } : {}) }); toast(`Connected (${r.acquisition}).`); go(`#/sources/${r.sourceId}`); } }]);
}
function report(feedId: string) {
	const t = h('textarea', { rows: '3', placeholder: 'What went wrong? (no personal data)' });
	modal('Report a problem with this feed', t, [{ label: 'Report', primary: true, run: async () => { await m(api.sites.report, { feedId, detail: t.value }); toast('Reported'); } }]);
}
async function curate(feedId: string, action: 'promote' | 'deprecate') {
	const note = action === 'deprecate' ? prompt('Why is it deprecated?') ?? '' : '';
	try { const r = await m(api.sites.review, { feedId, action, ...(note ? { note } : {}) }); toast(`Status: ${r.status}`); } catch (e) { toast((e as Error).message, 'error'); }
}
