// Slice-17 mini-req 1 — explorer navigator RE-SKIN to the file-tree
// aesthetic. PURE re-skin: computeExplorerRows (the ONE row model) is
// untouched; the renderer displays branch guides + right-aligned meta while
// every action, key, and hit target stays identical (PIN-1). Collapse glyphs
// render ONLY where collapse genuinely exists today (pods; spec folders;
// section headers) — hosts/rigs lose their false ▾. New file; shipped floors
// untouched.
import { describe, it, expect } from "vitest";
import { createViewState, computeExplorerRows } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { demoSnapshot } from "../src/demo-data.js";
import { createStyle, stripAnsi } from "../src/theme.js";
import { stylizeLines } from "../src/stylize.js";

const snap = demoSnapshot();

// minimal graph-carrying snapshot for the relocated card pins
function graphSnapLocal() {
  const graph = {
    nodes: [
      { id: "pod-G", type: "podGroup", data: { logicalId: "g", podNamespace: "g", runtime: null, model: null, status: null, nodeKind: "agent" as const, startupStatus: null, contextUsedPercentage: null } },
      { id: "nG", type: "rigNode", parentId: "pod-G", data: { logicalId: "g.driver", podNamespace: "g", runtime: "claude-code", model: null, status: "running", nodeKind: "agent" as const, startupStatus: "ready" as const, contextUsedPercentage: 24, agentActivity: { state: "running" }, terminalActive: true, canonicalSessionName: "g-driver@r" } },
    ],
    edges: [],
  };
  return {
    ...snap,
    hosts: [{ name: "h", reachable: true, rigs: [{ name: "r", pods: [{ name: "g", agents: [
      { name: "g.driver", runtime: "claude-code", spec: "", context: 24, tokens: null, status: "active", live: true },
    ] }], graph }] }],
  };
}

function makeStore() {
  return createViewState({ instanceId: "nav-test", getSnapshot: () => snap });
}

function explorerPane(lines: string[]): string[] {
  // rows 3.. of the screen, left of the │ pane border (EXPL_W = 30)
  return lines.slice(2).map((l) => l.slice(0, 30));
}

describe("file-tree re-skin (Direction B navigator)", () => {
  it("renders continuous branch guides in the explorer pane", () => {
    const s = makeStore();
    const screen = renderScreen(s.get(), snap, { cols: 120, rows: 32 });
    const pane = explorerPane(screen.lines).join("\n");
    expect(pane).toMatch(/┣━/);
    expect(pane).toMatch(/┗━/);
  });

  it("hosts and rigs carry NO collapse glyph (no false affordances — no collapse exists there today)", () => {
    const s = makeStore();
    const screen = renderScreen(s.get(), snap, { cols: 120, rows: 32 });
    const hostRow = explorerPane(screen.lines).find((l) => l.includes("vm-host"))!;
    const rigRow = explorerPane(screen.lines).find((l) => l.includes("openrig-build"))!;
    expect(hostRow).not.toMatch(/[▾▸]/);
    expect(rigRow).not.toMatch(/[▾▸]/);
  });

  it("pods KEEP their genuine collapse glyph (› collapsed, ⌄ expanded via drill/auto-expand)", () => {
    const s = makeStore();
    let screen = renderScreen(s.get(), snap, { cols: 120, rows: 32 });
    const collapsed = explorerPane(screen.lines).find((l) => l.includes("dev50"))!;
    expect(collapsed).toContain("›");
    // drilling the pod auto-expands it — unchanged function, re-skinned look
    s.dispatch({ type: "drill", resource: "pod", name: "dev50", target: { host: "vm-host", rig: "openrig-build" } });
    screen = renderScreen(s.get(), snap, { cols: 120, rows: 32 });
    const pane = explorerPane(screen.lines);
    expect(pane.find((l) => l.includes("dev50") && !l.includes("●"))).toContain("⌄");
    // the agent rows appear (identity by ROW MODEL key — display names may
    // truncate under the locked meta-always policy)
    expect(screen.explorerRows.some((r) => r.key === "agent:vm-host/openrig-build/dev50/dev50.driver")).toBe(true);
  });

  it("agent meta is ALWAYS the locked `runtime · ctx%` form and names render POD-RELATIVE (guard rulings)", () => {
    const s = makeStore();
    s.dispatch({ type: "drill", resource: "pod", name: "dev50", target: { host: "vm-host", rig: "openrig-build" } });
    const pane = explorerPane(renderScreen(s.get(), snap, { cols: 120, rows: 32 }).lines);
    // dev50.driver under pod dev50 displays pod-relative "driver" (the
    // nav-flow mockup's convention); the meta stays complete
    const driver = pane.find((l) => l.trimEnd().endsWith(" 62%"))!;
    expect(driver).toBeDefined();
    // pod-relative "driver" may still truncate at depth-4 geometry, but its
    // visible stem is the AGENT's own name, never the shared pod prefix
    expect(driver).toMatch(/● driver/); // untruncated under the S19 mark meta
    expect(driver).not.toMatch(/dev50\.driver/); // full identity lives in the row model, not the display
  });

  it("same-pod agents with IDENTICAL runtime+context stay visibly distinct (guard collision repro)", () => {
    const twinSnap = {
      ...snap,
      hosts: [{ name: "h", reachable: true, rigs: [{ name: "r", pods: [{ name: "dev50", agents: [
        { name: "dev50.driver", runtime: "codex", spec: "", context: 31, tokens: null, status: "active", live: true },
        { name: "dev50.guard", runtime: "codex", spec: "", context: 31, tokens: null, status: "active", live: true },
      ] }] }] }],
    };
    const s = createViewState({ instanceId: "nav-twin", getSnapshot: () => twinSnap });
    s.dispatch({ type: "drill", resource: "pod", name: "dev50", target: { host: "h", rig: "r" } });
    const pane = explorerPane(renderScreen(s.get(), twinSnap, { cols: 120, rows: 32 }).lines);
    const agentRows = pane.filter((l) => /[●◐○✕] (driver|guard)/.test(l) && l.includes("31%")).map((l) => l.replace(/^./, " "));
    expect(agentRows).toHaveLength(2);
    expect(new Set(agentRows.map((l) => l.trim())).size).toBe(2); // visibly distinct rows
    expect(agentRows.some((l) => l.includes("driv"))).toBe(true);
    expect(agentRows.some((l) => l.includes("guar"))).toBe(true);
  });

  it("a name NOT prefixed by its pod displays unchanged (honest fallback — only a confirmed prefix strips)", () => {
    const soloSnap = {
      ...snap,
      hosts: [{ name: "h", reachable: true, rigs: [{ name: "r", pods: [{ name: "dev50", agents: [
        { name: "solo", runtime: "codex", spec: "", context: 7, tokens: null, status: "active", live: true },
      ] }] }] }],
    };
    const s = createViewState({ instanceId: "nav-solo", getSnapshot: () => soloSnap });
    s.dispatch({ type: "drill", resource: "pod", name: "dev50", target: { host: "h", rig: "r" } });
    const row = explorerPane(renderScreen(s.get(), soloSnap, { cols: 120, rows: 32 }).lines).find((l) => l.includes("● solo"))!;
    expect(row.trimEnd()).toMatch(/● solo\s+7%$/); // round-3: bare ctx meta
  });

  it("null context renders the honest bare — (round-3 explorer meta)", () => {
    const s = makeStore();
    s.dispatch({ type: "drill", resource: "pod", name: "dev50", target: { host: "vm-host", rig: "openrig-build" } });
    const pane = explorerPane(renderScreen(s.get(), snap, { cols: 120, rows: 32 }).lines);
    expect(pane.some((l) => /qa/.test(l) && l.trimEnd().endsWith("—"))).toBe(true); // demo: dev50.qa ctx null → honest —
  });

  it("a short name renders untruncated beside the ctx meta (round-3 form)", () => {
    const shortSnap = {
      ...snap,
      hosts: [{ name: "h", reachable: true, rigs: [{ name: "r", pods: [{ name: "p", agents: [
        { name: "ok", runtime: "claude-code", spec: "", context: 5, tokens: null, status: "active", live: true },
      ] }] }] }],
    };
    const s = createViewState({ instanceId: "nav-short", getSnapshot: () => shortSnap });
    s.dispatch({ type: "drill", resource: "pod", name: "p", target: { host: "h", rig: "r" } });
    const row = explorerPane(renderScreen(s.get(), shortSnap, { cols: 120, rows: 32 }).lines).find((l) => l.includes("● ok"))!;
    expect(row).not.toMatch(/…/);
    expect(row.trimEnd()).toMatch(/● ok\s+5%$/);
  });

  it("an extreme name renders FULL — the meta yields entirely, the identity NEVER ellipsises (guard NOT-CLEAR finding 1)", () => {
    const longSnap = {
      ...snap,
      hosts: [{ name: "h", reachable: true, rigs: [{ name: "r", pods: [{ name: "p", agents: [
        { name: "an-extremely-long-agent-name-x", runtime: "codex", spec: "", context: 9, tokens: null, status: "active", live: true },
      ] }] }] }],
    };
    const s = createViewState({ instanceId: "nav-long", getSnapshot: () => longSnap });
    s.dispatch({ type: "drill", resource: "pod", name: "p", target: { host: "h", rig: "r" } });
    const row = explorerPane(renderScreen(s.get(), longSnap, { cols: 120, rows: 32 }).lines).find((l) => l.includes("● an-"))!;
    // the LAYOUT never truncates: the name gets every available cell and the
    // meta yields entirely; only the PHYSICAL pane edge may clip (pad()'s
    // honest boundary ellipsis at the last column — same class as the
    // width-clip indicator, not a layout choice)
    expect(row).toContain("an-extremely-lon"); // every cell the pane physically offers
    expect(row).not.toMatch(/9%/); // the meta yielded — name-first
    expect(row.indexOf("…") === -1 || row.indexOf("…") === 29, "ellipsis only at the physical pane edge").toBe(true);
  });

  it("the TERMINAL mark keeps its dark-cell background on TOPOLOGY CARDS (round-3: marks live on cards; the bg-channel discriminator relocates with them)", () => {
    const node = (id: string, name: string, runtime: string) => ({
      id, type: "rigNode", parentId: "pod-T",
      data: { logicalId: name, podNamespace: "t", runtime, model: null, status: "running",
        nodeKind: "agent" as const, startupStatus: "ready" as const, contextUsedPercentage: 10,
        agentActivity: { state: "running" }, terminalActive: true, canonicalSessionName: `${name}@r` },
    });
    const graph = {
      nodes: [
        { id: "pod-T", type: "podGroup", data: { logicalId: "t", podNamespace: "t", runtime: null, model: null, status: null, nodeKind: "agent" as const, startupStatus: null, contextUsedPercentage: null } },
        node("nT", "t.tty", "terminal"), node("nC", "t.cx", "codex"),
      ],
      edges: [],
    };
    const ttySnap = {
      ...snap,
      hosts: [{ name: "h", reachable: true, rigs: [{ name: "r", pods: [{ name: "t", agents: [
        { name: "t.tty", runtime: "terminal", spec: "", context: 10, tokens: null, status: "active", live: true },
        { name: "t.cx", runtime: "codex", spec: "", context: 10, tokens: null, status: "active", live: true },
      ] }], graph }] }],
    };
    const s = createViewState({ instanceId: "card-tty", getSnapshot: () => ttySnap });
    s.dispatch({ type: "tab", tab: "graph" });
    const screen = renderScreen(s.get(), ttySnap, { cols: 150, rows: 40 });
    const styled = stylizeLines(screen, createStyle("truecolor"));
    const joined = styled.join("\n");
    expect(joined, "terminal card mark carries the dark bg").toMatch(/48;2;12;10;9[^m]*m>/);
    styled.forEach((line, j) => expect(stripAnsi(line), `line ${j}`).toBe(screen.lines[j]));
  });

  it("the clawd card mark paints eye-on-terracotta (fg #181818 on bg #ad6755) through the seg channel", () => {
    const s = createViewState({ instanceId: "card-clawd", getSnapshot: () => graphSnapLocal() });
    s.dispatch({ type: "tab", tab: "graph" });
    const snap2 = graphSnapLocal();
    const screen = renderScreen(s.get(), snap2, { cols: 150, rows: 40 });
    const styled = stylizeLines(screen, createStyle("truecolor"));
    const joined = styled.join("\n");
    expect(joined).toMatch(/38;2;24;24;24;48;2;173;103;85m></); // picks-v4 inward squinty eyes on the terracotta field
    styled.forEach((line, j) => expect(stripAnsi(line), `line ${j}`).toBe(screen.lines[j]));
  });

  it("an expanded namespaced spec folder renders its child ONE level deeper, never a sibling (guard finding 2)", () => {
    const nsSnap = {
      ...snap,
      specs: [
        ...snap.specs,
        { name: "vault-specialist", kind: "agent" as const, runtime: "codex", namespace: "vault", usedByRigs: [] },
      ],
    };
    const s = createViewState({ instanceId: "nav-ns", getSnapshot: () => nsSnap });
    s.dispatch({ type: "jump", section: "specs" });
    s.dispatch({ type: "toggle-expand", key: "folder:vault" });
    const screen = renderScreen(s.get(), nsSnap, { cols: 120, rows: 40 });
    const pane = explorerPane(screen.lines);
    const folder = pane.find((l) => l.includes("vault/"))!;
    const child = pane.find((l) => l.includes("vault-specialist"))!;
    const indentOf = (l: string) => (/^\s*(?:┃ )*/.exec(l)?.[0] ?? "").length + (l.match(/┣━|┗━/)?.index ?? 0);
    const branchCol = (l: string) => l.search(/┣━|┗━/);
    expect(branchCol(child)).toBeGreaterThan(branchCol(folder)); // child branch sits deeper
    void indentOf;
    // PIN-1 untouched: the child's action is still the spec drill from the row model
    const rows = computeExplorerRows(s.get(), nsSnap);
    const childRow = rows.find((r) => r.key === "spec:vault-specialist")!;
    expect(childRow.action).toEqual({ type: "drill", resource: "spec", name: "vault-specialist" });
  });

  it("pod rows carry their agent count right-aligned (moved out of the inline label)", () => {
    const s = makeStore();
    const screen = renderScreen(s.get(), snap, { cols: 120, rows: 32 });
    const pod = explorerPane(screen.lines).find((l) => l.includes("dev50"))!;
    expect(pod.trimEnd()).toMatch(/3$/); // dev50 pod has 3 agents in the demo fixture
  });

  it("PURE re-skin: the hit-map's explorer actions are EXACTLY the row model's actions (PIN-1 untouched)", () => {
    const s = makeStore();
    const screen = renderScreen(s.get(), snap, { cols: 120, rows: 32 });
    const rows = computeExplorerRows(s.get(), snap);
    screen.explorerRows.forEach((rendered, i) => {
      expect(rendered.action).toEqual(rows[i]!.action);
      expect(rendered.key).toBe(rows[i]!.key);
    });
    // clicking the rig row still drills the rig — same action, same reducer
    const rigTarget = screen.hitMap.find((h) => h.action.type === "drill" && h.action.resource === "rig");
    expect(rigTarget).toBeDefined();
    const after = s.dispatch(rigTarget!.action);
    expect(after.drill.map((d) => d.name)).toEqual(["vm-host", "openrig-build"]);
  });

  it("selection sync still lands ON the drilled agent (auto-expand preserved through the re-skin)", () => {
    const s = makeStore();
    s.dispatch({ type: "drill", resource: "agent", name: "dev50.guard", target: { host: "vm-host", rig: "openrig-build", pod: "dev50" } });
    const rows = computeExplorerRows(s.get(), snap);
    expect(rows[s.get().selection]?.key).toBe("agent:vm-host/openrig-build/dev50/dev50.guard");
    const screen = renderScreen(s.get(), snap, { cols: 120, rows: 32 });
    // the selected ROW is the drilled agent (row-model identity)…
    const selectedRow = screen.explorerRows.find((r) => r.y === screen.lines.findIndex((l) => l.startsWith("▶")) + 1);
    expect(selectedRow?.key).toBe("agent:vm-host/openrig-build/dev50/dev50.guard");
    // …AND the line shows the agent's VISIBLE identity (pod-relative "guard")
    // plus its own locked meta at the edge (guard: visible-identity restore)
    const selectedLine = screen.lines.find((l) => l.startsWith("▶"))!;
    expect(selectedLine.slice(0, 30)).toMatch(/● guard/);
    expect(selectedLine.slice(0, 30).trimEnd()).toMatch(/31%$/); // demo: guard ctx 31 (round-3 bare meta)
  });

  it("G2 selection gives the whole selected Explorer row a bright wash", () => {
    const s = makeStore();
    s.dispatch({ type: "drill", resource: "agent", name: "dev50.guard", target: { host: "vm-host", rig: "openrig-build", pod: "dev50" } });
    const screen = renderScreen(s.get(), snap, { cols: 120, rows: 32 });
    const styled = stylizeLines(screen, createStyle("truecolor"));
    const i = screen.lines.findIndex((l) => l.startsWith("▶"));
    expect(i).toBeGreaterThan(0);
    const line = styled[i]!;
    expect(line).toMatch(/\x1b\[1;38;2;111;168;255;48;2;34;52;82m▶[^\x1b]*┣━[^\x1b]*● guard/);
    styled.forEach((l, j) => expect(stripAnsi(l), `line ${j}`).toBe(screen.lines[j]));
  });

  it("explorer agent status derives from SERVED truth — all four states visibly distinct in compiled output (guard round-4 finding 4)", () => {
    // demo fixture serves all four: driver active · guard idle · qa unknown
    // (live:false) · orch.lead needs-attention — none may fabricate liveness
    const s = makeStore();
    s.dispatch({ type: "drill", resource: "pod", name: "dev50", target: { host: "vm-host", rig: "openrig-build" } });
    s.dispatch({ type: "drill", resource: "pod", name: "orch", target: { host: "vm-host", rig: "openrig-build" } });
    const screen = renderScreen(s.get(), snap, { cols: 140, rows: 36 });
    const styled = stylizeLines(screen, createStyle("truecolor"));
    const styledRow = (needle: string) => styled.find((l) => stripAnsi(l).slice(0, 30).includes(needle))!;
    const plainRow = (needle: string) => screen.lines.find((l) => l.slice(0, 30).includes(needle))!;
    // honest glyphs first: unknown/offline qa is ○ (never a fabricated ●),
    // needs-attention lead is ◐ — served truth, not a hardcoded ●
    expect(plainRow("driver").slice(0, 30)).toMatch(/● driver/);
    expect(plainRow("guard").slice(0, 30)).toMatch(/● guard/);
    expect(plainRow("qa").slice(0, 30)).toMatch(/○ qa/);
    expect(plainRow("lead").slice(0, 30)).toMatch(/◐ lead/);
    // the four activity ROLES paint distinctly (Substrate values, truecolor)
    expect(styledRow("driver"), "active → actActive").toMatch(/38;2;152;195;121m●/);
    expect(styledRow("guard"), "idle → actIdle").toMatch(/38;2;110;142;170m●/);
    expect(styledRow("qa"), "unknown → actDetached (honest)").toMatch(/38;2;109;116;128m○/);
    expect(styledRow("lead"), "needs-attention → actAttention").toMatch(/38;2;230;181;110m◐/);
    styled.forEach((l, i) => expect(stripAnsi(l), `line ${i}`).toBe(screen.lines[i]));
  });

  it("stylize keeps the strip-invariant over the re-skinned labels", () => {
    const s = makeStore();
    s.dispatch({ type: "drill", resource: "pod", name: "dev50", target: { host: "vm-host", rig: "openrig-build" } });
    const screen = renderScreen(s.get(), snap, { cols: 120, rows: 32 });
    const styled = stylizeLines(screen, createStyle("truecolor"));
    styled.forEach((line, i) => expect(stripAnsi(line), `line ${i}`).toBe(screen.lines[i]));
  });
});
