import { api, go, m, q, route, type Any } from '../app.ts';
import { add, put, ago, badge, fmt, h, modal, toast } from '../dom.ts';

const OPS: Array<[string, string, 'none' | 'scalar' | 'number' | 'range' | 'list' | 'pct']> = [
	['lte', '≤', 'number'], ['lt', '<', 'number'], ['gte', '≥', 'number'], ['gt', '>', 'number'], ['between', 'between', 'range'],
	['eq', 'is', 'scalar'], ['neq', 'is not', 'scalar'], ['in', 'is one of', 'list'], ['not_in', 'is none of', 'list'], ['contains', 'contains', 'scalar'],
	['exists', 'is known', 'none'], ['missing', 'is unknown', 'none'], ['decreased_pct', 'dropped by ≥ %', 'pct'], ['increased_pct', 'rose by ≥ %', 'pct'], ['changed', 'changed', 'none'],
];
const BLANK = { name: '', entityType: 'property', severity: 'info', require: [{ attr: '', op: 'lte', value: 0 }], exclude: [], prefer: [] };

export async function criteriaView(el: HTMLElement) {
	const { id, params } = route();
	const list: Any[] = await q(api.criteria.list);
	add(el, h('div', { class: 'toolbar' }, h('h1', null, 'Criteria'), h('button', { class: 'primary', onclick: () => go('#/criteria?new=1') }, 'New criteria')));
	const left = h('div', { class: 'pane' }, list.length ? h('ul', { class: 'feed' }, list.map((c) => h('li', { class: `card ${c.id === id ? 'active' : ''}`, onclick: () => go(`#/criteria/${c.id}`) },
		h('div', { class: 'row between' }, h('strong', null, c.name), c.enabled ? badge('monitoring', 'match') : badge('paused', 'warn')),
		h('div', { class: 'meta' }, `${c.entityType} · v${c.version} · ${c.matches} matches, ${c.possible} possible · updated ${ago(c.updatedAt)}`),
		h('p', { class: 'small muted' }, c.definition?.description ?? '')))) : h('div', { class: 'empty' }, h('p', null, 'Criteria say what matters to you: required conditions, exclusions, preferences and how fresh evidence must be.')));
	const right = h('aside', { class: 'detail', 'data-editing': '1' });
	if (id) await editor(right, id);
	else if (params.get('new') === '1') await editor(right, null);
	else right.removeAttribute('data-editing'), right.append(h('p', { class: 'muted' }, 'Select criteria to see and refine them.'));
	add(el, h('div', { class: 'split' }, left, right));
}

async function editor(el: HTMLElement, id: string | null) {
	const current: Any = id ? await q(api.criteria.get, { criteriaId: id }) : null;
	let def: Any = structuredClone(current ? current.versions[0].definition : BLANK);
	const cat: Any = await q(api.criteria.attributes, { entityType: def.entityType });
	const attrNames = [...cat.attributes.map((a: Any) => a.attr), ...(def.derive ?? []).map((d: Any) => d.name)];
	const out = h('div', { class: 'preview' });
	const json = h('textarea', { rows: '14', class: 'mono', spellcheck: 'false' });
	const form = h('div');
	const syncJson = () => { json.value = JSON.stringify(def, null, 2); };
	const fromJson = () => { try { def = JSON.parse(json.value); drawForm(); } catch (e) { toast(`JSON: ${(e as Error).message}`, 'error'); } };

	const leafRow = (list: Any[], i: number, withWeight: boolean) => {
		const item = withWeight ? list[i].when : list[i];
		if (!('attr' in item)) return h('div', { class: 'leaf muted small' }, `Group condition (${'all' in item ? 'all' : 'any'} of ${(item.all ?? item.any).length}) — edit in JSON below`);
		const op = OPS.find((o) => o[0] === item.op) ?? OPS[0];
		const valueInput = () => {
			const kind = op[2];
			if (kind === 'none') return null;
			const v = item.value;
			const text = kind === 'range' ? (Array.isArray(v) ? v.join(' – ') : '') : kind === 'list' ? (Array.isArray(v) ? v.join(', ') : '') : v ?? '';
			return h('input', { value: text, class: 'value', placeholder: kind === 'range' ? 'min – max' : kind === 'list' ? 'a, b, c' : 'value', onchange: (e: Event) => {
				const t = (e.target as HTMLInputElement).value.trim();
				const num = (s: string) => (s !== '' && !isNaN(Number(s.replace(/[$,]/g, ''))) ? Number(s.replace(/[$,]/g, '')) : s);
				item.value = kind === 'range' ? t.split(/\s*[–-]\s*/).map((s) => Number(s.replace(/[$,]/g, ''))) : kind === 'list' ? t.split(',').map((s) => num(s.trim())) : kind === 'scalar' ? num(t) : Number(t.replace(/[$,]/g, ''));
				syncJson();
			} });
		};
		return h('div', { class: 'leaf' },
			h('input', { list: 'attrs', value: item.attr, placeholder: 'attribute', onchange: (e: Event) => { item.attr = (e.target as HTMLInputElement).value; syncJson(); } }),
			h('select', { onchange: (e: Event) => { item.op = (e.target as HTMLSelectElement).value; const k = OPS.find((o) => o[0] === item.op)![2]; if (k === 'none') delete item.value; if (k.match(/pct/)) item.withinDays ??= 30; syncJson(); drawForm(); } }, OPS.map(([v, l]) => h('option', { value: v, ...(v === item.op ? { selected: true } : {}) }, l))),
			valueInput(),
			op[2] === 'pct' ? h('input', { type: 'number', class: 'small-num', title: 'within days', value: item.withinDays ?? 30, onchange: (e: Event) => { item.withinDays = Number((e.target as HTMLInputElement).value); syncJson(); } }) : null,
			h('input', { type: 'number', class: 'small-num', title: 'evidence must be newer than (days)', placeholder: 'max age', value: item.maxAgeDays ?? '', onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value; if (v) item.maxAgeDays = Number(v); else delete item.maxAgeDays; syncJson(); } }),
			withWeight ? h('input', { type: 'number', class: 'small-num', title: 'weight', value: list[i].weight, onchange: (e: Event) => { list[i].weight = Number((e.target as HTMLInputElement).value); syncJson(); } }) : null,
			h('button', { class: 'link', title: 'remove', onclick: () => { list.splice(i, 1); syncJson(); drawForm(); } }, '×'));
	};
	const section = (title: string, key: 'require' | 'exclude' | 'prefer', hint: string) => {
		def[key] ??= [];
		const list = def[key];
		return h('fieldset', null, h('legend', null, title), h('p', { class: 'small muted' }, hint),
			list.map((_: Any, i: number) => leafRow(list, i, key === 'prefer')),
			h('button', { class: 'link', onclick: () => { list.push(key === 'prefer' ? { when: { attr: '', op: 'gte', value: 0 }, weight: 10 } : { attr: '', op: key === 'exclude' ? 'in' : 'lte', value: key === 'exclude' ? [] : 0 }); syncJson(); drawForm(); } }, '+ add'));
	};
	const drawForm = () => {
		put(form, 
			h('label', { class: 'field' }, h('span', null, 'Name'), h('input', { value: def.name, oninput: (e: Event) => { def.name = (e.target as HTMLInputElement).value; syncJson(); } })),
			h('div', { class: 'row' },
				h('label', { class: 'field' }, h('span', null, 'Evaluates'), current ? h('input', { value: def.entityType, disabled: true }) : h('select', { onchange: (e: Event) => { def.entityType = (e.target as HTMLSelectElement).value; syncJson(); } }, (cat.entityTypes.length ? cat.entityTypes : ['property']).map((t: string) => h('option', { value: t, ...(t === def.entityType ? { selected: true } : {}) }, t)))),
				h('label', { class: 'field' }, h('span', null, 'Severity'), h('select', { onchange: (e: Event) => { def.severity = (e.target as HTMLSelectElement).value; syncJson(); } }, ['info', 'warning', 'critical'].map((s) => h('option', { value: s, ...(s === def.severity ? { selected: true } : {}) }, s)))),
				h('label', { class: 'field' }, h('span', null, 'Evidence max age (days)'), h('input', { type: 'number', value: def.maxAgeDays ?? '', onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value; if (v) def.maxAgeDays = Number(v); else delete def.maxAgeDays; syncJson(); } }))),
			section('Required', 'require', 'All must hold for a match. If evidence is missing, stale or conflicting, the finding is “possible”, never a silent no.'),
			section('Disqualifying', 'exclude', 'Any that holds removes the entity.'),
			section('Preferred', 'prefer', 'Each that holds adds its weight to the priority.'),
			def.derive?.length ? h('p', { class: 'small' }, 'Derived values: ', def.derive.map((d: Any) => h('code', null, d.name)), ' (edit in JSON)') : null);
	};
	drawForm(); syncJson();

	const run = async (save: boolean) => {
		const definition = json.value;
		try {
			if (save) {
				const r = await m(api.criteria.save, { definition, ...(id ? { criteriaId: id } : {}) });
				toast(`Saved v${r.version}${r.run ? `: ${r.run.entities} evaluated, ${r.run.created} new, ${r.run.closed} closed (${r.run.durationMs} ms)` : ''}`);
				go(`#/criteria/${r.criteriaId}`);
			} else {
				const p = await q(api.criteria.preview, { definition, ...(id ? { criteriaId: id } : {}) });
				put(out, h('h3', null, 'Effect on current information'),
					h('p', null, `${p.entities} entities: ${p.counts.match} match, ${p.counts.possible} possible, ${p.counts.non_match} do not meet it, ${p.counts.excluded} excluded, ${p.counts.insufficient} not enough evidence.`),
					p.delta ? h('p', null, `Compared with the saved version: ${p.delta.wouldOpen} would open, ${p.delta.wouldClose} would close (superseded), ${p.delta.wouldStay} stay.`) : null,
					p.counts.match + p.counts.possible === 0 ? h('p', { class: 'warn' }, 'Nothing would qualify. Check the thresholds against the attribute ranges.') : null,
					h('ul', { class: 'small' }, p.top.slice(0, 10).map((t: Any) => h('li', null, badge(t.qualification, t.qualification), ` ${t.label ?? t.entityId} — ${t.summary}`))));
			}
		} catch (e) { put(out, h('p', { class: 'error' }, (e as Error).message)); }
	};

	add(el, 
		h('div', { class: 'row between' }, h('h2', null, current ? current.name : 'New criteria'), current ? badge(`v${current.version}`) : null),
		current ? h('div', { class: 'row' },
			h('button', { onclick: async () => { const r = await m(api.criteria.setEnabled, { criteriaId: id, enabled: !current.enabled }); toast(r.enabled ? 'Monitoring resumed (re-evaluated)' : 'Paused'); } }, current.enabled ? 'Pause monitoring' : 'Resume monitoring'),
			h('a', { class: 'button', href: `#/findings?criteria=${id}` }, 'Findings'),
			h('button', { class: 'danger', onclick: () => modal('Remove criteria?', h('p', null, 'Open findings are closed as superseded; their history and every version of these criteria are kept.'), [{ label: 'Remove', primary: true, run: async () => { await m(api.criteria.remove, { criteriaId: id }); go('#/criteria'); } }]) }, 'Remove')) : null,
		h('datalist', { id: 'attrs' }, attrNames.map((a: string) => h('option', { value: a }))),
		form,
		h('details', null, h('summary', null, 'Criteria as JSON (the saved form; edit here for groups, derived values, trust, change thresholds)'), json, h('button', { onclick: fromJson }, 'Apply JSON to the form')),
		h('div', { class: 'row' }, h('button', { onclick: () => run(false) }, 'Preview effect'), h('button', { class: 'primary', onclick: () => run(true) }, current ? `Save as v${current.version + 1}` : 'Save and evaluate')),
		out,
		h('h3', null, 'Attributes available'),
		h('table', { class: 'grid small' }, h('thead', null, h('tr', null, ['Attribute', 'Sources (coverage)', 'Range / samples'].map((x) => h('th', null, x)))),
			h('tbody', null, cat.attributes.map((a: Any) => h('tr', null, h('td', null, h('code', null, a.attr)), h('td', null, a.sources.map((s: Any) => `${s.name} ${Math.round((s.present / Math.max(1, s.of)) * 100)}%`).join('; ')), h('td', null, a.min !== undefined ? `${fmt(a.min)} – ${fmt(a.max)}` : a.samples.join(', ')))))),
		current && current.versions.length > 1 ? [h('h3', null, 'Versions'), h('ul', { class: 'small' }, current.versions.map((v: Any) => h('li', null, `v${v.version} — ${ago(v.createdAt)}`)))] : null,
	);
}
