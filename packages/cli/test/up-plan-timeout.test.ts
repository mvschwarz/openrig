// #1654: a plan runs the same preflight as an apply (skill resolution, and a Codex profile probe of up to 10 s per
// profile), so `rig up --plan` waits as long as an apply does. A plan that still times out created or changed no rig
// or seat, so it says that instead of the UNKNOWN-outcome guidance meant for writes.
import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { DaemonClient, DaemonTimeoutError } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

const remote = vi.hoisted(() => ({ calls: [] as Array<{ path: string; timeoutMs?: number }> }));
vi.mock("../src/remote-host-ops.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    runRemoteHttpOp: vi.fn(async (_host: string, _method: string, path: string, _body: unknown, _deps: unknown, options?: { timeoutMs?: number }) => {
      remote.calls.push({ path, timeoutMs: options?.timeoutMs });
      return { ok: true, data: { status: "planned", runId: "r", stages: [], errors: [], warnings: [] } };
    }),
  };
});

const { upCommand } = await import("../src/commands/up.js");

function lifecycleDeps(): LifecycleDeps {
  return {
    acquireStartLock: () => ({ recordChild: vi.fn(), release: vi.fn() }),
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn((p: string) => (p === STATE_FILE
      ? JSON.stringify({ pid: 123, port: 7433, db: "test.sqlite", startedAt: "2026-10-21T00:00:00Z" } as DaemonState)
      : null)),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn((p: string) => p === STATE_FILE),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

async function runUp(args: string[], post: (path: string, body: unknown, options?: { timeoutMs?: number }) => Promise<unknown>) {
  const deps: StatusDeps = { lifecycleDeps: lifecycleDeps(), clientFactory: () => ({ post } as unknown as DaemonClient) };
  const prog = new Command();
  prog.exitOverride();
  prog.addCommand(upCommand({ ...deps, preflightExec: async () => "" }));
  const logs: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
  const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
  process.exitCode = undefined;
  try {
    await prog.parseAsync(["node", "rig", "up", ...args]);
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { logs, exitCode };
}

describe("rig up --plan and the daemon's time to answer", () => {
  it("waits as long as an apply does", async () => {
    let timeoutMs: number | undefined;
    const post = vi.fn(async (_path: string, _body: unknown, options?: { timeoutMs?: number }) => {
      timeoutMs = options?.timeoutMs;
      return { status: 200, data: { status: "planned", runId: "r", stages: [], errors: [], warnings: [] } };
    });
    await runUp(["/tmp/rig.yaml", "--plan", "--json"], post);
    expect(post).toHaveBeenCalledTimes(1);
    expect(timeoutMs).toBe(120_000);
  });

  it("waits as long as an apply does on another host", async () => {
    remote.calls.length = 0;
    await runUp(["/tmp/rig.yaml", "--plan", "--json", "--host", "vps-a"], vi.fn());
    expect(remote.calls.filter((c) => c.path === "/api/up").map((c) => c.timeoutMs)).toEqual([120_000]);
  });

  it("a plan that times out says no rig or seat changed, not that the outcome is unknown", async () => {
    const post = vi.fn(async () => { throw new DaemonTimeoutError("Request to http://127.0.0.1:7433/api/up timed out after 120000ms"); });
    const { logs, exitCode } = await runUp(["/tmp/rig.yaml", "--plan"], post);
    const text = logs.join("\n");
    expect(post).toHaveBeenCalledTimes(1);
    expect(text).toContain("A plan doesn't create or change any rig or seat");
    expect(text).not.toContain("UNKNOWN");
    expect(exitCode).toBe(1);
  });
});
