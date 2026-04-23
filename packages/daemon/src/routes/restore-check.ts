import { existsSync, readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { RestoreCheckService, type RestoreCheckDeps, type NodeInventoryEntry, type StartupContextProbeResult } from "../domain/restore-check-service.js";
import { getNodeInventory } from "../domain/node-inventory.js";
import type { RigRepository } from "../domain/rig-repository.js";
import type { SnapshotRepository } from "../domain/snapshot-repository.js";

function getDeps(c: { get(key: never): unknown }): {
  rigRepo: RigRepository;
  snapshotRepo: SnapshotRepository;
} {
  return {
    rigRepo: c.get("rigRepo" as never) as RigRepository,
    snapshotRepo: c.get("snapshotRepo" as never) as SnapshotRepository,
  };
}

export const restoreCheckRoutes = new Hono();

function getNodeIdMap(db: Database.Database, rigId: string): Map<string, string> {
  const rows = db.prepare(
    "SELECT id, logical_id FROM nodes WHERE rig_id = ?"
  ).all(rigId) as Array<{ id: string; logical_id: string }>;
  return new Map(rows.map((row) => [row.logical_id, row.id]));
}

function parseStartupContextJsonField<T>(
  raw: string,
  fieldName: string,
  nodeId: string,
): { ok: true; value: T } | { ok: false; evidence: string } {
  try {
    const parsed = JSON.parse(raw) as T;
    return { ok: true, value: parsed };
  } catch (err) {
    return {
      ok: false,
      evidence: `Persisted startup context JSON parse failed for node ${nodeId} field ${fieldName}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function getStartupContext(db: Database.Database, nodeId: string): StartupContextProbeResult {
  try {
    const row = db.prepare(
      "SELECT projection_entries_json, resolved_files_json, startup_actions_json, runtime FROM node_startup_context WHERE node_id = ?"
    ).get(nodeId) as
      | {
          projection_entries_json: string;
          resolved_files_json: string;
          startup_actions_json: string;
          runtime: string | null;
        }
      | undefined;

    if (!row) {
      return {
        status: "missing",
        evidence: `Persisted startup context missing for node ${nodeId}`,
      };
    }

    const resolvedFiles = parseStartupContextJsonField<unknown[]>(row.resolved_files_json, "resolved_files_json", nodeId);
    if (!resolvedFiles.ok) {
      return { status: "malformed", evidence: resolvedFiles.evidence };
    }
    if (!Array.isArray(resolvedFiles.value)) {
      return {
        status: "malformed",
        evidence: `Persisted startup context field resolved_files_json is not an array for node ${nodeId}`,
      };
    }

    const projectionEntries = parseStartupContextJsonField<unknown[]>(row.projection_entries_json, "projection_entries_json", nodeId);
    if (!projectionEntries.ok) {
      return { status: "malformed", evidence: projectionEntries.evidence };
    }
    if (!Array.isArray(projectionEntries.value)) {
      return {
        status: "malformed",
        evidence: `Persisted startup context field projection_entries_json is not an array for node ${nodeId}`,
      };
    }

    return {
      status: "ok",
      runtime: row.runtime,
      resolvedStartupFiles: resolvedFiles.value.flatMap((file) => {
        if (!file || typeof file !== "object") return [];
        const candidate = file as Record<string, unknown>;
        if (typeof candidate["absolutePath"] !== "string" || candidate["absolutePath"].trim() === "") return [];
        return [{
          absolutePath: candidate["absolutePath"].trim(),
          required: candidate["required"] !== false,
          path: typeof candidate["path"] === "string" ? candidate["path"] : null,
          deliveryHint: typeof candidate["deliveryHint"] === "string" ? candidate["deliveryHint"] : null,
        }];
      }),
      projectionEntries: projectionEntries.value.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const candidate = entry as Record<string, unknown>;
        if (typeof candidate["absolutePath"] !== "string" || candidate["absolutePath"].trim() === "") return [];
        return [{
          absolutePath: candidate["absolutePath"].trim(),
          effectiveId: typeof candidate["effectiveId"] === "string" ? candidate["effectiveId"] : null,
          category: typeof candidate["category"] === "string" ? candidate["category"] : null,
        }];
      }),
    };
  } catch (err) {
    return {
      status: "probe_error",
      evidence: err instanceof Error ? err.message : String(err),
    };
  }
}

// GET /api/restore-check?rig=<name>&noQueue=true&noHooks=true
restoreCheckRoutes.get("/", (c) => {
  const deps = getDeps(c);
  const rigFilter = c.req.query("rig") ?? undefined;
  const noQueue = c.req.query("noQueue") === "true";
  const noHooks = c.req.query("noHooks") === "true";

  try {
    const serviceDeps: RestoreCheckDeps = {
      listRigs: () => {
        const rigs = deps.rigRepo.listRigs();
        return rigs.map((r) => ({ rigId: r.id, name: r.name }));
      },
      getNodeInventory: (rigId: string) => {
        const nodeIdByLogicalId = getNodeIdMap(deps.rigRepo.db, rigId);
        return getNodeInventory(deps.rigRepo.db, rigId).map((entry) => ({
          ...entry,
          nodeId: nodeIdByLogicalId.get(entry.logicalId) ?? null,
        })) as NodeInventoryEntry[];
      },
      getStartupContext: (nodeId: string) => {
        return getStartupContext(deps.rigRepo.db, nodeId);
      },
      hasSnapshot: (rigId: string) => {
        return deps.snapshotRepo.listSnapshots(rigId).length > 0;
      },
      getLatestSnapshot: (rigId: string) => {
        const snapshot = deps.snapshotRepo.getLatestSnapshot(rigId);
        return snapshot ? { id: snapshot.id, kind: snapshot.kind } : null;
      },
      probeDaemonHealth: () => {
        // We're inside the daemon — if this route is responding, daemon is healthy
        return { healthy: true, evidence: "Daemon running (responding to API requests)" };
      },
      exists: (path: string) => {
        try { return existsSync(path); } catch { return false; }
      },
      readFile: (path: string) => readFileSync(path, "utf-8"),
    };

    const service = new RestoreCheckService(serviceDeps);
    const result = service.check({ rig: rigFilter, noQueue, noHooks });

    return c.json(result);
  } catch (err) {
    const evidence = `Service error: ${err instanceof Error ? err.message : String(err)}`;

    return c.json({
      verdict: "unknown",
      fullyBack: false,
      assertion: {
        level: "host",
        status: "unknown",
        reason: "unknown_probe_state",
        blockingRigCount: 0,
        caveatRigCount: 0,
        unknownRigCount: 0,
      },
      rigs: [],
      hostInfra: {
        status: "unknown",
        evidence: "Host bootstrap/autostart source could not be inspected because restore-check route failed",
      },
      recovery: {
        status: "unknown",
        summary: "Recovery status could not be inspected because the restore-check route failed.",
        actions: [],
        blocked: [],
        unknown: [{
          scope: "host",
          reason: evidence,
        }],
      },
      counts: { red: 0, yellow: 0, green: 0 },
      checks: [{
        check: "probe.error",
        status: "red",
        evidence,
        remediation: "Check daemon logs with: rig daemon logs",
      }],
      repairPacket: [{
        step: 1,
        command: "Check daemon logs with: rig daemon logs",
        rationale: evidence,
        safe: true,
        blocking: true,
      }],
    }, 500);
  }
});
