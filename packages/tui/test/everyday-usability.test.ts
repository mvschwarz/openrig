import { describe, expect, it } from "vitest";
import { completeCommand } from "../src/commands/completion.js";
import { COMMAND_REGISTRY } from "../src/commands/registry.js";
import { parseCommand } from "../src/grammar.js";
import { createInputDecoder, decodeInput, resolveEscapeAction } from "../src/input.js";
import { createViewState, emptySnapshot } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { displayTime, resolveTimeZone } from "../src/time.js";
import { healthDetailLines } from "../src/health/health-model.js";
import { workflowDetail } from "../src/execution/workflow-model.js";
import { demoSnapshot } from "../src/demo-data.js";

function fixture() {
  const snapshot = demoSnapshot();
  snapshot.stream = [];
  snapshot.recentTransitionsScope = { kind: "instance" };
  snapshot.recentTransitions = [
    { transitionId: 31, qitemId: "q-one", ts: "2026-01-15T20:00:00Z", actorSession: "qa-checker@build", change: "launch requested; result unconfirmed", summary: "Inspect an unusually long activity title without losing what happened", rig: "build", targetKind: "qitem" as const, target: "q-one" },
    { transitionId: 32, qitemId: "q-two", ts: "2026-07-15T20:00:00Z", actorSession: "orch-lead@build", change: "failed: destination unavailable", summary: "Report delivery failure", rig: "build", targetKind: "qitem" as const, target: "q-two" },
    { transitionId: 33, qitemId: "q-three", ts: "malformed", actorSession: "dev-worker@build", change: "completed", summary: "Keep this recorded outcome attributed", rig: "build", targetKind: "qitem" as const, target: "q-three" },
  ];
  const view = createViewState({ instanceId: "proof", getSnapshot: () => snapshot });
  view.dispatch({ type: "drill", resource: "host", name: snapshot.hosts[0]!.name });
  view.dispatch(parseCommand("tab recent"));
  return { snapshot, view };
}

describe("registry-backed command completion", () => {
  it("offers registry commands and aliases without executing them", () => {
    const snapshot = emptySnapshot(); const view = createViewState({ instanceId: "c" });
    const ctx = { state: view.get(), snapshot };
    for (const entry of COMMAND_REGISTRY.filter((e) => !e.prefix)) for (const word of [entry.name, ...entry.aliases])
      expect(completeCommand(word, ctx).candidates).toContain(word);
    expect(completeCommand("con", ctx)).toMatchObject({ line: "con", candidates: ["config", "connections"] });
    expect(completeCommand("conn", ctx).line).toBe("connections");
    expect(completeCommand("conf", ctx).line).toBe("config ");
    expect(completeCommand("ag", ctx).line).toBe("agent ");
    expect(view.get().section).toBe("topology");
    expect(completeCommand("", ctx).message).toContain("matches");
  });
  it("narrows ambiguous prefixes and preserves unmatched text", () => {
    const { snapshot, view } = fixture(); const ctx = { snapshot, state: view.get() };
    expect(completeCommand("s", ctx).candidates.length).toBeGreaterThan(1);
    expect(completeCommand("s", ctx).line).toBe("s");
    expect(completeCommand("nonesuch text", ctx)).toMatchObject({ line: "nonesuch text", candidates: [] });
    expect(completeCommand("/free form", ctx).line).toBe("/free form");
    expect(completeCommand(":sc", ctx).line).toBe(":scopes");
    expect(completeCommand("scroll d", ctx).line).toBe("scroll down");
    expect(completeCommand("style braille-", ctx).line).toBe("style braille-fallback");
  });
  it.each([
    ["  hel", "  help"],
    ["  scroll  d", "  scroll  down"],
    ["  :  sc", "  :  scopes"],
  ])("completes %j with grammar-compatible whitespace", (input, expected) => {
    const { snapshot, view } = fixture();
    const ctx = { snapshot, state: view.get() };
    expect(completeCommand(input, ctx).line).toBe(expected);
    expect(parseCommand(expected, ctx.state.sections).type).not.toBe("error");
  });

  it("offers only valid tabs and only workflows in the selected mission", () => {
    const { snapshot, view } = fixture();
    view.dispatch(parseCommand(":connections"));
    expect(completeCommand("tab ", { snapshot, state: view.get() }).candidates).toEqual(["pulse"]);
    snapshot.execution = { mission: "m", lifecycle_instances: [{ instance_id: "run-1", frontier_packets: [{ packet_id: "work-1" }] }] } as never;
    expect(completeCommand("workflow ", { snapshot, state: view.get() }).candidates).toEqual([]);
    view.dispatch(parseCommand("mission m"));
    expect(completeCommand("workflow r", { snapshot, state: view.get() }).line).toBe("workflow run-1");
    expect(completeCommand("packet w", { snapshot, state: view.get() }).line).toBe("packet work-1");
  });
  it("qualifies duplicate seats rather than choosing a twin", () => {
    const { snapshot, view } = fixture();
    const h = snapshot.hosts[0]!; const r = h.rigs[0]!;
    const a = r.pods[0]!.agents[0]!;
    snapshot.hosts.push({ ...h, name: "second-host" });
    const candidates = completeCommand("agent ", { snapshot, state: view.get() }).candidates;
    expect(candidates).not.toContain(a.name);
    for (const name of candidates) { view.dispatch(parseCommand(`agent ${name}`)); expect(view.get().lastError).toBeNull(); }
  });
  it("does not complete unavailable commands in recovery", () => {
    const view = createViewState({ instanceId: "c" }); const ctx = { state: view.get(), snapshot: emptySnapshot() };
    expect(completeCommand("con", ctx, "daemon-down").candidates).toEqual([]);
    expect(completeCommand("hel", ctx, "daemon-down").line).toBe("help");
  });
});

describe("keyboard stream boundaries", () => {
  it("decodes Tab once, preserving neighboring text and backspace", () => {
    expect(decodeInput("ag\t\x7f")).toEqual([{ type: "char", ch: "a" }, { type: "char", ch: "g" }, { type: "key", key: "tab" }, { type: "key", key: "backspace" }]);
  });
  it("does not flush an open paste on the bare-Escape key timer", () => {
    const decoder = createInputDecoder();
    expect(decoder.write("\x1b[200~slow paste")).toEqual([]);
    expect(decoder.hasPending()).toBe(false);
    expect(decoder.write(" continues\x1b[201~")).toEqual([{ type: "paste", text: "slow paste continues" }]);
  });
  it("bracketed paste never becomes a shortcut, completion or submission at any byte split", () => {
    const bytes = Buffer.from("\x1b[200~q?界🙂\tnew\nline\x1b[201~");
    for (let split = 1; split < bytes.length; split++) {
      const decoder = createInputDecoder();
      expect([...decoder.write(bytes.subarray(0, split)), ...decoder.write(bytes.subarray(split)), ...decoder.flush()]).toEqual([{ type: "paste", text: "q?界🙂 new line" }]);
    }
  });
});

describe("Recent play-by-play", () => {
  it.each([140, 84])("keeps actor/change/subject/order readable at %i columns", (cols) => {
    const { snapshot, view } = fixture(); const before = JSON.stringify(snapshot.recentTransitions);
    const screen = renderScreen(view.get(), snapshot, { cols, rows: 140 });
    const content = screen.lines.map((l) => l.slice(screen.explorerWidth + 2)).join("\n");
    const text = content.replace(/\s+/g, " ");
    expect(text).toContain("launch requested; result unconfirmed");
    expect(text).toContain("failed: destination unavailable");
    expect(text).toContain("qa-checker@build");
    expect(text).toContain("without losing what happened");
    expect(text.indexOf("#31")).toBeLessThan(text.indexOf("#32"));
    expect(text.indexOf("#32")).toBeLessThan(text.indexOf("#33"));
    expect(text).toContain("time unknown");
    expect(JSON.stringify(snapshot.recentTransitions)).toBe(before);
    expect(screen.contentTargets.filter((t) => t.action.type === "recent-open")).toHaveLength(3);
    expect(screen.lines.every((l) => l.length <= cols)).toBe(true);
  });
  it("opens the exact record, keeps it through refresh, and returns to the prior scroll", () => {
    const { snapshot, view } = fixture();
    view.dispatch({ type: "layout", contentMaxOffset: 20, contentTargetCount: 3 });
    view.dispatch({ type: "content-scroll", delta: 7 });
    view.dispatch(parseCommand("recent 31"));
    snapshot.recentTransitions = [];
    const screen = renderScreen(view.get(), snapshot, { cols: 140, rows: 45 });
    expect(screen.lines.join("\n")).toContain("2026-01-15T20:00:00Z");
    expect(screen.lines.join("\n")).toContain("result unconfirmed");
    const back = resolveEscapeAction({ type: "key", key: "escape" }, view.get());
    expect(back).toEqual({ type: "back" }); view.dispatch(back!);
    expect(view.get()).toMatchObject({ recentOpen: null, viewTab: "recent", contentOffset: 7 });
    view.dispatch(parseCommand("recent 31")); expect(view.get().lastError).toContain("outside");
  });
});

describe("named local time", () => {
  it("uses Pacific winter and summer offsets, not the machine timezone", () => {
    expect(displayTime("2026-01-15T20:00:00Z")).toBe("2026-01-15 12:00:00 PST");
    expect(displayTime("2026-07-15T20:00:00Z")).toBe("2026-07-15 13:00:00 PDT");
    expect(displayTime("2026-01-15 20:00:00")).toBe("2026-01-15 12:00:00 PST");
    expect(displayTime("2026-07-15T20:00:00Z", "Europe/London")).toBe("2026-07-15 21:00:00 GMT+1");
  });
  it("does not invent an instant or hide invalid timezone configuration", () => {
    for (const bad of [null, "", "nonsense", "2026-01-15T20:00:00", "2026-13-15T20:00:00Z", "2026-02-30T20:00:00Z", "2026-01-15T24:00:00Z"]) expect(displayTime(bad)).toBe("time unknown");
    expect(resolveTimeZone("Mars/Olympus")).toMatchObject({ timeZone: "America/Los_Angeles", warning: expect.stringContaining("invalid") });
    expect(displayTime("2026-07-15T20:00:00Z", "Mars/Olympus")).toContain("fallback");
  });
  it("uses the chosen zone in workflow, health and Recent", () => {
    const { snapshot } = fixture(); const ts = "2026-07-15T20:00:00Z";
    const view = createViewState({ instanceId: "z", timeZone: "Europe/London", getSnapshot: () => snapshot });
    view.dispatch(parseCommand("recent 32"));
    expect(renderScreen(view.get(), snapshot, { cols: 140, rows: 50 }).lines.join("\n")).toContain("21:00:00 GMT+1");
    const ex = { mission: "m", derived_at: ts, lifecycle_instances: [{ instance_id: "run", status: "running", frontier_packets: [{ packet_id: "q", step_id: "work", latest_transition: { ts } }] }] } as never;
    expect(workflowDetail(ex, "packet:q", 100, "Europe/London")!.map((l) => l.text).join("\n")).toContain("21:00:00 GMT+1");
    snapshot.health = { records: [{ id: "h", status: "open", severity: "warning", category: "work", detector: "test", summary: "Signal", confidence: "high", explanation: "A recorded condition", threshold: "threshold", suggestedInspection: "Inspect the source", freshness: { state: "fresh", ageSeconds: 1 }, evidence: [], startedAt: ts, lastObservedAt: ts, scope: { type: "instance", instanceId: "local" } }] } as never;
    expect(healthDetailLines(snapshot, "h", 100, "Europe/London").map((l) => l.text).join("\n")).toContain("21:00:00 GMT+1");
    view.dispatch(parseCommand("timezone"));
    const help = renderScreen(view.get(), snapshot, { cols: 100, rows: 50 }).lines.join("\n");
    expect(help).toContain("rig config set ui.timezone Europe/London");
  });
});
