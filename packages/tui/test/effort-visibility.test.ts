import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../src/demo-data.js";
import { renderScreen } from "../src/render.js";
import { createViewState } from "../src/state.js";
import type { FleetSnapshot } from "../src/types.js";

function rigView(snap: FleetSnapshot) {
  const view = createViewState({ instanceId: "effort", getSnapshot: () => snap });
  view.dispatch({ type: "drill", resource: "rig", name: "openrig-build" });
  return view;
}

function agentDetail(snap: FleetSnapshot, name: string) {
  const view = createViewState({ instanceId: "effort-detail", getSnapshot: () => snap });
  view.dispatch({
    type: "drill",
    resource: "agent",
    name,
    target: { host: "vm-host", rig: "openrig-build", pod: "dev50" },
  });
  return renderScreen(view.get(), snap, { cols: 140, rows: 34 }).lines.join("\n");
}

describe("#1347: per-seat effort with configured/observed provenance", () => {
  it("shows the configured effort in its own column and a dash when none is configured", () => {
    const snap = demoSnapshot();
    const agents = snap.hosts[0]!.rigs[0]!.pods[0]!.agents;
    agents[0]!.effort = "high";
    agents[0]!.effortSource = "seat_choice";
    agents[1]!.effort = null;
    agents[1]!.effortSource = "runtime_default";

    const screen = renderScreen(rigView(snap).get(), snap, { cols: 140, rows: 34 });
    const header = screen.lines.find((line) => line.includes("EFF") && line.includes("MODEL"))!;
    const driver = screen.lines.find((line) => line.includes("┃ dev50") && line.includes("driver"))!;
    const guard = screen.lines.find((line) => line.includes("guard") && line.includes("gpt-5.6"))!;
    const at = header.indexOf("EFF");

    expect(at).toBeGreaterThan(0);
    expect(driver.slice(at, at + 4).trim()).toBe("high");
    expect(guard.slice(at, at + 4).trim()).toBe("—");
  });

  it("defers effort to drill at narrow widths and says so", () => {
    const snap = demoSnapshot();
    const body = renderScreen(rigView(snap).get(), snap, { cols: 84, rows: 28 }).lines.join("\n");
    const header = body.split("\n").find((line) => line.includes("SEAT") && line.includes("STATE"))!;

    expect(header).not.toContain("EFFORT");
    expect(body).toContain("MODEL/EFFORT/NOW/ACTIONS on drill");
  });

  it("renders configured and observed provenance on agent detail", () => {
    const snap = demoSnapshot();
    const driver = snap.hosts[0]!.rigs[0]!.pods[0]!.agents[0]!;
    driver.effort = "high";
    driver.effortSource = "seat_choice";
    snap.seatEffort = {
      seatRef: "dev50.driver@openrig-build",
      report: {
        ok: true,
        emitted: { state: "observed", value: "high", pid: 123 },
        observed: { state: "observed", value: "medium", source: "Codex rollout (latest turn_context)", outcome: "accepted" },
      },
    };

    const out = agentDetail(snap, "dev50.driver");
    expect(out).toMatch(/effort:\s+high \(this seat's choice\) · observed medium \(accepted\)/);
  });

  it("states the runtime default and a not-verified observation instead of guessing", () => {
    const snap = demoSnapshot();
    const driver = snap.hosts[0]!.rigs[0]!.pods[0]!.agents[0]!;
    driver.effort = null;
    driver.effortSource = "runtime_default";
    snap.seatEffort = {
      seatRef: "dev50.driver@openrig-build",
      report: {
        ok: true,
        emitted: { state: "unknown", detail: "The seat has no running session, so no launch to read." },
        observed: { state: "not_verified", detail: "The seat has no running session." },
      },
    };

    const out = agentDetail(snap, "dev50.driver");
    expect(out).toMatch(/effort:\s+— \(runtime default; no configured level\)/);
    expect(out).toContain("observed not verified · The seat has no running");
    expect(out).toContain("session.");
  });
});
