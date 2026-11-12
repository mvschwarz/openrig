import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalDeps } from "../src/commands/terminal.js";
import type { WindowDeps } from "../src/terminal-window.js";
import { createProgram } from "../src/index.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

interface StubResponse { status: number; data: unknown }

function makeDeps(opts?: {
  routes?: Record<string, StubResponse>;
  windowDeps?: Partial<WindowDeps>;
  env?: NodeJS.ProcessEnv;
}) {
  const calls: Array<{ method: string; path: string; body?: unknown; opts?: unknown }> = [];
  const routes = opts?.routes ?? {};
  const exec = vi.fn(async () => "");
  const launch = vi.fn(async () => {});
  const windowDeps: WindowDeps = {
    platform: "linux",
    env: { DISPLAY: ":0", TERM_PROGRAM: "ghostty", HOME: "/tmp/home" },
    exists: () => false,
    exec,
    launch,
    sleep: async () => {},
    id: () => "viewid1",
    herdrConfig: () => "/tmp/herdr.cfg",
    ...opts?.windowDeps,
  };
  const deps: TerminalDeps = {
    lifecycleDeps: {} as TerminalDeps["lifecycleDeps"],
    env: opts?.env ?? {},
    windowDeps,
    clientFactory: () => ({
      isLocalInstance: vi.fn(async () => true),
      get: vi.fn(async (path: string) => {
        calls.push({ method: "GET", path });
        return routes[`GET ${path}`] ?? { status: 200, data: {} };
      }),
      post: vi.fn(async (path: string, body: unknown, reqOpts?: unknown) => {
        calls.push({ method: "POST", path, body, opts: reqOpts });
        return routes[`POST ${path}`] ?? { status: 200, data: {} };
      }),
      delete: vi.fn(async (path: string, body?: unknown, reqOpts?: unknown) => {
        calls.push({ method: "DELETE", path, body, opts: reqOpts });
        return routes[`DELETE ${path}`] ?? { status: 200, data: { ok: true } };
      }),
    }) as unknown as ReturnType<TerminalDeps["clientFactory"]>,
  };
  return { deps, calls, exec, launch };
}

describe("#3081 rig terminal open/close --all CLI", () => {
  let logs: string[];
  let errors: string[];
  const prevToken = process.env["OPENRIG_TERMINAL_BEARER_TOKEN"];

  beforeEach(() => {
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => errors.push(a.join(" ")));
    process.exitCode = undefined;
    process.env["OPENRIG_TERMINAL_BEARER_TOKEN"] = "cli-test-token";
  });

  afterEach(() => {
    if (prevToken === undefined) delete process.env["OPENRIG_TERMINAL_BEARER_TOKEN"];
    else process.env["OPENRIG_TERMINAL_BEARER_TOKEN"] = prevToken;
    vi.restoreAllMocks();
  });

  it("rejects conflicting flags with --all before calling daemon or tmux", async () => {
    const conflicts: string[][] = [
      ["open", "myrig", "--all"],
      ["open", "--all", "--follow"],
      ["open", "--all", "--no-follow"],
      ["open", "--all", "--expected-plan", "abc"],
      ["open", "--all", "--max-tiles", "4"],
      ["open", "--all", "--pin", "a@b"],
      ["open", "--all", "--app-home", "/tmp/app"],
      ["close", "rv-1", "--all"],
      ["close"],
    ];
    for (const argv of conflicts) {
      process.exitCode = 0;
      const { deps, calls, exec } = makeDeps();
      const program = createProgram({ terminalDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "terminal", ...argv, "--json"]);
      expect(process.exitCode).toBe(1);
      expect(calls).toEqual([]);
      expect(exec).not.toHaveBeenCalled();
    }
  });

  it("requires --window for --all --provider tmux with zero tmux or daemon calls", async () => {
    const { deps, calls, exec } = makeDeps();
    const program = createProgram({ terminalDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "terminal", "open", "--all", "--provider", "tmux", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(logs[0]!).error).toMatch(/tmux requires --window/i);
    expect(calls).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });

  it.each(["herdr-app", "cmux", "rex"])("rejects --all --provider %s with unsupported_provider and zero provider calls", async (provider) => {
    const { deps, calls, exec } = makeDeps();
    const program = createProgram({ terminalDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "terminal", "open", "--all", "--provider", provider, "--json"]);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(logs[0]!).code).toBe("unsupported_provider");
    expect(calls).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });

  it("posts POST /api/terminal/open-all with bearer auth for --provider herdr and exits 0 only when opened or reused", async () => {
    const okData = {
      ok: true,
      provider: "herdr",
      rigs: [{ rig: "alpha", view: "rig:alpha", outcome: "opened", opened: ["op@alpha"], absent: [], degraded: [], skipped: [], workspaceId: "w1" }],
    };
    const { deps, calls } = makeDeps({ routes: { "POST /api/terminal/open-all": { status: 200, data: okData } } });
    const program = createProgram({ terminalDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "terminal", "open", "--all", "--provider", "herdr", "--json"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/api/terminal/open-all",
      body: { provider: "herdr", reuseLive: true },
      opts: { headers: { Authorization: "Bearer cli-test-token" } },
    });

    process.exitCode = undefined;
    logs.length = 0;
    const allAbsent = {
      ok: false,
      provider: "herdr",
      rigs: [{ rig: "alpha", view: "rig:alpha", outcome: "absent", opened: [], absent: [{ seat: "op@alpha", host: null, reason: "stopped" }], degraded: [], skipped: [] }],
    };
    const { deps: deps2 } = makeDeps({ routes: { "POST /api/terminal/open-all": { status: 200, data: allAbsent } } });
    const program2 = createProgram({ terminalDeps: deps2 });
    program2.exitOverride();
    await program2.parseAsync(["node", "rig", "terminal", "open", "--all", "--provider", "herdr", "--json"]);
    expect(process.exitCode).toBe(1);
  });

  it("posts POST /api/terminal/close-all with bearer auth and exits 0 on clean/empty and 1 when a viewer failed", async () => {
    const emptyData = { ok: true, viewers: [], notes: ["no OpenRig rig viewers recorded"] };
    const { deps, calls } = makeDeps({ routes: { "POST /api/terminal/close-all": { status: 200, data: emptyData } } });
    const program = createProgram({ terminalDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "terminal", "close", "--all", "--json"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/api/terminal/close-all",
      opts: { headers: { Authorization: "Bearer cli-test-token" } },
    });

    process.exitCode = undefined;
    logs.length = 0;
    const failData = {
      ok: false,
      viewers: [{ view: "rig:alpha", provider: "herdr", target: "w1", outcome: "failed", code: "close_pending", reason: "still present" }],
    };
    const { deps: deps2 } = makeDeps({ routes: { "POST /api/terminal/close-all": { status: 200, data: failData } } });
    const program2 = createProgram({ terminalDeps: deps2 });
    program2.exitOverride();
    await program2.parseAsync(["node", "rig", "terminal", "close", "--all", "--json"]);
    expect(process.exitCode).toBe(1);
  });
});
