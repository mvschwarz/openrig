// B1 ROUND 2 — the TUI-owned lifecycle. Discriminators against r2's probes:
//  HIGH-3: a MID-RUN frame is observable (onFrame fires on not-done polls, with progressive counts),
//          not only at completion.
//  HIGH-1: cancel reaches the endpoint with the retained attempt id when the operator requests it.
import { describe, it, expect, vi } from "vitest";
import { driveRestoreLifecycle, type RestoreLifecycleClient } from "../src/crash-cart/restore-lifecycle.js";
import type { RestoreFleetStatus } from "../src/daemon-client.js";

function status(over: Partial<RestoreFleetStatus> & { counts?: Partial<RestoreFleetStatus["rollup"]["counts"]> }): RestoreFleetStatus {
  return {
    done: over.done ?? false,
    cancelled: over.cancelled ?? false,
    verdict: over.verdict ?? "none_attempted",
    rollup: {
      counts: { fully_restored: 0, partially_restored: 0, failed: 0, not_attempted: 0, ...(over.counts ?? {}) },
      sequence: over.rollup?.sequence ?? [],
      attention_required: over.rollup?.attention_required ?? [],
    },
  };
}

function scriptedClient(statuses: RestoreFleetStatus[]): { client: RestoreLifecycleClient; cancelled: string[]; gets: number } {
  const cancelled: string[] = [];
  let i = 0;
  const box = { gets: 0 };
  const client: RestoreLifecycleClient = {
    restoreFleet: async () => ({ fleetAttemptId: "fleet-xyz" }),
    restoreFleetStatus: async () => {
      const s = statuses[Math.min(i, statuses.length - 1)]!;
      i++;
      box.gets++;
      return s;
    },
    cancelRestoreFleet: async (id: string) => {
      cancelled.push(id);
      return { ok: true, cancelled: true };
    },
  };
  return { client, cancelled, get gets() { return box.gets; } };
}

describe("driveRestoreLifecycle", () => {
  it("HIGH-3: emits a frame EVERY poll — a mid-run running frame is observed, not only completion", async () => {
    const frames: Array<{ phase: string; done: boolean; fully: number }> = [];
    const { client } = scriptedClient([
      status({ done: false, counts: { fully_restored: 1 } }), // 1 rig done, fleet still running
      status({ done: false, counts: { fully_restored: 2 } }), // 2 rigs done, still running
      status({ done: true, verdict: "all_fully_restored", counts: { fully_restored: 3 } }),
    ]);
    const final = await driveRestoreLifecycle({
      client,
      onFrame: (f) => frames.push({ phase: f.phase, done: f.done, fully: f.rollup.counts.fully_restored }),
      isCancelRequested: () => false,
      sleep: async () => {},
    });
    // three frames — TWO of them mid-run (running) with progressive counts BEFORE the done frame
    expect(frames).toEqual([
      { phase: "running", done: false, fully: 1 },
      { phase: "running", done: false, fully: 2 },
      { phase: "done", done: true, fully: 3 },
    ]);
    expect(final.phase).toBe("done");
    expect(final.attemptId).toBe("fleet-xyz");
  });

  it("HIGH-1: cancel reaches the endpoint with the retained attempt id, exactly once", async () => {
    const { client, cancelled } = scriptedClient([
      status({ done: false, counts: { fully_restored: 1 } }),
      status({ done: false, cancelled: true, counts: { fully_restored: 1, not_attempted: 1 } }),
      status({ done: true, cancelled: true, verdict: "mixed", counts: { fully_restored: 1, not_attempted: 1 } }),
    ]);
    let asked = false;
    const cancelSpy = vi.spyOn(client, "cancelRestoreFleet");
    const final = await driveRestoreLifecycle({
      client,
      onFrame: () => { asked = true; }, // after the first frame renders, the operator hits cancel
      isCancelRequested: () => asked,
      sleep: async () => {},
    });
    expect(cancelled).toEqual(["fleet-xyz"]); // reached the endpoint with the retained id
    expect(cancelSpy).toHaveBeenCalledTimes(1); // once, not every tick
    expect(final.cancelled).toBe(true);
  });

  it("HIGH-1 (r2 probe): the poll ceiling DETACHES — never a frozen 'running' frame", async () => {
    // r2's maxPolls:2 discriminator: a perpetually-running status. The driver must NOT return a
    // running frame the caller would render as live-with-a-dead-cancel; it returns DETACHED.
    const frames: string[] = [];
    const { client } = scriptedClient([status({ done: false, counts: { fully_restored: 1 } })]);
    const final = await driveRestoreLifecycle({
      client,
      onFrame: (f) => frames.push(f.phase),
      isCancelRequested: () => false,
      sleep: async () => {},
      maxPolls: 2,
    });
    expect(final.done).toBe(false);
    expect(final.phase).toBe("detached"); // NOT "running" — the fix
    expect(frames[frames.length - 1]).toBe("detached"); // the last rendered frame is detached, honest
  });

  it("HIGH-1 (r1 refinement 2): ONE transient poll error is TOLERATED — the lifecycle does not end", async () => {
    let n = 0;
    const client: RestoreLifecycleClient = {
      restoreFleet: async () => ({ fleetAttemptId: "fleet-t" }),
      restoreFleetStatus: async () => {
        n++;
        if (n === 1) throw new Error("ECONNRESET"); // a single blip
        return status({ done: true, verdict: "all_fully_restored", counts: { fully_restored: 2 } });
      },
      cancelRestoreFleet: async () => ({}),
    };
    const final = await driveRestoreLifecycle({ client, onFrame: () => {}, isCancelRequested: () => false, sleep: async () => {} });
    expect(final.phase).toBe("done"); // survived the blip and reached done — not detached, not thrown
    expect(final.done).toBe(true);
  });

  it("HIGH-1 (r1 q2): the error counter RESETS on a good poll — scattered blips never accumulate to a detach", async () => {
    // error, ok, error, ok, error, done — 3 errors total but never 2 in a row; maxConsecutiveErrors:2.
    const seq: Array<"err" | "ok" | "done"> = ["err", "ok", "err", "ok", "err", "done"];
    let i = 0;
    const client: RestoreLifecycleClient = {
      restoreFleet: async () => ({ fleetAttemptId: "fleet-s" }),
      restoreFleetStatus: async () => {
        const step = seq[Math.min(i, seq.length - 1)]!;
        i++;
        if (step === "err") throw new Error("blip");
        return status({ done: step === "done", verdict: "all_fully_restored", counts: { fully_restored: 1 } });
      },
      cancelRestoreFleet: async () => ({}),
    };
    const final = await driveRestoreLifecycle({ client, onFrame: () => {}, isCancelRequested: () => false, sleep: async () => {}, maxConsecutiveErrors: 2, maxPolls: 50 });
    expect(final.phase).toBe("done"); // reset-on-success: no 2-in-a-row streak, so never detaches
  });

  it("HIGH-1: a SUSTAINED error streak detaches (a genuinely unreachable daemon)", async () => {
    const client: RestoreLifecycleClient = {
      restoreFleet: async () => ({ fleetAttemptId: "fleet-d" }),
      restoreFleetStatus: async () => {
        throw new Error("daemon gone");
      },
      cancelRestoreFleet: async () => ({}),
    };
    const final = await driveRestoreLifecycle({ client, onFrame: () => {}, isCancelRequested: () => false, sleep: async () => {}, maxConsecutiveErrors: 3, maxPolls: 50 });
    expect(final.phase).toBe("detached");
  });

  it("HIGH-1 (r1 q1): reattach+cancel POSTs cancel AND emits a frame — observable confirmation, not a silent POST", async () => {
    const frames: Array<{ cancelled: boolean }> = [];
    let cancelCalled = false;
    const client: RestoreLifecycleClient = {
      restoreFleet: async () => ({ fleetAttemptId: "unused" }),
      restoreFleetStatus: async () => status({ done: true, cancelled: true, verdict: "mixed", counts: { fully_restored: 1, not_attempted: 1 } }),
      cancelRestoreFleet: async () => {
        cancelCalled = true;
        return {};
      },
    };
    await driveRestoreLifecycle({ client, attemptId: "fleet-existing", onFrame: (f) => frames.push({ cancelled: f.cancelled }), isCancelRequested: () => true, sleep: async () => {} });
    expect(cancelCalled).toBe(true); // the cancel POST reaches the endpoint on reattach
    expect(frames.length).toBeGreaterThan(0); // AND the resumed poll renders a frame — the operator SEES it
    expect(frames[frames.length - 1]!.cancelled).toBe(true); // the frame shows the cancel took effect
  });

  it("reattach (attemptId set): skips the kick and polls the existing attempt", async () => {
    const kickSpy = vi.fn(async () => ({ fleetAttemptId: "SHOULD-NOT-BE-USED" }));
    let polledId = "";
    const client: RestoreLifecycleClient = {
      restoreFleet: kickSpy,
      restoreFleetStatus: async () => {
        polledId = "polled";
        return status({ done: true, verdict: "mixed", counts: { fully_restored: 1 } });
      },
      cancelRestoreFleet: async () => ({}),
    };
    const final = await driveRestoreLifecycle({ client, attemptId: "fleet-existing", onFrame: () => {}, isCancelRequested: () => false, sleep: async () => {} });
    expect(kickSpy).not.toHaveBeenCalled(); // reattach never re-kicks
    expect(final.attemptId).toBe("fleet-existing");
    expect(polledId).toBe("polled");
  });
});
