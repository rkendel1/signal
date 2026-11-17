import { act, api, go, m, q, route, type Any } from '../app.ts';
import { add, put, ago, badge, day, fmt, h, modal, toast } from '../dom.ts';

const KINDS: Array<[string, string, string]> = [
	['file', 'File', 'CSV, GeoJSON or JSON you upload. A snapshot: it changes when you upload a new version.'],
	['http_json', 'HTTP JSON API', 'A URL Signal fetches on request (and by the poller). Conditional GET; private addresses are refused.'],
	['push', 'Push (API)', 'A system pushes records to Signal through the signal.sources.push capability. Evaluated on arrival.'],
	['manual', 'Manual records', 'Records you enter in Signal yourself.'],
	['page_capture', 'Browser capture', 'Pages you capture in your own browser with the Signal extension.'],
];
const kindLabel = (k: string) => KINDS.find((x) => x[0] === k)?.[1] ?? k;
const statusKind = (s: string) => (s === 'connected' ? 'match' : s === 'removed' ? 'closed' : 'warn');

export async function sourcesView(el: HTMLElement) {
	const { id, params } = route();
	const list: Any[] = await q(api.sources.list, { includeRemoved: params.get('removed') === '1' });
	add(el, h('div', { class: 'toolbar' }, h('h1', null, 'Sources'), h('button', { class: 'primary', onclick: () => addSource() }, 'Connect a source'),
		h('label', { class: 'field inline' }, h('input', { type: 'checkbox', checked: params.get('removed') === '1', onchange: (e: Event) => go(`#/sources${id ? '/' + id : ''}${(e.target as HTMLInputElement).checked ? '?removed=1' : ''}`) }), h('span', null, 'show removed'))));
	const left = h('div', { class: 'pane' }, list.length ? h('ul', { class: 'feed' }, list.map((s) => h('li', { class: `card ${s.id === id ? 'active' : ''}`, onclick: () => go(`#/sources/${s.id}`) },
		h('div', { class: 'row between' }, h('strong', null, s.name), badge(s.status, statusKind(s.status))),
		h('div', { class: 'row wrap' }, badge(kindLabel(s.kind)), badge(s.origin === 'native' ? 'native' : 'user-provided', 'muted'), s.synthetic ? badge('synthetic', 'synthetic') : null, s.stale ? badge('stale', 'warn') : null, s.overdue ? badge('refresh overdue', 'warn') : null),
		h('div', { class: 'meta' }, `${s.records.toLocaleString('en-US')} ${s.entityType} records · last success ${ago(s.lastSuccessAt)} · last change ${ago(s.lastChangeAt)}`),
		s.statusReason ? h('div', { class: 'small error' }, s.statusReason) : null))) : h('div', { class: 'empty' }, h('p', null, 'No sources connected.')));
	const right = h('aside', { class: 'detail' });
	if (id) await detail(right, id); else right.append(h('p', { class: 'muted' }, 'Select a source to see what it provides, how fresh it is, and how its records match other sources.'));
	add(el, h('div', { class: 'split' }, left, right));
	if (params.get('add') === '1') { history.replaceState(null, '', '#/sources'); addSource(); }
}

async function detail(el: HTMLElement, id: string) {
	const d: Any = await q(api.sources.get, { sourceId: id });
	const s = d.source, c = d.coverage;
	const run = async (label: string, f: () => Promise<Any>) => { try { const r = await f(); toast(`${label}: ${describe(r)}`); } catch (e) { toast((e as Error).message, 'error'); } };
	const live = s.status !== 'removed';
	add(el, 
		h('div', { class: 'row between' }, h('h2', null, s.name), badge(s.status, statusKind(s.status))),
		s.description ? h('p', null, s.description) : null,
		h('p', { class: 'muted' }, s.refresh),
		s.statusReason ? h('p', { class: 'error' }, s.statusReason) : null,
		h('div', { class: 'row wrap' },
			live && s.kind === 'http_json' ? h('button', { class: 'primary', onclick: () => run('Refresh', () => act(api.sources.refresh, { sourceId: id })) }, 'Refresh now') : null,
			live && s.kind === 'file' ? h('button', { class: 'primary', onclick: () => uploadSnapshot(id, s.config.format) }, 'Upload new version') : null,
			live && (s.kind === 'manual' || s.kind === 'push') ? h('button', { class: 'primary', onclick: () => pushRecords(id, s.kind) }, s.kind === 'manual' ? 'Enter records' : 'Push records (test)') : null,
			live ? h('button', { onclick: () => run(s.status === 'paused' ? 'Resumed' : 'Paused', () => m(api.sources.setStatus, { sourceId: id, status: s.status === 'paused' ? 'connected' : 'paused' })) }, s.status === 'paused' ? 'Resume' : 'Pause') : null,
			live ? h('button', { onclick: () => editFreshness(id, s.staleAfterDays) }, `Freshness: ${s.staleAfterDays ? `${s.staleAfterDays} days` : 'not set'}`) : null,
			live ? h('button', { class: 'danger', onclick: () => modal(`Remove ${s.name}?`, h('p', null, 'Its current records are withdrawn (their history is kept) and every affected finding is re-evaluated. This cannot be undone; connect it again to use it.'), [{ label: 'Remove source', primary: true, run: async () => { const r = await m(api.sources.remove, { sourceId: id }); toast(`Removed: ${describe(r)}`); } }]) }, 'Remove') : null),
		h('dl', { class: 'facts' },
			h('dt', null, 'Kind'), h('dd', null, `${kindLabel(s.kind)} (${s.origin === 'native' ? 'native to Signal' : 'user-provided'})`),
			h('dt', null, 'Describes'), h('dd', null, s.entityType),
			s.config.url ? [h('dt', null, 'URL'), h('dd', null, h('code', null, s.config.url))] : null,
			h('dt', null, 'Last refresh'), h('dd', null, `${ago(s.lastRefreshAt)} (success ${ago(s.lastSuccessAt)})`),
			h('dt', null, 'Data as of'), h('dd', null, c.validAt.min ? `${day(c.validAt.min)}${c.validAt.max !== c.validAt.min ? ` – ${day(c.validAt.max)}` : ''}${c.validAt.missing ? ` (${c.validAt.missing} records do not say)` : ''}` : 'not stated by the source; freshness is when Signal received it'),
			h('dt', null, 'Mapping'), h('dd', null, `version ${s.mappingVersion} `, live ? h('button', { class: 'link', onclick: () => editMapping(id, d.mapping) }, 'edit') : null)),

		h('h3', null, 'Coverage'),
		h('p', null, `${c.records.toLocaleString('en-US')} current records. Identity: ${c.identity.withId} with an identifier, ${c.identity.withAddress} with an address, ${c.identity.withLocation} with a location${c.identity.withNothing ? `, ${c.identity.withNothing} with nothing to match on` : ''}.${c.identity.positionalKeys ? ` ${c.identity.positionalKeys} records have no stable key (row position): an edit to them looks like a removal plus an addition.` : ''}`),
		h('div', { class: 'row wrap' }, Object.entries(c.links).map(([k, v]) => badge(`${v} ${k}`, k === 'ambiguous' || k === 'conflict' ? 'warn' : k === 'exact' || k === 'probable' ? 'match' : ''))),
		h('table', { class: 'grid small' }, h('thead', null, h('tr', null, ['Attribute', 'Present', 'Type', 'Range / samples'].map((x) => h('th', null, x)))),
			h('tbody', null, c.attributes.map((a: Any) => h('tr', null, h('td', null, a.attr), h('td', null, `${Math.round((a.present / Math.max(c.records, 1)) * 100)}%`), h('td', null, a.types.join(', '), a.unit ? ` (${a.unit})` : ''), h('td', null, a.min !== undefined ? `${fmt(a.min)} – ${fmt(a.max)}` : a.samples.join(', ')))))),

		h('h3', null, 'Refresh history'),
		h('table', { class: 'grid small' }, h('thead', null, h('tr', null, ['When', 'Trigger', 'Result', 'New', 'Changed', 'Same', 'Withdrawn', 'Issues'].map((x) => h('th', null, x)))),
			h('tbody', null, d.ingestions.map((i: Any) => h('tr', null, h('td', { title: i.at }, ago(i.at)), h('td', null, i.trigger), h('td', null, i.status === 'ok' ? (i.added + i.changed + i.retracted ? 'new information' : 'no new information') : badge(i.status, 'warn'), i.error ? h('div', { class: 'error small' }, i.error) : null),
				h('td', null, String(i.added)), h('td', null, String(i.changed)), h('td', null, String(i.unchanged)), h('td', null, String(i.retracted)), h('td', { title: JSON.stringify(i.issues.first?.slice(0, 5) ?? []) }, String(i.issues.count ?? 0)))))),

		h('h3', null, 'Records'),
		h('table', { class: 'grid small' }, h('thead', null, h('tr', null, ['Record', 'Version', 'Identity', ''].map((x) => h('th', null, x)))),
			h('tbody', null, d.records.slice(0, 100).map((r: Any) => h('tr', null, h('td', null, r.label, h('div', { class: 'muted' }, r.recordKey)), h('td', null, `v${r.version}`),
				h('td', { title: r.link?.reason ?? '' }, r.link ? badge(r.link.status, r.link.status === 'ambiguous' || r.link.status === 'conflict' ? 'warn' : '') : '—'),
				h('td', null, r.link ? h('a', { href: `#/entities/${r.link.entityId}` }, 'entity') : null))))),
		d.records.length > 100 ? h('p', { class: 'muted small' }, `Showing 100 of ${c.records}.`) : null,
	);
}

function describe(r: Any): string {
	if (!r) return 'done';
	if (r.status === 'unavailable') return `source unavailable (${r.error})`;
	if (r.status === 'not_modified') return 'not modified since the last fetch';
	if (r.received === undefined) return r.mappingVersion ? `mapping v${r.mappingVersion}${r.note ? ` — ${r.note}` : ''}` : 'done';
	const info = r.newInformation ? `${r.added} new, ${r.changed} changed, ${r.retracted} withdrawn` : 'no new information';
	const run = r.run ? ` → ${r.run.entities} re-evaluated: ${r.run.created} new, ${r.run.changed} changed, ${r.run.closed} closed, ${r.run.reopened} reopened findings (${r.run.durationMs} ms)` : '';
	return `${r.received} received, ${info}${run}`;
}

const readFile = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsText(f); });
const fmtOf = (name: string) => (/\.(geo)?json$/i.test(name) ? (/geojson/i.test(name) ? 'geojson' : 'json') : 'csv');

function uploadSnapshot(id: string, format: string) {
	const file = h('input', { type: 'file', accept: format === 'csv' ? '.csv,text/csv' : '.json,.geojson,application/json' });
	const asOf = h('input', { type: 'date' });
	modal('Upload a new version', h('div', null, h('p', null, 'Compared with the current version: only differences become new information.'), file, h('label', { class: 'field' }, h('span', null, 'Data as of (if the provider says)'), asOf)), [{ label: 'Upload', primary: true, run: async () => {
		const f = file.files?.[0]; if (!f) throw new Error('Choose a file.');
		const r = await m(api.sources.upload, { sourceId: id, content: await readFile(f), ...(asOf.value ? { dataAsOf: new Date(asOf.value).toISOString() } : {}) });
		toast(describe(r));
	} }]);
}

function pushRecords(id: string, kind: string) {
	const ta = h('textarea', { rows: '10', class: 'mono', placeholder: '[{"listing_id": "A1", "address": "1 Main St", "price": 250000}]' });
	modal(kind === 'manual' ? 'Enter records' : 'Push records', h('div', null, h('p', { class: 'muted small' }, 'A JSON array of records, using the source’s column names. Records with an existing key update it; others are added.'), ta), [{ label: 'Save', primary: true, run: async () => { const r = await m(api.sources.push, { sourceId: id, records: ta.value }); toast(describe(r)); } }]);
}

function editFreshness(id: string, current: number | null) {
	const n = h('input', { type: 'number', min: '1', value: current ?? '', placeholder: 'days' });
	modal('Freshness', h('div', null, h('p', null, 'Evidence from this source older than this many days (by its as-of date, or when Signal last confirmed it) is stale and does not count. Findings are re-evaluated at once.'), n), [{ label: 'Save', primary: true, run: async () => { const r = await m(api.sources.update, { sourceId: id, staleAfterDays: n.value ? Number(n.value) : null }); toast(`${r.reevaluated} entities re-evaluated`); } }]);
}

function editMapping(id: string, mapping: Any) {
	const ta = h('textarea', { rows: '16', class: 'mono' }, JSON.stringify(mapping, null, 2));
	modal('Edit mapping', h('div', null, h('p', { class: 'muted small' }, 'A new mapping version. For file and HTTP sources the stored snapshot is re-mapped now; only records whose meaning changes get new observation versions.'), ta), [{ label: 'Save new version', primary: true, run: async () => { const r = await m(api.sources.setMapping, { sourceId: id, mapping: ta.value }); toast(describe(r)); } }]);
}

// ------------------------------------------------------------------ connect wizard

function addSource() {
	const st: Any = { kind: 'file' };
	const body = h('div', { class: 'wizard' });
	const draw = async () => {
		put(body, 
			h('div', { class: 'kinds' }, KINDS.map(([k, label, hint]) => h('label', { class: `kind ${st.kind === k ? 'active' : ''}` }, h('input', { type: 'radio', name: 'kind', checked: st.kind === k, onchange: () => { Object.assign(st, { kind: k, inspection: null }); draw(); } }), h('b', null, label), h('span', { class: 'small muted' }, hint)))),
			h('label', { class: 'field' }, h('span', null, 'Name'), h('input', { value: st.name ?? '', oninput: (e: Event) => (st.name = (e.target as HTMLInputElement).value), placeholder: 'e.g. County parcels 2026' })),
			h('label', { class: 'field' }, h('span', null, 'Each record describes a'), h('input', { value: st.entityType ?? 'property', oninput: (e: Event) => (st.entityType = (e.target as HTMLInputElement).value) }), h('span', { class: 'small muted' }, 'Sources describing the same kind of thing can be combined.')),
			kindFields(st, draw),
			st.inspection ? review(st) : null);
	};
	draw();
	modal('Connect a source', body, [{ label: 'Connect', primary: true, run: async () => {
		if (!st.name) throw new Error('Name the source.');
		st.entityType ??= 'property';
		let mapping: Any, config: Any = {};
		if (st.kind === 'page_capture') {
			mapping = { entityType: st.entityType, pageTypes: st.pageTypes ?? [] };
		} else {
			if (!st.inspection && st.kind !== 'http_json') throw new Error('Inspect a sample first so you can review the mapping.');
			if (!st.inspection) throw new Error('Fetch a sample first: paste the API response (Signal fetches it after connecting).');
			mapping = { version: 1, entityType: st.entityType, fields: st.inspection.proposals.filter((p: Any) => p.include !== false).map(({ basis: _b, include: _i, ...f }: Any) => f) };
		}
		if (st.kind === 'file') config = { format: st.format };
		if (st.kind === 'http_json') config = { url: st.url, ...(st.recordsPath ? { recordsPath: st.recordsPath } : {}) };
		const id = await m(api.sources.create, { name: st.name, kind: st.kind, entityType: st.entityType, config: JSON.stringify(config), mapping: JSON.stringify(mapping), ...(st.kind === 'file' ? { content: st.content, ...(st.asOf ? { dataAsOf: new Date(st.asOf).toISOString() } : {}) } : {}), ...(st.stale ? { staleAfterDays: Number(st.stale) } : {}) });
		if (st.kind === 'http_json') { const r = await act(api.sources.refresh, { sourceId: id }); toast(`Connected. First fetch: ${describe(r)}`); } else toast('Connected');
		go(`#/sources/${id}`);
	} }]);
}

function kindFields(st: Any, draw: () => void) {
	const inspect = async (content: string, extra: Record<string, unknown> = {}) => {
		try { st.inspection = await q(api.sources.inspect, { kind: st.kind, content, entityType: st.entityType ?? 'property', ...extra }); st.content = content; draw(); } catch (e) { toast((e as Error).message, 'error'); }
	};
	const stale = h('label', { class: 'field' }, h('span', null, 'Stale after (days, optional)'), h('input', { type: 'number', min: '1', value: st.stale ?? '', oninput: (e: Event) => (st.stale = (e.target as HTMLInputElement).value) }));
	switch (st.kind) {
		case 'file': return h('div', null,
			h('input', { type: 'file', accept: '.csv,.json,.geojson', onchange: async (e: Event) => { const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return; st.format = fmtOf(f.name); st.name ??= f.name.replace(/\.[^.]+$/, ''); await inspect(await readFile(f), { format: st.format }); } }),
			h('label', { class: 'field' }, h('span', null, 'Data as of (if the provider says)'), h('input', { type: 'date', value: st.asOf ?? '', oninput: (e: Event) => (st.asOf = (e.target as HTMLInputElement).value) })), stale);
		case 'http_json': {
			const sample = h('textarea', { rows: '5', class: 'mono', placeholder: 'Paste a sample response to review the mapping' });
			return h('div', null,
				h('label', { class: 'field' }, h('span', null, 'URL'), h('input', { type: 'url', value: st.url ?? '', oninput: (e: Event) => (st.url = (e.target as HTMLInputElement).value), placeholder: 'https://api.example.com/v1/listings' })),
				h('label', { class: 'field' }, h('span', null, 'Records are at (path in the response, optional)'), h('input', { value: st.recordsPath ?? '', oninput: (e: Event) => (st.recordsPath = (e.target as HTMLInputElement).value), placeholder: 'data.items' })),
				h('p', { class: 'small muted' }, 'Public APIs only for now: credentials are not supported yet (GAP_REGISTER).'),
				sample, h('button', { onclick: () => inspect(sample.value, { format: 'json', ...(st.recordsPath ? { recordsPath: st.recordsPath } : {}) }) }, 'Review mapping'), stale);
		}
		case 'push': case 'manual': {
			const sample = h('textarea', { rows: '5', class: 'mono', placeholder: '[{"id": "A1", "address": "1 Main St", "price": 250000}]' });
			return h('div', null, h('p', { class: 'small muted' }, 'Give one or two example records so Signal can propose the mapping. They are not stored.'), sample, h('button', { onclick: () => inspect(sample.value, { format: 'json' }) }, 'Review mapping'), stale);
		}
		case 'page_capture': {
			const html = h('textarea', { rows: '4', class: 'mono', placeholder: 'Optional: paste a page’s HTML to see which item types it contains' });
			const url = h('input', { type: 'url', placeholder: 'Page URL' });
			return h('div', null,
				h('p', { class: 'small' }, 'Captures come from the Signal browser extension, in your own browser session: Signal never fetches these pages itself.'),
				h('label', { class: 'field' }, h('span', null, 'Item types to keep (comma-separated)'), h('input', { value: (st.pageTypes ?? ['RealEstateListing', 'Product']).join(', '), oninput: (e: Event) => (st.pageTypes = (e.target as HTMLInputElement).value.split(',').map((x) => x.trim()).filter(Boolean)) })),
				html, url, h('button', { onclick: async () => { try { st.pageInspection = await q(api.sources.inspect, { kind: 'page_capture', content: html.value, url: url.value || undefined }); draw(); } catch (e) { toast((e as Error).message, 'error'); } } }, 'Show item types'),
				st.pageInspection ? h('ul', { class: 'small' }, st.pageInspection.types.map((t: Any) => h('li', null, `${t.type} × ${t.count}: ${t.sample.join('; ')}`))) : null);
		}
	}
	return null;
}

const ROLES = ['', 'key', 'id', 'address', 'latitude', 'longitude', 'name', 'validAt'];
const TYPES = ['text', 'number', 'money', 'boolean', 'date'];
function review(st: Any) {
	const i = st.inspection;
	return h('div', { class: 'review' },
		h('h3', null, 'Review the mapping'),
		h('p', { class: 'small' }, `${i.rows} records${i.withGeometry ? `, ${i.withGeometry} with a geometry` : ''}. Proposed from column names only — check it. Roles: key = this source's own record id; id = an identifier other sources may share; address/latitude/longitude/name = used to match records across sources.`),
		i.errors?.length ? h('p', { class: 'error small' }, i.errors.join('; ')) : null,
		i.skipped?.length ? h('p', { class: 'small muted' }, `Not mapped: ${i.skipped.map((s: Any) => `${s.column} (${s.reason})`).join('; ')}`) : null,
		h('table', { class: 'grid small' }, h('thead', null, h('tr', null, ['Use', 'Column', 'Attribute', 'Type', 'Role', 'Sample'].map((x) => h('th', null, x)))),
			h('tbody', null, i.proposals.map((p: Any) => {
				const f = i.fields.find((x: Any) => x.name === p.source);
				return h('tr', null,
					h('td', null, h('input', { type: 'checkbox', checked: p.include !== false, onchange: (e: Event) => (p.include = (e.target as HTMLInputElement).checked) })),
					h('td', null, h('code', null, p.source)),
					h('td', null, h('input', { value: p.attribute, oninput: (e: Event) => (p.attribute = (e.target as HTMLInputElement).value) })),
					h('td', null, h('select', { onchange: (e: Event) => (p.type = (e.target as HTMLSelectElement).value) }, TYPES.map((t) => h('option', { value: t, ...(t === p.type ? { selected: true } : {}) }, t)))),
					h('td', null, h('select', { onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v) p.role = v; else delete p.role; } }, ROLES.map((r) => h('option', { value: r, ...(r === (p.role ?? '') ? { selected: true } : {}) }, r || '—')))),
					h('td', { class: 'muted' }, f?.samples?.join(', ') ?? ''));
			}))));
}
