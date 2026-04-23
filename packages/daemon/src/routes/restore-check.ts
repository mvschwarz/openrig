import { existsSync, readFileSync } from "node:fs";
import { Hono } from "hono";
import { RestoreCheckService, type RestoreCheckDeps, type NodeInventoryEntry } from "../domain/restore-check-service.js";
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
        return getNodeInventory(deps.rigRepo.db, rigId) as NodeInventoryEntry[];
      },
      hasSnapshot: (rigId: string) => {
        return deps.snapshotRepo.listSnapshots(rigId).length > 0;
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
