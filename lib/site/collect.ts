/**
 * The site evidence collector. Runs IN THE PAGE (the extension injects it with chrome.scripting.executeScript,
 * world MAIN; the validation script uses page.evaluate), only when the user asks Signal to understand a site.
 * It must be self-contained: no imports, no closures over this module.
 *
 * What it can see (verified against the platform, not assumed):
 *  - Resource Timing: URL, initiator type, status, size of requests the page made. No bodies, no methods.
 *  - JSON-LD, <script type="application/json"> (incl. __NEXT_DATA__) and a few well-known state globals.
 *  - Response bodies only by RE-ISSUING a GET the page itself made, once, from the page context with the
 *    user's own session (and once without cookies, to learn whether the data depends on the session).
 * What it cannot see: POST bodies (so GraphQL queries are listed, not analyzed), WebSocket traffic, responses
 * to requests it does not repeat. It never invents endpoints, never follows links, never sends credentials
 * anywhere but the site itself, and skips paths the site's robots.txt disallows.
 */
export function collectSiteEvidence(opts: { maxFetches: number; snapshot: string | null; collector: string }): Promise<unknown> {
	const MAX_ITEMS = 50;
	const BODY_CAP = 3_000_000;
	const NOISE = /(google-analytics|googletagmanager|doubleclick|facebook\.(com|net)|segment\.(io|com)|hotjar|newrelic|nr-data|sentry|datadoghq|digitalgov\.gov|clarity\.ms|optimizely|amplitude|mixpanel|bing\.com|adservice|adsystem|scorecardresearch|quantserve|cloudflareinsights|arcgis\.com\/.*(tiles|basemap|VectorTileServer)|basemaps-api|\/collect\b|\/beacon\b|\/log\b|\/track)/i;
	const PREFIXES = ['{}&&', ")]}'", 'while(1);', 'for(;;);'];
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	const trim = (v: unknown, path: string, truncated: Record<string, number>, depth = 0): unknown => {
		if (depth > 12) return null;
		if (Array.isArray(v)) {
			if (v.length > MAX_ITEMS) truncated[path] = v.length;
			return v.slice(0, MAX_ITEMS).map((x, i) => trim(x, `${path}[${i}]`, truncated, depth + 1));
		}
		if (v && typeof v === 'object') {
			const o: Record<string, unknown> = {};
			let n = 0;
			for (const [k, x] of Object.entries(v as Record<string, unknown>)) { if (++n > 400) break; o[k] = trim(x, path ? `${path}.${k}` : k, truncated, depth + 1); }
			return o;
		}
		return typeof v === 'string' ? v.slice(0, 500) : v;
	};
	const largestArray = (v: unknown, d = 0): number => {
		if (d > 5) return 0;
		if (Array.isArray(v)) return Math.max(v.length, ...v.slice(0, 3).map((x) => largestArray(x, d + 1)));
		if (v && typeof v === 'object') return Math.max(0, ...Object.values(v as object).map((x) => largestArray(x, d + 1)));
		return 0;
	};
	const parse = (text: string): { json: unknown; prefix: string | null } | null => {
		let t = text.trimStart(), prefix: string | null = null;
		for (const p of PREFIXES) if (t.startsWith(p)) { prefix = p; t = t.slice(p.length); }
		if (!/^[[{]/.test(t)) return null;
		try { return { json: JSON.parse(t), prefix }; } catch { return null; }
	};
	// Minimal RFC 9309 matcher (same rules as lib/sources/robots.ts), so disallowed paths are never re-fetched.
	const robotsDisallows = (txt: string | null, path: string): boolean => {
		if (!txt) return false;
		const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> = [];
		let cur: (typeof groups)[number] | undefined, lastAgent = false;
		for (const line of txt.split(/\r?\n/)) {
			const m = /^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*(#.*)?$/.exec(line);
			if (!m) continue;
			const k = m[1].toLowerCase();
			if (k === 'user-agent') { if (!lastAgent || !cur) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(m[2].toLowerCase()); lastAgent = true; }
			else if ((k === 'allow' || k === 'disallow') && cur) { lastAgent = false; if (m[2]) cur.rules.push({ allow: k === 'allow', path: m[2] }); }
			else lastAgent = false;
		}
		const g = groups.find((x) => x.agents.some((a) => a !== '*' && 'signal'.includes(a))) ?? groups.find((x) => x.agents.includes('*'));
		if (!g) return false;
		let best = { allow: true, len: -1 };
		for (const r of g.rules) {
			const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
			if (re.test(path) && (r.path.length > best.len || (r.path.length === best.len && r.allow))) best = { allow: r.allow, len: r.path.length };
		}
		return !best.allow;
	};

	return (async () => {
		const origin = location.origin;
		let robots: { status: number; text: string | null } | null = null;
		try { const r = await fetch(`${origin}/robots.txt`, { credentials: 'omit', cache: 'no-store' }); robots = { status: r.status, text: r.ok ? (await r.text()).slice(0, 100_000) : null }; } catch { robots = null; }

		const jsonLd: unknown[] = [];
		document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => { try { jsonLd.push(trim(JSON.parse(s.textContent ?? ''), '', {})); } catch { /* invalid JSON-LD */ } });

		const embedded: Array<{ kind: string; name: string; json: unknown; truncated: Record<string, number> }> = [];
		document.querySelectorAll('script[type="application/json"]').forEach((s, i) => {
			const text = s.textContent ?? '';
			if (text.length < 200 || text.length > BODY_CAP) return;
			const p = parse(text); if (!p) return;
			const truncated: Record<string, number> = {};
			embedded.push({ kind: s.id === '__NEXT_DATA__' ? 'next_data' : 'json_script', name: s.id || (s as HTMLElement).dataset?.target || `script[${i}]`, json: trim(p.json, '', truncated), truncated });
		});
		const w = window as unknown as Record<string, unknown>;
		for (const name of ['__NUXT__', '__INITIAL_STATE__', '__PRELOADED_STATE__', '__APOLLO_STATE__', '__remixContext', '__APP_STATE__']) {
			try { const v = w[name]; if (v && typeof v === 'object') { const truncated: Record<string, number> = {}; embedded.push({ kind: name === '__NUXT__' ? 'nuxt' : 'global', name, json: trim(JSON.parse(JSON.stringify(v)), '', truncated), truncated }); } } catch { /* not serializable */ }
		}

		const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
		const resources = entries.filter((e) => ['fetch', 'xmlhttprequest', 'beacon', 'other'].includes(e.initiatorType)).slice(0, 300)
			.map((e) => ({ url: e.name, initiator: e.initiatorType, status: (e as unknown as { responseStatus?: number }).responseStatus ?? 0, bytes: e.encodedBodySize, durationMs: Math.round(e.duration) }));
		const graphql = [...new Set(resources.filter((r) => /graphql|gql\b/i.test(r.url)).map((r) => r.url.split('?')[0]))];

		const seen = new Set<string>();
		const candidates = resources.filter((r) => (r.initiator === 'fetch' || r.initiator === 'xmlhttprequest') && !NOISE.test(r.url) && !/graphql/i.test(r.url) && (r.status === 0 || r.status < 400))
			.filter((r) => { if (seen.has(r.url)) return false; seen.add(r.url); return true; })
			.sort((a, b) => Number(new URL(b.url).origin === origin) - Number(new URL(a.url).origin === origin) || b.bytes - a.bytes);
		const responses: unknown[] = [];
		let fetched = 0;
		for (const r of candidates) {
			const u = new URL(r.url);
			const sameOrigin = u.origin === origin;
			const base = { url: r.url, status: 0, contentType: null as string | null, etag: null as string | null, lastModified: null as string | null, cacheControl: null as string | null, json: null as unknown, prefix: null as string | null, truncated: {} as Record<string, number>, anonymous: null as null | { status: number; records: number | null }, records: null as number | null };
			if (sameOrigin && robotsDisallows(robots?.text ?? null, u.pathname + u.search)) { responses.push({ ...base, skipped: 'disallowed by the site\'s robots.txt: observed, not fetched' }); continue; }
			if (fetched >= opts.maxFetches) { responses.push({ ...base, skipped: 'not fetched: analysis request budget reached' }); continue; }
			fetched++;
			try {
				const res = await fetch(r.url, { credentials: sameOrigin ? 'include' : 'omit', cache: 'no-store' });
				const text = await res.text();
				base.status = res.status; base.contentType = res.headers.get('content-type'); base.etag = res.headers.get('etag'); base.lastModified = res.headers.get('last-modified'); base.cacheControl = res.headers.get('cache-control');
				const p = text.length <= BODY_CAP ? parse(text) : null;
				if (!p) { responses.push({ ...base, skipped: text.length > BODY_CAP ? 'response too large to analyze' : 'not JSON' }); continue; }
				base.records = largestArray(p.json); base.prefix = p.prefix; base.json = trim(p.json, '', base.truncated);
				if (sameOrigin) {
					try { const an = await fetch(r.url, { credentials: 'omit', cache: 'no-store' }); const at = await an.text(); const ap = parse(at); base.anonymous = { status: an.status, records: ap ? largestArray(ap.json) : null }; } catch { base.anonymous = null; }
				} else base.anonymous = { status: res.status, records: base.records }; // fetched without cookies already
				responses.push(base);
			} catch (e) { responses.push({ ...base, skipped: `not readable from the page: ${(e as Error).message.slice(0, 120)} (cross-origin without CORS?)` }); }
			await sleep(150);
		}

		const downloads = [...document.querySelectorAll('a[href]')].map((a) => (a as HTMLAnchorElement).href).filter((h) => /\.(csv|json|geojson|xml|xlsx|kml|zip)(\?|$)/i.test(h)).slice(0, 30).map((url) => ({ url, type: (/\.([a-z]+)(\?|$)/i.exec(url)?.[1] ?? '').toLowerCase() }));
		return {
			url: location.href, title: document.title, collectedAt: new Date().toISOString(), collector: opts.collector, robots, jsonLd, embedded, resources, responses, downloads,
			snapshot: opts.snapshot,
			observed: { webSocket: 'not_observable', eventSource: 'not_observable', graphql, serviceWorker: !!navigator.serviceWorker?.controller },
		};
	})();
}
