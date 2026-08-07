import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { askCommand } from "../src/commands/ask.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
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

function mockLifecycleDeps(): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

// Raw-token wakes never touch the daemon — inert lifecycle/client are fine.
function tokenDeps(runner: WakeRunner): StatusDeps {
  return {
    lifecycleDeps: {} as never,
    clientFactory: () => ({ post: vi.fn() }) as never,
    wakeRunner: runner,
    wakeFileLocator: () => null,
  } as unknown as StatusDeps;
}

// Seat wakes resolve via the daemon first: running status + a post() that returns
// the WakeResolution.
function seatDeps(runner: WakeRunner, resolution: unknown, httpStatus = 200): StatusDeps {
  const post = vi.fn(async () => ({ status: httpStatus, data: resolution }));
  return {
    lifecycleDeps: {
      ...mockLifecycleDeps(),
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) =>
        p === STATE_FILE ? JSON.stringify({ pid: 1, port: 5000, db: "t", startedAt: "2026-01-01T00:00:00Z" } as DaemonState) : null,
      ),
      fetch: vi.fn(async () => ({ ok: true })),
    },
    clientFactory: () => ({ post }) as never,
    wakeRunner: runner,
    wakeFileLocator: () => null,
    __post: post,
  } as unknown as StatusDeps;
}

function makeCmd(deps: StatusDeps): Command {
  const prog = new Command();
  prog.exitOverride();
  prog.addCommand(askCommand(deps));
  return prog;
}

describe("rig ask --wake (L3 CLI)", () => {
  it("wakes by raw token and prints the snapshot answer (checked-not-believed)", async () => {
    const runner: WakeRunner = vi.fn(async () => ({ stdout: "the gateway plan is A2 first", stderr: "", code: 0, timedOut: false }));
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd(tokenDeps(runner)).parseAsync(["node", "rig", "ask", "my-rig", "summarize", "--wake", "3f2a-abc"]);
    });
    const out = logs.join("\n");
    expect(runner).toHaveBeenCalled();
    expect(out).toMatch(/snapshot answer.*checked, not believed/i);
    expect(out).toContain("the gateway plan is A2 first");
    expect(exitCode).toBeUndefined();
  });

  it("reports a wake timeout honestly with a non-zero exit — never a silent hang", async () => {
    const runner: WakeRunner = vi.fn(async () => ({ stdout: "", stderr: "", code: null, timedOut: true }));
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd(tokenDeps(runner)).parseAsync(["node", "rig", "ask", "my-rig", "q", "--wake", "tok", "--wake-timeout", "5"]);
    });
    const out = logs.join("\n");
    expect(out).toMatch(/did not return|bounded timeout/i);
    expect(exitCode).toBe(2);
  });

  it("renders a FAILED wake honestly (exit N + stderr), non-zero exit — never a fake success", async () => {
    const runner: WakeRunner = vi.fn(async () => ({ stdout: "", stderr: "resume: invalid session token", code: 1, timedOut: false }));
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd(tokenDeps(runner)).parseAsync(["node", "rig", "ask", "my-rig", "q", "--wake", "bad"]);
    });
    const out = logs.join("\n");
    expect(out).toMatch(/wake failed.*exit 1/i);
    expect(out).not.toMatch(/no answer returned/i);
    expect(exitCode).toBe(2);
  });

  it("resolves a SEAT target via the daemon, then wakes with the resolved token+runtime", async () => {
    const runner: WakeRunner = vi.fn(async () => ({ stdout: "resolved-and-woke", stderr: "", code: 0, timedOut: false }));
    const deps = seatDeps(runner, { resolved: true, token: "resolved-tok", runtime: "codex", sessionId: 7 });
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ask", "my-rig", "q", "--wake", "dev-planner@my-rig"]);
    });
    const out = logs.join("\n");
    // resolved runtime (codex) and token used; answer rendered
    expect(runner).toHaveBeenCalled();
    const call = (runner as unknown as { mock: { calls: [string, string[], unknown][] } }).mock.calls[0]!;
    expect(call[0]).toBe("codex");
    expect(call[1]).toContain("resolved-tok");
    expect(out).toContain("resolved-and-woke");
    expect(exitCode).toBeUndefined();
  });

  it("renders the teaching REFUSAL for an unresolvable seat (lists tenures), exit 2, no wake", async () => {
    const runner: WakeRunner = vi.fn(async () => ({ stdout: "x", stderr: "", code: 0, timedOut: false }));
    const deps = seatDeps(runner, {
      resolved: false,
      reason: "Generation 5 does not exist for seat 'dev-planner@my-rig' — only 2 tenure(s) recorded.",
      known: [
        { generation: 1, sessionId: 20, tokenPresent: true, createdAt: "2026-08-06" },
        { generation: 2, sessionId: 10, tokenPresent: false, createdAt: "2026-08-05" },
      ],
    });
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "ask", "my-rig", "q", "--wake", "dev-planner@my-rig@5"]);
    });
    const out = logs.join("\n");
    expect(runner).not.toHaveBeenCalled(); // never a guessed wake
    expect(out).toMatch(/only 2 tenure/i);
    expect(out).toMatch(/gen 1: session 20/);
    expect(out).toMatch(/no resume token/); // gen 2 flagged token-absent
    expect(exitCode).toBe(2);
  });
});
