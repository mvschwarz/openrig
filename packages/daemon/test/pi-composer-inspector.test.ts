import { describe, expect, it, vi } from "vitest";
import { createPiComposerInspector } from "../src/domain/pi-composer-inspector.js";
import type { PiRunnerState } from "../src/adapters/pi-runner-protocol.js";

describe("Pi editor inspection boundary", () => {
  it("sends nothing when the runner does not advertise editor inspection", async () => {
    const sendText = vi.fn();
    const inspect = createPiComposerInspector({
      readSidecar: () => ({ ready: true, updatedAt: "now" }), tmux: { sendText },
    });
    const result = await inspect({ sessionName: "pi@test", target: "%7", expected: "/openrig-compact" });
    expect(result).toBe("unknown");
    expect(sendText).not.toHaveBeenCalled();
  });

  it.each(["wrong-id", "old-time", "new-launch", "exited"])("refuses an inspection reply with %s", async failure => {
    let time = Date.parse("2026-11-11T10:00:00Z");
    let state: PiRunnerState = { ready: true, launchId: "launch", updatedAt: new Date(time).toISOString(),
      inputInspection: { protocol: 1, probeId: "", state: "unknown", updatedAt: new Date(time).toISOString() } };
    const inspect = createPiComposerInspector({
      readSidecar: () => state, now: () => time, sleep: async ms => { time += ms; },
      tmux: { sendText: async (_target, text) => {
        state = { ...state, launchId: failure === "new-launch" ? "other" : "launch",
          ...(failure === "exited" ? { exited: { code: 1, at: new Date(time).toISOString() } } : {}),
          inputInspection: { protocol: 1, probeId: failure === "wrong-id" ? "old" : text.split(" ")[1] ?? "",
            state: "empty", updatedAt: new Date(time - (failure === "old-time" ? 1 : 0)).toISOString() } };
        return { ok: true };
      } },
    });
    const result = await inspect({ sessionName: "pi@test", target: "%7", expected: "/openrig-compact" });
    expect(result).toBe("unknown");
  });
});
