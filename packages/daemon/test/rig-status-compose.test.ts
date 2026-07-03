import { describe, it, expect } from "vitest";
import { composeRigStatus, type SeatLifecycleInput } from "../src/domain/rig-status-compose.js";
import type { RestorePlanPreview, RestorePlanPreviewNode } from "../src/domain/restore-plan-preview.js";
import type { RecoveryPlan } from "../src/domain/restore-check-service.js";

function planNode(over: Partial<RestorePlanPreviewNode> & { logicalId: string }): RestorePlanPreviewNode {
  return {
    intendedAction: "resume-original",
    tokenState: "present",
    freshRequired: false,
    ...over,
  };
}

function plan(nodes: RestorePlanPreviewNode[]): RestorePlanPreview {
  return {
    status: "plan",
    mode: "restore",
    rigId: "rig1",
    rigName: "r1",
    snapshot: null,
    wouldCaptureCurrentState: true,
    nodes,
    mutated: false,
  };
}

function seat(logicalId: string, lifecycleState: SeatLifecycleInput["lifecycleState"], runtime = "claude-code"): SeatLifecycleInput {
  return { logicalId, runtime, lifecycleState };
}

describe("composeRigStatus — pure fold of per-seat truths (the LOCK)", () => {
  it("THE MONEY CASE: 2 resumable + 3 blocked seats → aggregate blocked; resumable seats STAY resume-original; input plan NOT mutated", () => {
    const inputPlan = plan([
      planNode({ logicalId: "a", intendedAction: "resume-original", tokenState: "present" }),
      planNode({ logicalId: "b", intendedAction: "resume-original", tokenState: "present" }),
      planNode({ logicalId: "c", intendedAction: "awaiting-decision", tokenState: "missing", freshRequired: true }),
      planNode({ logicalId: "d", intendedAction: "awaiting-decision", tokenState: "missing", freshRequired: true }),
      planNode({ logicalId: "e", intendedAction: "awaiting-decision", tokenState: "missing", freshRequired: true }),
    ]);
    const snapshotBefore = JSON.stringify(inputPlan.nodes);

    const out = composeRigStatus({
      rigId: "rig1",
      rigName: "r1",
      nodes: [
        seat("a", "recoverable"),
        seat("b", "recoverable"),
        seat("c", "recoverable"),
        seat("d", "recoverable"),
        seat("e", "recoverable"),
      ],
      plan: inputPlan,
    });

    // Aggregate is blocked BECAUSE seats are blocked.
    expect(out.status).toBe("blocked");
    // The 2 resumable seats stay resume-original in the per-seat table (no global-fresh flip).
    const a = out.perSeat.find((s) => s.logicalId === "a")!;
    const b = out.perSeat.find((s) => s.logicalId === "b")!;
    expect(a.intendedAction).toBe("resume-original");
    expect(b.intendedAction).toBe("resume-original");
    expect(a.blocked).toBe(false);
    expect(b.blocked).toBe(false);
    // The 3 blocked seats surface as awaiting-decision blockers.
    expect(out.perSeat.filter((s) => s.blocked)).toHaveLength(3);
    // Blocked rig is NOT recoverable without operator action.
    expect(out.recoverable).toBe(false);
    // No code path sets any seat to fresh.
    expect(out.perSeat.some((s) => s.intendedAction === "fresh-primed")).toBe(false);
    // The input plan was not mutated.
    expect(JSON.stringify(inputPlan.nodes)).toBe(snapshotBefore);
  });

  it("all seats running → up (composed, with a src provenance line)", () => {
    const out = composeRigStatus({
      rigId: "rig1",
      rigName: "r1",
      nodes: [seat("a", "running"), seat("b", "running")],
      plan: plan([planNode({ logicalId: "a" }), planNode({ logicalId: "b" })]),
    });
    expect(out.status).toBe("up");
    expect(out.seatsRunning).toBe(2);
    expect(out.seatsTotal).toBe(2);
    // Composed, not inferred — src names the folded signals + values.
    expect(out.src.some((s) => s.startsWith("ps: 2/2 running"))).toBe(true);
    expect(out.src.some((s) => s.startsWith("restore-plan:"))).toBe(true);
  });

  it("mixed running + stopped → partial (recoverable)", () => {
    const out = composeRigStatus({
      rigId: "rig1",
      rigName: "r1",
      nodes: [seat("a", "running"), seat("b", "detached")],
      plan: plan([planNode({ logicalId: "a" }), planNode({ logicalId: "b" })]),
    });
    expect(out.status).toBe("partial");
    expect(out.recoverable).toBe(true);
  });

  it("none running, all recoverable → down (recoverable)", () => {
    const out = composeRigStatus({
      rigId: "rig1",
      rigName: "r1",
      nodes: [seat("a", "recoverable"), seat("b", "recoverable")],
      plan: plan([planNode({ logicalId: "a" }), planNode({ logicalId: "b" })]),
    });
    expect(out.status).toBe("down");
    expect(out.recoverable).toBe(true);
  });

  it("restore-original honest: a seat with recorded source + missing token → awaiting-decision (blocked), others independently resume-original", () => {
    const out = composeRigStatus({
      rigId: "rig1",
      rigName: "r1",
      nodes: [seat("a", "recoverable"), seat("b", "recoverable")],
      plan: plan([
        planNode({ logicalId: "a", intendedAction: "resume-original", tokenState: "present" }),
        planNode({ logicalId: "b", intendedAction: "awaiting-decision", tokenState: "missing", freshRequired: true }),
      ]),
    });
    expect(out.status).toBe("blocked");
    expect(out.perSeat.find((s) => s.logicalId === "a")!.intendedAction).toBe("resume-original");
    expect(out.perSeat.find((s) => s.logicalId === "b")!.intendedAction).toBe("awaiting-decision");
  });

  it("stale-but-present token is DISTINCT from missing (FR-6) and is not itself a blocker", () => {
    const out = composeRigStatus({
      rigId: "rig1",
      rigName: "r1",
      nodes: [seat("a", "recoverable")],
      plan: plan([planNode({ logicalId: "a", intendedAction: "resume-original", tokenState: "stale" })]),
    });
    const a = out.perSeat[0]!;
    expect(a.tokenState).toBe("stale");
    expect(a.tokenState).not.toBe("missing");
    expect(a.blocked).toBe(false); // stale is visible, not a blocker
    expect(out.status).toBe("down");
  });

  it("restore-check blocked verdict folds up to aggregate blocked even when the plan alone is clean", () => {
    const recovery: RecoveryPlan = {
      status: "blocked",
      summary: "restore-input blockers remain",
      actions: [],
      blocked: [{ scope: "rig", rigId: "rig1", rigName: "r1", reason: "missing canonical identity" }],
      unknown: [],
    };
    const out = composeRigStatus({
      rigId: "rig1",
      rigName: "r1",
      nodes: [seat("a", "recoverable")],
      plan: plan([planNode({ logicalId: "a", intendedAction: "resume-original", tokenState: "present" })]),
      recovery,
    });
    // The plan seat is clean, but restore-check says blocked → the verdict is consumed, not defaulted to green.
    expect(out.status).toBe("blocked");
    expect(out.src.some((s) => s === "restore-check: blocked")).toBe(true);
  });

  it("restore-check unknown → aggregate unknown (probe uncertainty), when no seat is blocked", () => {
    const recovery: RecoveryPlan = {
      status: "unknown",
      summary: "could not inspect",
      actions: [],
      blocked: [],
      unknown: [{ scope: "host", reason: "probe error" }],
    };
    const out = composeRigStatus({
      rigId: "rig1",
      rigName: "r1",
      nodes: [seat("a", "recoverable")],
      plan: plan([planNode({ logicalId: "a", intendedAction: "resume-original", tokenState: "present" })]),
      recovery,
    });
    expect(out.status).toBe("unknown");
  });

  it("kernel rig folds kernel-status (NOT /healthz): auth_blocked → blocked; ready → up; degraded → partial", () => {
    const nodes = [seat("k", "running", "claude-code")];
    const p = plan([planNode({ logicalId: "k" })]);

    const blocked = composeRigStatus({ rigId: "rig1", rigName: "kernel", isKernel: true, nodes, plan: p, kernelState: "auth_blocked" });
    expect(blocked.status).toBe("blocked");
    expect(blocked.src.some((s) => s === "kernel-status.kernel_state=auth_blocked")).toBe(true);

    const up = composeRigStatus({ rigId: "rig1", rigName: "kernel", isKernel: true, nodes, plan: p, kernelState: "ready" });
    expect(up.status).toBe("up");

    const degraded = composeRigStatus({ rigId: "rig1", rigName: "kernel", isKernel: true, nodes, plan: p, kernelState: "degraded" });
    expect(degraded.status).toBe("partial");
  });
});
