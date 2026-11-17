/**
 * Identity resolution across sources (pure, deterministic), and change planning for ingestion.
 *
 * A record is linked to an existing entity by the strongest evidence that decides, in this order:
 *   1. identifier   — the same identifier scheme and value (parcelId, url, sku…)          → exact
 *   2. address      — the same normalized street address, corroborated by coordinates     → probable
 *                     (coordinates > ADDRESS_CORROBORATION_M apart, or a different identifier → conflict)
 *   3. containment  — the record's point lies inside exactly one entity's polygon          → probable
 *   4. coordinates  — exactly one entity within COORD_MATCH_M                               → probable
 * Two or more equally good candidates are AMBIGUOUS. Ambiguous, conflicting and unmatched records stand as
 * their own entity: nothing is merged on a guess, and a person can link or separate them later.
 */
import type { EntityInfo, EntityKeys, Geometry, IdentityHints, LinkDecision, ObservationDraft } from './types.ts';

export const COORD_MATCH_M = 30;
export const ADDRESS_CORROBORATION_M = 250;

const R = 6_371_008.8;
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
	const rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function inRing(lat: number, lng: number, ring: Array<[number, number]>): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi, yi] = ring[i], [xj, yj] = ring[j];
		if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}
export function inGeometry(lat: number, lng: number, g: Geometry | undefined): boolean {
	return !!g?.polygons?.some((rings) => rings.length > 0 && inRing(lat, lng, rings[0]) && !rings.slice(1).some((h) => inRing(lat, lng, h)));
}

export function emptyKeys(): EntityKeys { return { ids: {}, addressKeys: [], points: [], geometries: [], sources: [] }; }

/** Add one record's identity hints to an entity's keys. */
export function addKeys(k: EntityKeys, h: IdentityHints, sourceId: string): EntityKeys {
	const out: EntityKeys = { ids: { ...k.ids }, addressKeys: [...k.addressKeys], points: [...k.points], geometries: [...k.geometries], sources: [...k.sources] };
	for (const [s, v] of Object.entries(h.ids)) if (!(out.ids[s] ?? []).includes(v)) out.ids[s] = [...(out.ids[s] ?? []), v];
	if (h.addressKey && !out.addressKeys.includes(h.addressKey)) out.addressKeys.push(h.addressKey);
	if (h.lat !== null && h.lng !== null && !out.points.some((p) => p.lat === h.lat && p.lng === h.lng)) out.points.push({ lat: h.lat, lng: h.lng });
	if (h.geometry?.polygons) out.geometries.push(h.geometry);
	if (!out.sources.includes(sourceId)) out.sources.push(sourceId);
	return out;
}
export function keysFrom(records: Array<{ identity: IdentityHints; sourceId: string }>): EntityKeys {
	return records.reduce((k, r) => addKeys(k, r.identity, r.sourceId), emptyKeys());
}

/** An index over a set of entities so each resolution touches candidates, not everything. */
export class EntityIndex {
	private byId = new Map<string, EntityInfo[]>();
	private byAddress = new Map<string, EntityInfo[]>();
	private cells = new Map<string, EntityInfo[]>();
	private static CELL = 0.001; // ~110 m
	readonly entities: EntityInfo[];
	constructor(entities: EntityInfo[]) { this.entities = entities; for (const e of entities) this.add(e); }
	private push<T>(m: Map<string, T[]>, k: string, v: T) { const l = m.get(k); if (l) { if (!l.includes(v)) l.push(v); } else m.set(k, [v]); }
	add(e: EntityInfo) {
		for (const [s, vs] of Object.entries(e.keys.ids)) for (const v of vs) this.push(this.byId, `${s}\u0000${v}`, e);
		for (const a of e.keys.addressKeys) this.push(this.byAddress, a, e);
		for (const p of e.keys.points) this.push(this.cells, this.cell(p.lat, p.lng), e);
		for (const g of e.keys.geometries) for (const ring of g.polygons ?? []) for (const [lng, lat] of ring[0] ?? []) this.push(this.cells, this.cell(lat, lng), e);
	}
	remove(entityId: string) {
		for (const m of [this.byId, this.byAddress, this.cells]) for (const [k, l] of m) { const f = l.filter((e) => e.entityId !== entityId); if (f.length) m.set(k, f); else m.delete(k); }
	}
	private cell(lat: number, lng: number) { return `${Math.floor(lat / EntityIndex.CELL)}:${Math.floor(lng / EntityIndex.CELL)}`; }
	withId(scheme: string, value: string) { return this.byId.get(`${scheme}\u0000${value}`) ?? []; }
	withAddress(a: string) { return this.byAddress.get(a) ?? []; }
	near(lat: number, lng: number) {
		const i = Math.floor(lat / EntityIndex.CELL), j = Math.floor(lng / EntityIndex.CELL);
		const out = new Set<EntityInfo>();
		for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const e of this.cells.get(`${i + di}:${j + dj}`) ?? []) out.add(e);
		return [...out];
	}
}

const nearest = (e: EntityInfo, lat: number, lng: number) => e.keys.points.length ? Math.min(...e.keys.points.map((p) => distanceM({ lat, lng }, p))) : null;

/**
 * Decide which entity a record belongs to. `excludeEntityId` is the record's own current entity when it is
 * being re-resolved. Records from a source never merge with another record of the same source (a source's
 * own key already says they are different), except that a shared identifier is reported as ambiguous.
 */
export function resolveIdentity(d: Pick<ObservationDraft, 'identity'>, sourceId: string, ix: EntityIndex, excludeEntityId?: string): LinkDecision {
	const h = d.identity;
	const hasPoint = h.lat !== null && h.lng !== null;
	const ok = (e: EntityInfo) => e.entityId !== excludeEntityId;
	const otherSource = (e: EntityInfo) => ok(e) && !e.keys.sources.every((s) => s === sourceId);
	const opt = (e: EntityInfo, why: string) => ({ entityId: e.entityId, label: e.label, distanceM: hasPoint ? (nearest(e, h.lat!, h.lng!) === null ? null : Math.round(nearest(e, h.lat!, h.lng!)!)) : null, why });
	const none: LinkDecision = { status: 'unmatched', entityId: null, basis: 'none', confidence: 1, reason: '', options: [] };

	// 1. identifiers
	for (const [scheme, value] of Object.entries(h.ids)) {
		const hits = ix.withId(scheme, value).filter(ok);
		const cross = hits.filter(otherSource);
		if (cross.length === 1 && hits.length === 1) return { status: 'exact', entityId: cross[0].entityId, basis: 'identifier', confidence: 1, reason: `${scheme} ${value} is stated by both sources`, options: [] };
		if (hits.length >= 1) return { ...none, status: 'ambiguous', reason: `${scheme} ${value} is shared by ${hits.length} other record${hits.length > 1 ? 's' : ''}${cross.length < hits.length ? ' (including this source)' : ''}`, options: hits.slice(0, 5).map((e) => opt(e, `same ${scheme}`)) };
	}
	const idClash = (e: EntityInfo) => Object.entries(h.ids).find(([s, v]) => (e.keys.ids[s] ?? []).length > 0 && !(e.keys.ids[s] ?? []).includes(v));

	// 2. address
	if (h.addressKey) {
		let hits = ix.withAddress(h.addressKey).filter(otherSource);
		if (hits.length > 1 && hasPoint) { const close = hits.filter((e) => (nearest(e, h.lat!, h.lng!) ?? Infinity) <= COORD_MATCH_M); if (close.length === 1) hits = close; }
		if (hits.length === 1) {
			const e = hits[0];
			if (e.keys.sources.includes(sourceId)) return { ...none, status: 'ambiguous', reason: `same address as ${e.label ?? 'an entity'} that this source already describes with another record`, options: [opt(e, 'same address; already has a record from this source')] };
			const clash = idClash(e);
			if (clash) return { ...none, status: 'conflict', reason: `same address "${h.addressKey}", but ${clash[0]} differs (${clash[1]} vs ${e.keys.ids[clash[0]].join(', ')})`, options: [opt(e, 'same address, different identifier')] };
			const dist = hasPoint ? nearest(e, h.lat!, h.lng!) : null;
			const inside = hasPoint && e.keys.geometries.some((g) => inGeometry(h.lat!, h.lng!, g));
			if (dist !== null && dist > ADDRESS_CORROBORATION_M && !inside) return { ...none, status: 'conflict', reason: `same address "${h.addressKey}", but the coordinates are ${Math.round(dist)} m apart`, options: [opt(e, 'same address, distant coordinates')] };
			if (dist !== null || inside) return { status: 'probable', entityId: e.entityId, basis: 'address+coordinates', confidence: 0.9, reason: `same street address, and the locations agree (${inside ? 'inside the parcel' : `${Math.round(dist!)} m apart`})`, options: [] };
			return { status: 'probable', entityId: e.entityId, basis: 'address', confidence: 0.75, reason: 'same normalized street address; no location to corroborate it', options: [] };
		}
		if (hits.length > 1) return { ...none, status: 'ambiguous', reason: `${hits.length} entities share the address "${h.addressKey}"`, options: hits.slice(0, 5).map((e) => opt(e, 'same address')) };
	}

	// 3–4. location
	if (hasPoint) {
		const near = ix.near(h.lat!, h.lng!).filter(otherSource);
		const containing = near.filter((e) => e.keys.geometries.some((g) => inGeometry(h.lat!, h.lng!, g)));
		const pick = (e: EntityInfo, basis: 'containment' | 'coordinates', reason: string): LinkDecision => {
			if (e.keys.sources.includes(sourceId)) return { ...none, status: 'ambiguous', reason: `${reason}, which this source already describes with another record`, options: [opt(e, reason)] };
			const clash = idClash(e);
			return clash ? { ...none, status: 'conflict', reason: `${reason}, but ${clash[0]} differs`, options: [opt(e, reason)] } : { status: 'probable', entityId: e.entityId, basis, confidence: 0.7, reason, options: [] };
		};
		if (containing.length === 1) return pick(containing[0], 'containment', 'the location lies inside this parcel and no other');
		if (containing.length > 1) return { ...none, status: 'ambiguous', reason: `the location lies inside ${containing.length} overlapping parcels`, options: containing.slice(0, 5).map((e) => opt(e, 'contains the location')) };
		const close = near.filter((e) => (nearest(e, h.lat!, h.lng!) ?? Infinity) <= COORD_MATCH_M);
		if (close.length === 1) return pick(close[0], 'coordinates', `the only entity within ${COORD_MATCH_M} m`);
		if (close.length > 1) return { ...none, status: 'ambiguous', reason: `${close.length} entities within ${COORD_MATCH_M} m`, options: close.slice(0, 5).map((e) => opt(e, `within ${COORD_MATCH_M} m`)) };
	}

	const hasAny = Object.keys(h.ids).length > 0 || !!h.addressKey || hasPoint;
	return { ...none, reason: hasAny ? 'no other source describes this by identifier, address or location' : 'the record has no identifier, address or location to match on' };
}

// ------------------------------------------------------------------ ingestion planning

export interface CurrentRef { recordKey: string; contentHash: string; version: number }
export interface IngestionPlan<D> {
	added: D[];
	changed: Array<{ draft: D; previous: CurrentRef }>;
	unchanged: number;
	unchangedKeys: string[];
	retracted: CurrentRef[];
}

/**
 * Compare a refresh with what is current. `snapshot`: the refresh is the whole source, so a current record
 * that is missing was removed. `partial`: only what was sent is known; absent records are left alone unless
 * named in `removed`.
 */
export function planIngestion<D extends { recordKey: string }>(current: CurrentRef[], drafts: Array<{ draft: D; hash: string }>, mode: 'snapshot' | 'partial', removed: string[] = []): IngestionPlan<D> {
	const byKey = new Map(current.map((c) => [c.recordKey, c]));
	const plan: IngestionPlan<D> = { added: [], changed: [], unchanged: 0, unchangedKeys: [], retracted: [] };
	const seen = new Set<string>();
	for (const { draft, hash } of drafts) {
		seen.add(draft.recordKey);
		const prev = byKey.get(draft.recordKey);
		if (!prev) plan.added.push(draft);
		else if (prev.contentHash !== hash) plan.changed.push({ draft, previous: prev });
		else { plan.unchanged++; plan.unchangedKeys.push(draft.recordKey); }
	}
	if (mode === 'snapshot') for (const c of current) if (!seen.has(c.recordKey)) plan.retracted.push(c);
	for (const k of removed) { const c = byKey.get(k); if (c && !seen.has(k) && !plan.retracted.includes(c)) plan.retracted.push(c); }
	return plan;
}
