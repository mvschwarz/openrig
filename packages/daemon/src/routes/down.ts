import { Hono } from "hono";
import type { RigTeardownOrchestrator } from "../domain/rig-teardown.js";
import type { RigRepository } from "../domain/rig-repository.js";
import { RigNotFoundError } from "../domain/errors.js";

export const downRoutes = new Hono();

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    teardownOrchestrator: c.get("teardownOrchestrator" as never) as RigTeardownOrchestrator,
  };
}

/**
 * POST /api/down — tear down a rig.
 * @param rigId - required rig identifier
 * @param delete - optional, remove rig record after stop
 * @param force - optional, kill sessions immediately
 * @param snapshot - optional, snapshot before teardown
 * @returns TeardownResult
 */
downRoutes.post("/", async (c) => {
  const { teardownOrchestrator } = getDeps(c);
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const rigId = typeof body["rigId"] === "string" ? body["rigId"] : "";
  const deleteRig = body["delete"] === true;
  const force = body["force"] === true;
  const snapshot = body["snapshot"] === true;

  if (!rigId) {
    return c.json({ error: "rigId is required" }, 400);
  }

  try {
    const result = await teardownOrchestrator.teardown(rigId, {
      delete: deleteRig,
      force,
      snapshot,
    });

    // Determine HTTP status
    if (deleteRig && !result.deleted) {
      if (result.deleteBlocked) {
        return c.json(result, 409);
      }
      return c.json(result, 500);
    }

    // Include rig name + uniqueness in response for post-command handoff
    const rigRepo = c.get("rigRepo" as never) as RigRepository;
    const rig = rigRepo.getRig(rigId);
    const rigName = rig?.rig.name ?? null;
    const isUniqueName = rigName ? rigRepo.findRigsByName(rigName).length === 1 : false;
    const enriched = { ...result, rigName, isUniqueName };
    return c.json(enriched, 200);
  } catch (err) {
    if (err instanceof RigNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    return c.json({ error: (err as Error).message }, 500);
  }
});
