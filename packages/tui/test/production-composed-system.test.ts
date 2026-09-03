import { afterEach, describe, expect, it } from "vitest";
import { parseCommand } from "../src/grammar.js";
import { renderScreen } from "../src/render.js";
import { createViewState } from "../src/state.js";
import { describeState } from "../src/socket-server.js";
import { demoSnapshot } from "../src/demo-data.js";

function factory() {
  const snap = demoSnapshot();
  const driver = snap.hosts[0]!.rigs[0]!.pods[0]!.agents[0]!;
  driver.model = "fable-5.1";
  snap.blocked[0]!.tags = ["mission:release-0.5.9", "slice:OPR.0.5.9.11"];
  snap.blocked = snap.blocked.filter((row) => row.destinationSession !== "dev50-qa@openrig-build");
  snap.pending = snap.pending.filter((row) => row.destinationSession !== "dev50-qa@openrig-build");
  const view = createViewState({ instanceId: "production-composed", getSnapshot: () => snap });
  view.dispatch({ type: "drill", resource: "rig", name: "openrig-build" });
  return { snap, view };
}

afterEach(() => {
  delete process.env["OPENRIG_REDUCED_MOTION"];
});

describe("founder-approved G2/L2 production composition", () => {
  it.each([
    [160, 32],
    [120, 30],
    [84, 24],
  ])("keeps the balanced Explorer at %i columns", (cols, expected) => {
    const { snap, view } = factory();
    const screen = renderScreen(view.get(), snap, { cols, rows: cols === 84 ? 28 : 42 });
    expect(screen.explorerWidth).toBe(expected);
    expect(screen.lines[1]![expected]).toBe("╋");
    expect(screen.lines.slice(2, -3).some((line) => line[expected] === "┃")).toBe(true);
  });

  it.each([160, 120])("keeps every approved factory fact separately scannable at %i columns", (cols) => {
    const { snap, view } = factory();
    const body = renderScreen(view.get(), snap, { cols, rows: 42, nowMs: 0 }).lines.join("\n");
    const header = body.split("\n").find((line) => /POD\s+SEAT\s+RT\s+MODEL/.test(line));
    expect(header).toMatch(/CTX\s+STATE\s+Q\s+WORK\s+NOW\s+ACTIONS/);
    expect(body).toContain("fable-5");
    expect(body).toMatch(/\sS11\s/);
    expect(body).toMatch(/blocked · [^ ]/);
    expect(body).not.toMatch(/RIG\s+POD\s+SEAT/);
  });

  it("defers MODEL, NOW, and ACTIONS at 84 columns and says where they went", () => {
    const { snap, view } = factory();
    const body = renderScreen(view.get(), snap, { cols: 84, rows: 28 }).lines.join("\n");
    const header = body.split("\n").find((line) => /POD\s+SEAT\s+RT/.test(line))!;
    expect(header).toMatch(/CTX\s+STATE\s+Q\s+WORK/);
    expect(header).not.toMatch(/MODEL|NOW|ACTIONS/);
    expect(body).toContain("MODEL/NOW/ACTIONS on drill");
    expect(body.split("\n").every((line) => line.length <= 84)).toBe(true);
  });

  it("derives NOW only from typed queue rows and animates visible working marks at 2fps", () => {
    const { snap, view } = factory();
    const at0 = renderScreen(view.get(), snap, { cols: 160, rows: 42, nowMs: 0 });
    const at500 = renderScreen(view.get(), snap, { cols: 160, rows: 42, nowMs: 500 });
    const driver0 = at0.lines.find((line) => line.includes("┃ dev50") && line.includes("driver"));
    const driver500 = at500.lines.find((line) => line.includes("┃ dev50") && line.includes("driver"));
    const noRow = at0.lines.find((line) => line.includes("┃") && /\? qa\s/.test(line));
    expect(driver0).not.toBe(driver500);
    expect(at0.motionActive).toBe(true);
    expect(noRow).toMatch(/\s—\s+—\s+run ▸/);

    process.env["OPENRIG_REDUCED_MOTION"] = "1";
    const reduced0 = renderScreen(view.get(), snap, { cols: 160, rows: 42, nowMs: 0 });
    const reduced500 = renderScreen(view.get(), snap, { cols: 160, rows: 42, nowMs: 500 });
    expect(reduced0.lines.find((line) => line.includes("┃ dev50") && line.includes("driver"))).toBe(
      reduced500.lines.find((line) => line.includes("┃ dev50") && line.includes("driver")),
    );
  });

  it("makes terminal-native select/copy mode a registered, visible view-state", () => {
    expect(parseCommand("select-text")).toEqual({ type: "copy-mode" });
    const { snap, view } = factory();
    expect(view.dispatch(parseCommand("select-text")).copyMode).toBe(true);
    const screen = renderScreen(view.get(), snap, { cols: 120, rows: 34 });
    expect(screen.lines.join("\n")).toContain("drag to select/copy");
    expect(view.dispatch(parseCommand("select-text")).copyMode).toBe(false);
  });

  it("exposes the current semantic address as structured socket state", () => {
    const { view } = factory();
    view.dispatch({ type: "drill", resource: "agent", name: "dev50.driver" });
    const address = describeState(view.get()).address;
    expect(address).toMatchObject({
      instance: "production-composed",
      section: "topology",
      host: "vm-host",
      rig: "openrig-build",
      pod: "dev50",
      agent: "dev50.driver",
    });
    expect(address.path).toContain("agent:dev50.driver");
  });

  it.each([
    ["resource drill", "rig openrig-build", {
      instance: "production-composed",
      section: "topology",
      host: "vm-host",
      rig: "openrig-build",
      path: "instance:production-composed/section:topology/host:vm-host/rig:openrig-build",
    }],
    ["cross navigation", "spec-of dev50.driver", {
      instance: "production-composed",
      section: "specs",
      spec: "driver-agent",
      path: "instance:production-composed/section:specs/spec:driver-agent",
    }],
  ])("drops stale scope coordinates when %s leaves SCOPES", (_label, command, expected) => {
    const { view } = factory();
    view.dispatch({ type: "scopes-open", mission: "release-0.5.9", slice: "11-production-tui-composed-system" });
    view.dispatch(parseCommand(command));

    expect(describeState(view.get()).address).toEqual(expected);
  });
});
