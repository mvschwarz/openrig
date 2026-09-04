// B1 — the crash-cart RESTORE CONDUCTOR route (daemon-side batch verb). Plan-locked
// (B1-CRASH-CART-CONDUCTOR-PLAN-2026-08-21, content-hash 84401cd4). ASYNC on-commit
// shape (the locked rollup-stream / onAttemptStarted design): the route starts the
// conductor in the BACKGROUND and answers immediately with a fleet-attempt handle —
// it NEVER blocks to fleet completion (a real fleet restore is seconds-per-seat and
// would exceed any request timeout). The client polls the status endpoint for the
// rollup + triage as rigs complete. A cancel endpoint sets stop-before-next-rig.
import { Hono } from "hono";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { RigRepository } from "../domain/rig-repository.js";
import type { SnapshotRepository } from "../domain/snapshot-repository.js";
import type { RestoreOrchestrator } from "../domain/restore-orchestrator.js";
import type { RuntimeAdapter } from "../domain/runtime-adapter.js";
import type { SessionRegistry } from "../domain/session-registry.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { ClaimService } from "../domain/claim-service.js";
import {
  RestoreConductor,
  createDefaultRestoreRig,
  listRigsInKernelFirstOrder,
  aggregateFleetRollup,
  deriveFleetVerdict,
  type AdoptRigDeps,
  type FleetRollup,
  type ConductorRigResult,
} from "../domain/crash-cart-conductor.js";

export const crashCartRoutes = new Hono();

/** A live fleet-restore attempt — the pollable progress/rollup state, updated by the
 *  background conductor as each rig completes. In-memory per daemon process (v1).
 *  NO verdict field: per ARCH-RULING Q2 / plan R6 the fleet verdict is a DERIVED
 *  f(counts), never a stored second truth — it is computed in the GET handler. */
interface FleetAttempt {
  sequence: ConductorRigResult[];
  rollup: FleetRollup;
  done: boolean;
  cancelled: boolean;
}
const fleetAttempts = new Map<string, FleetAttempt>();

// Exported ONLY for tests — reset the in-memory store between cases.
export function __resetFleetAttempts(): void {
  fleetAttempts.clear();
}

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    rigRepo: c.get("rigRepo" as never) as RigRepository,
    snapshotRepo: c.get("snapshotRepo" as never) as SnapshotRepository,
    restoreOrchestrator: c.get("restoreOrchestrator" as never) as RestoreOrchestrator,
    // H1 — the app's runtime adapters + fs, WITHOUT which the orchestrator fail-closes
    // a pod-aware resume to awaiting-decision (seats can't return in their panes).
    runtimeAdapters: c.get("runtimeAdapters" as never) as Record<string, RuntimeAdapter> | undefined,
    // AMENDMENT 2 — the shipped machinery the adopt branch composes.
    sessionRegistry: c.get("sessionRegistry" as never) as SessionRegistry | undefined,
    tmuxAdapter: c.get("tmuxAdapter" as never) as TmuxAdapter | undefined,
    claimService: c.get("claimService" as never) as ClaimService | undefined,
  };
}

/** AMENDMENT 2 — build the adopt deps from the SHIPPED machinery, or undefined when a
 *  degraded daemon lacks any of it (the conductor then behaves exactly pre-amendment:
 *  a live-panes rig fail-closes through restore's own 409 — no clobber, no new path). */
function buildAdoptDeps(deps: ReturnType<typeof getDeps>): AdoptRigDeps | undefined {
  const { rigRepo, sessionRegistry, tmuxAdapter, claimService, restoreOrchestrator, runtimeAdapters } = deps;
  if (!sessionRegistry || !tmuxAdapter || !claimService) return undefined;
  return {
    // The same classification restore's 409 guard runs: DB-running sessions × tmux
    // reality. A tmux error is NOT live (fail-closed both ways: an unprobeable pane
    // never adopts here, and restore's own unknown-blocks guard still refuses).
    probeLiveSessions: async (rigId) => {
      const rig = rigRepo.getRig(rigId);
      if (!rig) return [];
      const logicalByNodeId = new Map(rig.nodes.map((n) => [n.id, n.logicalId]));
      const live: Array<{ sessionName: string; logicalId: string }> = [];
      for (const session of sessionRegistry.getSessionsForRig(rigId)) {
        if (session.status !== "running") continue;
        const logicalId = logicalByNodeId.get(session.nodeId);
        if (!logicalId) continue;
        try {
          if (await tmuxAdapter.hasSession(session.sessionName)) {
            live.push({ sessionName: session.sessionName, logicalId });
          }
        } catch { /* fail-closed: unprobeable ≠ live */ }
      }
      return live;
    },
    reconcileSession: (sessionName) => claimService.reconcileSession({ sessionName }),
    listRigSeats: (rigId) => rigRepo.getRig(rigId)?.nodes.map((n) => n.logicalId) ?? [],
    launchNodeSubset: (rigId, logicalIds) =>
      restoreOrchestrator.launchNodeSubset(rigId, logicalIds, {
        adapters: runtimeAdapters ?? {},
        fsOps: { exists: (p: string) => existsSync(p) },
      }),
  };
}

function recompute(attempt: FleetAttempt): void {
  attempt.rollup = aggregateFleetRollup(attempt.sequence);
}

// POST /api/crash-cart/restore-fleet — start the fleet restore, answer ON-COMMIT.
crashCartRoutes.post("/restore-fleet", (c) => {
  const deps = getDeps(c);
  const { rigRepo, snapshotRepo, restoreOrchestrator, runtimeAdapters } = deps;
  const fleetAttemptId = `fleet-${randomUUID()}`;
  const attempt: FleetAttempt = {
    sequence: [],
    rollup: aggregateFleetRollup([]),
    done: false,
    cancelled: false,
  };
  fleetAttempts.set(fleetAttemptId, attempt);

  const conductor = new RestoreConductor({
    listRigsInOrder: () => listRigsInKernelFirstOrder({ listRigs: () => rigRepo.listRigs() }),
    restoreRig: createDefaultRestoreRig(
      {
        findLatestRestoreUsable: (rigId) => snapshotRepo.findLatestRestoreUsable(rigId),
        ...(typeof snapshotRepo.selectRestoreUsable === "function"
          ? { selectRestoreUsable: (rigId: string) => snapshotRepo.selectRestoreUsable(rigId) }
          : {}),
        // H1 — thread the app's adapters + fsOps into the shipped restore.
        restore: (snapshotId, opts) =>
          restoreOrchestrator.restore(snapshotId, {
            ...opts,
            adapters: runtimeAdapters ?? {},
            fsOps: { exists: (p: string) => existsSync(p) },
          }),
      },
      // AMENDMENT 2 — LIVE panes adopt via the shipped machinery; DEAD panes unchanged.
      buildAdoptDeps(deps),
    ),
    // H3 — the running attempt's cancel flag, polled stop-before-next-rig.
    isCancelled: () => attempt.cancelled,
  });

  // Run the fleet restore in the BACKGROUND — the response has already been sent.
  // Each rig updates the pollable rollup (the progress stream) as it completes.
  void conductor
    .restoreFleet({
      onRigDone: (r) => {
        attempt.sequence.push(r);
        recompute(attempt);
      },
    })
    .then(() => {
      attempt.done = true;
    })
    .catch(() => {
      // Best-effort: the fleet loop itself is guarded per rig; mark done so the
      // client stops polling. Per-rig failures are already in the rollup.
      attempt.done = true;
    });

  // Answer ON-COMMIT (immediately) — never block to fleet completion (r1 root).
  return c.json({ fleetAttemptId, status: "started" }, 202);
});

// GET /api/crash-cart/restore-fleet/:fleetAttemptId — poll progress + the rollup/triage.
crashCartRoutes.get("/restore-fleet/:fleetAttemptId", (c) => {
  const attempt = fleetAttempts.get(c.req.param("fleetAttemptId"));
  if (!attempt) return c.json({ error: "unknown fleet restore attempt" }, 404);
  // Verdict DERIVED at read from the current counts (R6 / ARCH-RULING Q2) — never a stored field.
  return c.json({
    done: attempt.done,
    cancelled: attempt.cancelled,
    rollup: attempt.rollup,
    verdict: deriveFleetVerdict(attempt.rollup.counts),
  });
});

// POST /api/crash-cart/restore-fleet/:fleetAttemptId/cancel — stop-before-next-rig.
crashCartRoutes.post("/restore-fleet/:fleetAttemptId/cancel", (c) => {
  const attempt = fleetAttempts.get(c.req.param("fleetAttemptId"));
  if (!attempt) return c.json({ error: "unknown fleet restore attempt" }, 404);
  attempt.cancelled = true;
  return c.json({ ok: true, cancelled: true });
});
