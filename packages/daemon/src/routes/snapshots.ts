import { Hono } from "hono";
import { RigNotFoundError } from "../domain/errors.js";
import type { SnapshotCapture } from "../domain/snapshot-capture.js";
import type { SnapshotRepository } from "../domain/snapshot-repository.js";
import type { RestoreOrchestrator } from "../domain/restore-orchestrator.js";

export const snapshotsRoutes = new Hono();
export const restoreRoutes = new Hono();

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    snapshotCapture: c.get("snapshotCapture" as never) as SnapshotCapture,
    snapshotRepo: c.get("snapshotRepo" as never) as SnapshotRepository,
    restoreOrchestrator: c.get("restoreOrchestrator" as never) as RestoreOrchestrator,
  };
}

// POST /api/rigs/:rigId/snapshots
snapshotsRoutes.post("/", async (c) => {
  const rigId = c.req.param("rigId")!;
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const kind = typeof body["kind"] === "string" ? body["kind"] : "manual";
  const { snapshotCapture } = getDeps(c);

  try {
    const snapshot = snapshotCapture.captureSnapshot(rigId, kind);
    return c.json(snapshot, 201);
  } catch (err) {
    if (err instanceof RigNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    return c.json({ error: "Failed to capture snapshot" }, 500);
  }
});

// GET /api/rigs/:rigId/snapshots
snapshotsRoutes.get("/", (c) => {
  const rigId = c.req.param("rigId")!;
  const { snapshotRepo } = getDeps(c);
  return c.json(snapshotRepo.listSnapshots(rigId));
});

// GET /api/rigs/:rigId/snapshots/:id
snapshotsRoutes.get("/:id", (c) => {
  const rigId = c.req.param("rigId")!;
  const id = c.req.param("id")!;
  const { snapshotRepo } = getDeps(c);

  const snapshot = snapshotRepo.getSnapshot(id);
  if (!snapshot || snapshot.rigId !== rigId) {
    return c.json({ error: "Snapshot not found" }, 404);
  }

  return c.json(snapshot);
});

// POST /api/rigs/:rigId/restore/:snapshotId
restoreRoutes.post("/:snapshotId", async (c) => {
  const rigId = c.req.param("rigId")!;
  const snapshotId = c.req.param("snapshotId")!;
  const { snapshotRepo, restoreOrchestrator } = getDeps(c);

  // Cross-rig guard: verify snapshot belongs to this rig
  const snapshot = snapshotRepo.getSnapshot(snapshotId);
  if (!snapshot || snapshot.rigId !== rigId) {
    return c.json({ error: "Snapshot not found" }, 404);
  }

  const adapters = c.get("runtimeAdapters" as never) as Record<string, import("../domain/runtime-adapter.js").RuntimeAdapter> | undefined;
  const fs = await import("node:fs");
  const outcome = await restoreOrchestrator.restore(snapshotId, {
    adapters: adapters ?? {},
    fsOps: { exists: (p: string) => fs.existsSync(p) },
  });

  if (!outcome.ok) {
    const status = outcome.code === "snapshot_not_found" || outcome.code === "rig_not_found"
      ? 404
      : outcome.code === "restore_in_progress" || outcome.code === "rig_not_stopped"
      ? 409
      : 500;
    return c.json({ error: outcome.message, code: outcome.code }, status);
  }

  // Compute attach command from first running node
  const { getNodeInventory } = await import("../domain/node-inventory.js");
  const inventory = getNodeInventory(restoreOrchestrator.db, rigId);
  const firstRunning = inventory.find((n) => n.canonicalSessionName && n.sessionStatus === "running");
  const attachCommand = firstRunning?.tmuxAttachCommand ?? inventory.find((n) => n.canonicalSessionName)?.tmuxAttachCommand ?? null;
  const inventoryByLogicalId = new Map(inventory.map((entry) => [entry.logicalId, entry]));
  const nodes = outcome.result.nodes.map((node) => {
    const detail = inventoryByLogicalId.get(node.logicalId);
    return {
      ...node,
      canonicalSessionName: detail?.canonicalSessionName ?? null,
      tmuxAttachCommand: detail?.tmuxAttachCommand ?? null,
      resumeCommand: detail?.resumeCommand ?? null,
      recoveryGuidance: detail?.recoveryGuidance ?? null,
      cwd: detail?.cwd ?? null,
    };
  });

  return c.json({ ...outcome.result, nodes, attachCommand });
});
