// #3315 on real tmux servers of the test's own (`-S <fixture>/…`): the test takes one server away and brings it back,
// and the daemon's adapter, its reachability record and its delivery hold see the loss, the return and nothing in
// between; a second server keeps answering throughout. Nothing here touches a server the test did not start.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { execArgvCommand, execCommand } from "../src/adapters/tmux-exec.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigDeliveryDrainStore } from "../src/domain/rig-delivery-drain.js";
import { TerminalServerReachability, type TerminalServerChange } from "../src/domain/terminal-server-reachability.js";
import { isTmuxBoundSession } from "../src/domain/terminal-server-seats.js";

const nativeAvailable = process.platform !== "win32" && (() => {
  try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); return true; }
  catch { return false; }
})();

const until = async (predicate: () => boolean, message: string) => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(message);
};

describe.skipIf(!nativeAvailable)("a tmux server taken away and brought back", { timeout: 30_000 }, () => {
  let root: string;
  let lost: string;
  let kept: string;
  const native = (socket: string, args: string[]) =>
    execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TMUX: "", TMUX_PANE: "" } }).trim();
  const startServer = (socket: string, session: string) =>
    native(socket, ["-f", "/dev/null", "new-session", "-d", "-s", session, "sleep 600"]);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "t3315-"));
    lost = path.join(root, "lost.sock");
    kept = path.join(root, "kept.sock");
    startServer(lost, "worker@fixture");
    startServer(kept, "other@fixture");
  });

  afterEach(() => {
    // These sockets belong to this test, never to a user's terminal server.
    for (const socket of [lost, kept]) {
      try { native(socket, ["kill-server"]); } catch { /* already gone */ }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("records the loss and the return once each, holds only the lost server's seat, and never starts a server", async () => {
    const db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    db.exec(`INSERT INTO rigs(id, name) VALUES ('r', 'fixture');
      INSERT INTO nodes(id, rig_id, logical_id, runtime) VALUES ('n1', 'r', 'worker', 'claude-code'), ('n2', 'r', 'other', 'claude-code');
      INSERT INTO sessions(id, node_id, session_name, status) VALUES ('s1', 'n1', 'worker@fixture', 'running'), ('s2', 'n2', 'other@fixture', 'running');
      INSERT INTO bindings(id, node_id, attachment_type, tmux_session) VALUES ('b1', 'n1', 'tmux', 'worker@fixture'), ('b2', 'n2', 'tmux', 'other@fixture');`);
    const commands: string[][] = [];
    // Both of the adapter's paths are recorded: argv commands, and the shell-string path a server start takes.
    const recorded = (argv: string[]) => { commands.push(argv); return execArgvCommand(argv); };
    const recordedShell = (command: string) => { commands.push([command]); return execCommand(command); };
    const lostAdapter = new TmuxAdapter(recordedShell, undefined, recorded, ["-S", lost]);
    const keptAdapter = new TmuxAdapter(recordedShell, undefined, recorded, ["-S", kept]);
    const eventBus = new EventBus(db);
    const changes: TerminalServerChange[] = [];
    const probeOf = (adapter: TmuxAdapter) => async () => {
      const probe = await adapter.probeSession("openrig-reachability-probe");
      return probe.state === "transport_unavailable" ? { reachable: false as const, cause: probe.cause } : { reachable: true as const };
    };
    const reach = new TerminalServerReachability({ probeIntervalMs: 50, probeMaxIntervalMs: 200,
      onChange: change => { changes.push(change); eventBus.emit(change); },
      probe: socket => probeOf(socket === lost ? lostAdapter : keptAdapter)() });
    lostAdapter.serverObserver = observation => reach.observe(lost, observation);
    keptAdapter.serverObserver = observation => reach.observe(kept, observation);
    const drains = new RigDeliveryDrainStore(db);
    const socketOf = (session: string) => session === "worker@fixture" ? lost : kept;
    drains.attachTerminalHold(session => reach.unreachable(socketOf(session)) !== null && isTmuxBoundSession(db, session));

    expect(await lostAdapter.probeSession("worker@fixture")).toEqual({ state: "present" });
    expect(await keptAdapter.probeSession("other@fixture")).toEqual({ state: "present" });
    expect(reach.snapshot().state).toBe("ok");

    native(lost, ["kill-server"]); // the loss: the test's own act on its own server
    const probe = await lostAdapter.probeSession("worker@fixture");
    expect(probe.state).toBe("transport_unavailable"); // existence not determined, never "absent"
    expect(changes.map(c => c.type)).toEqual(["tmux.server_gone"]);
    expect(changes[0]).toMatchObject({ socket: lost });
    expect(drains.holds("worker@fixture")).toBe(true);
    expect(drains.holds("other@fixture")).toBe(false);
    expect(await keptAdapter.probeSession("other@fixture")).toEqual({ state: "present" }); // the other server works on

    // Let the record's own probes run for a while: still one loss on record, and no server started by anyone.
    await new Promise(resolve => setTimeout(resolve, 800));
    expect(changes).toHaveLength(1);
    expect(() => native(lost, ["list-sessions"])).toThrow(); // nothing brought it back on its own

    startServer(lost, "worker@fixture"); // the return: someone else's act (here, the test as operator)
    await until(() => changes.length === 2, "the return was not noticed");
    expect(changes.map(c => c.type)).toEqual(["tmux.server_gone", "tmux.server_back"]);
    expect(drains.holds("worker@fixture")).toBe(false);
    expect(await lostAdapter.probeSession("worker@fixture")).toEqual({ state: "present" });
    expect(commands.filter(argv => /(^|\s)(-D|start-server|new-session|systemd-run)(\s|$)/.test(argv.join(" ")))).toEqual([]);
    expect((db.prepare("SELECT type, count(*) AS n FROM events WHERE type LIKE 'tmux.%' GROUP BY type ORDER BY type").all()))
      .toEqual([{ type: "tmux.server_back", n: 1 }, { type: "tmux.server_gone", n: 1 }]);
    reach.stop();
    db.close();
  });
});
