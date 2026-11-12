import { describe, expect, it, vi } from "vitest";
import { createDaemon } from "../src/startup.js";

// #2789: the daemon re-sends a seat's unroutable wakes from the same activity hook as prompt-clear recovery.
describe("the daemon's own wiring", () => {
  it("an agent's activity runs the reachable-seat wake retry for that seat, beside the prompt-clear retry", async () => {
    const originalNoKernel = process.env.OPENRIG_NO_KERNEL;
    process.env.OPENRIG_NO_KERNEL = "1";
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 404 }));
    let daemon: Awaited<ReturnType<typeof createDaemon>> | undefined;
    try {
      daemon = await createDaemon({ dbPath: ":memory:", tmuxExec: async () => "", cmuxExec: async () => "" } as Parameters<typeof createDaemon>[0]);
      const { queueRepo, eventBus } = daemon.deps;
      const reachable = vi.spyOn(queueRepo, "retryUnroutableWakesOnReachable").mockResolvedValue();
      const promptClear = vi.spyOn(queueRepo, "retryPromptWakesOnClear").mockResolvedValue();
      eventBus.emit({ type: "agent.activity", rigId: "rig", nodeId: "node", sessionName: "worker@wiring", runtime: "claude-code",
        activity: { state: "idle", reason: "stop", evidenceSource: "hook", sampledAt: new Date().toISOString(), evidence: "Stop" } } as never);
      // The seat's state is read from the daemon's own activity stores, so only the seat is fixed here.
      await vi.waitFor(() => expect(reachable.mock.calls.map(([session]) => session)).toContain("worker@wiring"));
      expect(promptClear.mock.calls.map(([session]) => session)).toContain("worker@wiring");
    } finally {
      daemon?.eventLoopMonitor.stop();
      daemon?.db.close();
      fetch.mockRestore();
      if (originalNoKernel === undefined) delete process.env.OPENRIG_NO_KERNEL;
      else process.env.OPENRIG_NO_KERNEL = originalNoKernel;
    }
  });
});
