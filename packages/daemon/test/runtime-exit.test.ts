import { describe, expect, it, vi } from "vitest";
import { exitPaneRuntime, runtimeExitStep } from "../src/domain/runtime-exit.js";
import { T, bash, claude, claudePane, timing } from "./fixtures/runtime-exit-pane.js";

// #3901: the agent's own exit, read from the process table (runtime-exit.ts). The pane-level cells are in
// pane-cutover-runtime-exit.test.ts.

describe("runtimeExitStep", () => {
  it("knows Claude Code's and Codex's own exits, and nothing else's", () => {
    expect(runtimeExitStep("claude-code")).toBe("term");
    expect(runtimeExitStep("codex")).toBe("typed_exit");
    expect(runtimeExitStep("pi")).toBeNull();
    expect(runtimeExitStep(null)).toBeNull();
  });
});

describe("exitPaneRuntime (#3901)", () => {
  it("observes the agent's exit apart from the pane's: a pane still alive after the agent exits is retired, and the report is the agent's", async () => {
    const pane = claudePane();
    const tmux = pane.tmux();
    const outcome = await exitPaneRuntime(tmux, { pane: "%1", inputTarget: "%1", runtime: "claude-code" }, timing, pane.list);
    expect(outcome).toMatchObject({ state: "exited", path: "graceful" });
    // The agent is gone; its shell, and so its pane, are not.
    expect(pane.dead).toBe(false);
    expect(pane.rows.map((row) => row.pid)).toEqual([1, 100]);
    expect(tmux.isPaneDead).not.toHaveBeenCalled();
  });

  it("re-checks the agent's identity before the signal: a reused pid (another start time) is never signalled", async () => {
    const pane = claudePane();
    // Between the observation and the effect, pid 200 becomes another process.
    pane.beforeRuntimeEffect = () => { pane.rows = [bash(200), claude(T("59"))]; };
    const outcome = await exitPaneRuntime(pane.tmux(), { pane: "%1", inputTarget: "%1", runtime: "claude-code" }, timing, pane.list);
    // The observed process (pid 200 started at :05) is gone; the new pid 200 is never signalled.
    expect(outcome).toEqual({ state: "exited", path: "graceful", detail: "Claude Code exited by itself before it was signalled." });
    expect(pane.effects).toEqual(["refused TERM 200"]);
  });

  it("re-checks that the effect's target is the observed pane: another occupant's pane is refused", async () => {
    const pane = claudePane();
    const tmux = pane.tmux();
    (tmux.signalPaneRuntime as ReturnType<typeof vi.fn>).mockImplementation(async (_t: string, pid: number, signal: string, still: (p: string) => Promise<boolean>) => {
      if (!await still("%other")) { pane.effects.push(`refused ${signal} ${pid}`); return { ok: false, code: "process_changed", message: "changed" }; }
      pane.effects.push(`${signal} ${pid}`);
      return { ok: true };
    });
    const outcome = await exitPaneRuntime(tmux, { pane: "%1", inputTarget: "node-1", runtime: "claude-code" }, timing, pane.list);
    expect(outcome).toEqual({ state: "not_identified", detail: "Claude Code wasn't signalled: changed" });
    expect(pane.effects).toEqual(["refused TERM 200"]);
  });
});
