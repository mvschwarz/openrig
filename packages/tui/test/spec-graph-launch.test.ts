import { describe, it, expect } from "vitest";
import { createViewState, emptySnapshot } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { renderScreen } from "../src/render.js";
import { resolveKeyAction } from "../src/input.js";
import { specGraph } from "../src/specs/graph.js";
import { renderGraphStyle } from "../src/topology/render-graph.js";
import { launchArgs, launchCommand, launchProcess, runSpecLaunch } from "../src/specs/launch.js";
import type { SpecEntry } from "../src/types.js";

const spec: SpecEntry = { name: "custom-team", kind: "rig", graph: {
  nodes: [{ id: "dev.build", label: "Build", pod: "dev", runtime: "claude", kind: "agent" },
    { id: "dev.review", label: "Review", pod: "dev", runtime: "codex", kind: "agent" }],
  edges: [{ source: "dev.build", target: "dev.review", kind: "collaborates_with" }],
} };
function setup() {
  const snap = { ...emptySnapshot(), specsLoaded: true, specs: [spec] };
  const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
  view.dispatch(parseCommand(`spec ${spec.name}`));
  return { snap, view, screen: () => renderScreen(view.get(), snap, { cols: 88, rows: 38 }) };
}

describe("rig spec graph and Launch", () => {
  it("opens on the same graph renderer, with no live seat hit targets or invented status", () => {
    const { view, screen } = setup();
    expect(view.get().viewTab).toBe("graph");
    const frame = screen();
    const graph = specGraph(spec.graph!);
    const expected = renderGraphStyle("hatchet", graph, { host: "", rig: spec.name }, 87).plainLines();
    const text = frame.lines.join("\n");
    for (const line of expected.filter(s => s.trim())) expect(text).toContain(line.trimEnd());
    expect(text).toContain("authored topology, not live status");
    expect(text).toContain("Launch…");
    expect(frame.contentTargets.some(t => t.action.type === "drill" && t.action.resource === "agent")).toBe(false);
    expect(graph.nodes.filter(n => n.type === "rigNode").every(n => n.data.status === null)).toBe(true);
  });

  it("keeps edge directions, pod grouping and null observations in the renderer input", () => {
    const result = specGraph(spec.graph!);
    expect(result.edges).toEqual([{ id: "spec-edge:0", source: "dev.build", target: "dev.review", label: "collaborates_with" }]);
    expect(result.nodes[1]!.parentId).toBe(result.nodes[0]!.id);
    expect(result.nodes[2]!.data).toMatchObject({ logicalId: "dev.review", runtime: "codex", contextUsedPercentage: null, startupStatus: null });
  });

  it("keyboard Enter opens Launch, requires a folder, shows exact choices, and Escape cancels", () => {
    const { view, screen } = setup();
    view.dispatch({ type: "focus", pane: "content" });
    let frame = screen();
    view.dispatch({ type: "layout", contentMaxOffset: frame.contentMaxOffset, contentTargetCount: frame.contentTargets.length });
    view.dispatch({ type: "content-select", index: frame.contentTargets.findIndex(t => t.action.type === "spec-launch") });
    const open = resolveKeyAction({ type: "key", key: "enter" }, view.get(), frame, frame.explorerRows.length);
    expect(open).toEqual({ type: "spec-launch" });
    view.dispatch(open!);
    expect(screen().lines.join("\n")).toContain("Working folder: not chosen");
    expect(screen().contentTargets.some(t => t.action.type === "act")).toBe(false);
    view.dispatch(parseCommand("launch-folder /work/My Team"));
    view.dispatch(parseCommand("launch-host build-box"));
    frame = screen();
    view.dispatch({ type: "layout", contentMaxOffset: frame.contentMaxOffset, contentTargetCount: frame.contentTargets.length });
    expect(frame.lines.join("\n")).toContain("/work/My Team");
    expect(frame.lines.join("\n")).toContain("Host: build-box");
    expect(frame.lines.join("\n")).toContain("Launch also sets OPENRIG_URL to this TUI's daemon.");
    view.dispatch({ type: "content-select", index: frame.contentTargets.findIndex(t => t.action.type === "act") });
    expect(resolveKeyAction({ type: "key", key: "enter" }, view.get(), frame, frame.explorerRows.length)).toEqual({ type: "act", act: "launch-spec" });
    // Dispatch alone (including control-socket navigation) cannot execute an act.
    view.dispatch({ type: "act", act: "launch-spec" });
    expect(view.get().specLaunch?.folder).toBe("/work/My Team");
    view.dispatch({ type: "back" });
    expect(view.get().specLaunch).toBeNull();
    expect(view.get().drill.at(-1)?.name).toBe(spec.name);
  });

  it("closes an unfinished confirmation on navigation rather than retaining a different spec's source", () => {
    const { view } = setup();
    view.dispatch(parseCommand("launch"));
    view.dispatch(parseCommand("launch-folder /work/team"));
    view.dispatch(parseCommand("tab yaml"));
    expect(view.get().specLaunch).toBeNull();
  });

  it("keeps graph unavailable separate from an empty graph, and defaults after lazy catalog loading", () => {
    const snap = emptySnapshot();
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch(parseCommand(`spec ${spec.name}`));
    snap.specs = [{ ...spec, graph: undefined, sourceUnavailable: "source unreadable" }];
    expect(view.get().viewTab).toBe("graph");
    expect(renderScreen(view.get(), snap, { cols: 88, rows: 38 }).lines.join("\n")).toContain("source unreadable");
  });
});

describe("unchanged rig up invocation and terminal handoff", () => {
  it("retains literal source/cwd/host and CLI entry; does not bypass collisions or add approval", () => {
    const request = { source: "custom-team", folder: "/work/Team's $(literal)", host: "remote-box" };
    const command = launchProcess(request, "http://127.0.0.1:7499", { OPENRIG_HOME: "/isolated", OPENRIG_HOST_SELECTED: "prior" }, "/node", ["/cli/bin-wrapper.js"]);
    expect(command).toEqual({ executable: "/node", args: ["/cli/bin-wrapper.js", "up", "--cwd", request.folder, "--host", "remote-box", "--", "custom-team"], env: { OPENRIG_HOME: "/isolated", OPENRIG_HOST_SELECTED: "prior", OPENRIG_URL: "http://127.0.0.1:7499" } });
    expect(launchCommand(request)).toContain("--cwd '");
    expect(launchArgs({ ...request, host: "" })).not.toContain("--host");
    expect(launchProcess({ ...request, host: "local" }, "http://localhost:7499", { OPENRIG_HOST_SELECTED: "remote" }, "rig").env.OPENRIG_HOST_SELECTED).toBe("local");
    expect(() => launchArgs({ ...request, folder: "" })).toThrow("absolute working folder");
    expect(() => launchArgs({ ...request, folder: "relative" })).toThrow("absolute working folder");
  });

  it.each([0, 1, null])("does not turn exit %s into a success claim or erase the CLI's partial output", async code => {
    const events: string[] = [];
    let notice = "";
    await runSpecLaunch({ command: { executable: "rig", args: ["up"], env: {} },
      run: async () => { events.push("CLI: partially_restored; one seat failed"); return code; },
      terminal: { write: s => { events.push(s); }, setRawMode: on => { events.push(`raw:${on}`); }, waitForEnter: async () => { events.push("wait"); return "enter"; } },
      pauseInput: () => { events.push("pause"); }, resumeInput: () => { events.push("resume"); }, setSuspended: on => { events.push(`suspended:${on}`); },
      isShuttingDown: () => false, notice: s => { notice = s; }, draw: () => { events.push("draw"); },
    });
    expect(events.indexOf("pause")).toBeLessThan(events.indexOf("CLI: partially_restored; one seat failed"));
    expect(events.indexOf("wait")).toBeLessThan(events.indexOf("raw:true"));
    expect(events.at(-1)).toBe("draw");
    expect(notice).not.toMatch(/success|launched/i);
    expect(notice).toContain(code === null ? "signal" : `exited ${code}`);
  });

  it("restores input after spawn error, names uncertainty, and never retries", async () => {
    let runs = 0; let resumed = false; let notice = "";
    await runSpecLaunch({ command: { executable: "missing", args: [], env: {} }, run: async () => { runs++; throw new Error("ENOENT"); },
      terminal: { write() {}, setRawMode() {}, waitForEnter: async () => "enter" },
      pauseInput() {}, resumeInput: () => { resumed = true; }, setSuspended() {}, isShuttingDown: () => false,
      notice: s => { notice = s; }, draw() {},
    });
    expect(runs).toBe(1); expect(resumed).toBe(true); expect(notice).toContain("ENOENT"); expect(notice).toContain("Inspect rig ps");
  });
});
