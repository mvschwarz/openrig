import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const [home, sourceRoot] = process.argv.slice(2);
const moduleRoot = sourceRoot ? join(sourceRoot, "packages/daemon/src") : fileURLToPath(new URL("../../dist/", import.meta.url));
const load = (name) => import(pathToFileURL(join(moduleRoot, name + (sourceRoot ? ".ts" : ".js"))));
const { migrate } = await load("db/migrate");
const { ALL_MIGRATIONS } = await load("db/all-migrations");
const { TmuxAdapter } = await load("adapters/tmux");
const { RigRepository } = await load("domain/rig-repository");
const { PodRepository } = await load("domain/pod-repository");
const { SessionRegistry } = await load("domain/session-registry");
const { EventBus } = await load("domain/event-bus");
const { DiscoveryRepository } = await load("domain/discovery-repository");
const { QueueRepository } = await load("domain/queue-repository");
const { RigLifecycleService } = await load("domain/rig-lifecycle-service");
const { SeatDeliveryGuard, resolveGuardTarget } = await load("domain/seat-delivery-guard");
const execute = promisify(execFile);
const socket = join(home, "tmux.sock");
const native = async (args) => (await execute("tmux", ["-S", socket, ...args], { timeout: 5000 })).stdout;
const db = new Database(":memory:");
try {
  migrate(db, ALL_MIGRATIONS);
  const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db), eventBus = new EventBus(db);
  const podRepo = new PodRepository(db);
  const rig = rigRepo.createRig("shrink-fixture"), pod = podRepo.createPod(rig.id, "crew", "Crew");
  const tmux = new TmuxAdapter(async () => { throw Error("shell path unused"); }, undefined, args => native(args.slice(1)));
  tmux.deliveryGuard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
  const lifecycle = new RigLifecycleService({ db, rigRepo, sessionRegistry, eventBus,
    discoveryRepo: new DiscoveryRepository(db), queueRepo: new QueueRepository(db, eventBus), tmuxAdapter: tmux });
  const seats = new Map();
  for (const member of ["a", "b", "c", "sibling"]) {
    const name = `${member}@shrink-fixture`;
    await native(["new-session", "-d", "-s", name, "sleep 120"]);
    const pane = (await native(["list-panes", "-t", name, "-F", "#{pane_id}"])).trim();
    const node = rigRepo.addNode(rig.id, member, { runtime: "terminal", ...(member === "sibling" ? {} : { podId: pod.id }) });
    const session = sessionRegistry.registerSession(node.id, name);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: name, tmuxPane: pane });
    seats.set(member, { node, session, name });
  }
  const stopped = seats.get("b");
  await native(["kill-session", "-t", stopped.name]);
  sessionRegistry.updateStatus(stopped.session.id, "exited");
  const result = await lifecycle.shrinkPod(rig.id, pod.id);
  assert.equal(result.ok && result.status, "ok", JSON.stringify(result));
  assert.deepEqual(result.removedLogicalIds, ["a", "b", "c"]);
  assert.equal(result.sessionsKilled, 2);
  assert.equal(podRepo.getPod(pod.id), null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE pod_id = ?").get(pod.id).n, 0);
  assert.equal((await tmux.probeSession(seats.get("sibling").name)).state, "present");
  assert.equal(sessionRegistry.getBindingForNode(seats.get("sibling").node.id).tmuxPane,
    (await native(["list-panes", "-t", seats.get("sibling").name, "-F", "#{pane_id}"])).trim());
  assert.ok(podRepo.createPod(rig.id, "crew", "Replacement"), "the removed namespace can be reused");
  // Inject failures only for conservative refusal controls. The recovery above
  // used native tmux, real absence and the actual three-seat shrink path.
  for (const failure of ["present", "transport", "permission", "changed"]) {
    const controlled = new TmuxAdapter(async () => { throw Error("unused shell"); }, undefined, async args => {
      if (args[1] === "list-panes") throw Error(failure === "permission" ? "permission denied: can't find window" : "can't find window");
      assert.equal(args[1], "has-session");
      if (failure === "transport") throw Error("no server running");
      if (failure === "changed") {
        sessionRegistry.updateBinding(seats.get("sibling").node.id, { tmuxSession: "replacement-session" });
        throw Error("can't find session");
      }
      return ""; // present must not be translated to absence
    });
    controlled.deliveryGuard = tmux.deliveryGuard;
    const outcome = await controlled.killSession(seats.get("sibling").name);
    assert.equal(outcome.ok, false);
    assert.notEqual(outcome.code, "session_not_found", `${failure} cannot authorize removal`);
    sessionRegistry.updateBinding(seats.get("sibling").node.id, { tmuxSession: seats.get("sibling").name });
  }
  assert.equal((await tmux.probeSession(seats.get("sibling").name)).state, "present");
  console.log(JSON.stringify({ shrink: "ok", stoppedRemoved: true, sessionsKilled: 2, siblingPreserved: true, namespaceReusable: true }));
} finally {
  await native(["kill-server"]).catch(() => {});
  db.close();
}
