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

  it("the DEFAULT graph style is HATCHET (founder flip 2026-08-04: font-dependence = brittleness) with braille one command away", () => {
    const s = makeStore(graphSnap());
    expect(s.get().graphStyle).toBe("hatchet");
    // both directions stay live: braille reachable, and back
    expect(s.dispatch(parseCommand("style braille")).graphStyle).toBe("braille");
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
    expect(body).toContain("● lead"); // member-only title (S19 MR1)
    expect(body).toContain(">< 18%"); // picks v4 (14afeb74): inward squinty eyes + adjacent ctx
    // straight connector runs + arrowhead; under the LOCKED containment an
    // edge may legitimately cross a pod-container wall (─ becomes ┼ at the
    // crossing) before its arrowhead
    expect(body).toMatch(/[─┼]+▸/);
    expect(body).not.toMatch(/delegates_to|collaborates_with|escalates_to/); // NO edge labels
  });

  it("honest-unknown ○ renders in the shipped graph view (never a fabricated ●)", () => {
    const { screen } = graphScreen();
    expect(screen.lines.join("\n")).toContain("○ r1"); // member-only (S19 MR1)
    expect(screen.lines.join("\n")).toContain("✕ validator");
    expect(screen.lines.join("\n")).toMatch(/◐ qa/);
  });

  it("braille style renders sub-cell edges; braille-fallback degrades to box-drawing", () => {
    const braille = graphScreen("braille").screen.lines.join("\n");
    expect(braille).toMatch(/[⠁-⣿]/);
    const fallback = graphScreen("braille-fallback").screen.lines.join("\n");
    expect(fallback).not.toMatch(/[⠁-⣿]/);
    expect(fallback).toMatch(/[─┼]+▸/);
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
    expect(joined).toMatch(/\x1b\[38;2;111;168;255m[^\x1b]*─/); // G2 blue delegates run
    expect(joined).toMatch(/\x1b\[38;2;244;190;92m[^\x1b]*[─│┘└▴]/); // G2 amber escalate run
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
      const metaInner = metaRow.match(/│([^│]*>_ 10%[^│]*)│/); // S19 MR2 mark meta form
      expect(metaInner, `${style}: meta-row borders intact — got: ${metaRow}`).not.toBeNull();
      expect(metaInner![1]!, `${style}: meta interior clean`).not.toMatch(/[─┼⠁-⣿]/);
    }
  });
});

describe("Phase-3 live-glyph honesty (the states the fleet GENUINELY serves)", () => {
  it("a detached seat (status 'detached', no startupStatus) renders ○ — the live-observed shape, never a fabricated ●", async () => {
    const { statusGlyph } = await import("../src/topology/glyphs.js");
    const detached = statusGlyph({
      logicalId: "dev.impl", podNamespace: "dev", runtime: "claude-code", model: null,
      status: "detached", nodeKind: "agent", startupStatus: null, contextUsedPercentage: null,
      agentActivity: null, terminalActive: null,
    });
    expect(detached.glyph).toBe("○");
    expect(detached.token).toBe("actDetached"); // S19 MR3 role (glyph honesty unchanged)
    // and the ● bucket is EXCLUSIVE to ready+running — nothing else qualifies
    for (const status of [null, "detached", "stopped", "pending"]) {
      const g = statusGlyph({
        logicalId: "x", podNamespace: "p", runtime: "codex", model: null,
        status, nodeKind: "agent", startupStatus: status === "stopped" ? null : null, contextUsedPercentage: null,
      });
      expect(g.glyph, `status=${status}`).not.toBe("●");
    }
  });
});

describe("R2 HIGH-3 — keyboard content focus stays VISIBLE under truecolor (segs path)", () => {
  it("the › marker survives seg stylization: visible in the styled row, strip-invariant intact, action unchanged", () => {
    const snap = graphSnap();
    const s = makeStore(snap);
    s.dispatch({ type: "style", name: "hatchet" });
    s.dispatch({ type: "tab", tab: "graph" });
    let screen = renderScreen(s.get(), snap, { cols: 150, rows: 40 });
    s.dispatch({ type: "layout", contentMaxOffset: screen.contentMaxOffset, contentTargetCount: screen.contentTargets.length });
    s.dispatch({ type: "focus", pane: "content" });
    // pick a node-box zone that does NOT start at content col 0 (the splice path)
    const zoneIdx = screen.contentTargets.findIndex(
      (t) => t.action.type === "drill" && t.action.resource === "agent" && t.x1 > 33,
    );
    expect(zoneIdx).toBeGreaterThanOrEqual(0);
    const zoneAction = screen.contentTargets[zoneIdx]!.action;
    s.dispatch({ type: "content-select", index: zoneIdx });
    screen = renderScreen(s.get(), snap, { cols: 150, rows: 40 });
    const rowIdx = screen.lines.findIndex((l, i) => i > 1 && l.slice(31).includes("›"));
    expect(rowIdx, "plain screen carries the marker").toBeGreaterThan(0);
    const styled = stylizeLines(screen, createStyle("truecolor"));
    // VISIBLE: the styled row still contains the marker glyph
    expect(styled[rowIdx]!, "marker visible after truecolor stylization").toContain("›");
    // TRUTHFUL: the strip-invariant holds on the marker row too
    expect(stripAnsi(styled[rowIdx]!)).toBe(screen.lines[rowIdx]!);
    // PIN-1: Enter would dispatch the SAME action the click zone carries
    expect(screen.contentTargets[zoneIdx]!.action).toEqual(zoneAction);
  });
});

describe("MR8 — width-clip honesty indicator (founder GO; indicator ONLY)", () => {
  it("a graph wider than the viewport renders the visible clipped-content indicator at the right edge", async () => {
    const { renderGraphStyle } = await import("../src/topology/render-graph.js");
    // 40 cols cannot hold the fixture's three ranked columns
    const plain = renderGraphStyle("hatchet", spikeFixtureGraph(), { host: "h", rig: "r", selected: null }, 40).plainLines().join("\n");
    expect(plain).toMatch(/content clipped ▸/);
  });

  it("a graph that fits renders WITHOUT the indicator (no false alarm)", async () => {
    const { renderGraphStyle } = await import("../src/topology/render-graph.js");
    const plain = renderGraphStyle("hatchet", spikeFixtureGraph(), { host: "h", rig: "r", selected: null }, 200).plainLines().join("\n");
    expect(plain).not.toMatch(/content clipped/);
  });
});

describe("R2 HIGH-1 — the locked agent-in-pod-in-rig containment is VISIBLE", () => {
  function containScreen() {
    const snap = graphSnap();
    const s = makeStore(snap);
    s.dispatch({ type: "tab", tab: "graph" });
    return { s, snap, screen: renderScreen(s.get(), snap, { cols: 160, rows: 44 }) };
  }

  it("pod containers wrap their member agent boxes and the rig container wraps all (nesting fingerprint on every agent row)", () => {
    const { screen } = containScreen();
    const body = screen.lines.join("\n");
    expect(body).toMatch(/▦ RIG openrig-build/); // rig container tab (round-3 glyph)
    for (const pod of ["orch", "dev", "review"]) expect(body, `pod ${pod} header`).toMatch(new RegExp(`≡ ${pod}`)); // round-3 pod glyph
    // the fingerprint: rig double-border ║, then a pod border │, then the
    // agent's OWN box border │ — three nested walls left of every agent glyph
    // S19 MR1: titles are member-only — the fingerprint (three nested walls
    // before glyph+member) is unchanged in intent
    for (const agent of ["lead", "driver", "qa", "r1"]) {
      expect(body, `agent ${agent} nested`).toMatch(new RegExp(`║[^║╗\\n]*│[^│\\n]*│ [●◐○✕] ${agent}`));
    }
  });

  it("nested hit zones DISCRIMINATE: rig tab → rig drill, pod header → pod drill, agent cell → agent drill", () => {
    const { s, screen } = containScreen();
    const podZone = screen.contentTargets.find((t) => t.action.type === "drill" && t.action.resource === "pod" && t.action.name === "dev");
    expect(podZone, "pod-header hit zone").toBeDefined();
    const agentZone = screen.contentTargets.find((t) => t.action.type === "drill" && t.action.resource === "agent" && t.action.name === "dev.qa");
    expect(agentZone, "agent-cell hit zone").toBeDefined();
    const podState = s.dispatch(podZone!.action);
    expect(podState.drill.at(-1)).toEqual({ kind: "pod", name: "dev" });
    s.dispatch({ type: "tab", tab: "graph" });
    const agentState = s.dispatch(agentZone!.action);
    expect(agentState.drill.at(-1)).toEqual({ kind: "agent", name: "dev.qa" });
  });

  it("keyboard navigation reaches the SAME nested targets (content-select indices exist for pod AND agent zones)", () => {
    const { screen } = containScreen();
    const podIdx = screen.contentTargets.findIndex((t) => t.action.type === "drill" && t.action.resource === "pod" && t.action.name === "dev");
    const agentIdx = screen.contentTargets.findIndex((t) => t.action.type === "drill" && t.action.resource === "agent" && t.action.name === "dev.qa");
    expect(podIdx).toBeGreaterThanOrEqual(0);
    expect(agentIdx).toBeGreaterThanOrEqual(0);
    // Enter on the selected index dispatches EXACTLY the zone's action — the
    // same object the mouse path uses (PIN-1, keyboard leg)
    expect(screen.contentTargets[podIdx]!.action).toEqual({ type: "drill", resource: "pod", name: "dev", target: { host: "vm-host", rig: FIXTURE_RIG_NAME } });
  });
});

describe("R2 c47219f1 — offscreen nodes are neither keyboard-selectable nor actionable", () => {
  function screenAt(cols: number) {
    const snap = graphSnap();
    const s = makeStore(snap);
    s.dispatch({ type: "tab", tab: "graph" });
    const screen = renderScreen(s.get(), snap, { cols, rows: 34 });
    return { s, snap, screen };
  }

  it("every content target's hit region intersects the VISIBLE pane at 140x34 AND 80x34 (zones derive from the clipped truth)", () => {
    for (const cols of [140, 80]) {
      const { screen } = screenAt(cols);
      for (const t of screen.contentTargets) {
        expect(t.x1, `cols=${cols}: target ${JSON.stringify(t.action)} starts on-screen`).toBeLessThanOrEqual(cols);
      }
    }
  });

  it("keyboard walking the FULL target list always shows a visible marker whose Enter action matches (plain + truecolor)", () => {
    for (const cols of [140, 80]) {
      const { s, snap, screen } = screenAt(cols);
      s.dispatch({ type: "layout", contentMaxOffset: screen.contentMaxOffset, contentTargetCount: screen.contentTargets.length });
      s.dispatch({ type: "focus", pane: "content" });
      // walk to the LAST selectable target — the class R2 hit (12×Down at 140)
      const last = screen.contentTargets.length - 1;
      s.dispatch({ type: "content-select", index: last });
      const sel = renderScreen(s.get(), snap, { cols, rows: 34 });
      const markerRow = sel.lines.findIndex((l, i) => i > 1 && l.slice(31).includes("›"));
      expect(markerRow, `cols=${cols}: a visible marker exists for the last selectable target`).toBeGreaterThan(0);
      const styled = stylizeLines(sel, createStyle("truecolor"));
      expect(styled[markerRow]!, `cols=${cols}: marker visible in truecolor`).toContain("›");
      expect(stripAnsi(styled[markerRow]!)).toBe(sel.lines[markerRow]!);
      // Enter dispatches a real, visible-target action
      expect(sel.contentTargets[Math.min(last, sel.contentTargets.length - 1)]!.action).toBeDefined();
    }
  });

  it("selection normalizes honestly when a narrower re-render shrinks the target list (resize class)", () => {
    const { s, snap, screen } = screenAt(150);
    s.dispatch({ type: "layout", contentMaxOffset: screen.contentMaxOffset, contentTargetCount: screen.contentTargets.length });
    s.dispatch({ type: "focus", pane: "content" });
    s.dispatch({ type: "content-select", index: screen.contentTargets.length - 1 });
    // resize narrower: fewer targets — the layout action clamps the selection
    const narrow = renderScreen(s.get(), snap, { cols: 80, rows: 34 });
    const after = s.dispatch({ type: "layout", contentMaxOffset: narrow.contentMaxOffset, contentTargetCount: narrow.contentTargets.length });
    expect(after.contentSelection).toBeLessThan(Math.max(narrow.contentTargets.length, 1));
  });
});

describe("PER-VIEW eligibility (PM concurrence on b7f95c4b): visibility truth re-evaluates per view", () => {
  it("an agent fully clipped at rig level becomes eligible when its pod is drilled, and ineligible again at rig level", () => {
    const snap = graphSnap();
    const s = makeStore(snap);
    s.dispatch({ type: "tab", tab: "graph" });
    // S19 density shrank the cards, so the old 80-col premise no longer
    // clips anything — 56 cols (24-col content pane) restores a genuinely
    // fully-clipped last pod for this eligibility pin
    const rigLevel = renderScreen(s.get(), snap, { cols: 56, rows: 34 });
    const atRig = rigLevel.contentTargets.some((t) => t.action.type === "drill" && t.action.resource === "agent" && t.action.name === "dev.qa");
    expect(atRig, "dev.qa ineligible while fully clipped at rig level").toBe(false);
    // drill the dev pod → the pod-scoped view fits → dev.qa is visible AND eligible
    s.dispatch({ type: "drill", resource: "pod", name: "dev", target: { host: "vm-host", rig: FIXTURE_RIG_NAME } });
    s.dispatch({ type: "tab", tab: "graph" });
    const podLevel = renderScreen(s.get(), snap, { cols: 80, rows: 34 });
    expect(podLevel.lines.join("\n")).toContain("◐ qa"); // visible pixels (member-only, S19 MR1)
    const atPod = podLevel.contentTargets.some((t) => t.action.type === "drill" && t.action.resource === "agent" && t.action.name === "dev.qa");
    expect(atPod, "dev.qa eligible in the drilled view (same visible-truth rule, per view)").toBe(true);
  });
});

describe("S19 MR1 — kill the triple name (§A1)", () => {
  it("each graph card names its pod ONCE: node titles are MEMBER-only, no pod token in card meta", () => {
    const snap = graphSnap();
    const s = makeStore(snap);
    s.dispatch({ type: "tab", tab: "graph" });
    const body = renderScreen(s.get(), snap, { cols: 160, rows: 44 }).lines.join("\n");
    // pod named once — the container tab
    expect(body).toMatch(/≡ dev/);
    // titles are member-only: the qa card reads "◐ qa", never "◐ dev.qa"
    expect(body).toMatch(/[◐] qa/);
    expect(body).not.toMatch(/[◐] dev\.qa/);
    expect(body).toMatch(/● driver/);
    expect(body).not.toMatch(/● dev\.driver/);
    // meta drops the pod suffix: no "· dev" tail inside a card meta row
    expect(body).not.toMatch(/· dev │/);
    expect(body).not.toMatch(/· orch │/);
    // non-pod-prefixed names display unchanged (honest fallback mirrors the
    // navigator's confirmed-prefix rule)
  });
});

describe("S19 MR3 — activity design language (role-level, palette-value-agnostic)", () => {
  it("active / idle / detached / attention map to FOUR DISTINCT color roles; glyph honesty unchanged", async () => {
    const { statusGlyph } = await import("../src/topology/glyphs.js");
    const base = { logicalId: "x", podNamespace: "p", runtime: "codex", model: null, nodeKind: "agent" as const, contextUsedPercentage: null };
    const active = statusGlyph({ ...base, status: "running", startupStatus: "ready", agentActivity: { state: "running" } });
    const idle = statusGlyph({ ...base, status: "running", startupStatus: "ready", agentActivity: { state: "idle" } });
    const detached = statusGlyph({ ...base, status: "detached", startupStatus: null, agentActivity: null });
    const attention = statusGlyph({ ...base, status: "running", startupStatus: "attention_required", agentActivity: null });
    // glyphs stay the honest 4-vocab
    expect(active.glyph).toBe("●");
    expect(idle.glyph).toBe("●");
    expect(detached.glyph).toBe("○");
    expect(attention.glyph).toBe("◐");
    // roles are DISTINCT (values = founder pick later; roles are the contract)
    const roles = [active.token, idle.token, detached.token, attention.token];
    expect(new Set(roles).size).toBe(4);
    // honest-unknown unchanged: no session/no activity → ○, never ●
    const unknown = statusGlyph({ ...base, status: null, startupStatus: null });
    expect(unknown.glyph).toBe("○");
  });
});

describe("S19 MR4 — detail pane shows the full absolute working directory", () => {
  it("an agent with a served cwd renders it verbatim; absent cwd renders honest —", () => {
    const snap = graphSnap();
    (snap.hosts[0]!.rigs[0]!.pods[1]!.agents[0]! as { cwd?: string | null }).cwd = "/Users/admin/code/openrig-build-source";
    const s = makeStore(snap);
    s.dispatch({ type: "drill", resource: "agent", name: "dev.driver", target: { host: "vm-host", rig: FIXTURE_RIG_NAME, pod: "dev" } });
    const body = renderScreen(s.get(), snap, { cols: 150, rows: 40 }).lines.join("\n");
    expect(body).toContain("/Users/admin/code/openrig-build-source"); // full absolute path, verbatim
    const s2 = makeStore(graphSnap());
    s2.dispatch({ type: "drill", resource: "agent", name: "dev.qa", target: { host: "vm-host", rig: FIXTURE_RIG_NAME, pod: "dev" } });
    const body2 = renderScreen(s2.get(), graphSnap(), { cols: 150, rows: 40 }).lines.join("\n");
    expect(body2).toContain("— (not served)"); // the literal honest absent value (guard strengthening)
  });
});

describe("S19 MR5 — chrome: blinking cursor + guide contrast", () => {
  it("the command bar's blinking insertion cell is visible for EMPTY and non-empty input (guard MR5a: pre-typing discoverability)", () => {
    const snap = graphSnap();
    const s = makeStore(snap);
    // EMPTY buffer: the cursor shows the bar is ready BEFORE the first key
    const empty = renderScreen(s.get(), snap, { cols: 120, rows: 30 }, "");
    expect(empty.lines[0]).toContain("cmd ▸ ▊");
    const styledE = stylizeLines(empty, createStyle("truecolor"));
    expect(styledE[0]!, "blink on the empty-buffer insertion cell").toMatch(/\x1b\[[0-9;]*5;?[0-9;]*m▊/);
    styledE.forEach((l, i) => expect(stripAnsi(l)).toBe(empty.lines[i]));
    // NON-EMPTY: the cursor rides the end of the text
    const composing = renderScreen(s.get(), snap, { cols: 120, rows: 30 }, "rig ope");
    expect(composing.lines[0]).toContain("rig ope▊");
    const styledC = stylizeLines(composing, createStyle("truecolor"));
    expect(styledC[0]!, "SGR blink (5) on the cursor cell").toMatch(/\x1b\[[0-9;]*5;?[0-9;]*m▊/);
    styledC.forEach((l, i) => expect(stripAnsi(l)).toBe(composing.lines[i]));
  });

  it("tree guides paint the BUMPED chrome contrast (one step up; text-only-highlight pin is the regression guard)", () => {
    const s = makeStore(graphSnap());
    const screen = renderScreen(s.get(), graphSnap(), { cols: 120, rows: 30 });
    const styled = stylizeLines(screen, createStyle("truecolor"));
    const guideLine = styled.find((l) => stripAnsi(l).includes("┣━"))!;
    expect(guideLine).toMatch(/38;2;78;105;145m[^m]*┣━/); // G2 restrained indigo frame
    expect(guideLine).not.toMatch(/38;2;58;63;75m[^m]*┣━/); // not the old faint value
  });
});

describe("ROUND-3 LOCKED SET (orch locked-scope GO; pins 02259adb/29a10b62)", () => {
  it("runtime marks are OFF explorer rows: agent meta is ctx% only; marks live on detail + topology cards", () => {
    const snap = graphSnap();
    const s = makeStore(snap);
    s.dispatch({ type: "drill", resource: "pod", name: "dev", target: { host: "vm-host", rig: FIXTURE_RIG_NAME } });
    const explorer = renderScreen(s.get(), snap, { cols: 150, rows: 40 });
    const pane = explorer.lines.map((l) => l.slice(0, explorer.explorerWidth)).join("\n");
    expect(pane).not.toMatch(/▐▌|>_|▝▘|▘▝|></); // no marks in the explorer (quadrant orders AND the picks-v4 eyes)
    expect(pane).toMatch(/driver\s+24%/); // name-first untruncated + bare ctx%
    // cards still carry the mark
    s.dispatch({ type: "tab", tab: "graph" });
    const body = renderScreen(s.get(), snap, { cols: 150, rows: 40 }).lines.join("\n");
    expect(body).toMatch(/>< 24%|>< 63%/); // picks-v4 clawd mark in card meta
    // detail page shows the mark as the runtime field — spelled runtime is dead
    s.dispatch({ type: "drill", resource: "agent", name: "dev.driver", target: { host: "vm-host", rig: FIXTURE_RIG_NAME, pod: "dev" } });
    const detail = renderScreen(s.get(), snap, { cols: 150, rows: 40 }).lines.join("\n");
    // a4c9548a (S19 follow-on founder ruling, bounds the marks ruling): on the detail
    // page there is room, so the runtime NAME is the VALUE; the mark only accompanies
    // decoratively, never substitutes. (Supersedes the earlier "the mark IS the value /
    // spelled runtime is dead" pin — topology cards above stay mark-only, bounded not reversed.)
    expect(detail).toMatch(/runtime:\s+claude-code/); // the NAME is the runtime value
    expect(detail).toMatch(/claude-code\s+></); // the clawd mark still accompanies decoratively
  });

  it("the clawd eyes are the picks-v4 INWARD SQUINTY pair `><` (founder amendment 14afeb74, supersedes the round-4 quadrant geometry)", async () => {
    const { clawdSquareMark, runtimeMarkSegs, markText } = await import("../src/topology/runtime-marks.js");
    const sq = clawdSquareMark();
    expect(sq).toHaveLength(2); // 2-cell form: literally the characters >< per the amendment
    expect(sq[0]!.text).toBe(">"); // left eye points INWARD
    expect(sq[1]!.text).toBe("<"); // right eye points INWARD — reads as a FACE
    expect(markText(sq)).toBe("><");
    expect(sq.every((g) => g.token === "clawdEye" && g.bg === "clawd")).toBe(true); // dark eyes ON the terracotta field (unchanged)
    expect(markText(runtimeMarkSegs("claude-code"))).toBe("><"); // shipped claude mark = the refined face
  });

  it("agent-detail runtime NAME is the value AND the mark keeps its OWN styling in compiled output (a4c9548a + guard round-4 finding 2)", () => {
    const node = (id: string, name: string, runtime: string) => ({
      id, type: "rigNode", parentId: "pod-D",
      data: { logicalId: name, podNamespace: "d", runtime, model: null, status: "running",
        nodeKind: "agent" as const, startupStatus: "ready" as const, contextUsedPercentage: 10,
        agentActivity: { state: "running" }, terminalActive: true, canonicalSessionName: `${name}@r` },
    });
    const graph = {
      nodes: [
        { id: "pod-D", type: "podGroup", data: { logicalId: "d", podNamespace: "d", runtime: null, model: null, status: null, nodeKind: "agent" as const, startupStatus: null, contextUsedPercentage: null } },
        node("n1", "d.cl", "claude-code"), node("n2", "d.tty", "terminal"), node("n3", "d.cx", "codex"),
      ],
      edges: [],
    };
    const trioSnap = {
      ...graphSnap(),
      hosts: [{ name: "h", reachable: true, rigs: [{ name: "r", pods: [{ name: "d", agents: [
        { name: "d.cl", runtime: "claude-code", spec: "", context: 10, tokens: null, status: "active", live: true },
        { name: "d.tty", runtime: "terminal", spec: "", context: 10, tokens: null, status: "active", live: true },
        { name: "d.cx", runtime: "codex", spec: "", context: 10, tokens: null, status: "active", live: true },
      ] }], graph }] }],
    };
    const drillDetail = (agent: string) => {
      const s = makeStore(trioSnap);
      s.dispatch({ type: "drill", resource: "agent", name: agent, target: { host: "h", rig: "r", pod: "d" } });
      const screen = renderScreen(s.get(), trioSnap, { cols: 150, rows: 40 });
      const styled = stylizeLines(screen, createStyle("truecolor"));
      const idx = screen.lines.findIndex((l) => l.slice(31).includes("runtime:"));
      expect(idx, `runtime field row for ${agent}`).toBeGreaterThan(0);
      styled.forEach((l, j) => expect(stripAnsi(l), `${agent} line ${j}`).toBe(screen.lines[j]));
      return { plain: screen.lines[idx]!, styled: styled[idx]! };
    };
    // clawd: dark #181818 eyes ON the #ad6755 terracotta field, in compiled SGR
    const cl = drillDetail("d.cl");
    expect(cl.styled).toMatch(/38;2;24;24;24;48;2;173;103;85m[^\x1b]*>/);
    expect(cl.styled).toMatch(/38;2;24;24;24;48;2;173;103;85m[^\x1b]*</); // both inward eyes carry the eye-on-terracotta SGR
    expect(cl.plain).toMatch(/runtime:\s+claude-code/); // a4c9548a: the NAME is the value (the mark's SGR above proves it still accompanies decoratively)
    // terminal: the dark-cell background survives to the compiled detail line
    const tty = drillDetail("d.tty");
    expect(tty.styled).toMatch(/48;2;12;10;9m?[^\x1b]*>/);
    expect(tty.plain.slice(31)).toMatch(/runtime:\s+terminal/); // a4c9548a: the NAME is the value; the >_ mark still trails (SGR above)
    // codex: the NAME `codex` is the value (a4c9548a), with the picks-v4 CHEVRON-ONLY
    // blue hint accompanying — the `>` carries the OFFICIAL sampled #6867aa
    // (38;2;104;103;170) on detail; the `_` stays light ink; no ❯, no outline.
    const cx = drillDetail("d.cx");
    expect(cx.plain.slice(31)).toMatch(/runtime:\s+codex/); // a4c9548a: the NAME is the value
    expect(cx.styled).toMatch(/38;2;104;103;170m[^\x1b]*>/); // chevron pick (picks v4 item a) still accompanies
    expect(cx.plain).not.toMatch(/❯/); // no ❯ outline (the codex name renders as the value, not an icon substitute)
  });

  it("rig glyph is ▦ and pod glyph is ≡ (founder picks of record)", () => {
    const snap = graphSnap();
    const s = makeStore(snap);
    const pane = renderScreen(s.get(), snap, { cols: 150, rows: 40 }).lines.map((l) => l.slice(0, 30)).join("\n");
    expect(pane).toContain("▦ openrig-build"); // rig icon
    expect(pane).not.toMatch(/▚ /);
    s.dispatch({ type: "tab", tab: "graph" });
    const body = renderScreen(s.get(), snap, { cols: 150, rows: 40 }).lines.join("\n");
    expect(body).toMatch(/▦ RIG openrig-build/);
    expect(body).toMatch(/≡ dev/); // pod container tab carries the pod glyph
  });

  it("explorer icons are MONOCHROME (color is for status only)", () => {
    const snap = graphSnap();
    const s = makeStore(snap);
    const screen = renderScreen(s.get(), snap, { cols: 150, rows: 40 });
    const styled = stylizeLines(screen, createStyle("truecolor"));
    const rigLine = styled.find((l) => stripAnsi(l).includes("▦ openrig-build"))!;
    expect(rigLine).not.toMatch(/38;2;77;189;178m[^m]*▦/); // NOT the old accent teal
    expect(rigLine).toMatch(/38;2;109;116;128m[^m]*▦|38;2;76;84;99m[^m]*▦/); // dim/chrome monochrome
  });

  it("the official codex blue token is #6867aa and the three hint CANDIDATES exist unpicked", async () => {
    const { codexHintVariants } = await import("../src/topology/runtime-marks.js");
    const { createStyle: cs } = await import("../src/theme.js");
    const t = cs("truecolor");
    expect(t.paint("codexBlue", "x")).toContain("38;2;104;103;170"); // #6867aa exact
    const variants = codexHintVariants();
    expect(Object.keys(variants).sort()).toEqual(["chevron", "none", "outline"]); // candidates only — nothing picked
    const { runtimeMarkSegs, markText } = await import("../src/topology/runtime-marks.js");
    expect(markText(runtimeMarkSegs("codex"))).toBe(">_"); // the SHIPPED mark stays the approved plain form
  });
});
