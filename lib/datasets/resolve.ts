/**
 * Entity resolution across independent sources, and augmented discovery (pure, deterministic).
 *
 * A listing page and a parcel dataset describe the same property with no shared URL. Resolution walks a
 * fixed hierarchy of evidence and stops at the strongest tier that decides:
 *
 *   1. authoritative id   — the candidate carries a parcel id equal to a record's id
 *   2. address            — normalized street address, corroborated (or contradicted) by coordinates
 *   3. containment        — the candidate's point lies inside exactly one parcel polygon
 *   4. coordinates        — exactly one record within COORD_MATCH_M
 *
 * Two records that fit equally well are AMBIGUOUS: nothing is joined and both are reported. An address
 * match whose coordinates contradict it is a CONFLICT, treated the same way. Resolution never guesses.
 *
 * Matched records enter discovery as ordinary `Enrichment`s — the existing evaluator, with the existing
 * rule that a page's own value outranks an external one. Every enrichment carries its dataset version,
 * mapping version and data-as-of time; the report says which record, on what basis, and where the page
 * and the dataset disagree.
 */
import { discover, type DiscoverInput, type DiscoveryResult, type Enrichment } from '../discovery/discover.ts';
import type { AttributeValue, PageEntity, PageRepresentation } from '../page/types.ts';
import { normalizeAddress, type DatasetRecord, type Geometry } from './dataset.ts';

export const COORD_MATCH_M = 30; // two points this close are the same place
export const ADDRESS_CORROBORATION_M = 250; // listing pins are approximate; farther than this contradicts an address match

export type MatchBasis = 'authoritative-id' | 'address+coordinates' | 'address' | 'containment' | 'coordinates';
export type Confidence = 'high' | 'medium';

export interface DatasetSource {
	id: string; name: string;
	versionId: string; mappingVersion: number;
	/** static: a snapshot that does not change; periodic: refreshed on a schedule; live: queried at use. Never inferred. */
	freshness: 'static' | 'periodic' | 'live';
	/** When the provider says the data was true; null when it does not say. Distinct from retrievedAt. */
	dataAsOf: string | null;
	/** When Signal received it. */
	retrievedAt: string;
	records: DatasetRecord[];
}

export interface Resolution {
	candidateKey: string;
	status: 'matched' | 'ambiguous' | 'conflict' | 'unmatched' | 'no_identity';
	recordId?: string;
	basis?: MatchBasis;
	confidence?: Confidence;
	/** What was weighed, in plain words. */
	reason: string;
	/** For ambiguous/conflict: the records that fit, so a person can decide. */
	options?: Array<{ recordId: string; address: string | null; distanceM: number | null }>;
}

export interface DatasetResolution { dataset: { id: string; versionId: string; mappingVersion: number }; resolutions: Resolution[] }

export interface AugmentedValue {
	candidateKey: string; attribute: string; value: AttributeValue;
	dataset: { id: string; name: string; versionId: string; mappingVersion: number; freshness: DatasetSource['freshness']; dataAsOf: string | null; retrievedAt: string };
	recordId: string; basis: MatchBasis; confidence: Confidence;
	/** The page states a different value for this attribute. The page's value is the one discovery uses. */
	conflict?: { pageValue: AttributeValue };
}

export interface Augmentation {
	enrichments: Enrichment[];
	resolutions: DatasetResolution[];
	values: AugmentedValue[];
}

// ------------------------------------------------------------------ geometry

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
/** Inside the outer ring and outside every hole. */
export function inGeometry(lat: number, lng: number, g: Geometry | undefined): boolean {
	return !!g?.polygons?.some((rings) => rings.length > 0 && inRing(lat, lng, rings[0]) && !rings.slice(1).some((h) => inRing(lat, lng, h)));
}

/** A grid of ~110 m cells so a lookup touches nine buckets, not the dataset. */
const CELL = 0.001;
class Index {
	private cells = new Map<string, DatasetRecord[]>();
	readonly byId = new Map<string, DatasetRecord[]>();
	readonly byAddress = new Map<string, DatasetRecord[]>();
	constructor(records: DatasetRecord[]) {
		for (const r of records) {
			if (r.hasId) (this.byId.get(r.recordId) ?? this.byId.set(r.recordId, []).get(r.recordId)!).push(r);
			if (r.addressKey) (this.byAddress.get(r.addressKey) ?? this.byAddress.set(r.addressKey, []).get(r.addressKey)!).push(r);
			// A polygon is indexed under every cell its bounding box touches, so containment lookups find it.
			for (const k of this.cellsOf(r)) (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(r);
		}
	}
	private cellsOf(r: DatasetRecord): string[] {
		const pts: Array<[number, number]> = r.geometry?.polygons ? r.geometry.polygons.flatMap((p) => p[0].map(([lng, lat]) => [lat, lng] as [number, number])) : r.lat !== null && r.lng !== null ? [[r.lat, r.lng]] : [];
		if (!pts.length) return [];
		const lats = pts.map((p) => p[0]), lngs = pts.map((p) => p[1]);
		const out: string[] = [];
		const [i0, i1, j0, j1] = [Math.floor(Math.min(...lats) / CELL), Math.floor(Math.max(...lats) / CELL), Math.floor(Math.min(...lngs) / CELL), Math.floor(Math.max(...lngs) / CELL)];
		if ((i1 - i0 + 1) * (j1 - j0 + 1) > 10_000) return []; // a county-sized polygon is not a parcel; not indexed
		for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) out.push(`${i}:${j}`);
		return out;
	}
	near(lat: number, lng: number): DatasetRecord[] {
		const i = Math.floor(lat / CELL), j = Math.floor(lng / CELL);
		const seen = new Set<DatasetRecord>();
		for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const r of this.cells.get(`${i + di}:${j + dj}`) ?? []) seen.add(r);
		return [...seen];
	}
}

// ------------------------------------------------------------------ candidate identity

export interface CandidateIdentity { key: string; parcelId: string | null; address: string | null; addressKey: string | null; lat: number | null; lng: number | null; values: Map<string, AttributeValue> }

const attr = (es: PageEntity[], ...names: string[]) => { for (const n of names) for (const e of es) { const a = e.attributes.find((x) => x.name === n && x.value !== null); if (a) return a.value; } return null; };

/** What a page says about a candidate that can be used to find it elsewhere. */
export function identityOf(key: string, entities: PageEntity[]): CandidateIdentity {
	const addr = attr(entities, 'address', 'streetAddress');
	const name = attr(entities, 'name');
	const address = typeof addr === 'string' ? addr : typeof name === 'string' && normalizeAddress(name) ? name : null; // a listing titled "121 Elm St" names its address
	const pid = attr(entities, 'parcelId', 'apn', 'parcelNumber');
	const lat = attr(entities, 'latitude'), lng = attr(entities, 'longitude');
	const values = new Map<string, AttributeValue>();
	for (const e of entities) for (const a of e.attributes) if (a.value !== null && !values.has(a.name)) values.set(a.name, a.value);
	return { key, parcelId: pid === null ? null : String(pid), address, addressKey: normalizeAddress(address), lat: typeof lat === 'number' ? lat : null, lng: typeof lng === 'number' ? lng : null, values };
}

// ------------------------------------------------------------------ resolution

const opt = (rs: DatasetRecord[], c: CandidateIdentity) => rs.slice(0, 5).map((r) => ({ recordId: r.recordId, address: r.address, distanceM: c.lat !== null && c.lng !== null && r.lat !== null && r.lng !== null ? Math.round(distanceM({ lat: c.lat, lng: c.lng }, { lat: r.lat, lng: r.lng })) : null }));

function resolveOne(c: CandidateIdentity, ix: Index): Resolution {
	const base = { candidateKey: c.key };
	const hasPoint = c.lat !== null && c.lng !== null;
	const d = (r: DatasetRecord) => (hasPoint && r.lat !== null && r.lng !== null ? distanceM({ lat: c.lat!, lng: c.lng! }, { lat: r.lat, lng: r.lng }) : null);

	if (c.parcelId) {
		const byId = ix.byId.get(c.parcelId) ?? [];
		if (byId.length === 1) return { ...base, status: 'matched', recordId: byId[0].recordId, basis: 'authoritative-id', confidence: 'high', reason: `parcel id ${c.parcelId} is on the page and in the dataset` };
		if (byId.length > 1) return { ...base, status: 'ambiguous', reason: `parcel id ${c.parcelId} appears in ${byId.length} dataset rows`, options: opt(byId, c) };
	}

	if (c.addressKey) {
		let hits = ix.byAddress.get(c.addressKey) ?? [];
		if (hits.length > 1 && hasPoint) { // several units/rows at one address: coordinates may single one out
			const close = hits.filter((r) => (d(r) ?? Infinity) <= COORD_MATCH_M);
			if (close.length === 1) hits = close;
		}
		if (hits.length === 1) {
			const dist = d(hits[0]);
			const inside = hasPoint && inGeometry(c.lat!, c.lng!, hits[0].geometry);
			if (dist !== null && dist > ADDRESS_CORROBORATION_M && !inside) return { ...base, status: 'conflict', reason: `address "${c.addressKey}" matches record ${hits[0].recordId}, but the coordinates are ${Math.round(dist)} m apart`, options: opt(hits, c) };
			if (dist !== null || inside) return { ...base, status: 'matched', recordId: hits[0].recordId, basis: 'address+coordinates', confidence: 'high', reason: `same address, and the coordinates agree (${inside ? 'inside the parcel' : `${Math.round(dist!)} m apart`})` };
			return { ...base, status: 'matched', recordId: hits[0].recordId, basis: 'address', confidence: 'medium', reason: 'same normalized street address; no coordinates to corroborate it' };
		}
		if (hits.length > 1) return { ...base, status: 'ambiguous', reason: `${hits.length} dataset rows share the address "${c.addressKey}"`, options: opt(hits, c) };
	}

	if (hasPoint) {
		const near = ix.near(c.lat!, c.lng!);
		const containing = near.filter((r) => inGeometry(c.lat!, c.lng!, r.geometry));
		if (containing.length === 1) return { ...base, status: 'matched', recordId: containing[0].recordId, basis: 'containment', confidence: 'medium', reason: 'the listing\'s coordinates lie inside this parcel and no other' };
		if (containing.length > 1) return { ...base, status: 'ambiguous', reason: `the coordinates lie inside ${containing.length} overlapping parcels`, options: opt(containing, c) };
		const close = near.filter((r) => (d(r) ?? Infinity) <= COORD_MATCH_M);
		if (close.length === 1) return { ...base, status: 'matched', recordId: close[0].recordId, basis: 'coordinates', confidence: 'medium', reason: `the only record within ${COORD_MATCH_M} m (${Math.round(d(close[0])!)} m)` };
		if (close.length > 1) return { ...base, status: 'ambiguous', reason: `${close.length} records within ${COORD_MATCH_M} m`, options: opt(close, c) };
	}

	if (!c.parcelId && !c.addressKey && !hasPoint) return { ...base, status: 'no_identity', reason: 'the page gives no parcel id, street address or coordinates to match on' };
	return { ...base, status: 'unmatched', reason: 'no dataset record matches by id, address or location' };
}

export function resolveCandidates(candidates: CandidateIdentity[], dataset: Pick<DatasetSource, 'records'>): Resolution[] {
	const ix = new Index(dataset.records);
	return candidates.map((c) => resolveOne(c, ix));
}

// ------------------------------------------------------------------ augmented discovery

const same = (a: AttributeValue, b: AttributeValue) => JSON.stringify(a) === JSON.stringify(b) || (typeof a === 'object' && a && typeof b === 'object' && b && 'amount' in a && 'amount' in b && a.amount === b.amount);

/** What each candidate on the pages says about itself, before any dataset is consulted. */
export function candidateIdentities(input: { intent: DiscoverInput['intent']; pages: PageRepresentation[]; scope?: DiscoverInput['scope'] }): CandidateIdentity[] {
	const base = discover({ intent: input.intent, pages: input.pages, scope: input.scope }); // candidates only; no enrichment yet
	const entities = new Map(input.pages.flatMap((p) => p.entities.map((e) => [e.id, e] as const)));
	return base.candidates.map((c) => identityOf(c.key, c.entityIds.map((id) => entities.get(id)).filter((e): e is PageEntity => !!e)));
}

/** Resolve every candidate on the pages against each dataset and turn the matches into enrichments. */
export function augment(input: { intent: DiscoverInput['intent']; pages: PageRepresentation[]; datasets: DatasetSource[]; scope?: DiscoverInput['scope'] }): Augmentation {
	const idents = candidateIdentities(input);
	const out: Augmentation = { enrichments: [], resolutions: [], values: [] };
	for (const ds of input.datasets) {
		const resolutions = resolveCandidates(idents, ds);
		out.resolutions.push({ dataset: { id: ds.id, versionId: ds.versionId, mappingVersion: ds.mappingVersion }, resolutions });
		const byId = new Map<string, DatasetRecord>();
		for (const r of ds.records) if (!byId.has(r.recordId)) byId.set(r.recordId, r);
		const meta = { id: ds.id, name: ds.name, versionId: ds.versionId, mappingVersion: ds.mappingVersion, freshness: ds.freshness, dataAsOf: ds.dataAsOf, retrievedAt: ds.retrievedAt };
		const records: Enrichment['records'] = [];
		for (const r of resolutions) {
			if (r.status !== 'matched') continue;
			const rec = byId.get(r.recordId!)!;
			const ident = idents.find((i) => i.key === r.candidateKey)!;
			for (const [attribute, value] of Object.entries(rec.attributes)) {
				const pageValue = ident.values.get(attribute);
				records.push({ url: r.candidateKey, attribute, value });
				out.values.push({ candidateKey: r.candidateKey, attribute, value, dataset: meta, recordId: rec.recordId, basis: r.basis!, confidence: r.confidence!, ...(pageValue !== undefined && !same(pageValue, value) ? { conflict: { pageValue } } : {}) });
			}
		}
		out.enrichments.push({
			source: { id: ds.id, name: ds.name, method: 'external-record', observedAt: ds.dataAsOf ?? ds.retrievedAt, versionId: ds.versionId, mappingVersion: ds.mappingVersion, freshness: ds.freshness, dataAsOf: ds.dataAsOf, retrievedAt: ds.retrievedAt },
			records,
		});
	}
	return out;
}

export interface AugmentedDiscovery { result: DiscoveryResult; augmentation: Augmentation }

/** discover() with the user's datasets. The evaluator is unchanged; only its inputs grew. */
export function discoverAugmented(input: DiscoverInput & { datasets: DatasetSource[]; previousPages?: PageRepresentation[] }): AugmentedDiscovery {
	const augmentation = augment({ intent: input.intent, pages: input.pages, datasets: input.datasets, scope: input.scope });
	const enrichments = [...(input.enrichments ?? []), ...augmentation.enrichments];
	const previous = input.previousPages?.length
		? discover({ intent: input.intent, pages: input.previousPages, scope: input.scope, enrichments: [...(input.enrichments ?? []), ...augment({ intent: input.intent, pages: input.previousPages, datasets: input.datasets, scope: input.scope }).enrichments] })
		: input.previous;
	return { result: discover({ intent: input.intent, pages: input.pages, scope: input.scope, user: input.user, enrichments, previous }), augmentation };
}
