import { Hono } from "hono";
import type { RigRepository } from "../domain/rig-repository.js";
import type { SessionRegistry } from "../domain/session-registry.js";
import type { NodeLauncher } from "../domain/node-launcher.js";
import type { CmuxAdapter } from "../adapters/cmux.js";
import type { NodeCmuxService } from "../domain/node-cmux-service.js";
import type { TranscriptStore } from "../domain/transcript-store.js";
import { getNodeInventory, getNodeDetail, getNodeInventoryWithContext, getNodeDetailWithContext } from "../domain/node-inventory.js";
import type { ContextUsageStore } from "../domain/context-usage-store.js";
import type { RigLifecycleService } from "../domain/rig-lifecycle-service.js";

export const sessionsRoutes = new Hono();
export const nodesRoutes = new Hono();
export const sessionAdminRoutes = new Hono();

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    rigRepo: c.get("rigRepo" as never) as RigRepository,
    sessionRegistry: c.get("sessionRegistry" as never) as SessionRegistry,
    nodeLauncher: c.get("nodeLauncher" as never) as NodeLauncher,
    cmuxAdapter: c.get("cmuxAdapter" as never) as CmuxAdapter,
    rigLifecycleService: c.get("rigLifecycleService" as never) as RigLifecycleService | undefined,
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
  if (!rig) return c.json({ error: `Rig "${rigId}" not found. List rigs with: rig ps` }, 404);
  const contextUsageStore = c.get("contextUsageStore" as never) as ContextUsageStore | undefined;
  const inventory = contextUsageStore
    ? getNodeInventoryWithContext(deps.rigRepo.db, rigId, contextUsageStore)
    : getNodeInventory(deps.rigRepo.db, rigId);
  return c.json(inventory);
});

// GET /api/rigs/:rigId/nodes/:logicalId — node detail
nodesRoutes.get("/:logicalId", (c) => {
  const rigId = c.req.param("rigId")!;
  const logicalId = decodeURIComponent(c.req.param("logicalId")!);
  const deps = getDeps(c);
  const rig = deps.rigRepo.getRig(rigId);
  if (!rig) return c.json({ error: `Rig "${rigId}" not found. List rigs with: rig ps` }, 404);
  const contextUsageStore = c.get("contextUsageStore" as never) as ContextUsageStore | undefined;
  const detail = contextUsageStore
    ? getNodeDetailWithContext(deps.rigRepo.db, rigId, logicalId, contextUsageStore)
    : getNodeDetail(deps.rigRepo.db, rigId, logicalId);
  if (!detail) return c.json({ error: `Node "${logicalId}" not found in rig "${rigId}". Check node IDs with: rig ps --nodes` }, 404);

  // Enrich transcript info from TranscriptStore (not available to pure DB helper)
  const transcriptStore = c.get("transcriptStore" as never) as TranscriptStore | undefined;
  if (transcriptStore?.enabled && detail.canonicalSessionName) {
    const path = transcriptStore.getTranscriptPath(rig.rig.name, detail.canonicalSessionName);
    detail.transcript = {
      enabled: true,
      path,
      tailCommand: `rig transcript ${detail.canonicalSessionName} --tail 100`,
    };
  }

  return c.json(detail);
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

// POST /api/rigs/:rigId/nodes/:logicalId/open-cmux
nodesRoutes.post("/:logicalId/open-cmux", async (c) => {
  const rigId = c.req.param("rigId")!;
  const logicalId = decodeURIComponent(c.req.param("logicalId")!);
  const nodeCmuxService = c.get("nodeCmuxService" as never) as NodeCmuxService | undefined;

  if (!nodeCmuxService) {
    return c.json({ ok: false, error: "cmux service not available", code: "unavailable" }, 500);
  }

  const result = await nodeCmuxService.openOrFocusNodeSurface(rigId, logicalId);
  if (!result.ok && result.code === "not_found") {
    return c.json(result, 404);
  }
  return c.json(result);
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

// DELETE /api/rigs/:rigId/nodes/:logicalId
nodesRoutes.delete("/:logicalId", async (c) => {
  const rigId = c.req.param("rigId")!;
  const nodeRef = decodeURIComponent(c.req.param("logicalId")!);
  const { rigLifecycleService } = getDeps(c);
  if (!rigLifecycleService) {
    return c.json({ error: "Lifecycle service not available" }, 500);
  }

  const result = await rigLifecycleService.removeNode(rigId, nodeRef);
  if (!result.ok) {
    const status = result.code === "rig_not_found" ? 404
      : result.code === "node_not_found" ? 404
      : result.code === "kill_failed" ? 409
      : 500;
    return c.json(result, status);
  }

  return c.json(result, 200);
});

// POST /api/sessions/:sessionRef/unclaim
sessionAdminRoutes.post("/:sessionRef/unclaim", async (c) => {
  const sessionRef = decodeURIComponent(c.req.param("sessionRef")!);
  const { rigLifecycleService } = getDeps(c);
  if (!rigLifecycleService) {
    return c.json({ error: "Lifecycle service not available" }, 500);
  }

  const result = await rigLifecycleService.unclaimSession(sessionRef);
  if (!result.ok) {
    const status = result.code === "session_ambiguous" ? 409 : 404;
    return c.json(result, status);
  }

  return c.json(result, 200);
});
