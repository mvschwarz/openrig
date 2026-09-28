import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { ClaimService } from "../src/domain/claim-service.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";

// Real services and private SQLite; terminal/file effects are injected, never executed.
function fixture(hooks: { file?: () => Promise<void>; exec?: (command: string) => Promise<string>; realPanes?: boolean } = {}) {
  const db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
  db.exec(`INSERT INTO rigs(id,name) VALUES ('r','fixture');
    INSERT INTO nodes(id,rig_id,logical_id) VALUES ('a','r','worker');
    INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('ba','a','worker@fixture','%1');
    INSERT INTO sessions(id,node_id,session_name,status) VALUES ('sa','a','worker@fixture','running');
    INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('ga','a',1,'g1','fresh');`);
  const commands: string[] = [];
  const tmux = new TmuxAdapter(async command => {
    commands.push(command);
    return hooks.exec ? hooks.exec(command)
      : command.includes("list-panes") ? "%1|0|/inert|80|24|1\n"
      : command.includes("#{session_id}") ? "$1" : "";
  }, { writeFile: async () => { await hooks.file?.(); }, unlink: async () => {}, tmpName: () => "/inert/buffer", bufferName: () => "inert" });
  const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name)); tmux.deliveryGuard = guard;
  if (!hooks.realPanes) tmux.listPanes = async () => [{ id: "%1" } as never];
  tmux.hasSession = async () => true;
  tmux.getPaneCommand = async () => "bash";
  tmux.probeSession = async () => ({ state: "present" });
  const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db), eventBus = new EventBus(db);
  const deps = { db, tmuxAdapter: tmux, rigRepo, sessionRegistry, eventBus };
  const claim = new ClaimService({ ...deps, discoveryRepo: { db } as never });
  const teardown = new RigTeardownOrchestrator({ ...deps, snapshotCapture: { db, captureSnapshot: () => ({ id: "private" }) } as never });
  const transport = new SessionTransport({ ...deps, sleep: async () => {} });
  return { ...deps, tmux, guard, commands, claim, teardown, transport, outbox: new OutboxHandler(db) };
}
function signal() { let release!: () => void; const ready = new Promise<void>(r => { release = r; }); return { ready, release }; }

describe("guard-wired teardown", () => {
  it("cleans positively missing session through actual exec-to-listPanes", async () => {
    const f = fixture({ realPanes: true, exec: async () => { throw Error("can't find session: worker@fixture"); } });
    expect(await f.teardown.teardown("r")).toMatchObject({ sessionsKilled: 1, errors: [] });
    expect(f.sessionRegistry.getBindingForNode("a")).toBeNull();
    expect(f.db.prepare("SELECT status FROM sessions WHERE id='sa'").get()).toEqual({ status: "exited" });
    expect(f.commands).toHaveLength(1); expect(f.commands[0]).toContain("tmux list-panes"); f.db.close();
  });
  it.each(["no server running on /inert/socket", "permission denied", "operation not permitted: can't find session", "error connecting to /inert/socket (Connection refused)", "error connecting to /inert/socket (No such file or directory)", "probe timed out"])("preserves custody for uncertain failure: %s", async message => {
    const f = fixture({ realPanes: true, exec: async () => { throw Error(message); } });
    const result = await f.teardown.teardown("r");
    expect(result.sessionsKilled).toBe(0); expect(result.errors).toHaveLength(1);
    expect(f.sessionRegistry.getBindingForNode("a")?.tmuxPane).toBe("%1");
    expect(f.db.prepare("SELECT status FROM sessions WHERE id='sa'").get()).toEqual({ status: "running" });
    expect(f.commands).toHaveLength(1); expect(f.commands[0]).toContain("tmux list-panes"); f.db.close();
  });
  it("refuses before probing when on, and terminates the present immutable session when off", async () => {
    const f = fixture({ realPanes: true });
    await f.guard.set("a", true, "person", "draft");
    await expect(f.teardown.teardown("r")).rejects.toMatchObject({ code: "typing_guard_enabled" });
    expect(f.commands).toEqual([]);
    expect(f.sessionRegistry.getBindingForNode("a")?.tmuxPane).toBe("%1");
    await f.guard.set("a", false, "person", "stop");
    expect(await f.teardown.teardown("r")).toMatchObject({ sessionsKilled: 1, errors: [] });
    expect(f.commands).toContain("tmux kill-session -t '$1'");
    expect(f.commands.filter(c => c.includes("list-panes"))).toHaveLength(1);
    expect(f.db.prepare("SELECT status FROM sessions WHERE id='sa'").get()).toEqual({ status: "exited" });
    expect(f.sessionRegistry.getBindingForNode("a")).toBeNull(); f.db.close();
  });
});

describe("occupant fencing through payload preparation", () => {
  it("rechecks identity after the asynchronous PID observation before signalling", async () => {
    const f = fixture();
    f.tmux.getPanePid = async () => {
      f.db.exec("INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('new','a',2,'g-new','adopt')");
      return 123;
    };
    expect(await f.tmux.signalPaneProcess("worker@fixture", "TERM")).toMatchObject({ ok: false, code: "guard_target_changed" });
    expect(f.commands).toEqual([]); f.db.close();
  });
  for (const boundary of ["file", "load"] as const) {
    for (const fullTransport of [false, true]) {
      it(`refuses real reconciliation during ${boundary}, preserving ${fullTransport ? "whole send" : "adapter send"}`, async () => {
        let f: ReturnType<typeof fixture>; let reconciled: unknown;
        const reconcile = async () => { reconciled = await f.claim.reconcileSession({ sessionName: "worker@fixture" }); };
        f = fixture({ file: boundary === "file" ? reconcile : undefined, exec: async c => { if (boundary === "load" && c.includes("load-buffer")) await reconcile(); return ""; } });
        const before = f.guard.target("a");
        const result = fullTransport ? await f.transport.send("worker@fixture", "message", { force: true }) : await f.tmux.sendText("worker@fixture", "message");
        expect(reconciled).toMatchObject({ ok: false, code: "reconcile_error", message: expect.stringContaining("operation in progress") });
        expect(f.guard.target("a")).toEqual(before); expect(result.ok).toBe(true);
        expect(f.commands.filter(c => c.includes("paste-buffer"))).toHaveLength(1);
        expect(f.commands.filter(c => c.includes("send-keys"))).toHaveLength(fullTransport ? 1 : 0);
        // After the operation finishes the same supported reconcile route succeeds.
        expect((await f.claim.reconcileSession({ sessionName: "worker@fixture" })).ok).toBe(true);
        expect(f.guard.target("a").occupant).not.toBe(before.occupant); f.db.close();
      });
    }
    it(`rejects externally invalidated identity before paste after ${boundary}`, async () => {
      let f: ReturnType<typeof fixture>;
      const replace = async () => { f.db.exec("INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('new','a',2,'g-new','adopt')"); };
      f = fixture({ file: boundary === "file" ? replace : undefined, exec: async c => { if (boundary === "load" && c.includes("load-buffer")) await replace(); return ""; } });
      expect(await f.tmux.sendText("worker@fixture", "old")).toMatchObject({ ok: false, code: "guard_target_changed" });
      expect(f.commands.some(c => c.includes("paste-buffer") || c.includes("send-keys"))).toBe(false);
      expect(f.commands.some(c => c.includes("delete-buffer"))).toBe(true); f.db.close();
    });
  }
  it("does not reconcile during explicit human input; no nested wait or identity adoption", async () => {
    const f = fixture(); const before = f.guard.target("a");
    await f.guard.humanInput("a", async () => {
      expect(await f.claim.reconcileSession({ sessionName: "worker@fixture" })).toMatchObject({ ok: false });
      expect(f.guard.target("a")).toEqual(before);
      expect(await f.tmux.sendText("worker@fixture", "human")).toEqual({ ok: true });
    });
    expect((await f.claim.reconcileSession({ sessionName: "worker@fixture" })).ok).toBe(true); f.db.close();
  });
  it("activation waits for paste+submit, reconciliation refuses promptly, retained custody survives", async () => {
    const entered = signal(), finish = signal();
    const f = fixture({ file: async () => { entered.release(); await finish.ready; } });
    const sending = f.transport.send("worker@fixture", "old", { force: true }); await entered.ready;
    const before = f.guard.target("a");
    expect(await f.guard.set("a", true, "person", "draft", 1)).toMatchObject({ pending: true, effective: false });
    expect(await f.claim.reconcileSession({ sessionName: "worker@fixture" })).toMatchObject({ ok: false });
    expect(f.guard.target("a")).toEqual(before);
    finish.release(); expect((await sending).ok).toBe(true); await new Promise(r => setTimeout(r, 0));
    expect(f.guard.preference("a").effective).toBe(true);
    const count = f.commands.length;
    expect(await f.transport.send("worker@fixture", "held", { deliveryId: "held", force: true })).toMatchObject({ outcome: "retained", sent: false });
    expect(await f.claim.reconcileSession({ sessionName: "worker@fixture" })).toMatchObject({ ok: false, message: expect.stringContaining("protection is enabled") });
    expect(f.commands).toHaveLength(count); expect(f.outbox.getById("held")?.deliveryState).toBe("retained");
    expect(f.guard.target("a")).toEqual(before); f.db.close();
  });
  it("rejects observation made stale by another reconciliation without superseding again", async () => {
    const f = fixture(), entered = signal(), finish = signal(); let first = true;
    f.tmux.hasSession = async () => { if (first) { first = false; entered.release(); await finish.ready; } return true; };
    const pending = f.claim.reconcileSession({ sessionName: "worker@fixture" }); await entered.ready;
    expect((await f.claim.reconcileSession({ sessionName: "worker@fixture" })).ok).toBe(true);
    const current = f.guard.target("a"); finish.release();
    expect(await pending).toMatchObject({ ok: false, message: expect.stringContaining("changed during observation") });
    expect(f.guard.target("a")).toEqual(current); f.db.close();
  });
});
