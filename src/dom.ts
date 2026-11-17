/** A very small DOM toolkit: h() builds elements, nothing more. */
type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> & { class?: string; style?: string };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(props ?? {})) {
		if (v === undefined || v === null || v === false) continue;
		if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
		else if (k === 'value' && 'value' in el) (el as HTMLInputElement).value = String(v);
		else if (k === 'checked') (el as HTMLInputElement).checked = Boolean(v);
		else el.setAttribute(k, v === true ? '' : String(v));
	}
	append(el, children);
	return el;
}
/** Append children, skipping null/false (for conditional content). */
export function add(el: Node, ...children: Child[]) { append(el, children); }
/** Replace an element's children, skipping null/false. */
export function put(el: Element, ...children: Child[]) { el.replaceChildren(); append(el, children); }
function append(el: Node, children: Child[]) {
	for (const c of children) {
		if (c === null || c === undefined || c === false) continue;
		if (Array.isArray(c)) append(el, c);
		else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
	}
}
export const svg = (tag: string, attrs: Record<string, string | number>, ...children: Node[]) => {
	const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
	children.forEach((c) => el.appendChild(c));
	return el;
};

export function ago(iso: string | null | undefined): string {
	if (!iso) return '—';
	const s = (Date.now() - Date.parse(iso)) / 1000;
	if (s < 60) return 'just now';
	if (s < 3600) return `${Math.round(s / 60)} min ago`;
	if (s < 86400) return `${Math.round(s / 3600)} h ago`;
	const d = Math.round(s / 86400);
	return d < 60 ? `${d} days ago` : `${Math.round(d / 30.4)} months ago`;
}
export const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '—');

export function fmt(v: unknown): string {
	if (v === null || v === undefined) return '—';
	if (Array.isArray(v)) return v.map(fmt).join(' / ');
	if (typeof v === 'object' && 'amount' in (v as object)) { const m = v as { amount: number; currency: string | null }; return `${m.currency === 'USD' ? '$' : (m.currency ?? '') + ' '}${m.amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}`; }
	if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) < 10000 ? String(v) : v.toLocaleString('en-US', { maximumFractionDigits: 4 });
	if (typeof v === 'object') return JSON.stringify(v);
	return String(v);
}

export const badge = (text: string, kind = '') => h('span', { class: `badge ${kind}` }, text);
export const tri = (r: string) => h('span', { class: `tri ${r}`, title: r === 'true' ? 'holds' : r === 'false' ? 'does not hold' : 'unknown' }, r === 'true' ? '✓' : r === 'false' ? '✗' : '?');

export function modal(title: string, body: Node, actions: Array<{ label: string; primary?: boolean; run: () => void | Promise<void> }>): void {
	const close = () => back.remove();
	const err = h('p', { class: 'error' });
	const back = h('div', { class: 'modal-back', onclick: (e: Event) => { if (e.target === back) close(); } },
		h('div', { class: 'modal', role: 'dialog', 'aria-label': title },
			h('h2', null, title), body, err,
			h('div', { class: 'row end' }, h('button', { onclick: close }, 'Cancel'),
				actions.map((a) => h('button', { class: a.primary ? 'primary' : '', onclick: async (e: Event) => {
					const b = e.currentTarget as HTMLButtonElement; b.disabled = true; err.textContent = '';
					try { await a.run(); close(); } catch (x) { err.textContent = (x as Error).message; b.disabled = false; }
				} }, a.label)))));
	document.body.appendChild(back);
}

export function toast(text: string, kind: 'ok' | 'error' = 'ok') {
	const t = h('div', { class: `toast ${kind}`, role: 'status' }, text);
	document.body.appendChild(t);
	setTimeout(() => t.remove(), kind === 'error' ? 7000 : 3500);
}
