// S4-start-last-respects-down — the per-seat difference between a rig taken down with `rig down`
// and one whose tmux sessions were lost (the boot reconciler marks each session detached). Both
// project the same rig-level lifecycle, so `rig start --last` reads the seats from
// GET /api/rigs/:rigId/nodes (intentionallyStopped, recorded by `rig down` since #1254).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { Reconciler } from "../src/domain/reconciler.js";
import { getNodeInventory } from "../src/domain/node-inventory.js";
import { deriveRigLifecycleState } from "../src/domain/ps-projection.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { SnapshotCapture } from "../src/domain/snapshot-capture.js";

// Every tmux session is gone: what a `rig down` kill and lost tmux sessions both leave behind.
function goneTmux(): TmuxAdapter {
  return {
    killSession: vi.fn(async () => ({ ok: true })),
    probeSession: vi.fn(async () => ({ state: "absent" })),
    hasSession: vi.fn(async () => false),
  } as unknown as TmuxAdapter;
}

describe("rig down leaves seats exited; when tmux is lost, the boot reconciler marks them detached", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
  });

  afterEach(() => { db.close(); });

  function seedRunningRig(name: string): string {
    const rig = rigRepo.createRig(name);
    for (const logicalId of ["dev.impl", "dev.qa"]) {
      const node = rigRepo.addNode(rig.id, logicalId);
      const session = sessionRegistry.registerSession(node.id, `${logicalId.replace(".", "-")}@${name}`);
      sessionRegistry.updateStatus(session.id, "running");
    }
    return rig.id;
  }

  const seatStatuses = (rigId: string) => getNodeInventory(db, rigId).map((n) => n.sessionStatus);
  const rigLifecycle = (rigId: string) => deriveRigLifecycleState(getNodeInventory(db, rigId).map((n) => n.lifecycleState));

  it("reports exited after rig down and detached after a boot reconcile, with the same rig lifecycle", async () => {
    const downed = seedRunningRig("downed");
    const crashed = seedRunningRig("crashed");
    const tmux = goneTmux();

    await new RigTeardownOrchestrator({
      db, rigRepo, sessionRegistry, tmuxAdapter: tmux, eventBus,
      snapshotCapture: { captureSnapshot: vi.fn(() => ({ id: "snap-1" })), db } as unknown as SnapshotCapture,
    }).teardown(downed);
    const reconciler = new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
    await reconciler.reconcile(crashed);

    expect(seatStatuses(downed)).toEqual(["exited", "exited"]);
    expect(seatStatuses(crashed)).toEqual(["detached", "detached"]);
    // The rig-level projection cannot tell them apart, which is why the CLI reads the seats.
    expect(rigLifecycle(downed)).toBe(rigLifecycle(crashed));
  });

  it("a later boot reconcile does not turn a downed rig's exited seats into detached", async () => {
    const downed = seedRunningRig("downed");
    const tmux = goneTmux();
    await new RigTeardownOrchestrator({
      db, rigRepo, sessionRegistry, tmuxAdapter: tmux, eventBus,
      snapshotCapture: { captureSnapshot: vi.fn(() => ({ id: "snap-1" })), db } as unknown as SnapshotCapture,
    }).teardown(downed);

    const result = await new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: tmux }).reconcile(downed);

    expect(result.detached).toBe(0);
    expect(seatStatuses(downed)).toEqual(["exited", "exited"]);
  });
});
