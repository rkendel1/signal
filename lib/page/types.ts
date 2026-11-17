/**
 * signal.page/v1 — the universal, evidence-backed representation of what an observed page contains.
 *
 * What exists on a page (this file) is kept separate from what matters to someone
 * (criteria) and what should happen (events, notifications). The representation is
 * deterministic: the same bytes, URL and extractor version always produce the same
 * document, byte for byte (`revision` is its hash).
 *
 * Provenance vocabulary (never conflated):
 *  - Entity `classification`
 *      declared  — the page's structured data states the type (JSON-LD, microdata, RDFa).
 *      semantic  — HTML/ARIA semantics imply it (<article>, <table>, role="row", <time>).
 *      inferred  — a documented deterministic rule inferred it from structure/values.
 *      unknown   — structure retained, type not determined.
 *  - Attribute `provenance`
 *      observed   — the value as it appears in the page (text, attribute, structured data scalar).
 *      normalized — a deterministic parse of an observed value (money, date, availability, URL).
 *      inferred   — derived by a rule beyond parsing (relative dates, label-based roles).
 *  - `confidence` is a rule tier, not a calibrated probability:
 *      1.0 declared/observed · 0.9 semantic · 0.6 structural inference · 0.3 weak/ambiguous.
 */

export const PAGE_SCHEMA = 'signal.page/v1' as const;
export const EXTRACTOR_VERSION = 'page-extractor/1.1.0';

export type Classification = 'declared' | 'semantic' | 'inferred' | 'unknown';
export type ValueProvenance = 'observed' | 'normalized' | 'inferred';
export type ExtractionMethod =
	| 'json-ld' | 'microdata' | 'rdfa' | 'meta' | 'opengraph'
	| 'html' | 'aria' | 'table' | 'list' | 'structure' | 'label' | 'text' | 'identity' | 'decoder';

export type DataType =
	| 'text' | 'number' | 'percent' | 'money' | 'money_range' | 'datetime' | 'date' | 'duration'
	| 'url' | 'email' | 'availability' | 'rating' | 'boolean' | 'image' | 'unknown';

export interface Money { amount: number; currency: string | null }
export interface MoneyRange { min: number; max: number; currency: string | null; period?: string }
export interface Rating { value: number; best: number }
export interface ImageRef { url: string | null; alt: string | null }

export type AttributeValue = string | number | boolean | Money | MoneyRange | Rating | ImageRef | null;

export interface PageAttribute {
	name: string; // schema.org property name where one applies, else a slug of the page's label
	value: AttributeValue; // normalized value; null when absent, unparseable or ambiguous
	raw: string | null; // the original string as observed (truncated to 1,000 chars)
	dataType: DataType;
	provenance: ValueProvenance;
	method: ExtractionMethod;
	confidence: number;
	evidenceRefs: string[];
	/** Present when the value could not be determined uniquely. `value` is then null. */
	ambiguity?: { reason: 'conflict' | 'format' | 'relative' | 'truncated'; candidates: Array<{ value: AttributeValue; source: string }> };
}

export interface PageEntity {
	id: string; // ent_<hash(type, identity key)>; stable across observations when the identity key is
	type: string; // open vocabulary: schema.org type names where known, else 'Unknown'
	classification: Classification;
	typeBasis: { method: ExtractionMethod; rule: string }; // why this type
	identity: {
		key: string;
		basis: '@id' | 'url' | 'sku' | 'name' | 'locator' | 'page';
		/** strong: a source identifier (@id, url, sku) — repeated occurrences are the same entity.
		 *  weak: a visible name — may collide. positional: a DOM path — moves when the layout moves. */
		strength: 'strong' | 'weak' | 'positional';
		/** Set when another entity on this page has the same type and weak key: continuity cannot be established. */
		ambiguous?: true;
		/** How many places on the page show this entity (strong identities merge occurrences). */
		occurrences: number;
	};
	/** sha256 of the entity's facts (type + attribute names/values/raw), excluding evidence and layout. */
	digest: string;
	attributes: PageAttribute[];
	evidenceRefs: string[];
}

export interface PageRelationship {
	id: string;
	from: string; // entity id
	to: string; // entity id
	type: string; // e.g. offers, seller, author, hiringOrganization, inReplyTo, hasPart, sameAs
	method: ExtractionMethod;
	classification: Classification;
	confidence: number;
	evidenceRefs: string[];
	/** For sameAs: attributes whose values disagree between the two descriptions. */
	conflicts?: Array<{ attribute: string; values: Array<{ entity: string; value: AttributeValue }> }>;
}

export interface PageCollection {
	id: string;
	kind: 'list' | 'table' | 'repeated' | 'itemlist' | 'thread';
	name: string | null;
	itemType: string | null; // the common entity type, if all members share one
	members: string[]; // entity ids, in page order
	signature?: string; // structural signature for repeated structures
	method: ExtractionMethod;
	evidenceRefs: string[];
}

export interface PageSignal {
	id: string;
	codec: string; // e.g. ghostpost-unicode/v1, invisible-unicode/v1, page-access/v1
	kind: string;
	ok: boolean;
	payload?: Record<string, unknown>;
	error?: string;
	confidence: number;
	evidenceRefs: string[];
	warnings?: string[];
}

export interface PageEvidence {
	id: string; // ev_<hash(locator, method, detail)>
	locator: string; // deterministic CSS path, e.g. "html>body>main>ul:nth-of-type(1)>li:nth-of-type(2)>span.price"
	element: string; // tag name
	attributes: Record<string, string>; // allow-listed, secrets removed
	text: string | null; // the element's own text as observed (truncated)
	method: ExtractionMethod;
	pointer?: string; // JSON pointer inside structured data, for json-ld evidence
}

export interface PageSource {
	locator: string; // the monitored URL or logical locator
	baseUrl: string | null; // URL used to resolve relative links (never fetched)
	observationId: string;
	contentHash: string;
	contentType: string | null;
}

export interface PageRepresentation {
	schema: typeof PAGE_SCHEMA;
	extractorVersion: string;
	source: PageSource;
	observedAt: string;
	/** sha256 of the representation's content, excluding observation identity and time. */
	revision: string;
	/** sha256 of the page's facts only (entity ids + digests + relationship triples): unchanged when only layout changes. */
	factsRevision: string;
	language: string | null;
	title: string | null;
	entities: PageEntity[];
	relationships: PageRelationship[];
	collections: PageCollection[];
	signals: PageSignal[];
	evidence: PageEvidence[];
	stats: {
		elements: number;
		elementsVisited: number;
		truncated: boolean;
		limits: PageLimits;
		byClassification: Record<Classification, number>;
	};
}

export interface PageLimits {
	maxElements: number;
	maxEntities: number;
	maxAttributesPerEntity: number;
	maxTextLength: number;
	maxJsonLdBytes: number;
	maxJsonLdNodes: number;
}

export const DEFAULT_PAGE_LIMITS: PageLimits = {
	maxElements: 25_000,
	maxEntities: 2_000,
	maxAttributesPerEntity: 64,
	maxTextLength: 1_000,
	maxJsonLdBytes: 512_000,
	maxJsonLdNodes: 2_000
};

/** A deterministic interpreter that finds embedded signals in a block of visible text. Optional; none ship by default. */
export interface DetectedSignal {
	codec: string;
	kind: string;
	ok: boolean;
	payload?: Record<string, unknown>;
	error?: string;
	span?: [number, number];
	warnings?: string[];
	confidence: number;
}
export interface SignalDecoder {
	readonly codec: string;
	detect(input: { text: string; contentType?: string }): DetectedSignal[];
}
