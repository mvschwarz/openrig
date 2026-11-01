import { afterEach, describe, expect, it, vi } from "vitest";
import { exec, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatIdentityReconciler } from "../src/domain/seat-identity-reconciler.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { attachAgentActivity, attachTerminalActivityAndWork, getNodeInventory } from "../src/domain/node-inventory.js";

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function fixture(runtime = "claude-code", pane = "%1", session = "worker@rig") {
  const db = createFullTestDb(); dbs.push(db);
  db.prepare("INSERT INTO rigs (id,name) VALUES ('rig','rig')").run();
  db.prepare("INSERT INTO nodes (id,rig_id,logical_id,runtime,cwd) VALUES ('worker','rig','worker',?,'/tmp')").run(runtime);
  db.prepare("INSERT INTO sessions (id,node_id,session_name,status,startup_status,created_at) VALUES ('session','worker',?,'running','ready','2026-01-01 00:00:00')").run(session);
  db.prepare("INSERT INTO bindings (id,node_id,attachment_type,tmux_session,tmux_pane) VALUES ('binding','worker','tmux',?,?)").run(session,pane);
  return db;
}
function observed(dead?: boolean, command: string | null = "claude") {
  return { listSessions: async () => [{ name: "worker@rig" }] as never,
    listPanes: vi.fn(async () => [{ id: "%1" }] as never),
    getPanePid: vi.fn(async () => 4242), getPaneCommand: vi.fn(async () => command),
    readAllPaneProcesses: async () => new Map([["%1", { pid: 4242, command, ...(dead === undefined ? {} : { dead }) }]]) };
}

describe("retained pane liveness", () => {
  it.each(["claude-code", "codex", "stub"])("retained dead pane is not a running or ready executor: %s", async runtime => {
    const db = fixture(runtime);
    const tmux = observed(true, runtime === "codex" ? "codex" : "claude");
    await new SeatIdentityReconciler({ db, tmux, listProcesses: async () => [] }).reconcileAll();
    expect(new SeatIdentityStore(db).getForNode("worker")).toMatchObject({ verdict: "pane_missing", reason: "pane_exited", evidenceSource: "pane_process" });
    const [entry] = getNodeInventory(db,"rig");
    expect(entry).toMatchObject({ sessionStatus: "exited", startupStatus: "attention_required", storedSessionStatus: "running", storedStartupStatus: "ready", intentionallyStopped: false });
    expect(entry!.lifecycleState).not.toBe("running");
    const stale = vi.fn(() => ({ isActiveWithinWindow: true, lastActivityAt: new Date().toISOString() }));
    const [enriched] = attachTerminalActivityAndWork([entry!], { db, seatActivity: { getSeatActivity: stale, getSeatStateBySession: () => null } as never });
    expect(enriched).toMatchObject({ terminalActive: false, activityState: null, lastActivityAt: null });
    expect(stale).not.toHaveBeenCalled();
    const [activity] = await attachAgentActivity([entry!], { tmuxAdapter: tmux as unknown as TmuxAdapter });
    expect(activity!.agentActivity).toMatchObject({ state: "unknown", reason: "pane_exited", evidenceSource: "pane_process" });
  });

  it.each(["claude-code", "codex", "stub"])("a stale binding to another session's dead pane stays unknown: %s", async runtime => {
    const db = fixture(runtime);
    const tmux = { ...observed(true), listPanes: vi.fn(async () => [{ id: "%2" }] as never) };
    await new SeatIdentityReconciler({ db, tmux, listProcesses: async () => [] }).reconcileAll();
    expect(tmux.listPanes).toHaveBeenCalledWith("worker@rig", true);
    expect(new SeatIdentityStore(db).getForNode("worker")).toMatchObject({ reason: "tmux_unavailable" });
    expect(getNodeInventory(db,"rig")[0]!.sessionStatus).toBe("running");
    expect(getNodeInventory(db,"rig")[0]!.identityVerdict?.reason).not.toBe("pane_exited");
  });
  it.each(["missing", "failed"])("dead evidence with %s membership observation stays unknown", async kind => {
    const db = fixture();
    const tmux = { ...observed(true), listPanes: kind === "missing" ? undefined : vi.fn(async () => { throw Error("unavailable"); }) };
    await new SeatIdentityReconciler({ db, tmux }).reconcileAll();
    expect(new SeatIdentityStore(db).getForNode("worker")).toMatchObject({ reason: "tmux_unavailable" });
    expect(getNodeInventory(db,"rig")[0]!.sessionStatus).toBe("running");
  });

  it("an alive pane with unknown activity is not declared dead", async () => {
    const db = fixture("stub");
    await new SeatIdentityReconciler({ db, tmux: observed(false,null) }).reconcileAll();
    expect(getNodeInventory(db,"rig")[0]).toMatchObject({ sessionStatus: "running", startupStatus: "ready" });
  });
  it("a missing dead-bit observation does not invent an exit", async () => {
    const db = fixture();
    await new SeatIdentityReconciler({ db, tmux: observed() }).reconcileAll();
    expect(getNodeInventory(db,"rig")[0]).toMatchObject({ sessionStatus: "running", startupStatus: "ready" });
  });
  it("an exited predecessor cannot down-rank a newly bound pane", async () => {
    const db = fixture();
    await new SeatIdentityReconciler({ db, tmux: observed(true) }).reconcileAll();
    db.prepare("UPDATE bindings SET tmux_pane='%2' WHERE node_id='worker'").run();
    expect(getNodeInventory(db,"rig")[0]).toMatchObject({ sessionStatus: "running", startupStatus: "ready", identityVerdict: null });
  });
  it("the existing batch carries explicit pane death without losing a separator in the command", async () => {
    const run = vi.fn(async () => "%1|4242|1|old|command\n%2|4343|0|claude\n%3|0|1|sh\n");
    const batch = await new TmuxAdapter(run as never).readAllPaneProcesses();
    expect(batch!.get("%1")).toEqual({ pid: 4242, command: "old|command", dead: true });
    expect(batch!.get("%2")).toEqual({ pid: 4343, command: "claude", dead: false });
    expect(batch!.get("%3")).toEqual({ pid: null, command: "sh", dead: true });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

let hasTmux = true;
try { execFileSync("tmux",["-V"],{ stdio:"ignore" }); } catch { hasTmux = false; }
it.skipIf(!hasTmux)("a real private tmux retained exit is not reported running/ready", async () => {
  const socket = `dead-pane-${process.pid}-${randomUUID().slice(0,8)}`;
  const file = promisify(execFile), shell = promisify(exec);
  const env = { ...process.env, TMUX: "" };
  const run = (args: string[]) => file("tmux",["-L",socket,"-f","/dev/null",...args],{env});
  try {
    await run(["new-session","-d","-s","worker@rig","/bin/sh"]);
    const pane = (await run(["new-window","-d","-P","-F","#{pane_id}","-t","worker@rig","/bin/sh"])).stdout.trim();
    expect(pane).toMatch(/^%\d+$/); // bind the created pane, never an empty/default target
    await run(["set-window-option","-t",pane,"remain-on-exit","on"]);
    await run(["send-keys","-t",pane,"exit 0","Enter"]);
    const tmux = new TmuxAdapter(async cmd => (await shell(cmd.replace(/^tmux /,`tmux -L ${socket} -f /dev/null `),{env})).stdout);
    await vi.waitFor(async () => expect(await tmux.isPaneDead(pane)).toBe(true),{timeout:3000});
    expect((await tmux.listSessions()).map(s => s.name)).toEqual(["worker@rig"]);
    const db = fixture("claude-code",pane);
    expect(db.prepare("SELECT tmux_pane FROM bindings WHERE node_id='worker'").get()).toEqual({ tmux_pane:pane });
    await new SeatIdentityReconciler({db,tmux}).reconcileAll();
    expect(getNodeInventory(db,"rig")[0]).toMatchObject({ sessionStatus:"exited", startupStatus:"attention_required", identityVerdict:{reason:"pane_exited"} });
  } finally { await run(["kill-server"]).catch(() => {}); }
},10000);
