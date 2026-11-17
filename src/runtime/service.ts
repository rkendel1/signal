import type {
	Acknowledgement, AlertDestination, CriteriaDefinition, MatchedEvent, MonitorDefinition, Principal, SourceDefinition
} from '../contracts/types.ts';
import { newId } from '../core/canonical.ts';
import { validateCondition } from '../core/evaluate.ts';
import { validateRule } from '../interpret/extract.ts';
import { assertUrlAllowed, type NetPolicy } from '../sources/net-guard.ts';
import type { SignalStore } from '../store/feltdb-store.ts';

/**
 * Authorization boundary. In Boundry the decision belongs to AuthBoundry
 * (`enforcer.authorize({principal, action, resource, company})`); this
 * interface is what Signal calls, so the authority is replaceable.
 * Ownership of monitors/criteria is enforced in Signal's own data because
 * AuthBoundry decides at capability level (see GAP_REGISTER G-AUTH-1).
 */
export interface Authorizer {
	authorize(p: Principal, action: SignalAction, resource: { type: string; id: string; tenantId: string; ownerId?: string }): Promise<{ allowed: boolean; reason?: string }>;
}

export type SignalAction =
	| 'signal.source.write' | 'signal.criteria.write' | 'signal.monitor.write' | 'signal.monitor.run'
	| 'signal.event.read' | 'signal.event.ack' | 'signal.evidence.read';

/** Deterministic local policy: tenant match + granted permission + ownership for owned resources. */
export class LocalPolicyAuthorizer implements Authorizer {
	async authorize(p: Principal, action: SignalAction, r: { type: string; id: string; tenantId: string; ownerId?: string }) {
		if (p.tenantId !== r.tenantId) return { allowed: false, reason: 'tenant mismatch' };
		if (!p.permissions.includes(action)) return { allowed: false, reason: `missing permission ${action}` };
		if (r.ownerId && r.ownerId !== p.subjectId && !p.permissions.includes('signal.admin')) return { allowed: false, reason: 'not the owner' };
		return { allowed: true };
	}
}

export class AuthorizationError extends Error {
	readonly code = 'FORBIDDEN';
}

/** Application-facing operations. Every call is authorized; inputs are validated before they become durable configuration. */
export class SignalService {
	private store: SignalStore;
	private auth: Authorizer;
	private net: NetPolicy;
	private now: () => Date;
	constructor(store: SignalStore, auth: Authorizer, net: NetPolicy = {}, now = () => new Date()) { this.store = store; this.auth = auth; this.net = net; this.now = now; }

	private async require(p: Principal, action: SignalAction, r: { type: string; id: string; tenantId: string; ownerId?: string }) {
		// A service instance serves exactly one tenant's store; foreign principals are refused outright.
		if (p.tenantId !== this.store.tenantId) throw new AuthorizationError(`${action} denied: principal tenant ${p.tenantId} is not ${this.store.tenantId}`);
		const d = await this.auth.authorize(p, action, r);
		if (!d.allowed) throw new AuthorizationError(`${action} on ${r.type}/${r.id} denied: ${d.reason ?? 'not allowed'}`);
	}

	async registerSource(p: Principal, input: Pick<SourceDefinition, 'type' | 'locator' | 'access' | 'observation'>): Promise<SourceDefinition> {
		const s: SourceDefinition = { schema: 'signal.source/v1', id: newId('src'), tenantId: p.tenantId, ownerId: p.subjectId, createdAt: this.now().toISOString(), ...input };
		await this.require(p, 'signal.source.write', { type: 'source', id: s.id, tenantId: s.tenantId, ownerId: s.ownerId });
		const isHttp = /^https?:/i.test(s.locator);
		if (s.type === 'http_page' && !isHttp) throw new Error('http_page sources need an absolute http(s) URL');
		if (!isHttp && s.observation.strategy === 'poll') throw new Error('Only http(s) sources can be polled; pushed sources use strategy event/manual');
		if (s.type === 'http_page' || isHttp) {
			// Validated at registration and again at every fetch (DNS can change).
			await assertUrlAllowed(s.locator, this.net);
		}
		if (s.observation.strategy === 'poll') {
			s.observation.intervalSeconds = Math.max(300, s.observation.intervalSeconds ?? 3600); // floor: 5 minutes
		}
		await this.store.putSource(s);
		return s;
	}

	async defineCriteria(p: Principal, c: Omit<CriteriaDefinition, 'schema' | 'version'> & { version?: number }): Promise<CriteriaDefinition> {
		const def: CriteriaDefinition = { ...c, schema: 'signal.criteria/v1', version: c.version ?? 1 };
		await this.require(p, 'signal.criteria.write', { type: 'criteria', id: def.id, tenantId: p.tenantId, ownerId: p.subjectId });
		validateCondition(def.condition);
		(def.extract ?? []).forEach(validateRule);
		if (!(await this.store.putCriteria({ ...def, tenantId: p.tenantId, ownerId: p.subjectId } as CriteriaDefinition & { tenantId: string }))) {
			throw new Error(`Criteria ${def.id}@v${def.version} already exists; versions are immutable — publish version ${def.version + 1}`);
		}
		return def;
	}

	async createMonitor(p: Principal, input: { sourceId: string; criteriaId: string; criteriaVersion: number; destinations: AlertDestination[] }): Promise<MonitorDefinition> {
		const source = await this.store.getSource(input.sourceId);
		if (!source) throw new Error(`Unknown source ${input.sourceId}`);
		await this.require(p, 'signal.monitor.write', { type: 'source', id: source.id, tenantId: source.tenantId, ownerId: source.ownerId });
		if (!(await this.store.getCriteria(input.criteriaId, input.criteriaVersion))) throw new Error(`Unknown criteria ${input.criteriaId}@v${input.criteriaVersion}`);
		for (const d of input.destinations) {
			if (d.type === 'webhook') {
				if (!d.target.startsWith('https://') && !(this.net.allowPrivateHosts ?? []).includes(new URL(d.target).hostname)) {
					throw new Error(`Webhook destinations must be https: ${d.target}`);
				}
				await assertUrlAllowed(d.target, this.net);
			}
			if (d.type === 'inbox' && d.target !== p.subjectId) throw new Error('Inbox destination must be the monitor owner');
		}
		const m: MonitorDefinition = {
			schema: 'signal.monitor/v1', id: newId('mon'), tenantId: p.tenantId, ownerId: p.subjectId, sourceId: source.id,
			criteriaId: input.criteriaId, criteriaVersion: input.criteriaVersion, destinations: input.destinations, enabled: true,
			createdAt: this.now().toISOString()
		};
		await this.store.putMonitor(m);
		return m;
	}

	async authorizeRun(p: Principal, monitorId: string): Promise<MonitorDefinition> {
		const m = await this.store.getMonitor(monitorId);
		if (!m) throw new Error(`Unknown monitor ${monitorId}`);
		await this.require(p, 'signal.monitor.run', { type: 'monitor', id: m.id, tenantId: m.tenantId, ownerId: m.ownerId });
		return m;
	}

	async listEvents(p: Principal, filter: { sourceLocator?: string; monitorId?: string } = {}): Promise<Array<MatchedEvent & { acknowledged: boolean }>> {
		await this.require(p, 'signal.event.read', { type: 'event', id: '*', tenantId: p.tenantId, ownerId: p.subjectId });
		const events = await this.store.listEvents({ ...filter, ownerId: p.permissions.includes('signal.admin') ? undefined : p.subjectId });
		return Promise.all(events.map(async (e) => ({ ...e, acknowledged: (await this.store.listAcks(e.eventId)).length > 0 })));
	}

	async getEvidence(p: Principal, eventId: string): Promise<{ event: MatchedEvent; normalizedText: string }> {
		const e = await this.store.getEvent(eventId);
		if (!e) throw new Error(`Unknown event ${eventId}`);
		await this.require(p, 'signal.evidence.read', { type: 'event', id: e.eventId, tenantId: e.tenantId, ownerId: e.ownerId });
		const text = new TextDecoder().decode(await this.store.getEvidence(e.evidence.normalizedTextRef));
		return { event: e, normalizedText: text };
	}

	async acknowledge(p: Principal, eventId: string): Promise<Acknowledgement> {
		const e = await this.store.getEvent(eventId);
		if (!e) throw new Error(`Unknown event ${eventId}`);
		await this.require(p, 'signal.event.ack', { type: 'event', id: e.eventId, tenantId: e.tenantId, ownerId: e.ownerId });
		const a: Acknowledgement = { schema: 'signal.ack/v1', ackId: newId('ack'), tenantId: e.tenantId, eventId, subjectId: p.subjectId, acknowledgedAt: this.now().toISOString() };
		await this.store.putAck(a);
		return a;
	}
}
