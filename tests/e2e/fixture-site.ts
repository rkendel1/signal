/**
 * A SYNTHETIC listing site for the ambient end-to-end test ("Example Homes", invented addresses).
 *
 * It is built to reproduce the structural traits that matter, not any real site:
 *  - a single-page app: the search page renders listings it fetches from a JSON API, and listing links navigate
 *    with history.pushState (no page load);
 *  - the API depends on the visitor's own session (a cookie set by the site): without it, 401;
 *  - the API supports ETag conditional requests and declares pagination (page, total);
 *  - a "Redraw" control rebuilds the page, as frameworks do, and a script removes foreign elements.
 * The test changes listings through `update()`; nothing here is presented as real-site behaviour.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';

export interface Listing { listingId: string; address: string; price: number; beds: number; status: string; latitude: number; longitude: number; updatedAt: string }

export async function exampleHomes() {
	let listings: Listing[] = Array.from({ length: 12 }, (_, i) => ({
		listingId: `EH-${100 + i}`, address: `${10 + i * 2} Sample Way, Exampleton`, price: 420_000 + i * 15_000, beds: 2 + (i % 3), status: 'active',
		latitude: 41.7 + i * 0.002, longitude: -71.4 - i * 0.002, updatedAt: '2026-11-01T00:00:00Z',
	}));
	const requests: Array<{ path: string; cookie: boolean; at: number; conditional: boolean }> = [];
	const body = () => JSON.stringify({ page: 1, total: listings.length, results: listings.map((l) => ({ ...l, url: `${origin}/homes/${l.listingId}` })) });
	const etag = () => `"${createHash('sha256').update(body()).digest('hex').slice(0, 16)}"`;
	let origin = '';
	const shell = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Example Homes (synthetic)</title></head><body>
<header><a href="/search" data-nav>Example Homes</a> <button id="redraw">Redraw</button> <button id="hostile">Remove foreign elements</button></header><main id="app">Loading…</main>
<script>
const app = () => document.getElementById('app');
async function search() {
	const r = await fetch('/api/listings?page=1&north=41.8&south=41.6', { credentials: 'include' });
	const d = await r.json();
	app().innerHTML = '<h1>' + d.total + ' homes</h1><ul>' + d.results.map((l) => '<li class="card"><a href="/homes/' + l.listingId + '" data-nav>' + l.address + '</a> <b>$' + l.price.toLocaleString() + '</b> ' + l.beds + ' bd</li>').join('') + '</ul>';
}
async function detail(id) {
	const r = await fetch('/api/listings?page=1&north=41.8&south=41.6', { credentials: 'include' });
	const l = (await r.json()).results.find((x) => x.listingId === id);
	app().innerHTML = l ? '<h1>' + l.address + '</h1><p>$' + l.price.toLocaleString() + ' · ' + l.beds + ' bd</p><a href="/search" data-nav>Back</a>' : 'Not found';
}
function route() { const m = location.pathname.match(/^\\/homes\\/(.+)$/); return m ? detail(m[1]) : search(); }
document.addEventListener('click', (e) => { const a = e.target.closest('a[data-nav]'); if (!a) return; e.preventDefault(); history.pushState(null, '', a.getAttribute('href')); route(); });
addEventListener('popstate', route);
document.getElementById('redraw').onclick = () => { const b = document.createElement('body'); b.innerHTML = document.body.innerHTML; document.documentElement.replaceChild(b, document.body); document.querySelectorAll('#redraw').forEach((x) => x.onclick = null); route(); };
document.getElementById('hostile').onclick = () => document.querySelectorAll('html > :not(head):not(body)').forEach((x) => x.remove());
route();
</script></body></html>`;
	const server: Server = createServer((req, res) => {
		const url = new URL(req.url!, origin);
		const cookie = /(^|;\s*)sid=session-of-this-visitor\b/.test(req.headers.cookie ?? '');
		requests.push({ path: url.pathname + url.search, cookie, at: Date.now(), conditional: !!req.headers['if-none-match'] });
		if (url.pathname === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('User-agent: *\nDisallow: /account/\n'); return; }
		if (url.pathname === '/api/listings') {
			if (!cookie) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"sign in"}'); return; }
			const tag = etag();
			if (req.headers['if-none-match'] === tag) { res.writeHead(304, { etag: tag }); res.end(); return; }
			res.writeHead(200, { 'content-type': 'application/json', etag: tag, 'cache-control': 'private, max-age=60' });
			res.end(body());
			return;
		}
		if (url.pathname === '/search' || url.pathname.startsWith('/homes/') || url.pathname === '/') {
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'sid=session-of-this-visitor; Path=/; HttpOnly; SameSite=Lax' });
			res.end(shell);
			return;
		}
		res.writeHead(404); res.end('not found');
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		origin, requests,
		update(f: (l: Listing[]) => Listing[]) { listings = f(listings); },
		listings: () => listings,
		close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
	};
}
