import type {
	CriteriaDefinition, Evaluation, Interpretation, MatchedEvent, Observation, SignalDecoder
} from '../contracts/types.ts';
import { canonicalJson, contentId, sha256 } from './canonical.ts';
import { DeterministicEvaluator, matchedLeaves } from './evaluate.ts';
import { extractFields } from '../interpret/extract.ts';
import type { PageRepresentation } from '../page/types.ts';

/**
 * One Signal cycle's decision, as a pure function:
 *   (observation, raw body, normalized text, criteria, previous state) →
 *   interpretation, evaluation (with outcome), optional event, next state.
 *
 * No I/O. Persistence, authorization and delivery belong to the host
 * (FeltKit: feltkit/monitors.ts). Ids are content-derived, so re-running the
 * same observation yields the same evaluation and event ids — the host's
 * insert-once writes make reprocessing idempotent.
 */

export interface MonitorState {
	matched: boolean;
	lastDedupKey?: string;
	lastEventAt?: string;
	lastInterpretationId?: string;
	lastContentHash?: string;
}

export interface CycleInput {
	tenantId: string;
	monitor: { id: string; ownerId: string };
	source: { id: string; locator: string };
	criteria: CriteriaDefinition;
	observation: Observation; // status ok, with evidenceRef + contentHash
	rawBody: string;
	normalizedText: string;
	normalizedTextRef: string;
	state: MonitorState | undefined;
	previous: Interpretation | undefined;
	decoders: SignalDecoder[];
	now: string;
	/** The page representation of this observation and of the previous one (HTML sources). */
	page?: { representation: PageRepresentation; ref: string };
	previousPage?: PageRepresentation;
}

export interface CycleOutput {
	interpretation: Interpretation;
	evaluation: Evaluation;
	event?: MatchedEvent;
	nextState: MonitorState;
	timings: { extract: number; detect: number; evaluate: number };
}

const evaluator = new DeterministicEvaluator();

export function runCycle(i: CycleInput): CycleOutput {
	const { criteria, observation: obs } = i;
	let t = performance.now();
	const fields = extractFields(criteria.extract ?? [], i.normalizedText, i.rawBody);
	const extract = performance.now() - t;
	t = performance.now();
	// Decoders run on normalized text; spans index into it. (Signals hidden in HTML attributes
	// are not visible here — GAP_REGISTER G-INT-2.)
	const signals = i.decoders.flatMap((d) => d.detect({ text: i.normalizedText, contentType: obs.contentType }));
	const detect = performance.now() - t;

	const interpretation: Interpretation = {
		schema: 'signal.interpretation/v1',
		interpretationId: contentId('int', { observationId: obs.observationId, extract: criteria.extract ?? [], decoders: i.decoders.map((d) => d.codec) }),
		tenantId: i.tenantId, observationId: obs.observationId, sourceId: i.source.id, interpretedAt: i.now,
		normalizedTextHash: sha256(i.normalizedText), normalizedTextRef: i.normalizedTextRef,
		extractionVersion: sha256(canonicalJson(criteria.extract ?? [])).slice(0, 16),
		fields, signals,
		...(i.page ? { page: { ref: i.page.ref, revision: i.page.representation.revision, entities: i.page.representation.entities.length, schema: i.page.representation.schema } } : {})
	};

	t = performance.now();
	const previous = i.previous && i.previous.interpretationId !== interpretation.interpretationId ? i.previous : undefined;
	const contentChanged = i.state?.lastContentHash === undefined ? undefined : i.state.lastContentHash !== obs.contentHash;
	const result = evaluator.evaluate(interpretation, previous, criteria, { now: i.now, normalizedText: i.normalizedText, contentChanged, page: i.page?.representation, previousPage: i.previousPage });
	const evaluate = performance.now() - t;

	const s = i.state;
	const dedupKey = result.matched ? contentId('dk', { monitorId: i.monitor.id, criteriaId: criteria.id, criteriaVersion: criteria.version, values: result.matchedValues }) : undefined;
	let outcome: Evaluation['outcome'] = 'no_match';
	if (result.matched) {
		const w = criteria.window;
		if ((w?.notBefore && i.now < w.notBefore) || (w?.notAfter && i.now > w.notAfter)) outcome = 'suppressed_window';
		else if ((criteria.notify ?? 'on_change') === 'on_enter' && s?.matched) outcome = 'suppressed_not_entered';
		else if (s?.matched && s.lastDedupKey === dedupKey) outcome = 'suppressed_duplicate';
		else if (criteria.minIntervalSeconds && s?.lastEventAt && Date.parse(i.now) - Date.parse(s.lastEventAt) < criteria.minIntervalSeconds * 1000) outcome = 'suppressed_rate_limit';
		else outcome = 'event_recorded';
	}

	const idBasis = { monitorId: i.monitor.id, observationId: obs.observationId, criteriaId: criteria.id, criteriaVersion: criteria.version };
	const evaluation: Evaluation = {
		schema: 'signal.evaluation/v1', evaluationId: contentId('evl', idBasis), tenantId: i.tenantId, monitorId: i.monitor.id,
		observationId: obs.observationId, interpretationId: interpretation.interpretationId, previousInterpretationId: previous?.interpretationId,
		criteriaId: criteria.id, criteriaVersion: criteria.version, evaluatedAt: i.now, matched: result.matched, trace: result.trace, outcome, dedupKey
	};

	let event: MatchedEvent | undefined;
	if (outcome === 'event_recorded') {
		const leaves = matchedLeaves(result.trace);
		event = {
			schema: 'signal.event/v1', eventId: contentId('evt', idBasis), tenantId: i.tenantId, ownerId: i.monitor.ownerId,
			monitorId: i.monitor.id, sourceId: i.source.id, sourceLocator: i.source.locator,
			observationId: obs.observationId, interpretationId: interpretation.interpretationId, evaluationId: evaluation.evaluationId,
			criteriaId: criteria.id, criteriaVersion: criteria.version, criteriaName: criteria.name, severity: criteria.severity,
			occurredAt: i.now, matched: leaves,
			excerpts: [
				...fields.filter((f) => f.excerpt && leaves.some((l) => l.path.endsWith(`field(${f.field})`))).map((f) => ({ field: f.field, text: f.excerpt! })),
				...leaves.filter((l) => l.op === 'text' && typeof l.actual === 'string').map((l) => ({ text: String(l.actual) })),
				...leaves.filter((l) => l.op === 'entity' && Array.isArray(l.actual)).flatMap((l) => (l.actual as Array<{ type: string; name: string | null; values: Record<string, unknown[]> }>).slice(0, 10).map((m) => ({
					text: `${m.type}${m.name ? ` “${m.name}”` : ''}: ${Object.entries(m.values).map(([k, v]) => `${k}=${v.map((x) => (x && typeof x === 'object' && 'amount' in x ? `${(x as unknown as { currency: string | null }).currency ?? ''} ${(x as unknown as { amount: number }).amount}`.trim() : typeof x === 'object' ? JSON.stringify(x) : String(x))).join('|')}`).join(', ')}`
				})))
			],
			evidence: { observationRef: obs.evidenceRef!, normalizedTextRef: i.normalizedTextRef, contentHash: obs.contentHash!, ...(i.page ? { pageRef: i.page.ref, pageRevision: i.page.representation.revision } : {}) },
			provenance: obs.provenance,
			confidence: Math.min(1, ...signals.filter((x) => x.ok).map((x) => x.confidence)),
			dedupKey: dedupKey!
		};
		evaluation.eventId = event.eventId;
	}

	const nextState: MonitorState = {
		matched: result.matched,
		lastDedupKey: result.matched ? (outcome === 'event_recorded' ? dedupKey : s?.lastDedupKey ?? dedupKey) : undefined,
		lastEventAt: event ? i.now : s?.lastEventAt,
		lastInterpretationId: interpretation.interpretationId,
		lastContentHash: obs.contentHash
	};
	return { interpretation, evaluation, event, nextState, timings: { extract, detect, evaluate } };
}
