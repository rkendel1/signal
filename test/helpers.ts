import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Principal } from '../src/contracts/types.ts';
import { SignalStore } from '../src/store/feltdb-store.ts';

export const ALL_PERMS = [
	'signal.source.write', 'signal.criteria.write', 'signal.monitor.write', 'signal.monitor.run',
	'signal.event.read', 'signal.event.ack', 'signal.evidence.read'
];
export const alice: Principal = { tenantId: 't_acme', subjectId: 'u_alice', permissions: ALL_PERMS };
export const bob: Principal = { tenantId: 't_acme', subjectId: 'u_bob', permissions: ALL_PERMS };
export const mallory: Principal = { tenantId: 't_evil', subjectId: 'u_mallory', permissions: ALL_PERMS };

export async function tempStore(tenantId = 't_acme'): Promise<SignalStore> {
	return SignalStore.open({ tenantId, path: mkdtempSync(join(tmpdir(), 'signal-test-')) });
}

export interface Fixture {
	url: string;
	server: Server;
	set(path: string, res: { status?: number; statusSeq?: number[]; body: string; type?: string; etag?: string; headers?: Record<string, string> }): void;
	requests: Array<{ method: string; path: string; headers: IncomingMessage['headers']; body: string }>;
	close(): Promise<void>;
}

/** Local HTTP fixture standing in for "an accessible webpage" and "a webhook receiver". */
export async function fixture(): Promise<Fixture> {
	const routes = new Map<string, { status?: number; statusSeq?: number[]; body: string; type?: string; etag?: string; headers?: Record<string, string> }>();
	const requests: Fixture['requests'] = [];
	const server = createServer((req, res) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			requests.push({ method: req.method!, path: req.url!, headers: req.headers, body });
			const r = routes.get(req.url!.split('?')[0]);
			if (!r) { res.writeHead(404); res.end('not found'); return; }
			if (r.etag && req.headers['if-none-match'] === r.etag) { res.writeHead(304, { etag: r.etag }); res.end(); return; }
			const status = r.statusSeq?.length ? r.statusSeq.shift()! : r.status ?? 200;
			res.writeHead(status, { 'content-type': r.type ?? 'text/html; charset=utf-8', ...(r.etag ? { etag: r.etag } : {}), ...(r.headers ?? {}) });
			res.end(r.body);
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		server,
		set: (p, r) => routes.set(p, r),
		requests,
		close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); })
	};
}

export const instantRetry = { maxAttempts: 3, backoffMs: () => 0, sleep: async () => {} };
export const testNet = { allowPrivateHosts: ['127.0.0.1'] };

export function productPage(price: string, extra = ''): string {
	return `<!doctype html><html><head><title>Widget</title><style>.x{}</style><script>var price="$1";</script></head>
<body><h1>Acme Widget</h1><p class="price">Price: <b>$${price}</b></p><p>In stock</p>${extra}</body></html>`;
}
