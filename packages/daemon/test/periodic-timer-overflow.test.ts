import { expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { PeriodicSnapshotScheduler } from "../src/domain/periodic-snapshot-scheduler.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";

it("does not snapshot a monthly schedule immediately through native timer overflow", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "monthly-snapshot-"));
  const db = createDb(); migrate(db, ALL_MIGRATIONS);
  const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db);
  const snapshotRepo = new SnapshotRepository(db);
  const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus: new EventBus(db), snapshotRepo, checkpointStore: new CheckpointStore(db) });
  const scheduler = new PeriodicSnapshotScheduler({ db, snapshotCapture, snapshotRepo });
  try {
    const store = new SettingsStore(path.join(temp, "config.json"));
    store.set("snapshots.periodic.interval_seconds", "2592000");
    const interval = store.resolveOne("snapshots.periodic.interval_seconds");
    expect(interval).toMatchObject({ value: 2592000, source: "file" });
    const rig = rigRepo.createRig("monthly");
    const node = rigRepo.addNode(rig.id, "worker");
    const session = sessionRegistry.registerSession(node.id, "worker@monthly");
    sessionRegistry.updateStatus(session.id, "running");
    scheduler.start((interval.value as number) * 1000, 10);
    await new Promise((resolve) => setTimeout(resolve, 40));
    scheduler.stop();
    expect(snapshotRepo.listSnapshots(rig.id, { kind: "auto-periodic" })).toHaveLength(0);
  } finally {
    scheduler.stop(); db.close(); fs.rmSync(temp, { recursive: true, force: true });
  }
});


it("honors complete timer chunks, remainders, restart and ordinary cadence", async () => {
  const db = createDb(); migrate(db, ALL_MIGRATIONS);
  const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db);
  const snapshotRepo = new SnapshotRepository(db);
  const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus: new EventBus(db), snapshotRepo, checkpointStore: new CheckpointStore(db) });
  const scheduler = new PeriodicSnapshotScheduler({ db, snapshotCapture, snapshotRepo });
  vi.useFakeTimers();
  try {
    const rig = rigRepo.createRig("chunked");
    const node = rigRepo.addNode(rig.id, "worker");
    const session = sessionRegistry.registerSession(node.id, "worker@chunked");
    sessionRegistry.updateStatus(session.id, "running");
    const maxDelay = 2 ** 31 - 1;
    const interval = maxDelay * 2 + 40;
    const count = () => snapshotRepo.listSnapshots(rig.id, { kind: "auto-periodic" }).length;
    scheduler.start(interval, 10);
    scheduler.start(interval, 10);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(maxDelay);
    expect(count()).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(maxDelay + 39);
    expect(count()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(count()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(interval);
    expect(count()).toBe(1);
    scheduler.start(interval, 10);
    await vi.advanceTimersByTimeAsync(interval - 1);
    expect(count()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(count()).toBe(2);
    scheduler.stop();
    scheduler.start(30, 10);
    await vi.advanceTimersByTimeAsync(29);
    expect(count()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(count()).toBe(3);
    scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(scheduler.isActive).toBe(false);
  } finally {
    scheduler.stop(); vi.useRealTimers(); db.close();
  }
});
