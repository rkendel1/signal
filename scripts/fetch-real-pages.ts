/**
 * Fetch the real-world evaluation pages through Signal's own HttpSource
 * (robots.txt, SSRF guard, byte cap, conditional GET) and record provenance.
 *   node scripts/fetch-real-pages.ts            # fetch all in tests/fixtures/real/manifest.json
 * Re-fetching yields today's page; the committed snapshots are the reproducible fixtures.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { HttpSource, USER_AGENT } from '../lib/sources/sources.ts';
import { safeUrl } from '../lib/page/values.ts';

const dir = new URL('../tests/fixtures/real/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8')) as { pages: Array<{ id: string; url: string; category: string; terms: string }> };
const http = new HttpSource('http_page', {});
const only = process.argv.slice(2);
for (const p of manifest.pages.filter((x) => !only.length || only.includes(x.id))) {
	const r = await http.observe({ source: { schema: 'signal.source/v1', id: p.id, tenantId: 'eval', ownerId: 'eval', type: 'http_page', locator: p.url, access: { authorization: 'public' }, observation: { strategy: 'poll' }, createdAt: '' }, requestedAt: new Date().toISOString() });
	const o = r.observation;
	const prov = { id: p.id, split: (p as { split?: string }).split ?? 'tuning', url: safeUrl(p.url, null), category: p.category, terms: p.terms, fetchedAt: o.observedAt, method: o.provenance.adapter, userAgent: USER_AGENT, robots: o.provenance.robots, httpStatus: o.provenance.httpStatus, finalUrl: o.provenance.finalUrl ? safeUrl(o.provenance.finalUrl, null) : null, contentType: o.contentType, byteLength: o.byteLength, sha256: o.contentHash, status: o.status, error: o.error ?? null, sanitized: false };
	if (o.status === 'ok' && r.body) writeFileSync(new URL(`${p.id}.html`, dir), r.body);
	writeFileSync(new URL(`${p.id}.provenance.json`, dir), JSON.stringify(prov, null, 2) + '\n');
	console.log(o.status, o.provenance.robots, o.provenance.httpStatus, o.byteLength, p.id);
	await new Promise((res) => setTimeout(res, 1500)); // polite spacing between requests
}
