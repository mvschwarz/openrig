// OPR.0.4.6.WF5 FR-1: taxonomy tests — deterministic classification over
// recorded state, the per-class negatives, the handler-role split, and the
// occurrence-identity semantics (the single-home JSDoc contract).

import { describe, expect, it } from "vitest";

import {
  WORKFLOW_EXCEPTION_CLASSES,
  classifyDeadlineVerdict,
  classifyFailedInstance,
  classifyGateTrip,
  occurrenceDedupKey,
  workflowExceptionTags,
  type FailedInstanceView,
  type GateTripView,
} from "../src/domain/workflow-exception.js";
import type { WorkflowDeadlineVerdict } from "../src/domain/workflow-deadline.js";

const failedView = (over: Partial<FailedInstanceView["instance"]> = {}): FailedInstanceView => ({
  instance: {
    instanceId: "01WFI",
    workflowName: "wf5-pipeline",
    status: "failed",
    currentStepId: null,
    lastContinuationDecision: { exit: "failed", resultNote: "boom" },
    ...over,
  },
  failedStepId: "review",
  failedPacketId: "qitem-000-failpacket",
  failureReason: "boom",
});

const overdueVerdict: WorkflowDeadlineVerdict = {
  state: "overdue-unclaimed",
  evidence: {
    instanceId: "01WFI",
    stepId: "review",
    packetId: "qitem-000-stuckpacket",
    ownerSession: "crew-reviewer@wf5-proof",
    packetState: "pending",
    anchor: "created_at",
    anchorAt: "2026-07-07T00:00:00.000Z",
    overdueBySeconds: 3600,
    ageSeconds: 18000,
    claimedAt: null,
  },
};

const gateTrip = (over: Partial<GateTripView> = {}): GateTripView => ({
  workflowName: "wf5-pipeline",
  instanceId: "01WFI",
  gatedStepId: "signoff",
  gateKind: "human",
  gatePacketId: "qitem-000-gatepacket",
  parkOn: "human@kernel",
  ...over,
});

describe("WF-5 FR-1 taxonomy", () => {
  it("the class set is closed at exactly three", () => {
    expect(WORKFLOW_EXCEPTION_CLASSES).toEqual([
      "unmapped_failed",
      "stuck_overdue",
      "human_gate_trip",
    ]);
  });

  it("class (a): failed instance classifies unmapped_failed, deterministic over N replays", () => {
    const results = Array.from({ length: 5 }, () => classifyFailedInstance(failedView()));
    for (const r of results) {
      expect(r?.identity.exceptionClass).toBe("unmapped_failed");
      expect(r?.identity.occurrenceKey).toBe("qitem-000-failpacket");
      expect(r?.identity.stepId).toBe("review");
      expect(r?.reason).toContain("no remediation branch");
      expect(r?.reason).toContain("boom");
    }
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
  });

  it("class (a) negative: a non-failed instance NEVER classifies (mapped-failed stays active = deterministic remediation, not an exception)", () => {
    for (const status of ["active", "waiting", "completed"] as const) {
      expect(classifyFailedInstance(failedView({ status }))).toBeNull();
    }
  });

  it("class (b): a non-healthy evaluator verdict lifts verbatim — evidence carried, never recomputed", () => {
    const r = classifyDeadlineVerdict("wf5-pipeline", overdueVerdict);
    expect(r?.identity.exceptionClass).toBe("stuck_overdue");
    expect(r?.identity.occurrenceKey).toBe("qitem-000-stuckpacket");
    expect(r?.deadlineEvidence).toBe(overdueVerdict.evidence);
    expect(r?.reason).toContain("overdue-unclaimed");
    expect(r?.reason).toContain("created_at");
  });

  it("class (b) negative: healthy verdict → null (in-deadline steps are not exceptions)", () => {
    expect(
      classifyDeadlineVerdict("wf5-pipeline", { state: "healthy", evidence: null }),
    ).toBeNull();
  });

  it("class (c): a HUMAN gate reach classifies human_gate_trip keyed by the compiled gate packet", () => {
    const r = classifyGateTrip(gateTrip());
    expect(r?.identity.exceptionClass).toBe("human_gate_trip");
    expect(r?.identity.occurrenceKey).toBe("qitem-000-gatepacket");
    expect(r?.reason).toContain("human@kernel");
  });

  it("THE HANDLER-ROLE SPLIT: a handler-role gate is NOT an exception", () => {
    expect(classifyGateTrip(gateTrip({ gateKind: "handler-role", parkOn: null }))).toBeNull();
  });

  it("occurrence semantics: same episode = same key; a fresh packet after resume = a NEW occurrence", () => {
    const first = classifyFailedInstance(failedView());
    const reDetected = classifyFailedInstance(failedView());
    expect(occurrenceDedupKey(first!.identity)).toBe(occurrenceDedupKey(reDetected!.identity));
    const afterResume = classifyFailedInstance({
      ...failedView(),
      failedPacketId: "qitem-001-secondfail",
    });
    expect(occurrenceDedupKey(afterResume!.identity)).not.toBe(
      occurrenceDedupKey(first!.identity),
    );
  });

  it("identity tags extend the shipped stamp and carry every join dimension", () => {
    const r = classifyFailedInstance(failedView());
    expect(workflowExceptionTags(r!.identity)).toEqual([
      "workflow-exception",
      "workflow:wf5-pipeline",
      "instance:01WFI",
      "step:review",
      "exception:unmapped_failed",
      "occurrence:qitem-000-failpacket",
    ]);
  });

  it("identity tags omit step: cleanly when the step binding is null (pre-R2 rows)", () => {
    const r = classifyFailedInstance({ ...failedView(), failedStepId: null });
    const tags = workflowExceptionTags(r!.identity);
    expect(tags).not.toContainEqual(expect.stringMatching(/^step:/));
    expect(tags).toContain("exception:unmapped_failed");
  });
});
