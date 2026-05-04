import { Hono } from "hono";
import type { RigRepository } from "../domain/rig-repository.js";
import type { SessionRegistry } from "../domain/session-registry.js";
import type { NodeLauncher } from "../domain/node-launcher.js";
import type { CmuxAdapter } from "../adapters/cmux.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { NodeCmuxService } from "../domain/node-cmux-service.js";
import type { TranscriptStore } from "../domain/transcript-store.js";
import type { AgentActivityStore } from "../domain/agent-activity-store.js";
import { attachAgentActivity, getNodeInventory, getNodeDetail, getNodeInventoryWithContext, getNodeDetailWithContext } from "../domain/node-inventory.js";
import type { ContextUsageStore } from "../domain/context-usage-store.js";
import type { RigLifecycleService } from "../domain/rig-lifecycle-service.js";
import type { SessionTransport } from "../domain/session-transport.js";
import type { PreviewRateLimiter } from "../domain/preview/preview-rate-limiter.js";

export const sessionsRoutes = new Hono();
export const nodesRoutes = new Hono();
export const sessionAdminRoutes = new Hono();

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    rigRepo: c.get("rigRepo" as never) as RigRepository,
    sessionRegistry: c.get("sessionRegistry" as never) as SessionRegistry,
    nodeLauncher: c.get("nodeLauncher" as never) as NodeLauncher,
    tmuxAdapter: c.get("tmuxAdapter" as never) as TmuxAdapter,
    cmuxAdapter: c.get("cmuxAdapter" as never) as CmuxAdapter,
    agentActivityStore: c.get("agentActivityStore" as never) as AgentActivityStore | undefined,
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
// ?refresh=true triggers a context-monitor re-sample before responding
nodesRoutes.get("/", async (c) => {
  const rigId = c.req.param("rigId")!;
  const deps = getDeps(c);
  const rig = deps.rigRepo.getRig(rigId);
  if (!rig) return c.json({ error: `Rig "${rigId}" not found. List rigs with: rig ps` }, 404);

  const refresh = c.req.query("refresh") === "true";
  if (refresh) {
    const monitor = c.get("contextMonitor" as never) as { pollOnce(): Promise<void> } | undefined;
    if (monitor) {
      try {
        await monitor.pollOnce();
      } catch (err) {
        return c.json({
          error: "Context refresh failed. Stale data may be returned.",
          code: "context_refresh_failed",
          detail: err instanceof Error ? err.message : String(err),
        }, 502);
      }
    }
  }

  const contextUsageStore = c.get("contextUsageStore" as never) as ContextUsageStore | undefined;
  const inventory = contextUsageStore
    ? getNodeInventoryWithContext(deps.rigRepo.db, rigId, contextUsageStore)
    : getNodeInventory(deps.rigRepo.db, rigId);
  return c.json(await attachAgentActivity(inventory, { tmuxAdapter: deps.tmuxAdapter, activityStore: deps.agentActivityStore }));
});

// GET /api/rigs/:rigId/nodes/:logicalId — node detail
nodesRoutes.get("/:logicalId", async (c) => {
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
  const [detailWithActivity] = await attachAgentActivity([detail], { tmuxAdapter: deps.tmuxAdapter, activityStore: deps.agentActivityStore });
  Object.assign(detail, { agentActivity: detailWithActivity?.agentActivity });

  // PL-019 item 5: surface in-progress qitems on node-detail when the
  // node has a session name (matches /graph payload's enrichment shape).
  if (detail.canonicalSessionName) {
    const rows = deps.rigRepo.db.prepare(
      `SELECT qitem_id, body, tier
         FROM queue_items
         WHERE state = 'in-progress' AND destination_session = ?
         ORDER BY ts_updated DESC
         LIMIT 3`
    ).all(detail.canonicalSessionName) as Array<{ qitem_id: string; body: string; tier: string | null }>;
    Object.assign(detail, {
      currentQitems: rows.map((r) => ({
        qitemId: r.qitem_id,
        bodyExcerpt: r.body.length > 80 ? `${r.body.slice(0, 80)}…` : r.body,
        tier: r.tier,
      })),
    });
  }

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
  const { rigRepo, nodeLauncher } = getDeps(c);

  const rig = rigRepo.getRig(rigId);
  if (!rig) {
    return c.json({ ok: false, code: "rig_not_found", error: `Rig "${rigId}" not found` }, 404);
  }

  const node = rig.nodes.find((entry) => entry.logicalId === logicalId || entry.id === logicalId);
  if (!node) {
    return c.json({ ok: false, code: "node_not_found", error: `Node "${logicalId}" not found in rig "${rigId}"` }, 404);
  }

  if (node.podId) {
    return c.json({
      ok: false,
      code: "pod_aware_launch_unsupported",
      error: "Pod-aware node launch via this route bypasses startup orchestration. Use rig up, rig import --instantiate, or rig restore instead.",
    }, 409);
  }

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

// GET /api/rigs/:rigId/nodes/:logicalId/preview?lines=N
//
// Preview Terminal v0 (PL-018): returns the seat's last N lines via
// SessionTransport.capture. Rate-limited per session through the
// daemon-side PreviewRateLimiter (default 1 sec window) so live polling
// from multiple panes doesn't hammer tmux.
//
// Returns 404 when the rig/node/session can't be resolved (UI surfaces
// this as "preview unavailable on this rig"). Returns 503 when
// SessionTransport is missing from context (degraded daemon).
nodesRoutes.get("/:logicalId/preview", async (c) => {
  const rigId = c.req.param("rigId")!;
  const logicalId = decodeURIComponent(c.req.param("logicalId")!);
  const deps = getDeps(c);
  const sessionTransport = c.get("sessionTransport" as never) as SessionTransport | undefined;
  const rateLimiter = c.get("previewRateLimiter" as never) as PreviewRateLimiter<{
    content: string;
    lines: number;
    sessionName: string;
    capturedAt: string;
  }> | undefined;
  if (!sessionTransport) {
    return c.json({ error: "preview_unavailable", hint: "SessionTransport not configured on this daemon." }, 503);
  }

  const rig = deps.rigRepo.getRig(rigId);
  if (!rig) return c.json({ error: `Rig "${rigId}" not found.` }, 404);

  // Resolve canonical session name. The node-detail projector already
  // does this; we re-use the raw rig object to keep the route cheap.
  const node = rig.nodes.find((n) => n.logicalId === logicalId || n.id === logicalId);
  if (!node) return c.json({ error: `Node "${logicalId}" not found in rig "${rigId}".` }, 404);
  const sessionName = node.binding?.tmuxSession;
  if (!sessionName) {
    return c.json({
      error: "session_unbound",
      hint: "Node has no tmux session yet. Use rig up or rig launch to start the seat.",
    }, 409);
  }

  const linesRaw = c.req.query("lines");
  const linesParsed = linesRaw ? parseInt(linesRaw, 10) : NaN;
  // Clamp lines to a sensible range; default 50 matches the v0 UI pref.
  const lines = Number.isFinite(linesParsed) && linesParsed > 0
    ? Math.min(linesParsed, 1000)
    : 50;

  // Cache key includes the line count so a 50-line poll doesn't poison
  // a 200-line manual fetch (and vice versa).
  const cacheKey = `${sessionName}:${lines}`;
  const cached = rateLimiter?.get(cacheKey);
  if (cached) {
    return c.json(cached.payload);
  }

  const result = await sessionTransport.capture(sessionName, { lines });
  if (!result.ok) {
    return c.json({
      error: result.reason ?? "capture_failed",
      hint: result.error,
      sessionName,
    }, 502);
  }
  const payload = {
    content: result.content ?? "",
    lines: result.lines ?? lines,
    sessionName,
    capturedAt: new Date().toISOString(),
  };
  rateLimiter?.set(cacheKey, payload);
  return c.json(payload);
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

// GET /api/sessions/:sessionName/preview?lines=N
//
// Preview Terminal v0 (PL-018) — session-keyed alias for /preview.
// Used by surfaces that hold a sessionName but not a (rigId, logicalId)
// pair (Steering Loop State panel, Slice Story View Topology tab).
// Behavior identical to the rig+node-keyed route otherwise.
sessionAdminRoutes.get("/:sessionName/preview", async (c) => {
  const sessionName = decodeURIComponent(c.req.param("sessionName")!);
  const sessionTransport = c.get("sessionTransport" as never) as SessionTransport | undefined;
  const rateLimiter = c.get("previewRateLimiter" as never) as PreviewRateLimiter<{
    content: string;
    lines: number;
    sessionName: string;
    capturedAt: string;
  }> | undefined;
  if (!sessionTransport) {
    return c.json({ error: "preview_unavailable", hint: "SessionTransport not configured on this daemon." }, 503);
  }

  const linesRaw = c.req.query("lines");
  const linesParsed = linesRaw ? parseInt(linesRaw, 10) : NaN;
  const lines = Number.isFinite(linesParsed) && linesParsed > 0
    ? Math.min(linesParsed, 1000)
    : 50;

  const cacheKey = `${sessionName}:${lines}`;
  const cached = rateLimiter?.get(cacheKey);
  if (cached) return c.json(cached.payload);

  const result = await sessionTransport.capture(sessionName, { lines });
  if (!result.ok) {
    return c.json({
      error: result.reason ?? "capture_failed",
      hint: result.error,
      sessionName,
    }, 502);
  }
  const payload = {
    content: result.content ?? "",
    lines: result.lines ?? lines,
    sessionName,
    capturedAt: new Date().toISOString(),
  };
  rateLimiter?.set(cacheKey, payload);
  return c.json(payload);
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
