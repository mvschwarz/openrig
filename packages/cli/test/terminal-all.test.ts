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
      baseUrl: "http://localhost:7433",
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

  it("J06/J07: fails when --window --session <session> lacks Herdr, fails when open-all returns HTTP 400/500 or wrong session, and forwards --session to Herdr status & open-all", async () => {
    // 1. --window --session <session> when Herdr is unavailable MUST fail without falling back to plain tmux:
    process.exitCode = 0;
    const noHerdr = makeDeps({
      routes: {
        "GET /api/terminal/status?provider=herdr&session=work": { status: 200, data: { tmux: { mode: "isolated", serverArgs: ["-L", "s1"] }, providers: [] } },
      },
      windowDeps: { exists: () => false },
    });
    const p1 = createProgram({ terminalDeps: noHerdr.deps });
    await p1.parseAsync(["node", "rig", "terminal", "open", "--all", "--window", "--session", "work", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(noHerdr.calls.some(c => c.path === "/api/terminal/views")).toBe(false);
    expect(noHerdr.launch).not.toHaveBeenCalled();
    expect(noHerdr.exec.mock.calls.some(c => /tmux/.test(`${String(c[0])} ${JSON.stringify(c[1])}`))).toBe(false);

    // 2. --window --session <session> with Herdr available passes ?provider=herdr&session=work and forwards { session: "work" }, and fails if open-all returns HTTP 500 or mismatched session:
    process.exitCode = 0;
    const badStatus = makeDeps({
      routes: {
        "GET /api/terminal/status?provider=herdr&session=work": {
          status: 200,
          data: { session: "work", tmux: { mode: "isolated" }, providers: [{ name: "herdr", status: { available: true, launch: { socketPath: "/tmp/work.sock", session: "work" } }, liveness: { alive: true } }] },
        },
        "POST /api/terminal/open-all": { status: 500, data: { ok: false, error: "open-all crashed" } },
      },
      windowDeps: {
        platform: "darwin",
        env: { TERM_PROGRAM: "Apple_Terminal", HOME: "/tmp/home" },
        exists: p => p.endsWith("/herdr") || p === "herdr" || p === "/usr/local/bin/herdr",
        exec: async file => (file === "/usr/bin/osascript" ? "window" : "/usr/local/bin/herdr"),
      },
    });
    const p2 = createProgram({ terminalDeps: badStatus.deps });
    await p2.parseAsync(["node", "rig", "terminal", "open", "--all", "--window", "--session", "work", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(badStatus.calls.some(c => c.method === "GET" && c.path === "/api/terminal/status?provider=herdr&session=work")).toBe(true);
    const openAllCall = badStatus.calls.find(c => c.method === "POST" && c.path === "/api/terminal/open-all");
    expect(openAllCall?.body).toMatchObject({ provider: "herdr", reuseLive: true, session: "work" });

    // 3. Wrong echoed session in POST /api/terminal/open-all must fail:
    process.exitCode = 0;
    const wrongSession = makeDeps({
      routes: {
        "GET /api/terminal/status?provider=herdr&session=work": {
          status: 200,
          data: { session: "work", tmux: { mode: "isolated" }, providers: [{ name: "herdr", status: { available: true, launch: { socketPath: "/tmp/work.sock", session: "work" } }, liveness: { alive: true } }] },
        },
        "POST /api/terminal/open-all": { status: 200, data: { ok: true, provider: "herdr", session: "default", rigs: [] } },
      },
      windowDeps: {
        platform: "darwin",
        env: { TERM_PROGRAM: "Apple_Terminal", HOME: "/tmp/home" },
        exists: p => p.endsWith("/herdr") || p === "herdr" || p === "/usr/local/bin/herdr",
        exec: async file => (file === "/usr/bin/osascript" ? "window" : "/usr/local/bin/herdr"),
      },
    });
    const p3 = createProgram({ terminalDeps: wrongSession.deps });
    await p3.parseAsync(["node", "rig", "terminal", "open", "--all", "--window", "--session", "work", "--json"]);
    expect(process.exitCode).toBe(1);
  });

  it("refuses open --all --window in currentHerdr mode on endpoint mismatch with zero POST /api/terminal/open-all or desktop side effects", async () => {
    const selectedSocket = "/tmp/home/.config/herdr/sessions/work/herdr.sock";
    const statusRoute = {
      status: 200,
      data: {
        session: "work",
        tmux: { mode: "isolated" },
        providers: [{ name: "herdr", status: { available: true, launch: { socketPath: selectedSocket, session: "work" } }, liveness: { alive: true } }],
      },
    };

    // 1. Inside tmux inside a Herdr pane (HERDR_ENV=1 + HERDR_PANE_ID + HERDR_SOCKET_PATH -> currentHerdr: true):
    process.exitCode = 0;
    const inPaneExec = vi.fn(async (file: string) => (file === "/bin/sh" ? "/usr/local/bin/herdr" : ""));
    const inPane = makeDeps({
      routes: {
        "GET /api/terminal/status?provider=herdr&session=work": statusRoute,
      },
      windowDeps: {
        platform: "linux",
        env: {
          TERM_PROGRAM: "tmux",
          HERDR_ENV: "1",
          HERDR_PANE_ID: "%1",
          HERDR_SOCKET_PATH: "/tmp/home/.config/herdr/sessions/alpha/herdr.sock",
          HOME: "/tmp/home",
        },
        exec: inPaneExec,
      },
    });
    const p1 = createProgram({ terminalDeps: inPane.deps });
    await p1.parseAsync(["node", "rig", "terminal", "open", "--all", "--window", "--session", "work", "--json"]);
    expect(process.exitCode).toBe(1);
    const out1 = JSON.parse(logs[0]!) as { ok: boolean; code?: string; windowAttempted?: boolean; rigs?: unknown[]; error?: string };
    expect(out1).toMatchObject({ ok: false, code: "terminal_window_failed", windowAttempted: false, rigs: [] });
    expect(out1.error).toMatch(/current Herdr endpoint differs from the selected endpoint/i);
    expect(out1.error).toContain("\"alpha\"");
    expect(inPane.calls.some(c => c.method === "POST" && c.path === "/api/terminal/open-all")).toBe(false);
    expect(inPane.launch).not.toHaveBeenCalled();
    expect(inPaneExec.mock.calls.every(c => c[0] === "herdr" || c[0] === "/bin/sh")).toBe(true);

    // 2. Direct Herdr host (TERM_PROGRAM=herdr + caller HERDR_SOCKET_PATH on default socket -> currentHerdr: true):
    process.exitCode = 0;
    logs.length = 0;
    const directExec = vi.fn(async (file: string) => (file === "/bin/sh" ? "/usr/local/bin/herdr" : ""));
    const directHerdr = makeDeps({
      routes: {
        "GET /api/terminal/status?provider=herdr&session=work": statusRoute,
      },
      windowDeps: {
        platform: "darwin",
        env: {
          TERM_PROGRAM: "herdr",
          HERDR_SOCKET_PATH: "/tmp/home/.config/herdr/herdr.sock",
          HOME: "/tmp/home",
        },
        exec: directExec,
      },
    });
    const p2 = createProgram({ terminalDeps: directHerdr.deps });
    await p2.parseAsync(["node", "rig", "terminal", "open", "--all", "--window", "--session", "work", "--json"]);
    expect(process.exitCode).toBe(1);
    const out2 = JSON.parse(logs[0]!) as { ok: boolean; code?: string; windowAttempted?: boolean; rigs?: unknown[]; error?: string };
    expect(out2).toMatchObject({ ok: false, code: "terminal_window_failed", windowAttempted: false, rigs: [] });
    expect(out2.error).toMatch(/current Herdr endpoint differs from the selected endpoint/i);
    expect(out2.error).toContain("\"default\"");
    expect(directHerdr.calls.some(c => c.method === "POST" && c.path === "/api/terminal/open-all")).toBe(false);
    expect(directHerdr.launch).not.toHaveBeenCalled();
    expect(directExec.mock.calls.every(c => c[0] === "herdr" || c[0] === "/bin/sh")).toBe(true);
  });

  it("J13: does not crash when open-all or close-all receives malformed payloads", async () => {
    process.exitCode = 0;
    const badClose = makeDeps({
      routes: {
        "POST /api/terminal/close-all": { status: 200, data: { ok: true } },
      },
    });
    const program = createProgram({ terminalDeps: badClose.deps });
    await program.parseAsync(["node", "rig", "terminal", "close", "--all"]);
    expect(process.exitCode).toBe(1);

    process.exitCode = 0;
    const badOpen = makeDeps({
      routes: {
        "GET /api/terminal/status?provider=herdr": { status: 200, data: { tmux: { mode: "isolated" }, providers: [{ name: "herdr", status: { available: true, launch: { socketPath: "/tmp/h.sock" } }, liveness: { alive: true } }] } },
        "POST /api/terminal/open-all": { status: 200, data: { ok: true } },
      },
      windowDeps: {
        platform: "darwin",
        env: { TERM_PROGRAM: "Apple_Terminal", HOME: "/tmp/home" },
        exists: p => p.endsWith("/herdr") || p === "herdr" || p === "/usr/local/bin/herdr",
        exec: async file => (file === "/usr/bin/osascript" ? "window" : "/usr/local/bin/herdr"),
      },
    });
    const program2 = createProgram({ terminalDeps: badOpen.deps });
    await program2.parseAsync(["node", "rig", "terminal", "open", "--all"]);
    expect(process.exitCode).toBe(1);
  });
});
