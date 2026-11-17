/**
 * What a source actually provides (pure): attribute coverage, identity coverage, link outcomes, freshness,
 * and a plain statement of how and when it can change. Computed from stored observations, never claimed.
 */
import { num } from './evaluate.ts';
import type { LinkStatus, RefreshMode, StoredObservation } from './types.ts';

export interface AttributeCoverage { attr: string; present: number; types: string[]; min?: number; max?: number; samples: string[]; unit: string | null }
export interface Coverage {
	records: number;
	attributes: AttributeCoverage[];
	identity: { withId: number; withAddress: number; withLocation: number; withNothing: number; positionalKeys: number };
	links: Partial<Record<LinkStatus, number>>;
	validAt: { min: string | null; max: string | null; missing: number };
}

const typeOf = (v: unknown) => (v === null ? 'null' : typeof v === 'object' ? ('amount' in (v as object) ? 'money' : 'object') : typeof v);
const show = (v: unknown) => (typeof v === 'object' && v && 'amount' in v ? String((v as { amount: number }).amount) : String(v));

export function coverage(obs: StoredObservation[], linkStatuses: LinkStatus[]): Coverage {
	const by = new Map<string, { present: number; types: Set<string>; nums: number[]; samples: Set<string>; unit: string | null }>();
	for (const o of obs) for (const [k, a] of Object.entries(o.attributes)) {
		if (a.value === null) continue;
		const e = by.get(k) ?? by.set(k, { present: 0, types: new Set(), nums: [], samples: new Set(), unit: a.unit ?? null }).get(k)!;
		e.present++; e.types.add(typeOf(a.value));
		const n = num(a.value); if (n !== null) e.nums.push(n);
		if (e.samples.size < 3) e.samples.add(show(a.value).slice(0, 60));
	}
	const attributes = [...by].map(([attr, e]) => ({ attr, present: e.present, types: [...e.types], unit: e.unit, samples: [...e.samples], ...(e.nums.length ? { min: e.nums.reduce((a, b) => Math.min(a, b)), max: e.nums.reduce((a, b) => Math.max(a, b)) } : {}) })).sort((a, b) => b.present - a.present || a.attr.localeCompare(b.attr));
	const links: Coverage['links'] = {};
	for (const s of linkStatuses) links[s] = (links[s] ?? 0) + 1;
	const valid = obs.map((o) => o.validAt).filter((v): v is string => !!v).sort();
	return {
		records: obs.length, attributes, links,
		identity: {
			withId: obs.filter((o) => Object.keys(o.identity.ids).length).length,
			withAddress: obs.filter((o) => o.identity.addressKey).length,
			withLocation: obs.filter((o) => o.identity.lat !== null).length,
			withNothing: obs.filter((o) => !Object.keys(o.identity.ids).length && !o.identity.addressKey && o.identity.lat === null).length,
			positionalKeys: obs.filter((o) => o.keyBasis === 'position').length,
		},
		validAt: { min: valid[0] ?? null, max: valid[valid.length - 1] ?? null, missing: obs.length - valid.length },
	};
}

/** What "real time" means for this source, stated plainly. */
export function refreshStatement(kind: string, mode: RefreshMode, intervalMinutes: number | null | undefined): string {
	switch (mode) {
		case 'snapshot': return 'Snapshot: changes only when you upload a new file. Each upload is compared with the last; only differences count as new information.';
		case 'poll': return `Polled: Signal fetches it when a refresh is requested${intervalMinutes ? ` (intended every ${intervalMinutes} min, by the poller process or "Refresh now")` : ' ("Refresh now")'}. Changes between fetches are not seen. FeltKit cannot schedule outbound fetches itself (GAP_REGISTER G-PLAT-1).`;
		case 'push': return kind === 'manual' ? 'Manual: records you enter in Signal. Evaluated the moment you save them.' : 'Push: the sending system pushes records; each push is evaluated in the same transaction it is recorded in. As live as the sender.';
		case 'capture': return 'Browser capture: pages you capture in your own browser session. Partial by nature — only what was rendered; a listing missing from a later capture is not treated as removed.';
	}
}
