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

  it("returns the last (not-done) frame on the poll ceiling — restore continues on the daemon", async () => {
    const { client } = scriptedClient([status({ done: false, counts: { fully_restored: 1 } })]);
    const final = await driveRestoreLifecycle({
      client,
      onFrame: () => {},
      isCancelRequested: () => false,
      sleep: async () => {},
      maxPolls: 3,
    });
    expect(final.done).toBe(false);
    expect(final.phase).toBe("running");
  });
});
