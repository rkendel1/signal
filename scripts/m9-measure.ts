/**
 * M9 measurement harness: how well does Signal's existing parcel-dataset augmentation hold up on REAL inputs?
 * It runs the same library code the server and the extension use (no thresholds or matching rules are changed or
 * parameterised here) and reports what it measures. It does not fetch anything: parcel files and page snapshots
 * are files you give it.
 *
 *   node scripts/m9-measure.ts --parcels FILE [--mapping FILE] \
 *        --page SNAPSHOT.html::https://site.example/the/page/url  (repeat per page) \
 *        [--types RealEstateListing,House] [--labels labels.json] [--review-sheet out.csv] [--repeat 5] [--out report.json]
 *
 *  - --mapping: an approved mapping (the "mapping" object from the review). Without it the PROPOSED mapping is
 *    measured, which says so in the report: a real run should use the mapping the person approved in the panel.
 *  - --page: a snapshot saved with the panel's "Download what Signal read", plus the address it was read from.
 *  - --review-sheet: writes a CSV of the listings Signal extracted, with ONLY what the page says about them, for a
 *    person to look up independently. It deliberately contains no Signal result, so labels are not anchored by it.
 *  - --labels: [{ "listing": "<url or street address>", "expected": {"parcelId":"…"} | "none" | "indistinguishable" }]
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { extractPage } from '../lib/page/extract.ts';
import { discover, extractContext, facets, type DiscoveryIntent } from '../lib/discovery/discover.ts';
import { applyMapping, inspectDataset, parseDataset, type DatasetMapping } from '../lib/datasets/dataset.ts';
import { ADDRESS_CORROBORATION_M, COORD_MATCH_M, candidateIdentities, discoverAugmented, resolveCandidates, type DatasetSource } from '../lib/datasets/resolve.ts';
import { confusion, inputProfile, judge, pinDistances, quantiles, resolutionTally, type Label } from '../lib/validation/measure.ts';

// The limits the panel and the instance enforce today (extension/src/datasets.ts, feltkit/_shared.ts). Recorded, not changed.
const REQUEST_TEXT_LIMIT = 1_800_000, STORED_LIMIT = 1_048_576;

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const all = (name: string) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
const need = (v: string | undefined, what: string) => { if (!v) { console.error(`missing ${what}`); process.exit(2); } return v; };

const ms = (t0: number) => Math.round((performance.now() - t0) * 10) / 10;
const mb = (n: number) => Math.round((n / 1048576) * 100) / 100;
const git = (c: string) => { try { return execSync(c, { encoding: 'utf8', cwd: new URL('../', import.meta.url).pathname }).trim(); } catch { return null; } };

const parcelsPath = need(opt('parcels'), '--parcels FILE');
const repeat = Number(opt('repeat') ?? 5);
const report: Record<string, unknown> = {
	measuredAt: new Date().toISOString(),
	environment: { node: process.version, platform: `${process.platform} ${process.arch}`, commit: git('git rev-parse --short HEAD'), workingTreeDirty: (git('git status --short') ?? '').length > 0 },
	rules: { COORD_MATCH_M, ADDRESS_CORROBORATION_M, note: 'defaults, unchanged by this harness' }
};

// ---- the parcel file
const raw = readFileSync(parcelsPath);
const text = raw.toString('utf8');
const format = /\.(geo)?json$/i.test(parcelsPath) ? 'geojson' : 'csv';
const gz = gzipSync(raw).byteLength;
const heap0 = process.memoryUsage();
let t = performance.now();
const parsed = parseDataset(text, format);
const parseMs = ms(t);
t = performance.now();
const inspection = inspectDataset(parsed);
const inspectMs = ms(t);
const mappingFile = opt('mapping');
const mapping: DatasetMapping = mappingFile ? JSON.parse(readFileSync(mappingFile, 'utf8')) : inspection.proposed;
t = performance.now();
const mapped = applyMapping(parsed, mapping);
const mapMs = ms(t);
const heap1 = process.memoryUsage();
report.parcelFile = {
	path: parcelsPath, format, bytes: raw.byteLength, megabytes: mb(raw.byteLength), gzipBytes: gz, gzipMegabytes: mb(gz),
	fits: { requestTextLimit: raw.byteLength <= REQUEST_TEXT_LIMIT, storedLimit: gz <= STORED_LIMIT, limits: { REQUEST_TEXT_LIMIT, STORED_LIMIT } },
	records: parsed.rows.length, withGeometry: inspection.withGeometry, columns: parsed.fields.length,
	timingsMs: { parse: parseMs, inspect: inspectMs, applyMapping: mapMs },
	heapDeltaMB: mb(heap1.heapUsed - heap0.heapUsed), rssAfterMB: mb(heap1.rss)
};
report.mapping = {
	source: mappingFile ? `approved mapping file ${mappingFile}` : 'PROPOSED mapping (not an approved one)',
	proposedAttributes: inspection.proposals.map((p) => `${p.source} → ${p.attribute}${p.role ? ` [${p.role}]` : ''}`),
	roles: { id: !!mapping.fields.find((f) => f.role === 'id'), address: !!mapping.fields.find((f) => f.role === 'address'), latitude: !!mapping.fields.find((f) => f.role === 'latitude'), longitude: !!mapping.fields.find((f) => f.role === 'longitude') },
	mappedColumns: mapping.fields.length, unmappedColumns: mapped.unmapped,
	proposalCoverage: `${inspection.proposals.length} of ${parsed.fields.length} columns proposed`,
	invalidValues: mapped.issues.length, firstInvalid: mapped.issues.slice(0, 20).map((i) => ({ row: i.row + 1, field: i.field, problem: i.problem, raw: i.raw }))
};
const ds: DatasetSource = { id: 'm9-parcels', name: 'parcels', versionId: 'm9', mappingVersion: mapping.version, freshness: 'static', dataAsOf: null, retrievedAt: new Date().toISOString(), records: mapped.records };

// ---- listing snapshots
const pageArgs = all('page');
if (pageArgs.length) {
	const pages = pageArgs.map((a, i) => {
		const [file, base] = a.split('::');
		if (!file || !base) { console.error('--page needs SNAPSHOT.html::https://the.page/url'); process.exit(2); }
		const t0 = performance.now();
		const p = extractPage({ html: readFileSync(file, 'utf8'), locator: base, baseUrl: base, observationId: `m9-${i}`, contentHash: `m9-${i}`, contentType: 'text/html', observedAt: new Date().toISOString() });
		return { file, base, page: p, extractMs: ms(t0) };
	});
	const ps = pages.map((x) => x.page);
	const types = (opt('types') ?? 'RealEstateListing,SingleFamilyResidence,Residence,House,Apartment').split(',');
	const intent: DiscoveryIntent = { schema: 'signal.intent/v1', id: 'm9', version: 1, name: 'm9', target: { type: types }, criteria: [] };
	report.pages = pages.map((x) => {
		const c = extractContext(x.page);
		const f = facets([x.page]);
		return {
			file: x.file, url: x.base, extractMs: x.extractMs, entities: x.page.entities.length, truncated: x.page.stats.truncated,
			entityTypes: f.types.map((y) => ({ type: y.type, candidates: y.candidates, inCollections: y.inCollections })),
			declaredTotal: c.declaredTotal.value, shown: c.shown.value, viewportMarkers: c.viewportMarkers.value, nextPage: c.nextPage.value ? 'present' : null
		};
	});
	report.targetTypes = types;

	const idents = candidateIdentities({ intent, pages: ps });
	report.inputs = inputProfile(idents, mapped.records);

	// first resolution, then repeats (each call rebuilds the lookup index, as the server does on every evaluate)
	t = performance.now();
	const resolutions = resolveCandidates(idents, ds);
	const firstMs = ms(t);
	const rep: number[] = [];
	for (let i = 0; i < repeat; i++) { const t1 = performance.now(); resolveCandidates(idents, ds); rep.push(ms(t1)); }
	report.resolution = { ...resolutionTally(resolutions), pinDistanceM: quantiles(pinDistances(idents, resolutions, mapped.records)), timingsMs: { first: firstMs, repeated: rep } };

	// what one evaluation costs on the server today: read + parse + map the dataset again, then resolve and evaluate
	const evalRuns: number[] = [];
	for (let i = 0; i < Math.max(1, repeat); i++) {
		const t1 = performance.now();
		const d = applyMapping(parseDataset(text, format), mapping);
		discoverAugmented({ intent, pages: ps, datasets: [{ ...ds, records: d.records }] });
		evalRuns.push(ms(t1));
	}
	const base: number[] = [];
	for (let i = 0; i < Math.max(1, repeat); i++) { const t1 = performance.now(); discover({ intent, pages: ps }); base.push(ms(t1)); }
	const withNone = discoverAugmented({ intent, pages: ps, datasets: [] }).result.resultDigest === discover({ intent, pages: ps }).resultDigest;
	report.evaluation = { perEvaluateIncludingReparseMs: evalRuns, discoveryWithoutDatasetMs: base, reparsesAndReindexesEveryEvaluation: true, noDatasetResultUnchanged: withNone };

	if (opt('review-sheet')) {
		const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
		const rows = ['listing_key,address_on_page,latitude,longitude,parcel_id_on_page,expected_parcel_id_or_none_or_indistinguishable,notes'];
		for (const c of idents) rows.push([c.key, c.address, c.lat, c.lng, c.parcelId, '', ''].map(q).join(','));
		writeFileSync(opt('review-sheet')!, rows.join('\n') + '\n');
		report.reviewSheet = { path: opt('review-sheet'), rows: idents.length, containsSignalResult: false };
	}

	if (opt('labels')) {
		const labels = JSON.parse(readFileSync(opt('labels')!, 'utf8')) as Label[];
		const judged = judge(labels, idents, resolutions, mapped.records);
		report.accuracy = { labelsFile: opt('labels'), ...confusion(judged), listings: judged };
	}
}
report.peakRssMB = mb(process.resourceUsage().maxRSS * 1024); // Node reports kilobytes on every platform

const out = opt('out');
if (out) writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
