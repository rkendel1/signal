/**
 * The "My data" section and the dataset parts of discovery in the side panel. All text from files and pages
 * is rendered with textContent. The file's content is read once, sent to the instance, and not kept here.
 */
import type { FeltKitClient } from '@feltdb/feltkit/client';
import {
	Latest, addField, approveMapping, draftChanged, draftMapping, draftProblem, dropField, factsFor, humanAttr, importDataset, inspectDataset, issueLines,
	listDatasets, prepareFile, reconcileSelection, renameField, startDraft, statusOf, typeLabel, unmappedIn, usable, warnings, why,
	type Augmentation, type DatasetRow, type Draft, type Review
} from './datasets.ts';
import type { FieldMapping } from '../../lib/datasets/dataset.ts';
import { ROLE_LABEL } from './datasets.ts';

export interface Deps {
	client(): FeltKitClient | null;
	status(text: string, error?: boolean): void;
	errorText(e: unknown): string;
	/** The selection changed: the panel re-evaluates. */
	onSelection(): void;
}

const SELECTED = 'signal.datasets.selected';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = (tag: string, cls?: string, text?: string) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

export function initData(deps: Deps) {
	let list: DatasetRow[] = [];
	let selected: string[] = [];
	const listGuard = new Latest(), reviewGuard = new Latest();
	let open: { dataset: DatasetRow; review: Review; draft: Draft; version: number } | null = null;

	const saveSelection = () => chrome.storage.local.set({ [SELECTED]: selected }).catch(() => undefined);

	/** Reload the list. A slower, older reply never replaces a newer one. */
	async function refresh(): Promise<void> {
		const c = deps.client();
		if (!c) { list = []; selected = []; render(); return; }
		const ticket = listGuard.next();
		const stored = ((await chrome.storage.local.get(SELECTED))[SELECTED] as string[] | undefined) ?? selected;
		const next = await listDatasets(c);
		if (!listGuard.isCurrent(ticket)) return;
		list = next;
		const kept = reconcileSelection(stored, list);
		const changed = kept.join() !== selected.join();
		selected = kept;
		void saveSelection();
		render();
		if (changed) deps.onSelection();
	}

	function setSelected(ids: string[]) {
		selected = reconcileSelection(ids, list);
		void saveSelection();
		render();
		deps.onSelection();
	}

	// ---------------------------------------------------------------- the list

	function renderList() {
		const ul = $('datasets'); ul.replaceChildren();
		if (!list.length) ul.append(el('li', 'muted', 'You have not imported any data yet.'));
		for (const d of list) {
			const st = statusOf(d);
			const li = el('li', 'dataset');
			li.dataset.id = d.id;
			const head = el('div', 'head');
			head.append(el('strong', '', d.name), el('span', `badge ds-${st.key}`, st.label));
			li.append(head, el('div', 'muted', `${d.format === 'csv' ? 'CSV' : 'GeoJSON'} · ${d.rows.toLocaleString('en-US')} records · version ${d.latestVersion} · ${d.dataAsOf ? `data as of ${d.dataAsOf}` : 'data date not stated'}`));
			const b = el('button', 'secondary small', st.key === 'proposed' ? 'Review and approve' : 'Inspect') as HTMLButtonElement; b.type = 'button';
			b.addEventListener('click', () => void openReview(d).catch((e) => deps.status(deps.errorText(e), true)));
			li.append(b);
			ul.append(li);
		}
	}

	// ---------------------------------------------------------------- import

	async function onImport(ev: Event) {
		ev.preventDefault();
		const c = deps.client(); if (!c) return;
		const input = $<HTMLInputElement>('import-file'), btn = $<HTMLButtonElement>('import-go'), note = $('import-note');
		note.className = 'muted'; note.textContent = '';
		const file = input.files?.[0];
		btn.disabled = true;
		try {
			if (!file) throw new Error('Choose a CSV or GeoJSON file first.');
			note.textContent = 'Checking the file…';
			const prepared = await prepareFile(file);
			note.textContent = `Importing ${(prepared.bytes / 1024).toFixed(0)} KB…`;
			const name = $<HTMLInputElement>('import-name').value.trim() || prepared.defaultName;
			const asOf = $<HTMLInputElement>('import-asof').value || undefined;
			const r = await importDataset(c, prepared, { name, freshness: 'static', dataAsOf: asOf });
			note.textContent = `Imported “${name}”: ${r.review.rows.toLocaleString('en-US')} records. Check the proposed mapping below, then approve it.`;
			input.value = ''; autoName = ''; $<HTMLInputElement>('import-name').value = ''; $<HTMLInputElement>('import-asof').value = '';
			await refresh();
			const d = list.find((x) => x.id === r.datasetId);
			if (d) await openReview(d, r.review);
		} catch (e) {
			note.className = 'error'; note.textContent = deps.errorText(e);
		} finally { btn.disabled = false; }
	}

	// ---------------------------------------------------------------- review

	async function openReview(d: DatasetRow, known?: Review, version?: number): Promise<void> {
		const c = deps.client(); if (!c) return;
		const ticket = reviewGuard.next();
		const review = known && version === undefined ? known : await inspectDataset(c, d.id, version);
		if (!reviewGuard.isCurrent(ticket)) return; // another dataset or version was opened meanwhile
		open = { dataset: d, review, draft: startDraft(review.mapping), version: review.version };
		renderReview();
		$('review').scrollIntoView?.({ block: 'nearest' });
	}

	function renderReview() {
		const box = $('review'); box.replaceChildren();
		if (!open) { box.hidden = true; return; }
		box.hidden = false;
		const { dataset, review, draft } = open;
		const latest = list.find((x) => x.id === dataset.id)?.latestVersion ?? review.version;
		const viewingOld = review.version !== latest;
		const st = statusOf(review);

		const head = el('div', 'head');
		head.append(el('h3', '', `Mapping for “${dataset.name}”`), el('span', `badge ds-${st.key}`, viewingOld ? `Version ${review.version} (earlier)` : st.label));
		box.append(head, el('p', 'hint', viewingOld ? 'This is an earlier version, kept as it was. You can start from it, and approving creates a new version.' : st.hint));
		if (latest > 1) {
			const sel = document.createElement('select'); sel.id = 'review-version'; sel.setAttribute('aria-label', 'Version');
			for (let v = latest; v >= 1; v--) { const o = el('option', '', `Version ${v}${v === latest ? ' (latest)' : ''}`) as HTMLOptionElement; o.value = String(v); o.selected = v === review.version; sel.append(o); }
			sel.addEventListener('change', () => void openReview(dataset, undefined, Number(sel.value)).catch((e) => deps.status(deps.errorText(e), true)));
			box.append(sel);
		}

		box.append(el('p', 'muted', `${review.rows.toLocaleString('en-US')} ${review.rows === 1 ? 'record' : 'records'} · ${review.format === 'csv' ? 'CSV' : 'GeoJSON'}. Signal matches a property by parcel ID, then by address and location, and never guesses between two candidates.`));

		// Renaming must not rebuild the review: the change event fires when the person presses "approve", and replacing
		// that button mid-click would lose the click. Only the approve button and its note are updated, in place.
		let syncFoot: () => void = () => undefined;
		// One stacked row per column: a side panel is too narrow for a table.
		const mapping = el('div', 'mapping');
		for (const f of draft.fields) {
			const prof = review.fields.find((x) => x.name === f.source);
			const r = el('div', 'mrow'); r.dataset.source = f.source;
			const src = el('div', 'src'); src.append(el('strong', '', f.source));
			if (f.role) src.append(el('span', 'muted', ` · used to match: ${ROLE_LABEL[f.role]}`));
			const rm = el('button', 'link', 'Leave out') as HTMLButtonElement; rm.type = 'button'; rm.setAttribute('aria-label', `Leave out ${f.source}`);
			rm.addEventListener('click', () => { open!.draft = dropField(open!.draft, f.source); renderReview(); });
			src.append(rm);
			const to = el('label', 'becomes'); to.append(el('span', 'muted', 'Becomes '));
			const input = document.createElement('input'); input.type = 'text'; input.value = f.attribute; input.setAttribute('aria-label', `Signal attribute for ${f.source}`); input.className = 'attr';
			input.addEventListener('change', () => { open!.draft = renameField(open!.draft, f.source, input.value); syncFoot(); });
			to.append(input);
			r.append(src, to, el('div', 'samples muted', `Examples: ${(prof?.samples ?? []).join(' · ') || '—'}`), el('div', 'kind muted', `Kind: ${typeLabel(f)}`), el('div', 'why muted', why(review, f)));
			mapping.append(r);
		}
		box.append(mapping);

		const left = unmappedIn(draft, review.fields.map((f) => f.name));
		if (left.length) {
			const d = el('details', 'unmapped') as HTMLDetailsElement; d.open = true;
			d.append(el('summary', '', `Not used (${left.length})`));
			d.append(el('p', 'muted', 'Signal does not know these columns. They are left out unless you map them.'));
			for (const name of left) {
				const prof = review.fields.find((x) => x.name === name);
				const row = el('div', 'unmapped-row'); row.dataset.source = name;
				row.append(el('span', '', name), el('span', 'muted', (prof?.samples ?? []).join(', ') || '—'));
				const attr = document.createElement('input'); attr.type = 'text'; attr.placeholder = 'attribute name'; attr.setAttribute('aria-label', `Signal attribute for ${name}`);
				const type = document.createElement('select'); type.setAttribute('aria-label', `Kind of ${name}`);
				for (const [v, t] of [['text', 'Text'], ['number', 'Number'], ['money', 'Money (USD)']] as const) { const o = el('option', '', t) as HTMLOptionElement; o.value = v; o.selected = v === (prof?.type === 'number' ? 'number' : 'text'); type.append(o); }
				const add = el('button', 'secondary small', 'Use this column') as HTMLButtonElement; add.type = 'button';
				add.addEventListener('click', () => { if (!attr.value.trim()) { attr.focus(); return; } open!.draft = addField(open!.draft, name, attr.value, type.value as FieldMapping['type']); renderReview(); });
				row.append(attr, type, add);
				d.append(row);
			}
			box.append(d);
		}

		// What was checked
		const checks = el('div', 'checks');
		const ws = warnings(review, draftMapping(draft));
		checks.append(el('div', review.issueCount ? 'warn' : 'ok', review.issueCount ? `${review.issueCount} value${review.issueCount === 1 ? '' : 's'} could not be read and ${review.issueCount === 1 ? 'is' : 'are'} left blank:` : 'Every mapped value could be read.'));
		if (review.issueCount) { const ul = el('ul', 'issues'); for (const line of issueLines(review)) ul.append(el('li', '', line)); checks.append(ul); }
		if (ws.length) { const ul = el('ul', 'warnings'); for (const w of ws) ul.append(el('li', '', w)); checks.append(ul); }
		box.append(checks);

		const pv = el('details', 'preview'); pv.append(el('summary', '', 'First records, before and after'));
		for (const [i, r] of review.preview.entries()) {
			const row = el('div', 'pv'); row.append(el('div', 'muted', `Record ${i + 1}`));
			row.append(el('div', '', `Your file: ${Object.entries(r.raw).map(([k, v]) => `${k} = ${v ?? '—'}`).join(' · ')}`));
			row.append(el('div', '', `Signal reads: ${Object.entries(r.mapped).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${humanAttr(k)} = ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}`));
			pv.append(row);
		}
		box.append(pv);

		// Approval is explicit, and always creates a new version.
		const approve = el('button', '') as HTMLButtonElement;
		approve.id = 'approve'; approve.type = 'button';
		const note = el('span', 'muted');
		syncFoot = () => {
			const problem = draftProblem(open!.draft), dirty = draftChanged(open!.draft);
			approve.textContent = dirty ? 'Save my changes and approve (new version)' : review.reviewed && !viewingOld ? 'Approved' : 'Approve this mapping';
			approve.disabled = !!problem || (review.reviewed && !viewingOld && !dirty);
			note.className = problem ? 'error' : 'muted';
			note.textContent = problem ?? (!review.reviewed ? 'Approving lets Signal use this file in discovery. You can change the mapping later; every change is a new version.' : '');
		};
		syncFoot();
		approve.addEventListener('click', () => void doApprove(approve));
		const row = el('div', 'row'); row.append(approve, note);
		box.append(row);
	}

	async function doApprove(btn: HTMLButtonElement) {
		const c = deps.client(); if (!c || !open) return;
		const ticket = reviewGuard.next();
		const { dataset, draft } = open;
		btn.disabled = true; deps.status('Approving…');
		try {
			const r = await approveMapping(c, dataset.id, draftMapping(draft), dataset.dataAsOf ?? undefined);
			await refresh();
			if (!reviewGuard.isCurrent(ticket)) return;
			open = { dataset: list.find((x) => x.id === dataset.id) ?? dataset, review: r.review, draft: startDraft(r.review.mapping), version: r.version };
			renderReview();
			deps.status(`Approved “${dataset.name}” as version ${r.version}. Choose it under “Use my data” to use it in discovery.`);
		} catch (e) { deps.status(deps.errorText(e), true); btn.disabled = false; }
	}

	// ---------------------------------------------------------------- choosing data for discovery

	function renderPick() {
		const box = $('dataset-pick'); box.replaceChildren();
		const chips = $('dataset-chips'); chips.replaceChildren();
		if (!list.length) box.append(el('p', 'muted', 'No data yet. Import a file under “My data” below.'));
		for (const d of list) {
			const u = usable(d);
			const label = el('label', `pick${u.ok ? '' : ' off'}`);
			const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = d.id; cb.checked = selected.includes(d.id); cb.disabled = !u.ok;
			cb.addEventListener('change', () => setSelected(cb.checked ? [...selected, d.id] : selected.filter((x) => x !== d.id)));
			label.append(cb, document.createTextNode(` ${d.name}`));
			if (!u.ok) label.append(el('span', 'muted why', ` — ${u.why}`));
			else label.append(el('span', 'muted', ` — version ${d.latestVersion}`));
			box.append(label);
		}
		const names = selected.map((id) => list.find((d) => d.id === id)!).filter(Boolean);
		$('use-count').textContent = names.length ? `(${names.length})` : '';
		if (!names.length) { chips.append(el('span', 'muted', list.length ? 'Not using your data: results come from the page alone.' : '')); return; }
		chips.append(el('span', 'muted', 'The next evaluation will use: '));
		for (const d of names) {
			const chip = el('span', 'chip', `${d.name} (v${d.latestVersion})`);
			const x = el('button', 'link', 'Remove') as HTMLButtonElement; x.type = 'button'; x.setAttribute('aria-label', `Remove ${d.name} from the evaluation`);
			x.addEventListener('click', () => setSelected(selected.filter((id) => id !== d.id)));
			chip.append(x); chips.append(chip);
		}
	}

	function render() { renderList(); renderPick(); if (open) { const cur = list.find((d) => d.id === open!.dataset.id); if (!cur) { open = null; } renderReview(); } else renderReview(); }

	$('import-form').addEventListener('submit', (ev) => void onImport(ev));
	// The name follows the chosen file until the person types their own.
	let autoName = '';
	$('import-file').addEventListener('change', () => {
		const f = ($('import-file') as HTMLInputElement).files?.[0];
		const name = $<HTMLInputElement>('import-name');
		if (f && (!name.value || name.value === autoName)) { autoName = f.name.replace(/\.[^.]+$/, ''); name.value = autoName; }
	});

	return {
		refresh,
		selected: () => [...selected],
		/** Forget everything (sign-out, disconnect). */
		reset() { listGuard.cancel(); reviewGuard.cancel(); list = []; selected = []; open = null; render(); },
		/** A dataset was refused by the instance (retired, not approved): reload what can be used. */
		async resync() { await refresh().catch(() => undefined); }
	};
}

/** Add "where do these facts come from" to a candidate card. Only when a dataset took part. */
export function renderFacts(li: HTMLElement, cand: { key: string; metrics?: Record<string, never> | Record<string, { value: number | null; possibleValues?: number[]; inputs: Array<{ attr: string; provenance: string; source?: string }> }> }, aug: Augmentation | undefined): void {
	if (!aug) return;
	const f = factsFor(cand.key, (cand.metrics ?? {}) as never, aug);
	if (!f.links.length && !f.external.length) return;
	const d = el('details', 'facts'); d.dataset.key = cand.key;
	const used = f.external.length;
	d.append(el('summary', '', used ? `Your data added ${used} fact${used === 1 ? '' : 's'}` : 'Your data did not add anything to this property'));

	const link = el('div', 'sect'); link.append(el('h4', '', 'How Signal connected this property to your data'));
	for (const l of f.links) {
		const row = el('div', `link ${l.status}`); row.dataset.status = l.status;
		row.append(el('strong', '', `${l.datasetName}: `), document.createTextNode(l.text));
		row.append(el('div', 'muted', l.reason));
		for (const o of l.options ?? []) row.append(el('div', 'muted opt', `Could be record ${o.recordId}${o.address ? ` (${o.address})` : ''}${o.distanceM !== null ? `, ${o.distanceM} m from the listing` : ''}`));
		link.append(row);
	}
	d.append(link);

	if (f.external.length) {
		const ext = el('div', 'sect'); ext.append(el('h4', '', 'From your data (not shown on the listing page)'));
		for (const v of f.external) {
			const row = el('div', 'fact external'); row.dataset.attr = v.attribute;
			row.append(el('strong', '', `${v.label}: ${v.value}`));
			row.append(el('div', 'muted', `${v.dataset} · ${v.version} · ${v.asOf} · ${v.fresh}`));
			row.append(el('div', 'muted', `Record ${v.record}, matched by ${v.basis}`));
			if (v.conflict) row.append(el('div', 'conflict', v.conflict));
			ext.append(row);
		}
		d.append(ext);
	}

	if (f.metrics.length) {
		const m = el('div', 'sect'); m.append(el('h4', '', 'Calculated'));
		for (const x of f.metrics) {
			const row = el('div', 'fact calculated'); row.append(el('strong', '', `${x.name}: ${x.value}`));
			row.append(el('div', 'muted', x.inputs.map((i) => `${i.attr} from ${i.from}`).join(' · ')));
			if (x.unknown.length) row.append(el('div', 'missing', `Missing: ${x.unknown.join(', ')}`));
			m.append(row);
		}
		d.append(m);
	}
	li.append(d);
}
