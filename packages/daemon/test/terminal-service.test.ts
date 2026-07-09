// OPR.0.4.6.02 C3 — TerminalService orchestration (the ONE composer for every
// view kind). Pure orchestration with injected deps + a fake provider:
//  - view resolution precedence: mission:/slice: (read-only) · rig name +
//    rig:<id> alias (interactive) · saved view (per-member read-only) · unknown;
//  - the one shared {opened,absent,degraded} result shape for resolution
//    failures too (unknown provider / view_required / view_not_found);
//  - honest-partial: a dead local seat (has-session false) lands in absent[];
//  - the composed view handed to the provider carries the composer's partition.

import { describe, it, expect } from "vitest";
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

  it("opens mission:/slice: as a READ-ONLY derived view (cross-rig observational)", async () => {
    const { deps, herdr } = makeDeps();
    const svc = new TerminalService(deps);
    const res = await svc.openView({ view: "mission:4.6" });
    expect(res.ok).toBe(true);
    expect(herdr.lastView?.opened.every((p) => p.readOnly === true)).toBe(true);
    expect(herdr.lastView?.opened[0]?.paneCommand).toContain("attach -r -t");
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
