// A `rig workflow resume` writes a `resumed` step-trail row (daemon
// WorkflowTrailReason in domain/workflow-types.ts). The routing-history
// timeline must show it with its own glyph, not the unknown-reason "?".

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { InstanceTrailTimeline } from "../src/components/workflow/InstanceTrailTimeline.js";
import type { WorkflowInstanceWithDeadline, WorkflowStepTrailEntry } from "../src/hooks/useWorkflow.js";

afterEach(() => cleanup());

const instance: WorkflowInstanceWithDeadline = {
  instanceId: "01WFTRAIL",
  workflowName: "wf",
  workflowVersion: "1",
  createdBySession: "lead@acme-rig",
  createdAt: "2026-07-07T00:00:00.000Z",
  status: "active",
  currentFrontier: ["Q3"],
  currentStepId: "build",
  hopCount: 1,
  fallbackSynthesis: null,
  lastContinuationDecision: null,
  completedAt: null,
  version: 1,
  resumeCount: 1,
  hopsBaseline: 0,
  deadline: { state: "healthy", evidence: null },
};

const resumed: WorkflowStepTrailEntry = {
  trailId: "T-RESUME",
  instanceId: "01WFTRAIL",
  stepId: "build",
  stepRole: "builder",
  closedAt: "2026-07-07T00:05:00.000Z",
  closureReason: "resumed",
  closureEvidence: { resume: { ownerSession: "builder-slot-2@acme-rig", ownerSource: "named" } },
  actorSession: "lead@acme-rig",
  nextQitemId: "Q3",
  priorQitemId: "Q2",
};

describe("InstanceTrailTimeline resumed row", () => {
  it("renders a resume row with the ↻ glyph", () => {
    const { getByTestId } = render(<InstanceTrailTimeline trail={[resumed]} instance={instance} />);
    const row = getByTestId("workflow-trail-row-T-RESUME");
    expect(row.textContent).toContain("↻ resumed");
    expect(row.textContent).not.toContain("? resumed");
  });

  it("does not count a resume row as a closed step after a failure then resume", () => {
    const failed: WorkflowStepTrailEntry = {
      ...resumed,
      trailId: "T-FAILED",
      closedAt: "2026-07-07T00:04:00.000Z",
      closureReason: "failed",
      closureEvidence: null,
      actorSession: "builder@acme-rig",
      nextQitemId: null,
    };
    const { container } = render(<InstanceTrailTimeline trail={[failed, resumed]} instance={instance} />);
    expect(container.textContent).toContain("1 closed step ·");
    expect(container.textContent).not.toContain("2 closed steps");
  });
});
