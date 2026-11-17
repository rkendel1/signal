import type { Observation, ObservationRequest, ObservationResult, ObservationSource, SourceType } from '../contracts/types.ts';
import { newId, sha256 } from '../core/canonical.ts';
import { BlockedUrlError, guardedFetch, type NetPolicy } from './net-guard.ts';

export const USER_AGENT = 'BoundrySignal/0.1 (+https://boundry.dev/signal)';
const KEPT_HEADERS = ['content-type', 'etag', 'last-modified', 'date', 'cache-control', 'content-length'];

function base(req: ObservationRequest, adapter: string, method: string): Omit<Observation, 'status'> {
	return {
		schema: 'signal.observation/v1',
		observationId: newId('obs'),
		tenantId: req.source.tenantId,
		sourceId: req.source.id,
		observedAt: req.requestedAt,
		provenance: { adapter, method }
	};
}

/** Minimal robots.txt evaluation (RFC 9309 longest-match for our UA group or `*`). */
export function robotsAllows(robotsTxt: string, path: string, ua = 'BoundrySignal'): boolean {
	const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> = [];
	let cur: (typeof groups)[number] | undefined;
	let lastWasAgent = false;
	for (const line of robotsTxt.split(/\r?\n/)) {
		const m = /^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*(#.*)?$/.exec(line);
		if (!m) continue;
		const key = m[1].toLowerCase();
		if (key === 'user-agent') {
			if (!lastWasAgent || !cur) { cur = { agents: [], rules: [] }; groups.push(cur); }
			cur.agents.push(m[2].toLowerCase());
			lastWasAgent = true;
		} else if ((key === 'allow' || key === 'disallow') && cur) {
			lastWasAgent = false;
			if (m[2] !== '') cur.rules.push({ allow: key === 'allow', path: m[2] });
		} else lastWasAgent = false;
	}
	const mine = groups.find((g) => g.agents.some((a) => a !== '*' && ua.toLowerCase().includes(a))) ?? groups.find((g) => g.agents.includes('*'));
	if (!mine) return true;
	let best: { allow: boolean; len: number } = { allow: true, len: -1 };
	for (const r of mine.rules) {
		const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
		if (re.test(path) && (r.path.length > best.len || (r.path.length === best.len && r.allow))) best = { allow: r.allow, len: r.path.length };
	}
	return best.allow;
}

/** `http_page` / `json` over HTTP: conditional GET, robots.txt, SSRF guard, byte cap. */
export class HttpSource implements ObservationSource {
	readonly adapter = 'http-page@1';
	readonly type: SourceType;
	private policy: NetPolicy;
	private fetchImpl: typeof guardedFetch;
	constructor(type: SourceType = 'http_page', policy: NetPolicy = {}, fetchImpl = guardedFetch) { this.type = type; this.policy = policy; this.fetchImpl = fetchImpl; }

	async observe(req: ObservationRequest): Promise<ObservationResult> {
		const obs = base(req, this.adapter, 'GET');
		obs.provenance.requestedUrl = req.source.locator;
		if (req.source.access.authorization !== 'public') {
			return { observation: { ...obs, status: 'denied', error: { code: 'CREDENTIALS_UNAVAILABLE', message: 'credential_ref sources require a host-provided credential resolver (not configured)' } } };
		}
		try {
			if (req.source.access.respectRobots !== false && req.source.observation.strategy === 'poll') {
				const u = new URL(req.source.locator);
				const robots = await this.fetchImpl(`${u.origin}/robots.txt`, { headers: { 'user-agent': USER_AGENT }, maxBytes: 500_000, timeoutMs: 5000 }, this.policy)
					.catch(() => undefined);
				if (!robots || robots.response.status >= 500) {
					// RFC 9309 §2.3.1.4: unreachable robots.txt ⇒ assume complete disallow.
					obs.provenance.robots = 'unavailable';
					return { observation: { ...obs, status: 'denied', error: { code: 'ROBOTS_UNREACHABLE', message: 'robots.txt unreachable; automated polling is not permitted until it is' } } };
				}
				if (robots.response.status >= 400) obs.provenance.robots = 'allowed'; // RFC 9309: 4xx ⇒ no restrictions
				else if (!robotsAllows(new TextDecoder().decode(robots.body), u.pathname + u.search)) {
					obs.provenance.robots = 'disallowed';
					return { observation: { ...obs, status: 'denied', error: { code: 'ROBOTS_DISALLOWED', message: 'robots.txt disallows automated access to this path' } } };
				} else obs.provenance.robots = 'allowed';
			} else obs.provenance.robots = 'not_checked';

			const headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: 'text/html,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5' };
			if (req.previous?.etag) headers['if-none-match'] = req.previous.etag;
			if (req.previous?.lastModified) headers['if-modified-since'] = req.previous.lastModified;
			const { response, body, finalUrl, redirects } = await this.fetchImpl(req.source.locator, { headers }, this.policy);
			const kept: Record<string, string> = {};
			for (const h of KEPT_HEADERS) { const v = response.headers.get(h); if (v) kept[h] = v; }
			obs.provenance = { ...obs.provenance, finalUrl, httpStatus: response.status, headers: kept, redirects };
			if (response.status === 304) return { observation: { ...obs, status: 'not_modified', revision: kept.etag } };
			if (response.status === 401 || response.status === 403 || response.status === 451) {
				return { observation: { ...obs, status: 'denied', error: { code: `HTTP_${response.status}`, message: 'Source refused access; Signal does not bypass access controls' } } };
			}
			if (response.status >= 400) {
				return { observation: { ...obs, status: 'error', error: { code: `HTTP_${response.status}`, message: response.statusText } } };
			}
			const contentHash = sha256(body);
			return {
				observation: { ...obs, status: 'ok', contentHash, contentType: kept['content-type'], byteLength: body.byteLength, revision: kept.etag ?? contentHash },
				body
			};
		} catch (e) {
			const blocked = e instanceof BlockedUrlError;
			return { observation: { ...obs, status: blocked ? 'denied' : 'error', error: { code: blocked ? 'URL_BLOCKED' : 'FETCH_FAILED', message: (e as Error).message } } };
		}
	}
}

/** `text` / `json` / `dom`: content pushed by an authorized caller (e.g. the browser overlay). */
export class PushedContentSource implements ObservationSource {
	readonly adapter = 'pushed-content@1';
	readonly type: SourceType;
	private maxBytes: number;
	constructor(type: SourceType, maxBytes = 5_000_000) { this.type = type; this.maxBytes = maxBytes; }

	async observe(req: ObservationRequest): Promise<ObservationResult> {
		const obs = base(req, this.adapter, 'PUSH');
		if (req.content === undefined) return { observation: { ...obs, status: 'error', error: { code: 'NO_CONTENT', message: 'Pushed source requires content' } } };
		const body = new TextEncoder().encode(req.content);
		if (body.byteLength > this.maxBytes) return { observation: { ...obs, status: 'error', error: { code: 'TOO_LARGE', message: `Content exceeds ${this.maxBytes} bytes` } } };
		const contentHash = sha256(body);
		const contentType = this.type === 'json' ? 'application/json' : this.type === 'dom' ? 'text/html' : 'text/plain';
		return { observation: { ...obs, status: 'ok', contentHash, contentType, byteLength: body.byteLength, revision: contentHash }, body };
	}
}
