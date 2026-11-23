import { describe, it, expect, vi } from "vitest";
import { createDaemon } from "../src/startup.js";
import { DaemonLifecycleStore } from "../src/domain/daemon-lifecycle-store.js";

// review50-r1 follow-on: the store data-layer is unit-tested, but the boot WIRING
// (startup calls recordBoot) was proven only by the live kill-9 e2e — a future
// wiring drop would pass CI silently. This cheap boot-level pin closes that gap.
describe("P7 wiring pin — startup recordBoot ran at boot", () => {
  it("the lifecycle boot row exists after createDaemon boot (removing the recordBoot call fails HERE)", async () => {
    const { db } = await createDaemon({ dbPath: ":memory:" });
    const rec = new DaemonLifecycleStore(db).get();
    expect(rec).not.toBeNull();
    expect(rec!.bootEpoch).toBeTruthy();
    expect(rec!.startedAt).toBeTruthy();
    expect(rec!.stoppedAt).toBeNull(); // a fresh boot has no clean-shutdown mark yet
  });
});

// #3253: the adapter tests set seatProcessLimits by hand; this pins that the daemon's own composition gives its tmux
// adapter each seat's stored process_limits, read again at each launch. The injected exec keeps tmux and systemd out.
describe("#3253 wiring pin: the tmux adapter reads each seat's stored process_limits", () => {
  it("reads the stored value per seat and per call, and a malformed one is that seat's invalid (removing the wiring fails HERE)", async () => {
    const { db, deps } = await createDaemon({ dbPath: ":memory:", tmuxExec: async () => "",
      cmuxFactory: async () => { throw Object.assign(new Error("fixture: no cmux"), { code: "ENOENT" }); } });
    try {
      const rig = deps.rigRepo.createRig("limits-wiring");
      const capped = deps.rigRepo.addNode(rig.id, "capped", { runtime: "terminal", processLimits: { tasksMax: 64 } });
      const plain = deps.rigRepo.addNode(rig.id, "plain", { runtime: "terminal" });
      expect(deps.tmuxAdapter.seatProcessLimits?.(capped.id)).toEqual({ tasksMax: 64 });
      expect(deps.tmuxAdapter.seatProcessLimitsSet(plain.id)).toBe(false);
      // Not cached: a re-applied spec reaches the next launch.
      deps.rigRepo.setNodeProcessLimits(capped.id, { tasksMax: 128 });
      expect(deps.tmuxAdapter.seatProcessLimits?.(capped.id)).toEqual({ tasksMax: 128 });
      // memory_max reaches the adapter alone and beside tasks_max, in bytes.
      deps.rigRepo.setNodeProcessLimits(capped.id, { memoryMax: 4294967296 });
      expect(deps.tmuxAdapter.seatProcessLimits?.(capped.id)).toEqual({ memoryMax: 4294967296 });
      deps.rigRepo.setNodeProcessLimits(capped.id, { tasksMax: 128, memoryMax: 1073741824 });
      expect(deps.tmuxAdapter.seatProcessLimits?.(capped.id)).toEqual({ tasksMax: 128, memoryMax: 1073741824 });
      // A value that can't be read is this seat's `invalid`, decided before any check of the host.
      db.prepare("UPDATE nodes SET process_limits = ? WHERE id = ?").run("{", plain.id);
      expect(await deps.tmuxAdapter.seatProcessLimitsRecoveryPlan(plain.id)).toMatchObject({ state: "not_applied", kind: "invalid" });
      expect(deps.tmuxAdapter.seatProcessLimitsSet(capped.id)).toBe(true);
    } finally { db.close(); }
  });
});

// #2940: the supervisor is unit-tested with its dependencies passed by hand; this pins that the daemon's own composition
// builds it (not started: index.ts starts it once the daemon listens) and gives it the daemon's reconcile, its one-seat
// launch and the runtime adapters every other launch uses. The injected exec keeps tmux out: every seat is absent.
describe("#2940 wiring pin: createDaemon composes the keep-alive supervisor", () => {
  it("relaunches a fallen keep_alive seat through the daemon's one-seat launch, with its adapters (removing the wiring fails HERE)", async () => {
    const savedNoKernel = process.env.OPENRIG_NO_KERNEL;
    process.env.OPENRIG_NO_KERNEL = "1";
    const tmuxExec = async (cmd: string) => {
      if (cmd.includes("has-session")) throw Object.assign(new Error("Command failed"), { execStderr: "can't find session: fixture" });
      return "";
    };
    const { db, deps } = await createDaemon({ dbPath: ":memory:", tmuxExec,
      cmuxFactory: async () => { throw Object.assign(new Error("fixture: no cmux"), { code: "ENOENT" }); } });
    try {
      const supervisor = deps.keepAliveSupervisor;
      expect(supervisor).toBeDefined();
      expect(supervisor!.isRunning()).toBe(false);
      const rig = deps.rigRepo.createRig("keep-alive-wiring");
      const node = deps.rigRepo.addNode(rig.id, "dev.driver", { runtime: "terminal" });
      db.prepare("UPDATE nodes SET keep_alive = 1 WHERE id = ?").run(node.id);
      const session = deps.sessionRegistry.registerSession(node.id, "dev-driver@keep-alive-wiring");
      deps.sessionRegistry.updateStatus(session.id, "running");
      const launch = vi.spyOn(deps.restoreOrchestrator, "launchSingleNode")
        .mockResolvedValue({ ok: false, code: "no_usable_snapshot", message: "fixture" });
      await supervisor!.runTickNow();
      expect(launch).toHaveBeenCalledOnce();
      const [launchedRig, logicalId, opts] = launch.mock.calls[0]!;
      expect([launchedRig, logicalId]).toEqual([rig.id, "dev.driver"]);
      // The relaunch carries the supervisor's shutdown check, so a launch still waiting for the seat's lease starts nothing.
      const keepAlive = opts!.keepAlive as { shouldContinue?: () => boolean };
      expect(keepAlive.shouldContinue?.()).toBe(true);
      expect(opts!.adapters).toBe(deps.runtimeAdapters);
      expect(opts!.fsOps?.exists("/")).toBe(true);
    } finally {
      await deps.keepAliveSupervisor?.stop();
      db.close();
      if (savedNoKernel === undefined) delete process.env.OPENRIG_NO_KERNEL;
      else process.env.OPENRIG_NO_KERNEL = savedNoKernel;
    }
  });
});
