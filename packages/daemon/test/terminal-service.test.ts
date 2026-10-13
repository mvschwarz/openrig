// OPR.0.4.6.02 C3 — TerminalService orchestration (the ONE composer for every
// view kind). Pure orchestration with injected deps + a fake provider:
//  - view resolution precedence: mission:/slice: (read-only) · rig name +
//    rig:<id> alias (interactive) · saved view (per-member read-only) · unknown;
//  - the one shared {opened,absent,degraded} result shape for resolution
//    failures too (unknown provider / view_required / view_not_found);
//  - honest-partial: a dead local seat (has-session false) lands in absent[];
//  - the composed view handed to the provider carries the composer's partition.

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { planHerdrLayout } from "../src/domain/terminal/herdr-adapter.js";
import { TerminalService, type TerminalServiceDeps } from "../src/domain/terminal/terminal-service.js";
import type {
  ComposedView,
  OpenViewResult,
  ProviderLiveness,
  ProviderStatus,
  TerminalProvider,
} from "../src/domain/terminal/terminal-provider.js";
import type { LiveSeatRow, SavedView } from "../src/domain/terminal/terminal-views-store.js";

/** A provider that records the composed view it was handed and reports success. */
class RecordingProvider implements TerminalProvider {
  readonly name: string;
  lastView: ComposedView | null = null;
  constructor(name: string) {
    this.name = name;
  }
  async status(): Promise<ProviderStatus> {
    return { provider: this.name, available: true, capabilities: { layout: true } };
  }
  async liveness(): Promise<ProviderLiveness> {
    return { alive: true };
  }
  async openView(view: ComposedView): Promise<OpenViewResult> {
    this.lastView = view;
    return {
      provider: this.name,
      ok: view.opened.length > 0,
      opened: view.opened.map((p) => p.seat),
      absent: view.absent,
      degraded: view.degraded,
      pages: view.pages.length,
    };
  }
}

const rigRows: LiveSeatRow[] = [
  { canonicalSessionName: "dev-driver@acme-build", attachmentType: "tmux", tmuxSession: "dev-driver@acme-build", rigName: "acme-build", logicalId: "dev.driver" },
  { canonicalSessionName: "rev-r1@acme-build", attachmentType: "tmux", tmuxSession: "rev-r1@acme-build", rigName: "acme-build", logicalId: "rev.r1" },
];

const savedView: SavedView = {
  id: "watchtower",
  name: "Watchtower",
  members: [
    { seat: "lead@acme-ops", tmuxSession: "lead@acme-ops", readOnly: true },
    { seat: "builder@acme-ops", tmuxSession: "builder@acme-ops" },
  ],
};

function makeDeps(overrides: Partial<TerminalServiceDeps> = {}): {
  deps: TerminalServiceDeps;
  herdr: RecordingProvider;
  cmux: RecordingProvider;
} {
  const herdr = new RecordingProvider("herdr");
  const cmux = new RecordingProvider("cmux");
  const providerMap: Record<string, TerminalProvider> = { herdr, cmux };
  const deps: TerminalServiceDeps = {
    resolveProvider: (name) => providerMap[name] ?? null,
    viewsStore: {
      get: (id) => (id === savedView.id ? savedView : null),
      list: () => [savedView],
    },
    listRigSeats: (rigArg) => (rigArg === "acme-build" || rigArg === "rig-id-1" ? rigRows : null),
    listPodSeats: (rigArg, pod) => (rigArg === "acme-build" && pod === "dev" ? [rigRows[0]!] : null),
    listScopeSeats: (scope) =>
      scope === "mission:4.6" || scope === "slice:02"
        ? [{ canonicalSessionName: "dev-driver@acme-build", attachmentType: "tmux", tmuxSession: "dev-driver@acme-build", rigName: "acme-build", logicalId: "dev.driver" }]
        : null,
    listRigNames: () => ["acme-build"],
    resolveHost: () => null,
    hasSession: () => true,
    ...overrides,
  };
  return { deps, herdr, cmux };
}

describe("TerminalService — view resolution + one-shape result", () => {
  it.each([false, true])("keeps the view outcome and puts the human handoff beside it (provider unavailable=%s)", async unavailable => {
    const { deps, herdr } = makeDeps({ resolveLocalTmux: () => "/opt/tools/tmux" });
    let calls = 0;
    herdr.openView = async view => {
      calls++;
      return {
        provider: "herdr", ok: !unavailable,
        opened: unavailable ? [] : view.opened.map(pane => pane.seat),
        absent: view.absent, degraded: view.degraded, pages: unavailable ? 0 : 1,
        ...(unavailable ? { code: "herdr_unavailable", error: "not running" } : {}),
        notes: ["Original provider detail"],
      };
    };
    const result = await new TerminalService(deps).openView({ view: "acme-build" });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ ok: !unavailable, opened: unavailable ? [] : rigRows.map(row => row.canonicalSessionName), absent: [], degraded: [] });
    expect(result.code).toBe(unavailable ? "herdr_unavailable" : undefined);
    expect(result.notes).toContain("Original provider detail");
    const notes = result.notes!.join("\n");
    expect(notes).toContain("shared dashboard is the overview");
    expect(notes).toContain("lead pane");
    expect(notes).toContain("Can you see the team?");
    expect(notes).toContain("does not confirm");
    if (unavailable) {
      expect(result.notes).toContain("dev.driver: env -u TMUX '/opt/tools/tmux' attach -t 'dev-driver@acme-build'");
      expect(result.notes).toContain("rev.r1: env -u TMUX '/opt/tools/tmux' attach -t 'rev-r1@acme-build'");
      expect(notes).toContain("include every command in full, unchanged");
    } else {
      expect(notes).not.toContain("attach -t");
    }
  });

  it("opens a rig NAME as an interactive derived view (read-write panes)", async () => {
    const { deps, herdr } = makeDeps();
    const svc = new TerminalService(deps);
    const res = await svc.openView({ view: "acme-build" });
    expect(res.provider).toBe("herdr");
    expect(res.ok).toBe(true);
    expect(res.opened).toEqual(["dev-driver@acme-build", "rev-r1@acme-build"]);
    // interactive → no `-r` in the composed pane commands
    expect(herdr.lastView?.opened.every((p) => p.readOnly === false)).toBe(true);
    expect(herdr.lastView?.opened[0]?.paneCommand).toBe("tmux attach -t 'dev-driver@acme-build'");
  });

  it("the rig:<id> alias form resolves the same rig (the rig-scoped route delegation)", async () => {
    const { deps, herdr } = makeDeps();
    const svc = new TerminalService(deps);
    const res = await svc.openView({ view: "rig:rig-id-1" });
    expect(res.ok).toBe(true);
    expect(herdr.lastView?.id).toBe("rig:rig-id-1");
    expect(res.opened.length).toBe(2);
  });

  it("opens a pod:<rig>/<pod> as an interactive derived view (AC-5 launcher target)", async () => {
    const { deps, herdr } = makeDeps();
    const svc = new TerminalService(deps);
    const res = await svc.openView({ view: "pod:acme-build/dev" });
    expect(res.ok).toBe(true);
    expect(res.opened).toEqual(["dev-driver@acme-build"]);
    expect(herdr.lastView?.opened.every((p) => p.readOnly === false)).toBe(true);
    expect(herdr.lastView?.id).toBe("pod:acme-build/dev");
  });

  it("a malformed or unknown pod view → view_not_found", async () => {
    const { deps } = makeDeps();
    const svc = new TerminalService(deps);
    expect((await svc.openView({ view: "pod:acme-build" })).code).toBe("view_not_found"); // no /pod
    expect((await svc.openView({ view: "pod:acme-build/ghost" })).code).toBe("view_not_found"); // unknown pod
  });

  it.each(["mission:4.6", "slice:02"])("opens %s as a watch view without a team-conversation handoff", async view => {
    const { deps, herdr } = makeDeps();
    const svc = new TerminalService(deps);
    const res = await svc.openView({ view });
    expect(res.ok).toBe(true);
    expect(herdr.lastView?.opened.every((p) => p.readOnly === true)).toBe(true);
    expect(herdr.lastView?.opened[0]?.paneCommand).toContain("attach -r -t");
    expect(res.notes?.join("\n") ?? "").not.toMatch(/lead pane|Can you see the team/);
  });

  it("omits the team-conversation handoff when every saved pane is read-only", async () => {
    const { deps, herdr } = makeDeps({
      viewsStore: { list: () => [], get: () => ({ ...savedView, members: savedView.members.map(member => ({ ...member, readOnly: true })) }) },
    });
    const result = await new TerminalService(deps).openView({ view: "watchtower" });
    expect(result.opened).toEqual(savedView.members.map(member => member.seat));
    expect(herdr.lastView?.opened.every(pane => pane.readOnly)).toBe(true);
    expect(result.notes?.join("\n") ?? "").not.toMatch(/lead pane|Can you see the team/);
  });

  it("opens a saved view with per-member read-only", async () => {
    const { deps, herdr } = makeDeps();
    const svc = new TerminalService(deps);
    const res = await svc.openView({ view: "watchtower" });
    expect(res.ok).toBe(true);
    const byReadOnly = Object.fromEntries((herdr.lastView?.opened ?? []).map((p) => [p.seat, p.readOnly]));
    expect(byReadOnly["lead@acme-ops"]).toBe(true);
    expect(byReadOnly["builder@acme-ops"]).toBe(false);
  });

  it("routes to the named provider (cmux best-effort)", async () => {
    const { deps, cmux } = makeDeps();
    const svc = new TerminalService(deps);
    const res = await svc.openView({ view: "acme-build", provider: "cmux" });
    expect(res.provider).toBe("cmux");
    expect(cmux.lastView).not.toBeNull();
  });

  it("names a dead local seat in absent[] (honest-partial via has-session refine)", async () => {
    const { deps } = makeDeps({ hasSession: (s) => s !== "rev-r1@acme-build" });
    const svc = new TerminalService(deps);
    const res = await svc.openView({ view: "acme-build" });
    expect(res.opened).toEqual(["dev-driver@acme-build"]);
    expect(res.absent.map((a) => a.seat)).toContain("rev-r1@acme-build");
    // a partial-with-names open is still ok (disclosure, not failure)
    expect(res.ok).toBe(true);
  });

  it("unknown view → the one shared shape with code view_not_found", async () => {
    const { deps } = makeDeps();
    const svc = new TerminalService(deps);
    const res = await svc.openView({ view: "no-such-thing" });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("view_not_found");
    expect(res.opened).toEqual([]);
  });

  it("explicit rig:<x> that resolves nowhere is view_not_found (never falls through to saved)", async () => {
    const { deps } = makeDeps();
    const svc = new TerminalService(deps);
    const res = await svc.openView({ view: "rig:watchtower" });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("view_not_found");
  });

  it("unknown provider → code unknown_provider (400-class), no composition", async () => {
    const { deps } = makeDeps();
    const svc = new TerminalService(deps);
    const res = await svc.openView({ view: "acme-build", provider: "tmate" });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("unknown_provider");
  });

  it("empty view → code view_required", async () => {
    const { deps } = makeDeps();
    const svc = new TerminalService(deps);
    const res = await svc.openView({ view: "   " });
    expect(res.code).toBe("view_required");
  });

  it("listViews returns saved views + openable rig names", async () => {
    const { deps } = makeDeps();
    const svc = new TerminalService(deps);
    const res = await svc.listViews();
    expect(res.saved.map((v) => v.id)).toEqual(["watchtower"]);
    expect(res.rigs).toEqual(["acme-build"]);
  });

  it("status reports each provider; an unknown named provider is honestly unavailable", async () => {
    const { deps } = makeDeps();
    const svc = new TerminalService(deps);
    const all = await svc.status();
    expect(all.providers.map((p) => p.name).sort()).toEqual(["cmux", "herdr"]);
    const one = await svc.status("tmate");
    expect(one.providers[0]?.status.available).toBe(false);
  });
});

describe("one terminal catalog inventory", () => {
  it("uses one batch for derived entries and preserves the complete default catalog", async () => {
    const normal = makeDeps();
    const expected = await new TerminalService(normal.deps).listViews(true);
    let batches = 0; let singles = 0;
    const batched = makeDeps({
      listRigSeats: () => { singles++; return rigRows; },
      listRigSeatsBatch: names => { batches++; expect(names).toEqual(["acme-build"]); return new Map([["acme-build", rigRows]]); },
    });
    const actual = await new TerminalService(batched.deps).listViews(true);
    expect(actual).toEqual(expected);
    expect(batches).toBe(1);
    expect(singles).toBe(0);
    expect(batched.herdr.lastView).toBeNull();
  });
});

describe("Herdr reuse plan labels", () => {
  async function rendered(service: TerminalService, provider: RecordingProvider, view: string) {
    const preview = await service.previewView({ view });
    if (!("composed" in preview)) throw new Error("expected preview");
    expect((await service.openView({ view, expectedPlan: preview.planId })).ok).toBe(true);
    const label = planHerdrLayout(provider.lastView!, "fixed").pages[0]!.tabLabel;
    expect(label).toBe(`openrig:${preview.composed.id}#${preview.planId.slice(0, 16)}#fixed`);
    return label;
  }

  it.each(["membership", "target"])("changes the reuse label when saved view %s changes", async change => {
    const saved: SavedView = { id: "team", name: "Team", members: [{ seat: "lead", tmuxSession: "original" }] };
    const { deps, herdr } = makeDeps({ viewsStore: { list: () => [saved], get: () => saved } });
    const service = new TerminalService(deps);
    const before = await rendered(service, herdr, "saved:team");
    expect(await rendered(service, herdr, "saved:team")).toBe(before);
    if (change === "membership") saved.members.push({ seat: "worker", tmuxSession: "worker" });
    else saved.members[0]!.tmuxSession = "replacement";
    expect(await rendered(service, herdr, "saved:team")).not.toBe(before);
  });

  it("separates saved and derived views with the same resolved id and different members", async () => {
    const saved: SavedView = { id: "rig:acme-build", name: "Saved", members: [{ seat: "other", tmuxSession: "other" }] };
    const { deps, herdr } = makeDeps({ viewsStore: { list: () => [saved], get: id => id === saved.id ? saved : null } });
    const service = new TerminalService(deps);
    const before = await rendered(service, herdr, "saved:rig:acme-build");
    const after = await rendered(service, herdr, "rig:acme-build");
    expect(before).toMatch(/^openrig:rig:acme-build#/);
    expect(after).toMatch(/^openrig:rig:acme-build#/);
    expect(after).not.toBe(before);
  });
});

describe("default saved kernel conversations", () => {
  function kernel(operatorRuntime = "codex", advisorRuntime = "claude-code"): LiveSeatRow[] {
    // Bindings deliberately differ from the logical IDs and inventory order.
    return [
      { logicalId: "queue.worker", runtime: "codex", canonicalSessionName: "queue-bound", attachmentType: "tmux" },
      { logicalId: "operator.human", runtime: "terminal", canonicalSessionName: "tui-bound", tmuxSession: "actual-tui", attachmentType: "tmux" },
      { logicalId: "operator.agent", runtime: operatorRuntime, canonicalSessionName: "operator-bound", attachmentType: "tmux" },
      { logicalId: "advisor.lead", runtime: advisorRuntime, canonicalSessionName: "advisor-bound", attachmentType: "tmux" },
    ];
  }
  function makeKernel(rows: LiveSeatRow[], saved: SavedView[] = []) {
    return makeDeps({
      viewsStore: { list: () => saved, get: id => saved.find(view => view.id === id) ?? null },
      listRigNames: () => ["kernel"], listRigSeats: name => name === "kernel" ? rows : null,
    });
  }

  it("names the first Herdr tab for the operator once it becomes available", async () => {
    const { deps, herdr } = makeKernel(kernel());
    let operatorReady = false;
    deps.hasSession = session => session !== "operator-bound" || operatorReady;
    const service = new TerminalService(deps);
    const before = await service.openView({ view: "saved:kernel" });
    expect(before.opened).toEqual(["tui-bound", "advisor-bound"]);
    const oldLabel = planHerdrLayout(herdr.lastView!, "fixed").pages[0]!.tabLabel;
    operatorReady = true;
    const preview = await service.previewView({ view: "saved:kernel" });
    if (!("composed" in preview)) throw new Error("expected preview");
    expect((await service.openView({ view: "saved:kernel", expectedPlan: preview.planId })).opened).toEqual(["operator-bound", "tui-bound", "advisor-bound"]);
    const newLabel = planHerdrLayout(herdr.lastView!, "fixed").pages[0]!.tabLabel;
    expect(oldLabel).toBe("dashboard");
    expect(newLabel).toBe("operator");
    expect(planHerdrLayout(herdr.lastView!, "fixed").workspaceLabel).toBe("openrig kernel");
  });

  it.each([false, true])("keeps the default kernel handoff distinct from a team (provider unavailable=%s)", async unavailable => {
    const { deps, herdr } = makeKernel(kernel());
    if (unavailable) herdr.openView = async view => ({
      provider: "herdr", ok: false, opened: [], absent: view.absent, degraded: view.degraded,
      pages: 0, code: "herdr_unavailable", error: "not running",
    });
    const result = await new TerminalService(deps).openView({ view: "saved:kernel" });
    expect(result.ok).toBe(!unavailable);
    expect(result.opened).toEqual(unavailable ? [] : ["operator-bound", "tui-bound", "advisor-bound"]);
    expect(result.notes?.join("\n")).toContain("Default kernel view:");
    expect(result.notes?.join("\n")).not.toMatch(/lead pane|Can you see the team/);
    if (unavailable) expect(result.notes).toContain("operator: env -u TMUX tmux attach -t 'operator-bound'");
  });

  it.each(["herdr", "cmux"])("offers existing conversation attachments when %s is unavailable", async providerName => {
    const { deps, herdr, cmux } = makeKernel(kernel());
    deps.hasSession = session => session !== "advisor-bound";
    const provider = providerName === "herdr" ? herdr : cmux;
    provider.openView = async view => ({
      provider: providerName, ok: false, opened: [], pages: 0,
      absent: view.absent, degraded: view.degraded,
      code: `${providerName}_unavailable`, error: "not running", notes: ["Original provider detail"],
    });
    const result = await new TerminalService(deps).openView({ view: "saved:kernel", provider: providerName });
    expect(result).toMatchObject({ ok: false, opened: [], code: `${providerName}_unavailable` });
    expect(result.absent.map(member => member.seat)).toContain("advisor-bound");
    expect(result.notes).toContain("operator: env -u TMUX tmux attach -t 'operator-bound'");
    expect(result.notes).toContain("dashboard: env -u TMUX tmux attach -t 'actual-tui'");
    expect(result.notes).toContain("Original provider detail");
    expect(result.notes!.join("\n")).not.toContain("attach -t 'advisor-bound'");
    expect(result.notes!.join("\n")).not.toContain("queue-bound");
  });

  it.each([["claude-code", "codex"], ["claude-code", "claude-code"], ["codex", "codex"]])("opens the operator first with dashboard and advisor on their own pages for %s/%s", async (advisorRuntime, operatorRuntime) => {
    const { deps, herdr } = makeKernel(kernel(operatorRuntime, advisorRuntime));
    const service = new TerminalService(deps);
    const preview = await service.previewView({ view: "saved:kernel" });
    if (!("composed" in preview)) throw new Error("expected preview");
    expect(preview.composed.columns).toBe(1);
    expect(preview.composed.pages.map(page => page.map(pane => pane.seat))).toEqual([
      ["operator-bound"], ["tui-bound"], ["advisor-bound"],
    ]);
    expect(preview.grids.map(({ columns, rows, blanks }) => ({ columns, rows, blanks }))).toEqual(
      Array(3).fill({ columns: 1, rows: 1, blanks: 0 }),
    );
    expect(preview.grids.map(grid => grid.root)).toMatchObject([
      { type: "pane", label: "operator" },
      { type: "pane", label: "dashboard" },
      { type: "pane", label: "advisor" },
    ]);
    expect(preview.planId).toBe(createHash("sha256").update(JSON.stringify({
      provider: "herdr", composed: preview.composed, grids: preview.grids,
    })).digest("hex"));
    const result = await service.openView({ view: "saved:kernel", expectedPlan: preview.planId });
    expect(result.ok).toBe(true);
    expect(herdr.lastView).toEqual({ ...preview.composed, planId: preview.planId });
    expect(planHerdrLayout(herdr.lastView!, "fixed").pages.map(page => page.root)).toEqual(preview.grids.map(grid => grid.root));
  });

  it.each([
    [119, "claude-code", "codex"], [120, "claude-code", "codex"], [174, "claude-code", "codex"],
    [119, "claude-code", "claude-code"], [120, "claude-code", "claude-code"],
    [119, "codex", "codex"], [160, "codex", "codex"],
  ] as const)("uses the measured %i-column welcome layout for %s/%s", async (viewportColumns, advisor, operator) => {
    const { deps, herdr } = makeKernel(kernel(operator, advisor));
    const service = new TerminalService(deps);
    const preview = await service.previewView({ view: "saved:kernel", viewportColumns });
    if (!("composed" in preview)) throw new Error("expected preview");
    const wide = viewportColumns >= 120;
    expect(preview.composed.pages.map(page => page.map(pane => pane.seat))).toEqual(wide
      ? [["tui-bound", "operator-bound"], ["advisor-bound"]]
      : [["operator-bound"], ["tui-bound"], ["advisor-bound"]]);
    if (wide) expect(preview.grids[0]!.root).toMatchObject({
      type: "split", direction: "right", ratio: 0.5,
      first: { type: "pane", label: "dashboard" }, second: { type: "pane", label: "operator" },
    });
    expect(planHerdrLayout({ ...preview.composed, planId: preview.planId }, "fixed").pages.map(page => page.tabLabel)).toEqual(wide
      ? ["dashboard · operator", "advisor"] : ["operator", "dashboard", "advisor"]);
    expect(preview.grids.every(grid => grid.blanks === 0)).toBe(true);
    expect((await service.openView({ view: "saved:kernel", viewportColumns, expectedPlan: preview.planId })).ok).toBe(true);
    expect(planHerdrLayout(herdr.lastView!, "fixed").pages.map(page => page.root)).toEqual(preview.grids.map(grid => grid.root));
  });

  it.each(["operator.agent", "operator.human"])("keeps the advisor separate at 160 columns when %s is absent", async missing => {
    const { deps } = makeKernel(kernel().filter(row => row.logicalId !== missing));
    const preview = await new TerminalService(deps).previewView({ view: "saved:kernel", viewportColumns: 160 });
    if (!("composed" in preview)) throw new Error("expected preview");
    expect(preview.composed.pages.map(page => page.map(pane => pane.seat))).toEqual([
      [missing === "operator.agent" ? "tui-bound" : "operator-bound"], ["advisor-bound"],
    ]);
    expect(preview.composed.absent.map(pane => pane.seat)).toContain(missing);
    expect(preview.grids.every(grid => grid.blanks === 0)).toBe(true);
  });

  it("binds preview fingerprints to the width-selected composition", async () => {
    const { deps, herdr } = makeKernel(kernel());
    const service = new TerminalService(deps);
    const preview = await service.previewView({ view: "saved:kernel", viewportColumns: 119 });
    if (!("composed" in preview)) throw new Error("expected preview");
    const result = await service.openView({ view: "saved:kernel", viewportColumns: 120, expectedPlan: preview.planId });
    expect(result).toMatchObject({ ok: false, code: "preview_changed" });
    expect(herdr.lastView).toBeNull();
  });

  it.each([undefined, 0, -1, NaN, Infinity, 120.5])("uses the narrow layout for an unknown or invalid width %s", async viewportColumns => {
    const { deps } = makeKernel(kernel());
    const preview = await new TerminalService(deps).previewView({ view: "saved:kernel", viewportColumns });
    if (!("composed" in preview)) throw new Error("expected preview");
    expect(preview.composed.pages.map(page => page.map(pane => pane.seat))).toEqual([["operator-bound"], ["tui-bound"], ["advisor-bound"]]);
  });

  it.each(["saved:kernel", "saved:custom", "rig:kernel"])("kernel geometry preserves auto-grid for %s outside the default", async view => {
    const custom: SavedView = { id: view.slice(6), name: "Custom", members: ["a", "b", "c"].map(seat => ({ seat })) };
    const { deps, herdr } = makeKernel(kernel().filter(row => row.logicalId !== "queue.worker"), [custom]);
    const service = new TerminalService(deps);
    const preview = await service.previewView({ view, viewportColumns: 174 });
    if (!("composed" in preview)) throw new Error("expected preview");
    expect(preview.composed.columns).toBeUndefined();
    expect(preview.grids[0]).toMatchObject({ columns: 2, rows: 2, blanks: 1 });
    expect((await service.openView({ view, viewportColumns: 174, expectedPlan: preview.planId })).ok).toBe(true);
    expect(planHerdrLayout(herdr.lastView!, "fixed").pages.map(page => page.root)).toEqual(preview.grids.map(grid => grid.root));
  });

  it("kernel geometry caps partial views to available panes while retaining named absences", async () => {
    const rows = kernel();
    rows.find(row => row.logicalId === "operator.agent")!.canonicalSessionName = null;
    const { deps, herdr } = makeKernel(rows);
    const service = new TerminalService(deps);
    const preview = await service.previewView({ view: "saved:kernel" });
    if (!("composed" in preview)) throw new Error("expected preview");
    expect(preview.composed.columns).toBe(1);
    expect(preview.composed.pages.map(page => page.map(pane => pane.seat))).toEqual([["tui-bound"], ["advisor-bound"]]);
    expect(preview.grids.map(({ columns, rows, blanks }) => ({ columns, rows, blanks }))).toEqual(
      Array(2).fill({ columns: 1, rows: 1, blanks: 0 }),
    );
    const result = await service.openView({ view: "saved:kernel", expectedPlan: preview.planId });
    expect(result.opened).toEqual(["tui-bound", "advisor-bound"]);
    expect(result.absent.map(member => member.seat)).toEqual(["operator.agent"]);
    expect(planHerdrLayout(herdr.lastView!, "fixed").pages.map(page => page.root)).toEqual(preview.grids.map(grid => grid.root));
  });

  it("kernel geometry keeps auto-grid on each page without treating map indexes as columns", async () => {
    const custom: SavedView = { id: "custom", name: "Custom", members: Array.from({ length: 6 }, (_, i) => ({ seat: `s${i}` })) };
    const { deps } = makeKernel(kernel(), [custom]);
    class PagedProvider extends RecordingProvider { readonly panesPerPage = 3; }
    const provider = new PagedProvider("herdr");
    deps.resolveProvider = () => provider;
    const service = new TerminalService(deps);
    const preview = await service.previewView({ view: "saved:custom" });
    if (!("composed" in preview)) throw new Error("expected preview");
    expect(preview.grids.map(({ columns, rows, blanks }) => ({ columns, rows, blanks }))).toEqual([
      { columns: 2, rows: 2, blanks: 1 }, { columns: 2, rows: 2, blanks: 1 },
    ]);
    expect(preview.planId).toBe(createHash("sha256").update(JSON.stringify({
      provider: "herdr", composed: preview.composed, grids: preview.grids,
    })).digest("hex"));
    expect((await service.openView({ view: "saved:custom", expectedPlan: preview.planId })).ok).toBe(true);
    expect(planHerdrLayout(provider.lastView!, "fixed").pages.map(page => page.root)).toEqual(preview.grids.map(grid => grid.root));
  });

  it.each([["claude-code", "codex"], ["claude-code", "claude-code"], ["codex", "codex"]])("resolves the %s/%s layout from installed bindings without saving it", async (advisorRuntime, operatorRuntime) => {
    const saved: SavedView[] = [];
    const { deps, herdr } = makeKernel(kernel(operatorRuntime, advisorRuntime), saved);
    const service = new TerminalService(deps);
    const expected = ["operator-bound", "tui-bound", "advisor-bound"];
    expect((await service.listViews()).saved[0]?.members.map(member => member.seat)).toEqual(expected);
    expect(herdr.lastView).toBeNull();
    const preview = await service.previewView({ view: "saved:kernel" });
    expect("composed" in preview && preview.composed.opened.map(member => member.seat)).toEqual(expected);
    expect(herdr.lastView).toBeNull();
    expect((await service.openView({ view: "saved:kernel" })).opened).toEqual(expected);
    expect(herdr.lastView?.opened[1]?.paneCommand).toContain("'actual-tui'");
    expect(herdr.lastView?.opened[2]?.runtime).toBe(advisorRuntime);
    expect(saved).toEqual([]);
  });

  it("preserves a user kernel override, including remote membership and read-only flags", async () => {
    const custom = { id: "kernel", name: "My view", members: [{ seat: "custom", host: "elsewhere", readOnly: true }] };
    const views = [savedView, custom];
    const { deps } = makeKernel(kernel(), views);
    deps.listRigSeats = () => { throw new Error("must not resolve the default for an override"); };
    const service = new TerminalService(deps);
    expect((await service.listViews()).saved).toEqual(views);
    const result = await service.openView({ view: "saved:kernel" });
    expect(result.degraded).toEqual([{ seat: "custom", host: "elsewhere", reason: "host elsewhere is not in the hosts registry" }]);
    expect(views).toEqual([savedView, custom]);
  });

  it("leaves unrelated custom views and the full rig view unchanged", async () => {
    const { deps } = makeKernel(kernel(), [savedView]);
    const service = new TerminalService(deps);
    expect((await service.listViews()).saved[0]).toEqual(savedView);
    expect((await service.openView({ view: "saved:watchtower" })).opened).toEqual(["lead@acme-ops", "builder@acme-ops"]);
    expect((await service.openView({ view: "kernel" })).opened).toContain("queue-bound");
    expect((await service.openView({ view: "rig:kernel" })).opened).toContain("queue-bound");
  });

  it("reports dead bound seats and never invents an unbound session", async () => {
    const rows = kernel(); rows[1]!.canonicalSessionName = null;
    const { deps } = makeKernel(rows);
    deps.hasSession = name => name !== "advisor-bound";
    const result = await new TerminalService(deps).openView({ view: "saved:kernel" });
    expect(result.opened).toEqual(["operator-bound"]);
    expect(result.absent.map(member => member.seat)).toEqual(["operator.human", "advisor-bound"]);
    expect(result.notes).toContain("Default kernel view: dual-runtime.");
  });

  it.each(["claude-code", "codex"])("names an unbound operator in a %s-only kernel", async runtime => {
    const rows = kernel(runtime, runtime);
    rows.find(row => row.logicalId === "operator.agent")!.canonicalSessionName = null;
    const { deps } = makeKernel(rows);
    const probed: string[] = [];
    deps.hasSession = name => { probed.push(name); return true; };
    const result = await new TerminalService(deps).openView({ view: "saved:kernel" });
    expect(result.ok).toBe(true);
    expect(result.opened).toEqual(["tui-bound", "advisor-bound"]);
    expect(result.absent.map(member => member.seat)).toEqual(["operator.agent"]);
    expect(probed).toEqual(["actual-tui", "advisor-bound"]);
  });

  it("keeps missing roles named while opening the remaining TUI", async () => {
    const { deps } = makeKernel([kernel()[1]!]);
    const result = await new TerminalService(deps).openView({ view: "saved:kernel" });
    expect(result.ok).toBe(true);
    expect(result.opened).toEqual(["tui-bound"]);
    expect(result.absent.map(member => member.seat)).toEqual(["operator.agent", "advisor.lead"]);
    expect(result.notes?.join(" ")).toContain("runtime layout unverified");
  });

  it("keeps a bound operator when the advisor row and runtime are missing", async () => {
    const { deps } = makeKernel(kernel().filter(row => row.logicalId !== "advisor.lead"));
    const result = await new TerminalService(deps).openView({ view: "saved:kernel" });
    expect(result.ok).toBe(true);
    expect(result.opened).toEqual(["operator-bound", "tui-bound"]);
    expect(result.absent.map(member => member.seat)).toEqual(["advisor.lead"]);
    expect(result.notes?.join(" ")).toContain("runtime layout unverified");
  });

  it.each(["unbound", "non-tmux", "missing"])("names all unavailable roles for %s kernels without calling the provider", async kind => {
    const rows = kind === "missing" ? [] : kernel().map(row => ({ ...row,
      ...(kind === "unbound" ? { canonicalSessionName: null, tmuxSession: null } : { attachmentType: "external_cli" }),
    }));
    const { deps, herdr } = makeKernel(rows);
    deps.hasSession = () => { throw new Error("must not probe a guessed session"); };
    const service = new TerminalService(deps);
    const result = await service.openView({ view: "saved:kernel" });
    expect(result.code).toBe("kernel_seats_unavailable");
    expect(result.opened).toEqual([]);
    expect(result.absent.map(member => member.seat)).toEqual(["operator.agent", "operator.human", "advisor.lead"]);
    for (const member of result.absent) expect(result.error).toContain(member.seat);
    expect(herdr.lastView).toBeNull();
  });

  it("does not add the default when no kernel is installed", async () => {
    const { deps } = makeDeps();
    const service = new TerminalService(deps);
    expect((await service.listViews()).saved).toEqual([savedView]);
    expect((await service.openView({ view: "saved:kernel" })).code).toBe("view_not_found");
  });
});

describe("TerminalService — an omitted provider falls back from herdr to cmux (#1069)", () => {
  const down = (provider: RecordingProvider, how: "unavailable" | "not-alive") => {
    if (how === "unavailable") provider.status = async () => ({ provider: provider.name, available: false, capabilities: {} });
    else provider.liveness = async () => ({ alive: false, detail: "herdr control socket is not answering ping" });
  };

  it.each(["unavailable", "not-alive"] as const)("opens in a live cmux when herdr is %s, and says so", async (how) => {
    const { deps, herdr, cmux } = makeDeps();
    down(herdr, how);
    const r = await new TerminalService(deps).openView({ view: "acme-build" });
    expect(r).toMatchObject({ provider: "cmux", ok: true });
    expect(cmux.lastView).not.toBeNull();
    expect(herdr.lastView).toBeNull();
    expect(r.notes?.join("\n")).toContain("Herdr isn't available here (not installed or not answering), so this view uses cmux.");
  });

  it("previews with the same fallback, so the preview's plan matches the open", async () => {
    const { deps, herdr } = makeDeps();
    down(herdr, "unavailable");
    const service = new TerminalService(deps);
    const preview = await service.previewView({ view: "acme-build" });
    expect(preview).toMatchObject({ provider: "cmux" });
    const r = await service.openView({ view: "acme-build", expectedPlan: (preview as { planId: string }).planId });
    expect(r).toMatchObject({ provider: "cmux", ok: true });
  });

  it("with neither available, keeps herdr's honest failure and the direct attach commands", async () => {
    const { deps, herdr, cmux } = makeDeps();
    down(herdr, "unavailable");
    down(cmux, "not-alive");
    herdr.openView = async (view) => ({ provider: "herdr", ok: false, opened: [], absent: view.absent, degraded: view.degraded, pages: 0, error: "herdr control socket is not answering ping; is herdr running?", code: "herdr_unavailable" });
    const r = await new TerminalService(deps).openView({ view: "acme-build" });
    expect(r).toMatchObject({ provider: "herdr", ok: false, code: "herdr_unavailable" });
    expect(r.notes?.join("\n")).toContain("attach directly using one of these commands");
    expect(r.notes?.join("\n")).toContain("env -u TMUX");
    expect(cmux.lastView).toBeNull();
  });

  it("keeps an explicitly named provider exactly as named, with no fallback", async () => {
    const { deps, herdr, cmux } = makeDeps();
    down(herdr, "unavailable");
    const r = await new TerminalService(deps).openView({ provider: "herdr", view: "acme-build" });
    expect(r.provider).toBe("herdr");
    expect(herdr.lastView).not.toBeNull();
    expect(cmux.lastView).toBeNull();
    expect(r.notes?.join("\n") ?? "").not.toContain("Herdr isn't available here");
  });

  it("prefers a live herdr when both are there", async () => {
    const { deps, herdr, cmux } = makeDeps();
    const r = await new TerminalService(deps).openView({ view: "acme-build" });
    expect(r.provider).toBe("herdr");
    expect(herdr.lastView).not.toBeNull();
    expect(cmux.lastView).toBeNull();
  });
});
