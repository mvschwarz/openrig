import { describe, expect, it } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { HerdrSeatAdapter } from "../src/adapters/herdr-seat.js";
import { HerdrRpcError, type HerdrResult } from "../src/domain/terminal/herdr-transport.js";
import { createTerminalRouter, SubstrateResolver } from "../src/adapters/terminal-router.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

/** A minimal in-memory Herdr: workspaces with one pane each, the socket methods the seat adapter uses. */
function fakeHerdr() {
  const workspaces = new Map<string, { label: string; panes: string[]; env: Record<string, string> }>();
  const screen = new Map<string, string>();
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  let next = 1;
  let down = false;
  const rpc = async (req: { id: string; method: string; params: unknown }): Promise<HerdrResult> => {
    if (down) throw new Error("connect ECONNREFUSED");
    const p = (req.params ?? {}) as Record<string, unknown>;
    sent.push({ method: req.method, params: p });
    const ws = (id: unknown) => {
      const w = workspaces.get(String(id));
      if (!w) throw new HerdrRpcError(`herdr error: workspace ${id} not found`, "workspace_not_found");
      return w;
    };
    const paneWs = (pane: unknown) => {
      const id = String(pane).split(":")[0]!;
      const w = workspaces.get(id);
      if (!w || !w.panes.includes(String(pane))) throw new HerdrRpcError(`herdr error: pane ${pane} not found`, "pane_not_found");
      return w;
    };
    switch (req.method) {
      case "ping": return { type: "pong", version: "0.9.5" };
      case "workspace.list": return { type: "workspace_list", workspaces: [...workspaces].map(([id, w]) => ({ workspace_id: id, label: w.label, pane_count: w.panes.length })) };
      case "workspace.get": { const w = ws(p["workspace_id"]); return { type: "workspace_info", workspace: { workspace_id: p["workspace_id"], label: w.label } }; }
      case "workspace.create": {
        const id = `w${next++}`; const pane = `${id}:p1`;
        workspaces.set(id, { label: String(p["label"]), panes: [pane], env: (p["env"] ?? {}) as Record<string, string> });
        return { type: "workspace_created", workspace: { workspace_id: id, label: p["label"] }, root_pane: { pane_id: pane, workspace_id: id } };
      }
      case "workspace.close": ws(p["workspace_id"]); workspaces.delete(String(p["workspace_id"])); return { type: "workspace_closed" };
      case "pane.list": { const w = ws(p["workspace_id"]); return { type: "pane_list", panes: w.panes.map(id => ({ pane_id: id, workspace_id: p["workspace_id"] })) }; }
      case "pane.send_text": case "pane.send_keys": paneWs(p["pane_id"]); return { type: "ok" };
      case "pane.read": paneWs(p["pane_id"]); return { type: "pane_read", read: { text: screen.get(String(p["pane_id"])) ?? `screen of ${p["pane_id"]}` } };
      case "pane.process_info": paneWs(p["pane_id"]); return { type: "pane_process_info", process_info: { shell_pid: 4242, foreground_processes: [{ pid: 4243, name: "claude" }] } };
      // Like Herdr 0.9.5 (measured in the M4 sandbox): revision does NOT advance on output.
      case "pane.layout": paneWs(p["pane_id"]); return { type: "pane_layout", layout: { panes: [{ pane_id: p["pane_id"], focused: true, rect: { x: 0, y: 0, width: 120, height: 40 } }] } };
      case "pane.get": paneWs(p["pane_id"]); return { type: "pane_info", pane: { pane_id: p["pane_id"], agent_status: "idle", revision: 1 } };
      default: throw new HerdrRpcError(`herdr error: unknown method ${req.method}`, "unknown_method");
    }
  };
  const output = (pane: string, text: string) => { screen.set(pane, text); };
  return { rpc, workspaces, sent, output, setDown: (v: boolean) => { down = v; } };
}

function setup(extra: { now?: () => number } = {}) {
  const db = createFullTestDb();
  const repo = new RigRepository(db);
  const rig = repo.createRig("hr");
  const node = repo.addNode(rig.id, "dev.solo", { runtime: "terminal", terminalSubstrate: "herdr" });
  const herdr = fakeHerdr();
  const adapter = new HerdrSeatAdapter({ db, socketForNewSeats: () => "/sandbox/herdr.sock", rpcFor: () => herdr.rpc, now: extra.now });
  const bind = (session: string, pane: string) =>
    db.prepare("INSERT INTO bindings (id, node_id, tmux_session, tmux_pane) VALUES (?, ?, ?, ?)").run(`b-${node.id}`, node.id, session, pane);
  return { db, repo, node, herdr, adapter, bind };
}

describe("HerdrSeatAdapter", () => {
  it("creates a seat as a Herdr workspace labelled with its session name and stores the ids on the binding", async () => {
    const { db, adapter, herdr, bind } = setup();
    expect(await adapter.createSession("dev-solo@hr", "/tmp", { FOO: "bar" })).toEqual({ ok: true });
    expect([...herdr.workspaces.values()][0]).toMatchObject({ label: "dev-solo@hr", env: expect.objectContaining({ FOO: "bar" }) });
    expect((await adapter.listPanes("dev-solo@hr")).map(p => p.id)).toEqual(["w1:p1"]);
    bind("dev-solo@hr", "w1:p1");
    expect(await adapter.probeSession("dev-solo@hr")).toEqual({ state: "present" });
    expect(db.prepare("SELECT herdr_workspace, herdr_socket FROM bindings").get()).toEqual({ herdr_workspace: "w1", herdr_socket: "/sandbox/herdr.sock" });
    // FOO isn't read back by value, so only its presence is kept (F3).
    expect(await adapter.getSessionEnv("dev-solo@hr", "FOO")).toBeUndefined();
    expect(await adapter.hasSessionEnv("dev-solo@hr", "FOO")).toBe(true);
  });

  it("refuses a duplicate label", async () => {
    const { adapter } = setup();
    await adapter.createSession("dev-solo@hr");
    expect(await adapter.createSession("dev-solo@hr")).toMatchObject({ ok: false, code: "duplicate_session" });
  });

  it("sends text (bracketed), keys and reads through the seat's own pane", async () => {
    const { adapter, herdr, bind } = setup();
    await adapter.createSession("dev-solo@hr");
    bind("dev-solo@hr", "w1:p1");
    expect(await adapter.sendText("dev-solo@hr", "hello")).toEqual({ ok: true });
    expect(await adapter.sendKeys("dev-solo@hr", ["Enter"])).toEqual({ ok: true });
    expect(herdr.sent.filter(s => s.method.startsWith("pane.send"))).toEqual([
      { method: "pane.send_text", params: { pane_id: "w1:p1", text: "\u001b[200~hello\u001b[201~" } },
      { method: "pane.send_keys", params: { pane_id: "w1:p1", keys: ["enter"] } },
    ]);
    expect(await adapter.capturePaneContent("w1:p1", 30)).toBe("screen of w1:p1");
    expect(await adapter.getPaneCommand("w1:p1")).toBe("claude");
    expect(await adapter.getPanePid("w1:p1")).toBe(4242);
    expect(await adapter.agentStatus("dev-solo@hr")).toBe("idle");
  });

  it("R1: a verb Herdr lacks is refused as herdr_unsupported, never as absence", async () => {
    const { adapter } = setup();
    expect(await adapter.respawnPane("w1:p1")).toMatchObject({ ok: false, code: "herdr_unsupported" });
    expect(await adapter.sendKeys("w1:p1", ["F13"])).toMatchObject({ ok: false, code: "herdr_unsupported" });
    expect(await adapter.createProbeSession("probe")).toMatchObject({ ok: false, code: "herdr_unsupported" });
  });

  it("R2: an unreachable Herdr is transport_unavailable, not an absent session or a dead pane", async () => {
    const { adapter, herdr, bind } = setup();
    await adapter.createSession("dev-solo@hr");
    bind("dev-solo@hr", "w1:p1");
    herdr.setDown(true);
    expect(await adapter.probeSession("dev-solo@hr")).toMatchObject({ state: "transport_unavailable" });
    await expect(adapter.listPanes("dev-solo@hr")).rejects.toMatchObject({ resultCode: "transport_unavailable" });
    await expect(adapter.listSessions()).rejects.toMatchObject({ resultCode: "transport_unavailable" });
    expect(await adapter.isPaneDead("w1:p1")).toBe(false);
    herdr.setDown(false);
    herdr.workspaces.clear();
    expect(await adapter.probeSession("dev-solo@hr")).toEqual({ state: "absent" });
    expect(await adapter.isPaneDead("w1:p1")).toBe(true);
  });

  it("R4: a renamed or replaced workspace is not the seat any more", async () => {
    const { adapter, herdr, bind } = setup();
    await adapter.createSession("dev-solo@hr");
    bind("dev-solo@hr", "w1:p1");
    herdr.workspaces.get("w1")!.label = "renamed";
    expect(await adapter.probeSession("dev-solo@hr")).toEqual({ state: "absent" });
    expect(await adapter.sendText("dev-solo@hr", "x")).toMatchObject({ ok: false });
    expect(herdr.sent.some(s => s.method === "pane.send_text")).toBe(false);
  });

  it("D4: whole-server reads list only DB-known seats, not the person's other Herdr workspaces", async () => {
    const { adapter, herdr, bind } = setup();
    herdr.workspaces.set("w9", { label: "person's own workspace", panes: ["w9:p1"], env: {} });
    await adapter.createSession("dev-solo@hr");
    bind("dev-solo@hr", "w1:p1");
    expect((await adapter.listSessions()).map(s => s.name)).toEqual(["dev-solo@hr"]);
    expect([...(await adapter.readAllPaneProcesses())!.keys()]).toEqual(["w1:p1"]);
  });

  it("router: a merged read fails when a Herdr endpoint with seats is down, and keeps the tmux half otherwise", async () => {
    const { db, adapter, herdr, bind } = setup();
    await adapter.createSession("dev-solo@hr");
    bind("dev-solo@hr", "w1:p1");
    const tmux = Object.create({ listSessions: async () => [{ name: "tmux-seat", windows: 1, created: "", attached: false }] }) as TmuxAdapter;
    const router = createTerminalRouter(tmux, { resolver: new SubstrateResolver(db), herdr: adapter });
    expect((await router.listSessions()).map(s => s.name)).toEqual(["tmux-seat", "dev-solo@hr"]);
    herdr.setDown(true);
    await expect(router.listSessions()).rejects.toBeTruthy();
  });
});

describe("HerdrSeatAdapter activity and transcripts (M3)", () => {
  it("S1: a screen change records the receive time; an unreachable endpoint reads unknown", async () => {
    let t = 1_000_000;
    const { adapter, herdr, bind } = setup({ now: () => t });
    await adapter.createSession("dev-solo@hr");
    bind("dev-solo@hr", "w1:p1");
    // First sight records a baseline (S1): a quiet seat reads idle once the window passes, never unknown forever.
    expect(await adapter.readAllSessionWindowActivity()).toEqual(new Map([["dev-solo@hr", 1000]]));
    t += 5_000; herdr.output("w1:p1", "a\n");
    expect(await adapter.readAllSessionWindowActivity()).toEqual(new Map([["dev-solo@hr", 1005]]));
    t += 5_000;
    expect(await adapter.readAllSessionWindowActivity()).toEqual(new Map([["dev-solo@hr", 1005]])); // no change: keeps time
    herdr.setDown(true);
    expect(await adapter.readAllSessionWindowActivity()).toEqual(new Map()); // unknown, not idle
    expect(adapter.lastAgentStatus("dev-solo@hr")).toBe("idle");
  });

  it("refuses pipe-pane (the web terminal live view) explicitly", async () => {
    const { adapter } = setup();
    expect(await adapter.startPipePane("dev-solo@hr", "/t/x.log")).toMatchObject({ ok: false, code: "herdr_unsupported" });
  });
});

describe("HerdrSeatAdapter review fixes (F1-F5)", () => {
  it("F3: stores identity env by value and every other variable as presence only", async () => {
    const { db, adapter, bind } = setup();
    await adapter.createSession("dev-solo@hr", "/tmp", { OPENRIG_NODE_ID: "n1", OPENRIG_ACTIVITY_HOOK_TOKEN: "secret-token", ANTHROPIC_API_KEY: "sk-x" });
    bind("dev-solo@hr", "w1:p1");
    const stored = JSON.stringify(db.prepare("SELECT * FROM herdr_session_meta").all());
    expect(stored).not.toContain("secret-token");
    expect(stored).not.toContain("sk-x");
    expect(await adapter.getSessionEnv("dev-solo@hr", "OPENRIG_NODE_ID")).toBe("n1");
    expect(await adapter.getSessionEnv("dev-solo@hr", "OPENRIG_ACTIVITY_HOOK_TOKEN")).toBeUndefined();
    expect(await adapter.hasSessionEnv("dev-solo@hr", "OPENRIG_ACTIVITY_HOOK_TOKEN")).toBe(true);
  });

  it("F4: a Herdr pane id that belongs to no known seat is refused, never written to", async () => {
    const { adapter, herdr } = setup();
    herdr.workspaces.set("w9", { label: "person's own", panes: ["w9:p1"], env: {} });
    expect(await adapter.sendText("w9:p1", "x")).toMatchObject({ ok: false, code: "guard_target_unknown" });
    expect(await adapter.sendKeys("w9:p1", ["Enter"])).toMatchObject({ ok: false, code: "guard_target_unknown" });
    expect(herdr.sent.some(s => s.method.startsWith("pane.send"))).toBe(false);
  });

  it("F5: after a restart, a seat whose binding lacks the Herdr ids keeps its own endpoint, not the current setting", async () => {
    const { db, herdr, bind } = setup();
    const first = new HerdrSeatAdapter({ db, socketForNewSeats: () => "/sandbox/A.sock", rpcFor: () => herdr.rpc });
    await first.createSession("dev-solo@hr");
    bind("dev-solo@hr", "w1:p1"); // the launcher's binding, without herdr_workspace/socket
    const sockets: string[] = [];
    const restarted = new HerdrSeatAdapter({ db, socketForNewSeats: () => "/sandbox/B.sock", rpcFor: (s) => { sockets.push(s); return herdr.rpc; } });
    expect(await restarted.probeSession("dev-solo@hr")).toEqual({ state: "present" });
    expect(sockets).toEqual(["/sandbox/A.sock"]);
    expect(db.prepare("SELECT herdr_workspace, herdr_socket FROM bindings").get()).toEqual({ herdr_workspace: "w1", herdr_socket: "/sandbox/A.sock" });
  });

  it("F1: non-decimal Herdr ids are recognised", async () => {
    const { adapter, herdr, db } = setup();
    herdr.workspaces.set("w3A", { label: "dev-solo@hr", panes: ["w3A:p2"], env: {} });
    db.prepare("INSERT INTO bindings (id, node_id, tmux_session, tmux_pane, herdr_workspace, herdr_socket) SELECT 'b1', id, 'dev-solo@hr', 'w3A:p2', 'w3A', '/sandbox/herdr.sock' FROM nodes").run();
    expect(await adapter.sendText("w3A:p2", "x")).toEqual({ ok: true });
  });
});

describe("HerdrSeatAdapter should-fix items (S1-S4, size)", () => {
  it("reports pane sizes from Herdr's layout", async () => {
    const { adapter, bind } = setup();
    await adapter.createSession("dev-solo@hr");
    bind("dev-solo@hr", "w1:p1");
    expect(await adapter.listPanes("dev-solo@hr")).toMatchObject([{ id: "w1:p1", width: 120, height: 40 }]);
  });

  it("S2: closes the workspace it made when recording the seat fails", async () => {
    const { db, adapter, herdr } = setup();
    db.exec("DROP TABLE herdr_session_meta"); // recording fails after workspace.create
    expect(await adapter.createSession("dev-solo@hr")).toMatchObject({ ok: false, code: "session_not_created" });
    expect(herdr.workspaces.size).toBe(0);
  });

  it("S4: a pane id bound on two endpoints is ambiguous and refused", async () => {
    const { db, repo, adapter, herdr } = setup();
    const rig2 = repo.createRig("hr2");
    const other = repo.addNode(rig2.id, "dev.two", { runtime: "terminal", terminalSubstrate: "herdr" });
    herdr.workspaces.set("w1", { label: "dev-solo@hr", panes: ["w1:p1"], env: {} });
    db.prepare("INSERT INTO bindings (id, node_id, tmux_session, tmux_pane, herdr_workspace, herdr_socket) SELECT 'b1', id, 'dev-solo@hr', 'w1:p1', 'w1', '/a.sock' FROM nodes WHERE logical_id = 'dev.solo'").run();
    db.prepare("INSERT INTO bindings (id, node_id, tmux_session, tmux_pane, herdr_workspace, herdr_socket) VALUES ('b2', ?, 'dev-two@hr2', 'w1:p1', 'w1', '/b.sock')").run(other.id);
    expect(await adapter.sendText("w1:p1", "x")).toMatchObject({ ok: false, code: "guard_target_unknown" });
    expect(await adapter.sendText("dev-solo@hr", "x")).toEqual({ ok: true }); // by name it is unambiguous
  });
});

describe("CodeRabbit follow-ups on PR #2785", () => {
  it("re-baselines a seat whose reading an outage dropped, without a screen change", async () => {
    let t = 2_000_000;
    const { adapter, herdr, bind } = setup({ now: () => t });
    await adapter.createSession("dev-solo@hr");
    bind("dev-solo@hr", "w1:p1");
    await adapter.readAllSessionWindowActivity();
    herdr.setDown(true);
    expect(await adapter.readAllSessionWindowActivity()).toEqual(new Map()); // unknown during the outage
    herdr.setDown(false); t += 10_000;
    expect(await adapter.readAllSessionWindowActivity()).toEqual(new Map([["dev-solo@hr", 2010]])); // same screen, re-baselined
  });

  it("after a restart before the binding was backfilled, a bulk read still includes the seat (durable record)", async () => {
    const { db, herdr, bind } = setup();
    const first = new HerdrSeatAdapter({ db, socketForNewSeats: () => "/sandbox/A.sock", rpcFor: () => herdr.rpc });
    await first.createSession("dev-solo@hr");
    bind("dev-solo@hr", "w1:p1"); // binding written without herdr_workspace / herdr_socket
    const sockets: string[] = [];
    const restarted = new HerdrSeatAdapter({ db, socketForNewSeats: () => "/sandbox/B.sock", rpcFor: (s) => { sockets.push(s); return herdr.rpc; } });
    // A whole-server read comes first, before any per-seat call could backfill the binding.
    expect((await restarted.listSessions()).map(x => x.name)).toEqual(["dev-solo@hr"]);
    expect(sockets).toEqual(["/sandbox/A.sock"]);
  });
});
