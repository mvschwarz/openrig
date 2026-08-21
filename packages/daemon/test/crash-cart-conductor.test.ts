// B1 Atom B — the crash-cart RESTORE CONDUCTOR core. RED-first pins for the
// three plan behaviors: kernel-first order (R2), best-effort continue (R5),
// stop-before-next-rig cancel (R8). The per-rig restore is injected so this unit
// observes ORDER / FAILURE / CANCEL without the full restore machinery (the real
// dep wraps findLatestRestoreUsable + RestoreOrchestrator.restore; verified by the
// integration + door test).
import { describe, it, expect } from "vitest";
import { RestoreConductor, createDefaultRestoreRig, listRigsInKernelFirstOrder, type PerRigOutcome } from "../src/domain/crash-cart-conductor.js";

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

describe("createDefaultRestoreRig — composes findLatestRestoreUsable + restore (R3/R4)", () => {
  it("R3: no usable snapshot → not_attempted, and restore is NEVER called (no silent substitute)", async () => {
    let restoreCalled = false;
    const restoreRig = createDefaultRestoreRig({
      findLatestRestoreUsable: () => null,
      restore: async () => {
        restoreCalled = true;
        return { ok: true, result: { rigResult: "fully_restored" } };
      },
    });
    const r = await restoreRig("alpha");
    expect(r.outcome).toBe("not_attempted");
    expect(restoreCalled).toBe(false);
  });

  it("usable snapshot → restore(snapshot.id) and returns its rigResult + the attemptId receiptRef", async () => {
    let usedSnapshotId: string | undefined;
    const restoreRig = createDefaultRestoreRig({
      findLatestRestoreUsable: () => ({ id: "snap-7" }),
      restore: async (snapshotId, opts) => {
        usedSnapshotId = snapshotId;
        opts?.onAttemptStarted?.(99); // the restore-started event seq
        return { ok: true, result: { rigResult: "partially_restored" } };
      },
    });
    const r = await restoreRig("alpha");
    expect(usedSnapshotId).toBe("snap-7");
    expect(r.outcome).toBe("partially_restored");
    expect(r.receiptRef).toBe(99);
  });

  it("restore ok:false (no result) → failed", async () => {
    const restoreRig = createDefaultRestoreRig({
      findLatestRestoreUsable: () => ({ id: "snap-1" }),
      restore: async () => ({ ok: false }),
    });
    const r = await restoreRig("alpha");
    expect(r.outcome).toBe("failed");
  });
});

describe("listRigsInKernelFirstOrder (R2 — kernel supervisor first)", () => {
  it("puts the kernel rig first, then the rest in listRigs order", () => {
    const ordered = listRigsInKernelFirstOrder({
      listRigs: () => [
        { id: "r-alpha", name: "alpha" },
        { id: "r-kernel", name: "kernel" },
        { id: "r-beta", name: "beta" },
      ],
    });
    expect(ordered.map((r) => r.rigId)).toEqual(["r-kernel", "r-alpha", "r-beta"]);
    expect(ordered[0]!.isKernel).toBe(true);
    expect(ordered.slice(1).every((r) => !r.isKernel)).toBe(true);
  });

  it("no kernel rig → all rigs, none flagged kernel (honest, not fabricated)", () => {
    const ordered = listRigsInKernelFirstOrder({ listRigs: () => [{ id: "r-a", name: "a" }] });
    expect(ordered).toEqual([{ rigId: "r-a", isKernel: false }]);
  });
});
