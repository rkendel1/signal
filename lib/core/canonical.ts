import { createHash, randomUUID } from 'node:crypto';

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(sortKeys);
	if (v && typeof v === 'object' && !(v instanceof Date)) {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(v as Record<string, unknown>).sort()) {
			const x = (v as Record<string, unknown>)[k];
			if (x !== undefined) out[k] = sortKeys(x);
		}
		return out;
	}
	return v;
}

export function sha256(data: string | Uint8Array): string {
	return createHash('sha256').update(data).digest('hex');
}

/** Prefixed random id, e.g. `obs_…`. Identity of records, never of content. */
export function newId(prefix: string): string {
	return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

/** Content-derived id: identical inputs always produce the identical id. */
export function contentId(prefix: string, value: unknown): string {
	return `${prefix}_${sha256(canonicalJson(value)).slice(0, 32)}`;
}
