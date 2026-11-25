import { describe, expect, it, vi } from "vitest";
import { exitPaneRuntime, pinTerminal, runtimeExitStep } from "../src/domain/runtime-exit.js";
import { codexTwoRowComposer } from "./fixtures/codex-two-row-composer.js";
import { T, bash, claude, claudePane, codex, codexPane, timing, type Pane } from "./fixtures/runtime-exit-pane.js";

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

// #3901 (X-F2): an agent that ends after its window, just before KILL's check, is reported by what ended it.
describe("an exit just past the window, before KILL (#3901)", () => {
  /** It ignores TERM for the window, then ends just as KILL is about to be checked. */
  function endsJustBeforeKill(pane: Pane, pid: number): void {
    pane.runtimeIgnores.add("TERM");
    pane.beforeRuntimeEffect = () => { if (pane.effects.some((effect) => effect.startsWith("TERM "))) pane.runtimeGone(pid); };
  }

  it("a Codex that couldn't take /exit and ended on TERM after the window stays forced, naming TERM and why", async () => {
    const pane = codexPane();
    pane.composer = codexTwoRowComposer("a real draft");
    endsJustBeforeKill(pane, codex.pid);
    const outcome = await exitPaneRuntime(pane.tmux(), { pane: "%1", inputTarget: "%1", runtime: "codex" }, timing, pane.list);
    expect(pane.effects).toEqual(["TERM 300", "refused KILL 300"]);
    expect(outcome).toEqual({ state: "exited", path: "forced", detail: expect.stringMatching(
      /^Codex was ended with TERM, which doesn't run its own shutdown, just past the 0\.0 s window, because \/exit couldn't be used: its input box held text\.$/) });
  });

  it("Claude Code ending on TERM after the window is still its own shutdown: graceful", async () => {
    const pane = claudePane();
    endsJustBeforeKill(pane, 200);
    const outcome = await exitPaneRuntime(pane.tmux(), { pane: "%1", inputTarget: "%1", runtime: "claude-code" }, timing, pane.list);
    expect(pane.effects).toEqual(["TERM 200", "refused KILL 200"]);
    expect(outcome).toEqual({ state: "exited", path: "graceful", detail: expect.stringMatching(/^Claude Code exited by itself \d+\.\d s after TERM, just past the 0\.0 s window\.$/) });
  });
});

// #3901 (X-F5): what can't be checked stays unknown. Only an agent seen running after its KILL is "still running".
describe("an exit that can't be checked is unverified, not still running (#3901)", () => {
  it("the first read is valid, then the process table can't be read after TERM: unverified, and KILL isn't sent blind", async () => {
    const pane = claudePane();
    const rows = pane.list.getMockImplementation()!;
    pane.list.mockImplementation(async () => { if (pane.effects.includes("TERM 200")) throw new Error("table unreadable"); return rows(); });
    const outcome = await exitPaneRuntime(pane.tmux(), { pane: "%1", inputTarget: "%1", runtime: "claude-code" }, timing, pane.list);
    expect(pane.effects).toEqual(["TERM 200", "refused KILL 200"]);
    expect(outcome).toEqual({ state: "unverified", detail: "Claude Code was sent TERM, but its exit couldn't be checked: the process table couldn't be read, and KILL wasn't sent (changed)." });
  });

  it("KILL withheld because the agent is no longer the pane's one agent (a second one appeared): unverified", async () => {
    const pane = claudePane();
    pane.runtimeIgnores.add("TERM");
    // A SessionEnd hook starts another claude in the pane's foreground while the first is shutting down.
    pane.beforeRuntimeEffect = () => {
      if (pane.effects.includes("TERM 200")) pane.rows = [...pane.rows.filter((row) => row.pid !== 201), { ...claude(T("08")), pid: 201, ppid: 200 }];
    };
    const outcome = await exitPaneRuntime(pane.tmux(), { pane: "%1", inputTarget: "%1", runtime: "claude-code" }, timing, pane.list);
    expect(pane.effects).toEqual(["TERM 200", "refused KILL 200"]);
    expect(outcome).toEqual({ state: "unverified", detail: "Claude Code didn't exit within 0.0 s of TERM, and KILL wasn't sent (changed), so its end wasn't verified." });
  });

  it("an agent seen running after its KILL is still running", async () => {
    const pane = claudePane();
    pane.runtimeIgnores.add("TERM");
    pane.runtimeIgnores.add("KILL");
    const outcome = await exitPaneRuntime(pane.tmux(), { pane: "%1", inputTarget: "%1", runtime: "claude-code" }, timing, pane.list);
    expect(outcome).toEqual({ state: "still_running", detail: "Claude Code was still running after TERM and KILL." });
  });
});

// #3901 (X-F4): every effect is held to the terminal (tmux session and server) the pane was first read in.
describe("an effect held to the pane's terminal (#3901)", () => {
  it("a pane that is another server's by the time of the signal gets nothing", async () => {
    const pane = claudePane();
    const tmux = pane.tmux();
    const pin = pinTerminal(tmux, (await tmux.paneTerminal("%1"))!);
    // The server is replaced between the first read and the TERM; the new one reuses the pane id, and runs a Claude too.
    pane.beforeRuntimeEffect = () => { pane.server = { pid: "4001", start: "1764061290" }; };
    const outcome = await exitPaneRuntime(tmux, { pane: "%1", inputTarget: "%1", runtime: "claude-code", pin }, timing, pane.list);
    expect(pane.effects).toEqual(["refused TERM 200"]);
    expect(outcome).toEqual({ state: "terminal_changed", detail: "Claude Code's pane is no longer in the tmux session and server it was first read in "
      + "(the server may have been replaced), so nothing more was sent to it." });
  });

  it("a terminal that can't be read is never sent the agent's exit", async () => {
    const pane = claudePane();
    const outcome = await exitPaneRuntime(pane.tmux(), { pane: "%1", inputTarget: "%1", runtime: "claude-code", pin: null }, timing, pane.list);
    expect(pane.effects).toEqual([]);
    expect(outcome).toEqual({ state: "not_identified", detail: "Claude Code's terminal (its tmux session and server) couldn't be read, so it wasn't sent its own exit." });
  });
});
