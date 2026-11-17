/**
 * SYNTHETIC scaling workload for the parcel path (not real data). Generates N parcel rows with ~12 columns of
 * realistic width, then times what one evaluation does today: parse + map + build the lookup index + resolve
 * a fixed set of listings. It exists so the real-county measurement has a reproducible reference curve, and so
 * "re-parsed on every evaluate" has a measured cost. It says nothing about match accuracy.
 *
 *   node scripts/m9-scale.ts [N ...]        default: 1000 5000 20000 50000 100000 200000
 */
import { gzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { applyMapping, inspectDataset, parseCsv } from '../lib/datasets/dataset.ts';
import { resolveCandidates, type CandidateIdentity } from '../lib/datasets/resolve.ts';

const ns = process.argv.slice(2).map(Number).filter(Boolean);
const sizes = ns.length ? ns : [1000, 5000, 20000, 50000, 100000, 200000];
const STREETS = ['Oak', 'Elm', 'Maple', 'Pine', 'Cedar', 'Birch', 'Spruce', 'Willow', 'Aspen', 'Alder'];
const SUFFIX = ['STREET', 'AVENUE', 'ROAD', 'DRIVE', 'COURT', 'LANE'];
// deterministic pseudo-random, so the workload is identical on every run
let seed = 42; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

function csv(n: number): string {
	const rows = ['parcel_no,site_addr,owner_mail_addr,assessed_total,tax_annual,gross_living_area,yr_built,lat,lon,zoning,land_use,legal_desc'];
	for (let i = 0; i < n; i++) {
		const lat = 39.5 + rnd() * 0.5, lon = -105.2 + rnd() * 0.5;
		rows.push(`${String(10 + (i % 90)).padStart(2, '0')}-${String(i).padStart(6, '0')},"${1 + Math.floor(rnd() * 9999)} ${STREETS[i % 10].toUpperCase()} ${SUFFIX[i % 6]}, METRO CO 802${i % 100}","PO BOX ${i}, METRO CO",${Math.floor(100000 + rnd() * 900000)},${Math.floor(1000 + rnd() * 9000)},${Math.floor(600 + rnd() * 3000)},${1900 + Math.floor(rnd() * 120)},${lat.toFixed(6)},${lon.toFixed(6)},R-${i % 5},RESIDENTIAL,"LOT ${i % 40} BLK ${i % 17} SUBDIVISION ${i % 300} FILING ${i % 9}"`);
	}
	return rows.join('\n');
}
const ms = (t: number) => Math.round((performance.now() - t) * 10) / 10;
const listings: CandidateIdentity[] = Array.from({ length: 50 }, (_, i) => ({ key: `l${i}`, parcelId: null, address: `${100 + i} Oak Street`, addressKey: `${100 + i} oak st`, lat: 39.5 + (i % 10) * 0.04, lng: -105.2 + (i % 7) * 0.05, values: new Map() }));

console.log('records, fileMB, gzipMB, parseMs, mapMs, indexAndResolveMs, perEvaluateMs, heapMB, fitsRequest(1.8MB), fitsStored(1MiB)');
for (const n of sizes) {
	const text = csv(n);
	const bytes = Buffer.byteLength(text), gz = gzipSync(text).byteLength;
	if (global.gc) global.gc();
	const h0 = process.memoryUsage().heapUsed;
	let t = performance.now(); const parsed = parseCsv(text); const parseMs = ms(t);
	const mapping = inspectDataset(parsed).proposed;
	t = performance.now(); const mapped = applyMapping(parsed, mapping); const mapMs = ms(t);
	t = performance.now(); resolveCandidates(listings, { records: mapped.records }); const resMs = ms(t);
	const h1 = process.memoryUsage().heapUsed;
	console.log([n, (bytes / 1048576).toFixed(2), (gz / 1048576).toFixed(2), parseMs, mapMs, resMs, Math.round((parseMs + mapMs + resMs) * 10) / 10, ((h1 - h0) / 1048576).toFixed(0), bytes <= 1_800_000, gz <= 1_048_576].join(', '));
}
