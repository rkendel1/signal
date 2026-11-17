/**
 * Site intelligence types.
 *
 *   SiteEvidence      what the user's own browser observed on a page (collected only when the user asks).
 *                     PRIVATE: may contain the user's data. Stays in the user's analysis record.
 *   Candidate         one possible information source on the site, with private samples.
 *   FeedDefinition    the SHAREABLE description of a candidate: structure, semantics, access requirements.
 *                     Never values, never session material, never the user's parameters.
 */

export interface EvidenceResponse {
	url: string;
	status: number;
	contentType: string | null;
	etag: string | null;
	lastModified: string | null;
	cacheControl: string | null;
	/** Parsed JSON, arrays trimmed to the first 50 items (original lengths in `truncated`). */
	json: unknown;
	/** A non-JSON prefix stripped before parsing (e.g. `{}&&`), if any. */
	prefix: string | null;
	truncated: Record<string, number>;
	/** The same GET without cookies: does the response depend on the user's session? */
	anonymous: { status: number; records: number | null } | null;
	/** Records counted in the credentialed response's main array (for the anonymous comparison). */
	records: number | null;
	/** Why it was not fetched (disallowed by robots, not GET-able, too large, cross-origin without CORS…). */
	skipped?: string;
}

export interface SiteEvidence {
	url: string;
	title: string;
	collectedAt: string;
	collector: string;
	robots: { status: number; text: string | null } | null;
	jsonLd: unknown[];
	embedded: Array<{ kind: 'next_data' | 'nuxt' | 'json_script' | 'global'; name: string; json: unknown; truncated: Record<string, number> }>;
	/** Resource Timing entries for fetch/XHR/beacon/other requests the page made (URLs and sizes; no bodies). */
	resources: Array<{ url: string; initiator: string; status: number; bytes: number; durationMs: number }>;
	/** GET requests the page made, re-issued once from the page context for analysis. */
	responses: EvidenceResponse[];
	downloads: Array<{ url: string; type: string }>;
	/** Structural snapshot of the rendered page (scripts and styles removed), for surface analysis. */
	snapshot: string | null;
	/** What the collector could and could not observe. */
	observed: { webSocket: 'not_observable'; eventSource: 'not_observable'; graphql: string[]; serviceWorker: boolean };
}

export type CandidateKind = 'json_endpoint' | 'geojson_endpoint' | 'embedded_state' | 'json_ld' | 'download' | 'dom';
export type FieldType = 'string' | 'number' | 'boolean' | 'url' | 'datetime' | 'object' | 'array' | 'null';
export type FieldRole = 'id' | 'url' | 'detail_link' | 'updated' | 'time' | 'latitude' | 'longitude' | 'geometry' | 'address' | 'name' | 'price' | 'status';

export interface FieldInfo {
	path: string;
	type: FieldType;
	/** Share of records that have a non-null value. */
	presence: number;
	/** Share of distinct values among records that have one. */
	distinct: number;
	role?: FieldRole;
	suggestedAttribute?: string;
	/** PRIVATE: up to three example values. Never leaves the analysis. */
	samples?: string[];
}

export interface ParamInfo { name: string; role: 'page' | 'offset' | 'cursor' | 'size' | 'bbox' | 'query' | 'sort' | 'format' | 'filter' | 'credential' | 'tracking'; sensitive: boolean; value?: string /* PRIVATE */ }

export interface Candidate {
	key: string;
	kind: CandidateKind;
	label: string;
	endpoint: { origin: string; pathTemplate: string; params: ParamInfo[]; url?: string /* PRIVATE */ } | null;
	embedded: { kind: string; name: string } | null;
	recordsPath: string | null;
	format: 'json' | 'geojson' | null;
	responsePrefix: string | null;
	recordCount: number;
	declaredTotal: number | null;
	entityHint: string | null;
	fields: FieldInfo[];
	identifier: { path: string; basis: string } | null;
	relations: Array<{ field: string; kind: 'detail_link' | 'page_link'; targetTemplate: string }>;
	pagination: { kind: 'page' | 'offset' | 'cursor' | 'none' | 'unknown'; params: string[]; responseFields: string[] };
	filters: Array<{ param: string; kind: ParamInfo['role'] }>;
	change: { conditional: 'etag' | 'last-modified' | null; maxAgeSeconds: number | null; recordUpdatedField: string | null; live: 'sse' | null };
	access: { auth: 'public' | 'session' | 'unknown'; robots: 'allowed' | 'disallowed' | 'unknown'; automatable: boolean; sameOrigin: boolean };
	completeness: 'complete' | 'partial' | 'unknown';
	verdict: 'feed' | 'detail' | 'metadata' | 'not_records' | 'surface' | 'disallowed';
	why: string[];
	limitations: string[];
	score: number;
	breakdown: Array<{ factor: string; value: number; weight: number; why: string }>;
	duplicates: string[];
	/** PRIVATE: identifier values seen (for duplicate detection across candidates). */
	idSample?: string[];
}

export interface SiteAnalysis {
	site: { domain: string; origin: string };
	page: { url: string; pathTemplate: string; title: string };
	candidates: Candidate[];
	surface: { types: Array<{ type: string; count: number }>; entities: number; jsonLdTypes: string[] };
	observed: SiteEvidence['observed'];
	analyzerVersion: string;
	durationMs: number;
}

/** The shareable definition of one feed (signal.site-feed/v1). */
export interface FeedDefinition {
	schema: 'signal.site-feed/v1';
	site: string;
	kind: CandidateKind;
	label: string;
	endpoint: { origin: string; pathTemplate: string; params: Array<Omit<ParamInfo, 'value'>> } | null;
	embedded: { kind: string; name: string } | null;
	recordsPath: string | null;
	format: 'json' | 'geojson' | null;
	responsePrefix: string | null;
	entityHint: string | null;
	fields: Array<Omit<FieldInfo, 'samples'>>;
	identifier: { path: string; basis: string } | null;
	relations: Candidate['relations'];
	pagination: Candidate['pagination'];
	filters: Candidate['filters'];
	change: Candidate['change'];
	access: Candidate['access'];
	completeness: Candidate['completeness'];
	verdict: Candidate['verdict'];
	limitations: string[];
	score: number;
	breakdown: Candidate['breakdown'];
	pages: string[];
	structureHash: string;
	provenance: { analyzerVersion: string; discoveredAt: string };
}
