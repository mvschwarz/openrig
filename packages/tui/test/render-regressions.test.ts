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

  it("never emits a composed row wider than the terminal", () => {
    const snap = demoSnapshot();
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "jump", section: "needs" });

    const screen = renderScreen(view.get(), snap, { cols: 80, rows: 20 });
    expect(screen.lines.every((line) => line.length <= 80)).toBe(true);
  });

  it("anchors ticker, rule, and status to the bottom of an exact short 140x34 view", () => {
    const base = demoSnapshot();
    const snap: FleetSnapshot = { ...base, needs: [], hostsDown: [], humanQueue: [] };
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "jump", section: "needs" });

    const screen = renderScreen(view.get(), snap, { cols: 140, rows: 34 });
    expect(screen.lines).toHaveLength(34);
    expect(screen.lines[31]).toContain("≋");
    expect(screen.lines[32]).toMatch(/^─+$/);
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
      needs: [{ kind: "overdue", target: "qitem-123", detail: "past closure_required_at" }],
    };
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "jump", section: "needs" });

    const screen = renderScreen(view.get(), snap, { cols: 140, rows: 20 });
    const lineIndex = screen.lines.findIndex((line) => line.includes("qitem-123"));
    expect(lineIndex).toBeGreaterThanOrEqual(0);
    expect(screen.lines[lineIndex]).not.toContain("open ▸");
    expect(screen.hitMap.some((hit) => hit.y === lineIndex + 1 && hit.x1 > 30)).toBe(false);
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
    expect(output).toContain("source: …/");
    expect(output).toContain("adversarial-review/rig.yaml · user library");
    expect(output).toContain("format pod-aware · pods 1 · members 1 · edges 1");
    expect(output).toContain("review (pod)");
    expect(output).toContain("r1 → independent-reviewer · claude-code · profile default");
    expect(output).toContain("orch.lead → review.r1 (delegates_to)");
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
    expect(topology).toContain("orch.lead · lead · pod orch · claude-code");
    expect(topology).toContain("orch.lead → review.r1 (delegates_to)");

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
    expect(initial.lines.join("\n")).not.toContain("pod-17 (pod)");
    const scrollY = initial.lines.findIndex((line) => line.includes("content ↑/↓")) + 1;
    expect(initial.hitMap).toContainEqual(expect.objectContaining({
      y: scrollY,
      action: { type: "content-scroll", delta: 10 },
    }));
    view.dispatch({ type: "content-scroll", delta: 20 });
    const scrolled = renderScreen(view.get(), snap, { cols: 100, rows: 12 }).lines.join("\n");
    expect(scrolled).toContain("pod-17 (pod)");
    expect(view.get().selection).toBe(selected);
    expect(scrolled).toContain("content ↑/↓");
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
    expect(output).toContain("runtime claude-code");
    expect(output).toContain("brainstorming");
    expect(output).toContain("resources: guidance guidance/role.md · plugins openrig-core · subagents reviewer");
    const usedY = screen.lines.findIndex((line) => line.includes("used by rig adversarial-review")) + 1;
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
