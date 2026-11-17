/** Helpers shared by Signal's FeltKit function modules (not loaded as functions). */
import { fail } from "@feltdb/feltkit";
import { gunzipSync, gzipSync } from "node:zlib";
import type { CriteriaDefinition, MatchedEvent, Observation } from "../lib/contracts/types.ts";
import { canonicalJson } from "../lib/core/canonical.ts";
import type { NetPolicy } from "../lib/sources/net-guard.ts";
import { GhostpostUnicodeDecoder } from "../lib/codecs/ghostpost-unicode.ts";
import { InvisibleUnicodeDetector } from "../lib/codecs/invisible-unicode.ts";
import { extractPage } from "../lib/page/extract.ts";
import type { PageRepresentation } from "../lib/page/types.ts";
import { observations, pages } from "./app.js";


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

// ------------------------------------------------------------------ observations + page representations


export const isHtml = (contentType: string | undefined) => /html/i.test(contentType ?? "");

type MutationCtx = {
  db: { insert: (c: never, v: never) => Promise<string>; find: (c: never, f?: never) => Promise<any[]> };
  services: { files: { upload: (f: { name: string; contentType: string; content: string | Uint8Array; metadata: Record<string, string> }) => Promise<{ id: string }>; read: (id: string) => Promise<{ text: () => string | Promise<string> }> } };
};

/** Store the exact observed bytes in Files and the observation record. Returns the evidence ref. */
export async function storeObservation(ctx: MutationCtx, obs: Observation, body: string | undefined, ownerId: string, monitorId?: string): Promise<void> {
  if (obs.status === "ok" && body !== undefined && !obs.evidenceRef) {
    const f = await ctx.services.files.upload({
      name: `${obs.observationId}.raw`, contentType: obs.contentType ?? "text/plain", content: body,
      metadata: { kind: "signal.evidence.raw", observationId: obs.observationId, sha256: obs.contentHash! },
    });
    obs.evidenceRef = `files:${f.id}`;
  }
  await ctx.db.insert(observations as never, {
    observationId: obs.observationId, sourceId: obs.sourceId, ...(monitorId ? { monitorId } : {}), observedAt: obs.observedAt, status: obs.status,
    ...(obs.evidenceRef ? { evidenceRef: obs.evidenceRef } : {}), ...(obs.contentHash ? { contentHash: obs.contentHash } : {}),
    ...(obs.contentType ? { contentType: obs.contentType } : {}), ...(obs.byteLength !== undefined ? { byteLength: obs.byteLength } : {}),
    provenance: json(obs.provenance), ...(obs.error ? { error: json(obs.error) } : {}), ownerId,
  } as never);
}

/** Build signal.page/v1 for an HTML observation, store it in Files, and index it. */
export async function storePage(ctx: MutationCtx, obs: Observation, body: string, source: { id: string; locator: string }, ownerId: string): Promise<{ representation: PageRepresentation; ref: string; recordId: string }> {
  const baseUrl = obs.provenance.finalUrl ?? (/^https?:/i.test(source.locator) ? source.locator : null);
  const representation = extractPage({
    html: body, locator: source.locator, baseUrl, observationId: obs.observationId, contentHash: obs.contentHash!,
    contentType: obs.contentType ?? null, observedAt: obs.observedAt, decoders: signalDecoders(),
  });
  // Stored as gzip of the canonical JSON: the same document, ~10x smaller (docs/storage-options.json).
  const f = await ctx.services.files.upload({
    name: `${obs.observationId}.page.json.gz`, contentType: "application/gzip", content: new Uint8Array(gzipSync(json(representation))),
    metadata: { kind: "signal.page", encoding: "gzip", observationId: obs.observationId, revision: representation.revision, factsRevision: representation.factsRevision, schema: representation.schema },
  });
  const ref = `files:${f.id}`;
  const recordId = await ctx.db.insert(pages as never, {
    observationId: obs.observationId, sourceId: source.id, locator: source.locator, observedAt: obs.observedAt,
    revision: representation.revision, extractorVersion: representation.extractorVersion, pageRef: ref,
    entities: representation.entities.length, relationships: representation.relationships.length,
    collections: representation.collections.length, signals: representation.signals.length, truncated: representation.stats.truncated, ownerId,
  } as never);
  return { representation, ref, recordId };
}

export async function readPage(ctx: MutationCtx, ref: string): Promise<PageRepresentation> {
  const f = await ctx.services.files.read(ref.replace(/^files:/, "")) as unknown as { bytes: Uint8Array; text: () => string };
  // gzip magic (1f 8b) ⇒ compressed canonical JSON; otherwise a pre-M7 uncompressed representation.
  const raw = f.bytes[0] === 0x1f && f.bytes[1] === 0x8b ? gunzipSync(f.bytes).toString("utf8") : f.text();
  return parse<PageRepresentation>(raw);
}
