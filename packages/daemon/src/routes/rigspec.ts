import { Hono } from "hono";
import type { Context } from "hono";
import type { RigSpecExporter } from "../domain/rigspec-exporter.js";
import type { RigInstantiator } from "../domain/rigspec-instantiator.js";
import type { RigSpecPreflight } from "../domain/rigspec-preflight.js";
import { LegacyRigSpecCodec as RigSpecCodec } from "../domain/rigspec-codec.js"; // TODO: AS-T08b — migrate to pod-aware RigSpec
import { LegacyRigSpecSchema as RigSpecSchema } from "../domain/rigspec-schema.js"; // TODO: AS-T08b — migrate to pod-aware RigSpec
import { RigNotFoundError } from "../domain/errors.js";

export const rigspecImportRoutes = new Hono();

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    exporter: c.get("rigSpecExporter" as never) as RigSpecExporter,
    instantiator: c.get("rigInstantiator" as never) as RigInstantiator,
    preflight: c.get("rigSpecPreflight" as never) as RigSpecPreflight,
  };
}

// GET /api/rigs/:rigId/spec -> YAML
export function handleExportYaml(c: Context): Response {
  const rigId = c.req.param("rigId")!;
  const { exporter } = getDeps(c);

  try {
    const spec = exporter.exportRig(rigId);
    const yaml = RigSpecCodec.serialize(spec);
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
  const { instantiator } = getDeps(c);

  const body = await c.req.text();
  let spec;
  try {
    const raw = RigSpecCodec.parse(body);
    spec = RigSpecSchema.normalize(raw);
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

// POST /api/rigs/import/validate -> validate only
rigspecImportRoutes.post("/validate", async (c) => {
  const body = await c.req.text();

  let raw: unknown;
  try {
    raw = RigSpecCodec.parse(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ valid: false, errors: [message] }, 400);
  }

  const result = RigSpecSchema.validate(raw);
  return c.json(result);
});

// POST /api/rigs/import/preflight -> validate + preflight
rigspecImportRoutes.post("/preflight", async (c) => {
  const { preflight } = getDeps(c);
  const body = await c.req.text();

  let spec;
  try {
    const raw = RigSpecCodec.parse(body);
    spec = RigSpecSchema.normalize(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ valid: false, errors: [message] }, 400);
  }

  const result = await preflight.check(spec);
  return c.json(result);
});
