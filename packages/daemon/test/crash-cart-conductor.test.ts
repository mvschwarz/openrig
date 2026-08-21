// B1 Atom B — the crash-cart RESTORE CONDUCTOR core. RED-first pins for the
// three plan behaviors: kernel-first order (R2), best-effort continue (R5),
// stop-before-next-rig cancel (R8). The per-rig restore is injected so this unit
// observes ORDER / FAILURE / CANCEL without the full restore machinery (the real
// dep wraps findLatestRestoreUsable + RestoreOrchestrator.restore; verified by the
// integration + door test).
import { describe, it, expect } from "vitest";
import { RestoreConductor, type PerRigOutcome } from "../src/domain/crash-cart-conductor.js";

// kernel FIRST, then the rest — the founder's order the conductor must honor.
const rigsInOrder = () => [
  { rigId: "kernel", isKernel: true },
  { rigId: "alpha", isKernel: false },
  { rigId: "beta", isKernel: false },
];

describe("RestoreConductor — Atom B core", () => {
  it("R2: restores rigs kernel-first, in order", async () => {
    const seen: string[] = [];
    const c = new RestoreConductor({
      listRigsInOrder: rigsInOrder,
      restoreRig: async (rigId) => {
        seen.push(rigId);
        return { outcome: "fully_restored" as PerRigOutcome };
      },
    });
    const results = await c.restoreFleet();
    expect(seen).toEqual(["kernel", "alpha", "beta"]);
    expect(results.map((r) => r.rigId)).toEqual(["kernel", "alpha", "beta"]);
    expect(results.every((r) => r.outcome === "fully_restored")).toBe(true);
  });

  it("R5: best-effort — one rig's failure never halts the fleet; the failed rig is `failed`", async () => {
    const attempted: string[] = [];
    const c = new RestoreConductor({
      listRigsInOrder: rigsInOrder,
      restoreRig: async (rigId) => {
        attempted.push(rigId);
        if (rigId === "alpha") throw new Error("resume blew up");
        return { outcome: "fully_restored" as PerRigOutcome };
      },
    });
    const results = await c.restoreFleet();
    // beta is STILL attempted after alpha threw
    expect(attempted).toEqual(["kernel", "alpha", "beta"]);
    expect(results.find((r) => r.rigId === "alpha")!.outcome).toBe("failed");
    expect(results.find((r) => r.rigId === "beta")!.outcome).toBe("fully_restored");
  });

  it("R8: stop-before-next-rig cancel — the in-flight rig completes; later rigs are `not_attempted`", async () => {
    const attempted: string[] = [];
    let cancelled = false;
    const c = new RestoreConductor({
      listRigsInOrder: rigsInOrder,
      restoreRig: async (rigId) => {
        attempted.push(rigId);
        if (rigId === "kernel") cancelled = true; // operator cancels while kernel restores
        return { outcome: "fully_restored" as PerRigOutcome };
      },
      isCancelled: () => cancelled,
    });
    const results = await c.restoreFleet();
    // kernel (in-flight) completed; alpha/beta never started
    expect(attempted).toEqual(["kernel"]);
    expect(results.find((r) => r.rigId === "kernel")!.outcome).toBe("fully_restored");
    expect(results.find((r) => r.rigId === "alpha")!.outcome).toBe("not_attempted");
    expect(results.find((r) => r.rigId === "beta")!.outcome).toBe("not_attempted");
  });

  it("carries the receiptRef (ledger lineage) through per rig", async () => {
    const c = new RestoreConductor({
      listRigsInOrder: () => [{ rigId: "kernel", isKernel: true }],
      restoreRig: async () => ({ outcome: "fully_restored" as PerRigOutcome, receiptRef: 4242 }),
    });
    const results = await c.restoreFleet();
    expect(results[0]!.receiptRef).toBe(4242);
  });
});
