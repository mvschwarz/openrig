import { Hono } from "hono";
import type { RigRepository } from "../domain/rig-repository.js";
import type { SessionRegistry } from "../domain/session-registry.js";
import type { NodeLauncher } from "../domain/node-launcher.js";
import type { CmuxAdapter } from "../adapters/cmux.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { NodeCmuxService } from "../domain/node-cmux-service.js";
import type { TranscriptStore } from "../domain/transcript-store.js";
import type { AgentActivityStore } from "../domain/agent-activity-store.js";
import type { SeatActivityService } from "../domain/seat-activity-service.js";
import {
  attachAgentActivity,
  attachTerminalActivityAndWork,
  getNodeInventory,
  getNodeDetail,
  getNodeInventoryWithContext,
  getNodeDetailWithContext,
} from "../domain/node-inventory.js";
import type { ContextUsageStore } from "../domain/context-usage-store.js";
import type { RigLifecycleService } from "../domain/rig-lifecycle-service.js";
import type { SessionTransport } from "../domain/session-transport.js";
import type { PreviewRateLimiter } from "../domain/preview/preview-rate-limiter.js";
import type { ClaimService } from "../domain/claim-service.js";
import type { PodRigInstantiator } from "../domain/rigspec-instantiator.js";
import { convergeOp } from "../domain/topology-converge.js";
import type { RestoreOrchestrator } from "../domain/restore-orchestrator.js";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
import type { MiddlewareHandler } from "hono";
import type { EventBus } from "../domain/event-bus.js";
import { validateResumeToken } from "../domain/resume-token-validation.js";

function terminalAuthGuard(): MiddlewareHandler {
  return async (c, next) => {
    const token = c.get("terminalBearerToken" as never) as string | null;
    const mw = authBearerTokenMiddleware({ expectedToken: token });
    return mw(c, next);
  };
}

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
    seatActivityService: c.get("seatActivityService" as never) as SeatActivityService | undefined,
    rigLifecycleService: c.get("rigLifecycleService" as never) as RigLifecycleService | undefined,
    restoreOrchestrator: c.get("restoreOrchestrator" as never) as RestoreOrchestrator | undefined,
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
  // Slice 15 — enrich with the two new orthogonal primitives. Order is
  // independent (each enrichment reads its own source), so the chain
  // composes cleanly with attachAgentActivity. The non-inference
  // contract is preserved at the data layer; this route is purely
  // assembling the JSON response.
  const withActivity = await attachAgentActivity(inventory, {
    tmuxAdapter: deps.tmuxAdapter,
    activityStore: deps.agentActivityStore,
  });
  const withTerminalAndWork = attachTerminalActivityAndWork(withActivity, {
    db: deps.rigRepo.db,
    seatActivity: deps.seatActivityService,
  });
  return c.json(withTerminalAndWork);
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
  const [detailWithTerminalAndWork] = attachTerminalActivityAndWork(detailWithActivity ? [detailWithActivity] : [detail], {
    db: deps.rigRepo.db,
    seatActivity: deps.seatActivityService,
  });
  Object.assign(detail, {
    agentActivity: detailWithTerminalAndWork?.agentActivity,
    terminalActive: detailWithTerminalAndWork?.terminalActive,
    hasAssignedWork: detailWithTerminalAndWork?.hasAssignedWork,
    pendingWorkCount: detailWithTerminalAndWork?.pendingWorkCount,
  });

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
    const { restoreOrchestrator } = getDeps(c);
    if (!restoreOrchestrator) {
      return c.json({ ok: false, code: "internal_error", error: "Restore orchestrator not available" }, 500);
    }
    const body = await c.req.json().catch(() => ({})) as { holdReason?: string };
    const result = await restoreOrchestrator.launchNodeSubset(rigId, [node.logicalId], { holdReason: body.holdReason });
    if (!result.ok) {
      return c.json(result, result.code === "rig_not_found" ? 404 : result.code === "no_matching_nodes" ? 404 : 500);
    }
    const failedTarget = result.failedTargets?.find((n) => n.logicalId === node.logicalId);
    if (failedTarget) {
      return c.json({ ok: false, code: "target_liveness_unknown", error: `Target '${node.logicalId}' tmux probe failed (fail-closed). Cannot determine if seat is live.`, failedTargets: result.failedTargets }, 503);
    }
    const launchedNode = result.launched?.[0];
    if (launchedNode) {
      return c.json({ ok: true, rigId, nodeId: launchedNode.nodeId, logicalId: launchedNode.logicalId, launched: result.launched, held: result.held, alreadyRunning: result.alreadyRunning }, 201);
    }
    const alreadyRunningNode = result.alreadyRunning?.find((n) => n.logicalId === node.logicalId);
    if (alreadyRunningNode) {
      return c.json({ ok: true, rigId, nodeId: alreadyRunningNode.nodeId, logicalId: alreadyRunningNode.logicalId, code: "already_running", launched: result.launched, held: result.held, alreadyRunning: result.alreadyRunning });
    }
    return c.json(result);
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

// POST /api/rigs/:rigId/nodes/launch-subset — multi-target managed subset launch
nodesRoutes.post("/launch-subset", async (c) => {
  const rigId = c.req.param("rigId")!;
  const { restoreOrchestrator } = getDeps(c);
  if (!restoreOrchestrator) {
    return c.json({ ok: false, code: "internal_error", error: "Restore orchestrator not available" }, 500);
  }
  const body = await c.req.json().catch(() => ({})) as { seats?: string[]; holdReason?: string };
  if (!Array.isArray(body.seats) || body.seats.length === 0) {
    return c.json({ ok: false, code: "invalid_request", error: "Request body must include a non-empty 'seats' array of logical IDs" }, 400);
  }
  const result = await restoreOrchestrator.launchNodeSubset(rigId, body.seats, { holdReason: body.holdReason });
  if (!result.ok) {
    return c.json(result, result.code === "rig_not_found" ? 404 : result.code === "no_matching_nodes" ? 404 : 500);
  }
  const hasLaunched = (result.launched?.length ?? 0) > 0;
  return c.json(result, hasLaunched ? 201 : 200);
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
nodesRoutes.get("/:logicalId/preview", terminalAuthGuard(), async (c) => {
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
nodesRoutes.post("/:logicalId/open-cmux", terminalAuthGuard(), async (c) => {
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
sessionAdminRoutes.get("/:sessionName/preview", terminalAuthGuard(), async (c) => {
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

// POST /api/sessions/:sessionName/reconcile — OPR.0.3.4.3 no-launch reconcile.
// Adopt a LIVE hand-resumed canonical session back into its persisted node via
// the reconcile_session converge op (sugar over the topology spine). Never
// launches/kills/replays startup or writes input into the target pane.
sessionAdminRoutes.post("/:sessionName/reconcile", async (c) => {
  const sessionName = decodeURIComponent(c.req.param("sessionName")!);
  const claimService = c.get("claimService" as never) as ClaimService | undefined;
  const podInstantiator = c.get("podInstantiator" as never) as PodRigInstantiator | undefined;
  if (!claimService || !podInstantiator) {
    return c.json({ error: "Reconcile unavailable: claim service not configured on this daemon." }, 503);
  }

  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const rigId = typeof body["rigId"] === "string" ? body["rigId"] : undefined;
  const logicalId = typeof body["logicalId"] === "string" ? body["logicalId"] : undefined;
  if ((rigId && !logicalId) || (!rigId && logicalId)) {
    return c.json({ error: "rigId and logicalId must be provided together (or both omitted)." }, 400);
  }

  const converged = await convergeOp(
    { instantiator: podInstantiator, claimService },
    rigId ?? "",
    { kind: "reconcile_session", sessionName, rigId, logicalId },
    ".",
  );
  if (converged.kind !== "reconcile_session" || !converged.supported) {
    return c.json({ error: "Unexpected converge result for reconcile_session" }, 500);
  }
  const outcome = converged.outcome;

  if (!outcome.ok) {
    switch (outcome.code) {
      case "session_not_found":
      case "node_not_found":
      case "rig_not_found":
        return c.json(outcome, 404);
      case "node_mismatch":
        return c.json(outcome, 409);
      default:
        return c.json(outcome, 500);
    }
  }

  return c.json(outcome, 200);
});

// POST /api/sessions/:sessionName/clear-attention — OPR.0.3.4.10.
sessionAdminRoutes.post("/:sessionName/clear-attention", async (c) => {
  const sessionName = decodeURIComponent(c.req.param("sessionName")!);
  const reconciler = c.get("seatAttentionReconciler" as never) as import("../domain/seat-attention-reconciler.js").SeatAttentionReconciler | undefined;
  if (!reconciler) {
    return c.json({ error: "Seat attention reconciler not configured on this daemon." }, 503);
  }
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const reason = typeof body["reason"] === "string" ? body["reason"].trim() : undefined;
  const result = await reconciler.clearAttention(sessionName, reason ? { reason } : undefined);
  if (!result.ok) {
    return c.json(result, result.code === "not_in_attention" ? 409 : 422);
  }
  return c.json(result, 200);
});

// POST /api/sessions/:sessionName/resume-token — OPR.0.4.0.22.
// Managed, attested, audited SET of a seat's durable resume token (the
// host-upgrade de-risk gate; replaces the manual-SQLite-edit anti-pattern).
// GUARDED by terminalAuthGuard() (credential write). The raw token arrives in
// the request BODY (the CLI reads it from stdin, never argv) and is NEVER
// echoed back, placed in an error message, logged, or written to the audit
// event — it is credential-class.
sessionAdminRoutes.post("/:sessionName/resume-token", terminalAuthGuard(), async (c) => {
  const sessionName = decodeURIComponent(c.req.param("sessionName")!);
  const { sessionRegistry } = getDeps(c);
  const eventBus = c.get("eventBus" as never) as EventBus | undefined;

  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const reason = typeof body["reason"] === "string" ? body["reason"].trim() : "";
  if (!reason) {
    return c.json({ error: "missing_reason", message: "set-resume-token requires --reason (operator attestation)." }, 400);
  }

  const ctx = sessionRegistry.findResumeContextByName(sessionName);
  if (!ctx) {
    return c.json({ error: "session_not_found", message: `Session '${sessionName}' not found.` }, 404);
  }

  // FR-2: validate per runtime; reject malformed. The error is redacted (it
  // never contains the token value).
  const validation = validateResumeToken(ctx.runtime, body["token"]);
  if (!validation.ok) {
    return c.json({ error: "invalid_token", message: validation.error }, 422);
  }

  // FR-1: operator/attested provenance OUTRANKS hook/scrape.
  sessionRegistry.updateResumeToken(ctx.sessionId, validation.resumeType, validation.token, "operator");

  // FR-5: append-only audit event — NO raw token.
  if (eventBus) {
    eventBus.emit({
      type: "session.resume_token_set",
      rigId: ctx.rigId,
      nodeId: ctx.nodeId,
      sessionName,
      sessionId: ctx.sessionId,
      resumeType: validation.resumeType,
      previousProvenance: (ctx.currentProvenance as "hook" | "scrape" | "operator" | null) ?? null,
      newProvenance: "operator",
      source: "operator_set",
      reason,
      redacted: true,
    });
  }

  // Response carries NO token (FR-2 redaction).
  return c.json({
    ok: true,
    sessionName,
    resumeType: validation.resumeType,
    provenance: "operator",
    previousProvenance: ctx.currentProvenance ?? null,
    reason,
    redacted: true,
  }, 200);
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
