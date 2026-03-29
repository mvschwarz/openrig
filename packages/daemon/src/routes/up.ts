import nodePath from "node:path";
import { Hono } from "hono";
import type { BootstrapOrchestrator } from "../domain/bootstrap-orchestrator.js";
import type { BootstrapRepository } from "../domain/bootstrap-repository.js";
import type { EventBus } from "../domain/event-bus.js";
import type { UpCommandRouter } from "../domain/up-command-router.js";

export const upRoutes = new Hono();

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    bootstrapOrchestrator: c.get("bootstrapOrchestrator" as never) as BootstrapOrchestrator,
    bootstrapRepo: c.get("bootstrapRepo" as never) as BootstrapRepository,
    eventBus: c.get("eventBus" as never) as EventBus,
    upRouter: c.get("upRouter" as never) as UpCommandRouter,
  };
}

// POST /api/up — the hero route
upRoutes.post("/", async (c) => {
  const { bootstrapOrchestrator, bootstrapRepo, eventBus, upRouter } = getDeps(c);
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const sourceRef = typeof body["sourceRef"] === "string" ? body["sourceRef"] : "";
  const plan = body["plan"] === true;
  const autoApprove = body["autoApprove"] === true;
  const targetRoot = typeof body["targetRoot"] === "string" ? body["targetRoot"] : undefined;

  if (!sourceRef) {
    return c.json({ error: "sourceRef is required" }, 400);
  }

  // Route source
  let sourceKind: string;
  try {
    const route = upRouter.route(nodePath.resolve(sourceRef));
    sourceKind = route.sourceKind;
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  // Bundle apply requires targetRoot
  if (sourceKind === "rig_bundle" && !plan && !targetRoot) {
    return c.json({ error: "targetRoot is required for bundle apply mode" }, 400);
  }

  // Concurrency lock
  if (!bootstrapOrchestrator.tryAcquire(sourceRef)) {
    return c.json({ error: "Already in progress for this source", code: "conflict" }, 409);
  }

  try {
    if (plan) {
      // Plan mode — no run lifecycle
      const result = await bootstrapOrchestrator.bootstrap({
        mode: "plan",
        sourceRef: nodePath.resolve(sourceRef),
        sourceKind,
        targetRoot,
      });

      if (result.status === "planned") {
        eventBus.emit({ type: "bootstrap.planned", runId: result.runId, sourceRef, stages: result.stages.length });
        return c.json(result, 200);
      }
      // Plan failed
      eventBus.emit({ type: "bootstrap.failed", runId: result.runId, sourceRef, error: result.errors[0] ?? "plan failed" });
      const failedStage = result.stages.find((s) => s.status === "failed" || s.status === "blocked");
      let httpStatus: 400 | 409 | 500 = 500;
      if (failedStage?.status === "blocked") httpStatus = 409;
      else if (failedStage?.stage === "resolve_spec") {
        const detail = failedStage.detail as { code?: string } | undefined;
        if (detail?.code === "file_not_found" || detail?.code === "parse_error" || detail?.code === "validation_failed" || detail?.code === "bundle_error" || detail?.code === "cycle_error") httpStatus = 400;
      }
      return c.json(result, httpStatus);
    }

    // Apply mode — full lifecycle
    const run = bootstrapRepo.createRun(sourceKind, sourceRef);
    bootstrapRepo.updateRunStatus(run.id, "running");
    eventBus.emit({ type: "bootstrap.started", runId: run.id, sourceRef });

    try {
      const result = await bootstrapOrchestrator.bootstrap({
        mode: "apply",
        sourceRef: nodePath.resolve(sourceRef),
        sourceKind,
        autoApprove,
        targetRoot,
        runId: run.id,
      });

      if (result.status === "completed") {
        eventBus.emit({ type: "bootstrap.completed", runId: result.runId, rigId: result.rigId!, sourceRef });
        return c.json(result, 201);
      }
      if (result.status === "partial") {
        const ok = result.stages.filter((s) => s.status === "ok").length;
        const fail = result.stages.filter((s) => s.status === "failed" || s.status === "blocked").length;
        eventBus.emit({ type: "bootstrap.partial", runId: result.runId, sourceRef, rigId: result.rigId, completed: ok, failed: fail });
        return c.json(result, 200);
      }
      eventBus.emit({ type: "bootstrap.failed", runId: result.runId, sourceRef, error: result.errors[0] ?? "failed" });
      const hasBlocked = result.stages.some((s) => s.status === "blocked");
      return c.json(result, hasBlocked ? 409 : 500);
    } catch (err) {
      bootstrapRepo.updateRunStatus(run.id, "failed");
      eventBus.emit({ type: "bootstrap.failed", runId: run.id, sourceRef, error: (err as Error).message });
      return c.json({ runId: run.id, status: "failed", error: (err as Error).message }, 500);
    }
  } finally {
    bootstrapOrchestrator.release(sourceRef);
  }
});
