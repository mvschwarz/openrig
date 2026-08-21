// B1 — the crash-cart RESTORE CONDUCTOR route (daemon-side batch verb). Plan-locked
// (B1-CRASH-CART-CONDUCTOR-PLAN-2026-08-21, content-hash 84401cd4). Thin glue: it
// assembles the tested conductor pieces (kernel-first order + the default per-rig
// restore composing the shipped RestoreOrchestrator) and returns the per-rig sequence.
// Atom C aggregates the sequence into the fleet rollup; Atom D wires the TUI ⏎.
import { Hono } from "hono";
import type { RigRepository } from "../domain/rig-repository.js";
import type { SnapshotRepository } from "../domain/snapshot-repository.js";
import type { RestoreOrchestrator } from "../domain/restore-orchestrator.js";
import {
  RestoreConductor,
  createDefaultRestoreRig,
  listRigsInKernelFirstOrder,
  aggregateFleetRollup,
  deriveFleetVerdict,
} from "../domain/crash-cart-conductor.js";

export const crashCartRoutes = new Hono();

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    rigRepo: c.get("rigRepo" as never) as RigRepository,
    snapshotRepo: c.get("snapshotRepo" as never) as SnapshotRepository,
    restoreOrchestrator: c.get("restoreOrchestrator" as never) as RestoreOrchestrator,
  };
}

// POST /api/crash-cart/restore-fleet — restore every rig on this host, kernel-first,
// best-effort, returning the ordered per-rig sequence.
crashCartRoutes.post("/restore-fleet", async (c) => {
  const { rigRepo, snapshotRepo, restoreOrchestrator } = getDeps(c);
  const conductor = new RestoreConductor({
    listRigsInOrder: () => listRigsInKernelFirstOrder({ listRigs: () => rigRepo.listRigs() }),
    restoreRig: createDefaultRestoreRig({
      findLatestRestoreUsable: (rigId) => snapshotRepo.findLatestRestoreUsable(rigId),
      restore: (snapshotId, opts) => restoreOrchestrator.restore(snapshotId, opts),
    }),
  });
  const sequence = await conductor.restoreFleet();
  // Atom C — pure aggregation over the per-rig sequence. The verdict is DERIVED
  // f(counts), computed here and NEVER stored on the rollup. attention_required is
  // wired from the shipped per-rig restore-check attention projection (next increment).
  const rollup = aggregateFleetRollup(sequence);
  return c.json({ rollup, verdict: deriveFleetVerdict(rollup.counts) });
});
