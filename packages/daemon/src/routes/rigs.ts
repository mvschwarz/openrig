import { Hono } from "hono";
import type { RigRepository } from "../domain/rig-repository.js";
import type { SessionRegistry } from "../domain/session-registry.js";
import type { EventBus } from "../domain/event-bus.js";
import type { SnapshotRepository } from "../domain/snapshot-repository.js";
import type { RestoreOrchestrator } from "../domain/restore-orchestrator.js";
import { projectRigToGraph, type InventoryOverlay } from "../domain/graph-projection.js";
import { getNodeInventory, getNodeInventoryWithContext } from "../domain/node-inventory.js";
import type { ContextUsageStore } from "../domain/context-usage-store.js";
import type { Pod, ExpansionPodFragment } from "../domain/types.js";
import type { RigExpansionService } from "../domain/rig-expansion-service.js";
import type { RigLifecycleService } from "../domain/rig-lifecycle-service.js";

export const rigsRoutes = new Hono();

function normalizeExpansionPodFragment(raw: Record<string, unknown>): ExpansionPodFragment | null {
  if (!raw || typeof raw !== "object") return null;
  const id = raw["id"];
  const label = raw["label"];
  const members = raw["members"];
  if (typeof id !== "string" || !Array.isArray(members)) return null;

  return {
    id,
    label: typeof label === "string" ? label : id,
    summary: typeof raw["summary"] === "string" ? raw["summary"] : undefined,
    members: members.map((member) => {
      const m = (member ?? {}) as Record<string, unknown>;
      return {
        id: typeof m["id"] === "string" ? m["id"] : "",
        runtime: typeof m["runtime"] === "string" ? m["runtime"] : "",
        agentRef:
          typeof m["agentRef"] === "string"
            ? m["agentRef"]
            : typeof m["agent_ref"] === "string"
              ? m["agent_ref"]
              : undefined,
        profile: typeof m["profile"] === "string" ? m["profile"] : undefined,
        cwd: typeof m["cwd"] === "string" ? m["cwd"] : undefined,
        model: typeof m["model"] === "string" ? m["model"] : undefined,
        restorePolicy:
          typeof m["restorePolicy"] === "string"
            ? m["restorePolicy"]
            : typeof m["restore_policy"] === "string"
              ? m["restore_policy"]
              : undefined,
        label: typeof m["label"] === "string" ? m["label"] : undefined,
      };
    }),
    edges: Array.isArray(raw["edges"])
      ? raw["edges"].map((edge) => {
          const e = (edge ?? {}) as Record<string, unknown>;
          return {
            from: typeof e["from"] === "string" ? e["from"] : "",
            to: typeof e["to"] === "string" ? e["to"] : "",
            kind: typeof e["kind"] === "string" ? e["kind"] : "",
          };
        })
      : [],
  };
}

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
  const ctxStore = c.get("contextUsageStore" as never) as ContextUsageStore | undefined;
  const inventory = ctxStore
    ? getNodeInventoryWithContext(getRepo(c).db, rigId, ctxStore)
    : getNodeInventory(getRepo(c).db, rigId);
  const pods = getRepo(c).db
    .prepare("SELECT id, rig_id, namespace, label, summary, continuity_policy_json, created_at FROM pods WHERE rig_id = ? ORDER BY created_at")
    .all(rigId) as Array<{ id: string; rig_id: string; namespace: string; label: string; summary: string | null; continuity_policy_json: string | null; created_at: string }>;
  const overlay: InventoryOverlay[] = inventory.map((n) => ({
    logicalId: n.logicalId,
    startupStatus: n.startupStatus,
    canonicalSessionName: n.canonicalSessionName,
    restoreOutcome: n.restoreOutcome,
    contextUsedPercentage: n.contextUsage?.usedPercentage ?? null,
    contextFresh: n.contextUsage?.fresh ?? false,
    contextAvailability: n.contextUsage?.availability ?? "unknown",
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

// POST /api/rigs/:rigId/expand — dynamic rig expansion
rigsRoutes.post("/:rigId/expand", async (c) => {
  const rigId = c.req.param("rigId")!;
  const expansionService = c.get("rigExpansionService" as never) as RigExpansionService | undefined;
  if (!expansionService) {
    return c.json({ error: "Expansion service not available" }, 500);
  }

  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const pod = normalizeExpansionPodFragment((body["pod"] ?? {}) as Record<string, unknown>);
  if (!pod) {
    return c.json({ error: "pod is required with id and members[]" }, 400);
  }

  const crossPodEdges = Array.isArray(body["crossPodEdges"]) ? body["crossPodEdges"] as Array<{ from: string; to: string; kind: string }> : undefined;
  const rigRoot = typeof body["rigRoot"] === "string" ? body["rigRoot"] : undefined;

  const result = await expansionService.expand({ rigId, pod, crossPodEdges, rigRoot });

  if (!result.ok) {
    switch (result.code) {
      case "rig_not_found":
      case "target_rig_not_found":
        return c.json(result, 404);
      case "materialize_conflict":
        return c.json(result, 409);
      case "validation_failed":
      case "preflight_failed":
        return c.json(result, 400);
      default:
        return c.json(result, 500);
    }
  }

  const httpStatus = result.status === "ok" ? 201 : 207;
  return c.json(result, httpStatus);
});

// DELETE /api/rigs/:rigId/pods/:podRef
rigsRoutes.delete("/:rigId/pods/:podRef", async (c) => {
  const rigId = c.req.param("rigId")!;
  const podRef = decodeURIComponent(c.req.param("podRef")!);
  const lifecycleService = c.get("rigLifecycleService" as never) as RigLifecycleService | undefined;
  if (!lifecycleService) {
    return c.json({ error: "Lifecycle service not available" }, 500);
  }

  const result = await lifecycleService.shrinkPod(rigId, podRef);
  if (!result.ok) {
    const status = result.code === "rig_not_found" ? 404
      : result.code === "pod_not_found" ? 404
      : result.code === "kill_failed" ? 409
      : 500;
    return c.json(result, status);
  }

  return c.json(result, result.status === "ok" ? 200 : 207);
});
