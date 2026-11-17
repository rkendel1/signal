/**
 * Signal capability contracts — version 1.
 *
 * These types are the contract boundary. They are deliberately plain data
 * (JSON-serialisable) so the capability can be consumed from any language; the
 * JSON Schemas in /schemas mirror them. Every durable record carries a
 * `schema` discriminator of the form `signal.<record>/v1`.
 *
 * Separation of facts (each is its own record, never merged):
 *   Observation  — we looked at a source and preserved what we saw
 *   Interpretation — what we extracted / detected from that observation
 *   Evaluation   — whether criteria matched, with a full trace
 *   MatchedEvent — a durable, deduplicated "this matters" fact
 *   DeliveryAttempt — one try to notify one destination (attempted/delivered/failed)
 *   Acknowledgement — a person or app acknowledged an event
 */

import type { EntityCondition } from '../page/query.ts';
import type { PageRepresentation } from '../page/types.ts';
import type { DiscoveryIntent } from '../discovery/discover.ts';

export type Iso8601 = string;

export interface Principal {
	tenantId: string;
	subjectId: string;
	/** Granted actions, e.g. `signal.monitor.write`. Resolved by the host's authority (AuthBoundry). */
	permissions: string[];
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export type SourceType = 'http_page' | 'text' | 'json' | 'dom';

export interface SourceDefinition {
	schema: 'signal.source/v1';
	id: string;
	tenantId: string;
	ownerId: string;
	type: SourceType;
	/** For http_page/json: absolute http(s) URL. For text/dom: a stable logical name. */
	locator: string;
	access: {
		/** `public`: no credentials. `credential_ref`: the host injects a credential; Signal never stores secrets. */
		authorization: 'public' | 'credential_ref';
		credentialRef?: string;
		/** Respect robots.txt for automated polling (default true). */
		respectRobots?: boolean;
	};
	observation: {
		strategy: 'manual' | 'poll' | 'event';
		/** Requested poll interval; clamped to `minIntervalSeconds`. */
		intervalSeconds?: number;
	};
	createdAt: Iso8601;
}

export interface ObservationRequest {
	source: SourceDefinition;
	/** Inline content for `text`/`json`/`dom` sources (pushed by the caller, e.g. a browser overlay). */
	content?: string;
	previous?: { etag?: string; lastModified?: string; contentHash?: string };
	requestedAt: Iso8601;
}

export interface Provenance {
	adapter: string; // e.g. `http-page@1`
	method: string; // e.g. `GET`
	requestedUrl?: string;
	finalUrl?: string;
	httpStatus?: number;
	headers?: Record<string, string>; // allow-listed response headers only
	redirects?: string[];
	robots?: 'allowed' | 'disallowed' | 'unavailable' | 'not_checked';
	submittedBy?: string; // for pushed content
	/** false when the observed bytes were not kept (page intelligence keeps the structure, its evidence and the content hash). */
	bodyRetained?: boolean;
}

export interface Observation {
	schema: 'signal.observation/v1';
	observationId: string;
	tenantId: string;
	sourceId: string;
	observedAt: Iso8601;
	status: 'ok' | 'not_modified' | 'denied' | 'error';
	/** Content-addressed reference to the exact bytes observed (`sha256:<hex>`). Present when status=ok. */
	evidenceRef?: string;
	contentHash?: string;
	contentType?: string;
	byteLength?: number;
	revision?: string;
	provenance: Provenance;
	error?: { code: string; message: string };
}

/** What an adapter returns; the runtime persists `body` as evidence and records the Observation. */
export interface ObservationResult {
	observation: Observation;
	body?: Uint8Array;
}

export interface ObservationSource {
	readonly type: SourceType;
	readonly adapter: string;
	observe(request: ObservationRequest): Promise<ObservationResult>;
}

// ---------------------------------------------------------------------------
// Interpretation (extraction + signal detection)
// ---------------------------------------------------------------------------

export interface ExtractionRule {
	/** Output field name, e.g. `price`. */
	field: string;
	from: 'text' | 'json';
	/** For `text`: ECMAScript regex; capture group 1 (or the whole match) is the value. */
	pattern?: string;
	flags?: string;
	/** For `json`: RFC 6901 JSON Pointer. */
	pointer?: string;
	type: 'string' | 'number' | 'boolean';
}

export interface ExtractedField {
	field: string;
	value: string | number | boolean | null;
	/** Exact substring of normalized text (or JSON excerpt) the value came from. */
	excerpt?: string;
	/** Char offsets into the normalized text (text rules only). */
	span?: [number, number];
}

export interface DetectedSignal {
	/** Decoder that produced this signal, e.g. `ghostpost-unicode/v1`, `invisible-unicode/v1`. */
	codec: string;
	kind: string; // e.g. `text`, `reference`, `invisible_cluster`
	ok: boolean;
	payload?: Record<string, unknown>;
	error?: string;
	span?: [number, number];
	warnings?: string[];
	/** Deterministic decoders use 1. Probabilistic interpretation must set < 1. */
	confidence: number;
}

export interface SignalInput {
	text: string;
	contentType?: string;
}

export interface SignalDecoder {
	readonly codec: string;
	detect(input: SignalInput): DetectedSignal[];
}

export interface Interpretation {
	schema: 'signal.interpretation/v1';
	interpretationId: string;
	tenantId: string;
	observationId: string;
	sourceId: string;
	interpretedAt: Iso8601;
	/** sha256 of the normalized text the rules ran against. */
	normalizedTextHash: string;
	normalizedTextRef: string;
	extractionVersion: string; // sha of the rules used
	fields: ExtractedField[];
	signals: DetectedSignal[];
	/** The universal page representation built from this observation (HTML content only). */
	page?: { ref: string; revision: string; entities: number; schema: string };
}

// ---------------------------------------------------------------------------
// Criteria
// ---------------------------------------------------------------------------

export type FieldOp =
	| 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte'
	| 'contains' | 'not_contains' | 'matches' | 'in'
	| 'exists' | 'absent'
	| 'changed' | 'unchanged' | 'increased' | 'decreased';

export type Condition =
	| { all: Condition[] }
	| { any: Condition[] }
	| { not: Condition }
	| { field: string; op: FieldOp; value?: unknown; caseSensitive?: boolean }
	| { text: { contains?: string; matches?: string; flags?: string; fuzzy?: { term: string; maxDistance: number } } }
	| { signal: { codec?: string; kind?: string; payloadContains?: string } }
	| { content: 'changed' | 'unchanged' }
	/** Evaluated against the observation's signal.page/v1 representation (lib/page/query.ts). */
	| { entity: EntityCondition }
	/** A discovery intent over the page (lib/discovery): true when at least one candidate is a definite match.
	 *  "possible" (missing information) never matches; the matched values are the matching candidates. */
	| { discover: DiscoveryIntent };

export interface CriteriaDefinition {
	schema: 'signal.criteria/v1';
	id: string;
	/** Monotonic; every edit produces a new version. Events record the version that matched. */
	version: number;
	name: string;
	extract?: ExtractionRule[];
	condition: Condition;
	severity: 'info' | 'warning' | 'critical';
	/** `on_change` (default): alert when the matched values change. `on_enter`: only on false→true. */
	notify?: 'on_change' | 'on_enter';
	window?: { notBefore?: Iso8601; notAfter?: Iso8601 };
	/** Minimum seconds between events for this monitor (frequency limit). */
	minIntervalSeconds?: number;
	metadata?: Record<string, string>;
}

export interface ConditionTrace {
	path: string; // e.g. `all[0].field(price)`
	result: boolean;
	op?: string;
	expected?: unknown;
	actual?: unknown;
	previous?: unknown;
	note?: string;
}

export interface EvaluationResult {
	matched: boolean;
	trace: ConditionTrace[];
	/** Values of the leaves that made the match true; basis of the dedup identity. */
	matchedValues: Record<string, unknown>;
}

export interface CriteriaEvaluator {
	evaluate(
		current: Interpretation,
		previous: Interpretation | undefined,
		criteria: CriteriaDefinition,
		ctx: { now: Iso8601; normalizedText: string; contentChanged: boolean | undefined; page?: PageRepresentation; previousPage?: PageRepresentation }
	): EvaluationResult;
}

export interface Evaluation {
	schema: 'signal.evaluation/v1';
	evaluationId: string;
	tenantId: string;
	monitorId: string;
	observationId: string;
	interpretationId: string;
	previousInterpretationId?: string;
	criteriaId: string;
	criteriaVersion: number;
	evaluatedAt: Iso8601;
	matched: boolean;
	trace: ConditionTrace[];
	/** Why a match did or did not become an event. */
	outcome: 'no_match' | 'event_recorded' | 'suppressed_duplicate' | 'suppressed_not_entered' | 'suppressed_window' | 'suppressed_rate_limit';
	dedupKey?: string;
	eventId?: string;
}

// ---------------------------------------------------------------------------
// Monitors, events, delivery
// ---------------------------------------------------------------------------

export interface AlertDestination {
	id: string;
	type: 'webhook' | 'inbox' | 'appport_notification';
	/** webhook: https URL; inbox: owner subject id; appport_notification: recipient handle. */
	target: string;
	/** Reference to a host-managed signing secret (webhook). Never the secret itself. */
	secretRef?: string;
	minSeverity?: 'info' | 'warning' | 'critical';
	quietHours?: { startHour: number; endHour: number; timeZoneOffsetMinutes: number };
}

export interface MonitorDefinition {
	schema: 'signal.monitor/v1';
	id: string;
	tenantId: string;
	ownerId: string;
	sourceId: string;
	criteriaId: string;
	criteriaVersion: number;
	destinations: AlertDestination[];
	enabled: boolean;
	createdAt: Iso8601;
}

export interface MatchedEvent {
	schema: 'signal.event/v1';
	eventId: string;
	tenantId: string;
	ownerId: string;
	monitorId: string;
	sourceId: string;
	sourceLocator: string;
	observationId: string;
	interpretationId: string;
	evaluationId: string;
	criteriaId: string;
	criteriaVersion: number;
	criteriaName: string;
	severity: CriteriaDefinition['severity'];
	occurredAt: Iso8601;
	/** The leaves that matched, with current and previous values. */
	matched: ConditionTrace[];
	/** Relevant extracted content (never a replacement for evidence). */
	excerpts: Array<{ field?: string; text: string }>;
	evidence: { /** absent for captured (dom) pages: the structure is kept, not the page */ observationRef?: string; normalizedTextRef: string; contentHash: string; pageRef?: string; pageRevision?: string };
	provenance: Provenance;
	/** Deterministic interpretation ⇒ 1. */
	confidence: number;
	dedupKey: string;
}

export interface DeliveryResult {
	status: 'delivered' | 'failed' | 'suppressed';
	retryable: boolean;
	detail?: string;
	responseStatus?: number;
}

export interface DeliveryAttempt {
	schema: 'signal.delivery/v1';
	attemptId: string;
	tenantId: string;
	eventId: string;
	destinationId: string;
	attempt: number;
	attemptedAt: Iso8601;
	status: DeliveryResult['status'];
	retryable: boolean;
	detail?: string;
	responseStatus?: number;
	/** Idempotency key sent to the destination: same event+destination ⇒ same key on every retry. */
	idempotencyKey: string;
}

export interface Acknowledgement {
	schema: 'signal.ack/v1';
	ackId: string;
	tenantId: string;
	eventId: string;
	subjectId: string;
	acknowledgedAt: Iso8601;
}

export interface AlertDispatcher {
	readonly type: AlertDestination['type'];
	dispatch(event: MatchedEvent, destination: AlertDestination, ctx: { idempotencyKey: string; attempt: number }): Promise<DeliveryResult>;
}
