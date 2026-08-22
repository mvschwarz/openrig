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

// ── AMENDMENT 2 (stamped, body hash 72757e81) — the surviving-panes ADOPT branch ──
// The round-10 door: daemon killed, panes ALIVE → restore() fail-closes 409 → the fleet
// read "failed" and the non-resumable seat never reached triage. The amendment sanctions
// ONE change: per rig, LIVE panes compose the SHIPPED reconcile/adopt + per-seat resume
// verification; DEAD panes take the existing restore path byte-unchanged. The union stays
// CLOSED (four members) and adoption touches session state only (R9).
describe("AMENDMENT 2 — per-rig LIVE/DEAD-panes branch in createDefaultRestoreRig", () => {
  // The shipped restore in its 409 shape: a live-panes rig fail-closes with NO result —
  // exactly what the conductor read as `failed` at round 10.
  const restore409 = async () => ({ ok: false as const });
  const restoreDeps = () => ({
    findLatestRestoreUsable: () => ({ id: "snap-1" }),
    restore: restore409,
  });

  it("THE DOOR (unit form): a live-panes rig that today 409s must ADOPT — restore is never called, outcome is not `failed`", async () => {
    let restoreCalled = false;
    const restoreRig = createDefaultRestoreRig(
      {
        findLatestRestoreUsable: () => ({ id: "snap-1" }),
        restore: async () => { restoreCalled = true; return { ok: false }; },
      },
      {
        probeLiveSessions: async () => [
          { sessionName: "dev-planner@r", logicalId: "dev.planner" },
          { sessionName: "dev-driver@r", logicalId: "dev.driver" },
        ],
        reconcileSession: async () => ({ ok: true }),
        listRigSeats: () => ["dev.planner", "dev.driver"],
        launchNodeSubset: async () => { throw new Error("no remaining seats — must not be called"); },
      },
    );
    const r = await restoreRig("rig-1");
    expect(restoreCalled).toBe(false); // adopt branch, never the 409
    expect(r.outcome).toBe("fully_restored"); // all seats re-attached
    expect(r.attention ?? []).toEqual([]);
  });

  it("some seats adopted + the engineered non-resumable seat lands on triage with its EXACT --fresh line → partially_restored", async () => {
    const subsetCalls: string[][] = [];
    const restoreRig = createDefaultRestoreRig(restoreDeps(), {
      probeLiveSessions: async () => [{ sessionName: "dev-planner@r", logicalId: "dev.planner" }],
      reconcileSession: async () => ({ ok: true }),
      listRigSeats: () => ["dev.planner", "dev.qa"],
      launchNodeSubset: async (_rigId, ids) => {
        subsetCalls.push(ids);
        return {
          ok: true,
          launched: [{
            logicalId: "dev.qa",
            status: "awaiting-decision",
            error: "Original session not resumable. Use --fresh dev.qa to fresh-prime, or skip.",
          }],
        };
      },
    });
    const r = await restoreRig("rig-1");
    expect(subsetCalls).toEqual([["dev.qa"]]); // only the not-adopted seat is verified
    expect(r.outcome).toBe("partially_restored");
    expect(r.attention).toEqual([
      { rigId: "rig-1", seat: "dev.qa", need: "Original session not resumable. Use --fresh dev.qa to fresh-prime, or skip." },
    ]);
  });

  it("mis-probe (probe LIVE, panes died before adopt): every adoption fails → not_attempted with reason+remediation; the subset launcher is NEVER reached", async () => {
    let subsetCalled = false;
    const restoreRig = createDefaultRestoreRig(restoreDeps(), {
      probeLiveSessions: async () => [{ sessionName: "dev-planner@r", logicalId: "dev.planner" }],
      reconcileSession: async () => ({ ok: false, code: "session_not_found", message: "No live tmux session" }),
      listRigSeats: () => ["dev.planner", "dev.qa"],
      launchNodeSubset: async () => { subsetCalled = true; return { ok: true, launched: [] }; },
    });
    const r = await restoreRig("rig-1");
    expect(r.outcome).toBe("not_attempted"); // adopt fails EMPTY (honest) — the stamped mis-probe analysis
    expect(subsetCalled).toBe(false);
    expect(r.reason).toBeTruthy();
    expect(r.remediation).toBeTruthy();
  });

  it("DEAD panes (probe empty): the existing restore composition runs UNCHANGED", async () => {
    let restored: string | null = null;
    const restoreRig = createDefaultRestoreRig(
      {
        findLatestRestoreUsable: () => ({ id: "snap-9" }),
        restore: async (snapshotId) => { restored = snapshotId; return { ok: true, result: { rigResult: "fully_restored" } }; },
      },
      {
        probeLiveSessions: async () => [],
        reconcileSession: async () => { throw new Error("must not adopt a dead rig"); },
        listRigSeats: () => [],
        launchNodeSubset: async () => { throw new Error("must not launch on the dead path"); },
      },
    );
    const r = await restoreRig("rig-1");
    expect(restored).toBe("snap-9");
    expect(r.outcome).toBe("fully_restored");
  });

  it("no adopt deps wired (today's callers): behavior is byte-identical to the existing composition", async () => {
    const restoreRig = createDefaultRestoreRig(restoreDeps());
    const r = await restoreRig("rig-1");
    expect(r.outcome).toBe("failed"); // the pre-amendment reading of a 409 — unchanged when no adopt deps exist
  });

  it("subset launcher refusal (e.g. no usable snapshot) + failed targets fold LOUD: rows for every unverified seat, outcome partially_restored", async () => {
    const restoreRig = createDefaultRestoreRig(restoreDeps(), {
      probeLiveSessions: async () => [{ sessionName: "dev-planner@r", logicalId: "dev.planner" }],
      reconcileSession: async () => ({ ok: true }),
      listRigSeats: () => ["dev.planner", "dev.qa", "dev.guard"],
      launchNodeSubset: async () => ({ ok: false, code: "no_usable_snapshot", message: "No usable snapshot for rig rig-1" }),
    });
    const r = await restoreRig("rig-1");
    expect(r.outcome).toBe("partially_restored"); // the adopted seat is real; the unverified ones are named
    const seats = (r.attention ?? []).map((a) => a.seat).sort();
    expect(seats).toEqual(["dev.guard", "dev.qa"]);
    for (const row of r.attention ?? []) expect(row.need).toContain("No usable snapshot");
  });

  it("held + failed subset targets become triage rows (never silent); outcome stays in the CLOSED union", async () => {
    const restoreRig = createDefaultRestoreRig(restoreDeps(), {
      probeLiveSessions: async () => [{ sessionName: "dev-planner@r", logicalId: "dev.planner" }],
      reconcileSession: async () => ({ ok: true }),
      listRigSeats: () => ["dev.planner", "dev.qa", "dev.guard"],
      launchNodeSubset: async () => ({
        ok: true,
        launched: [],
        held: [{ logicalId: "dev.qa", reason: "operator hold" }],
        failedTargets: [{ logicalId: "dev.guard", reason: "tmux probe failed (fail-closed)" }],
      }),
    });
    const r = await restoreRig("rig-1");
    expect(r.outcome).toBe("partially_restored");
    const bySeat = Object.fromEntries((r.attention ?? []).map((a) => [a.seat, a.need]));
    expect(bySeat["dev.qa"]).toContain("held");
    expect(bySeat["dev.guard"]).toContain("tmux probe failed");
    expect(["fully_restored", "partially_restored", "failed", "not_attempted"]).toContain(r.outcome);
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

  it("BLOCKER 3: awaiting-decision PRESERVES the exact node error/remediation (the --fresh command), not a generic sentence", () => {
    const exact = "session for dev.qa not resumable (resume_token expired); run: rig restore snap-7 --fresh dev.qa — or skip this seat";
    const rows = attentionRowsFromNodes("myrig", [{ logicalId: "dev.qa", status: "awaiting-decision", error: exact }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.need).toBe(exact); // the EXACT evidence reaches the operator (the door's acceptance sentence)
    expect(rows[0]!.need).toContain("--fresh dev.qa");
  });

  it("awaiting-decision with NO node error falls back to the generic sentence (never blank)", () => {
    const rows = attentionRowsFromNodes("r", [{ logicalId: "dev.x", status: "awaiting-decision" }]);
    expect(rows[0]!.need).toContain("choose fresh-prime or skip");
  });

  it("no attention-needing nodes → empty (never fabricated)", () => {
    expect(attentionRowsFromNodes("r", [{ logicalId: "a", status: "resumed" }, { logicalId: "b", status: "fresh-primed" }])).toEqual([]);
  });
});
