// B1 Atom D — the ⏎ RESTORE EVERYTHING drive: start the daemon (the `s` step) THEN
// drive the C1 conductor. Sequencing + failure-propagation pinned here; the full TUI
// ⏎→render flow is verified by the QA door test.
import { describe, it, expect } from "vitest";
import { driveRestoreEverything } from "../src/crash-cart/restore-drive.js";

describe("driveRestoreEverything — Atom D", () => {
  it("starts the daemon BEFORE driving the conductor, and returns the rollup", async () => {
    const order: string[] = [];
    const rollup = await driveRestoreEverything({
      startDaemon: async () => {
        order.push("start");
      },
      callRestoreFleet: async () => {
        order.push("restore");
        return { counts: { fully_restored: 2 } };
      },
    });
    expect(order).toEqual(["start", "restore"]); // the `s` step first, always
    expect(rollup).toEqual({ counts: { fully_restored: 2 } });
  });

  it("if the daemon fails to start, the conductor is NEVER called (error propagates)", async () => {
    let restoreCalled = false;
    await expect(
      driveRestoreEverything({
        startDaemon: async () => {
          throw new Error("daemon start failed");
        },
        callRestoreFleet: async () => {
          restoreCalled = true;
          return {};
        },
      }),
    ).rejects.toThrow("daemon start failed");
    expect(restoreCalled).toBe(false);
  });
});
