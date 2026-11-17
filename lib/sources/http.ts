/**
 * An HTTP JSON API as a source: a conditional GET through the SSRF guard. Signal does not bypass access
 * controls: 401/403/451 are reported as the source refusing access, never retried with tricks.
 */
import { sha256 } from '../core/canonical.ts';
import { BlockedUrlError, guardedFetch, type NetPolicy } from './net-guard.ts';

export const USER_AGENT = 'Signal/0.3 (+source refresh on behalf of its owner)';
export const MAX_FETCH_BYTES = 1_800_000; // what one FeltKit request can carry into the recording mutation

export type FetchResult =
	| { ok: true; notModified: false; body: string; hash: string; contentType: string | null; etag: string | null; lastModified: string | null; finalUrl: string; httpStatus: number; durationMs: number }
	| { ok: true; notModified: true; etag: string | null; lastModified: string | null; finalUrl: string; httpStatus: 304; durationMs: number }
	| { ok: false; code: string; message: string; httpStatus: number | null; durationMs: number };

export async function fetchJson(url: string, previous: { etag?: string | null; lastModified?: string | null }, policy: NetPolicy, fetchImpl = guardedFetch): Promise<FetchResult> {
	const t0 = performance.now();
	const ms = () => Math.round(performance.now() - t0);
	const headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: 'application/json, application/geo+json;q=0.9, text/csv;q=0.5' };
	if (previous.etag) headers['if-none-match'] = previous.etag;
	if (previous.lastModified) headers['if-modified-since'] = previous.lastModified;
	try {
		const { response, body, finalUrl } = await fetchImpl(url, { headers, maxBytes: MAX_FETCH_BYTES, timeoutMs: 20_000 }, policy);
		const etag = response.headers.get('etag'), lastModified = response.headers.get('last-modified');
		if (response.status === 304) return { ok: true, notModified: true, etag, lastModified, finalUrl, httpStatus: 304, durationMs: ms() };
		if ([401, 403, 451].includes(response.status)) return { ok: false, code: `HTTP_${response.status}`, message: 'the source refused access (credentials or permission needed)', httpStatus: response.status, durationMs: ms() };
		if (response.status >= 400) return { ok: false, code: `HTTP_${response.status}`, message: response.statusText || 'request failed', httpStatus: response.status, durationMs: ms() };
		return { ok: true, notModified: false, body: new TextDecoder().decode(body), hash: sha256(body), contentType: response.headers.get('content-type'), etag, lastModified, finalUrl, httpStatus: response.status, durationMs: ms() };
	} catch (e) {
		const blocked = e instanceof BlockedUrlError;
		return { ok: false, code: blocked ? 'URL_BLOCKED' : 'UNREACHABLE', message: (e as Error).message, httpStatus: null, durationMs: ms() };
	}
}
