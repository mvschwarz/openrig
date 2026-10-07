import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { TerminalService } from "../../daemon/src/domain/terminal/terminal-service.js";
import { HerdrAdapter } from "../../daemon/src/domain/terminal/herdr-adapter.js";
import { terminalRoutes } from "../../daemon/src/routes/terminal.js";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { createViewState, emptySnapshot, computeExplorerRows } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { terminalLines } from "../src/terminals/terminal-model.js";
import { parseCommand } from "../src/grammar.js";
import type { FleetSnapshot, ViewStateStore } from "../src/types.js";

let snap: FleetSnapshot, view: ViewStateStore, client: DaemonClient, service: TerminalService;
let effects: Array<{ method: string; params: any }>, requests: string[], alive: boolean, providerAlive: boolean, failPage: boolean;
beforeEach(() => {
  effects = []; requests = []; alive = true; providerAlive = true; failPage = false;
  const provider = new HerdrAdapter({ transportFactory: () => ({
    probe: async () => ({ alive: providerAlive, version: "fixture", protocol: 1 }),
    request: async (method, params) => {
      effects.push({ method, params });
      if (failPage && method === "layout.apply") throw new Error("fixture layout refused");
      return { type: "fixture", workspace: { workspace_id: "own-fixture" } };
    },
  }) });
  const saved = { id: "fixture", name: "Reading room", members: [
    ...Array.from({ length: 19 }, (_, i) => ({ seat: `member-${i + 1}`, tmuxSession: `member-${i + 1}`, readOnly: i === 0 })),
    { seat: "missing", tmuxSession: "missing" }, { seat: "remote-http", host: "http" },
  ] };
  service = new TerminalService({ resolveProvider: name => name === "herdr" ? provider : null, viewsStore: { get: id => id === "fixture" ? saved : null, list: () => [saved] }, listRigNames: () => ["fixture"], listRigSeats: name => name === "fixture" ? [{ canonicalSessionName: "derived", tmuxSession: "member-1", attachmentType: "tmux", rigName: "fixture", logicalId: "derived" }] : null, listPodSeats: () => null, listScopeSeats: () => null, resolveHost: () => ({ id: "http", transport: "http", url: "http://fixture" }) as any, hasSession: name => name !== "missing" && (alive || name !== "member-1") });
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("terminalService" as never, service); await next(); });
  app.route("/api/terminal", terminalRoutes());
  client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async (url, init) => {
    const u = new URL(String(url)); requests.push(`${init?.method ?? "GET"} ${u.pathname}`);
    return app.request(u.pathname + u.search, init);
  }) as typeof fetch });
  snap = emptySnapshot(); view = createViewState({ instanceId: "fixture", getSnapshot: () => snap });
});
async function refresh() { snap = await hydrateSnapshot(client, undefined, null, null, null, view.get()); }
function draw(cols: number, rows: number) {
  const screen = renderScreen(view.get(), snap, { cols, rows });
  view.dispatch({ type: "layout", contentMaxOffset: screen.contentMaxOffset, contentTargetCount: screen.contentTargets.length });
  return renderScreen(view.get(), snap, { cols, rows });
}

describe("terminal browser → preview → explicit Open", () => {
  it.each([[140, 42], [80, 24]])("uses the opened plan, pages and Back at %ix%i", async (cols, rows) => {
    view.dispatch(parseCommand("terminals", view.get().sections)); await refresh();
    expect(snap.terminals?.catalog.map(e => [e.kind, e.readinessUnverified, e.members.length])).toEqual([["saved", true, 21], ["derived", true, 0]]);
    const savedRow = computeExplorerRows(view.get(), snap).findIndex(r => r.key === "terminal:saved:fixture");
    view.dispatch({ type: "select", index: savedRow });
    const before = view.get();
    view.dispatch({ type: "activate" }); await refresh();
    expect(view.get().terminalView).toBe("saved:fixture");
    let screen = draw(cols, rows);
    expect(screen.lines.every(line => line.length <= cols && !/[\r\n]/.test(line))).toBe(true);
    expect(screen.lines.join("\n")).toContain("Open in Herdr");
    const preview = snap.terminals!.preview!;
    // OPR.0.6.0.8: Herdr pages hold 16 (4×4); 19 openable members → 16 + 3 (2×2, one blank).
    expect(preview.grids.map(g => [g.columns, g.rows, g.blanks])).toEqual([[4, 4, 0], [2, 2, 1]]);
    view.dispatch({ type: "terminal-page", page: 1 }); await refresh();
    const detail = terminalLines(view.get(), snap, 50).map(l => l.text).join("\n");
    expect(detail).toContain("blank"); expect(detail).toContain("member-19"); expect(detail).toContain("Unavailable · missing"); expect(detail).toContain("remote-http");
    screen = draw(cols, rows);
    expect(screen.lines.join("\n")).toContain("Page 2/2");
    expect(effects).toEqual([]); expect(requests.every(r => r.startsWith("GET /api/terminal/"))).toBe(true);
    // Attention is a side trip: Help and Back must preserve this exact preview page.
    view.dispatch(parseCommand("attention"));
    view.dispatch({ type: "attention-open", id: "queue:fixture-request" });
    view.dispatch({ type: "palette-open" });
    expect(draw(cols, rows).lines.join("\n")).toContain("Esc return");
    view.dispatch({ type: "palette-close" });
    expect(view.get().attentionOpen).toBe("queue:fixture-request");
    view.dispatch({ type: "back" });
    expect(view.get().attentionOpen).toBeNull();
    view.dispatch({ type: "back" }); await refresh();
    expect(view.get()).toMatchObject({ section: "terminals", terminalView: "saved:fixture", terminalPage: 1 });
    screen = draw(cols, rows);
    expect(screen.lines.join("\n")).toContain("Page 2/2");
    const open = screen.contentTargets.find(t => t.action.type === "act")!.action;
    if (open.type !== "act" || open.act !== "open-terminal") throw new Error("missing explicit Open");
    const result = await client.openTerminal(open.view, open.expectedPlan);
    expect(result.opened).toEqual(preview.composed.opened.map(m => m.seat));
    expect(result.absent).toHaveLength(1); expect(result.degraded).toHaveLength(1);
    expect(effects.map(e => e.method)).toEqual(["workspace.create", "layout.apply", "layout.apply"]);
    expect(effects.filter(e => e.method === "layout.apply").map(e => e.params.root)).toEqual((preview.grids as any[]).map(g => g.root));
    view.dispatch({ type: "back" }); await refresh();
    expect(view.get().terminalView).toBe(before.terminalView);
    expect(view.get().selection).toBe(before.selection);
  });

  it("refuses a changed plan before any launch, then allows a fresh preview", async () => {
    const p = await client.previewTerminal("saved:fixture"); alive = false;
    await expect(client.openTerminal(p.view, p.planId)).rejects.toThrow(/409.*changed/);
    expect(effects).toEqual([]);
    const fresh = await client.previewTerminal(p.view);
    expect(fresh.planId).not.toBe(p.planId);
    expect((await client.openTerminal(fresh.view, fresh.planId)).opened).toHaveLength(18); // 19 openable, one now down
  });

  it("keeps unavailable-provider preview useful with no Open or recovery effect", async () => {
    providerAlive = false;
    view.dispatch({ type: "terminal-preview", view: "saved:fixture" }); await refresh();
    const lines = terminalLines(view.get(), snap, 70);
    expect(lines.map(l => l.text).join("\n")).toContain("Herdr unavailable");
    expect(lines.some(l => l.action?.type === "act")).toBe(false);
    expect(lines.some(l => l.action?.type === "back")).toBe(true);
    const narrow = terminalLines(view.get(), snap, 54).map(line => line.text).join(" ").replace(/\s+/g, " ");
    expect(narrow).toContain("If a command wraps, widen this terminal until it fits on one line before copying.");
    const wide = terminalLines(view.get(), snap, 1000).map(line => line.text);
    expect(wide).toContain("env -u TMUX tmux attach -t 'member-2'");
    expect(effects).toEqual([]);
  });

  it("keeps the selected daemon and remote member in plain-terminal guidance", async () => {
    providerAlive = false;
    const remote = { id: "remote view", name: "Remote", members: [{ seat: "quoted-seat", tmuxSession: "seat with spaces", host: "remote", readOnly: true }] };
    const provider = new HerdrAdapter({ transportFactory: () => ({ probe: async () => ({ alive: false, version: null, protocol: null }), request: async () => { throw new Error("must remain passive"); } }) });
    service = new TerminalService({ resolveProvider: () => provider, viewsStore: { get: () => remote, list: () => [remote] }, listRigNames: () => [], listRigSeats: () => null, listPodSeats: () => null, listScopeSeats: () => null, resolveHost: () => ({ id: "remote", transport: "ssh", target: "other.example", user: "viewer" }) as any, hasSession: () => { throw new Error("remote is not a local session"); } });
    client = new DaemonClient({ baseUrl: "http://selected.example:7654", fetchImpl: (async (url, init) => {
      const u = new URL(String(url));
      const app = new Hono(); app.use("*", async (c, next) => { c.set("terminalService" as never, service); await next(); }); app.route("/api/terminal", terminalRoutes());
      return app.request(u.pathname + u.search, init);
    }) as typeof fetch });
    view.dispatch({ type: "terminal-preview", view: "saved:remote view" }); await refresh();
    const text = terminalLines(view.get(), snap, 1000).map(line => line.text).join("\n");
    expect(text).toContain("http://selected.example:7654");
    expect(text).toContain("saved:remote view");
    expect(text).toContain("machine running that daemon");
    const command = snap.terminals!.preview!.composed.pages[0]![0]!.paneCommand;
    expect(text).toContain(`env -u TMUX ${command.replace(/^ssh /, "ssh -t ")}`);
    expect(text).toContain("viewer@other.example");
    expect(text).toContain("seat with spaces");
    expect(text).toContain("attach -r");
    expect(effects).toEqual([]);
  });

  it("preserves a failed Open as failure, without a success notice", async () => {
    const p = await client.previewTerminal("saved:fixture"); failPage = true;
    await expect(client.openTerminal(p.view, p.planId)).rejects.toThrow("fixture layout refused");
    expect(effects.filter(e => e.method === "layout.apply")).toHaveLength(2);
  });

  it("keeps wrapped partial/failure receipts readable across layout and refresh", async () => {
    view.dispatch({ type: "terminal-preview", view: "saved:fixture" }); await refresh();
    view.dispatch({ type: "terminal-result", view: "saved:fixture", message: "Partial Open: 9 opened, 1 absent, 6 degraded. Herdr refused page two." });
    draw(80, 24); await refresh(); draw(80, 24);
    expect(terminalLines(view.get(), snap, 40).map(l => l.text).join(" ").replace(/\s+/g, " ")).toContain("Herdr refused page two.");
  });
});
