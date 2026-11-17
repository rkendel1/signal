import { fail, s } from "@feltdb/feltkit";
import { gunzipSync, gzipSync } from "node:zlib";
import { app, datasets, datasetVersions } from "./app.js";
import { MAX_PAGE_FILE_BYTES, json, parse, requireFound } from "./_shared.js";
import { sha256 } from "../lib/core/canonical.ts";
import { applyMapping, inspectDataset, parseDataset, validateMapping, type DatasetMapping, type ParsedDataset } from "../lib/datasets/dataset.ts";
import type { DatasetSource } from "../lib/datasets/resolve.ts";

/**
 * User-owned datasets (a parcel file, a rent survey). Signal keeps the exact bytes imported, proposes a
 * mapping to Signal's vocabulary, and uses the data in discovery only after a person has reviewed the mapping.
 * Provider credentials, databases and APIs are a later adapter over the same record shapes; none is stored here.
 */

const MAX_CONTENT = 8_000_000;
const Fmt = s.union([s.literal("csv"), s.literal("geojson")]);
const Fresh = s.union([s.literal("static"), s.literal("periodic"), s.literal("live")]);
const open = { additionalProperties: true } as const;

type Ctx = Parameters<Parameters<typeof app.query>[0]["handler"]>[0];
type Rec = { id: string; datasetId: string; version: number; rawRef: string; rawHash: string; format: "csv" | "geojson"; rows: number; mapping: string; reviewed: boolean; dataAsOf?: string; retrievedAt: string; ownerId: string };

export async function loadParsed(ctx: Ctx, v: Pick<Rec, "rawRef" | "format">): Promise<ParsedDataset> {
  const f = await (ctx as never as { services: { files: { read: (id: string) => Promise<{ bytes: Uint8Array }> } } }).services.files.read(v.rawRef.replace(/^files:/, ""));
  return parseDataset(gunzipSync(f.bytes).toString("utf8"), v.format);
}

async function ownDataset(ctx: Ctx, datasetId: string) {
  const principal = ctx.auth.requirePrincipal();
  const d = requireFound(await ctx.db.get(datasets, datasetId), "That dataset");
  if (d.ownerId !== principal.id && !(principal as { roles?: string[] }).roles?.includes("admin")) fail("FORBIDDEN", "not the owner of that dataset");
  return d;
}

async function versionsOf(ctx: Ctx, datasetId: string): Promise<Rec[]> {
  return ((await ctx.db.find(datasetVersions, { datasetId })) as Rec[]).sort((a, b) => a.version - b.version);
}

/** What a person reviews: the file's real columns, the proposed mapping, and records before and after normalization. */
async function review(ctx: Ctx, v: Rec) {
  const parsed = await loadParsed(ctx, v);
  const inspection = inspectDataset(parsed);
  const mapping = parse<DatasetMapping>(v.mapping);
  const mapped = applyMapping(parsed, mapping);
  return {
    version: v.version, reviewed: v.reviewed, format: v.format, rows: v.rows, fields: inspection.fields, proposals: inspection.proposals, unmapped: mapped.unmapped,
    mapping, issues: mapped.issues.slice(0, 50), issueCount: mapped.issues.length,
    preview: parsed.rows.slice(0, 5).map((r, i) => ({ raw: r.props, mapped: { id: mapped.records[i].hasId ? mapped.records[i].recordId : null, address: mapped.records[i].address, latitude: mapped.records[i].lat, longitude: mapped.records[i].lng, ...mapped.records[i].attributes } })),
  };
}
const Review = s.object({}, open);

/** Import a CSV or GeoJSON file. The mapping is proposed, not applied: nothing is used in discovery until it is accepted. */
export const importDataset = app.mutation({
  access: "signal.datasets.write",
  args: {
    name: s.string({ minLength: 1, maxLength: 200 }),
    format: Fmt,
    content: s.string({ minLength: 1, maxLength: MAX_CONTENT }),
    freshness: s.optional(Fresh),
    /** When the provider says the data was true (ISO date). Omit when unknown; it is never guessed. */
    dataAsOf: s.optional(s.string({ maxLength: 40 })),
  },
  returns: s.object({ datasetId: s.string(), versionId: s.string(), version: s.integer(), review: Review }),
  capability: { name: "signal.datasets.import", description: "Import a user-owned CSV or GeoJSON dataset. Signal keeps the exact bytes, profiles the columns and proposes a mapping to its vocabulary for review." },
  handler: async (ctx, a) => {
    let parsed: ParsedDataset;
    try { parsed = parseDataset(a.content, a.format); } catch (e) { fail("INVALID_ARGUMENT", (e as Error).message); }
    if (a.dataAsOf !== undefined && Number.isNaN(Date.parse(a.dataAsOf))) fail("INVALID_ARGUMENT", "dataAsOf must be a date");
    const bytes = new Uint8Array(gzipSync(a.content));
    if (bytes.byteLength > MAX_PAGE_FILE_BYTES) fail("PAYLOAD_TOO_LARGE", `The dataset is ${bytes.byteLength.toLocaleString("en-US")} bytes compressed; the limit is ${MAX_PAGE_FILE_BYTES.toLocaleString("en-US")}. Split it by area.`);
    const rawHash = sha256(a.content);
    const f = await ctx.services.files.upload({ name: `${rawHash.slice(0, 16)}.${a.format}.gz`, contentType: "application/gzip", content: bytes, metadata: { kind: "signal.dataset.raw", sha256: rawHash, format: a.format } });
    const owner = ctx.auth.requirePrincipal().id, now = new Date().toISOString();
    const datasetId = await ctx.db.insert(datasets, { name: a.name, freshness: a.freshness ?? "static", retired: false, ownerId: owner, createdAt: now });
    const mapping: DatasetMapping = { ...inspectDataset(parsed).proposed, version: 1 };
    const versionId = await ctx.db.insert(datasetVersions, { datasetId, version: 1, rawRef: `files:${f.id}`, rawHash, format: a.format, rows: parsed.rows.length, mapping: json(mapping), reviewed: false, ...(a.dataAsOf ? { dataAsOf: a.dataAsOf } : {}), retrievedAt: now, ownerId: owner });
    const rec = (await ctx.db.get(datasetVersions, versionId)) as unknown as Rec;
    return { datasetId, versionId, version: 1, review: JSON.parse(JSON.stringify(await review(ctx as never, rec))) };
  },
});

/** Accept or edit the mapping. This creates the next version over the same bytes; earlier versions keep their meaning. */
export const setMapping = app.mutation({
  access: "signal.datasets.write",
  args: { datasetId: s.string(), mapping: s.string({ maxLength: 50_000 }), dataAsOf: s.optional(s.string({ maxLength: 40 })) },
  returns: s.object({ version: s.integer(), versionId: s.string(), review: Review }),
  capability: { name: "signal.datasets.mapping", description: "Accept or edit a dataset's mapping to Signal attributes. Creates a new immutable version; only reviewed versions are used in discovery." },
  handler: async (ctx, a) => {
    await ownDataset(ctx as never, a.datasetId);
    const vs = await versionsOf(ctx as never, a.datasetId);
    const latest = vs[vs.length - 1];
    let m: DatasetMapping;
    try { m = JSON.parse(a.mapping); } catch { fail("INVALID_ARGUMENT", "mapping is not valid JSON"); }
    const errors = validateMapping({ ...m!, version: latest.version + 1 }, await loadParsed(ctx as never, latest));
    if (errors.length) fail("INVALID_ARGUMENT", errors.join("; "));
    if (a.dataAsOf !== undefined && Number.isNaN(Date.parse(a.dataAsOf))) fail("INVALID_ARGUMENT", "dataAsOf must be a date");
    const version = latest.version + 1;
    const dataAsOf = a.dataAsOf ?? latest.dataAsOf;
    const versionId = await ctx.db.insert(datasetVersions, { datasetId: a.datasetId, version, rawRef: latest.rawRef, rawHash: latest.rawHash, format: latest.format, rows: latest.rows, mapping: json({ ...m!, version }), reviewed: true, ...(dataAsOf ? { dataAsOf } : {}), retrievedAt: latest.retrievedAt, ownerId: latest.ownerId });
    const rec = (await ctx.db.get(datasetVersions, versionId)) as unknown as Rec;
    return { version, versionId, review: JSON.parse(JSON.stringify(await review(ctx as never, rec))) };
  },
});

export const inspect = app.query({
  access: "signal.datasets.read",
  args: { datasetId: s.string(), version: s.optional(s.integer()) },
  returns: Review,
  capability: { name: "signal.datasets.inspect", description: "Review a dataset version: its columns, the mapping, values that could not be mapped, and records before and after normalization." },
  handler: async (ctx, a) => {
    await ownDataset(ctx, a.datasetId);
    const vs = await versionsOf(ctx, a.datasetId);
    const v = a.version === undefined ? vs[vs.length - 1] : vs.find((x) => x.version === a.version);
    return JSON.parse(JSON.stringify(await review(ctx, requireFound(v, "That version")))) as never;
  },
});

export const list = app.query({
  access: "signal.datasets.read",
  returns: s.array(s.object({ id: s.string(), name: s.string(), freshness: s.string(), format: s.string(), retired: s.boolean(), createdAt: s.string(), latestVersion: s.integer(), reviewed: s.boolean(), rows: s.integer(), dataAsOf: s.nullable(s.string()), retrievedAt: s.string() })),
  handler: async (ctx) => {
    const out = [];
    for (const d of await ctx.db.find(datasets, { ownerId: ctx.auth.requirePrincipal().id })) {
      const vs = await versionsOf(ctx, d.id);
      const reviewed = vs.filter((v) => v.reviewed).pop();
      const v = reviewed ?? vs[vs.length - 1];
      out.push({ id: d.id, name: d.name, freshness: d.freshness, format: v.format, retired: d.retired, createdAt: d.createdAt, latestVersion: v.version, reviewed: !!reviewed, rows: v.rows, dataAsOf: v.dataAsOf ?? null, retrievedAt: v.retrievedAt });
    }
    return out as never;
  },
});

/** Stop using a dataset. Its versions stay: results already produced from them must remain explainable. */
export const retire = app.mutation({
  access: "signal.datasets.write",
  args: { datasetId: s.string() },
  handler: async (ctx, { datasetId }) => { await ownDataset(ctx as never, datasetId); await ctx.db.patch(datasets, datasetId, { retired: true }); return null; },
});

/** The latest reviewed version of each dataset, ready for discovery. Unreviewed, retired and foreign datasets are refused by name, never skipped. */
export async function loadDatasetSources(ctx: Ctx, ids: string[]): Promise<DatasetSource[]> {
  const out: DatasetSource[] = [];
  for (const id of ids) {
    const d = await ownDataset(ctx, id);
    if (d.retired) fail("FAILED_PRECONDITION", `Dataset "${d.name}" is retired.`);
    const v = (await versionsOf(ctx, id)).filter((x) => x.reviewed).pop();
    if (!v) fail("FAILED_PRECONDITION", `Dataset "${d.name}" has no reviewed mapping yet; accept or edit its mapping first.`);
    const mapped = applyMapping(await loadParsed(ctx, v), parse<DatasetMapping>(v.mapping));
    out.push({ id, name: d.name, versionId: v.id, mappingVersion: v.version, freshness: d.freshness, dataAsOf: v.dataAsOf ?? null, retrievedAt: v.retrievedAt, records: mapped.records });
  }
  return out;
}
