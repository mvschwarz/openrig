// OPR.0.6.0.8 — open the whole rig in Herdr. A real TerminalService + real HerdrAdapter over an
// injected socket transport, with a synthetic 17-seat rig. These prove what the adapter SENDS and
// how it reads replies; they do not prove what a real Herdr does with duplicate labels or focus.
import { describe, expect, it } from "vitest";
import { TerminalService, type TerminalServiceDeps } from "../src/domain/terminal/terminal-service.js";
import { HerdrAdapter, HERDR_PANES_PER_PAGE, planHerdrLayout } from "../src/domain/terminal/herdr-adapter.js";
import { PANES_PER_PAGE } from "../src/domain/terminal/view-composer.js";
import { MAX_COLS, MAX_PER_WORKSPACE } from "../src/domain/cmux-layout-service.js";
import type { HerdrResult, HerdrTransport } from "../src/domain/terminal/herdr-transport.js";
import type { ComposedView, OpenViewResult, TerminalProvider } from "../src/domain/terminal/terminal-provider.js";

const RIG = "big";
const rows = Array.from({ length: 17 }, (_, i) => {
  const s = `seat-${String(i + 1).padStart(2, "0")}@${RIG}`;
  return { canonicalSessionName: s, attachmentType: "tmux" as const, tmuxSession: s, rigName: RIG, logicalId: `pod.s${i + 1}` };
});

type Req = { method: string; params: Record<string, unknown> };
function herdrTransport(respond?: (method: string, params: Record<string, unknown>, n: number) => HerdrResult): { transport: HerdrTransport; requests: Req[] } {
  const requests: Req[] = [];
  let applied = 0;
  return {
    requests,
    transport: {
      probe: async () => ({ alive: true, version: "0.7.1", protocol: 14 }),
      request: async (method, params) => {
        requests.push({ method, params: params as Record<string, unknown> });
        if (respond) return respond(method, params as Record<string, unknown>, applied);
        if (method === "workspace.create") return { type: "workspace_created", workspace: { workspace_id: "w1" }, tab: { tab_id: "w1:t0" } };
        if (method === "layout.apply") { applied++; return { type: "layout_apply", layout: { workspace_id: "w1", tab_id: `w1:t${applied}` } }; }
        return { type: "ok" };
      },
    },
  };
}

class RecordingCmux implements TerminalProvider {
  readonly name = "cmux";
  last: ComposedView | null = null;
  async status() { return { provider: this.name, available: true, capabilities: { layout: true } }; }
  async liveness() { return { alive: true }; }
  async openView(view: ComposedView): Promise<OpenViewResult> {
    this.last = view;
    return { provider: this.name, ok: true, opened: view.opened.map((p) => p.seat), absent: view.absent, degraded: view.degraded, pages: view.pages.length };
  }
}

function service(herdr: TerminalProvider, cmux = new RecordingCmux()): { svc: TerminalService; cmux: RecordingCmux } {
  const deps: TerminalServiceDeps = {
    resolveProvider: (n) => (n === "herdr" ? herdr : n === "cmux" ? cmux : null),
    viewsStore: { get: () => null, list: () => [] },
    listRigSeats: (r) => (r === RIG ? rows : null),
    listPodSeats: () => null,
    listScopeSeats: () => null,
    listRigNames: () => [RIG],
    resolveHost: () => null,
    hasSession: () => true,
  } as TerminalServiceDeps;
  return { svc: new TerminalService(deps), cmux };
}

const cellSeats = (root: unknown): string[] => {
  const out: string[] = [];
  const walk = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "pane" && Array.isArray(n.command)) { const m = /attach -t '([^']+)'/.exec(n.command.join(" ")); if (m) out.push(m[1]!); }
    for (const k of ["first", "second", "children", "left", "right", "top", "bottom"]) {
      const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else walk(v);
    }
  };
  walk(root);
  return out;
};

describe("S08 — the rig opens as one Herdr space, 16 cells per tab", () => {
  it("17 live seats → workspace named after the rig, tabs of 16 then 1, each cell on its own seat, in order", async () => {
    const { transport, requests } = herdrTransport();
    const { svc } = service(new HerdrAdapter({ transportFactory: () => transport, newLaunchToken: () => "tok" }));
    const res = await svc.openView({ view: `rig:${RIG}` });
    expect(res).toMatchObject({ provider: "herdr", ok: true, pages: 2, absent: [], degraded: [] });
    expect(res.opened).toEqual(rows.map((r) => r.canonicalSessionName));
    const create = requests.find((r) => r.method === "workspace.create")!;
    expect(create.params).toEqual({ focus: false, label: RIG });
    const applies = requests.filter((r) => r.method === "layout.apply");
    expect(applies.map((a) => a.params["tab_label"])).toEqual([`openrig:rig:${RIG}#tok/1`, `openrig:rig:${RIG}#tok/2`]);
    expect(applies.map((a) => cellSeats(a.params["root"]).length)).toEqual([16, 1]);
    expect([...cellSeats(applies[0]!.params["root"]), ...cellSeats(applies[1]!.params["root"])]).toEqual(rows.map((r) => r.canonicalSessionName));
  });

  it("the first tab is a 4×4 equal grid; the preview plan pages the same way", async () => {
    const { transport } = herdrTransport();
    const { svc } = service(new HerdrAdapter({ transportFactory: () => transport }));
    const preview = await svc.previewView({ view: `rig:${RIG}` }) as { grids: Array<{ columns: number; rows: number; blanks: number }>; composed: ComposedView };
    expect(preview.composed.pages.map((p) => p.length)).toEqual([16, 1]);
    expect(preview.grids.map((g) => [g.columns, g.rows, g.blanks])).toEqual([[4, 4, 0], [1, 1, 0]]);
    expect(HERDR_PANES_PER_PAGE).toBe(16);
  });

  it("after layout it focuses the first populated tab, then closes the blank starting tab", async () => {
    const { transport, requests } = herdrTransport();
    const { svc } = service(new HerdrAdapter({ transportFactory: () => transport }));
    const res = await svc.openView({ view: `rig:${RIG}` });
    expect(requests.map((r) => r.method)).toEqual(["workspace.create", "layout.apply", "layout.apply", "tab.focus", "tab.close"]);
    expect(requests[3]!.params).toEqual({ tab_id: "w1:t1" });
    expect(requests[4]!.params).toEqual({ tab_id: "w1:t0" });
    expect(res.notes).toBeUndefined();
  });

  it("never closes a tab that holds a page, even if herdr reuses the starting tab", async () => {
    const { transport, requests } = herdrTransport((m) =>
      m === "workspace.create" ? { type: "c", workspace: { workspace_id: "w1" }, tab: { tab_id: "w1:t0" } }
        : m === "layout.apply" ? { type: "l", layout: { tab_id: "w1:t0" } } : { type: "ok" });
    const { svc } = service(new HerdrAdapter({ transportFactory: () => transport }));
    await svc.openView({ view: `rig:${RIG}` });
    expect(requests.some((r) => r.method === "tab.close")).toBe(false);
  });

  it("re-opening creates a second space with the same name and different tab labels", async () => {
    const { transport, requests } = herdrTransport();
    let n = 0;
    const { svc } = service(new HerdrAdapter({ transportFactory: () => transport, newLaunchToken: () => `l${++n}` }));
    await svc.openView({ view: `rig:${RIG}` });
    await svc.openView({ view: `rig:${RIG}` });
    const creates = requests.filter((r) => r.method === "workspace.create");
    expect(creates.map((c) => c.params["label"])).toEqual([RIG, RIG]);
    const labels = requests.filter((r) => r.method === "layout.apply").map((a) => a.params["tab_label"]);
    expect(new Set(labels).size).toBe(4);
    expect(labels[0]).not.toBe(labels[2]);
  });

  it("if herdr refuses a duplicate name, it retries with a numbered suffix and says so", async () => {
    const { transport, requests } = herdrTransport((m, p) => {
      if (m === "workspace.create") {
        if (p["label"] === RIG) throw new Error("label already in use");
        return { type: "c", workspace: { workspace_id: "w2" }, tab: { tab_id: "w2:t0" } };
      }
      if (m === "workspace.list") return { type: "workspaces", workspaces: [{ label: RIG }, { label: `${RIG} (2)` }] };
      if (m === "layout.apply") return { type: "l", layout: { tab_id: "w2:t1" } };
      return { type: "ok" };
    });
    const { svc } = service(new HerdrAdapter({ transportFactory: () => transport }));
    const res = await svc.openView({ view: `rig:${RIG}` });
    expect(requests.filter((r) => r.method === "workspace.create").map((c) => c.params["label"])).toEqual([RIG, `${RIG} (3)`]);
    expect(res.ok).toBe(true);
    expect(res.notes).toEqual([`A workspace named "${RIG}" already exists, so this one is "${RIG} (3)".`]);
  });

  it("a refused focus or close is a note; the opened seats are unchanged", async () => {
    const { transport } = herdrTransport((m, _p, n) => {
      if (m === "workspace.create") return { type: "c", workspace: { workspace_id: "w1" }, tab: { tab_id: "w1:t0" } };
      if (m === "layout.apply") return { type: "l", layout: { tab_id: `w1:t${n + 1}` } };
      throw new Error(`${m} unsupported`);
    });
    const { svc } = service(new HerdrAdapter({ transportFactory: () => transport }));
    const res = await svc.openView({ view: `rig:${RIG}` });
    expect(res.opened).toHaveLength(17);
    expect(res.degraded).toEqual([]);
    expect(res.notes).toEqual(["herdr did not focus the first tab: tab.focus unsupported", "herdr kept the blank starting tab: tab.close unsupported"]);
  });

  it("honest partials: a page herdr refuses names its seats as degraded; the tile count never overclaims", async () => {
    let applyCall = 0;
    const { transport } = herdrTransport((m) => {
      if (m === "workspace.create") return { type: "c", workspace: { workspace_id: "w1" }, tab: { tab_id: "w1:t0" } };
      if (m === "layout.apply") { applyCall++; if (applyCall === 2) throw new Error("page refused"); return { type: "l", layout: { tab_id: "w1:t1" } }; }
      return { type: "ok" };
    });
    const { svc } = service(new HerdrAdapter({ transportFactory: () => transport }));
    const res = await svc.openView({ view: `rig:${RIG}` });
    expect(res.opened).toHaveLength(16);
    expect(res.degraded.map((d) => d.seat)).toEqual([rows[16]!.canonicalSessionName]);
    expect(res.degraded[0]!.reason).toContain("page refused");
  });
});

describe("S08 correction — the starting tab is kept unless it is known blank", () => {
  const create = { type: "c", workspace: { workspace_id: "w1" }, tab: { tab_id: "t0" } };
  const closes = (reqs: Req[]) => reqs.filter((r) => r.method === "tab.close");
  const KEPT = "The starting tab was kept because it could not be confirmed empty.";

  it("a page applied without a tab id (maybe into the starting tab) keeps the starting tab; the known page is focused", async () => {
    let n = 0;
    const { transport, requests } = herdrTransport((m) => {
      if (m === "workspace.create") return create;
      if (m === "layout.apply") { n++; return n === 1 ? { type: "l" } : { type: "l", layout: { tab_id: "t2" } }; }
      return { type: "ok" };
    });
    const { svc } = service(new HerdrAdapter({ transportFactory: () => transport }));
    const res = await svc.openView({ view: `rig:${RIG}` });
    expect(closes(requests)).toEqual([]);
    expect(requests.find((r) => r.method === "tab.focus")!.params).toEqual({ tab_id: "t2" });
    expect(res.opened).toHaveLength(17);
    expect(res.notes).toEqual([KEPT]);
  });

  it("no page reports a tab id: no focus and no close, both said", async () => {
    const { transport, requests } = herdrTransport((m) => (m === "workspace.create" ? create : { type: "l" }));
    const { svc } = service(new HerdrAdapter({ transportFactory: () => transport }));
    const res = await svc.openView({ view: `rig:${RIG}` });
    expect(requests.map((r) => r.method)).toEqual(["workspace.create", "layout.apply", "layout.apply"]);
    expect(res.notes).toEqual(["herdr returned no tab id for any page, so no tab was focused explicitly.", KEPT]);
  });

  it("a failed apply (which may still have taken effect) keeps the starting tab; its seats stay degraded, not counted", async () => {
    let n = 0;
    const { transport, requests } = herdrTransport((m) => {
      if (m === "workspace.create") return create;
      if (m === "layout.apply") { n++; if (n === 1) throw new Error("reply lost"); return { type: "l", layout: { tab_id: "t2" } }; }
      return { type: "ok" };
    });
    const { svc } = service(new HerdrAdapter({ transportFactory: () => transport }));
    const res = await svc.openView({ view: `rig:${RIG}` });
    expect(closes(requests)).toEqual([]);
    expect(res.opened).toEqual([rows[16]!.canonicalSessionName]);
    expect(res.degraded).toHaveLength(16);
    expect(res.notes).toEqual([KEPT]);
  });

  it("every page fails: nothing is focused or closed", async () => {
    const { transport, requests } = herdrTransport((m) => { if (m === "workspace.create") return create; throw new Error("refused"); });
    const { svc } = service(new HerdrAdapter({ transportFactory: () => transport }));
    const res = await svc.openView({ view: `rig:${RIG}` });
    expect(requests.map((r) => r.method)).toEqual(["workspace.create", "layout.apply", "layout.apply"]);
    expect(res.opened).toEqual([]);
    expect(res.degraded).toHaveLength(17);
  });

  it("all pages known and none is the starting tab: the close still happens", async () => {
    const { transport, requests } = herdrTransport();
    const { svc } = service(new HerdrAdapter({ transportFactory: () => transport }));
    const res = await svc.openView({ view: `rig:${RIG}` });
    expect(closes(requests).map((r) => r.params)).toEqual([{ tab_id: "w1:t0" }]);
    expect(res.notes).toBeUndefined();
  });
});

describe("S08 correction — catalog pages match the Herdr open", () => {
  const ten = rows.slice(0, 10);
  const saved = { id: "ten", name: "Ten", members: ten.map((r) => ({ seat: r.canonicalSessionName, tmuxSession: r.tmuxSession })) };
  function catalogService(batch: boolean): TerminalService {
    const { transport } = herdrTransport();
    const herdr = new HerdrAdapter({ transportFactory: () => transport });
    return new TerminalService({
      resolveProvider: (n) => (n === "herdr" ? herdr : null),
      viewsStore: { get: (id) => (id === "ten" ? saved : null), list: () => [saved] },
      listRigSeats: (r) => (r === RIG ? ten : null),
      ...(batch ? { listRigSeatsBatch: (names: string[]) => new Map(names.map((n) => [n, n === RIG ? ten : []])) } : {}),
      listPodSeats: () => null, listScopeSeats: () => null, listRigNames: () => [RIG],
      resolveHost: () => null, hasSession: () => true,
    } as TerminalServiceDeps);
  }

  for (const batch of [false, true]) {
    it(`${batch ? "batch" : "fallback"} inventory: saved and derived entries show 1 page for 10 seats, like preview`, async () => {
      const svc = catalogService(batch);
      const views = await svc.listViews(true);
      const pages = Object.fromEntries((views.catalog ?? []).map((e) => [e.view, e.pages]));
      expect(pages).toEqual({ "saved:ten": 1, [`rig:${RIG}`]: 1 });
      const preview = await svc.previewView({ view: "saved:ten" }) as { composed: ComposedView };
      expect(preview.composed.pages).toHaveLength(1);
    });
  }
});

describe("S08 — cmux is unchanged", () => {
  it("cmux still pages at the default 9 and keeps its 12-per-workspace and 2-column limits", async () => {
    const { transport } = herdrTransport();
    const { svc, cmux } = service(new HerdrAdapter({ transportFactory: () => transport }));
    await svc.openView({ view: `rig:${RIG}`, provider: "cmux" });
    expect(cmux.last!.pages.map((p) => p.length)).toEqual([9, 8]);
    expect(PANES_PER_PAGE).toBe(9);
    expect(MAX_PER_WORKSPACE).toBe(12);
    expect(MAX_COLS).toBe(2);
  });

  it("the workspace name rule is Herdr-only: a mission/slice/saved view keeps its view id", () => {
    const view: ComposedView = { id: "mission:4.6", opened: [], absent: [], degraded: [], pages: [] };
    expect(planHerdrLayout(view, "t").workspaceLabel).toBe("mission:4.6");
  });
});
