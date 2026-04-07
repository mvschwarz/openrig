import { Hono } from "hono";
import type { RigRepository } from "../domain/rig-repository.js";
import type { SessionRegistry } from "../domain/session-registry.js";
import type { EventBus } from "../domain/event-bus.js";
import type { SnapshotRepository } from "../domain/snapshot-repository.js";
import type { RestoreOrchestrator } from "../domain/restore-orchestrator.js";
import { projectRigToGraph, type InventoryOverlay } from "../domain/graph-projection.js";
import { getNodeInventory } from "../domain/node-inventory.js";
import type { Pod } from "../domain/types.js";

export const rigsRoutes = new Hono();

function getRepo(c: { get: (key: string) => unknown }): RigRepository {
  return c.get("rigRepo" as never) as RigRepository;
}

function getSessionRegistry(c: { get: (key: string) => unknown }): SessionRegistry {
  return c.get("sessionRegistry" as never) as SessionRegistry;
}

// GET /api/rigs/summary — MUST be registered before /:id to avoid Hono resolving "summary" as a rig ID
rigsRoutes.get("/summary", (c) => {
  const repo = getRepo(c);
  const summaries = repo.getRigSummaries();
  return c.json(summaries);
});

rigsRoutes.post("/", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const name = body["name"];
  if (!name || typeof name !== "string") {
    return c.json({ error: "name is required" }, 400);
  }
  const rig = getRepo(c).createRig(name);
  return c.json(rig, 201);
});

rigsRoutes.get("/", (c) => {
  const rigs = getRepo(c).listRigs();
  return c.json(rigs);
});

rigsRoutes.get("/:id", (c) => {
  const rig = getRepo(c).getRig(c.req.param("id"));
  if (!rig) {
    return c.json({ error: "rig not found" }, 404);
  }
  return c.json(rig);
});

rigsRoutes.get("/:id/graph", (c) => {
  const rig = getRepo(c).getRig(c.req.param("id"));
  if (!rig) {
    return c.json({ error: "rig not found" }, 404);
  }
  const rigId = c.req.param("id");
  const sessions = getSessionRegistry(c).getSessionsForRig(rigId);
  // Overlay inventory data for enriched graph fields
  const inventory = getNodeInventory(getRepo(c).db, rigId);
  const pods = getRepo(c).db
    .prepare("SELECT id, rig_id, namespace, label, summary, continuity_policy_json, created_at FROM pods WHERE rig_id = ? ORDER BY created_at")
    .all(rigId) as Array<{ id: string; rig_id: string; namespace: string; label: string; summary: string | null; continuity_policy_json: string | null; created_at: string }>;
  const overlay: InventoryOverlay[] = inventory.map((n) => ({
    logicalId: n.logicalId,
    startupStatus: n.startupStatus,
    canonicalSessionName: n.canonicalSessionName,
    restoreOutcome: n.restoreOutcome,
  }));
  const projectedPods: Pod[] = pods.map((pod) => ({
    id: pod.id,
    rigId: pod.rig_id,
    namespace: pod.namespace,
    label: pod.label,
    summary: pod.summary,
    continuityPolicyJson: pod.continuity_policy_json,
    createdAt: pod.created_at,
  }));
  return c.json(projectRigToGraph({ ...rig, sessions, pods: projectedPods }, overlay));
});

rigsRoutes.delete("/:id", (c) => {
  const rigId = c.req.param("id");
  const repo = getRepo(c);
  const eventBus = c.get("eventBus" as never) as EventBus;

  // Only emit event + delete if rig exists
  const rig = repo.getRig(rigId);
  if (!rig) {
    return c.body(null, 204);
  }

  // Atomic: event persist + rig delete in one transaction
  // Uses eventBus.db (same handle as rigRepo.db — enforced by shared AppDeps)
  const txn = eventBus.db.transaction(() => {
    const persisted = eventBus.persistWithinTransaction({
      type: "rig.deleted",
      rigId,
    });
    repo.deleteRig(rigId);
    return persisted;
  });

  try {
    const persistedEvent = txn();
    eventBus.notifySubscribers(persistedEvent);
    return c.body(null, 204);
  } catch (err) {
    return c.json({ error: "delete failed" }, 500);
  }
});

// POST /api/rigs/:id/up — power-on an existing rig from auto-pre-down snapshot
rigsRoutes.post("/:id/up", async (c) => {
  const rigId = c.req.param("id")!;
  const repo = getRepo(c);
  const rig = repo.getRig(rigId);
  if (!rig) return c.json({ error: `Rig "${rigId}" not found. List rigs with: rig ps` }, 404);

  const snapshotRepo = c.get("snapshotRepo" as never) as SnapshotRepository;
  const snapshot = snapshotRepo.findLatestAutoPreDown(rigId);
  if (!snapshot) {
    return c.json({ error: `Rig "${rig.rig.name}" exists but has no auto-pre-down snapshot. Start fresh with: rig up <spec-path>`, code: "no_snapshot" }, 404);
  }

  const restoreOrch = c.get("restoreOrchestrator" as never) as RestoreOrchestrator | undefined;
  if (!restoreOrch) {
    return c.json({ error: "Restore orchestrator not available" }, 500);
  }

  const adapters = c.get("runtimeAdapters" as never) as Record<string, import("../domain/runtime-adapter.js").RuntimeAdapter> | undefined;
  const fs = await import("node:fs");
  const result = await restoreOrch.restore(snapshot.id, {
    adapters: adapters ?? {},
    fsOps: { exists: (p: string) => fs.existsSync(p) },
  });
  if (!result.ok) {
    return c.json({ error: result.message, code: result.code }, result.code === "rig_not_stopped" ? 409 : 400);
  }

  // Compute attach command from first running/resumed node (same logic as /api/up)
  const { getNodeInventory } = await import("../domain/node-inventory.js");
  const inventory = getNodeInventory(repo.db, rigId);
  const firstRunning = inventory.find((n) => n.canonicalSessionName && n.sessionStatus === "running");
  const attachCommand = firstRunning?.tmuxAttachCommand ?? inventory.find((n) => n.canonicalSessionName)?.tmuxAttachCommand ?? null;

  return c.json({
    status: "restored",
    rigId,
    rigName: rig.rig.name,
    snapshotId: snapshot.id,
    nodes: result.result.nodes,
    warnings: result.result.warnings,
    attachCommand,
  }, 200);
});
