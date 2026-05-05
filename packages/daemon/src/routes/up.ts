import nodePath from "node:path";
import { Hono } from "hono";
import type { BootstrapOrchestrator } from "../domain/bootstrap-orchestrator.js";
import type { BootstrapRepository } from "../domain/bootstrap-repository.js";
import type { EventBus } from "../domain/event-bus.js";
import type { UpCommandRouter } from "../domain/up-command-router.js";
import type { RigRepository } from "../domain/rig-repository.js";
import type { SnapshotRepository } from "../domain/snapshot-repository.js";
import type { SnapshotCapture } from "../domain/snapshot-capture.js";
import type { RestoreOrchestrator } from "../domain/restore-orchestrator.js";
import { assessCurrentStateRehydrateEligibility } from "../domain/rehydrate-eligibility.js";

export const upRoutes = new Hono();

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    bootstrapOrchestrator: c.get("bootstrapOrchestrator" as never) as BootstrapOrchestrator,
    bootstrapRepo: c.get("bootstrapRepo" as never) as BootstrapRepository,
    eventBus: c.get("eventBus" as never) as EventBus,
    upRouter: c.get("upRouter" as never) as UpCommandRouter,
    rigRepo: c.get("rigRepo" as never) as RigRepository,
    snapshotRepo: c.get("snapshotRepo" as never) as SnapshotRepository,
    snapshotCapture: c.get("snapshotCapture" as never) as SnapshotCapture,
    restoreOrchestrator: c.get("restoreOrchestrator" as never) as RestoreOrchestrator | undefined,
    runtimeAdapters: c.get("runtimeAdapters" as never) as Record<string, import("../domain/runtime-adapter.js").RuntimeAdapter> | undefined,
  };
}

/**
 * Restore a rig by ID from its latest restore-usable snapshot.
 *
 * L3b: prefers `auto-pre-down` when present (existing behavior preserved as a
 * preference signal) but falls back to the latest manual snapshot whose
 * structural metadata satisfies `RestoreOrchestrator.restore`'s pre-validation.
 * The response payload echoes `snapshotKind` so the operator/CLI can surface
 * which snapshot was used.
 *
 * Shared helper used by both /api/up (rig_name) and /api/rigs/:rigId/up (Explorer).
 */
async function restoreByRigId(rigId: string, rigName: string | null, deps: ReturnType<typeof getDeps>, c: { json: (data: unknown, status?: number) => Response }) {
  const { snapshotRepo, restoreOrchestrator } = deps;

  const rig = deps.rigRepo.getRig(rigId);
  if (!rig) {
    return c.json({ error: `Rig ${rigId} not found`, code: "rig_not_found" }, 404);
  }

  let snapshot = snapshotRepo.findLatestRestoreUsable(rigId);
  let capturedCurrentState = false;
  if (!snapshot) {
    const eligibility = assessCurrentStateRehydrateEligibility(snapshotRepo.db, rig);
    if (!eligibility.ok) {
      return c.json({
        error: `Rig exists but has no restore-usable snapshot and current DB state is insufficient for rehydrate. Start fresh with: rig up <spec-path>`,
        code: "no_snapshot",
        blockers: eligibility.blockers,
      }, 404);
    }
    snapshot = deps.snapshotCapture.captureSnapshot(rigId, "auto-rehydrate");
    capturedCurrentState = true;
  }

  if (!restoreOrchestrator) {
    return c.json({ error: "Restore orchestrator not available" }, 500);
  }

  const fs = await import("node:fs");
  const result = await restoreOrchestrator.restore(snapshot.id, {
    adapters: deps.runtimeAdapters ?? {},
    fsOps: { exists: (p: string) => fs.existsSync(p) },
  });
  if (!result.ok) {
    if (result.code === "pre_restore_validation_failed") {
      return c.json({
        status: "not_attempted",
        rigId,
        rigName,
        error: result.message,
        code: result.code,
        snapshotKind: snapshot.kind,
        ...result.result,
        remediation: result.result.blockers?.map((blocker) => blocker.remediation) ?? [],
      }, 409);
    }
    return c.json({ error: result.message, code: result.code }, result.code === "rig_not_stopped" ? 409 : 400);
  }

  // Compute attach command from first running node (same logic as /api/rigs/:id/up)
  const { getNodeInventory } = await import("../domain/node-inventory.js");
  const inventory = getNodeInventory(deps.snapshotRepo.db, rigId);
  const firstRunning = inventory.find((n) => n.canonicalSessionName && n.sessionStatus === "running");
  const attachCommand = firstRunning?.tmuxAttachCommand ?? inventory.find((n) => n.canonicalSessionName)?.tmuxAttachCommand ?? null;

  return c.json({
    status: "restored",
    rigId,
    rigName,
    snapshotId: snapshot.id,
    snapshotKind: snapshot.kind,
    rigResult: result.result.rigResult,
    nodes: result.result.nodes,
    warnings: capturedCurrentState
      ? ["No restore-usable snapshot existed; captured current DB state as auto-rehydrate snapshot for reboot recovery.", ...result.result.warnings]
      : result.result.warnings,
    attachCommand,
  }, 200);
}

// POST /api/up — the hero route
upRoutes.post("/", async (c) => {
  const { bootstrapOrchestrator, bootstrapRepo, eventBus, upRouter } = getDeps(c);
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const sourceRef = typeof body["sourceRef"] === "string" ? body["sourceRef"] : "";
  const plan = body["plan"] === true;
  const autoApprove = body["autoApprove"] === true;
  const cwdOverride = typeof body["cwdOverride"] === "string" ? body["cwdOverride"] : undefined;
  const targetRoot = typeof body["targetRoot"] === "string" ? body["targetRoot"] : undefined;

  if (!sourceRef) {
    return c.json({ error: "sourceRef is required" }, 400);
  }

  // Route source — classify raw sourceRef first, only resolve path for file-based kinds
  let sourceKind: string;
  let resolvedSourceRef = sourceRef;
  try {
    const route = upRouter.route(sourceRef);
    sourceKind = route.sourceKind;

    // Rig name: restore from latest auto-pre-down snapshot
    if (sourceKind === "rig_name") {
      const { rigRepo } = getDeps(c);
      const rigs = rigRepo.findRigsByName(sourceRef);
      if (rigs.length === 0) {
        return c.json({ error: `No rig found named "${sourceRef}". Provide a .yaml spec path to create a new rig.`, code: "rig_not_found" }, 404);
      }
      if (rigs.length > 1) {
        const ids = rigs.map((r) => r.id).join(", ");
        return c.json({ error: `Multiple rigs named "${sourceRef}" found (IDs: ${ids}). Use rig restore --rig <rigId> with a specific rig ID.`, code: "ambiguous_name" }, 409);
      }
      return restoreByRigId(rigs[0]!.id, sourceRef, getDeps(c), c) as any;
    }

    // File-based: resolve path now
    resolvedSourceRef = nodePath.resolve(sourceRef);
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
        sourceRef: resolvedSourceRef,
        sourceKind,
        cwdOverride,
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
        if (detail?.code === "file_not_found" || detail?.code === "parse_error" || detail?.code === "validation_failed" || detail?.code === "bundle_error" || detail?.code === "cycle_error" || detail?.code === "invalid_cwd") httpStatus = 400;
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
        sourceRef: resolvedSourceRef,
        sourceKind,
        autoApprove,
        cwdOverride,
        targetRoot,
        runId: run.id,
      });

      if (result.status === "completed") {
        eventBus.emit({ type: "bootstrap.completed", runId: result.runId, rigId: result.rigId!, sourceRef });

        // Compute attach command from first running node
        let attachCommand: string | null = null;
        if (result.rigId) {
          const { getNodeInventory } = await import("../domain/node-inventory.js");
          const inventory = getNodeInventory(bootstrapRepo.db, result.rigId);
          const firstRunning = inventory.find((n) => n.canonicalSessionName && n.sessionStatus === "running");
          attachCommand = firstRunning?.tmuxAttachCommand ?? inventory.find((n) => n.canonicalSessionName)?.tmuxAttachCommand ?? null;
        }

        return c.json({ ...result, attachCommand }, 201);
      }
      if (result.status === "partial") {
        const ok = result.stages.filter((s) => s.status === "ok").length;
        const fail = result.stages.filter((s) => s.status === "failed" || s.status === "blocked").length;
        eventBus.emit({ type: "bootstrap.partial", runId: result.runId, sourceRef, rigId: result.rigId, completed: ok, failed: fail });

        // Compute attach command from first running node
        let attachCommand: string | null = null;
        if (result.rigId) {
          const { getNodeInventory } = await import("../domain/node-inventory.js");
          const inventory = getNodeInventory(bootstrapRepo.db, result.rigId);
          const firstRunning = inventory.find((n) => n.canonicalSessionName && n.sessionStatus === "running");
          attachCommand = firstRunning?.tmuxAttachCommand ?? inventory.find((n) => n.canonicalSessionName)?.tmuxAttachCommand ?? null;
        }

        return c.json({ ...result, attachCommand }, 200);
      }
      eventBus.emit({ type: "bootstrap.failed", runId: result.runId, sourceRef, error: result.errors[0] ?? "failed" });
      const hasBlocked = result.stages.some((s) => s.status === "blocked");
      const hasBadRequest = result.stages.some((s) => {
        if (s.stage !== "resolve_spec") return false;
        const detail = s.detail as { code?: string } | undefined;
        return detail?.code === "file_not_found" || detail?.code === "parse_error" || detail?.code === "validation_failed" || detail?.code === "bundle_error" || detail?.code === "cycle_error" || detail?.code === "invalid_cwd";
      });
      return c.json(result, hasBlocked ? 409 : hasBadRequest ? 400 : 500);
    } catch (err) {
      bootstrapRepo.updateRunStatus(run.id, "failed");
      eventBus.emit({ type: "bootstrap.failed", runId: run.id, sourceRef, error: (err as Error).message });
      return c.json({ runId: run.id, status: "failed", error: (err as Error).message }, 500);
    }
  } finally {
    bootstrapOrchestrator.release(sourceRef);
  }
});
