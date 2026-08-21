// B1 Atom B — the crash-cart RESTORE CONDUCTOR core. RED-first pins for the
// three plan behaviors: kernel-first order (R2), best-effort continue (R5),
// stop-before-next-rig cancel (R8). The per-rig restore is injected so this unit
// observes ORDER / FAILURE / CANCEL without the full restore machinery (the real
// dep wraps findLatestRestoreUsable + RestoreOrchestrator.restore; verified by the
// integration + door test).
import { describe, it, expect } from "vitest";
import {
  RestoreConductor,
  createDefaultRestoreRig,
  listRigsInKernelFirstOrder,
  aggregateFleetRollup,
  deriveFleetVerdict,
  attentionRowsFromNodes,
  type PerRigOutcome,
  type ConductorRigResult,
} from "../src/domain/crash-cart-conductor.js";

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
    const alpha = results.find((r) => r.rigId === "alpha")!;
    expect(alpha.outcome).toBe("not_attempted");
    // R3: the cancel-skipped rig carries WHY + the fix (never a blank not_attempted)
    expect(alpha.reason).toMatch(/cancel/i);
    expect(alpha.remediation).toMatch(/re-run/i);
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

  it("r1-root: emits onRigDone per rig AS IT COMPLETES (the progress stream), in order", async () => {
    const streamed: Array<{ rigId: string; outcome: PerRigOutcome }> = [];
    const c = new RestoreConductor({
      listRigsInOrder: rigsInOrder,
      restoreRig: async (rigId) => ({ outcome: (rigId === "alpha" ? "failed" : "fully_restored") as PerRigOutcome }),
    });
    const results = await c.restoreFleet({ onRigDone: (r) => streamed.push({ rigId: r.rigId, outcome: r.outcome }) });
    // every rig streamed as it finished, in kernel-first order, matching the final sequence
    expect(streamed.map((r) => r.rigId)).toEqual(["kernel", "alpha", "beta"]);
    expect(streamed).toEqual(results.map((r) => ({ rigId: r.rigId, outcome: r.outcome })));
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

  it("R3: no usable snapshot → not_attempted CARRIES a reason + remediation (no blank gap)", async () => {
    const restoreRig = createDefaultRestoreRig({
      findLatestRestoreUsable: () => null,
      restore: async () => ({ ok: true, result: { rigResult: "fully_restored" } }),
    });
    const r = await restoreRig("alpha");
    expect(r.outcome).toBe("not_attempted");
    expect(r.reason).toMatch(/no restore-usable snapshot/i);
    expect(r.remediation).toMatch(/snapshot/i);
  });

  it("restore ok:false (no result) → failed", async () => {
    const restoreRig = createDefaultRestoreRig({
      findLatestRestoreUsable: () => ({ id: "snap-1" }),
      restore: async () => ({ ok: false }),
    });
    const r = await restoreRig("alpha");
    expect(r.outcome).toBe("failed");
  });

  it("surfaces per-rig attention (triage rows) from the restore result's nodes", async () => {
    const restoreRig = createDefaultRestoreRig({
      findLatestRestoreUsable: () => ({ id: "snap-x" }),
      restore: async () => ({
        ok: true,
        result: {
          rigResult: "partially_restored",
          nodes: [
            { logicalId: "dev.guard", status: "attention_required", attentionEvidence: "pick a conversation" },
            { logicalId: "dev.driver", status: "resumed" },
          ],
        },
      }),
    });
    const r = await restoreRig("myrig");
    expect(r.attention).toEqual([
      { rigId: "myrig", seat: "dev.guard", need: "live runtime prompt — pick a conversation" },
    ]);
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

describe("aggregateFleetRollup + deriveFleetVerdict (R6 / ARCH-RULING Q2 — pure aggregation)", () => {
  const seq: ConductorRigResult[] = [
    { rigId: "kernel", outcome: "fully_restored", receiptRef: 1 },
    { rigId: "alpha", outcome: "failed" },
    { rigId: "beta", outcome: "not_attempted" },
    { rigId: "gamma", outcome: "partially_restored", receiptRef: 4 },
  ];

  it("counts by the CLOSED union; not_attempted is first-class (never folded into failed)", () => {
    const rollup = aggregateFleetRollup(seq);
    expect(rollup.counts).toEqual({ fully_restored: 1, partially_restored: 1, failed: 1, not_attempted: 1 });
  });

  it("sequence is a view carrying receiptRef; NO verdict field is stored on the rollup", () => {
    const rollup = aggregateFleetRollup(seq);
    expect(rollup.sequence).toBe(seq);
    expect(rollup.sequence.find((r) => r.rigId === "kernel")!.receiptRef).toBe(1);
    expect((rollup as Record<string, unknown>)["verdict"]).toBeUndefined(); // verdict is derived, not stored
  });

  it("attention_required is the UNION of per-rig triage rows carried in the sequence", () => {
    const seqWithAttention: ConductorRigResult[] = [
      { rigId: "kernel", outcome: "fully_restored" },
      { rigId: "alpha", outcome: "failed", attention: [{ rigId: "alpha", seat: "dev.driver", need: "codex auth" }] },
      { rigId: "beta", outcome: "not_attempted" },
    ];
    expect(aggregateFleetRollup(seqWithAttention).attention_required).toEqual([
      { rigId: "alpha", seat: "dev.driver", need: "codex auth" },
    ]);
    expect(aggregateFleetRollup(seq).attention_required).toEqual([]); // no per-rig attention → empty
  });

  it("deriveFleetVerdict is f(counts): all→all_fully_restored, all-failed→all_failed, all-not_attempted→none_attempted, mix→mixed", () => {
    expect(deriveFleetVerdict({ fully_restored: 3, partially_restored: 0, failed: 0, not_attempted: 0 })).toBe("all_fully_restored");
    expect(deriveFleetVerdict({ fully_restored: 0, partially_restored: 0, failed: 2, not_attempted: 0 })).toBe("all_failed");
    expect(deriveFleetVerdict({ fully_restored: 0, partially_restored: 0, failed: 0, not_attempted: 2 })).toBe("none_attempted");
    expect(deriveFleetVerdict(aggregateFleetRollup(seq).counts)).toBe("mixed");
    expect(deriveFleetVerdict({ fully_restored: 0, partially_restored: 0, failed: 0, not_attempted: 0 })).toBe("none_attempted");
  });
});

describe("attentionRowsFromNodes (R5 — triage: seat + exact need)", () => {
  it("maps attention_required / awaiting-decision / failed nodes to triage rows; running nodes are excluded", () => {
    const rows = attentionRowsFromNodes("kernel", [
      { logicalId: "dev.driver", status: "resumed" }, // running — no triage
      { logicalId: "dev.guard", status: "attention_required", attentionEvidence: "select a conversation to resume" },
      { logicalId: "dev.qa", status: "awaiting-decision" },
      { logicalId: "orch.lead", status: "failed", error: "spawn ENOENT" },
    ]);
    expect(rows.map((r) => r.seat)).toEqual(["dev.guard", "dev.qa", "orch.lead"]);
    expect(rows.find((r) => r.seat === "dev.guard")!.need).toContain("select a conversation");
    expect(rows.find((r) => r.seat === "dev.qa")!.need).toContain("choose");
    expect(rows.find((r) => r.seat === "orch.lead")!.need).toContain("spawn ENOENT");
    expect(rows.every((r) => r.rigId === "kernel")).toBe(true);
  });

  it("no attention-needing nodes → empty (never fabricated)", () => {
    expect(attentionRowsFromNodes("r", [{ logicalId: "a", status: "resumed" }, { logicalId: "b", status: "fresh-primed" }])).toEqual([]);
  });
});
