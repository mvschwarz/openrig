import { Hono } from "hono";
import type { RigRepository } from "../domain/rig-repository.js";
import type { SessionRegistry } from "../domain/session-registry.js";
import type { NodeLauncher } from "../domain/node-launcher.js";
import type { CmuxAdapter } from "../adapters/cmux.js";
import { getNodeInventory } from "../domain/node-inventory.js";

export const sessionsRoutes = new Hono();
export const nodesRoutes = new Hono();

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    rigRepo: c.get("rigRepo" as never) as RigRepository,
    sessionRegistry: c.get("sessionRegistry" as never) as SessionRegistry,
    nodeLauncher: c.get("nodeLauncher" as never) as NodeLauncher,
    cmuxAdapter: c.get("cmuxAdapter" as never) as CmuxAdapter,
  };
}

// GET /api/rigs/:rigId/sessions
sessionsRoutes.get("/", (c) => {
  const rigId = c.req.param("rigId")!;
  const { sessionRegistry } = getDeps(c);
  return c.json(sessionRegistry.getSessionsForRig(rigId));
});

// GET /api/rigs/:rigId/nodes — node inventory projection
nodesRoutes.get("/", (c) => {
  const rigId = c.req.param("rigId")!;
  const deps = getDeps(c);
  const rig = deps.rigRepo.getRig(rigId);
  if (!rig) return c.json({ error: `Rig "${rigId}" not found. List rigs with: rigged ps` }, 404);
  const inventory = getNodeInventory(deps.rigRepo.db, rigId);
  return c.json(inventory);
});

// POST /api/rigs/:rigId/nodes/:logicalId/launch
nodesRoutes.post("/:logicalId/launch", async (c) => {
  const rigId = c.req.param("rigId")!;
  const logicalId = c.req.param("logicalId")!;
  const { nodeLauncher } = getDeps(c);

  const result = await nodeLauncher.launchNode(rigId, logicalId);

  if (!result.ok) {
    const status = result.code === "node_not_found" ? 404
      : result.code === "already_bound" ? 409
      : result.code === "invalid_session_name" ? 400
      : 500;
    return c.json(result, status);
  }

  return c.json(result, 201);
});

// POST /api/rigs/:rigId/nodes/:logicalId/focus
nodesRoutes.post("/:logicalId/focus", async (c) => {
  const rigId = c.req.param("rigId")!;
  const logicalId = c.req.param("logicalId")!;
  const { rigRepo, cmuxAdapter } = getDeps(c);

  const rig = rigRepo.getRig(rigId);
  if (!rig) return c.json({ error: "rig not found" }, 404);

  const node = rig.nodes.find((n) => n.logicalId === logicalId);
  if (!node) return c.json({ error: "node not found" }, 404);

  const cmuxSurface = node.binding?.cmuxSurface;
  if (!cmuxSurface) {
    return c.json({ error: "node has no cmux surface binding" }, 409);
  }

  const result = await cmuxAdapter.focusSurface(cmuxSurface);
  return c.json(result);
});
