import { describe, it, expect } from "vitest";
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
