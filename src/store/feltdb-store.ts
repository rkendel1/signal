import { createFeltDB } from '@feltdb/core';
import type {
	Acknowledgement, CriteriaDefinition, DeliveryAttempt, Evaluation, Interpretation, MatchedEvent,
	MonitorDefinition, Observation, SourceDefinition
} from '../contracts/types.ts';

/**
 * Durable state for Signal, held in FeltDB (the Boundry source of truth).
 * Signal does not run its own database.
 *
 * Conventions (from FeltDB's public contract and boundry/intelligence/src/store.mjs):
 *  - Facts are write-once: inserted with `requireAbsent` and never updated.
 *  - Definitions are versioned immutably: criteria `id@vN`.
 *  - The only mutable record is the per-monitor condition state, updated with a
 *    version fence (CAS) inside the same transaction that records the event.
 *  - Evidence bytes live in FeltDB's content store (`sha256:` refs).
 *  - Every query is scoped by tenantId as well as by the tenant authority scope.
 */

export const COLLECTIONS = {
	sources: 'signal_sources',
	criteria: 'signal_criteria',
	monitors: 'signal_monitors',
	monitorState: 'signal_monitor_state',
	observations: 'signal_observations',
	interpretations: 'signal_interpretations',
	evaluations: 'signal_evaluations',
	events: 'signal_events',
	deliveries: 'signal_deliveries',
	acks: 'signal_acks'
} as const;

export interface MonitorState {
	monitorId: string;
	tenantId: string;
	matched: boolean;
	lastDedupKey?: string;
	lastEventAt?: string;
	lastInterpretationId?: string;
	lastContentHash?: string;
	lastObservedAt?: string;
	etag?: string;
	lastModified?: string;
	__version?: number;
}

type Db = Awaited<ReturnType<typeof createFeltDB>>;

function strip<T>(r: Record<string, unknown> | null | undefined): T | undefined {
	if (!r) return undefined;
	// FeltDB sets `id` to the record key. For sources/monitors that *is* the domain id;
	// criteria restore theirs from `criteriaId` (record key is `id@vN`).
	const { __version: _v, ...rest } = r as Record<string, unknown>;
	if (typeof rest.criteriaId === 'string' && typeof rest.version === 'number' && rest.schema === 'signal.criteria/v1') rest.id = rest.criteriaId;
	if (rest.schema !== 'signal.source/v1' && rest.schema !== 'signal.monitor/v1' && rest.schema !== 'signal.criteria/v1') delete rest.id;
	return rest as T;
}

function isPrecondition(e: unknown): boolean {
	const err = e as { code?: string; message?: string };
	return err?.code === 'PRECONDITION_FAILED' || /PRECONDITION_FAILED|already exists/.test(err?.message ?? '');
}

export class SignalStore {
	private db: Db;
	readonly tenantId: string;
	private constructor(db: Db, tenantId: string) { this.db = db; this.tenantId = tenantId; }

	/** `path` = durable local file store; omit for an in-memory store (no evidence blobs). */
	static async open(opts: { tenantId: string; path?: string }): Promise<SignalStore> {
		const db = await createFeltDB({
			...(opts.path ? { path: opts.path } : { memory: true }),
			authorityScope: { kind: 'tenant', tenantId: opts.tenantId }
		} as Parameters<typeof createFeltDB>[0]);
		return new SignalStore(db, opts.tenantId);
	}

	async close(): Promise<void> {
		await (this.db as unknown as { close?: () => Promise<void> }).close?.();
	}

	private col(name: string) {
		return this.db.collection(name);
	}

	private assertTenant(rec: { tenantId: string }): void {
		if (rec.tenantId !== this.tenantId) throw new Error(`Cross-tenant write refused (${rec.tenantId} into ${this.tenantId})`);
	}

	/** Insert-once. Returns false if a record with this id already exists (idempotent replay). */
	private async insertOnce(collection: string, id: string, rec: { tenantId: string }): Promise<boolean> {
		this.assertTenant(rec);
		try {
			await this.col(collection).insert(rec as Record<string, unknown>, id, { requireAbsent: true });
			return true;
		} catch (e) {
			if (isPrecondition(e)) return false;
			throw e;
		}
	}

	private async getById<T extends { tenantId: string }>(collection: string, id: string): Promise<T | undefined> {
		const r = await this.col(collection).get(id);
		const v = strip<T>(r as Record<string, unknown> | null);
		return v && v.tenantId === this.tenantId ? v : undefined;
	}

	private async queryBy<T>(collection: string, where: Array<Record<string, unknown>>, orderBy?: { field: string; direction: 'asc' | 'desc' }, limit = 100): Promise<T[]> {
		const q = await this.db.query({
			collection,
			where: [{ field: 'tenantId', eq: this.tenantId }, ...where],
			...(orderBy ? { orderBy: [orderBy] } : {}),
			limit
		} as Parameters<Db['query']>[0]);
		return (q.records as Record<string, unknown>[]).map((r) => strip<T>(r)!);
	}

	// --- evidence -----------------------------------------------------------
	async putEvidence(bytes: Uint8Array): Promise<string> {
		const r = await this.db.storeContent(bytes);
		return r.ref;
	}
	async getEvidence(ref: string): Promise<Uint8Array> {
		const hash = ref.replace(/^sha256:/, '');
		const r = (await this.db.acquireContent(hash)) as unknown as Uint8Array | { bytes: Uint8Array };
		return r instanceof Uint8Array ? r : 'bytes' in r ? r.bytes : Uint8Array.from(Object.values(r as Record<string, number>));
	}

	// --- definitions ---------------------------------------------------------
	putSource(s: SourceDefinition) { return this.insertOnce(COLLECTIONS.sources, s.id, s); }
	getSource(id: string) { return this.getById<SourceDefinition>(COLLECTIONS.sources, id); }
	putCriteria(c: CriteriaDefinition & { tenantId: string }) { return this.insertOnce(COLLECTIONS.criteria, `${c.id}@v${c.version}`, { ...c, criteriaId: c.id }); }
	getCriteria(id: string, version: number) { return this.getById<CriteriaDefinition & { tenantId: string }>(COLLECTIONS.criteria, `${id}@v${version}`); }
	putMonitor(m: MonitorDefinition) { return this.insertOnce(COLLECTIONS.monitors, m.id, m); }
	getMonitor(id: string) { return this.getById<MonitorDefinition>(COLLECTIONS.monitors, id); }
	listMonitors() { return this.queryBy<MonitorDefinition>(COLLECTIONS.monitors, [], undefined, 1000); }

	// --- facts ----------------------------------------------------------------
	putObservation(o: Observation) { return this.insertOnce(COLLECTIONS.observations, o.observationId, o); }
	getObservation(id: string) { return this.getById<Observation>(COLLECTIONS.observations, id); }
	putInterpretation(i: Interpretation) { return this.insertOnce(COLLECTIONS.interpretations, i.interpretationId, i); }
	getInterpretation(id: string) { return this.getById<Interpretation>(COLLECTIONS.interpretations, id); }
	getEvaluation(id: string) { return this.getById<Evaluation>(COLLECTIONS.evaluations, id); }
	getEvent(id: string) { return this.getById<MatchedEvent>(COLLECTIONS.events, id); }
	listEvaluations(monitorId: string) { return this.queryBy<Evaluation>(COLLECTIONS.evaluations, [{ field: 'monitorId', eq: monitorId }], { field: 'evaluatedAt', direction: 'asc' }, 1000); }
	listEvents(filter: { monitorId?: string; sourceLocator?: string; ownerId?: string } = {}) {
		const where = Object.entries(filter).filter(([, v]) => v !== undefined).map(([field, v]) => ({ field, eq: v }));
		return this.queryBy<MatchedEvent>(COLLECTIONS.events, where, { field: 'occurredAt', direction: 'desc' }, 200);
	}
	putDelivery(d: DeliveryAttempt) { return this.insertOnce(COLLECTIONS.deliveries, d.attemptId, d); }
	listDeliveries(eventId: string) { return this.queryBy<DeliveryAttempt>(COLLECTIONS.deliveries, [{ field: 'eventId', eq: eventId }], { field: 'attempt', direction: 'asc' }, 1000); }
	putAck(a: Acknowledgement) { return this.insertOnce(COLLECTIONS.acks, `ack_${a.eventId}_${a.subjectId}`, a); }
	listAcks(eventId: string) { return this.queryBy<Acknowledgement>(COLLECTIONS.acks, [{ field: 'eventId', eq: eventId }]); }

	async getMonitorState(monitorId: string): Promise<MonitorState | undefined> {
		const r = (await this.col(COLLECTIONS.monitorState).get(monitorId)) as Record<string, unknown> | null;
		if (!r || r.tenantId !== this.tenantId) return undefined;
		const { id: _id, ...rest } = r;
		return rest as unknown as MonitorState;
	}

	/**
	 * Atomically record an evaluation, optionally a matched event, and the new
	 * monitor state (fenced on the state version read before evaluation).
	 * A concurrent runner that read the same state version loses the race and
	 * nothing it staged is written — no duplicate event can be produced.
	 */
	async commitEvaluation(args: {
		evaluation: Evaluation;
		event?: MatchedEvent;
		prevState: MonitorState | undefined;
		nextState: MonitorState;
	}): Promise<'committed' | 'already_committed' | 'conflict'> {
		this.assertTenant(args.evaluation);
		const { __version: _v, ...state } = args.nextState;
		try {
			await this.db.transaction(async (tx) => {
				tx.collection(COLLECTIONS.evaluations).set(args.evaluation.evaluationId, args.evaluation as unknown as Record<string, unknown>, { requireAbsent: true });
				if (args.event) {
					this.assertTenant(args.event);
					tx.collection(COLLECTIONS.events).set(args.event.eventId, args.event as unknown as Record<string, unknown>, { requireAbsent: true });
				}
				tx.collection(COLLECTIONS.monitorState).set(
					args.nextState.monitorId,
					state as Record<string, unknown>,
					args.prevState?.__version !== undefined ? { ifVersion: args.prevState.__version } : { requireAbsent: true }
				);
			});
			return 'committed';
		} catch (e) {
			if (!isPrecondition(e) && !/version|CONFLICT/i.test(String((e as Error).message))) throw e;
			return (await this.getEvaluation(args.evaluation.evaluationId)) ? 'already_committed' : 'conflict';
		}
	}
}
