import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminalCommand, type TerminalDeps } from "../src/commands/terminal.js";
import { DaemonConnectionError, DaemonResponseError, DaemonTimeoutError } from "../src/client.js";
import type { WindowDeps } from "../src/terminal-window.js";

vi.mock("../src/daemon-lifecycle.js", async () => ({
  ...await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js"),
  getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
  getDaemonUrl: vi.fn(() => "http://localhost:7433"),
}));

function fixture(options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; unsupported?: boolean; denial?: boolean; remote?: boolean } = {}) {
  const panes = ["tui", "advisor", "operator"].map(seat => ({ seat, label: seat, paneCommand: `tmux attach-session -t '=fixture-${seat}'` }));
  const get = vi.fn(async (url: string) => ({ status: 200, data: url.includes("preview") ? {
    planId: "one-plan", composed: { opened: panes, pages: [panes], columns: 3, absent: [], degraded: [] },
    status: { launch: { socketPath: "/fixture/herdr.sock" } },
  } : { providers: [{ liveness: { alive: true } }] } }));
  const post = vi.fn(async () => ({ status: 200, data: { provider: "herdr", ok: true, opened: panes.map(p => p.seat), absent: [], degraded: [], pages: 1 } }));
  const exec = vi.fn(async (file: string, args: string[]) => {
    if (file === "/usr/bin/osascript") {
      if (options.denial) throw new Error("Automation denied");
      return "window";
    }
    if (args.includes("--version")) return "herdr 0.9.3";
    if (file === "/bin/sh") {
      if (options.unsupported) throw new Error("not installed");
      return args[1] === "command -v herdr" ? "/fixture/bin/herdr" : "/fixture/bin/terminal";
    }
    return "";
  });
  const windowDeps: WindowDeps = { platform: options.platform ?? "darwin", env: options.env ?? {}, exists: () => false, exec, launch: vi.fn(async () => {}), sleep: vi.fn(async () => {}), id: () => "fixture" };
  const deps: TerminalDeps = {
    lifecycleDeps: {} as TerminalDeps["lifecycleDeps"], windowDeps,
    clientFactory: () => ({ baseUrl: options.remote ? "http://192.0.2.2:7433" : "http://localhost:7433", get, post }) as unknown as ReturnType<TerminalDeps["clientFactory"]>,
  };
  const command = new Command().addCommand(terminalCommand(deps));
  return { get, post, exec, windowDeps, run: (args: string[]) => command.parseAsync(["terminal", "open", ...args], { from: "user" }) };
}

describe("terminal open desktop default", () => {
  let logs: string[];
  let originalExit: typeof process.exitCode;
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
    originalExit = process.exitCode;
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.exitCode = originalExit;
    vi.restoreAllMocks();
  });

  it.each([{ flags: [] }, { flags: ["--window"] }])("keeps the TUI preview binding on the desktop route with $flags", async ({ flags }) => {
    const f = fixture();
    await f.run(["--expected-plan", "old-plan", ...flags, "--json", "--", "saved:kernel"]);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(logs[0]!).error).toContain("changed since preview");
    expect(f.exec.mock.calls.some(([file]) => file === "/usr/bin/osascript")).toBe(false);
    expect(f.post).not.toHaveBeenCalled();
  });

  it("forwards a preview binding to the explicit existing-workspace route", async () => {
    const f = fixture({ platform: "linux", env: {} });
    await f.run(["saved:kernel", "--provider", "herdr", "--expected-plan", "one-plan", "--json"]);
    expect(f.post).toHaveBeenCalledExactlyOnceWith("/api/terminal/open", { view: "saved:kernel", provider: "herdr", expectedPlan: "one-plan" }, { timeoutMs: 45_000 });
    expect(f.exec).not.toHaveBeenCalled();
  });

  it.each([{ args: [] }, { args: ["--window"] }, { args: ["--provider", "herdr", "--window"] }])("opens the desktop with arguments $args, even when the provider socket already answers", async ({ args }) => {
    const f = fixture();
    await f.run(["saved:kernel", ...args, "--json"]);
    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(logs[0]!)).toMatchObject({ opened: ["tui", "advisor", "operator"], window: { app: "Terminal", surface: "window" } });
    expect(f.exec.mock.calls.filter(([file]) => file === "/usr/bin/osascript")).toHaveLength(1);
    expect(f.post).toHaveBeenCalledExactlyOnceWith("/api/terminal/open", { view: "saved:kernel", provider: "herdr", expectedPlan: "one-plan" }, { timeoutMs: 45_000 });
  });

  it.each(["headless", "unsupported", "remote"])("%s gives a primary no-window failure and an exact recovery command without opening provider tiles", async reason => {
    const f = fixture({ platform: "linux", env: reason === "headless" ? {} : { DISPLAY: ":fixture" }, unsupported: reason === "unsupported", remote: reason === "remote" });
    await f.run(["saved:kernel", "--json"]);
    expect(process.exitCode).toBe(1);
    const result = JSON.parse(logs[0]!);
    expect(result).toMatchObject({ ok: false, opened: [], code: "terminal_window_failed" });
    expect(result.error).toContain("No terminal window was opened.");
    expect(result.error).toContain("rig terminal open 'saved:kernel' --window");
    expect(f.post).not.toHaveBeenCalled();
    expect(f.windowDeps.launch).not.toHaveBeenCalled();
  });

  it("human headless output leads with no window, not a success or a note", async () => {
    const f = fixture({ platform: "linux", env: {} });
    await f.run(["saved:kernel"]);
    expect(logs[0]).toMatch(/^No terminal window was opened\./);
    expect(logs[0]).toContain("rig terminal open 'saved:kernel' --window");
  });

  it("does not replay an uncertain desktop request or claim that no window exists", async () => {
    const f = fixture({ denial: true });
    await f.run(["saved:kernel", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(logs[0]!).error).toContain("Terminal window status is unknown.");
    expect(f.exec.mock.calls.filter(([file]) => file === "/usr/bin/osascript")).toHaveLength(1);
    expect(f.post).not.toHaveBeenCalled();
  });

  it.each(["herdr", "cmux"])("keeps explicit %s on its existing-workspace route from a headless caller", async provider => {
    const f = fixture({ platform: "linux", env: {} });
    await f.run(["saved:kernel", "--provider", provider]);
    expect(process.exitCode).toBeUndefined();
    expect(f.post).toHaveBeenCalledExactlyOnceWith("/api/terminal/open", { view: "saved:kernel", provider }, { timeoutMs: 45_000 });
    expect(f.get).not.toHaveBeenCalled();
    expect(f.exec).not.toHaveBeenCalled();
    expect(f.windowDeps.launch).not.toHaveBeenCalled();
    expect(logs[0]).toContain("Prepared 3 tile(s)");
    expect(logs[0]).not.toMatch(/window requested|Terminal:/i);
  });

  it.each([
    { name: "lost", error: new DaemonConnectionError("Reply connection lost") },
    { name: "unreadable", error: new DaemonResponseError(200, "truncated") },
    { name: "timed out", error: new DaemonTimeoutError("Reply timed out") },
  ].flatMap(row => [false, true].map(json => ({ ...row, json }))))("preserves unknown outcome after an applied layout and $name reply (json=$json)", async ({ error, json }) => {
    const f = fixture();
    const applied: string[] = [];
    f.post.mockImplementation(async () => {
      applied.push("saved:kernel");
      throw error;
    });
    await f.run(["saved:kernel", ...(json ? ["--json"] : [])]);
    expect(applied).toEqual(["saved:kernel"]);
    expect(process.exitCode).toBe(1);
    const message = json ? JSON.parse(logs[0]!).error : logs[0];
    expect(message).toMatch(/^A terminal window was requested, but the view outcome could not be confirmed\./);
    expect(message).toContain("Inspect the terminal before retrying");
    expect(message).not.toMatch(/view did not open|No terminal window was opened/);
    expect(f.exec.mock.calls.filter(([file]) => file === "/usr/bin/osascript")).toHaveLength(1);
    expect(f.post).toHaveBeenCalledTimes(1);
    if (json) expect(JSON.parse(logs[0]!)).toMatchObject({ ok: false, window: { app: "Terminal", surface: "window" } });
  });
});
