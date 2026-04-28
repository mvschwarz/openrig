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
//
// L3: returns `{ ok: true, attemptId, status: "started", rigId }` AS SOON AS the
// orchestrator has emitted `restore.started`, BEFORE per-node restore work
// completes. The persisted `restore.started` event seq IS the attempt id
// (Decision 1: no separate restore_attempts table). Per-node work continues in
// the background; clients query event log / node inventory to follow progress.
//
// Pre-restore validation failures and other "couldn't even start" errors return
// the original error payloads with appropriate HTTP status codes (404/409/500),
// because in those cases no `restore.started` event was emitted.
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

  return new Promise<Response>((resolve) => {
    let resolved = false;

    const restorePromise = restoreOrchestrator.restore(snapshotId, {
      adapters: adapters ?? {},
      fsOps: { exists: (p: string) => fs.existsSync(p) },
      onAttemptStarted: (attemptId) => {
        if (resolved) return;
        resolved = true;
        // Per-node restore work runs in background; client receives attemptId
        // immediately and can poll /api/events or node inventory for progress.
        resolve(c.json({ ok: true, attemptId, status: "started", rigId }, 202));
      },
    });

    restorePromise
      .then((outcome) => {
        if (resolved) {
          // Background path: response already sent. Per-node failures are in
          // the event log; no need to do anything here.
          return;
        }
        // Pre-restore-started error path: no `restore.started` was emitted, so
        // the route should respond with the original error mapping.
        resolved = true;
        if (!outcome.ok) {
          if (outcome.code === "pre_restore_validation_failed") {
            resolve(c.json({
              error: outcome.message,
              code: outcome.code,
              ...outcome.result,
              remediation: outcome.result.blockers?.map((blocker) => blocker.remediation) ?? [],
            }, 409));
            return;
          }
          const status = outcome.code === "snapshot_not_found" || outcome.code === "rig_not_found"
            ? 404
            : outcome.code === "restore_in_progress" || outcome.code === "rig_not_stopped"
            ? 409
            : 500;
          resolve(c.json({ error: outcome.message, code: outcome.code }, status));
          return;
        }
        // Defensive: outcome.ok with no onAttemptStarted firing means the
        // orchestrator emitted restore.started but the callback was somehow
        // bypassed. Surface the result anyway with a synthesized attemptId.
        resolve(c.json({ ok: true, attemptId: -1, status: "completed", rigId, result: outcome.result }, 200));
      })
      .catch((err) => {
        if (resolved) return;
        resolved = true;
        resolve(c.json({
          error: err instanceof Error ? err.message : String(err),
          code: "restore_error",
        }, 500));
      });
  });
});
