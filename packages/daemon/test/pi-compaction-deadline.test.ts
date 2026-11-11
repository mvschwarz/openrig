import { expect, it, vi } from "vitest";
import { RunnerCore } from "../src/adapters/pi-runner.js";
import type { PiRunnerState } from "../src/adapters/pi-runner-protocol.js";
import { PiCompactionService } from "../src/domain/pi-compaction-service.js";
import { piCompactionTerminal } from "./helpers/pi-compaction-terminal.js";

it("never sends late Enter when the compact paste outlives the control deadline", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T10:00:00Z"));
  let sidecar: PiRunnerState | null = null;
  const core = new RunnerCore({
    sendRpc: command => {
      if (command.type !== "get_state") return;
      vi.setSystemTime(Date.now() + 1);
      core.handlePiLine(JSON.stringify({ type: "response", id: command.id, success: true,
        data: { sessionFile: "/synthetic/session", isStreaming: false, isCompacting: false } }));
    },
    writeSidecar: state => { sidecar = state; }, postActivity: () => {},
    mirrorLine: () => {}, mirrorAppend: () => {}, now: () => new Date().toISOString(),
  }, { sessionName: "pi@test" });
  core.start();
  const terminal = piCompactionTerminal(core);
  let release: (() => Promise<void>) | undefined;
  const sendKeys = vi.fn(terminal.tmux.sendKeys);
  const service = new PiCompactionService({ readSidecar: () => sidecar, resolveTarget: () => "%7",
    tmux: { sendKeys, sendText: (target, text) => text === "/openrig-compact"
      ? new Promise(resolve => { release = async () => { resolve(await terminal.tmux.sendText(target, text)); }; })
      : terminal.tmux.sendText(target, text) },
  });
  try {
    const pending = service.trigger({ nodeId: "node", sessionName: "pi@test", runtime: "pi" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toEqual({ triggered: false, reason: "live_state_unavailable" });
    expect(release).toBeTypeOf("function");
    await release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(sendKeys).toHaveBeenCalledTimes(1);
    expect(terminal.editor.line).toBe("/openrig-compact");
  } finally {
    terminal.editor.close();
    vi.useRealTimers();
  }
});
