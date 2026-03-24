import { Hono } from "hono";
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
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("not found")) {
      return c.json({ error: message }, 404);
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

  const outcome = await restoreOrchestrator.restore(snapshotId);

  if (!outcome.ok) {
    const status = outcome.code === "snapshot_not_found" || outcome.code === "rig_not_found"
      ? 404
      : outcome.code === "restore_in_progress"
      ? 409
      : 500;
    return c.json({ error: outcome.message, code: outcome.code }, status);
  }

  return c.json(outcome.result);
});
