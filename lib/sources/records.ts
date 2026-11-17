/**
 * Parsing user-provided records (pure, deterministic): CSV (RFC 4180), GeoJSON, and JSON documents
 * (an array of objects, optionally at a path inside the document — what most HTTP APIs return).
 * Parsing never interprets meaning; a reviewed mapping does (lib/engine/mapping.ts).
 */
import type { Geometry } from '../engine/types.ts';

// ------------------------------------------------------------------ parsing

export type Cell = string | number | boolean | null;
export interface RawRow { index: number; props: Record<string, Cell>; geometry?: Geometry; pointer?: string }
export type RecordFormat = 'csv' | 'geojson' | 'json';
export interface ParsedDataset { format: RecordFormat; fields: string[]; rows: RawRow[] }

export const MAX_ROWS = 200_000;

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF/LF, embedded newlines. A BOM is ignored. */
export function parseCsv(text: string): ParsedDataset {
	const src = text.replace(/^﻿/, '');
	const table: string[][] = [];
	let row: string[] = [], cur = '', quoted = false;
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (quoted) {
			if (ch === '"') { if (src[i + 1] === '"') { cur += '"'; i++; } else quoted = false; } else cur += ch;
		} else if (ch === '"' && cur === '') quoted = true;
		else if (ch === ',') { row.push(cur); cur = ''; }
		else if (ch === '\n' || ch === '\r') {
			if (ch === '\r' && src[i + 1] === '\n') i++;
			row.push(cur); cur = '';
			if (row.some((c) => c !== '')) table.push(row);
			row = [];
		} else cur += ch;
	}
	if (quoted) throw new Error('csv: unterminated quoted field');
	row.push(cur);
	if (row.some((c) => c !== '')) table.push(row);
	if (!table.length) throw new Error('csv: no header row');
	const fields = table[0].map((h) => h.trim());
	if (fields.some((f) => !f)) throw new Error('csv: every column needs a header');
	if (new Set(fields).size !== fields.length) throw new Error('csv: duplicate column names');
	if (table.length - 1 > MAX_ROWS) throw new Error(`dataset: more than ${MAX_ROWS} rows`);
	const rows: RawRow[] = table.slice(1).map((r, index) => ({ index, props: Object.fromEntries(fields.map((f, i) => [f, r[i] === undefined || r[i].trim() === '' ? null : r[i].trim()])) }));
	return { format: 'csv', fields, rows };
}

const isPos = (c: unknown): c is [number, number] => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]) && Math.abs(c[1]) <= 90 && Math.abs(c[0]) <= 180;

/** GeoJSON FeatureCollection (or single Feature) of Point / Polygon / MultiPolygon. Other geometries are kept as rows without geometry. */
export function parseGeoJson(text: string): ParsedDataset {
	const doc = JSON.parse(text) as { type?: string; features?: unknown[] };
	const features = doc.type === 'FeatureCollection' ? (doc.features ?? []) : doc.type === 'Feature' ? [doc] : null;
	if (!features) throw new Error('geojson: expected a FeatureCollection or Feature');
	if (features.length > MAX_ROWS) throw new Error(`dataset: more than ${MAX_ROWS} rows`);
	const fieldSet = new Set<string>();
	const rows: RawRow[] = features.map((f, index) => {
		const feat = f as { properties?: Record<string, unknown> | null; geometry?: { type?: string; coordinates?: unknown } | null };
		const props: Record<string, Cell> = {};
		for (const [k, v] of Object.entries(feat.properties ?? {})) { props[k] = v === null || ['string', 'number', 'boolean'].includes(typeof v) ? (v as Cell) : JSON.stringify(v); fieldSet.add(k); }
		const g = feat.geometry;
		let geometry: Geometry | undefined;
		if (g?.type === 'Point' && isPos(g.coordinates)) geometry = { point: { lat: g.coordinates[1], lng: g.coordinates[0] } };
		else if (g?.type === 'Polygon' && Array.isArray(g.coordinates) && (g.coordinates as unknown[][]).every((r) => r.every(isPos))) geometry = { polygons: [g.coordinates as Array<Array<[number, number]>>] };
		else if (g?.type === 'MultiPolygon' && Array.isArray(g.coordinates) && (g.coordinates as unknown[][][]).every((p) => p.every((r) => r.every(isPos)))) geometry = { polygons: g.coordinates as Array<Array<Array<[number, number]>>> };
		return { index, props, ...(geometry ? { geometry } : {}) };
	});
	return { format: 'geojson', fields: [...fieldSet], rows };
}

/** Flatten one level of nesting into dotted names; arrays and deeper objects become JSON text. */
function flatten(obj: Record<string, unknown>, prefix = '', out: Record<string, Cell> = {}, depth = 0): Record<string, Cell> {
	for (const [k, v] of Object.entries(obj)) {
		const name = prefix ? `${prefix}.${k}` : k;
		if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[name] = v as Cell;
		else if (v && typeof v === 'object' && !Array.isArray(v) && depth < 2) flatten(v as Record<string, unknown>, name, out, depth + 1);
		else if (v !== undefined) out[name] = JSON.stringify(v);
	}
	return out;
}

/** Follow a dotted path ("data.items") or JSON pointer ("/data/items") to the record array. */
export function atPath(doc: unknown, path: string | undefined): unknown {
	if (!path) return doc;
	const parts = path.startsWith('/') ? path.slice(1).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~')) : path.split('.');
	let cur: unknown = doc;
	for (const p of parts) {
		if (cur === null || typeof cur !== 'object') return undefined;
		cur = (cur as Record<string, unknown>)[p];
	}
	return cur;
}

/** A JSON document whose records are an array of objects at `recordsPath` (or the document itself). */
export function parseJsonRecords(text: string, recordsPath?: string): ParsedDataset {
	let doc: unknown;
	try { doc = JSON.parse(text); } catch (e) { throw new Error(`json: ${(e as Error).message}`); }
	if (doc && typeof doc === 'object' && (doc as { type?: string }).type === 'FeatureCollection' && !recordsPath) return parseGeoJson(text);
	const list = atPath(doc, recordsPath);
	if (!Array.isArray(list)) throw new Error(`json: expected an array of records${recordsPath ? ` at "${recordsPath}"` : ''}`);
	if (list.length > MAX_ROWS) throw new Error(`records: more than ${MAX_ROWS}`);
	const fieldSet = new Set<string>();
	const rows: RawRow[] = list.map((item, index) => {
		const props = item && typeof item === 'object' && !Array.isArray(item) ? flatten(item as Record<string, unknown>) : { value: JSON.stringify(item) };
		for (const k of Object.keys(props)) fieldSet.add(k);
		return { index, props, pointer: `${recordsPath ? (recordsPath.startsWith('/') ? recordsPath : '/' + recordsPath.split('.').join('/')) : ''}/${index}` };
	});
	return { format: 'json', fields: [...fieldSet], rows };
}

export function parseRecords(text: string, format: RecordFormat, recordsPath?: string): ParsedDataset {
	return format === 'csv' ? parseCsv(text) : format === 'geojson' ? parseGeoJson(text) : parseJsonRecords(text, recordsPath);
}
