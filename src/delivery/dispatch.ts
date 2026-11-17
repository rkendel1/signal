import { createHmac } from 'node:crypto';
import type { AlertDestination, AlertDispatcher, DeliveryAttempt, DeliveryResult, MatchedEvent } from '../contracts/types.ts';
import { contentId, newId } from '../core/canonical.ts';
import { BlockedUrlError, guardedFetch, type NetPolicy } from '../sources/net-guard.ts';
import type { SignalStore } from '../store/feltdb-store.ts';

const SEVERITY = { info: 0, warning: 1, critical: 2 } as const;

/** Host-provided secret lookup (Resolver `secret` refs in production). Signal never stores secrets. */
export type SecretResolver = (ref: string) => Promise<string | undefined>;

/**
 * Webhook delivery. Body is the MatchedEvent JSON; headers carry an idempotency
 * key (stable across retries) and an HMAC-SHA256 signature over `timestamp.body`.
 */
export class WebhookDispatcher implements AlertDispatcher {
	readonly type = 'webhook' as const;
	private secrets: SecretResolver;
	private policy: NetPolicy;
	private timeoutMs: number;
	constructor(secrets: SecretResolver, policy: NetPolicy = {}, timeoutMs = 10_000) { this.secrets = secrets; this.policy = policy; this.timeoutMs = timeoutMs; }

	async dispatch(event: MatchedEvent, dest: AlertDestination, ctx: { idempotencyKey: string; attempt: number }): Promise<DeliveryResult> {
		const body = JSON.stringify(event);
		const ts = String(Math.floor(Date.now() / 1000));
		const headers: Record<string, string> = {
			'content-type': 'application/json',
			'user-agent': 'BoundrySignal/0.1',
			'x-signal-event-id': event.eventId,
			'idempotency-key': ctx.idempotencyKey,
			'x-signal-attempt': String(ctx.attempt),
			'x-signal-timestamp': ts
		};
		if (dest.secretRef) {
			const secret = await this.secrets(dest.secretRef);
			if (!secret) return { status: 'failed', retryable: false, detail: `Signing secret ${dest.secretRef} unavailable` };
			headers['x-signal-signature'] = 'sha256=' + createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
		}
		try {
			const { response } = await guardedFetch(dest.target, { method: 'POST', headers, body, timeoutMs: this.timeoutMs, maxBytes: 64_000, maxRedirects: 0 }, this.policy);
			if (response.status >= 200 && response.status < 300) return { status: 'delivered', retryable: false, responseStatus: response.status };
			const retryable = response.status >= 500 || response.status === 429 || response.status === 408;
			return { status: 'failed', retryable, responseStatus: response.status, detail: `HTTP ${response.status}` };
		} catch (e) {
			const blocked = e instanceof BlockedUrlError;
			return { status: 'failed', retryable: !blocked, detail: (e as Error).message };
		}
	}
}

/**
 * In-app inbox. The MatchedEvent is already durable in FeltDB and readable via
 * the API/overlay; "delivery" records that it is available to the owner.
 */
export class InboxDispatcher implements AlertDispatcher {
	readonly type = 'inbox' as const;
	async dispatch(event: MatchedEvent, dest: AlertDestination): Promise<DeliveryResult> {
		if (dest.target !== event.ownerId) return { status: 'failed', retryable: false, detail: 'Inbox destination must be the monitor owner' };
		return { status: 'delivered', retryable: false };
	}
}

function inQuietHours(dest: AlertDestination, at: Date): boolean {
	const q = dest.quietHours;
	if (!q) return false;
	const local = new Date(at.getTime() + q.timeZoneOffsetMinutes * 60_000).getUTCHours();
	return q.startHour <= q.endHour ? local >= q.startHour && local < q.endHour : local >= q.startHour || local < q.endHour;
}

export interface DeliveryPolicy {
	maxAttempts: number;
	/** Delay before attempt n (n ≥ 2). Injected so tests do not sleep. */
	backoffMs: (attempt: number) => number;
	sleep: (ms: number) => Promise<void>;
}

export const defaultDeliveryPolicy: DeliveryPolicy = {
	maxAttempts: 4,
	backoffMs: (n) => Math.min(30_000, 500 * 2 ** (n - 2)),
	sleep: (ms) => new Promise((r) => setTimeout(r, ms))
};

/**
 * Deliver one event to its destinations. Idempotent: a destination that already
 * has a `delivered` (or `suppressed`) attempt for this event is skipped, so
 * reprocessing never re-notifies. Every attempt is a durable DeliveryAttempt.
 * A failed delivery never removes or alters the event.
 */
export async function deliverEvent(
	store: SignalStore,
	event: MatchedEvent,
	destinations: AlertDestination[],
	dispatchers: Partial<Record<AlertDestination['type'], AlertDispatcher>>,
	policy: DeliveryPolicy = defaultDeliveryPolicy,
	now: () => Date = () => new Date()
): Promise<DeliveryAttempt[]> {
	const prior = await store.listDeliveries(event.eventId);
	const written: DeliveryAttempt[] = [];
	for (const dest of destinations) {
		const mine = prior.filter((p) => p.destinationId === dest.id);
		if (mine.some((p) => p.status === 'delivered' || p.status === 'suppressed')) continue;
		const idempotencyKey = contentId('dlv', { eventId: event.eventId, destinationId: dest.id });
		const record = async (attempt: number, r: DeliveryResult) => {
			const a: DeliveryAttempt = {
				schema: 'signal.delivery/v1', attemptId: newId('att'), tenantId: event.tenantId, eventId: event.eventId,
				destinationId: dest.id, attempt, attemptedAt: now().toISOString(), status: r.status, retryable: r.retryable,
				detail: r.detail, responseStatus: r.responseStatus, idempotencyKey
			};
			await store.putDelivery(a);
			written.push(a);
		};
		let attempt = mine.length;
		if (dest.minSeverity && SEVERITY[event.severity] < SEVERITY[dest.minSeverity]) {
			await record(attempt + 1, { status: 'suppressed', retryable: false, detail: `severity ${event.severity} below ${dest.minSeverity}` });
			continue;
		}
		if (inQuietHours(dest, now())) {
			// Not suppressed permanently: no attempt is recorded, a later delivery pass will send it.
			continue;
		}
		const dispatcher = dispatchers[dest.type];
		if (!dispatcher) {
			await record(attempt + 1, { status: 'failed', retryable: false, detail: `No dispatcher configured for ${dest.type}` });
			continue;
		}
		// Each delivery pass gets up to maxAttempts tries; attempt numbers continue across passes.
		for (let tries = 1; tries <= policy.maxAttempts; tries++) {
			attempt++;
			if (tries > 1) await policy.sleep(policy.backoffMs(tries));
			const r = await dispatcher.dispatch(event, dest, { idempotencyKey, attempt });
			await record(attempt, r);
			if (r.status === 'delivered' || !r.retryable) break;
		}
	}
	return written;
}
