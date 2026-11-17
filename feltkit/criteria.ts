import { fail, s } from "@feltdb/feltkit";
import { app, criteria } from "./app.js";
import type { CriteriaDefinition } from "../lib/contracts/types.ts";
import { validateCondition } from "../lib/core/evaluate.ts";
import { validateRule } from "../lib/interpret/extract.ts";
import { json, parseCriteria } from "./_shared.js";

/**
 * Publish a criteria version. `definition` is a signal.criteria/v1 document (JSON).
 * Versions are immutable: re-publishing id@version is refused; an edit is version+1.
 * AI may *draft* a definition elsewhere; only this validated, deterministic form is stored.
 */
export const define = app.mutation({
  access: "signal.criteria.write",
  args: { definition: s.string({ minLength: 2, maxLength: 64_000 }) },
  returns: s.object({ criteriaId: s.string(), version: s.integer() }),
  capability: { name: "signal.criteria.define", description: "Publish an immutable version of declarative, deterministic criteria (signal.criteria/v1)." },
  handler: async (ctx, { definition }) => {
    let d: CriteriaDefinition;
    try {
      const raw = JSON.parse(definition);
      d = { ...raw, schema: "signal.criteria/v1", version: raw.version ?? 1 };
      if (typeof d.id !== "string" || !/^[A-Za-z0-9_.-]{1,120}$/.test(d.id)) throw new Error("id must be 1–120 of [A-Za-z0-9_.-]");
      if (!Number.isInteger(d.version) || d.version < 1) throw new Error("version must be a positive integer");
      if (!["info", "warning", "critical"].includes(d.severity)) throw new Error("severity must be info, warning or critical");
      if (typeof d.name !== "string" || !d.name) throw new Error("name is required");
      validateCondition(d.condition);
      (d.extract ?? []).forEach(validateRule);
    } catch (e) {
      fail("INVALID_ARGUMENT", `Invalid criteria: ${(e as Error).message}`);
    }
    const owner = ctx.auth.requirePrincipal().id;
    const existing = await ctx.db.find(criteria, { criteriaId: d!.id });
    if (existing.some((c) => c.ownerId !== owner)) fail("FORBIDDEN", `Criteria ${d!.id} belongs to someone else.`);
    if (existing.some((c) => c.version === d!.version)) {
      fail("FAILED_PRECONDITION", `Criteria ${d!.id}@v${d!.version} already exists; versions are immutable — publish version ${Math.max(...existing.map((c) => c.version)) + 1}.`);
    }
    await ctx.db.insert(criteria, {
      criteriaId: d!.id, version: d!.version, name: d!.name, severity: d!.severity, definition: json(d!),
      ownerId: owner, createdAt: new Date().toISOString(),
    });
    return { criteriaId: d!.id, version: d!.version };
  },
});

export const get = app.query({
  access: "signal.criteria.read",
  args: { criteriaId: s.string(), version: s.integer() },
  handler: async (ctx, { criteriaId, version }) => {
    const [c] = await ctx.db.find(criteria, { criteriaId, version });
    if (!c || c.ownerId !== ctx.auth.requirePrincipal().id) return null;
    return parseCriteria(c.definition);
  },
});
