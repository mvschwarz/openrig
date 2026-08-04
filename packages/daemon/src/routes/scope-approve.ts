// OPR.0.4.4.19 FR-9 — POST /api/scope/approve: the ONE write path behind
// `rig scope slice|mission approve`. Frontmatter stamp + append-only audit
// row in one daemon operation (scope-approve service owns ordering + the
// no-half-stamp guarantee).

import { Hono } from "hono";
import type { SliceIndexer } from "../domain/slices/slice-indexer.js";
import type { MissionControlActionLog } from "../domain/mission-control/mission-control-action-log.js";
import { ScopeApproveError, ScopeApproveService, type ApprovalScope, type ScopeTier } from "../domain/scope/scope-approve.js";

export function scopeApproveRoutes(): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const body = await c.req.json<{
      scopeTier?: string;
      scopePath?: string;
      approvalScope?: string;
      actorSession?: string;
      onBehalfOf?: string | null;
      reApprove?: boolean;
      reason?: string | null;
    }>().catch(() => ({} as never));

    if (body.scopeTier !== "slice" && body.scopeTier !== "mission") {
      return c.json({ error: "scope_tier_invalid", message: "scopeTier must be 'slice' or 'mission'" }, 400);
    }
    if (!body.scopePath) return c.json({ error: "scope_path_required", message: "scopePath is required" }, 400);
    if (!body.actorSession) return c.json({ error: "actor_session_required", message: "actorSession is required" }, 400);
    // Omitting approvalScope means delivery (back-compatible default).
    const approvalScope: ApprovalScope = body.approvalScope === undefined ? "delivery" : (body.approvalScope as ApprovalScope);
    if (approvalScope !== "spec" && approvalScope !== "delivery") {
      return c.json({ error: "approval_scope_invalid", message: "approvalScope must be 'spec' or 'delivery' (omit for delivery)" }, 400);
    }

    const indexer = c.get("sliceIndexer" as never) as SliceIndexer | undefined;
    const actionLog = c.get("missionControlActionLog" as never) as MissionControlActionLog | undefined;
    if (!actionLog) return c.json({ error: "action_log_unavailable" }, 503);

    const service = new ScopeApproveService({
      missionsRoot: () => (indexer?.isReady() ? indexer.slicesRoot : null),
      actionLog,
    });

    try {
      const result = service.approve({
        scopeTier: body.scopeTier as ScopeTier,
        scopePath: body.scopePath,
        approvalScope,
        actorSession: body.actorSession,
        onBehalfOf: body.onBehalfOf ?? null,
        reApprove: body.reApprove === true,
        reason: typeof body.reason === "string" ? body.reason : null,
      });
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof ScopeApproveError) {
        const status = err.code === "scope_not_found" ? 404
          : err.code === "already_approved" ? 409
          : err.code === "nothing_to_reapprove" ? 409
          : err.code === "workspace_not_configured" ? 503
          : err.code === "audit_write_failed" ? 500
          : 400;
        return c.json({ error: err.code, message: err.message, ...(err.details ?? {}) }, status as 200);
      }
      return c.json({ error: "internal", message: err instanceof Error ? err.message : "internal error" }, 500);
    }
  });

  return app;
}
