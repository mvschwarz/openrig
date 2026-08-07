import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { DaemonLifecycleStore } from "../src/domain/daemon-lifecycle-store.js";

describe("DaemonLifecycleStore — P7 atom 1 (mig-061 lifecycle record)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createFullTestDb();
  });

  it("get() is null before any boot", () => {
    expect(new DaemonLifecycleStore(db).get()).toBeNull();
  });

  it("recordBoot writes epoch + started_at; heartbeat + stopped are null", () => {
    const s = new DaemonLifecycleStore(db);
    s.recordBoot("epoch-1", "2026-08-07T00:00:00.000Z");
    const r = s.get()!;
    expect(r.bootEpoch).toBe("epoch-1");
    expect(r.startedAt).toBe("2026-08-07T00:00:00.000Z");
    expect(r.lastHeartbeatAt).toBeNull();
    expect(r.stoppedAt).toBeNull();
  });

  it("a NEW boot mints a new epoch, advances started_at, and CLEARS the prior run's stopped_at + heartbeat", () => {
    const s = new DaemonLifecycleStore(db);
    s.recordBoot("epoch-1", "2026-08-07T00:00:00.000Z");
    s.recordHeartbeat("2026-08-07T00:05:00.000Z");
    s.recordStop("epoch-1", "2026-08-07T00:10:00.000Z");

    s.recordBoot("epoch-2", "2026-08-07T01:00:00.000Z"); // new boot
    const r = s.get()!;
    expect(r.bootEpoch).toBe("epoch-2");
    expect(r.startedAt).toBe("2026-08-07T01:00:00.000Z");
    expect(r.stoppedAt).toBeNull(); // not the prior run's stop
    expect(r.lastHeartbeatAt).toBeNull();
  });

  it("recordHeartbeat advances last_heartbeat_at while running", () => {
    const s = new DaemonLifecycleStore(db);
    s.recordBoot("e", "2026-08-07T00:00:00.000Z");
    s.recordHeartbeat("2026-08-07T00:01:00.000Z");
    expect(s.get()!.lastHeartbeatAt).toBe("2026-08-07T00:01:00.000Z");
    s.recordHeartbeat("2026-08-07T00:02:00.000Z");
    expect(s.get()!.lastHeartbeatAt).toBe("2026-08-07T00:02:00.000Z");
  });

  it("recordHeartbeat GUARDS not-stopped — a stray tick after stop must NOT advance last-seen (write-order pin)", () => {
    const s = new DaemonLifecycleStore(db);
    s.recordBoot("e", "2026-08-07T00:00:00.000Z");
    s.recordHeartbeat("2026-08-07T00:05:00.000Z");
    s.recordStop("e", "2026-08-07T00:10:00.000Z");
    s.recordHeartbeat("2026-08-07T00:11:00.000Z"); // stray tick AFTER stop
    const r = s.get()!;
    expect(r.stoppedAt).toBe("2026-08-07T00:10:00.000Z");
    expect(r.lastHeartbeatAt).toBe("2026-08-07T00:05:00.000Z"); // NOT advanced past stop
  });

  it("recordStop is terminal per epoch — a second stop (or a wrong epoch) does not move stopped_at", () => {
    const s = new DaemonLifecycleStore(db);
    s.recordBoot("e1", "2026-08-07T00:00:00.000Z");
    s.recordStop("e1", "2026-08-07T00:10:00.000Z");
    s.recordStop("e1", "2026-08-07T00:20:00.000Z"); // second stop — ignored (terminal)
    s.recordStop("e-other", "2026-08-07T00:30:00.000Z"); // wrong epoch — ignored
    expect(s.get()!.stoppedAt).toBe("2026-08-07T00:10:00.000Z");
  });
});
