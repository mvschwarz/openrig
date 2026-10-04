// S5 (OPR.0.5.4.7) — CLI surface for rig seat set-model / stop / clean: required
// options, route paths + bodies posted, human output, refusal printing, --json
// pass-through with non-zero exit.
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
    readFile: vi.fn((p: string) => {
      if (p === STATE_FILE) {
        return JSON.stringify({ pid: 123, port: 7433, db: "test.sqlite", startedAt: "2026-04-20T00:00:00Z" } as DaemonState);
      }
      return null;
    }),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn((p: string) => p === STATE_FILE),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

function makeDeps(response: { status: number; data: unknown }, calls: Array<{ path: string; body: unknown }>): StatusDeps {
  return {
    lifecycleDeps: mockLifecycleDeps(),
    clientFactory: () => ({
      get: vi.fn(async (path: string) => { calls.push({ path, body: undefined }); return response; }),
      post: vi.fn(async (path: string, body: unknown) => { calls.push({ path, body }); return response; }),
    }) as unknown as ReturnType<StatusDeps["clientFactory"]>,
  };
}

function applyExitOverride(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) applyExitOverride(sub as Command);
}

function makeCommand(deps: StatusDeps): Command {
  const program = new Command();
  program.addCommand(seatCommand(deps));
  applyExitOverride(program);
  return program;
}

async function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; errors: string[]; exitCode: number | undefined }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args.join(" ")));
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  const exitCode = process.exitCode;
  process.exitCode = originalExitCode;
  return { logs, errors, exitCode };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("#729 startup warnings", () => {
  it.each([[200, false], [200, true], [409, false], [409, true]] as const)("seat launch retains warnings and HTTP %s (json=%s)", async (status, json) => {
    const warning = "Startup submission unverified: capture unavailable";
    const calls: Array<{ path: string; body: unknown }> = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = makeDeps({ status, data: { ok: status === 200, message: "Identity needs attention", warnings: [warning] } }, calls);
    const { logs, exitCode } = await captureLogs(() => makeCommand(deps).parseAsync([
      "node", "rig", "seat", "launch", "dev@fixture", "--fresh", "--reason", "requested", ...(json ? ["--json"] : []),
    ]));
    expect(exitCode).toBe(status === 200 ? undefined : 1);
    if (json) {
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0]!).warnings).toEqual([warning]);
      expect(warn).not.toHaveBeenCalled();
    } else expect(warn).toHaveBeenCalledWith(`Warning: ${warning}`);
    expect(calls).toHaveLength(1);
  });
});

describe("default-path rig seat continue", () => {
  it.each([false, true])("names CLI inspection for an ambiguous continuation refusal (json=%s)", async json => {
    const data = { ok: false, code: "continuation_unavailable", message: "No verified pending fresh-context delivery exists for this occupant. Refresh to inspect its actual state." };
    const original = structuredClone(data);
    const calls: Array<{ path: string; body: unknown }> = [];
    const { logs, errors, exitCode } = await captureLogs(() => makeCommand(makeDeps({ status: 409, data }, calls)).parseAsync([
      "node", "rig", "seat", "continue", "dev@fixture", ...(json ? ["--json"] : []),
    ]).then(() => {}));
    expect(exitCode).toBe(1);
    expect(calls).toEqual([{ path: "/api/seat/continue/dev%40fixture", body: {} }]);
    expect(data).toEqual(original);
    if (json) {
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0]!)).toEqual(original);
      expect(errors).toEqual([]);
    } else {
      expect(errors.join("\n")).toContain("No verified pending fresh-context delivery exists");
      expect(errors.join("\n")).toContain("unknown whether context was already delivered or was never pending");
      expect(errors.join("\n")).toContain("rig seat status 'dev@fixture'");
      expect(errors.join("\n")).not.toContain("Refresh");
    }
  });
  it.each([[200, false], [200, true], [409, false], [409, true]] as const)("preserves response and warnings (HTTP %s, json=%s)", async (status, json) => {
    const data = { ok: status === 200, message: "Configured context delivered to the existing fresh conversation.", warnings: ["Submission unverified"] };
    const calls: Array<{ path: string; body: unknown }> = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { logs, exitCode } = await captureLogs(() => makeCommand(makeDeps({ status, data }, calls)).parseAsync([
      "node", "rig", "seat", "continue", "dev@fixture", ...(json ? ["--json"] : []),
    ]).then(() => {}));
    expect(calls).toEqual([{ path: "/api/seat/continue/dev%40fixture", body: {} }]);
    expect(exitCode).toBe(status === 200 ? undefined : 1);
    if (json) {
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0]!)).toEqual(data);
      expect(warn).not.toHaveBeenCalled();
    } else {
      expect(warn).toHaveBeenCalledWith("Warning: Submission unverified");
      if (status === 200) expect(logs).toEqual([data.message]);
    }
  });
});

describe("rig seat set-permissions", () => {
  it("posts the explicit operator with the existing mode and reason", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const deps = makeDeps({ status: 200, data: { ok: true, changed: true, to: { mode: "floor" }, effect: "Future managed launches only." } }, calls);
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "set-permissions", "dev-impl@seat-rig",
        "--mode", "floor", "--reason", "future launch choice", "--operator", "human@example.test"]);
    });
    expect(calls).toEqual([{ path: "/api/seat/set-permissions/dev-impl%40seat-rig",
      body: { mode: "floor", reason: "future launch choice", operator: "human@example.test" } }]);
    expect(logs.join("\n")).toContain("Permission mode: floor");
    expect(exitCode).toBeUndefined();
  });
});

describe("rig seat set-model", () => {
  it("posts model/reason/operator to /api/seat/set-model/<seat> and prints the from->to summary", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const deps = makeDeps({
      status: 200,
      data: { ok: true, seat: { logicalId: "dev.impl", rigName: "seat-rig" }, from: "fable", to: "claude-fable-5", changed: true },
    }, calls);
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "set-model", "dev-impl@seat-rig", "--model", "claude-fable-5", "--reason", "alias migration", "--operator", "op@rig"]);
    });
    expect(calls[0]!.path).toBe("/api/seat/set-model/dev-impl%40seat-rig");
    expect(calls[0]!.body).toEqual({ model: "claude-fable-5", reason: "alias migration", operator: "op@rig" });
    expect(exitCode).toBeUndefined();
    expect(logs.join("\n")).toContain("fable -> claude-fable-5");
  });

  it("requires --model and --reason (commander rejects before any request)", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const deps = makeDeps({ status: 200, data: {} }, calls);
    await expect(
      makeCommand(deps).parseAsync(["node", "rig", "seat", "set-model", "dev-impl@seat-rig", "--reason", "x"]),
    ).rejects.toThrow(/--model/);
    await expect(
      makeCommand(deps).parseAsync(["node", "rig", "seat", "set-model", "dev-impl@seat-rig", "--model", "m"]),
    ).rejects.toThrow(/--reason/);
    expect(calls).toHaveLength(0);
  });

  it("prints the daemon's refusal (message + guidance) and exits 1 on 4xx", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const deps = makeDeps({
      status: 409,
      data: { ok: false, code: "seat_ambiguous", message: 'Seat "dev.impl" matched multiple nodes', guidance: "List seats with: rig ps --nodes", matches: [{ rig_name: "a", logical_id: "dev.impl", current_occupant: null }] },
    }, calls);
    const { errors, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "set-model", "dev.impl", "--model", "m", "--reason", "x"]);
    });
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("matched multiple nodes");
    expect(errors.join("\n")).toContain("rig ps --nodes");
  });
});

describe("rig seat stop", () => {
  it("posts reason to /api/seat/stop/<seat> and prints the stopped summary", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const deps = makeDeps({
      status: 200,
      data: { ok: true, seat: { logicalId: "dev.impl", rigName: "seat-rig" }, sessionName: "dev-impl@seat-rig", sessionId: "S1" },
    }, calls);
    const { logs } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "stop", "dev-impl@seat-rig", "--reason", "wave boundary"]);
    });
    expect(calls[0]!.path).toBe("/api/seat/stop/dev-impl%40seat-rig");
    expect(calls[0]!.body).toEqual({ reason: "wave boundary", operator: undefined });
    expect(logs.join("\n")).toContain("Stopped dev-impl@seat-rig");
    expect(logs.join("\n")).toContain("siblings untouched");
  });

  it("--json passes the refusal through verbatim and exits 1", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const refusal = { ok: false, code: "session_not_live", message: "not alive", guidance: "rig seat clean" };
    const deps = makeDeps({ status: 409, data: refusal }, calls);
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "stop", "dev-impl@seat-rig", "--reason", "x", "--json"]);
    });
    expect(exitCode).toBe(1);
    expect(JSON.parse(logs.join(""))).toEqual(refusal);
  });
});

describe("rig seat clean", () => {
  it("posts reason to /api/seat/clean/<seat> and prints the actions summary", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const deps = makeDeps({
      status: 200,
      data: { ok: true, seat: { logicalId: "dev.impl", rigName: "seat-rig" }, actions: { sessionsExited: ["dev-impl@seat-rig"], bindingCleared: true } },
    }, calls);
    const { logs } = await captureLogs(async () => {
      await makeCommand(deps).parseAsync(["node", "rig", "seat", "clean", "dev-impl@seat-rig", "--reason", "clean exit observed"]);
    });
    expect(calls[0]!.path).toBe("/api/seat/clean/dev-impl%40seat-rig");
    expect(logs.join("\n")).toContain("Sessions marked exited: dev-impl@seat-rig");
    expect(logs.join("\n")).toContain("binding cleared: yes");
    expect(logs.join("\n")).toContain("launchable again");
  });
});
