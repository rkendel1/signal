/** Helpers shared by Signal's FeltKit function modules (not loaded as functions). */
import { fail } from "@feltdb/feltkit";
import type { CriteriaDefinition, MatchedEvent, Observation } from "../lib/contracts/types.ts";
import { canonicalJson } from "../lib/core/canonical.ts";
import type { NetPolicy } from "../lib/sources/net-guard.ts";
import { GhostpostUnicodeDecoder } from "../lib/codecs/ghostpost-unicode.ts";
import { InvisibleUnicodeDetector } from "../lib/codecs/invisible-unicode.ts";

export const TENANT = "default"; // single-tenant app; FeltKit `auth.tenant` would scope this (GAP G-TEN-1)

/**
 * Hosts allowed to resolve to private addresses. Empty in production. Set
 * SIGNAL_ALLOW_PRIVATE_HOSTS=127.0.0.1 only for local demos and tests, where the
 * "website" is on loopback.
 */
export function netPolicy(): NetPolicy {
  const raw = process.env.SIGNAL_ALLOW_PRIVATE_HOSTS ?? "";
  return { allowPrivateHosts: raw.split(",").map((h) => h.trim()).filter(Boolean) };
}

let decoders: [GhostpostUnicodeDecoder, InvisibleUnicodeDetector] | undefined;
export function signalDecoders() {
  return (decoders ??= [new GhostpostUnicodeDecoder(), new InvisibleUnicodeDetector()]);
}

export const json = (v: unknown) => canonicalJson(v);
export const parse = <T>(s: string): T => JSON.parse(s) as T;

export function parseCriteria(definition: string): CriteriaDefinition {
  return parse<CriteriaDefinition>(definition);
}

export function requireFound<T>(v: T | null | undefined, what: string): T {
  if (!v) fail("NOT_FOUND", `${what} does not exist.`);
  return v as T;
}

/** Shape returned to clients for an event: the stored record id plus the signal.event/v1 body. */
export function eventView(rec: { id: string; body: string; acknowledgedAt?: string; acknowledgedBy?: string }) {
  const e = parse<MatchedEvent>(rec.body);
  return { id: rec.id, ...e, acknowledged: Boolean(rec.acknowledgedAt), acknowledgedAt: rec.acknowledgedAt ?? null };
}

export function observationFromRecord(r: Record<string, unknown>): Observation {
  return {
    schema: "signal.observation/v1", observationId: r.observationId as string, tenantId: TENANT, sourceId: r.sourceId as string,
    observedAt: r.observedAt as string, status: r.status as Observation["status"], evidenceRef: r.evidenceRef as string | undefined,
    contentHash: r.contentHash as string | undefined, contentType: r.contentType as string | undefined,
    byteLength: r.byteLength as number | undefined, provenance: parse(r.provenance as string),
    error: r.error ? parse(r.error as string) : undefined,
  };
}
