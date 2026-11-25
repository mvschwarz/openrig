import { describe, expect, it, vi } from "vitest";
import { terminatePaneInPlace } from "../src/domain/pane-cutover.js";
import { codexTwoRowComposer } from "./fixtures/codex-two-row-composer.js";
import { Pane, bash, claude, claudePane, codexPane, codexTwoRowComposerAt, init, timing } from "./fixtures/runtime-exit-pane.js";

// #3901: an in-place cutover lets the occupant exit through its own shutdown, read from the process table, and only
// then retires the pane. These cells use only pane-cutover.ts, as it was before #3901 too.

describe("terminatePaneInPlace with the occupant's own exit (#3901)", () => {
  it("TERMs Claude Code itself, not the pane's shell, and reports graceful when it exits on it", async () => {
    const pane = claudePane();
    const result = await terminatePaneInPlace(pane.tmux(), "%1", timing, "Retiree", "node-1", { runtime: "claude-code", listProcesses: pane.list });
    expect(result).toMatchObject({ ok: true, path: "graceful", detail: expect.stringMatching(/^Claude Code exited on TERM in \d+\.\d s\.$/) });
    // The pane is held first, the agent gets TERM, then the shell left at its prompt is ended with HUP. The shell never
    // gets the TERM it would ignore, and nothing is killed.
    expect(pane.effects).toEqual(["remain-on-exit", "TERM 200", "root HUP"]);
  });

  it("doesn't take the pane's death as the agent's exit: a shell that dies under a still-running agent doesn't end the cutover", async () => {
    const pane = claudePane();
    pane.runtimeIgnores.add("TERM");
    // After TERM, the pane's shell dies (the pane reads dead) while the agent keeps running, reparented out of the pane.
    pane.beforeRuntimeEffect = () => {
      if (!pane.effects.includes("TERM 200")) return;
      pane.dead = true;
      pane.rows = [init, { ...claude(), ppid: 1 }];
    };
    const result = await terminatePaneInPlace(pane.tmux(), "%1", timing, "Retiree", "%1", { runtime: "claude-code", listProcesses: pane.list });
    // Before #3901 a dead pane read as a graceful exit. The agent can no longer be shown to be the pane's, so KILL is withheld
    // too, and the cutover says the agent didn't exit.
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/did not exit: Claude Code didn't exit within 0\.0 s, and KILL wasn't sent/) });
    expect(pane.effects).toEqual(["remain-on-exit", "TERM 200", "refused KILL 200"]);
  });

  it("an unresponsive agent is killed at the end of the window, reported forced, and the wait stays bounded", async () => {
    const pane = claudePane();
    pane.runtimeIgnores.add("TERM");
    const sleep = vi.fn(async () => {});
    const result = await terminatePaneInPlace(pane.tmux(), "%1", { pollMs: 100, timeoutMs: 3_000, sleep }, "Retiree", "%1",
      { runtime: "claude-code", listProcesses: pane.list });
    expect(result).toMatchObject({ ok: true, path: "forced", detail: "Claude Code didn't exit within 3.0 s of TERM and was killed." });
    expect(pane.effects).toEqual(["remain-on-exit", "TERM 200", "KILL 200", "root HUP"]);
    // One window of polls for TERM; the KILL ended it on the first read after.
    expect(sleep.mock.calls.length).toBe(30);
  });

  it("a runtime that already exited (a bare shell) is no agent: nothing is signalled but the shell's HUP, and nothing was forced", async () => {
    const pane = new Pane([bash(100)]);
    const result = await terminatePaneInPlace(pane.tmux(), "%1", timing, "Retiree", "%1", { runtime: "claude-code", listProcesses: pane.list });
    expect(result).toEqual({ ok: true, path: "graceful", detail: "No Claude Code was running in the pane, only its shell." });
    expect(pane.effects).toEqual(["remain-on-exit", "root HUP"]);
  });

  it("an agent the shell holds in the background (stopped) isn't read as no agent: the pane is stopped as before, reported forced", async () => {
    const stopped = { ...claude(), tpgid: 100 };
    const pane = new Pane([bash(100), stopped]);
    const result = await terminatePaneInPlace(pane.tmux(), "%1", timing, "Retiree", "%1", { runtime: "claude-code", listProcesses: pane.list });
    expect(result).toMatchObject({ ok: true, path: "forced", detail: expect.stringMatching(/^Claude Code couldn't be identified in the pane/) });
    expect(pane.effects).toEqual(["remain-on-exit", "root TERM", "root KILL"]);
  });

  it("a pane whose root is the agent itself (no shell): its exit is the pane's, so no HUP follows", async () => {
    const direct = { ...claude(), ppid: 1, pgid: 200, tpgid: 200 };
    const pane = new Pane([direct], 200);
    const result = await terminatePaneInPlace(pane.tmux(), "%1", timing, "Retiree", "%1", { runtime: "claude-code", listProcesses: pane.list });
    expect(result).toMatchObject({ ok: true, path: "graceful" });
    expect(pane.effects).toEqual(["remain-on-exit", "TERM 200"]);
  });

  it("a runtime without its own exit keeps the pane-level TERM then KILL", async () => {
    const pane = new Pane([bash(100)]);
    const result = await terminatePaneInPlace(pane.tmux(), "%1", timing, "Retiree", "%1", { runtime: "pi", listProcesses: pane.list });
    expect(result).toMatchObject({ ok: true, path: "forced", detail: "The pane's process didn't exit within 0.0 s of TERM and was killed." });
    expect(pane.effects).toEqual(["remain-on-exit", "root TERM", "root KILL"]);
  });
});

describe("Codex's own exit: /exit, never over a draft or into a prompt (#3901)", () => {
  it("types /exit as keys into an empty box, presses Enter once it reads back alone, and reports graceful", async () => {
    const pane = codexPane();
    const result = await terminatePaneInPlace(pane.tmux(), "%1", timing, "Retiree", "node-1", { runtime: "codex", listProcesses: pane.list });
    expect(result).toMatchObject({ ok: true, path: "graceful", detail: expect.stringMatching(/^Codex exited through \/exit in \d+\.\d s\.$/) });
    expect(pane.effects).toEqual(["remain-on-exit", "type /exit (keys)", "keys Enter", "root HUP"]);
  });

  it.each([
    ["a person's draft", codexTwoRowComposer("a real draft"), "its input box held text"],
    ["an open prompt", codexTwoRowComposer("1. Approve action"), "its input box couldn't be read"],
    ["an unreadable screen", null, "its input box couldn't be read"],
  ])("with %s, nothing is typed; Codex is ended with TERM, reported forced", async (_case, composer, why) => {
    const pane = codexPane();
    pane.composer = composer;
    const result = await terminatePaneInPlace(pane.tmux(), "%1", timing, "Retiree", "%1", { runtime: "codex", listProcesses: pane.list });
    expect(result).toMatchObject({ ok: true, path: "forced", detail: `Codex was ended with TERM, which doesn't run its own shutdown, because /exit couldn't be used: ${why}.` });
    expect(pane.effects).toEqual(["remain-on-exit", "TERM 300", "root HUP"]);
  });

  it("doesn't press Enter when the box reads back with other text (a person typing at the same time)", async () => {
    const pane = codexPane();
    pane.afterTyping = () => codexTwoRowComposerAt("hello/exit");
    const result = await terminatePaneInPlace(pane.tmux(), "%1", timing, "Retiree", "%1", { runtime: "codex", listProcesses: pane.list });
    expect(result).toMatchObject({ ok: true, path: "forced", detail: expect.stringMatching(/the typed \/exit wasn't read back alone in its input box, so Enter wasn't sent/) });
    expect(pane.effects).toEqual(["remain-on-exit", "type /exit (keys)", "TERM 300", "root HUP"]);
  });

  it("a Codex that doesn't exit after /exit is killed at the end of the window and reported forced", async () => {
    const pane = codexPane();
    const tmux = pane.tmux();
    (tmux.sendKeys as ReturnType<typeof vi.fn>).mockImplementation(async (_t: string, keys: string[]) => { pane.effects.push(`keys ${keys.join(" ")}`); return { ok: true }; });
    const result = await terminatePaneInPlace(tmux, "%1", timing, "Retiree", "%1", { runtime: "codex", listProcesses: pane.list });
    expect(result).toMatchObject({ ok: true, path: "forced", detail: "Codex didn't exit within 0.0 s of /exit and was killed." });
    expect(pane.effects).toEqual(["remain-on-exit", "type /exit (keys)", "keys Enter", "KILL 300", "root HUP"]);
  });
});
