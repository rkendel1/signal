/**
 * Real-site validation: REAL pages, REAL feeds, a real FeltDB instance. Writes docs/site-validation.json.
 *
 *   node scripts/validate-real-sites.ts [monitorMinutes=6]
 *
 * Sites: USGS Earthquake Hazards (public domain, published for programmatic use, no robots.txt) and Hacker News
 * (a server-rendered page, for contrast). Real-estate sites are not used: their robots.txt disallows the listing
 * APIs to automated agents (Zillow: /graphql/, /api/, /async-create-search-page-state; Redfin: /stingray), and
 * Redfin answered this environment with HTTP 429. See SITE_INTELLIGENCE.md.
 */
process.env.SIGNAL_ALLOW_PRIVATE_HOSTS ??= '';
import { readFileSync, writeFileSync } from 'node:fs';
import { createTestApp } from '@feltdb/feltkit/testing';
import { api } from '../feltkit/_generated/api.ts';
import { collect } from './collect-evidence.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const minutes = Number(process.argv[2] ?? 6);
const out: Any = { generatedAt: new Date().toISOString(), real: true, environment: `${process.platform}/${process.arch} node ${process.version}`, pages: [], feeds: {}, criteria: {}, monitoring: [], secondUser: {}, notes: [] };
const t = async <T>(f: () => Promise<T>): Promise<[T, number]> => { const t0 = performance.now(); const r = await f(); return [r, Math.round(performance.now() - t0)]; };
const brief = (c: Any) => ({ label: c.label, kind: c.kind, verdict: c.verdict, score: c.score, records: c.recordCount, declaredTotal: c.declaredTotal, identifier: c.identifier?.path ?? null, pathTemplate: c.endpoint ? `${c.endpoint.origin}${c.endpoint.pathTemplate}` : null, change: c.change, access: c.access, completeness: c.completeness, pagination: c.pagination.kind, relations: c.relations, catalog: c.contribution?.status ?? c.contribution?.reason ?? null, why: c.why, limitations: c.limitations });

const app = await createTestApp();
const ada = app.as('ada'), bob = app.as('bob');
try {
	// ------------------------------------------------------------------ analyze real pages
	const pages: Array<{ name: string; url: string; snapshot?: boolean }> = [
		{ name: 'USGS latest earthquakes map', url: 'https://earthquake.usgs.gov/earthquakes/map/' },
		{ name: 'USGS earthquake search', url: 'https://earthquake.usgs.gov/earthquakes/search/' },
		{ name: 'Hacker News front page', url: 'https://news.ycombinator.com/', snapshot: true },
	];
	let summaryFeed: Any = null;
	for (const p of pages) {
		const c = await collect(p.url, { snapshot: p.snapshot });
		const [an, ms] = await t(() => ada.mutation(api.sites.analyze, { evidence: JSON.stringify(c.evidence) }) as Promise<Any>);
		out.pages.push({ name: p.name, url: p.url, loadMs: c.loadMs, collectMs: c.collectMs, analyzeMs: ms, analyzerMs: an.durationMs, requestsSeen: (c.evidence as Any).resources.length, responsesAnalyzed: (c.evidence as Any).responses.filter((r: Any) => !r.skipped).length, surface: an.surface, candidates: an.candidates.map(brief) });
		const feed = an.candidates.find((x: Any) => x.verdict === 'feed' && x.endpoint?.pathTemplate.includes('/summary/'));
		if (feed) summaryFeed = { ...feed, eventUrl: (c.evidence as Any).responses.find((r: Any) => r.url.includes('/summary/'))?.json?.features?.[0]?.properties?.url };
		console.error(`analyzed ${p.name}: ${an.candidates.length} candidates in ${ms} ms`);
	}
	// the event page of a real event: the detail endpoint
	if (summaryFeed?.eventUrl) {
		const c = await collect(summaryFeed.eventUrl);
		const [an, ms] = await t(() => ada.mutation(api.sites.analyze, { evidence: JSON.stringify(c.evidence) }) as Promise<Any>);
		out.pages.push({ name: 'USGS event page', url: summaryFeed.eventUrl, loadMs: c.loadMs, collectMs: c.collectMs, analyzeMs: ms, analyzerMs: an.durationMs, requestsSeen: (c.evidence as Any).resources.length, responsesAnalyzed: (c.evidence as Any).responses.filter((r: Any) => !r.skipped).length, surface: an.surface, candidates: an.candidates.map(brief) });
	}

	// ------------------------------------------------------------------ connect the real feeds with server acquisition
	const feedId = summaryFeed.contribution.feedId;
	const conn = (await ada.mutation(api.sites.connect, { feedId, entityType: 'earthquake' })) as Any;
	const [first, firstMs] = await t(() => ada.action(api.sources.refresh, { sourceId: conn.sourceId }) as Promise<Any>);
	out.feeds.summary = { feedId, acquisition: conn.acquisition, intervalMinutes: conn.intervalMinutes, firstAcquisitionMs: firstMs, records: first.added, verification: first.verification, status: ((await ada.query(api.sites.recognize, { url: 'https://earthquake.usgs.gov/earthquakes/map/' })) as Any).feeds.find((f: Any) => f.id === feedId)?.status };
	const det = (await ada.query(api.sites.recognize, { url: summaryFeed.eventUrl })) as Any;
	const detailFeed = det.feeds.find((f: Any) => f.verdict === 'detail');
	if (detailFeed) {
		const detailUrl = (((await ada.query(api.sources.get, { sourceId: conn.sourceId })) as Any).records ?? []).length ? null : null;
		void detailUrl;
		const evId = summaryFeed.eventUrl.split('/').pop();
		const dconn = (await ada.mutation(api.sites.connect, { feedId: detailFeed.id, entityType: 'earthquake', url: `https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/${evId}.geojson` })) as Any;
		const [d1, dms] = await t(() => ada.action(api.sources.refresh, { sourceId: dconn.sourceId }) as Promise<Any>);
		const dsrc = (await ada.query(api.sources.get, { sourceId: dconn.sourceId })) as Any;
		const ent = dsrc.records[0]?.link?.entityId ? (await ada.query(api.entities.get, { entityId: dsrc.records[0].link.entityId })) as Any : null;
		out.feeds.detail = { feedId: detailFeed.id, eventId: evId, acquisitionMs: dms, records: d1.added, verification: d1.verification, identity: dsrc.records[0]?.link ?? null, entitySources: ent?.records.map((r: Any) => `${r.source.name} (${r.link.status}: ${r.link.basis})`) ?? [] };
	}

	// ------------------------------------------------------------------ criteria over real observations, incl. the real Rhode Island boundary
	const ri = readFileSync(new URL('../rhode island.geojson', import.meta.url), 'utf8');
	const regions = await ada.mutation(api.sources.create, { name: 'US state boundary: Rhode Island (repository file)', kind: 'file', entityType: 'region', config: JSON.stringify({ format: 'geojson' }), content: ri, mapping: JSON.stringify({ version: 1, entityType: 'region', fields: [{ source: 'abbreviation', attribute: 'abbreviation', type: 'text', role: 'key' }, { source: 'name', attribute: 'name', type: 'text', role: 'name' }, { source: 'population', attribute: 'population', type: 'number' }] }) }) as string;
	const defs = {
		strong: { name: 'Magnitude 4.5+', entityType: 'earthquake', severity: 'warning', require: [{ attr: 'mag', op: 'gte', value: 4.5 }], changeThresholds: { mag: { abs: 0.1 } }, notifyOn: ['new', 'changed', 'resolved', 'reopened'] },
		nearRI: { name: 'Within 1,500 km of Rhode Island', entityType: 'earthquake', severity: 'info', require: [{ attr: '@location', op: 'within', value: { sourceId: regions, recordKey: 'RI', bufferKm: 1500 } }] },
		inRI: { name: 'Inside Rhode Island', entityType: 'earthquake', severity: 'critical', require: [{ attr: '@location', op: 'within', value: { sourceId: regions, recordKey: 'RI' } }] },
	};
	for (const [k, d] of Object.entries(defs)) {
		const [r, ms] = await t(() => ada.mutation(api.criteria.save, { definition: JSON.stringify(d) }) as Promise<Any>);
		out.criteria[k] = { name: d.name, evaluateMs: ms, entities: r.run.entities, findings: r.run.created };
	}
	const nearest = ((await ada.query(api.findings.list, {})) as Any[]).slice(0, 5).map((f) => ({ entity: f.entityLabel, criteria: f.criteriaName, summary: f.summary }));
	out.criteria.sample = nearest;

	// ------------------------------------------------------------------ monitor the live feed
	const end = Date.now() + minutes * 60_000;
	while (Date.now() < end) {
		await new Promise((r) => setTimeout(r, 60_000));
		const [r, ms] = await t(() => ada.action(api.sources.refresh, { sourceId: conn.sourceId }) as Promise<Any>);
		const notices = ((await ada.query(api.notices.list, {})) as Any[]).length;
		out.monitoring.push({ at: new Date().toISOString(), ms, status: r.status, added: r.added ?? 0, changed: r.changed ?? 0, retracted: r.retracted ?? 0, run: r.run ? { created: r.run.created, changed: r.run.changed, closed: r.run.closed } : null, notices });
		console.error(`poll: ${r.status} +${r.added ?? 0} ~${r.changed ?? 0} -${r.retracted ?? 0} (${ms} ms)`);
	}

	// ------------------------------------------------------------------ a second user reuses the shared definition
	const rec = (await bob.query(api.sites.recognize, { url: 'https://earthquake.usgs.gov/earthquakes/map/' })) as Any;
	const bconn = (await bob.mutation(api.sites.connect, { feedId, entityType: 'earthquake' })) as Any;
	const br = (await bob.action(api.sources.refresh, { sourceId: bconn.sourceId })) as Any;
	const shared = JSON.stringify(((await bob.query(api.sites.site, { siteId: rec.siteId })) as Any).feeds.map((f: Any) => f.definition));
	out.secondUser = { recognized: rec.known, feedsKnown: rec.feeds.length, connectedWithOwnAccess: bconn.acquisition, ownRecords: br.added, adaAnalysesVisible: ((await bob.query(api.sites.site, { siteId: rec.siteId })) as Any).myAnalyses.length, catalogContainsTokenValue: /token=[A-Za-z0-9]/.test(shared) || /AAPT/.test(shared), catalogBytes: shared.length };
	out.catalog = ((await bob.query(api.sites.catalog, {})) as Any[]);
	out.notices = ((await ada.query(api.notices.list, {})) as Any[]).map((n) => ({ kind: n.kind, severity: n.severity, title: n.title }));
} finally {
	await app.close();
}
writeFileSync(new URL('../docs/site-validation.json', import.meta.url), JSON.stringify(out, null, 2));
console.error('wrote docs/site-validation.json');
