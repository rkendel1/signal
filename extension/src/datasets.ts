/**
 * "My data" in the extension: the person's own datasets, and what the panel needs to import them, review a
 * proposed mapping, approve it, select datasets for discovery and read where each external fact came from.
 *
 * This file is logic only (no DOM) so it can be unit-tested. It calls the existing `datasets.*` API with the
 * panel's FeltKit client. The file's bytes go to the instance once, in the import call (the instance stores
 * them in Files); they are not kept in the panel, in extension storage, in a URL or in a message to a page.
 * Credentials and database connections do not exist here: datasets are files the person chose.
 */
import type { FeltKitClient } from '@feltdb/feltkit/client';
import { api } from '../../feltkit/_generated/api.ts';
import type { DatasetMapping, FieldMapping, FieldProfile, MappingIssue, MappingProposal } from '../../lib/datasets/dataset.ts';

// ------------------------------------------------------------------ types (what the API returns)

export interface DatasetRow {
	id: string; name: string; freshness: 'static' | 'periodic' | 'live'; format: 'csv' | 'geojson'; retired: boolean; createdAt: string;
	latestVersion: number; reviewed: boolean; rows: number; dataAsOf: string | null; retrievedAt: string;
}
export interface Review {
	version: number; reviewed: boolean; format: 'csv' | 'geojson'; rows: number;
	fields: FieldProfile[]; proposals: MappingProposal[]; unmapped: string[];
	mapping: DatasetMapping; issues: MappingIssue[]; issueCount: number;
	preview: Array<{ raw: Record<string, string | number | boolean | null>; mapped: Record<string, unknown> }>;
}
export interface Imported { datasetId: string; versionId: string; version: number; review: Review }

// ------------------------------------------------------------------ files

/** FeltKit rejects request bodies over 2 MiB; the content is sent inside a JSON envelope, so leave room. */
export const MAX_REQUEST_CONTENT_BYTES = 1_800_000;
/** One FeltKit Files object. The instance stores the gzip of the file, and refuses it beyond this size. */
export const MAX_STORED_BYTES = 1_048_576;

export type FileCheck = { ok: true; format: 'csv' | 'geojson'; defaultName: string } | { ok: false; reason: string };

/** By name only; the instance parses the content and says what is wrong with it. */
export function checkFileName(name: string): FileCheck {
	const m = /^(.*)\.(csv|geojson|json)$/i.exec(name);
	if (!m) return { ok: false, reason: `“${name}” is not a CSV or GeoJSON file. Signal can import .csv, .geojson and .json (GeoJSON) files.` };
	return { ok: true, format: m[2].toLowerCase() === 'csv' ? 'csv' : 'geojson', defaultName: m[1] };
}

export const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

async function gzipSize(text: string): Promise<number> {
	const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
	return (await new Response(stream).arrayBuffer()).byteLength;
}

export interface Prepared { format: 'csv' | 'geojson'; content: string; defaultName: string; bytes: number; storedBytes: number }

/** Read and check a chosen file before anything is sent. Never truncates: a file that is too large is refused, whole. */
export async function prepareFile(file: { name: string; size: number; text(): Promise<string> }): Promise<Prepared> {
	const c = checkFileName(file.name);
	if (!c.ok) throw new Error(c.reason);
	if (file.size === 0) throw new Error(`“${file.name}” is empty.`);
	if (file.size > MAX_REQUEST_CONTENT_BYTES) throw new Error(`“${file.name}” is ${mb(file.size)}. One import can carry up to ${mb(MAX_REQUEST_CONTENT_BYTES)} of file. Signal does not cut files down: split it by area (for example one file per neighbourhood) and import the parts.`);
	const content = await file.text();
	const bytes = new TextEncoder().encode(content).byteLength;
	if (bytes > MAX_REQUEST_CONTENT_BYTES) throw new Error(`“${file.name}” is ${mb(bytes)} as text; the limit for one import is ${mb(MAX_REQUEST_CONTENT_BYTES)}. Split it by area and import the parts.`);
	const storedBytes = await gzipSize(content);
	if (storedBytes > MAX_STORED_BYTES) throw new Error(`“${file.name}” is ${mb(storedBytes)} once compressed; Signal stores up to ${mb(MAX_STORED_BYTES)} per dataset. Signal does not cut files down: split it by area and import the parts.`);
	return { format: c.format, content, defaultName: c.defaultName, bytes, storedBytes };
}

// ------------------------------------------------------------------ the existing API

export async function listDatasets(client: FeltKitClient): Promise<DatasetRow[]> {
	return ((await client.query(api.datasets.list, {})) as unknown as DatasetRow[]).filter((d) => !d.retired);
}
export async function importDataset(client: FeltKitClient, p: Prepared, o: { name: string; freshness: DatasetRow['freshness']; dataAsOf?: string }): Promise<Imported> {
	return (await client.mutation(api.datasets.importDataset, { name: o.name, format: p.format, content: p.content, freshness: o.freshness, ...(o.dataAsOf ? { dataAsOf: o.dataAsOf } : {}) })) as unknown as Imported;
}
export async function inspectDataset(client: FeltKitClient, datasetId: string, version?: number): Promise<Review> {
	return (await client.query(api.datasets.inspect, { datasetId, ...(version !== undefined ? { version } : {}) })) as unknown as Review;
}
/** Approving (or editing and approving) creates the next immutable version over the same bytes. */
export async function approveMapping(client: FeltKitClient, datasetId: string, mapping: DatasetMapping, dataAsOf?: string): Promise<{ version: number; review: Review }> {
	return (await client.mutation(api.datasets.setMapping, { datasetId, mapping: JSON.stringify(mapping), ...(dataAsOf ? { dataAsOf } : {}) })) as unknown as { version: number; review: Review };
}

// ------------------------------------------------------------------ mapping review

export const TYPE_LABEL: Record<FieldMapping['type'], string> = { text: 'Text', number: 'Number', money: 'Money' };
export const humanAttr = (a: string) => a.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
export const ROLE_LABEL: Record<NonNullable<FieldMapping['role']>, string> = { id: 'parcel ID', address: 'address', latitude: 'latitude', longitude: 'longitude' };

/** The state a person sees. Only "approved" datasets can take part in discovery. */
export function statusOf(d: Pick<DatasetRow, 'reviewed'>): { key: 'proposed' | 'approved'; label: string; hint: string } {
	return d.reviewed
		? { key: 'approved', label: 'Approved', hint: 'You approved this mapping. It can be used in discovery.' }
		: { key: 'proposed', label: 'Needs your approval', hint: 'Signal proposed a mapping. Nothing from this file is used until you approve it.' };
}

/** A working copy of the mapping the person is editing. Approving it creates a new version; the stored one is never changed. */
export interface Draft { base: DatasetMapping; fields: FieldMapping[] }
export const startDraft = (m: DatasetMapping): Draft => ({ base: m, fields: m.fields.map((f) => ({ ...f })) });
export const draftMapping = (d: Draft, version = d.base.version): DatasetMapping => ({ version, fields: d.fields });
export const draftChanged = (d: Draft) => JSON.stringify(d.base.fields) !== JSON.stringify(d.fields);

export function dropField(d: Draft, source: string): Draft { return { ...d, fields: d.fields.filter((f) => f.source !== source) }; }
export function renameField(d: Draft, source: string, attribute: string): Draft {
	return { ...d, fields: d.fields.map((f) => (f.source === source ? { ...f, attribute: attribute.trim() } : f)) };
}
/** Map a column that was left out. Roles (id, address, coordinates) are not offered here: they come from the proposal. */
export function addField(d: Draft, source: string, attribute: string, type: FieldMapping['type']): Draft {
	return { ...d, fields: [...d.fields, { source, attribute: attribute.trim(), type, ...(type === 'money' ? { currency: 'USD' } : {}) }] };
}
export const unmappedIn = (d: Draft, columns: string[]) => columns.filter((c) => !d.fields.some((f) => f.source === c));
/** A reason the draft cannot be approved, or null. The instance checks again. */
export function draftProblem(d: Draft): string | null {
	// A file that only identifies or locates things adds nothing to a property: do not let it be approved as if it did.
	if (!d.fields.some((f) => !f.role)) return 'Nothing in this mapping is a fact Signal could add to a property (such as assessed value or tax). Map at least one such column, or this is not the file you meant to import.';
	const seen = new Set<string>();
	for (const f of d.fields) {
		if (!f.attribute) return `Name the Signal attribute for “${f.source}”, or leave the column out.`;
		if (!/^[A-Za-z][A-Za-z0-9]*$/.test(f.attribute)) return `“${f.attribute}” is not a valid attribute name (letters and digits, starting with a letter).`;
		if (seen.has(f.attribute)) return `Two columns are mapped to “${f.attribute}”.`;
		seen.add(f.attribute);
	}
	return null;
}

export function why(review: Review, f: FieldMapping): string {
	const p = review.proposals.find((x) => x.source === f.source && x.attribute === f.attribute);
	return p ? p.basis : review.proposals.some((x) => x.source === f.source) ? 'You chose this attribute' : 'You added this column';
}
export function typeLabel(f: FieldMapping): string { return f.type === 'money' ? `Money (${f.currency ?? 'USD'})` : TYPE_LABEL[f.type]; }

export function issueLines(review: Review): string[] {
	// `row` is the zero-based data row; people count data rows from 1.
	return review.issues.map((i) => `Row ${i.row + 1} · ${i.field}: ${i.problem} (“${i.raw}”)`);
}

/** Things worth knowing before approving. Not errors: the file can still be used. */
export function warnings(review: Review, m: DatasetMapping = review.mapping): string[] {
	const out: string[] = [];
	const has = (r: string) => m.fields.some((f) => f.role === r);
	if (!has('id')) out.push('No parcel ID column is mapped, so properties can only be matched by address or location.');
	if (!has('address')) out.push('No address column is mapped, so properties can only be matched by parcel ID or location.');
	if (review.format === 'csv' && !(has('latitude') && has('longitude'))) out.push('No latitude and longitude columns are mapped, so matches by address cannot be checked against the property’s location.');
	if (review.issueCount > review.issues.length) out.push(`${review.issueCount - review.issues.length} more values could not be read (the first ${review.issues.length} are listed).`);
	if (!m.fields.some((f) => !f.role)) out.push('No facts are mapped (only identifiers and location), so this file would not add any information to a property.');
	return out;
}

// ------------------------------------------------------------------ selection for discovery

export function usable(d: DatasetRow): { ok: true } | { ok: false; why: string } {
	if (d.retired) return { ok: false, why: 'This dataset was retired.' };
	if (!d.reviewed) return { ok: false, why: 'Its mapping has not been approved yet. Review it under My data.' };
	return { ok: true };
}
/** Keep only selections that still exist and can be used, in the order they were chosen. */
export function reconcileSelection(selected: string[], list: DatasetRow[]): string[] {
	const ok = new Set(list.filter((d) => usable(d).ok).map((d) => d.id));
	return [...new Set(selected)].filter((id) => ok.has(id));
}

// ------------------------------------------------------------------ results: where each external fact came from

export interface AugmentedValue {
	candidateKey: string; attribute: string; value: unknown;
	dataset: { id: string; name: string; versionId: string; mappingVersion: number; freshness: string; dataAsOf: string | null; retrievedAt: string };
	recordId: string; basis: string; confidence: string; conflict?: { pageValue: unknown };
}
export interface Resolution { candidateKey: string; status: 'matched' | 'ambiguous' | 'conflict' | 'unmatched' | 'no_identity'; recordId?: string; basis?: string; confidence?: string; reason: string; options?: Array<{ recordId: string; address: string | null; distanceM: number | null }> }
export interface Augmentation { values: AugmentedValue[]; resolutions: Array<{ dataset: { id: string; versionId: string; mappingVersion: number }; resolutions: Resolution[] }> }

export const BASIS: Record<string, string> = {
	'authoritative-id': 'the same parcel ID',
	'address+coordinates': 'the same address, at the same location',
	address: 'the same address (no location to confirm it)',
	containment: 'the listing’s location is inside this parcel',
	coordinates: 'the same location'
};
export const STATUS_TEXT: Record<Resolution['status'], string> = {
	matched: 'Matched', ambiguous: 'Could be more than one property — not used', conflict: 'The address and location disagree — not used', unmatched: 'No matching record', no_identity: 'The page gives nothing to match on'
};
const FRESH: Record<string, string> = { static: 'a snapshot that does not change', periodic: 'refreshed periodically', live: 'queried live' };
export const freshnessText = (f: string) => FRESH[f] ?? f;

export function formatAttr(v: unknown): string {
	if (v && typeof v === 'object' && 'amount' in v) {
		const m = v as { amount: number; currency: string | null };
		return m.currency && m.currency !== 'USD' ? `${m.amount.toLocaleString('en-US')} ${m.currency}` : `$${m.amount.toLocaleString('en-US')}`;
	}
	return typeof v === 'number' ? v.toLocaleString('en-US') : String(v);
}

export interface Facts {
	/** Per dataset: how this property was (or was not) connected to a record. */
	links: Array<{ datasetId: string; datasetName: string; status: Resolution['status']; text: string; reason: string; options?: Resolution['options'] }>;
	/** Values supplied by a dataset, never by the page. */
	external: Array<{ attribute: string; label: string; value: string; dataset: string; version: string; asOf: string; fresh: string; record: string; basis: string; conflict?: string }>;
	/** Calculated values, with the origin of each input. */
	metrics: Array<{ name: string; value: string; inputs: Array<{ attr: string; from: string }>; unknown: string[] }>;
}
type MetricView = Record<string, { value: number | null; possibleValues?: number[]; inputs: Array<{ attr: string; provenance: string; source?: string }> }>;

const fromText = (provenance: string, source: string | undefined, names: Map<string, string>) =>
	provenance === 'page' ? 'the listing page'
	: provenance === 'page-conflict' ? 'the listing page (it states more than one value)'
	: provenance === 'external-record' ? `your data: ${names.get(source ?? '') ?? source ?? 'a dataset'}`
	: provenance === 'external-estimate' ? `an estimate: ${source ?? 'external source'}`
	: provenance === 'missing' ? 'not available' : provenance;

/** Everything the results should say about one candidate's external facts, in the person's words. */
export function factsFor(key: string, metrics: MetricView, aug: Augmentation | undefined): Facts {
	const names = new Map<string, string>();
	for (const v of aug?.values ?? []) names.set(v.dataset.id, v.dataset.name);
	const f: Facts = { links: [], external: [], metrics: [] };
	for (const d of aug?.resolutions ?? []) {
		const r = d.resolutions.find((x) => x.candidateKey === key);
		if (!r) continue;
		const name = names.get(d.dataset.id) ?? 'Your dataset';
		f.links.push({ datasetId: d.dataset.id, datasetName: name, status: r.status, text: r.status === 'matched' ? `Matched by ${BASIS[r.basis ?? ''] ?? r.basis}${r.confidence === 'medium' ? ' (medium confidence)' : ''}` : STATUS_TEXT[r.status], reason: r.reason, ...(r.options?.length ? { options: r.options } : {}) });
	}
	for (const v of (aug?.values ?? []).filter((x) => x.candidateKey === key)) {
		f.external.push({
			attribute: v.attribute, label: humanAttr(v.attribute), value: formatAttr(v.value), dataset: v.dataset.name,
			version: `mapping version ${v.dataset.mappingVersion}`, asOf: v.dataset.dataAsOf ? `data as of ${v.dataset.dataAsOf}` : 'data date not stated', fresh: `${freshnessText(v.dataset.freshness)}, received ${v.dataset.retrievedAt.slice(0, 10)}`,
			record: v.recordId, basis: BASIS[v.basis] ?? v.basis,
			...(v.conflict ? { conflict: `The listing page says ${formatAttr(v.conflict.pageValue)}. Signal uses the page’s value; this is the dataset’s.` } : {})
		});
	}
	for (const [name, m] of Object.entries(metrics)) {
		const value = m.value !== null ? String(Math.round(m.value * 10000) / 10000) : m.possibleValues?.length ? `uncertain (${m.possibleValues.map((x) => Math.round(x * 10000) / 10000).join(' or ')})` : 'cannot be calculated';
		f.metrics.push({ name: humanAttr(name), value, inputs: m.inputs.map((i) => ({ attr: humanAttr(i.attr), from: fromText(i.provenance, i.source, names) })), unknown: m.inputs.filter((i) => i.provenance === 'missing').map((i) => humanAttr(i.attr)) });
	}
	return f;
}

// ------------------------------------------------------------------ stale responses

/** Latest-wins: take a ticket before an async call and apply the result only if it is still the newest. */
export class Latest {
	private n = 0;
	next(): number { return ++this.n; }
	isCurrent(ticket: number): boolean { return ticket === this.n; }
	/** Invalidate everything in flight (for example when the selection is cleared). */
	cancel(): void { this.n++; }
}
