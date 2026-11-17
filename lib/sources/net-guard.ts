import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Outbound URL policy shared by source observation and webhook delivery.
 * Prevents SSRF: only http(s), no credentials in URLs, no private / loopback /
 * link-local / metadata / CGNAT / multicast destinations — checked on the
 * resolved address and again on every redirect hop.
 *
 * Known limitation (recorded in GAP_REGISTER): resolution and connection are two
 * steps, so a DNS-rebinding attacker with a TTL≈0 record can race the check.
 * Closing that requires pinning the resolved IP at connect time (custom
 * dispatcher) or an egress proxy; the platform's egress component should own it.
 */

export interface NetPolicy {
	/** Hostnames explicitly allowed even if they resolve to private ranges (tests, on-prem). */
	allowPrivateHosts?: string[];
	allowHttp?: boolean;
}

export class BlockedUrlError extends Error {
	readonly code = 'URL_BLOCKED';
}

function ipv4Private(ip: string): boolean {
	const [a, b] = ip.split('.').map(Number);
	return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) ||
		(a === 198 && (b === 18 || b === 19)) || a >= 224;
}

export function isPrivateAddress(ip: string): boolean {
	if (isIP(ip) === 4) return ipv4Private(ip);
	const v = ip.toLowerCase();
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
	if (mapped) return ipv4Private(mapped[1]);
	// WHATWG URL serialises IPv4-mapped addresses in hex (::ffff:7f00:1); decode before checking.
	const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v);
	if (hex) {
		const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
		return ipv4Private(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
	}
	return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') ||
		v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff') || v.startsWith('64:ff9b');
}

/**
 * Synchronous checks that need no DNS: scheme, credentials, internal names, literal
 * private IPs. Safe inside a FeltKit mutation (no network). Returns the parsed URL and
 * whether the host is explicitly allowed.
 */
export function assertUrlShapeAllowed(raw: string, policy: NetPolicy = {}): { url: URL; host: string; allowlisted: boolean } {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new BlockedUrlError(`Not a valid absolute URL: ${raw}`);
	}
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && policy.allowHttp !== false)) {
		throw new BlockedUrlError(`Scheme ${url.protocol} not allowed`);
	}
	if (url.username || url.password) throw new BlockedUrlError('Credentials in URL are not allowed');
	const host = url.hostname.replace(/^\[|\]$/g, '');
	if ((policy.allowPrivateHosts ?? []).includes(host)) return { url, host, allowlisted: true };
	if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host === 'metadata.google.internal') {
		throw new BlockedUrlError(`Host ${host} is internal`);
	}
	if (isIP(host) && isPrivateAddress(host)) throw new BlockedUrlError(`Host ${host} resolves to non-public address ${host}`);
	return { url, host, allowlisted: false };
}

export async function assertUrlAllowed(raw: string, policy: NetPolicy = {}): Promise<URL> {
	const { url, host, allowlisted } = assertUrlShapeAllowed(raw, policy);
	if (allowlisted || isIP(host)) return url;
	const addrs = await lookup(host, { all: true, verbatim: true }).catch(() => {
		throw new BlockedUrlError(`Host ${host} does not resolve`);
	});
	for (const a of addrs) {
		if (isPrivateAddress(a.address)) throw new BlockedUrlError(`Host ${host} resolves to non-public address ${a.address}`);
	}
	return url;
}

/**
 * fetch with redirect re-validation, timeout and byte cap. Never follows a
 * redirect into a blocked address.
 */
export async function guardedFetch(
	raw: string,
	init: RequestInit & { maxBytes?: number; timeoutMs?: number; maxRedirects?: number },
	policy: NetPolicy
): Promise<{ response: Response; body: Uint8Array; finalUrl: string; redirects: string[] }> {
	const { maxBytes = 5_000_000, timeoutMs = 15_000, maxRedirects = 5, ...rest } = init;
	const redirects: string[] = [];
	let current = raw;
	for (let hop = 0; ; hop++) {
		await assertUrlAllowed(current, policy);
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		try {
			const response = await fetch(current, { ...rest, redirect: 'manual', signal: ctrl.signal });
			if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
				if (hop >= maxRedirects) throw new BlockedUrlError('Too many redirects');
				await response.body?.cancel();
				current = new URL(response.headers.get('location')!, current).toString();
				redirects.push(current);
				continue;
			}
			const chunks: Uint8Array[] = [];
			let total = 0;
			if (response.body) {
				for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
					total += chunk.byteLength;
					if (total > maxBytes) {
						ctrl.abort();
						throw new BlockedUrlError(`Response exceeds ${maxBytes} bytes`);
					}
					chunks.push(chunk);
				}
			}
			const body = new Uint8Array(total);
			let off = 0;
			for (const c of chunks) { body.set(c, off); off += c.byteLength; }
			return { response, body, finalUrl: current, redirects };
		} finally {
			clearTimeout(timer);
		}
	}
}
