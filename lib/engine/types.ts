/**
 * Signal's source-independent information model (pure types).
 *
 *   Source ─refresh→ Ingestion ─(content changed)→ Observation vN ─link→ Entity
 *   Criteria vK × Entity evidence ─evaluate→ Outcome ─lifecycle→ Finding (+ FindingEvent)
 *
 * Refresh, new information, meaningful change, qualifying finding and action are separate events.
 */

export interface Money { amount: number; currency: string | null }
/** A normalized value. `null` means the source did not provide one (missing), never "no"/"zero". */
export type Value = string | number | boolean | Money | null;

/** One attribute as a source stated it: the normalized value, the original, and how it was transformed. */
export interface ObservedValue {
	value: Value;
	raw: string | null;
	unit?: string | null;
	/** How `raw` became `value`, e.g. `number`, `money(USD)`, `page:json-ld`. */
	transform?: string;
}

export interface Geometry { point?: { lat: number; lng: number }; polygons?: Array<Array<Array<[number, number]>>> /* polygon → rings → [lng,lat] */ }

/** What a record says that can identify it elsewhere. Never used as evidence that two sources agree on anything else. */
export interface IdentityHints {
	/** Identifier scheme → value, e.g. { parcelId: "12-34" }. Only equal schemes are compared. */
	ids: Record<string, string>;
	address: string | null;
	addressKey: string | null;
	lat: number | null;
	lng: number | null;
	name: string | null;
	geometry?: Geometry;
}

/** A record as a source adapter produced it, before Signal stores it. */
export interface ObservationDraft {
	/** The source's own identifier for the record (stable across refreshes when the source has one). */
	recordKey: string;
	/** Whether recordKey comes from the source (an id/key column, a URL) or from position (row number). */
	keyBasis: 'source-key' | 'identifier' | 'position';
	entityType: string;
	attributes: Record<string, ObservedValue>;
	identity: IdentityHints;
	/** When the provider says the data was true (null when it does not say). */
	validAt: string | null;
	/** Where in the source the record was found (row, JSON pointer, page URL + CSS path). */
	locator: string | null;
}

export type ObservationStatus = 'current' | 'superseded' | 'retracted';

export interface StoredObservation extends ObservationDraft {
	observationId: string;
	sourceId: string;
	ingestionId: string;
	version: number;
	/** When Signal received it. */
	observedAt: string;
	contentHash: string;
	status: ObservationStatus;
	/** Last time a refresh confirmed this content unchanged (set by the store; defaults to observedAt). */
	confirmedAt?: string | null;
	retractedAt?: string | null;
	retractReason?: string | null;
}

export type RefreshMode = 'snapshot' | 'poll' | 'push' | 'capture';
export type SourceKind = 'file' | 'http_json' | 'push' | 'page_capture' | 'manual';
export type SourceStatus = 'connected' | 'paused' | 'unavailable' | 'removed';

export interface SourceInfo {
	id: string;
	name: string;
	kind: SourceKind;
	origin: 'native' | 'user';
	status: SourceStatus;
	/** Evidence older than this is stale unless a criterion says otherwise. Declared by the owner. */
	staleAfterDays: number | null;
	synthetic: boolean;
}

export type LinkStatus = 'exact' | 'probable' | 'ambiguous' | 'conflict' | 'unmatched' | 'manual';
export type MatchBasis = 'identifier' | 'address+coordinates' | 'address' | 'containment' | 'coordinates' | 'user' | 'none';

export interface LinkDecision {
	status: LinkStatus;
	/** The entity the record contributes to. Ambiguous/conflicting/unmatched records stand as their own entity, never merged. */
	entityId: string | null;
	basis: MatchBasis;
	confidence: number;
	reason: string;
	/** For ambiguous/conflict: the entities that fit, so a person can decide. */
	options: Array<{ entityId: string; label: string | null; distanceM: number | null; why: string }>;
}

/** Identity keys an entity carries, aggregated from its linked records. */
export interface EntityKeys {
	ids: Record<string, string[]>;
	addressKeys: string[];
	points: Array<{ lat: number; lng: number }>;
	geometries: Geometry[];
	/** Sources already contributing a record: a second record from the same source is a different thing unless ids say otherwise. */
	sources: string[];
}

export interface EntityInfo { entityId: string; type: string; label: string | null; keys: EntityKeys }

/** Everything Signal knows about one entity at evaluation time. */
export interface EvidenceRecord {
	source: SourceInfo;
	link: { status: LinkStatus; basis: MatchBasis; confidence: number };
	current: StoredObservation | null; // null when retracted
	/** Earlier versions, oldest first (for change conditions and history). */
	history: StoredObservation[];
}
export interface EntityEvidence { entity: EntityInfo; records: EvidenceRecord[] }
