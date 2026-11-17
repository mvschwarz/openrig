import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenAllResult, TerminalDeps } from "../src/commands/terminal.js";
import type { DaemonClient } from "../src/client.js";
import { openAllTerminalWindows, type WindowDeps } from "../src/terminal-window.js";
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
  it.each([
    { label: "different endpoint", sockets: ["/tmp/other.sock"], ok: false, polls: 20 },
    { label: "missing endpoint", sockets: [undefined], ok: false, polls: 20 },
    { label: "selected endpoint", sockets: ["/tmp/selected.sock"], ok: true, polls: 1 },
    { label: "different then selected endpoint", sockets: ["/tmp/other.sock", "/tmp/selected.sock"], ok: true, polls: 2 },
  ])("CR: bulk desktop readiness requires the $label", async ({ sockets, ok, polls }) => {
    let launched = false;
    let pollCount = 0;
    const sleep = vi.fn(async () => {});
    const post = vi.fn(async () => ({ status: 200, data: { provider: "herdr", session: "work", ok: true, rigs: [] } }));
    const get = vi.fn(async () => {
      const socketPath = launched ? sockets[Math.min(pollCount++, sockets.length - 1)] : "/tmp/selected.sock";
      return { status: 200, data: { session: "work", providers: [{ name: "herdr", liveness: { alive: true }, status: { available: true, launch: { socketPath, session: "work" } } }] } };
    });
    const client = { baseUrl: "http://localhost:7433", isLocalInstance: async () => true, get, post } as unknown as DaemonClient;
    const exec = vi.fn(async (file: string) => {
      if (file === "/usr/bin/osascript") { launched = true; return "window"; }
      return "/usr/local/bin/herdr";
    });
    const windowDeps: WindowDeps = {
      platform: "darwin", env: { TERM_PROGRAM: "Apple_Terminal", HOME: "/fixture" },
      exists: file => file.endsWith("/herdr"), exec, launch: async () => {}, sleep,
      id: () => "readiness", herdrConfig: () => "/fixture/herdr.cfg",
    };
    const result = await openAllTerminalWindows(client, "herdr", windowDeps, "work");
    expect(result.ok).toBe(ok);
    expect(pollCount).toBe(polls);
    expect(sleep).toHaveBeenCalledTimes(ok ? polls - 1 : 20);
    if (ok) expect(post).toHaveBeenCalledExactlyOnceWith("/api/terminal/open-all", { provider: "herdr", reuseLive: true, session: "work" }, expect.any(Object));
    else {
      expect(result.code).toBe("herdr_unavailable");
      expect(post).not.toHaveBeenCalled();
    }
  });

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

  it("sends the configured bearer on Herdr bulk status and readiness reads", async () => {
    const options = { headers: { Authorization: "Bearer cli-test-token" } };
    const get = vi.fn(async (_url: string, request?: unknown) => request === undefined
      ? { status: 401, data: {} }
      : { status: 200, data: { session: "work", providers: [{ liveness: { alive: true }, status: { launch: { socketPath: "/tmp/herdr-fixture.sock" } } }] } });
    const post = vi.fn(async () => ({ status: 200, data: { ok: true, provider: "herdr", session: "work", rigs: [] } }));
    const client = { baseUrl: "http://localhost:7433", isLocalInstance: async () => true, get, post } as unknown as DaemonClient;
    const deps: WindowDeps = { platform: "darwin", env: { TERM_PROGRAM: "Apple_Terminal" }, exists: () => false,
      exec: async file => file === "/usr/bin/osascript" ? "window" : "/fixture/herdr", launch: async () => {},
      sleep: async () => {}, id: () => "auth-herdr", herdrConfig: () => "/fixture/config" };
    const result = await openAllTerminalWindows(client, "herdr", deps, "work");
    expect(result.ok).toBe(true);
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenNthCalledWith(1, "/api/terminal/status?provider=herdr&session=work", options);
    expect(get).toHaveBeenNthCalledWith(2, "/api/terminal/status?provider=herdr&session=work", options);
    expect(post).toHaveBeenCalledOnce();
  });

  it("sends the configured bearer on tmux bulk status, views and preview reads", async () => {
    const options = { headers: { Authorization: "Bearer cli-test-token" } };
    const get = vi.fn(async (url: string, request?: unknown) => {
      if (request === undefined) return { status: 401, data: {} };
      if (url === "/api/terminal/status") return { status: 200, data: { tmux: { mode: "inherit", serverArgs: [] } } };
      if (url === "/api/terminal/views") return { status: 200, data: { rigIdentities: [{ id: "id-1", name: "one" }] } };
      return { status: 200, data: { composed: { opened: [], absent: [], degraded: [], pages: [], columns: 1 } } };
    });
    const client = { baseUrl: "http://localhost:7433", isLocalInstance: async () => true, get } as unknown as DaemonClient;
    const deps: WindowDeps = { platform: "darwin", env: { TERM_PROGRAM: "Apple_Terminal" }, exists: () => false,
      exec: async () => "/fixture/tmux", launch: async () => {}, sleep: async () => {}, id: () => "auth-tmux", herdrConfig: () => "" };
    const result = await openAllTerminalWindows(client, "tmux", deps);
    expect(result.rigs).toHaveLength(1);
    expect(get).toHaveBeenCalledWith("/api/terminal/status", options);
    expect(get).toHaveBeenCalledWith("/api/terminal/views", options);
    expect(get).toHaveBeenCalledWith("/api/terminal/preview?view=rig%3Aid-1&provider=herdr&bulk=1", options);
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

  describe("hard selected-session mismatch with active rows", () => {
    const workStatus = {
      status: 200,
      data: { session: "work", tmux: { mode: "isolated" }, providers: [{ name: "herdr", status: { available: true, launch: { socketPath: "/tmp/work.sock", session: "work" } }, liveness: { alive: true } }] },
    };
    const windowDeps: Partial<WindowDeps> = {
      platform: "darwin",
      env: { TERM_PROGRAM: "Apple_Terminal", HOME: "/tmp/home" },
      exists: p => p.endsWith("/herdr") || p === "herdr" || p === "/usr/local/bin/herdr",
      exec: async file => (file === "/usr/bin/osascript" ? "window" : "/usr/local/bin/herdr"),
    };
    const activeRigs = [
      { rig: "demo-a", view: "rig:demo-a", outcome: "opened", opened: ["worker1@demo-a"], absent: [], degraded: [], skipped: [], workspaceId: "w1" },
      { rig: "demo-b", view: "rig:demo-b", outcome: "reused", opened: ["worker1@demo-b"], absent: [], degraded: [], skipped: [], workspaceId: "w2" },
    ];

    it.each([
      { mode: "json", flags: ["--json"] },
      { mode: "human", flags: [] as string[] },
    ])("exits nonzero on a wrong echoed session even when rows say opened/reused ($mode), keeping rows, code and one open-all request", async ({ mode, flags }) => {
      const { deps, calls } = makeDeps({
        routes: {
          "GET /api/terminal/status?provider=herdr&session=work": workStatus,
          "POST /api/terminal/open-all": { status: 200, data: { ok: true, provider: "herdr", session: "default", rigs: activeRigs } },
        },
        windowDeps,
      });
      const program = createProgram({ terminalDeps: deps });
      await program.parseAsync(["node", "rig", "terminal", "open", "--all", "--window", "--session", "work", ...flags]);
      expect(process.exitCode).toBe(1);
      expect(calls.filter(c => c.method === "POST" && c.path === "/api/terminal/open-all")).toHaveLength(1);
      if (mode === "json") {
        const out = JSON.parse(logs[0]!) as OpenAllResult;
        expect(out).toMatchObject({ ok: false, code: "terminal_session_mismatch", rigs: activeRigs });
        expect(out.error).toMatch(/did not confirm selected Herdr session/);
      } else {
        const text = logs.join("\n");
        expect(text).toMatch(/did not confirm selected Herdr session/);
        expect(text).toContain("[opened] demo-a");
        expect(text).toContain("[reused] demo-b");
      }
    });

    it("the human summary names each rig, and adds its view only where two rigs share a name", async () => {
      const rigs = [
        { rig: "alpha", rigId: "01ALPHA1", view: "rig:01ALPHA1", outcome: "opened", opened: ["w@alpha"], absent: [], degraded: [], skipped: [], workspaceId: "w1" },
        { rig: "alpha", rigId: "01ALPHA2", view: "rig:01ALPHA2", outcome: "opened", opened: ["w@alpha"], absent: [], degraded: [], skipped: [], workspaceId: "w2" },
        { rig: "beta", rigId: "01BETA", view: "rig:01BETA", outcome: "reused", opened: ["w@beta"], absent: [], degraded: [], skipped: [], workspaceId: "w3" },
      ];
      const { deps } = makeDeps({
        routes: {
          "GET /api/terminal/status?provider=herdr&session=work": workStatus,
          "POST /api/terminal/open-all": { status: 200, data: { ok: true, provider: "herdr", session: "work", rigs } },
        },
        windowDeps,
      });
      const program = createProgram({ terminalDeps: deps });
      await program.parseAsync(["node", "rig", "terminal", "open", "--all", "--window", "--session", "work"]);
      const rows = logs.join("\n").split("\n").filter(line => /^ {2}\[/.test(line));
      expect(rows).toEqual(["  [opened] alpha (rig:01ALPHA1) (1 tiles)", "  [opened] alpha (rig:01ALPHA2) (1 tiles)", "  [reused] beta (1 tiles)"]);
    });

    it("keeps a confirmed partial success (some rigs opened, one absent, endpoint confirmed) at exit 0", async () => {
      const partial = {
        ok: true,
        provider: "herdr",
        session: "work",
        rigs: [
          activeRigs[0],
          { rig: "demo-c", view: "rig:demo-c", outcome: "absent", opened: [], absent: [{ seat: "worker1@demo-c", host: null, reason: "stopped" }], degraded: [], skipped: [] },
        ],
      };
      const { deps, calls } = makeDeps({
        routes: {
          "GET /api/terminal/status?provider=herdr&session=work": workStatus,
          "POST /api/terminal/open-all": { status: 200, data: partial },
        },
        windowDeps,
      });
      const program = createProgram({ terminalDeps: deps });
      await program.parseAsync(["node", "rig", "terminal", "open", "--all", "--window", "--session", "work", "--json"]);
      expect(process.exitCode ?? 0).toBe(0);
      expect(calls.filter(c => c.method === "POST" && c.path === "/api/terminal/open-all")).toHaveLength(1);
      expect(JSON.parse(logs[0]!)).toMatchObject({ ok: true, session: "work", rigs: partial.rigs });
    });
  });

  it("names absent, degraded and stopped seats with their reasons in human bulk output and leaves JSON untouched", async () => {
    const data = {
      ok: true,
      provider: "herdr",
      rigs: [{
        rig: "demo-a", view: "rig:demo-a", outcome: "opened", opened: ["worker1@demo-a"],
        absent: [{ seat: "worker2@demo-a", host: null, reason: "stopped" }, { seat: "worker3@demo-a", host: "remote-host-1", reason: "no session" }],
        degraded: [{ seat: "worker4@demo-a", host: "remote-host-2", reason: "attach failed" }, { seat: "worker5@demo-a", host: "remote-host-3", reason: "no pane id", code: "pane_unconfirmed" }],
        skipped: [{ seat: "worker6@demo-a", reason: "unchanged" }],
      }],
    };
    const route = { "POST /api/terminal/open-all": { status: 200, data } };
    const human = makeDeps({ routes: route });
    await createProgram({ terminalDeps: human.deps }).parseAsync(["node", "rig", "terminal", "open", "--all", "--provider", "herdr"]);
    const text = logs.join("\n");
    expect(process.exitCode ?? 0).toBe(0);
    expect(text).toContain("worker2@demo-a");
    expect(text).toContain("stopped");
    expect(text).toContain("worker3@demo-a");
    expect(text).toContain("no session");
    expect(text).toContain("worker4@demo-a");
    expect(text).toContain("attach failed");
    expect(text).toContain("worker5@demo-a");
    expect(text).toContain("no pane id");
    expect(text).toContain("skipped worker6@demo-a: unchanged");

    logs.length = 0;
    const json = makeDeps({ routes: route });
    await createProgram({ terminalDeps: json.deps }).parseAsync(["node", "rig", "terminal", "open", "--all", "--provider", "herdr", "--json"]);
    expect(logs).toEqual([JSON.stringify(data)]);
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

describe("#3081 bf06 child B01/B02/B03 — CLI bulk close, currentHerdr guards & structured errors", () => {
  let logs: string[];
  beforeEach(() => {
    logs = [];
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    process.exitCode = undefined;
  });

  function makeBugfixClient(opts?: {
    routes?: Record<string, { status: number; data: unknown } | Error>;
    isLocal?: boolean;
  }) {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const routes = opts?.routes ?? {};
    const respond = (key: string) => {
      const entry = routes[key];
      if (entry instanceof Error) return Promise.reject(entry);
      return Promise.resolve(entry ?? { status: 200, data: {} });
    };
    const client = {
      baseUrl: "http://127.0.0.1:7433",
      isLocalInstance: vi.fn(async () => opts?.isLocal ?? true),
      get: vi.fn(async (p: string) => {
        calls.push({ method: "GET", path: p });
        return respond(`GET ${p}`);
      }),
      post: vi.fn(async (p: string, body: unknown) => {
        calls.push({ method: "POST", path: p, body });
        return respond(`POST ${p}`);
      }),
      delete: vi.fn(async (p: string) => {
        calls.push({ method: "DELETE", path: p });
        return respond(`DELETE ${p}`);
      }),
    };
    return { client: client as unknown as DaemonClient, rawClient: client, calls };
  }

  function makeBugfixDeps(opts?: {
    env?: NodeJS.ProcessEnv;
    hasHerdr?: boolean;
    launch?: WindowDeps["launch"];
    execImpl?: (file: string, args: string[]) => Promise<string>;
  }): { windowDeps: WindowDeps; execCalls: Array<{ file: string; args: string[] }>; launchCalls: string[] } {
    const execCalls: Array<{ file: string; args: string[] }> = [];
    const launchCalls: string[] = [];
    const windowDeps: WindowDeps = {
      platform: "linux",
      env: { DISPLAY: ":0", TERM_PROGRAM: "ghostty", HOME: "/tmp/h", ...opts?.env },
      exists: (f) => Boolean(opts?.hasHerdr && f.endsWith("/herdr")),
      exec: vi.fn(async (file: string, args: string[]) => {
        execCalls.push({ file, args });
        if (opts?.execImpl) return opts.execImpl(file, args);
        if (file === "herdr" || file.endsWith("/herdr")) {
          if (opts?.hasHerdr) return "herdr 0.9.5\n";
          throw new Error("ENOENT: herdr not found");
        }
        if (file === "/bin/sh" && args[1]?.includes("command -v herdr")) {
          if (opts?.hasHerdr) return "/usr/local/bin/herdr\n";
          throw new Error("not found");
        }
        if (file === "/bin/sh" && args[1]?.includes("command -v tmux")) return "/usr/bin/tmux\n";
        return "";
      }),
      launch: vi.fn(async (app: string, args: string[]) => {
        launchCalls.push(`${app} ${args.join(" ")}`);
        if (opts?.launch) return opts.launch(app, args);
      }),
      sleep: async () => {},
      id: () => "vtest1",
      herdrConfig: () => "/tmp/herdr.cfg",
    };
    return { windowDeps, execCalls, launchCalls };
  }

  it("BT01: rig terminal close --all forwards normalized provider/session and exits 1 cleanly on HTTP 400 or empty --provider", async () => {
    const { deps, calls } = makeDeps({
      routes: {
        "POST /api/terminal/close-all": { status: 200, data: { ok: true, viewers: [] } },
      },
    });
    const prog1 = createProgram({ terminalDeps: deps });
    prog1.exitOverride();
    await prog1.parseAsync(["node", "rig", "terminal", "close", "--all", "--provider", " herdr ", "--session", " work ", "--json"]);
    expect(process.exitCode).toBeUndefined();
    expect(calls.find(c => c.path === "/api/terminal/close-all")?.body).toEqual({ provider: "herdr", session: "work" });

    const { deps: badDeps, calls: badCalls } = makeDeps({
      routes: {
        "POST /api/terminal/close-all": { status: 400, data: { ok: false, viewers: [], code: "invalid_terminal_session", error: "bad session" } },
      },
    });
    const prog2 = createProgram({ terminalDeps: badDeps });
    prog2.exitOverride();
    await prog2.parseAsync(["node", "rig", "terminal", "close", "--all", "--session", "   ", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(badCalls.find(c => c.path === "/api/terminal/close-all")?.body).toEqual({ session: "" });
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ ok: false, code: "invalid_terminal_session" });

    process.exitCode = undefined;
    const { deps: emptyProvDeps, calls: emptyProvCalls } = makeDeps({});
    const prog3 = createProgram({ terminalDeps: emptyProvDeps });
    prog3.exitOverride();
    await prog3.parseAsync(["node", "rig", "terminal", "close", "--all", "--provider", "   ", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(emptyProvCalls).toHaveLength(0);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ ok: false });
  });

  it("BT02: inside Herdr (TERM_PROGRAM=herdr or HERDR_ENV=1), openAllTerminalWindows refuses tmux and unavailable herdr BEFORE views/tmux/launch even with empty rigs", async () => {
    for (const herdrEnv of [
      { TERM_PROGRAM: "herdr" },
      { HERDR_ENV: "1", HERDR_PANE_ID: "%1", HERDR_SOCKET_PATH: "/tmp/h/.config/herdr/herdr.sock", HOME: "/tmp/h" },
    ]) {
      const { client, calls } = makeBugfixClient({
        routes: {
          "GET /api/terminal/status": { status: 200, data: { tmux: { mode: "inherit", serverArgs: [] } } },
          "GET /api/terminal/views": { status: 200, data: { rigs: ["alpha"], rigIdentities: [{ id: "alpha", name: "alpha" }] } },
        },
      });
      const { windowDeps, execCalls, launchCalls } = makeBugfixDeps({ env: herdrEnv, hasHerdr: true });
      const resTmux = await openAllTerminalWindows(client, "tmux", windowDeps);
      expect(resTmux).toMatchObject({ ok: false, provider: "tmux", rigs: [], windowAttempted: false, code: "terminal_window_failed" });
      expect(calls).toHaveLength(0);
      expect(launchCalls).toHaveLength(0);
      expect(execCalls.some(e => e.file.includes("tmux") || e.args.some(a => a.includes("tmux")))).toBe(false);

      const noHerdr = makeBugfixDeps({ env: herdrEnv, hasHerdr: false });
      const resNoHerdr = await openAllTerminalWindows(client, undefined, noHerdr.windowDeps);
      expect(resNoHerdr).toMatchObject({ ok: false, provider: "herdr", rigs: [], windowAttempted: false, code: "terminal_window_failed" });
      expect(calls).toHaveLength(0);
      expect(noHerdr.launchCalls).toHaveLength(0);

      // Even with zero rigs, must refuse cleanly inside Herdr rather than crashing into tmux launcher:
      const { client: emptyClient, calls: emptyCalls } = makeBugfixClient({
        routes: {
          "GET /api/terminal/status": { status: 200, data: { tmux: { mode: "inherit", serverArgs: [] } } },
          "GET /api/terminal/views": { status: 200, data: { rigs: [], rigIdentities: [] } },
        },
      });
      const resEmptyTmux = await openAllTerminalWindows(emptyClient, "tmux", windowDeps);
      expect(resEmptyTmux).toMatchObject({ ok: false, provider: "tmux", rigs: [], windowAttempted: false, code: "terminal_window_failed" });
      expect(emptyCalls).toHaveLength(0);
    }

    // CLI --json surface inside Herdr with --provider tmux --window:
    const { deps } = makeDeps({
      routes: { "GET /api/terminal/views": { status: 200, data: { rigs: ["alpha"], rigIdentities: [{ id: "alpha", name: "alpha" }] } } },
      windowDeps: { env: { DISPLAY: ":0", HOME: "/tmp/h", HERDR_ENV: "1", HERDR_PANE_ID: "%1", HERDR_SOCKET_PATH: "/tmp/h/.config/herdr/herdr.sock" } },
    });
    const prog = createProgram({ terminalDeps: deps });
    prog.exitOverride();
    await prog.parseAsync(["node", "rig", "terminal", "open", "--all", "--provider", "tmux", "--window", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ ok: false, provider: "tmux", rigs: [], windowAttempted: false, code: "terminal_window_failed" });

    // Positive sanity: valid herdr inside Herdr still opens via POST /api/terminal/open-all:
    process.exitCode = undefined;
    const { client: okClient, calls: okCalls } = makeBugfixClient({
      routes: {
        "GET /api/terminal/status?provider=herdr": {
          status: 200,
          data: { tmux: { mode: "inherit" }, providers: [{ liveness: { alive: true }, status: { launch: { socketPath: "/tmp/h/.config/herdr/herdr.sock" } } }] },
        },
        "POST /api/terminal/open-all": {
          status: 200,
          data: { ok: true, provider: "herdr", rigs: [{ rig: "alpha", view: "rig:alpha", outcome: "opened", opened: ["op@alpha"], absent: [], degraded: [], skipped: [] }] },
        },
      },
    });
    const okHerdr = makeBugfixDeps({
      env: { HOME: "/tmp/h", HERDR_ENV: "1", HERDR_PANE_ID: "%1", HERDR_SOCKET_PATH: "/tmp/h/.config/herdr/herdr.sock" },
      hasHerdr: true,
    });
    const okRes = await openAllTerminalWindows(okClient, undefined, okHerdr.windowDeps);
    expect(okRes.ok).toBe(true);
    expect(okCalls.some(c => c.method === "POST" && c.path === "/api/terminal/open-all")).toBe(true);
  });

  it("BT03: Herdr locality failure, status throw, post-launch throw, and currentHerdr post throw return honest structured JSON (no uncaught crashes)", async () => {
    const herdrEnv = { DISPLAY: ":0", TERM_PROGRAM: "ghostty", HOME: "/tmp/h" };

    // 1. assertLocalTmux failure on isolated remote daemon (pre-window):
    const remoteHerdr = makeBugfixClient({
      isLocal: false,
      routes: {
        "GET /api/terminal/status?provider=herdr": {
          status: 200,
          data: { tmux: { mode: "isolated" }, providers: [{ liveness: { alive: true }, status: { launch: { socketPath: "/tmp/h/herdr.sock" } } }] },
        },
      },
    });
    const wd1 = makeBugfixDeps({ env: herdrEnv, hasHerdr: true });
    const res1 = await openAllTerminalWindows(remoteHerdr.client, "herdr", wd1.windowDeps);
    expect(res1).toMatchObject({ ok: false, provider: "herdr", rigs: [], windowAttempted: false, code: "terminal_window_failed" });
    expect(wd1.launchCalls).toHaveLength(0);

    // 2. client.get("/api/terminal/status?provider=herdr") throws:
    const getThrow = makeBugfixClient({
      routes: { "GET /api/terminal/status?provider=herdr": new Error("socket reset") },
    });
    const res2 = await openAllTerminalWindows(getThrow.client, "herdr", wd1.windowDeps);
    expect(res2).toMatchObject({ ok: false, provider: "herdr", rigs: [], windowAttempted: false, code: "terminal_window_failed" });
    expect(res2.error).toContain("socket reset");

    // 3. client.post("/api/terminal/open-all") throws AFTER desktop launchWindow succeeded -> must disclose windowAttempted: true:
    const postThrow = makeBugfixClient({
      routes: {
        "GET /api/terminal/status?provider=herdr": {
          status: 200,
          data: { tmux: { mode: "inherit" }, providers: [{ liveness: { alive: true }, status: { launch: { socketPath: "/tmp/h/herdr.sock" } } }] },
        },
        "POST /api/terminal/open-all": new Error("daemon timed out"),
      },
    });
    const wdLaunch = makeBugfixDeps({ env: herdrEnv, hasHerdr: true });
    const res3 = await openAllTerminalWindows(postThrow.client, "herdr", wdLaunch.windowDeps);
    expect(res3).toMatchObject({ ok: false, provider: "herdr", rigs: [], windowAttempted: true, code: "terminal_window_failed", window: { app: "ghostty", surface: "window-requested" } });
    expect(res3.error).toContain("daemon timed out");
    expect(res3.error).not.toMatch(/No terminal window was opened|nothing was opened/i);

    // 4. currentHerdr POST throw discloses request already sent, no false "No terminal window was opened":
    const currentHerdrDeps = makeBugfixDeps({
      env: { HOME: "/tmp/h", HERDR_ENV: "1", HERDR_PANE_ID: "%1", HERDR_SOCKET_PATH: "/tmp/h/.config/herdr/herdr.sock" },
      hasHerdr: true,
    });
    const postThrowCurrent = makeBugfixClient({
      routes: {
        "GET /api/terminal/status?provider=herdr": {
          status: 200,
          data: { tmux: { mode: "inherit" }, providers: [{ liveness: { alive: true }, status: { launch: { socketPath: "/tmp/h/.config/herdr/herdr.sock" } } }] },
        },
        "POST /api/terminal/open-all": new Error("open-all boom"),
      },
    });
    const res4 = await openAllTerminalWindows(postThrowCurrent.client, "herdr", currentHerdrDeps.windowDeps);
    expect(res4).toMatchObject({ ok: false, provider: "herdr", rigs: [], windowAttempted: false, code: "terminal_window_failed" });
    expect(res4.error).not.toMatch(/No terminal window was opened|nothing was opened/i);

    // 5. CLI --json surface on remote Herdr locality failure:
    const cliDeps: TerminalDeps = {
      lifecycleDeps: {} as TerminalDeps["lifecycleDeps"],
      windowDeps: wd1.windowDeps,
      clientFactory: () => remoteHerdr.client,
    };
    const prog = createProgram({ terminalDeps: cliDeps });
    prog.exitOverride();
    await prog.parseAsync(["node", "rig", "terminal", "open", "--all", "--provider", "herdr", "--window", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ ok: false, provider: "herdr", windowAttempted: false, code: "terminal_window_failed" });
  });

  it("BT03: tmux locality failure, malformed serverArgs, views throw, and per-rig preview throw after earlier success return honest structured OpenAllResult", async () => {
    const extEnv = { DISPLAY: ":0", TERM_PROGRAM: "ghostty", HOME: "/tmp/h" };

    // 1. assertLocalTmux failure:
    const badLocal = makeBugfixClient({
      isLocal: false,
      routes: { "GET /api/terminal/status": { status: 200, data: { tmux: { mode: "isolated", serverArgs: ["-L", "s"] } } } },
    });
    const resLocal = await openAllTerminalWindows(badLocal.client, "tmux", makeBugfixDeps({ env: extEnv }).windowDeps);
    expect(resLocal).toMatchObject({ ok: false, provider: "tmux", rigs: [], windowAttempted: false, code: "terminal_window_failed" });

    // 2. Malformed serverArgs through CLI --json:
    const badServer = makeBugfixClient({
      routes: { "GET /api/terminal/status": { status: 200, data: { tmux: { mode: "inherit", serverArgs: [123] } } } },
    });
    const cliBadServer = createProgram({
      terminalDeps: {
        lifecycleDeps: {} as TerminalDeps["lifecycleDeps"],
        windowDeps: makeBugfixDeps({ env: extEnv }).windowDeps,
        clientFactory: () => badServer.client,
      },
    });
    cliBadServer.exitOverride();
    await cliBadServer.parseAsync(["node", "rig", "terminal", "open", "--all", "--provider", "tmux", "--window", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ ok: false, provider: "tmux", rigs: [], windowAttempted: false, code: "terminal_window_failed" });

    // 3. client.get("/api/terminal/views") throws:
    const viewsThrow = makeBugfixClient({
      routes: {
        "GET /api/terminal/status": { status: 200, data: { tmux: { mode: "inherit", serverArgs: [] } } },
        "GET /api/terminal/views": new Error("views ECONNREFUSED"),
      },
    });
    const resViews = await openAllTerminalWindows(viewsThrow.client, "tmux", makeBugfixDeps({ env: extEnv }).windowDeps);
    expect(resViews).toMatchObject({ ok: false, provider: "tmux", rigs: [], windowAttempted: false, code: "terminal_window_failed" });
    expect(resViews.error).toContain("views ECONNREFUSED");

    // 4. Rig alpha succeeds, then rig beta throws on preview GET -> preserves alpha outcome + discloses windowAttempted: true:
    process.exitCode = undefined;
    const partialThrowClient = makeBugfixClient({
      routes: {
        "GET /api/terminal/status": { status: 200, data: { tmux: { mode: "inherit", serverArgs: [] } } },
        "GET /api/terminal/views": { status: 200, data: { rigs: ["alpha", "beta"], rigIdentities: [{ id: "alpha", name: "alpha" }, { id: "beta", name: "beta" }] } },
        "GET /api/terminal/preview?view=rig%3Aalpha&provider=herdr&bulk=1": {
          status: 200,
          data: {
            planId: "p-alpha",
            status: {},
            composed: {
              id: "rig:alpha",
              opened: [{ seat: "op@alpha", label: "op", paneCommand: "tmux attach -t 'op@alpha'" }],
              pages: [[{ seat: "op@alpha", label: "op", paneCommand: "tmux attach -t 'op@alpha'" }]],
              absent: [],
              degraded: [],
            },
            skipped: [],
          },
        },
        "GET /api/terminal/preview?view=rig%3Abeta&provider=herdr&bulk=1": new Error("preview beta boom"),
      },
    });
    const tmuxDeps = makeBugfixDeps({
      env: extEnv,
      execImpl: async (file, args) => {
        if (file === "/bin/sh" && args[1]?.includes("command -v tmux")) return "/usr/bin/tmux\n";
        if (args.includes("new-session")) return "$1|@1|%1\n";
        if (args.includes("show-options")) return "120x40\n";
        if (args.includes("list-sessions")) return "$1|openrig-view-vtest1\n";
        if (args.includes("list-windows")) return "@1\n";
        if (args.includes("list-panes")) return "%1\n";
        return "";
      },
    });
    const resPartial = await openAllTerminalWindows(partialThrowClient.client, "tmux", tmuxDeps.windowDeps);
    expect(resPartial.rigs).toHaveLength(2);
    expect(resPartial.rigs[0]).toMatchObject({ rig: "alpha", outcome: "opened", opened: ["op@alpha"] });
    expect(resPartial.rigs[1]).toMatchObject({ rig: "beta", outcome: "failed", code: "terminal_window_failed" });
    expect(resPartial.rigs[1]?.error).toContain("preview beta boom");
    expect(resPartial.windowAttempted).toBe(true);
    expect(resPartial.error ?? "").not.toMatch(/No terminal window was opened|nothing was opened/i);
  });
});
