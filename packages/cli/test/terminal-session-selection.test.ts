import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminalCommand, type TerminalDeps } from "../src/commands/terminal.js";
import type { WindowDeps } from "../src/terminal-window.js";

vi.mock("../src/daemon-lifecycle.js", async () => ({
  ...await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js"),
  getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
  getDaemonUrl: vi.fn(() => "http://localhost:7433"),
}));

function fixture(options: { legacy?: boolean; noHerdr?: boolean; statusMismatch?: boolean; dropOpenSession?: boolean } = {}) {
  const pane = { seat: "worker@prod", label: "worker", paneCommand: "tmux attach -t 'worker@prod'" };
  const get = vi.fn(async (url: string) => {
    const requested = new URL(url, "http://localhost").searchParams.get("session") ?? "default";
    const session = options.legacy ? undefined : options.statusMismatch && url.includes("status") ? "wrong-session" : requested;
    const launch = { socketPath: `/fixture/${session ?? "legacy-default"}/herdr.sock`, ...(session !== undefined ? { session } : {}) };
    return { status: 200, data: url.includes("preview")
      ? { session, planId: `plan-${requested}`, composed: { id: "prod", opened: [pane], pages: [[pane]], absent: [], degraded: [] }, status: { launch } }
      : { session, providers: [{ name: "herdr", status: { launch }, liveness: { alive: true } }] } };
  });
  const post = vi.fn(async (_url: string, body: Record<string, unknown>) => ({ status: 200,
    data: { provider: "herdr", ...(options.dropOpenSession ? {} : { session: body.session }), ok: true, opened: [pane.seat], absent: [], degraded: [], pages: 1 } }));
  const exec = vi.fn(async (file: string, args: string[]) => {
    if (file === "/usr/bin/osascript") return "window";
    if (args.includes("--version")) {
      if (options.noHerdr) throw new Error("herdr unavailable");
      return "herdr 0.9.1";
    }
    if (file === "/bin/sh") {
      if (options.noHerdr) throw new Error("herdr unavailable");
      return "/fixture/bin/herdr";
    }
    if (file === "/usr/bin/env") return JSON.stringify({ result: { workspaces: [] } });
    return "";
  });
  const windowDeps: WindowDeps = { platform: "darwin", env: { TERM_PROGRAM: "Apple_Terminal", HERDR_SESSION: "unrelated", HERDR_SOCKET_PATH: "/unrelated.sock" },
    exists: () => false, exec, launch: vi.fn(async () => {}), sleep: vi.fn(async () => {}), id: () => "fixture", herdrConfig: vi.fn(() => "/fixture/private.toml") };
  const deps: TerminalDeps = { lifecycleDeps: {} as TerminalDeps["lifecycleDeps"], windowDeps,
    clientFactory: () => ({ baseUrl: "http://localhost:7433", get, post }) as unknown as ReturnType<TerminalDeps["clientFactory"]> };
  return { get, post, exec, windowDeps,
    run: (args: string[]) => new Command().addCommand(terminalCommand(deps)).parseAsync(["terminal", ...args], { from: "user" }) };
}

describe("terminal --session", () => {
  let logs: string[];
  let originalExit: typeof process.exitCode;
  beforeEach(() => {
    logs = []; originalExit = process.exitCode; process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
  });
  afterEach(() => { process.exitCode = originalExit; vi.restoreAllMocks(); });

  it("previews and opens the selected session without a desktop for an explicit provider", async () => {
    const f = fixture();
    await f.run(["open", "prod", "--provider", "herdr", "--session", "prod", "--json"]);
    expect(f.get).toHaveBeenCalledExactlyOnceWith("/api/terminal/preview?view=prod&provider=herdr&session=prod");
    expect(f.post).toHaveBeenCalledExactlyOnceWith("/api/terminal/open", { view: "prod", provider: "herdr", session: "prod", expectedPlan: "plan-prod" }, { timeoutMs: 45_000 });
    expect(f.exec).not.toHaveBeenCalled();
    expect(JSON.parse(logs[0]!)).toMatchObject({ ok: true, session: "prod" });
  });

  it.each([false, true])("an older daemon cannot silently redirect a named open (window=%s)", async window => {
    const f = fixture({ legacy: true });
    await f.run(["open", "prod", "--provider", "herdr", "--session", "prod", "--json", ...(window ? ["--window"] : [])]);
    expect(process.exitCode).toBe(1); expect(JSON.parse(logs[0]!).error).toContain("did not confirm");
    expect(f.post).not.toHaveBeenCalled();
    expect(f.exec.mock.calls.some(([file]) => file === "/usr/bin/osascript")).toBe(false);
  });

  it("a desktop request carries the same session through preview, readiness, inventory and open", async () => {
    const f = fixture();
    await f.run(["open", "prod", "--session", "prod", "--json"]);
    expect(process.exitCode).toBeUndefined();
    expect(f.get.mock.calls.map(([url]) => url)).toEqual(["/api/terminal/preview?view=prod&provider=herdr&session=prod", "/api/terminal/status?provider=herdr&session=prod"]);
    const desktop = f.exec.mock.calls.find(([file]) => file === "/usr/bin/osascript");
    expect(desktop?.[1].join(" ")).toContain("HERDR_SOCKET_PATH='/fixture/prod/herdr.sock'");
    for (const [, args] of f.exec.mock.calls.filter(([file]) => file === "/usr/bin/env")) {
      expect(args).toContain("HERDR_SOCKET_PATH=/fixture/prod/herdr.sock"); expect(args).not.toContain("/unrelated.sock");
    }
    expect(f.post).toHaveBeenCalledExactlyOnceWith("/api/terminal/open", { view: "prod", provider: "herdr", session: "prod", expectedPlan: "plan-prod" }, { timeoutMs: 45_000 });
    expect(JSON.parse(logs[0]!)).toMatchObject({ ok: true, session: "prod", window: { app: "Terminal" } });
  });

  it("does not fall back to tmux when Herdr is missing for an explicit session", async () => {
    const f = fixture({ noHerdr: true });
    await f.run(["open", "prod", "--session", "prod", "--json"]);
    expect(process.exitCode).toBe(1); expect(f.post).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled();
    expect(f.exec.mock.calls.some(([file]) => file === "/usr/bin/osascript")).toBe(false);
  });

  it("a changed endpoint after window launch is unconfirmed and never drives another session", async () => {
    const f = fixture({ statusMismatch: true });
    await f.run(["open", "prod", "--session", "prod", "--json"]);
    expect(process.exitCode).toBe(1); expect(f.post).not.toHaveBeenCalled();
    expect(JSON.parse(logs[0]!)).toMatchObject({ ok: false, windowAttempted: true, window: { app: "Terminal" } });
    expect(JSON.parse(logs[0]!).error).toContain("outcome could not be confirmed");
    expect(f.exec.mock.calls.filter(([file]) => file === "/usr/bin/env")).toEqual([]);
  });

  it("rejects a preview for another session before a headless open", async () => {
    const f = fixture();
    await f.run(["open", "prod", "--provider", "herdr", "--session", "prod", "--expected-plan", "plan-other", "--json"]);
    expect(process.exitCode).toBe(1); expect(f.post).not.toHaveBeenCalled(); expect(JSON.parse(logs[0]!).code).toBe("preview_changed");
  });

  it("does not report success when an open response omits the selected session", async () => {
    const f = fixture({ dropOpenSession: true });
    await f.run(["open", "prod", "--provider", "herdr", "--session", "prod", "--json"]);
    expect(f.post).toHaveBeenCalledTimes(1); expect(process.exitCode).toBe(1);
    expect(JSON.parse(logs[0]!)).toMatchObject({ ok: false, code: "terminal_session_unconfirmed" });
  });

  it("status selects a named session and rejects an older daemon's unscoped reply", async () => {
    const f = fixture(); await f.run(["status", "--session", "prod", "--json"]);
    expect(f.get).toHaveBeenCalledExactlyOnceWith("/api/terminal/status?session=prod");
    expect(JSON.parse(logs[0]!)).toMatchObject({ session: "prod" });
    logs.length = 0; const old = fixture({ legacy: true }); await old.run(["status", "--session", "prod", "--json"]);
    expect(process.exitCode).toBe(1); expect(JSON.parse(logs[0]!).code).toBe("terminal_session_unconfirmed");
  });
});
