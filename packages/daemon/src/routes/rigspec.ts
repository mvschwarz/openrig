import fs from "node:fs";
import { Hono } from "hono";
import type { Context } from "hono";
import type { RigSpecExporter } from "../domain/rigspec-exporter.js";
import type { RigInstantiator, PodRigInstantiator } from "../domain/rigspec-instantiator.js";
import type { RigSpecPreflight } from "../domain/rigspec-preflight.js";
import { LegacyRigSpecCodec } from "../domain/rigspec-codec.js";
import { RigSpecCodec } from "../domain/rigspec-codec.js";
import { LegacyRigSpecSchema } from "../domain/rigspec-schema.js";
import { RigSpecSchema } from "../domain/rigspec-schema.js";
import { rigPreflight } from "../domain/rigspec-preflight.js";
import { RigNotFoundError } from "../domain/errors.js";

export const rigspecImportRoutes = new Hono();

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    exporter: c.get("rigSpecExporter" as never) as RigSpecExporter,
    instantiator: c.get("rigInstantiator" as never) as RigInstantiator,
    preflight: c.get("rigSpecPreflight" as never) as RigSpecPreflight,
    podInstantiator: c.get("podInstantiator" as never) as PodRigInstantiator,
  };
}

// GET /api/rigs/:rigId/spec -> YAML
export function handleExportYaml(c: Context): Response {
  const rigId = c.req.param("rigId")!;
  const { exporter } = getDeps(c);

  try {
    const spec = exporter.exportRig(rigId);
    // Detect format: pod-aware RigSpec has `pods`, legacy has `schemaVersion`
    const isPodAware = "pods" in spec;
    const yaml = isPodAware
      ? RigSpecCodec.serialize(spec as import("../domain/types.js").RigSpec)
      : LegacyRigSpecCodec.serialize(spec as import("../domain/types.js").LegacyRigSpec);
    return new Response(yaml, {
      status: 200,
      headers: { "Content-Type": "text/yaml" },
    });
  } catch (err) {
    if (err instanceof RigNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    return c.json({ error: "Export failed" }, 500);
  }
}

// GET /api/rigs/:rigId/spec.json -> JSON
export function handleExportJson(c: Context): Response {
  const rigId = c.req.param("rigId")!;
  const { exporter } = getDeps(c);

  try {
    const spec = exporter.exportRig(rigId);
    return c.json(spec);
  } catch (err) {
    if (err instanceof RigNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    return c.json({ error: "Export failed" }, 500);
  }
}

// POST /api/rigs/import -> instantiate from YAML
rigspecImportRoutes.post("/", async (c) => {
  const { instantiator, podInstantiator } = getDeps(c);
  const body = await c.req.text();

  let raw: unknown;
  try {
    raw = RigSpecCodec.parse(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message, errors: [message] }, 400);
  }

  const isPodAware = raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).pods);

  if (isPodAware) {
    const rigRoot = c.req.header("X-Rig-Root");
    if (!rigRoot) return c.json({ error: "X-Rig-Root header required for pod-aware specs", code: "missing_rig_root" }, 400);

    const outcome = await podInstantiator.instantiate(body, rigRoot);
    if (!outcome.ok) {
      const status = outcome.code === "validation_failed" ? 400
        : outcome.code === "preflight_failed" ? 409
        : outcome.code === "cycle_error" ? 400
        : 500;
      return c.json(outcome, status);
    }
    return c.json(outcome.result, 201);
  }

  // Legacy path
  let spec;
  try {
    spec = LegacyRigSpecSchema.normalize(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message, errors: [message] }, 400);
  }

  const outcome = await instantiator.instantiate(spec);
  if (!outcome.ok) {
    const status = outcome.code === "validation_failed" ? 400
      : outcome.code === "preflight_failed" ? 409
      : 500;
    return c.json(outcome, status);
  }
  return c.json(outcome.result, 201);
});

// POST /api/rigs/import/validate -> validate only (auto-detects format)
rigspecImportRoutes.post("/validate", async (c) => {
  const body = await c.req.text();

  let raw: unknown;
  try {
    raw = RigSpecCodec.parse(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ valid: false, errors: [message] }, 400);
  }

  const isPodAware = raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).pods);
  if (isPodAware) {
    return c.json(RigSpecSchema.validate(raw));
  }
  return c.json(LegacyRigSpecSchema.validate(raw));
});

// POST /api/rigs/import/preflight -> validate + preflight (auto-detects format)
rigspecImportRoutes.post("/preflight", async (c) => {
  const { preflight } = getDeps(c);
  const body = await c.req.text();

  let raw: unknown;
  try {
    raw = RigSpecCodec.parse(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ valid: false, errors: [message] }, 400);
  }

  const isPodAware = raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).pods);
  if (isPodAware) {
    const rigRoot = c.req.header("X-Rig-Root");
    if (!rigRoot) return c.json({ ready: false, errors: ["X-Rig-Root header required for pod-aware specs"], warnings: [] }, 400);
    const fsOps = { readFile: (p: string) => fs.readFileSync(p, "utf-8"), exists: (p: string) => fs.existsSync(p) };
    const result = rigPreflight({ rigSpecYaml: body, rigRoot, fsOps });
    return c.json(result);
  }

  // Legacy
  let spec;
  try {
    spec = LegacyRigSpecSchema.normalize(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ valid: false, errors: [message] }, 400);
  }

  const result = await preflight.check(spec);
  return c.json(result);
});
