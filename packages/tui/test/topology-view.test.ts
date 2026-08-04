// Slice-17 TOPOLOGY LEG Phase 1 — the hatchet graph view ported onto the
// SHIPPED shell: one view-state, one reducer, the shipped renderScreen/
// stylize/hit-map (PIN-1 on the real path, not the spike store). New file;
// shipped floors untouched.
import { describe, it, expect } from "vitest";
import { createViewState } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { renderScreen } from "../src/render.js";
import { createStyle, stripAnsi } from "../src/theme.js";
import { stylizeLines } from "../src/stylize.js";
import { demoSnapshot } from "../src/demo-data.js";
import { spikeFixtureGraph, FIXTURE_RIG_NAME } from "../src/topology/fixture.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { DaemonClient } from "../src/daemon-client.js";
import type { FleetSnapshot } from "../src/types.js";

/** demo shell snapshot with the full-vocabulary graph attached to the rig —
 * the graph rides RigNode.graph, hydrated from the EXISTING /graph read */
function graphSnap(): FleetSnapshot {
  const snap = demoSnapshot();
  const graph = spikeFixtureGraph();
  // the snapshot pod tree mirrors the graph's agents so drill targets resolve
  // (PIN-1 dispatches validate against the SAME snapshot the renderer draws)
  const agentRow = (name: string, runtime: string, context: number | null) =>
    ({ name, runtime, spec: "", context, tokens: null, status: "active", live: true });
  return {
    ...snap,
    hosts: [{
      name: "vm-host",
      reachable: true,
      rigs: [{
        name: FIXTURE_RIG_NAME,
        pods: [
          { name: "orch", agents: [agentRow("orch.lead", "claude-code", 18)] },
          { name: "dev", agents: [agentRow("dev.driver", "claude-code", 24), agentRow("dev.qa", "codex", 63)] },
          { name: "review", agents: [agentRow("review.r1", "codex", null), agentRow("review.validator", "codex", null)] },
        ],
        graph,
      }],
    }],
  };
}

function makeStore(snap: FleetSnapshot) {
  return createViewState({ instanceId: "topo-test", getSnapshot: () => snap });
}

describe("graph view reachability (the existing navigation, extended additively)", () => {
  it("`tab graph` parses and the topology section accepts it", () => {
    expect(parseCommand("tab graph")).toEqual({ type: "tab", tab: "graph" });
    const s = makeStore(graphSnap());
    const state = s.dispatch({ type: "tab", tab: "graph" });
    expect(state.viewTab).toBe("graph");
    expect(state.lastError).toBeNull();
  });

  it("the DEFAULT graph style is braille (Phase-2 decision rule executed: clean-box solved) with hatchet one command away", () => {
    const s = makeStore(graphSnap());
    expect(s.get().graphStyle).toBe("braille");
    expect(s.dispatch(parseCommand("style hatchet")).graphStyle).toBe("hatchet");
  });

  it("`style braille` rides the command bar; unknown styles are named errors", () => {
    expect(parseCommand("style braille")).toEqual({ type: "style", name: "braille" });
    const s = makeStore(graphSnap());
    expect(s.dispatch({ type: "style", name: "braille" }).graphStyle).toBe("braille");
    expect(s.dispatch({ type: "style", name: "hatchet" }).graphStyle).toBe("hatchet");
    const err = s.dispatch(parseCommand("style cubist"));
    expect(err.lastError).toMatch(/unknown style/);
    expect(err.graphStyle).toBe("hatchet"); // unchanged on error
  });

  it("the graph tab renders in the topology tab bar and is click-reachable", () => {
    const s = makeStore(graphSnap());
    const screen = renderScreen(s.get(), graphSnap(), { cols: 150, rows: 40 });
    expect(screen.lines.join("\n")).toContain("GRAPH");
    const tabTarget = screen.hitMap.find((t) => t.action.type === "tab" && t.action.tab === "graph");
    expect(tabTarget).toBeDefined();
  });
});

describe("hatchet mainline in the SHIPPED content pane (frame-01 visual contract)", () => {
  function graphScreen(style?: string) {
    const snap = graphSnap();
    const s = makeStore(snap);
    if (style) s.dispatch({ type: "style", name: style });
    s.dispatch({ type: "tab", tab: "graph" });
    return { s, snap, screen: renderScreen(s.get(), snap, { cols: 150, rows: 40 }) };
  }

  it("renders boxed nodes with info-in-node over the rig's graph projection", () => {
    const { screen } = graphScreen();
    const body = screen.lines.join("\n");
    expect(body).toMatch(/┌─+┐/);
    expect(body).toContain("● orch.lead");
    expect(body).toContain("claude-code · 18% · orch");
    expect(body).toMatch(/─+▸/); // straight connector + arrowhead
    expect(body).not.toMatch(/delegates_to|collaborates_with|escalates_to/); // NO edge labels
  });

  it("honest-unknown ○ renders in the shipped graph view (never a fabricated ●)", () => {
    const { screen } = graphScreen();
    expect(screen.lines.join("\n")).toContain("○ review.r1");
    expect(screen.lines.join("\n")).toContain("✕ review.validator");
    expect(screen.lines.join("\n")).toMatch(/◐ dev\.qa/);
  });

  it("braille style renders sub-cell edges; braille-fallback degrades to box-drawing", () => {
    const braille = graphScreen("braille").screen.lines.join("\n");
    expect(braille).toMatch(/[⠁-⣿]/);
    const fallback = graphScreen("braille-fallback").screen.lines.join("\n");
    expect(fallback).not.toMatch(/[⠁-⣿]/);
    expect(fallback).toMatch(/─+▸/);
  });

  it("a rig without a hydrated graph renders honest-empty, never fabricated boxes", () => {
    const snap = graphSnap();
    delete (snap.hosts[0]!.rigs[0]! as { graph?: unknown }).graph;
    const s = makeStore(snap);
    s.dispatch({ type: "tab", tab: "graph" });
    const body = renderScreen(s.get(), snap, { cols: 150, rows: 40 }).lines.join("\n");
    expect(body).toMatch(/graph read pending|honest-empty/);
    expect(body).not.toMatch(/┌─+┐/);
  });

  it("edge kinds paint by line COLOR through the shipped stylize (strip-invariant intact)", () => {
    const { screen } = graphScreen();
    const styled = stylizeLines(screen, createStyle("truecolor"));
    const joined = styled.join("\n");
    expect(joined).toMatch(/\x1b\[38;2;77;189;178m[^\x1b]*─/); // teal delegates run
    expect(joined).toMatch(/\x1b\[38;2;230;181;110m[^\x1b]*[─│┘└▴]/); // amber escalate run
    styled.forEach((line, i) => expect(stripAnsi(line), `line ${i}`).toBe(screen.lines[i]));
  });
});

describe("PIN-1 on the SHIPPED path — click === keyboard, one store, one reducer", () => {
  it("clicking an agent node box drills to that agent; the command path lands the IDENTICAL state and screen", () => {
    const snap = graphSnap();
    const s1 = makeStore(snap);
    s1.dispatch({ type: "tab", tab: "graph" });
    const screen = renderScreen(s1.get(), snap, { cols: 150, rows: 40 });
    const target = screen.contentTargets.find(
      (t) => t.action.type === "drill" && t.action.resource === "agent" && t.action.name === "dev.qa",
    );
    expect(target, "hit target for dev.qa in the shipped hit-map").toBeDefined();
    const clicked = s1.dispatch(target!.action);
    expect(clicked.drill).toEqual([
      { kind: "host", name: "vm-host" },
      { kind: "rig", name: FIXTURE_RIG_NAME },
      { kind: "pod", name: "dev" },
      { kind: "agent", name: "dev.qa" },
    ]);

    const s2 = makeStore(snap);
    s2.dispatch({ type: "tab", tab: "graph" });
    const byCommand = s2.dispatch(parseCommand("agent vm-host/openrig-build/dev/dev.qa"));
    expect(byCommand.drill).toEqual(clicked.drill);
    // byte-identical rendered screens — parity on the SHIPPED renderer
    const a = renderScreen(clicked, snap, { cols: 150, rows: 40 }).lines;
    const b = renderScreen(byCommand, snap, { cols: 150, rows: 40 }).lines;
    expect(a).toEqual(b);
  });
});

describe("hydrate consumes the DECLARED /graph read (R7 — no new data)", () => {
  it("populates RigNode.graph from client.rigGraph; a failed graph read is a NAMED error, honest-empty view", async () => {
    const graph = spikeFixtureGraph();
    const routes: Record<string, unknown> = {
      "/api/rigs/summary": [{ id: "r1", name: "openrig-build" }],
      "/api/rigs/r1/nodes": [],
      "/api/rigs/r1/graph": graph,
      "/api/rigs/r1/spec.json": {},
      "/api/specs/library": [],
      "/api/review/fleet": { needsYou: { items: [] }, hosts: [] },
      "/api/stream/list?limit=5": [],
    };
    const client = new DaemonClient({
      fetchImpl: (async (url: string) => {
        const route = url.replace(/^http[^/]*\/\/[^/]+/, "");
        for (const [k, v] of Object.entries(routes)) if (route.startsWith(k.split("?")[0]!)) return { ok: true, json: async () => v };
        return { ok: false, status: 404, json: async () => ({}) };
      }) as unknown as typeof fetch,
    });
    const snap = await hydrateSnapshot(client);
    expect(snap.hosts[0]!.rigs[0]!.graph?.nodes.length).toBe(graph.nodes.length);

    delete routes["/api/rigs/r1/graph"];
    const snap2 = await hydrateSnapshot(client);
    expect(snap2.hosts[0]!.rigs[0]!.graph).toBeUndefined();
    expect(snap2.readErrors.join("\n")).toMatch(/graph/);
  });
});

describe("fixture gating (the --demo rule)", () => {
  it("no live module imports the fixture — only tests and spike tooling reach it", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = join(__dirname, "..", "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.endsWith("fixture.ts") && readFileSync(p, "utf-8").match(/from "\.[./]*\/?(topology\/)?fixture\.js"/))
          offenders.push(p);
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});

describe("box opacity is a CLASS invariant, not a draw-order artifact (pm kickback, planner-refined)", () => {
  // three ranks on ONE row: a → b → c by delegation; a-collaborates-c gives a
  // straight same-row corridor that must CROSS b's box — the box renders
  // byte-clean in BOTH styles (the braille regression pm falsified was
  // order-dependent: hatchet edges-first masked it, braille boxes-first bled)
  function crossingGraph() {
    const node = (id: string, name: string) => ({
      id,
      type: "rigNode",
      parentId: "pod-X",
      data: {
        logicalId: name, podNamespace: "p", runtime: "codex", model: null,
        status: "running", nodeKind: "agent" as const, startupStatus: "ready" as const,
        contextUsedPercentage: 10, agentActivity: { state: "running" }, terminalActive: true,
        canonicalSessionName: `${name}@r`,
      },
    });
    return {
      nodes: [
        { id: "pod-X", type: "podGroup", data: { logicalId: "p", podNamespace: "p", runtime: null, model: null, status: null, nodeKind: "agent" as const, startupStatus: null, contextUsedPercentage: null } },
        node("nA", "aa.left"), node("nB", "bb.mid"), node("nC", "cc.right"),
      ],
      edges: [
        { id: "e1", source: "nA", target: "nB", label: "delegates_to" },
        { id: "e2", source: "nB", target: "nC", label: "delegates_to" },
        { id: "e3", source: "nA", target: "nC", label: "collaborates_with" },
      ],
    };
  }

  it("an edge corridor crossing an intermediate box never paints inside it — hatchet AND braille", async () => {
    const { renderGraphStyle } = await import("../src/topology/render-graph.js");
    for (const style of ["hatchet", "braille", "braille-fallback"] as const) {
      const plain = renderGraphStyle(style, crossingGraph(), { host: "h", rig: "r", selected: null }, 140).plainLines();
      const nameIdx = plain.findIndex((l) => l.includes("bb.mid"));
      expect(nameIdx, `${style}: bb.mid renders`).toBeGreaterThanOrEqual(0);
      const nameRow = plain[nameIdx]!;
      const metaRow = plain[nameIdx + 1]!; // box rows: border/name/meta/border
      // the box's OWN borders must be intact │ (a pierced border shows ┼)
      // and the interior between them must carry ONLY the box's content
      const nameInner = nameRow.match(/│([^│]*● bb\.mid[^│]*)│/);
      expect(nameInner, `${style}: name-row borders intact — got: ${nameRow}`).not.toBeNull();
      expect(nameInner![1]!, `${style}: name interior clean`).not.toMatch(/[─┼⠁-⣿]/);
      const metaInner = metaRow.match(/│([^│]*codex · 10% · p[^│]*)│/);
      expect(metaInner, `${style}: meta-row borders intact — got: ${metaRow}`).not.toBeNull();
      expect(metaInner![1]!, `${style}: meta interior clean`).not.toMatch(/[─┼⠁-⣿]/);
    }
  });
});
