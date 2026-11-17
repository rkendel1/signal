/**
 * M9 measurement (pure). Turns resolutions plus a human-reviewed label set into the numbers that say how often
 * Signal joins the wrong parcel, and describes the inputs that explain why (address coverage, duplicate addresses,
 * the distance between a listing's pin and the parcel it matched).
 *
 * Nothing here changes how matching works. It reads the same `resolveCandidates` output the server uses.
 * Labels come from a person who looked each listing up independently of Signal; this file never creates them.
 */
import { normalizeAddress, type DatasetRecord } from '../datasets/dataset.ts';
import { distanceM, type CandidateIdentity, type Resolution } from '../datasets/resolve.ts';

/** `listing`: a candidate key (URL), or a street address. `expected`: the parcel the reviewer found, or why there is none. */
export interface Label { listing: string; expected: { parcelId: string } | 'none' | 'indistinguishable'; note?: string }

export type Verdict =
	| 'correct_match'           // joined the parcel the reviewer found
	| 'false_match'             // joined a different parcel, or joined one where none exists / the choice is not decidable
	| 'safe_ambiguous'          // refused to choose; a parcel exists (lost match), or the reviewer agrees it is undecidable
	| 'safe_conflict'           // address and location disagree; not joined
	| 'safe_unmatched'          // nothing joined; a parcel exists (lost match)
	| 'correct_unmatched'       // nothing joined, and the reviewer found no parcel
	| 'not_extracted';          // the labelled listing is not among the candidates Signal extracted

export interface Judged { listing: string; verdict: Verdict; expected: Label['expected']; resolution?: Resolution; distanceM?: number | null; note?: string }

const sameListing = (c: CandidateIdentity, listing: string) => c.key === listing || c.key.endsWith(listing) || (!!c.addressKey && c.addressKey === normalizeAddress(listing));

export function judge(labels: Label[], idents: CandidateIdentity[], resolutions: Resolution[], records: DatasetRecord[]): Judged[] {
	const byId = new Map<string, DatasetRecord>();
	for (const r of records) if (!byId.has(r.recordId)) byId.set(r.recordId, r);
	return labels.map((l): Judged => {
		const c = idents.find((x) => sameListing(x, l.listing));
		if (!c) return { listing: l.listing, verdict: 'not_extracted', expected: l.expected, ...(l.note ? { note: l.note } : {}) };
		const res = resolutions.find((r) => r.candidateKey === c.key)!;
		const hasParcel = typeof l.expected === 'object';
		let verdict: Verdict;
		if (res.status === 'matched') verdict = hasParcel && (l.expected as { parcelId: string }).parcelId === res.recordId ? 'correct_match' : 'false_match';
		else if (res.status === 'ambiguous') verdict = 'safe_ambiguous';
		else if (res.status === 'conflict') verdict = 'safe_conflict';
		else verdict = hasParcel ? 'safe_unmatched' : 'correct_unmatched';
		const rec = res.recordId ? byId.get(res.recordId) : undefined;
		const dist = rec && c.lat !== null && c.lng !== null && rec.lat !== null && rec.lng !== null ? Math.round(distanceM({ lat: c.lat, lng: c.lng }, { lat: rec.lat, lng: rec.lng })) : null;
		return { listing: l.listing, verdict, expected: l.expected, resolution: res, distanceM: dist, ...(l.note ? { note: l.note } : {}) };
	});
}

export interface Confusion {
	labelled: number;
	counts: Record<Verdict, number>;
	/** Listings Signal extracted and the reviewer labelled. */
	extracted: number;
	/** Of the listings Signal JOINED, how many were the right parcel. null when nothing was joined. */
	matchPrecision: number | null;
	/** Joined wrongly, as a share of every extracted, labelled listing. The number that matters most. */
	falseMatchRate: number | null;
	/** Of the listings that have a parcel in the data, how many were joined correctly. Lost matches are safe, but they are lost. */
	recall: number | null;
	/** Wilson 95% interval for falseMatchRate, because samples are small. */
	falseMatchInterval: [number, number] | null;
}

export function wilson(k: number, n: number, z = 1.96): [number, number] | null {
	if (n === 0) return null;
	const p = k / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
	return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

export function confusion(j: Judged[]): Confusion {
	const counts: Record<Verdict, number> = { correct_match: 0, false_match: 0, safe_ambiguous: 0, safe_conflict: 0, safe_unmatched: 0, correct_unmatched: 0, not_extracted: 0 };
	for (const x of j) counts[x.verdict]++;
	const extracted = j.length - counts.not_extracted;
	const joined = counts.correct_match + counts.false_match;
	const hadParcel = j.filter((x) => x.verdict !== 'not_extracted' && typeof x.expected === 'object').length;
	return {
		labelled: j.length, counts, extracted,
		matchPrecision: joined ? counts.correct_match / joined : null,
		falseMatchRate: extracted ? counts.false_match / extracted : null,
		recall: hadParcel ? counts.correct_match / hadParcel : null,
		falseMatchInterval: wilson(counts.false_match, extracted)
	};
}

// ------------------------------------------------------------------ describing the inputs

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
export function quantiles(xs: number[]): { n: number; p50: number; p90: number; p99: number; max: number } | null {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b), at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
	return { n: s.length, p50: at(0.5), p90: at(0.9), p99: at(0.99), max: s[s.length - 1] };
}

/** How much of each side can take part in each kind of match, and how often addresses repeat (which makes joins ambiguous). */
export function inputProfile(idents: CandidateIdentity[], records: DatasetRecord[]) {
	const keyCount = new Map<string, number>();
	for (const r of records) if (r.addressKey) keyCount.set(r.addressKey, (keyCount.get(r.addressKey) ?? 0) + 1);
	const repeated = [...keyCount.values()].filter((n) => n > 1);
	return {
		listings: {
			count: idents.length,
			withParcelId: idents.filter((c) => c.parcelId).length,
			withUsableAddress: idents.filter((c) => c.addressKey).length,
			withAddressText: idents.filter((c) => c.address).length,
			withCoordinates: idents.filter((c) => c.lat !== null && c.lng !== null).length,
			withNothingToMatchOn: idents.filter((c) => !c.parcelId && !c.addressKey && (c.lat === null || c.lng === null)).length
		},
		parcels: {
			count: records.length,
			withId: records.filter((r) => r.hasId).length,
			withUsableAddress: records.filter((r) => r.addressKey).length,
			withAddressText: records.filter((r) => r.address).length,
			withPoint: records.filter((r) => r.lat !== null && r.lng !== null).length,
			withPolygon: records.filter((r) => r.geometry?.polygons).length,
			addressKeysShared: repeated.length,
			recordsOnSharedAddress: repeated.reduce((a, b) => a + b, 0),
			shareOnSharedAddress: pct(repeated.reduce((a, b) => a + b, 0), records.length)
		}
	};
}

export function resolutionTally(resolutions: Resolution[]) {
	const by: Record<string, number> = {}, basis: Record<string, number> = {};
	for (const r of resolutions) { by[r.status] = (by[r.status] ?? 0) + 1; if (r.basis) basis[r.basis] = (basis[r.basis] ?? 0) + 1; }
	return { total: resolutions.length, byStatus: by, byBasis: basis };
}

/** Distance between a listing's pin and the parcel record it was joined to — the evidence for any threshold discussion. */
export function pinDistances(idents: CandidateIdentity[], resolutions: Resolution[], records: DatasetRecord[]): number[] {
	const byId = new Map<string, DatasetRecord>();
	for (const r of records) if (!byId.has(r.recordId)) byId.set(r.recordId, r);
	const out: number[] = [];
	for (const res of resolutions) {
		if (res.status !== 'matched') continue;
		const c = idents.find((x) => x.key === res.candidateKey)!, r = byId.get(res.recordId!);
		if (r && c.lat !== null && c.lng !== null && r.lat !== null && r.lng !== null) out.push(distanceM({ lat: c.lat, lng: c.lng }, { lat: r.lat, lng: r.lng }));
	}
	return out;
}
