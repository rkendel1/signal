/**
 * The site analyzer and the shareable definition, on REAL evidence collected from public USGS pages
 * (tests/fixtures/sites/PROVENANCE.md) plus small synthetic cases for what those pages do not show.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeSite, classifyParam, pathTemplate } from '../../lib/site/analyze.ts';
import { assertShareable, conformance, mappingFor, matchesDefinition, privateStrings, toDefinition } from '../../lib/site/definition.ts';
import type { SiteEvidence } from '../../lib/site/types.ts';
import { parseRecords } from '../../lib/sources/records.ts';
import { applyMapping } from '../../lib/engine/mapping.ts';

const real = (f: string): SiteEvidence => JSON.parse(readFileSync(new URL(`../fixtures/sites/${f}.json`, import.meta.url), 'utf8'));
const map = real('usgs-map');

test('real USGS map page: the earthquake feed is found, ranked first, and understood', () => {
	const a = analyzeSite(map);
	const top = a.candidates[0];
	assert.equal(top.verdict, 'feed');
	assert.equal(top.kind, 'geojson_endpoint');
	assert.equal(top.endpoint!.pathTemplate, '/earthquakes/feed/v1.0/summary/2.5_day.geojson');
	assert.deepEqual(top.identifier, { path: 'id', basis: 'GeoJSON feature id' });
	assert.equal(top.change.conditional, 'last-modified');
	assert.equal(top.change.recordUpdatedField, 'updated');
	assert.equal(top.access.auth, 'public', 'the same request without cookies returns the same records');
	assert.equal(top.access.robots, 'allowed', 'no robots.txt (404): no restrictions');
	assert.equal(top.completeness, 'complete');
	assert.ok(top.relations.some((r) => r.kind === 'detail_link' && r.targetTemplate.endsWith('/earthquakes/feed/v1.0/detail/{id}.geojson')));
	assert.ok(['mag', 'place', 'time', 'updated', 'url', 'status', 'sig'].every((f) => top.fields.some((x) => x.path === f)));
	assert.equal(top.change.live, null, 'push channels are not observable; nothing claims one');
	assert.ok(a.candidates.some((c) => c.verdict === 'metadata'), 'map styling and colour ramps are recognised as not being entities');
});

test('real USGS event page: the detail endpoint is one record with the feed\'s identifier', () => {
	const a = analyzeSite(real('usgs-event'));
	const d = a.candidates.find((c) => c.verdict === 'detail')!;
	assert.equal(d.endpoint!.pathTemplate, '/earthquakes/feed/v1.0/detail/{id}.geojson', 'the event id in the path is templated');
	assert.equal(d.identifier!.path, 'id');
	assert.equal(d.recordsPath, '');
	assert.equal(d.change.recordUpdatedField, 'updated');
});

test('real USGS search page: a JSON response that is not records is not called a feed', () => {
	const a = analyzeSite(real('usgs-search'));
	assert.ok(a.candidates.length >= 1);
	assert.ok(a.candidates.every((c) => c.verdict !== 'feed'), JSON.stringify(a.candidates.map((c) => [c.label, c.verdict])));
});

test('shared definitions carry structure only: no values, no parameter values, no token', () => {
	for (const f of ['usgs-map', 'usgs-event', 'usgs-search']) {
		const ev = real(f);
		const a = analyzeSite(ev);
		const priv = privateStrings(ev);
		for (const c of a.candidates) {
			const def = toDefinition(c, a);
			assertShareable(def, priv);
			const text = JSON.stringify(def);
			assert.doesNotMatch(text, /REDACTEDfixtureTOKEN/, `${c.label}: the token value never appears`);
			assert.ok(!('samples' in (def.fields[0] ?? {})), 'no samples');
			assert.ok(def.endpoint === null || def.endpoint.params.every((p) => !('value' in p)), 'no parameter values');
		}
	}
	const styles = analyzeSite(map).candidates.find((c) => c.endpoint?.params.some((p) => p.name === 'token'))!;
	assert.equal(styles.endpoint!.params.find((p) => p.name === 'token')!.sensitive, true);
	assert.equal(styles.access.auth, 'session', 'a credential in the request means each user needs their own');
	// The check is independent of how the definition was built: a value smuggled in is caught.
	const a = analyzeSite(map);
	const def = toDefinition(a.candidates[0], a);
	const place = String(map.responses[0].json && (map.responses[0].json as { features: Array<{ properties: { place: string } }> }).features[0].properties.place);
	assert.throws(() => assertShareable({ ...def, label: place }, privateStrings(map)), /observed in the user's data/);
	assert.throws(() => assertShareable({ ...def, pages: ['/a/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0'] }, privateStrings(map)), /secret/);
});

test('a user\'s URL must instantiate the definition; the mapping and conformance work on the real feed', () => {
	const a = analyzeSite(map);
	const def = toDefinition(a.candidates[0], a);
	assert.equal(matchesDefinition(def, 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson').ok, true);
	assert.equal(matchesDefinition(def, 'https://evil.example/earthquakes/feed/v1.0/summary/2.5_day.geojson').ok, false);
	assert.equal(matchesDefinition(def, 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson?x=1').ok, false);
	const m = mappingFor(def, 'earthquake');
	assert.deepEqual(m.fields.find((f) => f.role === 'key'), { source: 'id', attribute: 'id', type: 'text', role: 'key' });
	const body = JSON.stringify(map.responses[0].json);
	const parsed = parseRecords(body, 'geojson');
	const mapped = applyMapping(parsed, m);
	assert.equal(mapped.drafts.length, 44);
	assert.equal(mapped.drafts[0].recordKey, (map.responses[0].json as { features: Array<{ id: string }> }).features[0].id, 'the feature id is the record key');
	assert.ok(typeof mapped.drafts[0].attributes.mag.value === 'number');
	assert.ok(mapped.drafts[0].identity.lat !== null, 'GeoJSON geometry gives the location');
	const c = conformance(def, parsed.rows.map((r) => r.props));
	assert.equal(c.ok, true, JSON.stringify(c));
	const broken = conformance(def, parsed.rows.map((r) => ({ id: r.props.id })));
	assert.equal(broken.ok, false, 'a feed that lost its fields fails verification');
});

test('synthetic cases: embedded state, session-bound responses, robots disallow, URL templating', () => {
	assert.equal(pathTemplate('/homes/for_sale/123456_zpid/'), '/homes/for_sale/{segment}/');
	assert.equal(pathTemplate('/api/v2/listing/9f8e7d6c5b4a39281706f5e4d3c2b1a0.json'), '/api/v2/listing/{id}.json');
	assert.equal(classifyParam('access_token', 'x').role, 'credential');
	assert.equal(classifyParam('page', '2').role, 'page');
	assert.equal(classifyParam('north', '41.9').role, 'bbox');
	const listings = Array.from({ length: 30 }, (_, i) => ({ listingId: `L${i}`, address: `${i} Main St`, price: 300000 + i, updatedAt: '2026-11-01T00:00:00Z', latitude: 41 + i / 1000, longitude: -71 }));
	const ev: SiteEvidence = {
		url: 'https://homes.example/search?city=x', title: 't', collectedAt: '2026-11-17T00:00:00Z', collector: 'test',
		robots: { status: 200, text: 'User-agent: *\nDisallow: /private-api/\n' },
		jsonLd: [], embedded: [{ kind: 'next_data', name: '__NEXT_DATA__', json: { props: { pageProps: { results: listings.slice(0, 10) } } }, truncated: {} }],
		resources: [], downloads: [], snapshot: null, observed: { webSocket: 'not_observable', eventSource: 'not_observable', graphql: [], serviceWorker: false },
		responses: [
			{ url: 'https://homes.example/api/search?page=1&north=42&south=41', status: 200, contentType: 'application/json', etag: '"a"', lastModified: null, cacheControl: null, json: { total: 120, results: listings }, prefix: null, truncated: {}, anonymous: { status: 401, records: null }, records: 30 },
			{ url: 'https://homes.example/private-api/saved', status: 0, contentType: null, etag: null, lastModified: null, cacheControl: null, json: null, prefix: null, truncated: {}, anonymous: null, records: null, skipped: 'disallowed by the site\'s robots.txt: observed, not fetched' },
		],
	};
	const a = analyzeSite(ev);
	const api = a.candidates.find((c) => c.kind === 'json_endpoint')!;
	assert.equal(api.verdict, 'feed');
	assert.equal(api.access.auth, 'session', 'anonymous request refused: this feed depends on the user\'s session');
	assert.equal(api.pagination.kind, 'page');
	assert.equal(api.completeness, 'partial', '30 of 120 declared');
	assert.deepEqual(api.filters.map((f) => f.kind), ['bbox', 'bbox']);
	assert.equal(api.identifier!.path, 'listingId');
	const emb = a.candidates.find((c) => c.kind === 'embedded_state')!;
	assert.equal(emb.verdict, 'feed');
	assert.ok(emb.duplicates.includes(api.key) && api.duplicates.includes(emb.key), 'the embedded state and the API describe the same records');
	assert.ok(!a.candidates.some((c) => c.endpoint?.pathTemplate.startsWith('/private-api')), 'a disallowed path was never fetched, so it is never a candidate');
});
