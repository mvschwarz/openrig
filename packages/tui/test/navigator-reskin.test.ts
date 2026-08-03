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
    expect(pane).toMatch(/├─/);
    expect(pane).toMatch(/└─/);
  });

  it("hosts and rigs carry NO collapse glyph (no false affordances — no collapse exists there today)", () => {
    const s = makeStore();
    const screen = renderScreen(s.get(), snap, { cols: 120, rows: 32 });
    const hostRow = explorerPane(screen.lines).find((l) => l.includes("vm-host"))!;
    const rigRow = explorerPane(screen.lines).find((l) => l.includes("openrig-build"))!;
    expect(hostRow).not.toMatch(/[▾▸]/);
    expect(rigRow).not.toMatch(/[▾▸]/);
  });

  it("pods KEEP their genuine collapse glyph (▸ collapsed, ▾ expanded via drill/auto-expand)", () => {
    const s = makeStore();
    let screen = renderScreen(s.get(), snap, { cols: 120, rows: 32 });
    const collapsed = explorerPane(screen.lines).find((l) => l.includes("dev50"))!;
    expect(collapsed).toContain("▸");
    // drilling the pod auto-expands it — unchanged function, re-skinned look
    s.dispatch({ type: "drill", resource: "pod", name: "dev50", target: { host: "vm-host", rig: "openrig-build" } });
    screen = renderScreen(s.get(), snap, { cols: 120, rows: 32 });
    const pane = explorerPane(screen.lines);
    expect(pane.find((l) => l.includes("dev50") && !l.includes("●"))).toContain("▾");
    // the agent rows appear (identity by ROW MODEL key — display names may
    // truncate under the locked meta-always policy)
    expect(screen.explorerRows.some((r) => r.key === "agent:vm-host/openrig-build/dev50/dev50.driver")).toBe(true);
  });

  it("agent meta is ALWAYS the locked `runtime · ctx%` form — typical name truncates rather than the meta degrading (guard residual)", () => {
    const s = makeStore();
    s.dispatch({ type: "drill", resource: "pod", name: "dev50", target: { host: "vm-host", rig: "openrig-build" } });
    const pane = explorerPane(renderScreen(s.get(), snap, { cols: 120, rows: 32 }).lines);
    // typical long name: the NAME yields with …; the meta stays complete
    const driver = pane.find((l) => l.trimEnd().endsWith("claude · 62%"))!;
    expect(driver).toBeDefined();
    expect(driver).toMatch(/● dev/); // still recognizably the agent row
    expect(driver).toMatch(/…/);
  });

  it("null context renders the honest `runtime · —` — runtime never drops, unknown never fabricates", () => {
    const s = makeStore();
    s.dispatch({ type: "drill", resource: "pod", name: "dev50", target: { host: "vm-host", rig: "openrig-build" } });
    const pane = explorerPane(renderScreen(s.get(), snap, { cols: 120, rows: 32 }).lines);
    expect(pane.some((l) => l.trimEnd().endsWith("codex · —"))).toBe(true); // demo: dev50.qa ctx null
  });

  it("a short name renders untruncated beside the full meta (mockup display form, middle dot included)", () => {
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
    expect(row.trimEnd()).toMatch(/● ok\s+claude · 5%$/);
  });

  it("an extreme name still truncates with … while the whole meta survives at the edge", () => {
    const longSnap = {
      ...snap,
      hosts: [{ name: "h", reachable: true, rigs: [{ name: "r", pods: [{ name: "p", agents: [
        { name: "an-extremely-long-agent-name-x", runtime: "codex", spec: "", context: 9, tokens: null, status: "active", live: true },
      ] }] }] }],
    };
    const s = createViewState({ instanceId: "nav-long", getSnapshot: () => longSnap });
    s.dispatch({ type: "drill", resource: "pod", name: "p", target: { host: "h", rig: "r" } });
    const row = explorerPane(renderScreen(s.get(), longSnap, { cols: 120, rows: 32 }).lines).find((l) => l.includes("● an-"))!;
    expect(row).toMatch(/…/);
    expect(row.trimEnd()).toMatch(/codex · 9%$/);
  });

  it("the WHOLE right-aligned meta paints dim as one run — runtime, middle dot, and value together", () => {
    const s = makeStore();
    s.dispatch({ type: "drill", resource: "pod", name: "dev50", target: { host: "vm-host", rig: "openrig-build" } });
    const screen = renderScreen(s.get(), snap, { cols: 120, rows: 32 });
    const styled = stylizeLines(screen, createStyle("truecolor"));
    const i = screen.lines.findIndex((l) => l.slice(0, 30).trimEnd().endsWith("claude · 62%"));
    expect(i).toBeGreaterThanOrEqual(0);
    // the dim SGR opens immediately before the runtime token, covering the full meta
    expect(styled[i]).toMatch(/\x1b\[38;2;109;116;128mclaude · 62%\x1b\[0m/);
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
    const indentOf = (l: string) => (/^\s*(?:│ )*/.exec(l)?.[0] ?? "").length + (l.match(/├─|└─/)?.index ?? 0);
    const branchCol = (l: string) => l.search(/├─|└─/);
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
    // the selected ROW is the drilled agent (row-model identity); its display
    // line carries the marker and the agent's own locked meta at the edge
    const selectedRow = screen.explorerRows.find((r) => r.y === screen.lines.findIndex((l) => l.startsWith("›")) + 1);
    expect(selectedRow?.key).toBe("agent:vm-host/openrig-build/dev50/dev50.guard");
    const selectedLine = screen.lines.find((l) => l.startsWith("›"))!;
    expect(selectedLine.slice(0, 30).trimEnd()).toMatch(/codex · 31%$/); // demo: guard ctx 31
  });

  it("stylize keeps the strip-invariant over the re-skinned labels", () => {
    const s = makeStore();
    s.dispatch({ type: "drill", resource: "pod", name: "dev50", target: { host: "vm-host", rig: "openrig-build" } });
    const screen = renderScreen(s.get(), snap, { cols: 120, rows: 32 });
    const styled = stylizeLines(screen, createStyle("truecolor"));
    styled.forEach((line, i) => expect(stripAnsi(line), `line ${i}`).toBe(screen.lines[i]));
  });
});
