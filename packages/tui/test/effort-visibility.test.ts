import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../src/demo-data.js";
import { renderScreen } from "../src/render.js";
import { createViewState } from "../src/state.js";
import type { FleetSnapshot, SeatEffortRead } from "../src/types.js";

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
  // Wide enough that the one-row effort field does not wrap across the pane border.
  return renderScreen(view.get(), snap, { cols: 200, rows: 34 }).lines.join("\n");
}

function agents(snap: FleetSnapshot) {
  return snap.hosts[0]!.rigs[0]!.pods[0]!.agents;
}

function report(overrides: Partial<SeatEffortRead> = {}): SeatEffortRead {
  return {
    ok: true,
    requested: { value: "high", at: "2026-10-18T04:00:00.000Z", reason: "release", operator: "human@kernel" },
    saved: { effective: "high", source: "seat_choice", authored: "medium", choice: "high" },
    emitted: { state: "observed", value: "high", pid: 123, startedAt: "Sun Oct 18 04:00:00 2026", matchesSaved: true },
    observed: {
      state: "observed", value: "medium", source: "Codex rollout (latest turn_context)", outcome: "accepted",
      at: "2026-10-18T04:05:00.000Z", matchesEmitted: false,
    },
    ...overrides,
  };
}

describe("#1347: per-seat effort with configured/observed provenance", () => {
  it("labels the effort column as configured and marks each value's source at 160 columns", () => {
    const snap = demoSnapshot();
    const [driver, guard, qa] = agents(snap);
    driver!.effort = "high";
    driver!.effortSource = "seat_choice";
    guard!.effort = "medium";
    guard!.effortSource = "authored";
    qa!.effort = null;
    qa!.effortSource = "runtime_default";

    const screen = renderScreen(rigView(snap).get(), snap, { cols: 160, rows: 34 });
    const header = screen.lines.find((line) => line.includes("SEAT") && line.includes("STATE"))!;
    const at = header.indexOf("CFG EFF");

    expect(at).toBeGreaterThan(0);
    expect(header).toContain("MODEL");
    expect(screen.lines.find((line) => line.includes("┃ dev50") && line.includes("driver"))!.slice(at, at + 7).trim()).toBe("high*");
    expect(screen.lines.find((line) => line.includes("guard") && line.includes("gpt-5.6"))!.slice(at, at + 7).trim()).toBe("medium+");
    expect(screen.lines.find((line) => /\sqa\s/.test(line))!.slice(at, at + 7).trim()).toBe("—");
    expect(screen.lines.join("\n")).toContain("EFFORT (configured): * seat choice · + authored · — none · ? unknown; observed on drill");
  });

  it("keeps the compact CFG column inside 120 columns and shows unknown separately from none", () => {
    const snap = demoSnapshot();
    const [driver, guard, qa] = agents(snap);
    driver!.effort = "high";
    driver!.effortSource = "seat_choice";
    guard!.effort = "medium";
    guard!.effortSource = "authored";
    qa!.effort = null;
    qa!.effortSource = null;

    const screen = renderScreen(rigView(snap).get(), snap, { cols: 120, rows: 34 });
    const header = screen.lines.find((line) => line.includes("SEAT") && line.includes("STATE"))!;
    const at = header.indexOf("CFG");

    expect(at).toBeGreaterThan(0);
    expect(header).not.toContain("CFG EFF");
    expect(screen.lines.find((line) => line.includes("┃ dev50") && line.includes("driver"))!.slice(at, at + 4).trim()).toBe("hi*");
    expect(screen.lines.find((line) => line.includes("guard") && line.includes("gpt-5.6"))!.slice(at, at + 4).trim()).toBe("med+");
    expect(screen.lines.find((line) => /\sqa\s/.test(line))!.slice(at, at + 4).trim()).toBe("?");
  });

  it("defers effort to drill at 84 columns and says so", () => {
    const snap = demoSnapshot();
    const body = renderScreen(rigView(snap).get(), snap, { cols: 84, rows: 28 }).lines.join("\n");
    const header = body.split("\n").find((line) => line.includes("SEAT") && line.includes("STATE"))!;

    expect(header).not.toContain("CFG");
    expect(body).toContain("MODEL/EFFORT/NOW/ACTIONS on drill");
  });

  it("keeps requested, saved, emitted and observed distinct on agent detail", () => {
    const snap = demoSnapshot();
    const driver = agents(snap)[0]!;
    driver.effort = "high";
    driver.effortSource = "seat_choice";
    snap.seatEffort = { seatRef: "dev50.driver@openrig-build", report: report() };

    const out = agentDetail(snap, "dev50.driver");
    expect(out).toMatch(/effort:\s+requested\s+high/);
    expect(out).toMatch(/saved\s+high\s+\(seat choice;\s+authored medium\)/);
    expect(out).toMatch(/emitted\s+high/);
    expect(out).toMatch(/observed\s+medium\s+\(accepted\s+—\s+applied;\s+differs from launch\)/);
  });

  it("never calls a recorded native value applied", () => {
    const snap = demoSnapshot();
    const driver = agents(snap)[0]!;
    driver.effort = "high";
    driver.effortSource = "seat_choice";
    snap.seatEffort = {
      seatRef: "dev50.driver@openrig-build",
      report: report({
        emitted: { state: "observed", value: "high", pid: 123, matchesSaved: true },
        observed: { state: "observed", value: "high", outcome: "recorded" },
      }),
    };

    const out = agentDetail(snap, "dev50.driver");
    expect(out).toMatch(/recorded;\s+applied\s+not\s+proven/);
    expect(out).not.toContain("— applied");
  });

  it("shows each unknown and the runtime default without inventing an observed level", () => {
    const snap = demoSnapshot();
    const driver = agents(snap)[0]!;
    driver.effort = null;
    driver.effortSource = "runtime_default";
    snap.seatEffort = {
      seatRef: "dev50.driver@openrig-build",
      report: {
        ok: true,
        requested: null,
        saved: { effective: null, source: "runtime_default" },
        emitted: { state: "unknown", detail: "The seat has no running session, so no launch to read." },
        observed: { state: "not_verified", detail: "The seat has no running session." },
      },
    };

    const out = agentDetail(snap, "dev50.driver");
    expect(out).toMatch(/requested\s+never set/);
    expect(out).toMatch(/saved\s+none\s+\(runtime default\)/);
    expect(out).toMatch(/emitted\s+unknown/);
    expect(out).toMatch(/observed\s+unknown/);
    expect(out).not.toMatch(/observed\s+none/);
  });

  it("falls back to the node inventory when the report was not read, and marks the rest unknown", () => {
    const snap = demoSnapshot();
    const driver = agents(snap)[0]!;
    driver.effort = "high";
    driver.effortSource = "seat_choice";
    snap.seatEffort = { seatRef: "dev50.driver@openrig-build", report: null };

    const out = agentDetail(snap, "dev50.driver");
    expect(out).toMatch(/saved\s+high\s+\(seat choice;\s+node inventory\)/);
    expect(out).toMatch(/requested\s+unknown/);
    expect(out).toMatch(/emitted\s+unknown/);
    expect(out).toMatch(/observed\s+unknown/);
    expect(out).toContain("report not read");
  });

  it("reports an older daemon's missing inventory fields as unknown, not as a runtime default", () => {
    const snap = demoSnapshot();
    const [driver] = agents(snap);
    driver!.effort = null;
    driver!.effortSource = null;
    snap.seatEffort = { seatRef: "dev50.driver@openrig-build", report: null };

    const wide = renderScreen(rigView(snap).get(), snap, { cols: 160, rows: 34 });
    const header = wide.lines.find((line) => line.includes("SEAT") && line.includes("STATE"))!;
    const at = header.indexOf("CFG EFF");
    expect(wide.lines.find((line) => line.includes("┃ dev50") && line.includes("driver"))!.slice(at, at + 7).trim()).toBe("?");

    const out = agentDetail(snap, "dev50.driver");
    expect(out).toMatch(/saved\s+unknown/);
    expect(out).toContain("report not read");
    expect(out).not.toMatch(/saved\s+none/);
    expect(out).not.toContain("runtime default; no configured level");
  });

  it("shows a refused report without failing the detail page", () => {
    const snap = demoSnapshot();
    const driver = agents(snap)[0]!;
    driver.effort = "high";
    driver.effortSource = "authored";
    snap.seatEffort = {
      seatRef: "dev50.driver@openrig-build",
      report: { ok: false, code: "effort_unsupported_runtime", message: "Seat runs terminal; reasoning effort applies to claude-code and codex seats only." },
    };

    const out = agentDetail(snap, "dev50.driver");
    expect(out).toMatch(/saved\s+high\s+\(authored;\s+node inventory\)/);
    expect(out).toMatch(/emitted\s+unknown/);
    expect(out).toContain("report refused effort_unsupported_runtime");
  });
});
