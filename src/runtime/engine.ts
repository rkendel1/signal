import type {
	AlertDispatcher, AlertDestination, CriteriaDefinition, Evaluation, Interpretation, MatchedEvent, MonitorDefinition,
	Observation, ObservationSource, SignalDecoder, SourceDefinition, SourceType
} from '../contracts/types.ts';
import { canonicalJson, contentId, newId, sha256 } from '../core/canonical.ts';
import { DeterministicEvaluator, matchedLeaves } from '../core/evaluate.ts';
import { extractFields } from '../interpret/extract.ts';
import { normalizeContent } from '../interpret/normalize.ts';
import { deliverEvent, defaultDeliveryPolicy, type DeliveryPolicy } from '../delivery/dispatch.ts';
import type { MonitorState, SignalStore } from '../store/feltdb-store.ts';

export interface EngineDeps {
	store: SignalStore;
	sources: Partial<Record<SourceType, ObservationSource>>;
	decoders: SignalDecoder[];
	dispatchers: Partial<Record<AlertDestination['type'], AlertDispatcher>>;
	deliveryPolicy?: DeliveryPolicy;
	now?: () => Date;
}

export interface CycleResult {
	observation: Observation;
	interpretation?: Interpretation;
	evaluation?: Evaluation;
	event?: MatchedEvent;
	commit?: 'committed' | 'already_committed' | 'conflict';
	timings: Record<string, number>;
}

/**
 * The deterministic Signal pipeline:
 *   observe → preserve evidence → interpret → evaluate → record → deliver.
 * Each stage writes its own durable fact; no stage overwrites another's.
 */
export class SignalEngine {
	private evaluator = new DeterministicEvaluator();
	private d: EngineDeps;
	constructor(d: EngineDeps) { this.d = d; }

	private now(): Date { return this.d.now?.() ?? new Date(); }

	private async load(monitorId: string): Promise<{ monitor: MonitorDefinition; source: SourceDefinition; criteria: CriteriaDefinition }> {
		const monitor = await this.d.store.getMonitor(monitorId);
		if (!monitor) throw new Error(`Monitor ${monitorId} not found in tenant ${this.d.store.tenantId}`);
		const source = await this.d.store.getSource(monitor.sourceId);
		if (!source) throw new Error(`Source ${monitor.sourceId} not found`);
		const criteria = await this.d.store.getCriteria(monitor.criteriaId, monitor.criteriaVersion);
		if (!criteria) throw new Error(`Criteria ${monitor.criteriaId}@v${monitor.criteriaVersion} not found`);
		return { monitor, source, criteria };
	}

	/** Run one observation cycle. `content` is required for pushed sources (text/json/dom). */
	async runOnce(monitorId: string, opts: { content?: string } = {}): Promise<CycleResult> {
		const timings: Record<string, number> = {};
		const t = (k: string, t0: number) => (timings[k] = +(performance.now() - t0).toFixed(3));
		const { monitor, source, criteria } = await this.load(monitorId);
		if (!monitor.enabled) throw new Error(`Monitor ${monitorId} is disabled`);
		const adapter = this.d.sources[source.type];
		if (!adapter) throw new Error(`No observation adapter for source type ${source.type}`);
		const state = await this.d.store.getMonitorState(monitorId);

		let t0 = performance.now();
		const { observation, body } = await adapter.observe({
			source, content: opts.content, requestedAt: this.now().toISOString(),
			previous: state ? { etag: state.etag, lastModified: state.lastModified, contentHash: state.lastContentHash } : undefined
		});
		t('observe', t0);
		if (body) observation.evidenceRef = await this.d.store.putEvidence(body);
		await this.d.store.putObservation(observation);
		if (observation.status !== 'ok' || !body) return { observation, timings };

		return this.interpretAndEvaluate(monitor, source, criteria, observation, body, state, timings);
	}

	/**
	 * Re-run interpretation and evaluation for an already-stored observation
	 * (e.g. after a crash, or to audit). Deterministic ids make this idempotent:
	 * no duplicate evaluation, event or notification can result.
	 */
	async reprocess(monitorId: string, observationId: string): Promise<CycleResult> {
		const { monitor, source, criteria } = await this.load(monitorId);
		const observation = await this.d.store.getObservation(observationId);
		if (!observation?.evidenceRef) throw new Error(`Observation ${observationId} has no evidence`);
		const body = await this.d.store.getEvidence(observation.evidenceRef);
		const state = await this.d.store.getMonitorState(monitorId);
		return this.interpretAndEvaluate(monitor, source, criteria, observation, body, state, {});
	}

	private async interpretAndEvaluate(
		monitor: MonitorDefinition, source: SourceDefinition, criteria: CriteriaDefinition,
		observation: Observation, body: Uint8Array, state: MonitorState | undefined, timings: Record<string, number>
	): Promise<CycleResult> {
		const store = this.d.store;
		const t = (k: string, t0: number) => (timings[k] = +(performance.now() - t0).toFixed(3));

		// --- interpret ---------------------------------------------------------
		let t0 = performance.now();
		const raw = new TextDecoder().decode(body);
		const normalized = normalizeContent(raw, observation.contentType);
		const normalizedTextRef = await store.putEvidence(new TextEncoder().encode(normalized));
		const fields = extractFields(criteria.extract ?? [], normalized, raw);
		t('extract', t0);
		t0 = performance.now();
		// Decoders run on normalized text; spans index into it. (Signals hidden in HTML attributes are not
		// visible here — recorded in GAP_REGISTER.)
		const signals = this.d.decoders.flatMap((dec) => dec.detect({ text: normalized, contentType: observation.contentType }));
		t('detect', t0);
		const interpretation: Interpretation = {
			schema: 'signal.interpretation/v1',
			interpretationId: contentId('int', { observationId: observation.observationId, extract: criteria.extract ?? [], decoders: this.d.decoders.map((x) => x.codec) }),
			tenantId: observation.tenantId, observationId: observation.observationId, sourceId: source.id,
			interpretedAt: this.now().toISOString(),
			normalizedTextHash: sha256(normalized), normalizedTextRef,
			extractionVersion: sha256(canonicalJson(criteria.extract ?? [])).slice(0, 16),
			fields, signals
		};
		await store.putInterpretation(interpretation);

		// --- evaluate ----------------------------------------------------------
		t0 = performance.now();
		const previous = state?.lastInterpretationId && state.lastInterpretationId !== interpretation.interpretationId
			? await store.getInterpretation(state.lastInterpretationId) : undefined;
		const contentChanged = state?.lastContentHash === undefined ? undefined : state.lastContentHash !== observation.contentHash;
		const result = this.evaluator.evaluate(interpretation, previous, criteria, { now: this.now().toISOString(), normalizedText: normalized, contentChanged });
		t('evaluate', t0);

		const dedupKey = result.matched ? contentId('dk', { monitorId: monitor.id, criteriaId: criteria.id, criteriaVersion: criteria.version, values: result.matchedValues }) : undefined;
		const nowIso = this.now().toISOString();
		let outcome: Evaluation['outcome'] = 'no_match';
		if (result.matched) {
			const w = criteria.window;
			if ((w?.notBefore && nowIso < w.notBefore) || (w?.notAfter && nowIso > w.notAfter)) outcome = 'suppressed_window';
			else if ((criteria.notify ?? 'on_change') === 'on_enter' && state?.matched) outcome = 'suppressed_not_entered';
			else if (state?.matched && state.lastDedupKey === dedupKey) outcome = 'suppressed_duplicate';
			else if (criteria.minIntervalSeconds && state?.lastEventAt && Date.parse(nowIso) - Date.parse(state.lastEventAt) < criteria.minIntervalSeconds * 1000) outcome = 'suppressed_rate_limit';
			else outcome = 'event_recorded';
		}

		const idBasis = { monitorId: monitor.id, observationId: observation.observationId, criteriaId: criteria.id, criteriaVersion: criteria.version };
		const evaluation: Evaluation = {
			schema: 'signal.evaluation/v1', evaluationId: contentId('evl', idBasis), tenantId: monitor.tenantId,
			monitorId: monitor.id, observationId: observation.observationId, interpretationId: interpretation.interpretationId,
			previousInterpretationId: previous?.interpretationId, criteriaId: criteria.id, criteriaVersion: criteria.version,
			evaluatedAt: nowIso, matched: result.matched, trace: result.trace, outcome, dedupKey
		};

		let event: MatchedEvent | undefined;
		if (outcome === 'event_recorded') {
			const leaves = matchedLeaves(result.trace);
			event = {
				schema: 'signal.event/v1', eventId: contentId('evt', idBasis), tenantId: monitor.tenantId, ownerId: monitor.ownerId,
				monitorId: monitor.id, sourceId: source.id, sourceLocator: source.locator,
				observationId: observation.observationId, interpretationId: interpretation.interpretationId, evaluationId: evaluation.evaluationId,
				criteriaId: criteria.id, criteriaVersion: criteria.version, criteriaName: criteria.name, severity: criteria.severity,
				occurredAt: nowIso, matched: leaves,
				excerpts: [
					...fields.filter((f) => f.excerpt && leaves.some((l) => l.path.endsWith(`field(${f.field})`))).map((f) => ({ field: f.field, text: f.excerpt! })),
					...leaves.filter((l) => l.op === 'text' && typeof l.actual === 'string').map((l) => ({ text: String(l.actual) }))
				],
				evidence: { observationRef: observation.evidenceRef!, normalizedTextRef, contentHash: observation.contentHash! },
				provenance: observation.provenance,
				confidence: Math.min(1, ...signals.filter((s) => s.ok).map((s) => s.confidence)),
				dedupKey: dedupKey!
			};
			evaluation.eventId = event.eventId;
		}

		const nextState: MonitorState = {
			monitorId: monitor.id, tenantId: monitor.tenantId, matched: result.matched,
			lastDedupKey: result.matched ? (outcome === 'event_recorded' ? dedupKey : state?.lastDedupKey ?? dedupKey) : undefined,
			lastEventAt: event ? nowIso : state?.lastEventAt,
			lastInterpretationId: interpretation.interpretationId, lastContentHash: observation.contentHash,
			lastObservedAt: observation.observedAt,
			etag: observation.provenance.headers?.etag, lastModified: observation.provenance.headers?.['last-modified']
		};
		t0 = performance.now();
		const commit = await store.commitEvaluation({ evaluation, event, prevState: state, nextState });
		t('record', t0);

		if (commit === 'committed' && event) {
			t0 = performance.now();
			await deliverEvent(store, event, monitor.destinations, this.d.dispatchers, this.d.deliveryPolicy ?? defaultDeliveryPolicy, () => this.now());
			t('deliver', t0);
		} else if (commit === 'already_committed') {
			const existing = await store.getEvaluation(evaluation.evaluationId);
			if (existing?.eventId) {
				event = await store.getEvent(existing.eventId);
				// Resume any delivery that did not finish; delivered destinations are skipped.
				if (event) await deliverEvent(store, event, monitor.destinations, this.d.dispatchers, this.d.deliveryPolicy ?? defaultDeliveryPolicy, () => this.now());
			}
			return { observation, interpretation, evaluation: existing, event, commit, timings };
		}
		return { observation, interpretation, evaluation, event: commit === 'committed' ? event : undefined, commit, timings };
	}
}

export function newMonitorIds() {
	return { sourceId: newId('src'), criteriaId: newId('crt'), monitorId: newId('mon') };
}
