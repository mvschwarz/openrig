import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import Database from "better-sqlite3";
const [home, sourceRoot] = process.argv.slice(2);
const moduleRoot = sourceRoot ? join(sourceRoot, "packages/daemon/src") : fileURLToPath(new URL("../../dist/", import.meta.url));
const load = name => import(pathToFileURL(join(moduleRoot, name + (sourceRoot ? ".ts" : ".js"))));
const { TmuxAdapter } = await load("adapters/tmux");
const { migrate } = await load("db/migrate"), { ALL_MIGRATIONS } = await load("db/all-migrations");
const { RigRepository } = await load("domain/rig-repository"), { SessionRegistry } = await load("domain/session-registry");
const { EventBus } = await load("domain/event-bus"), { Reconciler } = await load("domain/reconciler");
const execute = promisify(execFile), socket = join(home, "tmux.sock");
const native = async args => (await execute("tmux", ["-S", socket, ...args], { timeout: 5000 })).stdout;
const quote = s => "'" + s.replace(/'/g, "'\"'\"'") + "'";
const shell = async command => (await execute("sh", ["-c", command.replace(/^tmux /, `tmux -S ${quote(socket)} `)], { timeout: 5000 })).stdout;
const argv = new TmuxAdapter(shell, undefined, args => native(args.slice(1)));
const legacy = new TmuxAdapter(shell);
const db = new Database(":memory:");
try {
  await native(["new-session", "-d", "-s", "worker@demo2", "sleep 120"]);
  const missingProbes = [];
  for (const adapter of [argv, legacy]) {
    assert.equal((await adapter.probeSession("worker@demo2")).state, "present", "exact existing session");
    missingProbes.push((await adapter.probeSession("worker@demo")).state);
  }
  migrate(db, ALL_MIGRATIONS);
  const repo = new RigRepository(db), registry = new SessionRegistry(db), eventBus = new EventBus(db);
  const rig = repo.createRig("demo"), neighborRig = repo.createRig("demo2");
  const missingNode = repo.addNode(rig.id, "worker", { runtime: "terminal" });
  const liveNode = repo.addNode(neighborRig.id, "worker", { runtime: "terminal" });
  const missing = registry.registerSession(missingNode.id, "worker@demo");
  const live = registry.registerSession(liveNode.id, "worker@demo2");
  registry.updateStatus(missing.id, "running"); registry.updateStatus(live.id, "running");
  const reconciler = new Reconciler({ db, sessionRegistry: registry, eventBus, tmuxAdapter: argv });
  assert.deepEqual(await reconciler.reconcile(rig.id), { checked: 1, detached: 1, errors: [] });
  assert.deepEqual(missingProbes, ["absent", "absent"], "missing session must not prefix-match its neighbor");
  assert.equal(registry.getSessionsForRig(rig.id)[0].status, "detached");
  assert.equal(registry.getSessionsForRig(neighborRig.id)[0].status, "running");
  assert.equal((await argv.probeSession("worker@demo2")).state, "present");
  console.log(JSON.stringify({ nativeTmux: true, argvAndLegacy: true, missingDetached: true, neighborPreserved: true }));
} finally { db.close(); await native(["kill-server"]).catch(() => {}); }
