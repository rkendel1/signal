import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Fixture {
	url: string;
	server: Server;
	set(path: string, res: { status?: number; body: string; type?: string; etag?: string; headers?: Record<string, string> }): void;
	requests: Array<{ method: string; path: string; headers: IncomingMessage['headers']; body: string }>;
	close(): Promise<void>;
}

/** Local HTTP fixture standing in for "an accessible webpage". */
export async function fixture(): Promise<Fixture> {
	const routes = new Map<string, Parameters<Fixture['set']>[1]>();
	const requests: Fixture['requests'] = [];
	const server = createServer((req, res) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			requests.push({ method: req.method!, path: req.url!, headers: req.headers, body });
			const r = routes.get(req.url!.split('?')[0]);
			if (!r) { res.writeHead(404); res.end('not found'); return; }
			if (r.etag && req.headers['if-none-match'] === r.etag) { res.writeHead(304, { etag: r.etag }); res.end(); return; }
			res.writeHead(r.status ?? 200, { 'content-type': r.type ?? 'text/html; charset=utf-8', ...(r.etag ? { etag: r.etag } : {}), ...(r.headers ?? {}) });
			res.end(r.body);
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`, server, set: (p, r) => routes.set(p, r), requests,
		close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); })
	};
}

export function productPage(price: string, extra = ''): string {
	return `<!doctype html><html><head><title>Widget</title><style>.x{}</style><script>var price="$1";</script></head>
<body><h1>Acme Widget</h1><p class="price">Price: <b>$${price}</b></p><p>In stock</p>${extra}</body></html>`;
}

export const priceCriteria = (id = 'price-drop', extra: Record<string, unknown> = {}) => JSON.stringify({
	id, name: 'Widget under $100', severity: 'warning',
	extract: [{ field: 'price', from: 'text', pattern: 'Price:\\s*\\$([0-9][0-9,.]*)', type: 'number' }],
	condition: { field: 'price', op: 'lt', value: 100 }, ...extra
});
