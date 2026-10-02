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
    const panes = await adapter.listPanes("worker@demo2");
    assert.equal(panes.length, 1, "the exact existing session pane remains visible");
    assert.equal((await adapter.listPanes("worker@demo2:0"))[0].id, panes[0].id, "named session window remains exact");
    assert.equal((await adapter.listPanes(panes[0].id))[0].id, panes[0].id, "immutable pane-id target remains supported");
    const ids = (await native(["display-message", "-p", "-t", "=worker@demo2:", "#{session_id} #{window_id}"])).trim().split(" ");
    for (const id of ids) assert.equal((await adapter.listPanes(id))[0].id, panes[0].id, "immutable session/window ids remain supported");
    assert.equal((await adapter.listPanes("=worker@demo2:0"))[0].id, panes[0].id, "already-exact target remains supported");
    await assert.rejects(adapter.listPanes("worker@demo"), /can't find (?:window|session)/,
      "missing list-panes target must not resolve to the live prefix neighbor");
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
  // Literal-leading-equals case also reported by lab1207 in PR #460.
  // Each arrangement uses real tmux targets through both adapter APIs.
  const literal = "=worker@demo", plain = "worker@demo";
  for (const names of [[literal], [plain], [literal, plain]]) {
    await native(["kill-server"]);
    // Keep the private server live when the literal case removes its only pane.
    await native(["new-session", "-d", "-s", "fixture-anchor", "sleep 120"]);
    for (const name of names) await native(["new-session", "-d", "-s", name, "sleep 120"]);
    for (const adapter of [argv, legacy]) {
      for (const name of names) {
        const expected = (await native(["display-message", "-p", "-t", `=${name}:`, "#{pane_id}"])).trim();
        const panes = await adapter.listPanes(name);
        assert.equal(panes.length, 1);
        assert.equal(panes[0].id, expected, "a literal session name must select its own pane");
        assert.equal((await adapter.listPanes(`=${name}:0`))[0].id, expected, "encoded qualified target stays exact");
        assert.equal((await adapter.listPanes(expected))[0].id, expected, "pane id stays unchanged");
        const ids = (await native(["display-message", "-p", "-t", `=${name}:`, "#{session_id} #{window_id}"])).trim().split(" ");
        for (const id of ids) assert.equal((await adapter.listPanes(id))[0].id, expected);
      }
      for (const absent of [literal, plain].filter(name => !names.includes(name))) {
        assert.equal((await adapter.probeSession(absent)).state, "absent");
        await assert.rejects(adapter.listPanes(absent), /can't find (?:window|session)/);
      }
    }
    if (names.includes(literal)) {
      const [pane] = await argv.listPanes(literal);
      await native(["kill-pane", "-t", pane.id]);
      assert.equal((await argv.probeSession(literal)).state, "absent", "selected literal pane is really stopped");
      if (names.includes(plain)) assert.equal((await argv.probeSession(plain)).state, "present", "plain neighbor survives literal removal");
    }
  }
  console.log(JSON.stringify({ nativeTmux: true, argvAndLegacy: true, missingDetached: true, neighborPreserved: true, exactPaneListing: true }));
} finally { db.close(); await native(["kill-server"]).catch(() => {}); }
