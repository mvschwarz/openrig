// rig seat set-permissions-to: the CLI posts the chosen person (or a clear) with its reason, prints what changed, and
// refuses a request that names both or neither before sending anything.
import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import { seatCommand } from "../src/commands/seat.js";
import { STATE_FILE, type DaemonState, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function mockLifecycleDeps(): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn((p: string) => p === STATE_FILE
      ? JSON.stringify({ pid: 123, port: 7433, db: "test.sqlite", startedAt: "2026-04-20T00:00:00Z" } as DaemonState) : null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn((p: string) => p === STATE_FILE),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

function makeCommand(response: { status: number; data: unknown }, calls: Array<{ path: string; body: unknown }>): Command {
  const deps: StatusDeps = {
    lifecycleDeps: mockLifecycleDeps(),
    clientFactory: () => ({
      get: vi.fn(async (path: string) => { calls.push({ path, body: undefined }); return response; }),
      post: vi.fn(async (path: string, body: unknown) => { calls.push({ path, body }); return response; }),
    }) as unknown as ReturnType<StatusDeps["clientFactory"]>,
  };
  const program = new Command();
  program.addCommand(seatCommand(deps));
  const exitOverride = (cmd: Command): void => { cmd.exitOverride(); for (const sub of cmd.commands) exitOverride(sub as Command); };
  exitOverride(program);
  return program;
}

async function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; errors: string[]; exitCode: number | undefined }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation((...args) => { logs.push(args.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...args) => { errors.push(args.join(" ")); });
  try {
    await fn();
  } finally {
    vi.restoreAllMocks();
  }
  const exitCode = process.exitCode;
  process.exitCode = originalExitCode;
  return { logs, errors, exitCode };
}

afterEach(() => { vi.restoreAllMocks(); });

const seat = { logicalId: "dev.runner", rigName: "perm-rig" };

describe("rig seat set-permissions-to", () => {
  it("posts the chosen person and reason to /api/seat/set-permissions-to/<seat>, and prints the change", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const program = makeCommand({ status: 200, data: { ok: true, seat, from: null, to: "mike@external", changed: true } }, calls);
    const { logs, exitCode } = await captureLogs(async () => {
      await program.parseAsync(["node", "rig", "seat", "set-permissions-to", "dev-runner@perm-rig", "--to", "mike@external", "--reason", "Mike approves"]);
    });
    expect(calls[0]!.path).toBe("/api/seat/set-permissions-to/dev-runner%40perm-rig");
    expect(calls[0]!.body).toEqual({ to: "mike@external", reason: "Mike approves" });
    expect(exitCode).toBeUndefined();
    expect(logs.join("\n")).toContain("dev.runner@perm-rig's permission requests: no one (requests are refused) -> mike@external (audited).");
  });

  it("--clear posts clear", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const program = makeCommand({ status: 200, data: { ok: true, seat, from: "mike@external", to: null, changed: true } }, calls);
    const { logs } = await captureLogs(async () => {
      await program.parseAsync(["node", "rig", "seat", "set-permissions-to", "dev.runner", "--clear", "--reason", "back to refusal"]);
    });
    expect(calls[0]!.body).toEqual({ clear: true, reason: "back to refusal" });
    expect(logs.join("\n")).toContain("mike@external -> no one (requests are refused)");
  });

  it("requires exactly one of --to or --clear, before any request", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    for (const extra of [[], ["--to", "mike@external", "--clear"]]) {
      const program = makeCommand({ status: 200, data: {} }, calls);
      const { errors, exitCode } = await captureLogs(async () => {
        await program.parseAsync(["node", "rig", "seat", "set-permissions-to", "dev.runner", "--reason", "x", ...extra]);
      });
      expect(exitCode).toBe(1);
      expect(errors.join("\n")).toContain("exactly one of --to <person> or --clear");
    }
    expect(calls).toHaveLength(0);
  });
});
