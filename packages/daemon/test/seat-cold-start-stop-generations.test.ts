import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { RigLifecycleService } from "../src/domain/rig-lifecycle-service.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { SeatColdStarter, classifyColdStartStop } from "../src/domain/seat-cold-start.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import type { RigSpec } from "../src/domain/types.js";

describe("cold-start stop attribution through real lifecycle writers", () => {
  let db: Database.Database;
  let registry: SessionRegistry;
  let eventBus: EventBus;
  let rigRepo: RigRepository;
  let tmux: TmuxAdapter;
  let stop: SeatLifecycleService;
  let down: RigTeardownOrchestrator;
  let rigId: string;
  let nodeId: string;
  let peerId: string;
  const target = "dev-impl@fleet";
  const peer = "dev-peer@fleet";
  let live: Set<string>;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    registry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    rigRepo = new RigRepository(db);
    rigId = rigRepo.createRig("fleet").id;
    nodeId = rigRepo.addNode(rigId, "dev.impl", { runtime: "pi" }).id;
    peerId = rigRepo.addNode(rigId, "dev.peer", { runtime: "pi" }).id;
    live = new Set();
    tmux = new TmuxAdapter();
    tmux.deliveryGuard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
    vi.spyOn(tmux, "hasSession").mockImplementation(async name => live.has(name));
    vi.spyOn(tmux, "probeSession").mockImplementation(async name => live.has(name) ? { state: "present" } : { state: "absent" });
    vi.spyOn(tmux, "killSession").mockImplementation(async name => { live.delete(name); return { ok: true }; });
    stop = new SeatLifecycleService({ db, rigRepo, sessionRegistry: registry, eventBus, tmuxAdapter: tmux });
    down = new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry: registry, eventBus, tmuxAdapter: tmux,
      snapshotCapture: new SnapshotCapture({ db, rigRepo, sessionRegistry: registry, eventBus,
        snapshotRepo: new SnapshotRepository(db), checkpointStore: new CheckpointStore(db) }) });
  });

  afterEach(() => { db.close(); });

  function launch(id = nodeId, name = target): string {
    const session = registry.registerSession(id, name);
    registry.updateStatus(session.id, "running");
    registry.updateBinding(id, { attachmentType: "tmux", tmuxSession: name });
    live.add(name);
    return session.id;
  }

  async function pendingWake(): Promise<number> {
    const recipe: RigSpec = { version: "0.2", name: "fleet", edges: [], pods: [{ id: "dev", label: "Dev", edges: [],
      members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "pi", cwd: ".", coldStart: true }] }] };
    const launched = vi.fn(async (_rigId: string, logicalId: string) => ({ ok: true, launched: [{ logicalId, status: "resumed" }] }));
    const logs: string[] = [];
    const guard = tmux.deliveryGuard;
    if (!guard) throw new Error("fixture requires a lifecycle guard");
    new SeatColdStarter({ db, deliveryGuard: guard, launchSingleNode: launched, hasSession: name => tmux.hasSession(name),
      getNodeLaunchRecipe: () => ({ rigSpec: recipe }), log: line => { logs.push(line); } }).notify(target);
    await vi.waitFor(() => expect(logs.length).toBeGreaterThan(0));
    return launched.mock.calls.length;
  }

  it.each(["rig down", "human stop", "crash"])("does not borrow a reaper stop across same-name relaunch then %s", async ending => {
    launch();
    expect(await stop.stopSeat({ seatRef: target, operator: "daemon:seat-reaper", reason: "idle_reap" })).toMatchObject({ ok: true });
    expect(classifyColdStartStop(db, nodeId).kind).toBe("daemon_reclaim");
    const newer = launch();
    if (ending === "rig down") await down.teardown(rigId);
    if (ending === "human stop") expect(await stop.stopSeat({ seatRef: target, operator: "human", reason: "pause" })).toMatchObject({ ok: true });
    if (ending === "crash") { live.delete(target); registry.updateStatus(newer, "exited"); }
    launch(peerId, peer);
    expect(await pendingWake()).toBe(ending === "crash" ? 1 : 0);
  });

  it("keeps a rolled-back launch stopped after down and a later peer launch", async () => {
    const failed = launch();
    live.delete(target);
    registry.updateStatus(failed, "superseded");
    await down.teardown(rigId);
    launch(peerId, peer);
    expect(classifyColdStartStop(db, nodeId).kind).toBe("intentional");
    expect(await pendingWake()).toBe(0);
  });

  it("attributes node removal to the exact session before removing its row", async () => {
    const sessionId = launch();
    const removal = new RigLifecycleService({ db, rigRepo, sessionRegistry: registry, eventBus,
      discoveryRepo: new DiscoveryRepository(db), queueRepo: new QueueRepository(db, eventBus, {}), tmuxAdapter: tmux });
    expect(await removal.removeNode(rigId, "dev.impl")).toMatchObject({ ok: true });
    const event = db.prepare("SELECT payload FROM events WHERE type='session.stopped' ORDER BY seq DESC LIMIT 1").get();
    expect(event).toEqual({ payload: expect.any(String) });
    if (!event || typeof event !== "object" || !("payload" in event) || typeof event.payload !== "string") throw new Error("missing stop audit");
    expect(JSON.parse(event.payload)).toMatchObject({ sessionId, operator: "rig remove", reason: "node_removal" });
  });
});
