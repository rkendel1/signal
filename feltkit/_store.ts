/**
 * The one pipeline (not loaded as functions): ingest → change detection → identity → evaluation → findings.
 *
 * Everything runs inside the caller's mutation, so an ingestion, the observations it creates, the identity
 * links, the findings it changes and their history commit together or not at all. Evaluation is incremental:
 * only entities whose evidence changed are re-evaluated, except when the cause is a criteria change (that
 * criteria, every entity of its type) or a sweep.
 */
import { fail } from "@feltdb/feltkit";
import { canonicalJson, newId, sha256 } from "../lib/core/canonical.ts";
import { validateCriteria, type CriteriaDefinition } from "../lib/engine/criteria.ts";
import { areaKey, evaluate, type Areas, type Outcome } from "../lib/engine/evaluate.ts";
import { isLeaf, LOCATION, type AreaRef, type Condition } from "../lib/engine/criteria.ts";
import { addKeys, EntityIndex, emptyKeys, keysFrom, planIngestion, resolveIdentity } from "../lib/engine/identity.ts";
import { decide, priority, type Cause, type FindingState } from "../lib/engine/lifecycle.ts";
import { findingNotice, normalizePrefs, type NoticeKind, type NotificationPrefs, type Severity } from "../lib/engine/notify.ts";
import { draftHash } from "../lib/engine/mapping.ts";
import type { EntityEvidence, EntityInfo, EntityKeys, EvidenceRecord, LinkDecision, ObservationDraft, SourceInfo, StoredObservation } from "../lib/engine/types.ts";
import { criteria, criteriaVersions, entities, findingEvents, findings, ingestions, links, notices, observations, preferences, runs, sources } from "./app.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Ctx = any; // a FeltKit mutation context (db with writes, services, afterCommit, auth)
export type ReadCtx = any; // a FeltKit query context

export const json = (v: unknown) => canonicalJson(v);
export const parse = <T>(s: string | undefined | null, fallback?: T): T => (s ? (JSON.parse(s) as T) : (fallback as T));
export function requireFound<T>(v: T | null | undefined, what: string): T {
  if (!v) fail("NOT_FOUND", `${what} does not exist.`);
  return v as T;
}

// ------------------------------------------------------------------ records ↔ engine types

export function sourceInfo(r: any): SourceInfo {
  return { id: r.id, name: r.name, kind: r.kind, origin: r.origin, status: r.status, staleAfterDays: r.staleAfterDays ?? null, synthetic: r.synthetic };
}

export function storedObservation(r: any): StoredObservation {
  const b = parse<{ attributes: StoredObservation["attributes"]; identity: StoredObservation["identity"]; locator: string | null; keyBasis: StoredObservation["keyBasis"] }>(r.body);
  return {
    observationId: r.observationId, sourceId: r.sourceId, ingestionId: r.ingestionId, version: r.version, observedAt: r.observedAt,
    confirmedAt: r.confirmedAt ?? null, contentHash: r.contentHash, status: r.status, retractedAt: r.retractedAt ?? null, retractReason: r.retractReason ?? null,
    recordKey: r.recordKey, keyBasis: b.keyBasis, entityType: r.entityType, attributes: b.attributes, identity: b.identity, validAt: r.validAt ?? null, locator: b.locator,
  };
}

function entityInfo(r: any): EntityInfo {
  return { entityId: r.id, type: r.type, label: r.label ?? null, keys: parse<EntityKeys>(r.keys, emptyKeys()) };
}

const labelOf = (d: Pick<ObservationDraft, "identity" | "attributes">): string | null =>
  d.identity.address ?? d.identity.name ?? (typeof d.attributes.name?.value === "string" ? d.attributes.name.value : null) ?? Object.values(d.identity.ids)[0] ?? null;

// ------------------------------------------------------------------ evidence

/** Snapshot-mode sources re-confirm every current record at each successful refresh (missing ones are retracted). */
function confirmed(o: StoredObservation, src: any): string {
  if ((src.refreshMode === "snapshot" || src.refreshMode === "poll") && src.lastSuccessAt && src.lastSuccessAt > o.observedAt) return src.lastSuccessAt;
  return o.confirmedAt ?? o.observedAt;
}

/**
 * Loads entity evidence. For a few entities it reads per entity (indexed finds). For many it preloads the
 * owner's links and the involved sources' observations once: inside one transaction every read is fenced and
 * re-checked at commit, so thousands of small reads cost far more than a few large ones (docs/measurements.json).
 */
export class EvidenceLoader {
  private ctx: ReadCtx;
  private srcs = new Map<string, any>();
  private bulk: { ents: Map<string, any>; links: Map<string, any[]>; obs: Map<string, any[]> } | null = null;
  static BULK = 40;
  constructor(ctx: ReadCtx) { this.ctx = ctx; }
  async preload(ownerId: string, entityIds: string[]) {
    if (entityIds.length < EvidenceLoader.BULK) return;
    const want = new Set(entityIds);
    const ents = new Map<string, any>((await this.ctx.db.find(entities, { ownerId })).filter((e: any) => want.has(e.id)).map((e: any) => [e.id, e]));
    const byEnt = new Map<string, any[]>();
    for (const l of await this.ctx.db.find(links, { ownerId })) if (want.has(l.entityId)) (byEnt.get(l.entityId) ?? byEnt.set(l.entityId, []).get(l.entityId)!).push(l);
    const obs = new Map<string, any[]>();
    const sids = new Set([...byEnt.values()].flat().map((l: any) => l.sourceId as string));
    for (const sid of sids) for (const o of await this.ctx.db.find(observations, { sourceId: sid })) { const k = `${sid}\u0000${o.recordKey}`; (obs.get(k) ?? obs.set(k, []).get(k)!).push(o); }
    this.bulk = { ents, links: byEnt, obs };
  }
  get isBulk() { return this.bulk !== null; }
  private async source(id: string) { if (!this.srcs.has(id)) this.srcs.set(id, await this.ctx.db.get(sources, id)); return this.srcs.get(id); }
  async evidence(entityId: string): Promise<EntityEvidence | null> {
    const ent = this.bulk ? this.bulk.ents.get(entityId) : await this.ctx.db.get(entities, entityId);
    if (!ent) return null;
    const ls = this.bulk ? this.bulk.links.get(entityId) ?? [] : await this.ctx.db.find(links, { entityId });
    const records: EvidenceRecord[] = [];
    for (const l of ls) {
      const src = await this.source(l.sourceId);
      if (!src) continue;
      const raw = this.bulk ? this.bulk.obs.get(`${l.sourceId}\u0000${l.recordKey}`) ?? [] : await this.ctx.db.find(observations, { sourceId: l.sourceId, recordKey: l.recordKey });
      const versions = raw.map(storedObservation).sort((a: StoredObservation, b: StoredObservation) => a.version - b.version);
      const cur = versions.find((v: StoredObservation) => v.status === "current") ?? null;
      records.push({
        source: sourceInfo(src),
        link: { status: l.status, basis: l.basis, confidence: l.confidence },
        current: cur ? { ...cur, confirmedAt: confirmed(cur, src) } : null,
        history: versions.filter((v: StoredObservation) => v.status === "superseded"),
      });
    }
    return { entity: entityInfo(ent), records };
  }
}

export async function buildEvidence(ctx: ReadCtx, entityId: string): Promise<EntityEvidence | null> {
  return new EvidenceLoader(ctx).evidence(entityId);
}

// ------------------------------------------------------------------ entities and links

/** Recompute entities' identity keys, label and location from their records' current observations. */
async function recomputeEntities(ctx: Ctx, ownerId: string, entityIds: Iterable<string>): Promise<void> {
  const ids = [...new Set(entityIds)];
  const loader = new EvidenceLoader(ctx);
  await loader.preload(ownerId, ids);
  for (const id of ids) {
    const ev = await loader.evidence(id);
    if (!ev) continue;
    const parts = ev.records.filter((r) => r.current).map((r) => ({ identity: r.current!.identity, sourceId: r.source.id, draft: r.current! }));
    const keys = keysFrom(parts);
    const label = parts.map((p) => labelOf(p.draft)).find(Boolean) ?? ev.entity.label;
    const pt = keys.points[0];
    await ctx.db.patch(entities, id, { keys: json(keys), records: parts.length, ...(label ? { label } : {}), ...(pt ? { lat: pt.lat, lng: pt.lng } : {}) });
  }
}
const recomputeEntity = (ctx: Ctx, entityId: string) => recomputeEntities(ctx, "", [entityId]);

export class Resolver {
  private indexes = new Map<string, EntityIndex>();
  private recs = new Map<string, any>();
  private ctx: Ctx;
  private ownerId: string;
  constructor(ctx: Ctx, ownerId: string) { this.ctx = ctx; this.ownerId = ownerId; }
  async index(type: string): Promise<EntityIndex> {
    let ix = this.indexes.get(type);
    if (!ix) {
      const recs = await this.ctx.db.find(entities, { ownerId: this.ownerId, type });
      for (const r of recs) this.recs.set(r.id, r);
      ix = new EntityIndex(recs.map(entityInfo)); this.indexes.set(type, ix);
    }
    return ix;
  }
  /** Link a record (new, or with changed identity). Returns the entities affected. */
  async link(sourceId: string, d: ObservationDraft, now: string, existing?: any): Promise<string[]> {
    const ix = await this.index(d.entityType);
    const decision: LinkDecision = resolveIdentity(d, sourceId, ix, existing?.entityId);
    let entityId = decision.entityId;
    if (!entityId) {
      const keys = addKeys(emptyKeys(), d.identity, sourceId);
      const pt = keys.points[0];
      const rec = { type: d.entityType, ...(labelOf(d) ? { label: labelOf(d)! } : {}), keys: json(keys), records: 1, ...(pt ? { lat: pt.lat, lng: pt.lng } : {}), createdAt: now, ownerId: this.ownerId };
      entityId = await this.ctx.db.insert(entities, rec);
      this.recs.set(entityId!, { ...rec, id: entityId });
      ix.add({ entityId: entityId!, type: d.entityType, label: labelOf(d), keys });
    } else {
      const ent = this.recs.get(entityId) ?? await this.ctx.db.get(entities, entityId);
      const keys = addKeys(parse<EntityKeys>(ent.keys, emptyKeys()), d.identity, sourceId);
      this.recs.set(entityId, await this.ctx.db.patch(entities, entityId, { keys: json(keys), records: ent.records + 1 }));
      ix.remove(entityId); ix.add({ entityId, type: d.entityType, label: ent.label ?? null, keys });
    }
    const fields = { entityId: entityId!, status: decision.status, basis: decision.basis, confidence: decision.confidence, reason: decision.reason, options: json(decision.options), decidedBy: "system" as const, at: now };
    const affected = [entityId!];
    if (existing) {
      await this.ctx.db.patch(links, existing.id, fields);
      if (existing.entityId !== entityId) { await recomputeEntity(this.ctx, existing.entityId); affected.push(existing.entityId); }
    } else await this.ctx.db.insert(links, { sourceId, recordKey: d.recordKey, ...fields, ownerId: this.ownerId });
    return affected;
  }
}

// ------------------------------------------------------------------ ingestion

export interface IngestInput {
  source: any;
  drafts: ObservationDraft[];
  mode: "snapshot" | "partial";
  removed?: string[];
  trigger: "upload" | "refresh" | "push" | "capture" | "mapping" | "removal" | "create";
  rawRef?: string;
  rawHash?: string;
  provenance: Record<string, unknown>;
  issues?: unknown[];
  validAt?: string | null;
  causeKind?: Cause["kind"];
}

export async function ingest(ctx: Ctx, input: IngestInput) {
  const t0 = performance.now();
  const { source } = input;
  const now = new Date().toISOString();
  if (source.status === "removed") fail("FAILED_PRECONDITION", "This source was removed.");
  if (source.status === "paused" && input.trigger !== "mapping") fail("FAILED_PRECONDITION", "This source is paused; resume it to accept new information.");
  const owner = source.ownerId;
  const ingestionId = newId("ing");
  const drafts = input.drafts.map((d) => ({ ...d, validAt: d.validAt ?? input.validAt ?? null }));
  // A small partial update (a push, a capture) reads only the records it names: the live path costs what changed,
  // not the size of the source. A snapshot must read everything current to know what disappeared.
  const targeted = input.mode === "partial" && drafts.length + (input.removed?.length ?? 0) <= 200;
  const keys = [...new Set([...drafts.map((d) => d.recordKey), ...(input.removed ?? [])])];
  const currentRecs = targeted
    ? (await Promise.all(keys.map((k) => ctx.db.find(observations, { sourceId: source.id, recordKey: k })))).flat().filter((r: any) => r.status === "current")
    : await ctx.db.find(observations, { sourceId: source.id, status: "current" });
  const byKey = new Map<string, any>(currentRecs.map((r: any) => [r.recordKey, r]));
  const plan = planIngestion(currentRecs.map((r: any) => ({ recordKey: r.recordKey, contentHash: r.contentHash, version: r.version })), drafts.map((d) => ({ draft: d, hash: draftHash(d) })), input.mode, input.removed);

  const affected = new Set<string>();
  const toRecompute = new Set<string>();
  const resolver = new Resolver(ctx, owner);
  // One read of the source's links instead of one per record (see EvidenceLoader).
  const linkByKey = new Map<string, any>((targeted ? (await Promise.all(keys.map((k) => ctx.db.find(links, { sourceId: source.id, recordKey: k })))).flat() : await ctx.db.find(links, { sourceId: source.id })).map((l: any) => [l.recordKey, l]));
  const pageUrl = typeof input.provenance.url === "string" && input.trigger === "capture" ? normalizeUrl(input.provenance.url) : null;
  const urlsOf = (d: ObservationDraft) => {
    const own = [d.attributes.url?.value, d.identity.ids.url].find((v) => typeof v === "string" && /^https?:/i.test(v)) as string | undefined;
    return { ...(own ? { url: normalizeUrl(own) } : {}), ...(pageUrl ? { pageUrl } : {}) };
  };
  const write = async (d: ObservationDraft, version: number) => {
    await ctx.db.insert(observations, {
      observationId: newId("obs"), sourceId: source.id, recordKey: d.recordKey, version, ingestionId, status: "current", entityType: d.entityType,
      observedAt: now, ...(d.validAt ? { validAt: d.validAt } : {}), contentHash: draftHash(d), ...urlsOf(d),
      body: json({ attributes: d.attributes, identity: d.identity, locator: d.locator, keyBasis: d.keyBasis }), ownerId: owner,
    });
  };
  for (const d of plan.added) {
    const existingLink = linkByKey.get(d.recordKey);
    // A record seen before (now retracted) continues its version numbering.
    const earlier = existingLink ? await ctx.db.find(observations, { sourceId: source.id, recordKey: d.recordKey }) : [];
    await write(d, earlier.reduce((m: number, r: any) => Math.max(m, r.version), 0) + 1);
    if (existingLink) { // a record that was retracted and has come back
      if (existingLink.decidedBy === "user") { affected.add(existingLink.entityId); toRecompute.add(existingLink.entityId); }
      else for (const e of await resolver.link(source.id, d, now, existingLink)) affected.add(e);
    } else for (const e of await resolver.link(source.id, d, now)) affected.add(e);
  }
  for (const { draft, previous } of plan.changed) {
    const prev = byKey.get(previous.recordKey);
    await ctx.db.patch(observations, prev.id, { status: "superseded" });
    await write(draft, previous.version + 1);
    const l = linkByKey.get(draft.recordKey);
    const idChanged = !l || json(storedObservation(prev).identity) !== json(draft.identity);
    if (l && (!idChanged || l.decidedBy === "user")) { affected.add(l.entityId); if (idChanged) toRecompute.add(l.entityId); }
    else for (const e of await resolver.link(source.id, draft, now, l)) affected.add(e);
  }
  for (const r of plan.retracted) {
    const rec = byKey.get(r.recordKey);
    await ctx.db.patch(observations, rec.id, { status: "retracted", retractedAt: now, retractReason: input.trigger === "removal" ? "source removed" : input.mode === "snapshot" ? "absent from the latest snapshot" : "removed by the source" });
    const l = linkByKey.get(r.recordKey);
    if (l) { affected.add(l.entityId); toRecompute.add(l.entityId); }
  }
  await recomputeEntities(ctx, owner, toRecompute);
  // Unchanged records are re-confirmed. A changed as-of date alone is freshness, not new information:
  // the observation keeps its version, its as-of is updated, and its entity is re-evaluated (staleness may change).
  const draftByKey = new Map(drafts.map((d) => [d.recordKey, d]));
  let reconfirmed = 0;
  for (const k of plan.unchangedKeys) {
    const rec = byKey.get(k), validAt = draftByKey.get(k)!.validAt ?? undefined;
    if ((rec.validAt ?? undefined) !== validAt) {
      await ctx.db.patch(observations, rec.id, { validAt, confirmedAt: now });
      const l = linkByKey.get(k);
      if (l) affected.add(l.entityId);
      reconfirmed++;
    } else if (input.mode === "partial" && plan.unchangedKeys.length <= 500) await ctx.db.patch(observations, rec.id, { confirmedAt: now });
  }

  const added = plan.added.length, changed = plan.changed.length, retracted = plan.retracted.length;
  const seq = await ctx.db.sequence(`signal.ingestions:${source.id}`);
  const ingestionRecordId = await ctx.db.insert(ingestions, {
    ingestionId, sourceId: source.id, seq, at: now, trigger: input.trigger, status: "ok", ...(input.rawRef ? { rawRef: input.rawRef } : {}), ...(input.rawHash ? { rawHash: input.rawHash } : {}),
    mappingVersion: source.mappingVersion, received: drafts.length, added, changed, unchanged: plan.unchanged, retracted,
    issues: json({ count: input.issues?.length ?? 0, first: (input.issues ?? []).slice(0, 50) }), provenance: json({ ...input.provenance, ingestionId }), durationMs: Math.round(performance.now() - t0), ownerId: owner,
  });
  const count = targeted ? source.records + added - retracted : await ctx.db.count(observations, { sourceId: source.id, status: "current" });
  await ctx.db.patch(sources, source.id, {
    records: count, lastRefreshAt: now, lastSuccessAt: now, ...(added + changed + retracted ? { lastChangeAt: now } : {}),
    ...(source.status === "unavailable" ? { status: "connected", statusReason: undefined } : {}), lastError: undefined,
  });

  if (source.status === "unavailable") await addNotice(ctx, { kind: "source_recovered", severity: "info", priority: 10, title: `Available again: ${source.name}`, body: `${source.name} answered again after: ${source.statusReason ?? "a failure"}.`, sourceId: source.id, dedupKey: `source:${source.id}:recovered:${source.lastRefreshAt ?? ""}` }, owner, now);
  const newInfo = added + changed + retracted > 0;
  const freshnessChanged = reconfirmed > 0;
  const kind: Cause["kind"] = input.causeKind ?? (input.trigger === "removal" ? "source_removed" : input.trigger === "mapping" ? "mapping" : retracted && !added && !changed ? "retraction" : "ingestion");
  const run = newInfo || freshnessChanged ? await evaluateEntities(ctx, owner, [...affected], { kind: newInfo ? kind : "time", ref: ingestionRecordId, label: `${source.name}: ${describeIngestion(input.trigger, added, changed, retracted)}${freshnessChanged ? `; as-of date changed on ${reconfirmed} unchanged records` : ""}` }) : null;
  return { ingestionId: ingestionRecordId, received: drafts.length, added, changed, unchanged: plan.unchanged, retracted, reconfirmed, newInformation: newInfo, affectedEntities: affected.size, run };
}

function describeIngestion(trigger: string, a: number, c: number, r: number): string {
  const parts = [a && `${a} new`, c && `${c} changed`, r && `${r} withdrawn`].filter(Boolean);
  return `${trigger} — ${parts.join(", ") || "no new information"}`;
}

// ------------------------------------------------------------------ evaluation

export async function loadCriteria(ctx: ReadCtx, ownerId: string, onlyId?: string): Promise<Array<{ rec: any; def: CriteriaDefinition; version: number }>> {
  const recs = onlyId ? [await ctx.db.get(criteria, onlyId)].filter(Boolean) : await ctx.db.find(criteria, { ownerId, enabled: true, removed: false });
  const out = [];
  for (const rec of recs) {
    const [v] = await ctx.db.find(criteriaVersions, { criteriaId: rec.id, version: rec.activeVersion });
    if (v) out.push({ rec, def: validateCriteria(parse<CriteriaDefinition>(v.definition)), version: rec.activeVersion });
  }
  return out;
}

/** The areas criteria refer to, loaded from their (owner's) source records. Missing → null: the condition is unknown. */
export async function loadAreas(ctx: ReadCtx, ownerId: string, defs: CriteriaDefinition[]): Promise<Areas> {
  const refs: AreaRef[] = [];
  const walk = (c: Condition) => { if (isLeaf(c)) { if (c.attr === LOCATION && c.op === "within") refs.push(c.value as AreaRef); } else ("all" in c ? c.all : c.any).forEach(walk); };
  for (const d of defs) [...d.require, ...(d.exclude ?? []), ...(d.prefer ?? []).map((p) => p.when)].forEach(walk);
  const areas: Areas = new Map();
  for (const r of refs) {
    const k = areaKey(r);
    if (areas.has(k)) continue;
    const src = await ctx.db.get(sources, r.sourceId);
    const [o] = src && src.ownerId === ownerId && src.status !== "removed" ? await ctx.db.find(observations, { sourceId: r.sourceId, recordKey: r.recordKey, status: "current" }) : [];
    const obs = o ? storedObservation(o) : null;
    const geometry = obs?.identity.geometry ?? (obs && obs.identity.lat !== null ? { point: { lat: obs.identity.lat, lng: obs.identity.lng! } } : null);
    areas.set(k, geometry ? { geometry, label: obs!.identity.name ?? obs!.identity.address ?? r.recordKey, sourceName: src!.name, observationId: obs!.observationId } : null);
  }
  return areas;
}

// ------------------------------------------------------------------ notices

export async function loadPrefs(ctx: ReadCtx, ownerId: string): Promise<NotificationPrefs> {
  const [p] = await ctx.db.find(preferences, { ownerId });
  return normalizePrefs(p ? parse(p.prefs) : null);
}

const short = (v: unknown): string => {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object" && v && "amount" in (v as object)) return String((v as { amount: number }).amount);
  const t = typeof v === "object" ? JSON.stringify(v) : String(v);
  return t.length > 40 ? `${t.slice(0, 37)}…` : t;
};

/** Web addresses an entity's records name: how the overlay recognises "this page is about that". */
export function entityUrls(ev: EntityEvidence): string[] {
  const out = new Set<string>();
  for (const r of ev.records) {
    const o = r.current;
    if (!o) continue;
    for (const v of [o.attributes.url?.value, o.identity.ids.url]) if (typeof v === "string" && /^https?:/i.test(v)) out.add(normalizeUrl(v));
  }
  return [...out].slice(0, 5);
}
export function normalizeUrl(u: string): string {
  try { const x = new URL(u); x.hash = ""; const s = x.toString(); return s.endsWith("/") && x.pathname !== "/" ? s.slice(0, -1) : s; } catch { return u; }
}

export interface NoticeInput { kind: NoticeKind; severity: Severity; priority: number; title: string; body: string; findingId?: string; sourceId?: string; entityId?: string; urls?: string[]; dedupKey: string; snoozedUntil?: string }
/** Record a notice once: the same dedupKey never notifies twice. */
export async function addNotice(ctx: Ctx, n: NoticeInput, ownerId: string, now: string): Promise<string | null> {
  const [dup] = await ctx.db.find(notices, { dedupKey: n.dedupKey });
  if (dup) return null;
  return ctx.db.insert(notices, { ...n, urls: n.urls ?? [], createdAt: now, ownerId });
}

export interface RunSummary { runId: string; entities: number; evaluations: number; created: number; changed: number; closed: number; reopened: number; durationMs: number }

/**
 * Re-evaluate entities against enabled criteria and apply the finding lifecycle. `onlyCriteriaId` limits it to
 * one criteria (a criteria change); `forceCriteria` evaluates a disabled/removed criteria to close its findings.
 */
export async function evaluateEntities(ctx: Ctx, ownerId: string, entityIds: string[], cause: Cause, opts: { onlyCriteriaId?: string; criteriaOverride?: Array<{ rec: any; def: CriteriaDefinition; version: number }> } = {}): Promise<RunSummary> {
  const t0 = performance.now();
  const now = new Date().toISOString();
  const runSeq = await ctx.db.sequence(`signal.runs:${ownerId}`);
  const runId = newId("run");
  const crits = opts.criteriaOverride ?? (await loadCriteria(ctx, ownerId, opts.onlyCriteriaId)).filter((c) => c.rec.enabled && !c.rec.removed);
  const sum: RunSummary = { runId, entities: 0, evaluations: 0, created: 0, changed: 0, closed: 0, reopened: 0, durationMs: 0 };
  const ids = [...new Set(entityIds)];
  const areas = await loadAreas(ctx, ownerId, crits.map((c) => c.def));
  const prefs = await loadPrefs(ctx, ownerId);
  const loader = new EvidenceLoader(ctx);
  await loader.preload(ownerId, ids);
  const existing = new Map<string, any>();
  if (loader.isBulk) for (const c of crits) for (const f of await ctx.db.find(findings, { criteriaId: c.rec.id })) existing.set(`${c.rec.id}\u0000${f.entityId}`, f);
  for (const entityId of ids) {
    const ev = await loader.evidence(entityId);
    if (!ev) continue;
    sum.entities++;
    for (const c of crits) {
      if (c.def.entityType !== ev.entity.type) continue;
      sum.evaluations++;
      const o = evaluate(ev, c.def, now, areas);
      const r = await applyOutcome(ctx, { ownerId, criteria: c, ev, o, cause, now, runId, prefs, existing: loader.isBulk ? existing.get(`${c.rec.id}\u0000${entityId}`) ?? null : undefined });
      if (r === "new") sum.created++; else if (r === "changed") sum.changed++; else if (r === "closed") sum.closed++; else if (r === "reopened") sum.reopened++;
    }
  }
  sum.durationMs = Math.round(performance.now() - t0);
  await ctx.db.insert(runs, { runId, seq: runSeq, at: now, cause: json({ ...cause, runId }), causeKind: cause.kind, entities: sum.entities, evaluations: sum.evaluations, created: sum.created, changed: sum.changed, closed: sum.closed, reopened: sum.reopened, durationMs: sum.durationMs, ownerId });
  return sum;
}

async function applyOutcome(ctx: Ctx, a: { ownerId: string; criteria: { rec: any; def: CriteriaDefinition; version: number }; ev: EntityEvidence; o: Outcome; cause: Cause; now: string; runId: string; existing?: any; prefs?: NotificationPrefs }): Promise<"new" | "changed" | "closed" | "reopened" | "none"> {
  const { o, now, criteria: c } = a;
  const existing = a.existing !== undefined ? a.existing : (await ctx.db.find(findings, { criteriaId: c.rec.id, entityId: a.ev.entity.entityId }))[0];
  const prev: FindingState | null = existing ? { ...parse<FindingState>(existing.state), status: existing.status, change: existing.change, qualification: existing.qualification } : null;
  const d = decide(prev, o, a.cause, c.def, c.version);
  if (!d.next) return "none";
  const synthetic = a.ev.records.some((r) => r.current && r.source.synthetic && o.evidenceIds.includes(r.current.observationId));
  const fields = {
    status: d.next.status, change: d.next.change, qualification: d.next.qualification, criteriaVersion: c.version, score: o.score, confidence: o.confidence,
    summary: o.summary, ...(a.ev.entity.label ? { entityLabel: a.ev.entity.label } : {}), explanation: json(o),
    state: json({ criteriaVersion: d.next.criteriaVersion, results: d.next.results, eventValues: d.next.eventValues }),
    hasConflict: o.conflicts.some((x) => !x.resolvedBy), hasStale: o.stale.length > 0, hasMissing: o.missing.length > 0, synthetic, sourceCount: o.sources.length, lastEvaluatedAt: now,
    ...(d.event && d.event.kind !== "persistent" ? { lastChangedAt: now } : {}),
    // A meaningful change re-opens a person's attention: acknowledgement is per state, not forever.
    ...(d.event && ["changed", "reopened"].includes(d.event.kind) ? { acknowledgedAt: undefined } : {}),
  };
  let findingId: string;
  if (existing) { findingId = existing.id; await ctx.db.patch(findings, existing.id, fields); }
  else findingId = await ctx.db.insert(findings, { criteriaId: c.rec.id, entityId: a.ev.entity.entityId, firstDetectedAt: now, lastChangedAt: now, ...fields, ownerId: a.ownerId });
  if (d.event) {
    const seq = await ctx.db.sequence(`signal.finding:${findingId}`);
    await ctx.db.insert(findingEvents, {
      findingId, seq, at: now, kind: d.event.kind, criteriaVersion: c.version, cause: json(a.cause), runId: a.runId, reason: d.event.reason,
      diff: json(d.event.diff), evidenceIds: json(o.evidenceIds), qualification: d.next.qualification, ownerId: a.ownerId,
    });
  }
  if (d.event && d.event.kind !== "persistent" && a.prefs) {
    const kind = findingNotice(d.event.kind, d.next.qualification, c.def, a.prefs);
    if (kind) {
      const label = a.ev.entity.label ?? a.ev.entity.entityId;
      const what = { finding_new: "New", finding_changed: "Changed", finding_resolved: "Resolved", finding_reopened: "Reopened", finding_closed: "Closed" }[kind as string] ?? kind;
      const diff = d.event.diff.filter((x) => !x.what.startsWith("condition")).slice(0, 3).map((x) => `${x.what}: ${short(x.from)} → ${short(x.to)}`).join("; ");
      const snoozed = existing?.snoozedUntil && existing.snoozedUntil > now ? existing.snoozedUntil : undefined;
      await addNotice(ctx, {
        kind, severity: c.def.severity, priority: priority({ score: o.score, confidence: o.confidence, lastChangedAt: now, status: d.next.status, acknowledged: false }, now).value,
        title: `${what}: ${label}`.slice(0, 200), body: `${c.rec.name} — ${diff || o.summary}`.slice(0, 600),
        findingId, entityId: a.ev.entity.entityId, urls: entityUrls(a.ev),
        dedupKey: `finding:${findingId}:${d.event.kind}:${sha256(json([d.event.diff, d.next.qualification])).slice(0, 16)}`, ...(snoozed ? { snoozedUntil: snoozed } : {}),
      }, a.ownerId, now);
    }
  }
  if (!d.event || d.event.kind === "persistent") return "none";
  if (d.event.kind === "new") return "new";
  if (d.event.kind === "reopened") return "reopened";
  if (d.event.kind === "changed") return "changed";
  return "closed";
}

/** User identity decisions: move a record to an entity (or to one of its own) and re-evaluate both sides. */
export async function relink(ctx: Ctx, link: any, target: string | null, ownerId: string, reason: string) {
  const now = new Date().toISOString();
  const from = link.entityId;
  let to = target;
  if (!to) {
    const [cur] = await ctx.db.find(observations, { sourceId: link.sourceId, recordKey: link.recordKey, status: "current" });
    const o = cur ? storedObservation(cur) : null;
    to = await ctx.db.insert(entities, { type: o?.entityType ?? "unknown", ...(o && labelOf(o) ? { label: labelOf(o)! } : {}), keys: json(emptyKeys()), records: 0, createdAt: now, ownerId });
  }
  await ctx.db.patch(links, link.id, { entityId: to, status: "manual", basis: "user", confidence: 1, reason, decidedBy: "user", at: now });
  await recomputeEntity(ctx, from);
  await recomputeEntity(ctx, to!);
  return evaluateEntities(ctx, ownerId, [from, to!], { kind: "identity", ref: link.id, label: reason });
}
