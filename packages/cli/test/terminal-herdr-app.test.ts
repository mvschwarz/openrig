import { describe, it, expect, vi, afterEach } from "vitest";
import { herdrAppClient, terminalCommand, type TerminalDeps } from "../src/commands/terminal.js";
import type { DaemonClient } from "../src/client.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

const inApp = { HC_TERMINAL_ID: "t4", HC_TERMINAL_SOCKET: "/run/core.sock", HERDR_APP_HOME: "/apps/h" };
const deps = (env: NodeJS.ProcessEnv, socket = true) => ({
  env, socketExists: (p: string) => socket && p === "/apps/h/herdr-app.sock",
}) as Parameters<typeof herdrAppClient>[1];

afterEach(() => vi.restoreAllMocks());

describe("rig terminal open: when herdr-app is the target", () => {
  it("--provider herdr-app resolves herdr-app's home (or explicit --app-home)", () => {
    expect(herdrAppClient({ provider: "herdr-app" }, deps(inApp))).toEqual({ appHome: "/apps/h", ambient: false });
    expect(herdrAppClient({ provider: "herdr-app", appHome: "/x" }, deps({}))).toEqual({ appHome: "/x", ambient: false });
  });

  it("with neither --provider nor --window: a herdr-app terminal whose window socket exists chooses herdr-app", () => {
    expect(herdrAppClient({}, deps(inApp))).toEqual({ appHome: "/apps/h", ambient: true });
    expect(herdrAppClient({}, deps({ HERDR_APP_HOME: "/apps/h" }))).toBeNull();
    expect(herdrAppClient({}, deps(inApp, false))).toBeNull(); // markers alone invent no endpoint
  });

  it("--window and other named providers keep their meaning", () => {
    expect(herdrAppClient({ window: true }, deps(inApp, true))).toBeNull();
    expect(herdrAppClient({ provider: "herdr-app", window: true }, deps(inApp, true))).toBeNull();
    expect(herdrAppClient({ provider: "herdr" }, deps(inApp))).toBeNull();
    expect(herdrAppClient({ provider: "cmux" }, deps(inApp))).toBeNull();
    const openCmd = terminalCommand().commands.find((c) => c.name() === "open");
    const windowOpt = openCmd?.options.find((o) => o.long === "--window");
    expect(windowOpt?.description).toContain("still asks for a desktop window");
    const providerOpt = openCmd?.options.find((o) => o.long === "--provider");
    expect(providerOpt?.description).not.toContain(")(");
    expect(providerOpt?.description).not.toContain(") (");
  });

  it("probing an ambient herdr-app window: answering opens in herdr-app; unanswering or unconfirmed status falls back to desktop with an accurate note; explicit --provider herdr-app does not fall back", async () => {
    const runOpen = async (args: string[], env: NodeJS.ProcessEnv, probeReply: { status: number; available?: boolean }) => {
      const posts: Array<{ path: string; body: unknown }> = [];
      const gets: string[] = [];
      const logs: string[] = [];
      const errs: string[] = [];
      vi.spyOn(console, "log").mockImplementation((m) => { logs.push(String(m)); });
      vi.spyOn(console, "error").mockImplementation((m) => { errs.push(String(m)); });
      const client = {
        baseUrl: "http://localhost:7433",
        get: async (path: string) => {
          gets.push(path);
          if (path.startsWith("/api/terminal/status?provider=herdr-app")) {
            return probeReply.available === undefined
              ? { status: probeReply.status, data: { error: "not_found" } }
              : { status: probeReply.status, data: { providers: [{ name: "herdr-app", status: { available: probeReply.available, launch: { socketPath: "/apps/h/herdr-app.sock" } } }] } };
          }
          if (path === "/api/terminal/status" || path.startsWith("/api/terminal/status?provider=herdr")) {
            return {
              status: 200,
              data: {
                available: true,
                launch: { binary: "/bin/herdr", socketPath: "/tmp/h.sock", session: "default" },
                providers: [{ name: "herdr", liveness: { alive: true }, status: { available: true, launch: { binary: "/bin/herdr", socketPath: "/tmp/h.sock", session: "default" } } }],
              },
            };
          }
          if (path.startsWith("/api/terminal/preview")) {
            return {
              status: 200,
              data: {
                planId: "p1",
                status: { launch: { socketPath: "/tmp/h.sock" } },
                composed: {
                  id: "slice:s1",
                  pages: [[{ seat: "dev.build@demo", label: "dev.build", readOnly: false, paneCommand: "tmux attach -t =dev.build@demo" }]],
                  opened: [{ seat: "dev.build@demo", label: "dev.build", paneCommand: "tmux attach -t =dev.build@demo" }],
                  absent: [],
                  degraded: [],
                },
              },
            };
          }
          return { status: 200, data: {} };
        },
        post: async (path: string, body: unknown) => {
          posts.push({ path, body });
          const b = body as { provider?: string };
          if (path === "/api/terminal/follow") {
            return { status: 200, data: { provider: "herdr", ok: true, workspaceId: "ws-1", opened: ["dev.build@demo"], absent: [], degraded: [], pages: 1 } };
          }
          if (b.provider === "herdr-app" && probeReply.available !== true) {
            return { status: 200, data: { provider: "herdr-app", ok: false, code: "herdr_app_unavailable", error: "herdr-app is not answering", opened: [], absent: [], degraded: [], pages: 0 } };
          }
          return { status: 200, data: { provider: b.provider ?? "herdr", ok: true, opened: ["dev.build@demo"], absent: [], degraded: [], pages: 1 } };
        },
      } as unknown as DaemonClient;
      const cmdDeps: TerminalDeps = {
        env,
        socketExists: (p: string) => p === "/apps/h/herdr-app.sock",
        lifecycleDeps: {} as TerminalDeps["lifecycleDeps"],
        clientFactory: () => client,
        windowDeps: {
          env: { DISPLAY: ":0", TERM_PROGRAM: "herdr", HERDR_SOCKET_PATH: "/tmp/h.sock" },
          platform: "linux",
          exists: () => true,
          exec: async (_file: string, execArgs: string[]) => {
            if (execArgs[1] === "command -v herdr") return "/bin/herdr\n";
            return JSON.stringify({
              result: {
                running: true,
                socket: "/tmp/h.sock",
                workspaces: [{ workspace_id: "ws-1", label: "s1", focused: true }],
                tabs: [{ workspace_id: "ws-1", tab_id: "tb-1", label: "s1" }],
                tab: { workspace_id: "ws-1", tab_id: "tb-1" },
              },
            });
          },
          launch: async () => {},
          sleep: async () => {},
          id: () => "id1",
          herdrConfig: () => "/tmp/herdr.json",
        },
      };
      await terminalCommand(cmdDeps).parseAsync(["node", "terminal", "open", ...args]);
      return { posts, gets, logs, errs };
    };

    // 1. Ambient + available:true -> opens in herdr-app
    const okAmbient = await runOpen(["rig:demo", "--json"], inApp, { status: 200, available: true });
    expect(okAmbient.gets).toContain("/api/terminal/status?provider=herdr-app&appHome=%2Fapps%2Fh");
    expect(okAmbient.posts).toEqual([{ path: "/api/terminal/open", body: { view: "rig:demo", provider: "herdr-app", herdrApp: { appHome: "/apps/h" } } }]);
    expect(okAmbient.errs).toEqual([]);

    // 2. Ambient + available:false -> desktop fallback, stderr + notes, no /api/terminal/open with herdr-app
    const staleAmbient = await runOpen(["rig:demo", "--json"], inApp, { status: 200, available: false });
    expect(staleAmbient.gets).toContain("/api/terminal/status?provider=herdr-app&appHome=%2Fapps%2Fh");
    expect(staleAmbient.posts.some((p) => (p.body as { provider?: string })?.provider === "herdr-app")).toBe(false);
    expect(staleAmbient.errs[0]).toContain("herdr-app's socket exists at /apps/h/herdr-app.sock but it isn't answering; opening a desktop window instead. Use --provider herdr-app to require it.");
    const parsed = JSON.parse(staleAmbient.logs[0]!) as { notes?: string[] };
    expect(parsed.notes).toContain("herdr-app's socket exists at /apps/h/herdr-app.sock but it isn't answering; opening a desktop window instead. Use --provider herdr-app to require it.");

    // 3. Ambient + status route 404/4xx -> says the daemon could not confirm, not "isn't answering"
    const unconfirmedAmbient = await runOpen(["rig:demo", "--json"], inApp, { status: 404 });
    expect(unconfirmedAmbient.posts.some((p) => (p.body as { provider?: string })?.provider === "herdr-app")).toBe(false);
    expect(unconfirmedAmbient.errs[0]).toContain("the daemon could not confirm whether it is answering (HTTP 404)");
    expect(unconfirmedAmbient.errs[0]).not.toContain("isn't answering");

    // 4. Explicit --provider herdr-app + available:false -> still herdr-app, fails loudly, no fallback
    const explicitFlag = await runOpen(["rig:demo", "--provider", "herdr-app", "--json"], inApp, { status: 200, available: false });
    expect(explicitFlag.gets).toEqual([]);
    expect(explicitFlag.posts).toEqual([{ path: "/api/terminal/open", body: { view: "rig:demo", provider: "herdr-app", herdrApp: { appHome: "/apps/h" } } }]);
    expect(JSON.parse(explicitFlag.logs[0]!)).toMatchObject({ ok: false, provider: "herdr-app", code: "herdr_app_unavailable" });

    // 5. Ambient (no --provider) + --follow -> falls through to the existing Herdr follow path (never follow_unsupported)
    const ambientFollow = await runOpen(["slice:s1", "--follow", "--json"], inApp, { status: 200, available: true });
    expect(ambientFollow.gets.some((g) => g.startsWith("/api/terminal/status?provider=herdr-app"))).toBe(false);
    expect(ambientFollow.posts).toEqual([
      { path: "/api/terminal/follow", body: { view: "slice:s1", provider: "herdr", enabled: true } },
    ]);
    expect(JSON.parse(ambientFollow.logs[0]!)).toMatchObject({ ok: true, provider: "herdr", workspaceId: "ws-1" });

    // 6. Explicit --provider herdr-app + --follow -> returns follow_unsupported
    const explicitFollow = await runOpen(["slice:s1", "--provider", "herdr-app", "--follow", "--json"], inApp, { status: 200, available: true });
    expect(explicitFollow.gets).toEqual([]);
    expect(explicitFollow.posts).toEqual([]);
    expect(JSON.parse(explicitFollow.logs[0]!)).toMatchObject({ ok: false, provider: "herdr-app", code: "follow_unsupported" });

    // 7. Explicit --provider herdr-app + --window -> --window wins and opens a desktop window (never herdr-app)
    const explicitWindow = await runOpen(["rig:demo", "--provider", "herdr-app", "--window", "--json"], inApp, { status: 200, available: true });
    expect(explicitWindow.gets.some((g) => g.startsWith("/api/terminal/status?provider=herdr-app"))).toBe(false);
    expect(explicitWindow.posts.some((p) => (p.body as { provider?: string })?.provider === "herdr-app")).toBe(false);
    expect(JSON.parse(explicitWindow.logs[0]!)).toMatchObject({ ok: true, provider: "herdr" });
  });
});
