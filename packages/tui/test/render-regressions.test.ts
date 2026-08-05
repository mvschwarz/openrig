import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../src/demo-data.js";
import { renderScreen } from "../src/render.js";
import { computeExplorerRows, createViewState } from "../src/state.js";
import type { FleetSnapshot } from "../src/types.js";

describe("live visual regressions", () => {
  it("renders the locked RIG column and value in the agents table", () => {
    const snap = demoSnapshot();
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "drill", resource: "rig", name: "openrig-build" });

    const screen = renderScreen(view.get(), snap, { cols: 140, rows: 34 });
    const header = screen.lines.find((line) => line.includes("AGENT") && line.includes("STATUS"));
    const row = screen.lines.find((line) => line.includes("dev50.driver"));

    expect(header).toMatch(/RIG\s+POD\s+AGENT/);
    expect(row).toContain("openrig-build");
  });

  it("preserves the full CTX/TOKENS table at the locked 140-column size", () => {
    const snap = demoSnapshot();
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "drill", resource: "rig", name: "openrig-build" });

    const screen = renderScreen(view.get(), snap, { cols: 140, rows: 34 });
    const header = screen.lines.find((line) => line.includes("AGENT") && line.includes("STATUS"));
    expect(header).toContain("CTX%");
    expect(header).toContain("TOKENS");
    expect(header).toContain("ACTIONS");
  });

  it("keeps every raw-key content target visibly focused, including multiple actions on one row", () => {
    const snap = demoSnapshot();
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "drill", resource: "rig", name: "openrig-build" });
    view.dispatch({ type: "focus", pane: "content" });
    let screen = renderScreen(view.get(), snap, { cols: 140, rows: 34 });
    view.dispatch({ type: "layout", contentMaxOffset: screen.contentMaxOffset, contentTargetCount: screen.contentTargets.length });
    screen = renderScreen(view.get(), snap, { cols: 140, rows: 34 });

    const tabIndex = screen.contentTargets.findIndex((target) => target.action.type === "tab");
    const termIndex = screen.contentTargets.findIndex((target) => target.action.type === "act" && target.action.act === "open-terminal");
    const rowIndex = screen.contentTargets.findIndex((target) => target.action.type === "drill" && target.action.resource === "agent");
    expect([tabIndex, termIndex, rowIndex].every((index) => index >= 0)).toBe(true);

    view.dispatch({ type: "content-select", index: tabIndex });
    screen = renderScreen(view.get(), snap, { cols: 140, rows: 34 });
    // pane delimiter located by its FIXED boundary (EXPL_W=30 → content at 31):
    // the slice-17 navigator's │ rails would shadow a first-│ split (guard-
    // sanctioned truthful floor update; the assertion is unchanged)
    expect(screen.lines[screen.contentTargets[tabIndex]!.y - 1]!.slice(31)).toMatch(/^›/);

    view.dispatch({ type: "content-select", index: termIndex });
    screen = renderScreen(view.get(), snap, { cols: 140, rows: 34 });
    expect(screen.lines[screen.contentTargets[termIndex]!.y - 1]).toContain("›term ▸");

    view.dispatch({ type: "content-select", index: rowIndex });
    screen = renderScreen(view.get(), snap, { cols: 140, rows: 34 });
    // fixed-boundary pane delimiter (see the tab-focus pin above)
    expect(screen.lines[screen.contentTargets[rowIndex]!.y - 1]!.slice(31)).toMatch(/^›/);
  });

  it("never emits a composed row wider than the terminal", () => {
    const snap = demoSnapshot();
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "jump", section: "needs" });

    const screen = renderScreen(view.get(), snap, { cols: 80, rows: 20 });
    expect(screen.lines.every((line) => line.length <= 80)).toBe(true);
  });

  it("anchors ticker, rule, and status to the bottom of an exact short 140x34 view", () => {
    const base = demoSnapshot();
    const snap: FleetSnapshot = { ...base, needs: [], hostsDown: [] };
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "jump", section: "needs" });

    const screen = renderScreen(view.get(), snap, { cols: 140, rows: 34 });
    expect(screen.lines).toHaveLength(34);
    // chrome contract (visual-polish directive): ticker · pane rule · keybind
    // hint bar · status line, bottom-anchored
    expect(screen.lines[30]).toContain("≋");
    expect(screen.lines[31]).toMatch(/^─+┴─+$/);
    expect(screen.lines[32]).toContain("q quit");
    expect(screen.lines[33]).toContain("[t] needs");
  });

  it("scrolls the Explorer viewport to keep the keyboard selection visible", () => {
    const base = demoSnapshot();
    const snap: FleetSnapshot = {
      ...base,
      specs: Array.from({ length: 20 }, (_, i) => ({ name: `spec-${i}`, kind: "agent" as const })),
    };
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "jump", section: "specs" });
    const rows = computeExplorerRows(view.get(), snap);
    const target = rows.findIndex((row) => row.label.includes("spec-15"));
    view.dispatch({ type: "select", index: target, rowCount: rows.length });

    const screen = renderScreen(view.get(), snap, { cols: 100, rows: 12 });
    expect(screen.lines.some((line) => line.includes("›") && line.includes("spec-15"))).toBe(true);
  });

  it("does not advertise open on a Needs-You target that cannot navigate", () => {
    const base = demoSnapshot();
    const snap: FleetSnapshot = {
      ...base,
      needs: [{ source: "derived", kind: "overdue", target: "qitem-123", detail: "past closure_required_at" }],
    };
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "jump", section: "needs" });

    const screen = renderScreen(view.get(), snap, { cols: 140, rows: 20 });
    const lineIndex = screen.lines.findIndex((line) => line.includes("qitem-123"));
    expect(lineIndex).toBeGreaterThanOrEqual(0);
    expect(screen.lines[lineIndex]).not.toContain("open ▸");
    expect(screen.hitMap.some((hit) => hit.y === lineIndex + 1 && hit.x1 > 30)).toBe(false);
  });

  it("never opens a local seat for a remote Needs row with the same canonical session", () => {
    const snap = demoSnapshot();
    snap.needs = [{
      source: "derived",
      kind: "stuck",
      target: "dev50-guard@openrig-build",
      hostId: "remote-a",
      detail: "remote guard needs attention",
    }];
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "jump", section: "needs" });
    const screen = renderScreen(view.get(), snap, { cols: 140, rows: 34 });
    const row = screen.lines.find((line) => line.includes("remote guard needs attention"));
    expect(row).toContain("[remote-a]");
    expect(row).not.toContain("open ▸");
    expect(screen.contentTargets).toHaveLength(0);
  });

  it("renders the locked rig-spec structure with clickable agent refs", () => {
    const base = demoSnapshot();
    const snap: FleetSnapshot = {
      ...base,
      specs: [{
        name: "adversarial-review",
        kind: "rig",
        sourceState: "library_item",
        sourceType: "user_file",
        sourcePath: "/Users/admin/code/openrig-build-source/packages/daemon/specs/rigs/focused/adversarial-review/rig.yaml",
        relativePath: "rigs/focused/adversarial-review/rig.yaml",
        format: "pod_aware",
        pods: [{
          id: "review",
          label: "Review",
          members: [{ id: "r1", agentRef: "independent-reviewer", runtime: "claude-code", profile: "default" }],
          edges: [],
        }],
        edges: [{ from: "orch.lead", to: "review.r1", kind: "delegates_to" }],
        graph: {
          nodes: [{ id: "orch.lead", label: "lead", pod: "orch", runtime: "claude-code", kind: "agent" }],
          edges: [{ source: "orch.lead", target: "review.r1", kind: "delegates_to" }],
        },
        raw: "name: adversarial-review\nversion: '0.2'",
      }, {
        name: "independent-reviewer",
        kind: "agent",
        relativePath: "agents/review/independent-reviewer/agent.yaml",
      }],
    };
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "drill", resource: "spec", name: "adversarial-review" });

    const screen = renderScreen(view.get(), snap, { cols: 140, rows: 34 });
    const output = screen.lines.join("\n");
    expect(output).toMatch(/source:\s+…\//);
    expect(output).toContain("adversarial-review/rig.yaml · user library");
    expect(output).toMatch(/format:\s+pod-aware/);
    expect(output).toMatch(/shape:\s+1 pods · 1 members · 1 edges/);
    expect(output).toMatch(/── pod review/);
    expect(output).toMatch(/▪ r1\s+independent-reviewer\s+claude-code\s+profile default/);
    expect(output).toMatch(/orch\.lead → review\.r1\s+\(delegates_to\)/);
    const memberY = screen.lines.findIndex((line) => line.includes("independent-reviewer")) + 1;
    expect(screen.hitMap).toContainEqual(expect.objectContaining({
      y: memberY,
      action: { type: "drill", resource: "spec", name: "independent-reviewer" },
    }));

    const tabsY = screen.lines.findIndex((line) => line.includes("TOPOLOGY") && line.includes("YAML")) + 1;
    expect(screen.hitMap).toContainEqual(expect.objectContaining({
      y: tabsY,
      action: { type: "tab", tab: "topology" },
    }));

    view.dispatch({ type: "tab", tab: "topology" });
    const topology = renderScreen(view.get(), snap, { cols: 140, rows: 34 }).lines.join("\n");
    expect(topology).toMatch(/NODE\s+LABEL\s+POD\s+RUNTIME/);
    expect(topology).toMatch(/orch\.lead\s+lead\s+orch\s+claude-code/);
    expect(topology).toMatch(/orch\.lead\s+→\s+review\.r1\s+\(delegates_to\)/);

    view.dispatch({ type: "tab", tab: "yaml" });
    const yaml = renderScreen(view.get(), snap, { cols: 140, rows: 34 }).lines.join("\n");
    expect(yaml).toContain("name: adversarial-review");
    expect(yaml).not.toContain("format pod-aware");
  });

  it("scrolls long content independently of the Explorer selection", () => {
    const base = demoSnapshot();
    const snap: FleetSnapshot = {
      ...base,
      specs: [{
        name: "long-rig",
        kind: "rig",
        format: "pod_aware",
        pods: Array.from({ length: 18 }, (_, i) => ({ id: `pod-${i}`, members: [], edges: [] })),
      }],
    };
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "drill", resource: "spec", name: "long-rig" });
    const selected = view.get().selection;

    const initial = renderScreen(view.get(), snap, { cols: 100, rows: 12 });
    view.dispatch({ type: "layout", contentMaxOffset: initial.contentMaxOffset, contentTargetCount: initial.contentTargets.length });
    expect(initial.lines.join("\n")).not.toContain("pod pod-17");
    const scrollY = initial.lines.findIndex((line) => line.includes("scroll ↑/↓")) + 1;
    expect(initial.hitMap).toContainEqual(expect.objectContaining({
      y: scrollY,
      action: { type: "content-scroll", delta: 10 },
    }));
    view.dispatch({ type: "content-scroll", delta: 60 }); // clamps to max; content grew to ~3 lines/pod under the section vocabulary
    const scrolled = renderScreen(view.get(), snap, { cols: 100, rows: 12 }).lines.join("\n");
    expect(scrolled).toContain("pod pod-17");
    expect(view.get().selection).toBe(selected);
    expect(scrolled).toContain("scroll ↑/↓");
  });

  it("shows the Topology filter affordance and N-of-M / idle frame", () => {
    const snap = demoSnapshot();
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "drill", resource: "rig", name: "openrig-build" });

    const output = renderScreen(view.get(), snap, { cols: 140, rows: 34 }).lines.join("\n");
    expect(output).toContain("/ filter agents…");
    expect(output).toMatch(/\d+ of \d+ \/ \d+ idle/);
  });

  it("renders agent runtime/resources and makes each used-by rig a real reverse link", () => {
    const base = demoSnapshot();
    const snap: FleetSnapshot = {
      ...base,
      specs: [{ name: "adversarial-review", kind: "rig", agentRefs: ["independent-reviewer"] }, {
        name: "independent-reviewer",
        kind: "agent",
        runtime: "claude-code",
        skills: ["using-superpowers", "openrig-user", "mission-slice-sop", "review-team", "systematic-debugging", "verification-before-completion", "writing-plans", "brainstorming"],
        profiles: ["default"],
        resources: {
          skills: ["review-team"], guidance: ["guidance/role.md"], plugins: ["openrig-core"], subagents: ["reviewer"],
        },
        usedByRigs: ["adversarial-review"],
      }],
    };
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "drill", resource: "spec", name: "independent-reviewer" });

    const screen = renderScreen(view.get(), snap, { cols: 140, rows: 34 });
    const output = screen.lines.join("\n");
    expect(output).toMatch(/runtime:\s+claude-code/);
    expect(output).toContain("brainstorming");
    expect(output).toMatch(/resources:\s+guidance guidance\/role\.md · plugins openrig-core · subagents reviewer/);
    const usedY = screen.lines.findIndex((line) => line.includes("rig adversarial-review")) + 1;
    expect(screen.hitMap).toContainEqual(expect.objectContaining({
      y: usedY,
      action: { type: "drill", resource: "spec", name: "adversarial-review" },
    }));
  });

  it("shows the Specs filter affordance and groups agent specs by folder namespace", () => {
    const base = demoSnapshot();
    const snap: FleetSnapshot = {
      ...base,
      specs: [
        { name: "independent-reviewer", kind: "agent", namespace: "review" },
        { name: "orchestrator", kind: "agent", namespace: "orchestration" },
      ],
    };
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "jump", section: "specs" });

    const output = renderScreen(view.get(), snap, { cols: 140, rows: 34 }).lines.join("\n");
    expect(output).toContain("/ filter specs…");
    expect(output).toContain("review/");
    expect(output).toContain("orchestration/");
  });
});
