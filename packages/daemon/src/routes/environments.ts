import { Hono, type Context } from "hono";
import { EnvironmentPlatform, EnvironmentError, type EnvironmentConfig } from "../domain/environment-platform.js";
import { EnvironmentLifecycle } from "../domain/environment-lifecycle.js";
import { EnvironmentArtifacts, type EnvironmentArtifactRequest } from "../domain/environment-artifacts.js";
import type { QueueRepository } from "../domain/queue-repository.js";
import { requireSenderIdentity, resolveRecordedIdentity } from "./require-sender-identity.js";

export const environmentRoutes = new Hono();
function platform(c: Context): EnvironmentPlatform { return c.get("environmentPlatform" as never) as EnvironmentPlatform; }
function failure(c: Context, error: unknown): Response {
  if (error instanceof EnvironmentError) return c.json({ error: error.message, code: error.code }, error.status as 400);
  return c.json({ code: "environment_unconfirmed", error: "The environment operation did not return a confirmed result; its intent is retained" }, 503);
}
environmentRoutes.post("/create", async c => {
  const identity = requireSenderIdentity(c, { verb: "environment create" }); if (!identity.ok) return identity.response;
  try {
    const input = await c.req.json<EnvironmentConfig & { operationId: string }>();
    const result = await platform(c).create(input);
    return c.json({ ...result.binding, ...(result.code ? { code: result.code } : {}) }, result.status as 201);
  } catch (error) { return failure(c, error); }
});
environmentRoutes.post("/attach", async c => {
  const identity = requireSenderIdentity(c, { verb: "environment attach" }); if (!identity.ok) return identity.response;
  try {
    const result = await platform(c).attach(await c.req.json());
    return c.json(result.binding, result.status as 201);
  } catch (error) { return failure(c, error); }
});
environmentRoutes.get("/:bindingId", async c => {
  try {
    const service = platform(c);
    const binding = c.req.query("live") === "true" ? await service.current(c.req.param("bindingId")) : service.get(c.req.param("bindingId"));
    if (!binding) return c.json({ code: "environment_binding_missing", error: "No environment binding" }, 404);
    const operations = service.db.prepare("SELECT operation_id AS operationId,kind,state,receipt_json FROM environment_operations WHERE binding_id=? ORDER BY rowid").all(binding.bindingId) as Array<{ operationId: string; kind: string; state: string; receipt_json: string | null }>;
    return c.json({ ...binding, operations: operations.map(({ receipt_json, ...operation }) => ({ ...operation, receipt: receipt_json ? JSON.parse(receipt_json) : null })), observation: c.req.query("live") === "true" ? "live-resource" : "stored-receipt",
      lifecycle: { closeViewer: "explicit effect", stopNative: "owned exact-native effect", stopCompute: "owned exact-compute effect", deleteEnvironment: "owned effect with independent local engine inventory", nativeRestore: "verified checkpoint and explicitly recreated same-host compute" } });
  } catch (error) { return failure(c, error); }
});
environmentRoutes.post("/:bindingId/validate", async c => {
  try {
    const body = await c.req.json<{ generation: string }>();
    await platform(c).validate(c.req.param("bindingId"), body.generation);
    return c.json({ ok: true, generation: body.generation, effect: "destination-verified; native ingestion is not observed" });
  } catch (error) { return failure(c, error); }
});
environmentRoutes.post("/:bindingId/export", async c => {
  const identity = requireSenderIdentity(c, { verb: "environment export" }); if (!identity.ok) return identity.response;
  try {
    const service = new EnvironmentArtifacts(platform(c), c.get("queueRepo" as never) as QueueRepository, c.get("environmentArtifactRoot" as never) as string);
    return c.json(await service.export(c.req.param("bindingId"), await c.req.json<EnvironmentArtifactRequest>(),
      { actor: identity.session, ...resolveRecordedIdentity(c, identity) }));
  } catch (error) { return failure(c, error); }
});
// Requester audit is trusted transport attribution, not credential-backed seat authentication.
// The transport-derived requester supersedes any requestedBy claim in the body.
environmentRoutes.post("/:bindingId/effect", async c => {
  const identity = requireSenderIdentity(c, { verb: "environment effect" }); if (!identity.ok) return identity.response;
  try { const body = { ...await c.req.json<{ effect: string }>(), requestedBy: identity.session }; return c.json(await (c.get("environmentLifecycle" as never) as EnvironmentLifecycle).effect(c.req.param("bindingId"), body as never)); }
  catch (error) { return failure(c, error); }
});

for (const operation of ["checkpoint", "recreate", "completion"] as const) environmentRoutes.post(`/:bindingId/${operation}`, async c => {
  const identity = requireSenderIdentity(c, { verb: `environment ${operation}` }); if (!identity.ok) return identity.response;
  try {
    const service = c.get("environmentLifecycle" as never) as EnvironmentLifecycle, input = { ...await c.req.json(), requestedBy: identity.session };
    const result = operation === "checkpoint" ? await service.checkpoint(c.req.param("bindingId"), input)
      : operation === "recreate" ? await service.recreate(c.req.param("bindingId"), input) : service.selectCompletion(c.req.param("bindingId"), input);
    if (operation === "completion") await service.checkCompletions();
    return c.json(result);
  } catch (error) { return failure(c, error); }
});
