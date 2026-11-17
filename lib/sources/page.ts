/**
 * Browser-observed pages as a source: a captured page's signal.page/v1 representation becomes observation
 * drafts, one per entity of the types the user chose. Captures are partial by nature (only what was rendered
 * and visible), so a record missing from a later capture is NOT retracted.
 */
import type { AttributeValue, PageEntity, PageRepresentation } from '../page/types.ts';
import { normalizeAddress } from '../engine/mapping.ts';
import { protectedTerm } from '../engine/policy.ts';
import type { IdentityHints, ObservationDraft, ObservedValue, Value } from '../engine/types.ts';

export interface PageMapping { entityType: string; pageTypes: string[] }

function toValue(v: AttributeValue): Value {
	if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
	if ('amount' in v) return { amount: v.amount, currency: v.currency };
	if ('best' in v) return v.value;
	if ('url' in v) return v.url;
	return null; // money ranges stay raw only
}

const first = (e: PageEntity, ...names: string[]) => { for (const n of names) { const a = e.attributes.find((x) => x.name === n && x.value !== null); if (a) return a.value; } return null; };

export function pageEntityToDraft(e: PageEntity, page: PageRepresentation, entityType: string): ObservationDraft {
	const attributes: Record<string, ObservedValue> = {};
	for (const a of e.attributes) {
		if (attributes[a.name] || protectedTerm(a.name)) continue;
		const value = toValue(a.value);
		if (value === null) continue;
		attributes[a.name] = { value, raw: a.raw, ...(typeof a.value === 'object' && a.value && 'currency' in a.value && a.value.currency ? { unit: a.value.currency } : {}), transform: `page:${a.method}/${a.provenance}` };
	}
	const addr = first(e, 'address', 'streetAddress');
	const name = first(e, 'name');
	const address = typeof addr === 'string' ? addr : typeof name === 'string' && normalizeAddress(name) ? name : null;
	const lat = first(e, 'latitude'), lng = first(e, 'longitude');
	const ids: Record<string, string> = {};
	const pid = first(e, 'parcelId', 'apn', 'parcelNumber');
	if (pid !== null) ids.parcelId = String(pid);
	if (e.identity.basis === 'url' || e.identity.basis === '@id') ids.url = e.identity.key;
	if (e.identity.basis === 'sku') ids.sku = e.identity.key;
	const identity: IdentityHints = { ids, address, addressKey: normalizeAddress(address), lat: typeof lat === 'number' ? lat : null, lng: typeof lng === 'number' ? lng : null, name: typeof name === 'string' ? name : null };
	return {
		recordKey: `${e.type}:${e.identity.key}`,
		keyBasis: e.identity.strength === 'positional' ? 'position' : 'identifier',
		entityType, attributes, identity, validAt: null,
		locator: `${page.source.locator}${e.evidenceRefs[0] ? ` #${e.evidenceRefs[0]}` : ''}`,
	};
}

export function pageToDrafts(page: PageRepresentation, m: PageMapping): { drafts: ObservationDraft[]; skipped: Array<{ entity: string; reason: string }> } {
	const want = new Set(m.pageTypes);
	const drafts: ObservationDraft[] = [];
	const skipped: Array<{ entity: string; reason: string }> = [];
	const seen = new Set<string>();
	for (const e of page.entities) {
		if (!want.has(e.type)) continue;
		if (e.identity.ambiguous) { skipped.push({ entity: e.id, reason: 'another entity on the page has the same name; continuity cannot be established' }); continue; }
		const d = pageEntityToDraft(e, page, m.entityType);
		if (!Object.keys(d.attributes).length) { skipped.push({ entity: e.id, reason: 'no attribute values' }); continue; }
		if (seen.has(d.recordKey)) continue;
		seen.add(d.recordKey);
		drafts.push(d);
	}
	return { drafts, skipped };
}

/** The entity types on a page and how many of each, so a person can choose what the source contributes. */
export function pageTypeSummary(page: PageRepresentation): Array<{ type: string; count: number; sample: string[] }> {
	const by = new Map<string, PageEntity[]>();
	for (const e of page.entities) (by.get(e.type) ?? by.set(e.type, []).get(e.type)!).push(e);
	return [...by].map(([type, es]) => ({ type, count: es.length, sample: es.slice(0, 3).map((e) => String(first(e, 'name') ?? e.identity.key).slice(0, 80)) })).sort((a, b) => b.count - a.count);
}
