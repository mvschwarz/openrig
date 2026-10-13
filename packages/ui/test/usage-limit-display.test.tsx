import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { getActivityLabel, getActivityStateWithSource } from "../src/lib/activity-visuals.js";
import { SeatOverviewTable } from "../src/components/SeatOverviewTable.js";

const limit = {
  state: "unknown", reason: "usage_limit", rawEvent: "at_limit",
  evidenceSource: "runtime_hook", sampledAt: "2026-10-07T00:00:00.000Z",
  stale: false, fallback: false,
} as const;

afterEach(cleanup);

describe("current usage-limit display", () => {
  it.each([true, false, null])("keeps the limit visible with terminalActive=%s", (terminalActive) => {
    expect(getActivityStateWithSource(limit, terminalActive)).toEqual({ state: "unknown", source: "hook" });
    expect(getActivityLabel("unknown", limit)).toBe("usage limit");
  });

  it.each(["usage_limit", "stale_runtime_hook", "generation_mismatch"])("does not revive stale %s evidence", (reason) => {
    const activity = { ...limit, reason, stale: true };
    expect(getActivityStateWithSource(activity, true)).toEqual({ state: "running", source: "terminal_activity" });
    expect(getActivityLabel("unknown", activity)).toBe("unknown");
  });

  it("does not promote an untyped reason to a limit", () => {
    const activity = { ...limit, rawEvent: "other" };
    expect(getActivityStateWithSource(activity, true).state).toBe("running");
    expect(getActivityLabel("unknown", activity)).toBe("unknown");
  });

  it.each(["needs_input", "blocked"] as const)("preserves a newer %s visual over a cached limit", (state) => {
    render(<SeatOverviewTable data={{ agentActivity: limit, terminalActive: true } as never}
      activityVisual={{ state, recent: true } as never} />);
    const cell = screen.getByTestId("seat-overview-activity-state");
    expect(cell.getAttribute("data-activity-state")).toBe(state);
    expect(cell.textContent).not.toContain("usage limit");
  });

  it("shows the limit in seat details even with a recent activity visual", () => {
    render(<SeatOverviewTable data={{ agentActivity: limit, terminalActive: true } as never}
      activityVisual={{ state: "active", recent: true } as never} />);
    const cell = screen.getByTestId("seat-overview-activity-state");
    expect(cell.textContent).toContain("usage limit");
    expect(cell.getAttribute("data-activity-state")).toBe("unknown");
    expect(cell.className).not.toContain("active-shimmer");
  });
});
