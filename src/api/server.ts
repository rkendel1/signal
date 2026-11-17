import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Principal } from '../contracts/types.ts';
import { AuthorizationError, type SignalService } from '../runtime/service.ts';
import type { SignalEngine } from '../runtime/engine.ts';

/**
 * Application-facing HTTP surface (JSON). Thin: every route delegates to
 * SignalService, which authorizes. Authentication is the host's job — the
 * server is given `authenticate(req) → Principal | undefined` (in Boundry,
 * AppPort/AuthBoundry verify the credential before it reaches Signal).
 *
 *   GET  /v1/events?sourceLocator=…     events visible to the caller (+acknowledged flag)
 *   GET  /v1/events/:id/evidence        event + normalized evidence text
 *   POST /v1/events/:id/ack             acknowledge
 *   POST /v1/monitors/:id/run           run one cycle (body {content?} for pushed sources)
 *   GET  /overlay.js, /codec/*          browser overlay + Ghostpost codec (WASM)
 */
export interface ApiOptions {
	service: SignalService;
	engine: SignalEngine;
	authenticate: (req: IncomingMessage) => Principal | undefined;
	/** Origins allowed to call the API from a page (the overlay). */
	corsOrigins?: string[] | '*';
}

const STATIC: Record<string, { file: string; type: string }> = {
	'/overlay.js': { file: '../overlay/overlay.js', type: 'text/javascript; charset=utf-8' },
	'/codec/ghostpost_unicode_codec.js': { file: '../../codecs/ghostpost-unicode/pkg/ghostpost_unicode_codec.js', type: 'text/javascript; charset=utf-8' },
	'/codec/ghostpost_unicode_codec_bg.wasm': { file: '../../codecs/ghostpost-unicode/pkg/ghostpost_unicode_codec_bg.wasm', type: 'application/wasm' }
};

async function readJson(req: IncomingMessage, max = 5_000_000): Promise<Record<string, unknown>> {
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const c of req) {
		size += (c as Buffer).length;
		if (size > max) throw Object.assign(new Error('Body too large'), { status: 413 });
		chunks.push(c as Buffer);
	}
	if (!size) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		throw Object.assign(new Error('Invalid JSON'), { status: 400 });
	}
}

export function createApi(opts: ApiOptions): Server {
	return createServer(async (req: IncomingMessage, res: ServerResponse) => {
		const origin = req.headers.origin;
		if (origin && (opts.corsOrigins === '*' || opts.corsOrigins?.includes(origin))) {
			res.setHeader('access-control-allow-origin', origin);
			res.setHeader('vary', 'origin');
			res.setHeader('access-control-allow-headers', 'authorization, content-type');
			res.setHeader('access-control-allow-methods', 'GET, POST');
		}
		const send = (status: number, body: unknown) => {
			res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
			res.end(JSON.stringify(body));
		};
		try {
			const url = new URL(req.url ?? '/', 'http://local');
			if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
			const asset = STATIC[url.pathname];
			if (req.method === 'GET' && asset) {
				const data = await readFile(fileURLToPath(new URL(asset.file, import.meta.url)));
				res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
				res.end(data);
				return;
			}
			const principal = opts.authenticate(req);
			if (!principal) return send(401, { error: 'unauthenticated' });
			let m: RegExpExecArray | null;
			if (req.method === 'GET' && url.pathname === '/v1/events') {
				const sourceLocator = url.searchParams.get('sourceLocator') ?? undefined;
				return send(200, { events: await opts.service.listEvents(principal, { sourceLocator }) });
			}
			if (req.method === 'GET' && (m = /^\/v1\/events\/([\w-]+)\/evidence$/.exec(url.pathname))) {
				return send(200, await opts.service.getEvidence(principal, m[1]));
			}
			if (req.method === 'POST' && (m = /^\/v1\/events\/([\w-]+)\/ack$/.exec(url.pathname))) {
				return send(200, await opts.service.acknowledge(principal, m[1]));
			}
			if (req.method === 'POST' && (m = /^\/v1\/monitors\/([\w-]+)\/run$/.exec(url.pathname))) {
				await opts.service.authorizeRun(principal, m[1]);
				const body = await readJson(req);
				const r = await opts.engine.runOnce(m[1], { content: typeof body.content === 'string' ? body.content : undefined });
				return send(200, { observation: r.observation, evaluation: r.evaluation, event: r.event ?? null });
			}
			return send(404, { error: 'not found' });
		} catch (e) {
			const err = e as Error & { status?: number };
			if (e instanceof AuthorizationError) return send(403, { error: err.message });
			if (/^Unknown /.test(err.message)) return send(404, { error: err.message });
			return send(err.status ?? 500, { error: err.status ? err.message : 'internal error' });
		}
	});
}
