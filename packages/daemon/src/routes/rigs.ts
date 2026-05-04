import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { RigRepository } from "../domain/rig-repository.js";
import type { SessionRegistry } from "../domain/session-registry.js";
import type { EventBus } from "../domain/event-bus.js";
import type { SnapshotRepository } from "../domain/snapshot-repository.js";
import type { RestoreOrchestrator } from "../domain/restore-orchestrator.js";
import { projectRigToGraph, type InventoryOverlay, type CurrentQitemSummary } from "../domain/graph-projection.js";
import { getNodeInventory, getNodeInventoryWithContext, attachAgentActivity } from "../domain/node-inventory.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { AgentActivityStore } from "../domain/agent-activity-store.js";
import { deriveRigLifecycleState } from "../domain/ps-projection.js";
import type { ContextUsageStore } from "../domain/context-usage-store.js";
import type { Pod, ExpansionPodFragment } from "../domain/types.js";
import type { RigExpansionService } from "../domain/rig-expansion-service.js";
import type { RigLifecycleService } from "../domain/rig-lifecycle-service.js";
import type { SelfAttachService } from "../domain/self-attach-service.js";

export const rigsRoutes = new Hono();

// PL-019 item 5: read-side join helper. Returns map of
// destination_session → in-progress qitems (capped at MAX_QITEMS_PER_NODE
// per node), keyed by canonicalSessionName so the route can stitch into
// the InventoryOverlay. Body is excerpted to stay phone-friendly in
// tooltip / drawer surfaces (item 5's UI consumers).
const MAX_QITEMS_PER_NODE = 3;
const BODY_EXCERPT_MAX_CHARS = 80;

export function loadCurrentQitemsForSessions(
  db: Database.Database,
  sessionNames: string[]
): Map<string, CurrentQitemSummary[]> {
  const out = new Map<string, CurrentQitemSummary[]>();
  if (sessionNames.length === 0) return out;
  const placeholders = sessionNames.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT qitem_id, destination_session, body, tier
       FROM queue_items
       WHERE state = 'in-progress' AND destination_session IN (${placeholders})
       ORDER BY ts_updated DESC`
  ).all(...sessionNames) as Array<{ qitem_id: string; destination_session: string; body: string; tier: string | null }>;
  for (const row of rows) {
    const list = out.get(row.destination_session) ?? [];
    if (list.length < MAX_QITEMS_PER_NODE) {
      list.push({
        qitemId: row.qitem_id,
        bodyExcerpt: row.body.length > BODY_EXCERPT_MAX_CHARS
          ? `${row.body.slice(0, BODY_EXCERPT_MAX_CHARS)}…`
          : row.body,
        tier: row.tier,
      });
    }
    out.set(row.destination_session, list);
  }
  return out;
}

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
      const rawSessionSource = (m["sessionSource"] ?? m["session_source"]) as unknown;
      let sessionSource: import("../domain/types.js").SessionSourceSpec | undefined;
      if (rawSessionSource !== undefined && rawSessionSource !== null && typeof rawSessionSource === "object") {
        const ss = rawSessionSource as Record<string, unknown>;
        const mode = ss["mode"];
        const ref = ss["ref"];
        if (ref !== null && typeof ref === "object") {
          const refRec = ref as Record<string, unknown>;
          const kind = refRec["kind"];
          if (mode === "fork" && (kind === "native_id" || kind === "artifact_path" || kind === "name" || kind === "last")) {
            const value = typeof refRec["value"] === "string" ? (refRec["value"] as string) : undefined;
            sessionSource = { mode: "fork", ref: { kind, ...(value !== undefined ? { value } : {}) } };
          } else if (mode === "rebuild" && kind === "artifact_set" && Array.isArray(refRec["value"])) {
            const paths: string[] = [];
            for (const p of refRec["value"] as unknown[]) {
              if (typeof p === "string" && p.trim() !== "") paths.push(p);
            }
            if (paths.length > 0) {
              sessionSource = { mode: "rebuild", ref: { kind: "artifact_set", value: paths } };
            }
          }
        }
      }
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
        codexConfigProfile:
          typeof m["codexConfigProfile"] === "string"
            ? m["codexConfigProfile"]
            : typeof m["codex_config_profile"] === "string"
              ? m["codex_config_profile"]
              : undefined,
        cwd: typeof m["cwd"] === "string" ? m["cwd"] : undefined,
        model: typeof m["model"] === "string" ? m["model"] : undefined,
        restorePolicy:
          typeof m["restorePolicy"] === "string"
            ? m["restorePolicy"]
            : typeof m["restore_policy"] === "string"
              ? m["restore_policy"]
              : undefined,
        label: typeof m["label"] === "string" ? m["label"] : undefined,
        ...(sessionSource ? { sessionSource } : {}),
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

function getRigLifecycleService(c: { get: (key: string) => unknown }): RigLifecycleService | undefined {
  return c.get("rigLifecycleService" as never) as RigLifecycleService | undefined;
}

function getSelfAttachService(c: { get: (key: string) => unknown }): SelfAttachService | undefined {
  return c.get("selfAttachService" as never) as SelfAttachService | undefined;
}

// GET /api/rigs/summary — MUST be registered before /:id to avoid Hono resolving "summary" as a rig ID
rigsRoutes.get("/summary", (c) => {
  const repo = getRepo(c);
  const summaries = repo.getRigSummaries();
  // Enrich with rig-level lifecycleState so CLI surfaces (rig up wording, recover vs
  // turn-on) can choose the right operator action without a second round trip.
  const enriched = summaries.map((s) => {
    const inventory = getNodeInventory(repo.db, s.id);
    const lifecycleState = deriveRigLifecycleState(inventory.map((e) => e.lifecycleState));
    return { ...s, lifecycleState };
  });
  return c.json(enriched);
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

rigsRoutes.get("/:id/graph", async (c) => {
  const rig = getRepo(c).getRig(c.req.param("id"));
  if (!rig) {
    return c.json({ error: "rig not found" }, 404);
  }
  const rigId = c.req.param("id");
  const sessions = getSessionRegistry(c).getSessionsForRig(rigId);
  // Overlay inventory data for enriched graph fields.
  const ctxStore = c.get("contextUsageStore" as never) as ContextUsageStore | undefined;
  const inventory = ctxStore
    ? getNodeInventoryWithContext(getRepo(c).db, rigId, ctxStore)
    : getNodeInventory(getRepo(c).db, rigId);

  // PL-019 item 4: enrich inventory with agentActivity at graph-payload time
  // so UI consumers receive activity in a single fetch (no separate
  // /api/rigs/:id/nodes round-trip just to color the topology dots).
  const tmuxAdapter = c.get("tmuxAdapter" as never) as TmuxAdapter | undefined;
  const agentActivityStore = c.get("agentActivityStore" as never) as AgentActivityStore | undefined;
  const inventoryWithActivity = tmuxAdapter
    ? await attachAgentActivity(inventory, { tmuxAdapter, activityStore: agentActivityStore })
    : inventory;

  // PL-019 item 5: read-side join for active-qitem enrichment. Cheap by
  // virtue of the existing idx_queue_items_destination_state index. The
  // helper is exported so it can be unit-tested without spinning up the
  // full route stack.
  const currentQitemsBySession = loadCurrentQitemsForSessions(
    getRepo(c).db,
    inventoryWithActivity
      .map((n) => n.canonicalSessionName)
      .filter((s): s is string => Boolean(s))
  );

  const pods = getRepo(c).db
    .prepare("SELECT id, rig_id, namespace, label, summary, continuity_policy_json, created_at FROM pods WHERE rig_id = ? ORDER BY created_at")
    .all(rigId) as Array<{ id: string; rig_id: string; namespace: string; label: string; summary: string | null; continuity_policy_json: string | null; created_at: string }>;
  const overlay: InventoryOverlay[] = inventoryWithActivity.map((n) => ({
    logicalId: n.logicalId,
    startupStatus: n.startupStatus,
    canonicalSessionName: n.canonicalSessionName,
    restoreOutcome: n.restoreOutcome,
    contextUsedPercentage: n.contextUsage?.usedPercentage ?? null,
    contextFresh: n.contextUsage?.fresh ?? false,
    contextAvailability: n.contextUsage?.availability ?? "unknown",
    agentActivity: n.agentActivity ?? null,
    currentQitems: n.canonicalSessionName
      ? currentQitemsBySession.get(n.canonicalSessionName) ?? []
      : [],
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

// POST /api/rigs/:id/release — non-destructive release of claimed sessions
rigsRoutes.post("/:id/release", async (c) => {
  const rigId = c.req.param("id")!;
  const rigLifecycleService = getRigLifecycleService(c);
  if (!rigLifecycleService) {
    return c.json({ error: "Rig lifecycle service not available" }, 500);
  }

  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const result = await rigLifecycleService.releaseRig(rigId, {
    delete: body["delete"] === true,
  });

  if (result.ok) {
    return c.json(result, result.status === "partial" ? 207 : 200);
  }

  switch (result.code) {
    case "rig_not_found":
      return c.json(result, 404);
    case "contains_launched_nodes":
      return c.json(result, 409);
    default:
      return c.json(result, 500);
  }
});

// POST /api/rigs/:id/attach-self — attach the current shell/agent, tmux-backed or external
rigsRoutes.post("/:id/attach-self", async (c) => {
  const rigId = c.req.param("id")!;
  const selfAttachService = getSelfAttachService(c);
  if (!selfAttachService) {
    return c.json({ error: "Self-attach service not available" }, 500);
  }

  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const logicalId = typeof body["logicalId"] === "string" ? body["logicalId"].trim() : "";
  const podNamespace = typeof body["podNamespace"] === "string" ? body["podNamespace"].trim() : "";
  const memberName = typeof body["memberName"] === "string" ? body["memberName"].trim() : "";
  const runtime = typeof body["runtime"] === "string" ? body["runtime"].trim() : "";
  const cwd = typeof body["cwd"] === "string" ? body["cwd"] : undefined;
  const displayName = typeof body["displayName"] === "string" ? body["displayName"] : undefined;
  const attachmentType = typeof body["attachmentType"] === "string" ? body["attachmentType"].trim() : "";
  const tmuxSession = typeof body["tmuxSession"] === "string" ? body["tmuxSession"].trim() : "";
  const tmuxWindow = typeof body["tmuxWindow"] === "string" ? body["tmuxWindow"].trim() : "";
  const tmuxPane = typeof body["tmuxPane"] === "string" ? body["tmuxPane"].trim() : "";

  const hasNodeTarget = logicalId.length > 0;
  const hasPodFields = podNamespace.length > 0 || memberName.length > 0 || runtime.length > 0;

  if (hasNodeTarget && hasPodFields) {
    return c.json({ error: "Specify either logicalId or podNamespace + memberName + runtime" }, 400);
  }
  if (!hasNodeTarget && !hasPodFields) {
    return c.json({ error: "Specify either logicalId or podNamespace + memberName + runtime" }, 400);
  }
  if (!hasNodeTarget && (!podNamespace || !memberName)) {
    return c.json({ error: "podNamespace and memberName are required when attaching into a pod" }, 400);
  }
  if (attachmentType && attachmentType !== "tmux" && attachmentType !== "external_cli") {
    return c.json({ error: "attachmentType must be 'tmux' or 'external_cli'" }, 400);
  }
  if (attachmentType === "tmux" && !tmuxSession) {
    return c.json({ error: "tmuxSession is required when attachmentType is 'tmux'" }, 400);
  }

  const context = attachmentType === "tmux" || tmuxSession
    ? {
        attachmentType: "tmux" as const,
        tmuxSession,
        tmuxWindow: tmuxWindow || undefined,
        tmuxPane: tmuxPane || undefined,
      }
    : undefined;

  const result = hasNodeTarget
    ? await selfAttachService.attachToNode({ rigId, logicalId, runtime: runtime || undefined, cwd, displayName, context })
    : await selfAttachService.attachToPod({ rigId, podNamespace, memberName, runtime, cwd, displayName, context });

  if (result.ok) {
    return c.json(result, 201);
  }

  switch (result.code) {
    case "rig_not_found":
    case "node_not_found":
    case "pod_not_found":
      return c.json(result, 404);
    case "runtime_required":
      return c.json(result, 400);
    case "already_bound":
    case "duplicate_logical_id":
    case "invalid_member_name":
    case "runtime_mismatch":
      return c.json(result, 409);
    default:
      return c.json(result, 500);
  }
});

// POST /api/rigs/:id/up — power-on an existing rig from its latest restore-usable snapshot
// L3b: prefers `auto-pre-down` when present but falls back to the latest manual
// snapshot whose structural metadata satisfies pre-validation. Echoes
// `snapshotKind` so operators see which snapshot was used.
rigsRoutes.post("/:id/up", async (c) => {
  const rigId = c.req.param("id")!;
  const repo = getRepo(c);
  const rig = repo.getRig(rigId);
  if (!rig) return c.json({ error: `Rig "${rigId}" not found. List rigs with: rig ps` }, 404);

  const snapshotRepo = c.get("snapshotRepo" as never) as SnapshotRepository;
  const snapshot = snapshotRepo.findLatestRestoreUsable(rigId);
  if (!snapshot) {
    return c.json({ error: `Rig "${rig.rig.name}" exists but has no restore-usable snapshot. Start fresh with: rig up <spec-path>`, code: "no_snapshot" }, 404);
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
    if (result.code === "pre_restore_validation_failed") {
      return c.json({
        status: "not_attempted",
        rigId,
        rigName: rig.rig.name,
        error: result.message,
        code: result.code,
        snapshotKind: snapshot.kind,
        ...result.result,
        remediation: result.result.blockers?.map((blocker) => blocker.remediation) ?? [],
      }, 409);
    }
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
    snapshotKind: snapshot.kind,
    rigResult: result.result.rigResult,
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
