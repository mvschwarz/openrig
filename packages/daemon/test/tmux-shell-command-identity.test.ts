import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { Reconciler } from "../src/domain/reconciler.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

// Actual registry, reconciliation, launch and guard code; all terminal/file I/O
// is injected. No real tmux server, shell command or runtime is started.
async function fixture() {
  const db = new Database(":memory:"); databases.push(db); migrate(db, ALL_MIGRATIONS);
  const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db), eventBus = new EventBus(db);
  const rig = rigRepo.createRig("fixture");
  const nodes = Object.fromEntries(["old", "worker", "sibling"].map((name, i) => {
    const node = rigRepo.addNode(rig.id, name, { role: "worker" });
    const session = sessionRegistry.registerSession(node.id, `${name}@fixture`);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: session.sessionName, tmuxPane: `%${i}` });
    return [name, node];
  }));
  // The old server is gone. The sibling represents an unrelated live target.
  const panes = new Map([["sibling@fixture", "%2"]]);
  const commands: string[] = [], files = new Map<string, string>();
  let serial = 0;
  const hooks: { write?: (path: string) => void; exec?: (command: string) => void } = {};
  const tmux = new TmuxAdapter(async command => {
    commands.push(command); hooks.exec?.(command);
    if (command.includes("#{pane_current_command}")) return "bash";
    if (command.startsWith("tmux new-session")) { panes.set("worker@fixture", "%0"); return ""; }
    if (command.startsWith("tmux has-session") || command.startsWith("tmux list-panes")) {
      // Both exact session probes (=name) and window-targeted pane listings
      // (=name:) address the same canonical session in the fixture server.
      const name = /-t '([^']+)'/.exec(command)?.[1]?.replace(/^=/, "").replace(/:$/, "");
      if (!name || !panes.has(name)) throw Error("can't find session");
      // Pane lines carry the window_index field the adapter's PANE_FORMAT now
      // requests (needed for psmux-safe qualified targets).
      return command.startsWith("tmux list-panes") ? `${panes.get(name)}|0|/inert|0|80|24|1\n` : "";
    }
    return "";
  }, {
    tmpName: () => `/inert/script-${++serial}`, bufferName: () => "fixture",
    writeFile: async (path, content) => { files.set(path, content); hooks.write?.(path); },
    unlink: async path => { files.delete(path); },
  });
  const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name)); tmux.deliveryGuard = guard;
  const deps = { db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux };
  expect(await new Reconciler(deps).reconcile(rig.id)).toMatchObject({ detached: 2, errors: [] });
  const retained = () => ({
    nodes: db.prepare("SELECT * FROM nodes ORDER BY id").all(),
    bindings: db.prepare("SELECT * FROM bindings ORDER BY id").all(),
    sessions: db.prepare("SELECT * FROM sessions ORDER BY id").all(),
    tenures: db.prepare("SELECT * FROM occupant_tenures ORDER BY id").all(),
  });
  const oldBinding = sessionRegistry.getBindingForNode(nodes.old!.id);
  const siblingBinding = sessionRegistry.getBindingForNode(nodes.sibling!.id);
  const oldSessions = sessionRegistry.getSessionsForRig(rig.id);
  // Restore clears ONLY the selected node's binding before NodeLauncher. The
  // other detached binding still owns its historical %0 value.
  await guard.lifecycle([nodes.worker!.id], async () => {
    sessionRegistry.clearBinding(nodes.worker!.id);
    guard.rebindLifecycle(nodes.worker!.id);
    expect(await new NodeLauncher(deps).launchNode(rig.id, "worker", {
      cwd: "/inert", sessionName: "worker@fixture",
    })).toMatchObject({ ok: true, binding: { tmuxPane: "%0" } });
  });
  expect(sessionRegistry.getBindingForNode(nodes.old!.id)).toEqual(oldBinding);
  expect(sessionRegistry.getBindingForNode(nodes.sibling!.id)).toEqual(siblingBinding);
  for (const session of oldSessions) expect(sessionRegistry.getSessionsForRig(rig.id)).toContainEqual(session);
  expect(guard.maybeTarget("%0")).toBeNull();
  commands.length = 0;
  return { db, nodes, sessionRegistry, guard, tmux, commands, files, panes, hooks, retained };
}

describe("shell launch after cold pane reuse (#141)", () => {
  it.each([false, true])("preserves the named lifecycle target through paste and Enter (callback=%s)", async callback => {
    const f = await fixture(), before = f.retained();
    let checks = 0;
    const result = await f.guard.lifecycle([f.nodes.worker!.id], () =>
      f.tmux.sendShellCommand("worker@fixture", "codex resume 'retained-thread'", callback ? () => { checks++; } : undefined));
    expect(result).toEqual({ ok: true });
    const pastes = f.commands.filter(c => c.includes("paste-buffer"));
    expect(pastes).toHaveLength(1); expect(pastes[0]).toContain("-t '=worker@fixture:0.0'");
    expect(f.commands.filter(c => c.includes("send-keys"))).toEqual(["tmux send-keys -t '=worker@fixture:0.0' 'Enter'"]);
    expect(checks).toBe(callback ? 2 : 0);
    expect(f.retained()).toEqual(before);
  });

  it("also preserves a node-id selector and leaves an unrelated sibling usable", async () => {
    const f = await fixture(), before = f.retained();
    expect(await f.tmux.sendShellCommand(f.nodes.worker!.id, "inert launch")).toEqual({ ok: true });
    expect(await f.tmux.sendShellCommand("sibling@fixture", "inert launch")).toEqual({ ok: true });
    expect(f.commands.filter(c => c.includes("send-keys"))).toEqual([
      "tmux send-keys -t '=worker@fixture:0.0' 'Enter'", "tmux send-keys -t '=sibling@fixture:0.0' 'Enter'",
    ]);
    expect(f.retained()).toEqual(before);
  });

  it.each(["detached", "running"])("still refuses a bare pane shared with a %s record", async status => {
    const f = await fixture(), before = f.retained();
    f.db.prepare("UPDATE sessions SET status=? WHERE node_id=?").run(status, f.nodes.old!.id);
    expect(await f.tmux.sendShellCommand("%0", "must not send")).toMatchObject({ ok: false, code: "guard_target_unknown" });
    expect(f.commands).toEqual([]); expect(f.files.size).toBe(0);
    expect(f.retained().bindings).toEqual(before.bindings);
  });

  it("refuses an unknown target or a session whose live pane does not match its binding", async () => {
    const f = await fixture();
    expect(await f.tmux.sendShellCommand("unknown@fixture", "must not send")).toMatchObject({ ok: false });
    f.panes.set("worker@fixture", "%2");
    expect(await f.tmux.sendShellCommand("worker@fixture", "must not send")).toMatchObject({ ok: false });
    expect(f.commands.every(c => c.includes("list-panes"))).toBe(true);
    expect(f.files.size).toBe(0);
  });

  it("still refuses a session name bound to two nodes", async () => {
    const f = await fixture();
    f.sessionRegistry.updateBinding(f.nodes.sibling!.id, { tmuxSession: "worker@fixture" });
    expect(await f.tmux.sendShellCommand("worker@fixture", "must not send")).toMatchObject({ ok: false, code: "guard_target_unknown" });
    expect(f.commands).toEqual([]); expect(f.files.size).toBe(0);
  });

  it("does not bypass an enabled guard on the named target", async () => {
    const f = await fixture();
    await f.guard.set(f.nodes.worker!.id, true, "fixture", "draft");
    expect(await f.tmux.sendShellCommand("worker@fixture", "must not send")).toMatchObject({ ok: false, code: "typing_guard_enabled" });
    expect(f.commands).toEqual([]); expect(f.files.size).toBe(0);
    expect(await f.tmux.sendShellCommand("sibling@fixture", "inert launch")).toEqual({ ok: true });
  });

  // On win32 the non-sourcing path sends the raw command (no staged writeFile),
  // so the script/payload write-boundary fences have no hook to fire on there;
  // those two cases stay POSIX-only. The load/paste exec boundaries still fence.
  it.each(["script", "payload", "load", "paste"].flatMap(boundary => [
    { boundary, sourceInPane: false }, { boundary, sourceInPane: true },
  ]).filter(({ boundary, sourceInPane }) => !(
    process.platform === "win32" && !sourceInPane && (boundary === "script" || boundary === "payload")
  )))("fences an occupant replacement during $boundary preparation (source=$sourceInPane)", async ({ boundary, sourceInPane }) => {
    const f = await fixture();
    const replace = () => f.db.prepare(`INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind)
      VALUES ('replacement',?,100,'replacement','adopt')`).run(f.nodes.worker!.id);
    let writes = 0;
    f.hooks.write = () => { writes++; if ((boundary === "script" && writes === 1) || (boundary === "payload" && writes === 2)) replace(); };
    f.hooks.exec = command => { if ((boundary === "load" && command.includes("load-buffer")) || (boundary === "paste" && command.includes("paste-buffer"))) replace(); };
    expect(await f.tmux.sendShellCommand("worker@fixture", "old command", undefined, { sourceInPane })).toMatchObject({ ok: false, code: "guard_target_changed" });
    expect(f.commands.filter(c => c.includes("paste-buffer"))).toHaveLength(boundary === "paste" ? 1 : 0);
    expect(f.commands.some(c => c.includes("send-keys"))).toBe(false);
    expect(f.files.size).toBe(0);
  });
});
