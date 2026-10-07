import { describe, expect, it } from "vitest";
import { workflowDetail } from "../src/execution/workflow-model.js";

// #860: a blocker change writes the epoch to the wake's last evaluation as a wake-now marker.
describe("a queued wake is not shown as a 1970 check", () => {
  const detail = (lastEvaluationAt: string | null) => workflowDetail({
    mission: "m", derived_at: "2026-10-07T12:00:00Z",
    lifecycle_instances: [{ instance_id: "run", status: "running", frontier_packets: [{
      packet_id: "q", step_id: "work", wake_schedule: { policy: "periodic-reminder", interval_seconds: 600, last_evaluation_at: lastEvaluationAt },
    }] }],
  } as never, "packet:q", 100, "UTC")!.map((line) => line.text).join("\n");

  it("says a wake is pending for the epoch marker", () => {
    const text = detail("1970-01-01T00:00:00.000Z");
    expect(text).toMatch(/last check:\s+wake pending/);
    expect(text).not.toContain("1970");
  });

  it("still shows a real check time", () => {
    expect(detail("2026-10-07T11:50:00.000Z")).toMatch(/last check:\s+2026-10-07 11:50:00 UTC/);
  });
});
