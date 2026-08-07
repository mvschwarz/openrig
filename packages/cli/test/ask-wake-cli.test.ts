import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { askCommand } from "../src/commands/ask.js";
import type { StatusDeps } from "../src/commands/status.js";
import type { WakeRunner } from "../src/ask-wake.js";

function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = [];
    const ol = console.log, oe = console.error;
    const prev = process.exitCode;
    process.exitCode = undefined;
    console.log = (...a: unknown[]) => logs.push(a.join(" "));
    console.error = (...a: unknown[]) => logs.push(a.join(" "));
    try { await fn(); } finally { console.log = ol; console.error = oe; }
    const exitCode = process.exitCode;
    process.exitCode = prev;
    resolve({ logs, exitCode });
  });
}

function wakeDeps(runner: WakeRunner): StatusDeps {
  // wake path never touches the daemon; lifecycle/client are inert here.
  return {
    lifecycleDeps: {} as never,
    clientFactory: () => ({ post: vi.fn() }) as never,
    // injected wake runner (typed via the AskCommandDeps extension)
    wakeRunner: runner,
    wakeFileLocator: () => null,
  } as unknown as StatusDeps;
}

function makeCmd(runner: WakeRunner): Command {
  const prog = new Command();
  prog.exitOverride();
  prog.addCommand(askCommand(wakeDeps(runner)));
  return prog;
}

describe("rig ask --wake (L3 CLI)", () => {
  it("wakes by raw token and prints the snapshot answer (checked-not-believed)", async () => {
    const runner: WakeRunner = vi.fn(async () => ({ stdout: "the gateway plan is A2 first", stderr: "", code: 0, timedOut: false }));
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd(runner).parseAsync(["node", "rig", "ask", "my-rig", "summarize", "--wake", "3f2a-abc"]);
    });
    const out = logs.join("\n");
    expect(runner).toHaveBeenCalled();
    expect(out).toMatch(/snapshot answer.*checked, not believed/i);
    expect(out).toContain("the gateway plan is A2 first");
    expect(exitCode).toBeUndefined();
  });

  it("refuses a seat target (needs L3b resolution), exit 2 — never a silent wrong wake", async () => {
    const runner: WakeRunner = vi.fn(async () => ({ stdout: "x", stderr: "", code: 0, timedOut: false }));
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd(runner).parseAsync(["node", "rig", "ask", "my-rig", "q", "--wake", "dev-planner@my-rig"]);
    });
    const out = logs.join("\n");
    expect(runner).not.toHaveBeenCalled(); // did NOT wake a guessed/unresolved target
    expect(out).toMatch(/seat->token|resolution/i);
    expect(exitCode).toBe(2);
  });

  it("reports a wake timeout honestly with a non-zero exit — never a silent hang", async () => {
    const runner: WakeRunner = vi.fn(async () => ({ stdout: "", stderr: "", code: null, timedOut: true }));
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd(runner).parseAsync(["node", "rig", "ask", "my-rig", "q", "--wake", "tok", "--wake-timeout", "5"]);
    });
    const out = logs.join("\n");
    expect(out).toMatch(/did not return|bounded timeout/i);
    expect(exitCode).toBe(2);
  });
});
