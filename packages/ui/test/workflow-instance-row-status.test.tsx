// The instance row's status chip shows the daemon's recorded status. An
// aborted instance (rig workflow abort; daemon WorkflowInstanceStatus in
// domain/workflow-types.ts) must read ABORTED, not COMPLETED.

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { instanceAttentionRank, WorkflowInstanceRow } from "../src/components/workflow/WorkflowInstancesBand.js";
import type { WorkflowInstanceWithDeadline } from "../src/hooks/useWorkflow.js";

afterEach(() => cleanup());

const inst = (over: Partial<WorkflowInstanceWithDeadline>): WorkflowInstanceWithDeadline => ({
  instanceId: "01WFROW",
  workflowName: "wf",
  workflowVersion: "1",
  createdBySession: "lead@acme-rig",
  createdAt: "2026-07-07T00:00:00.000Z",
  status: "active",
  currentFrontier: [],
  currentStepId: null,
  hopCount: 3,
  fallbackSynthesis: null,
  lastContinuationDecision: null,
  completedAt: null,
  version: 1,
  resumeCount: 0,
  hopsBaseline: 0,
  deadline: { state: "healthy", evidence: null },
  ...over,
});

async function renderRow(instance: WorkflowInstanceWithDeadline) {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <ul>
        <WorkflowInstanceRow instance={instance} />
      </ul>
    ),
  });
  const instRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflow/instance/$instanceId",
    component: () => <div />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, instRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(<RouterProvider router={router as never} />);
  const row = await waitFor(() => view.getByTestId(`workflow-instance-row-${instance.instanceId}`));
  return row.textContent ?? "";
}

describe("WorkflowInstanceRow status chip", () => {
  it("an aborted instance reads ABORTED, not COMPLETED", async () => {
    const text = await renderRow(inst({ status: "aborted", completedAt: "2026-07-07T01:00:00.000Z" }));
    expect(text).toContain("ABORTED");
    expect(text).not.toContain("COMPLETED");
  });

  it("a completed instance still reads COMPLETED", async () => {
    const text = await renderRow(inst({ status: "completed", completedAt: "2026-07-07T01:00:00.000Z" }));
    expect(text).toContain("COMPLETED");
    expect(text).toContain("closed");
  });

  it("an aborted instance sorts with the finished, after live runs", () => {
    expect(instanceAttentionRank(inst({ status: "aborted" }))).toBe(instanceAttentionRank(inst({ status: "completed" })));
    expect(instanceAttentionRank(inst({ status: "aborted" }))).toBeGreaterThan(instanceAttentionRank(inst({ status: "active" })));
  });
});
