import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminalCommand, type TerminalDeps } from "../src/commands/terminal.js";
import type { WindowDeps } from "../src/terminal-window.js";

vi.mock("../src/daemon-lifecycle.js", async () => ({
  ...await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js"),
  getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
  getDaemonUrl: vi.fn(() => "http://localhost:7433"),
}));

interface Tab { workspace_id: string; tab_id: string; label: string }
function fixture(tabs: Tab[] = [], id = "kernel") {
  const panes = ["tui", "advisor", "operator"].map(seat => ({ seat, label: seat, paneCommand: `tmux attach-session -t '=fixture-${seat}'` }));
  const get = vi.fn(async (url: string) => ({ status: 200, data: url.includes("preview") ? {
    planId: "bound-plan", composed: { id, opened: panes, pages: [panes], absent: [], degraded: [] },
    status: { launch: { socketPath: "/daemon home/herdr.sock" } },
  } : { providers: [{ liveness: { alive: true } }] } }));
  const post = vi.fn(async () => {
    tabs.push({ workspace_id: `ws-${tabs.length}`, tab_id: `tab-${tabs.length}`, label: `openrig:${id}#l1` });
    return { status: 200, data: { provider: "herdr", ok: true, opened: panes.map(p => p.seat), absent: [], degraded: [], pages: 1 } };
  });
  const list = vi.fn(async () => JSON.stringify({ id: "cli:tab:list", result: { tabs } }));
  const focus = vi.fn(async (tabId: string) => JSON.stringify({ id: "cli:tab:focus", result: { tab: tabs.find(tab => tab.tab_id === tabId) } }));
  const exec = vi.fn(async (file: string, args: string[]) => {
    if (file === "/usr/bin/osascript") return "window-sized";
    if (args.includes("--version")) return "herdr 0.9.3";
    if (file === "/bin/sh") return "/fixture/bin/herdr";
    if (file === "/usr/bin/env" && args.at(-1) === "list") return list();
    if (file === "/usr/bin/env" && args.at(-2) === "focus") return focus(args.at(-1)!);
    throw new Error(`Unexpected command: ${file} ${args.join(" ")}`);
  });
  const windowDeps: WindowDeps = {
    platform: "darwin", env: { HERDR_SESSION: "wrong", HERDR_SOCKET_PATH: "/wrong.sock" },
    exists: () => false, exec, launch: vi.fn(async () => {}), sleep: vi.fn(async () => {}), id: () => "fixture",
  };
  const deps: TerminalDeps = {
    lifecycleDeps: {} as TerminalDeps["lifecycleDeps"], windowDeps,
    clientFactory: () => ({ baseUrl: "http://localhost:7433", get, post }) as unknown as ReturnType<TerminalDeps["clientFactory"]>,
  };
  return { tabs, list, focus, exec, post, run: (args: string[] = ["--json"]) => new Command().addCommand(terminalCommand(deps)).parseAsync(["terminal", "open", `saved:${id}`, ...args], { from: "user" }) };
}

describe("reopening a Herdr view in a desktop window", () => {
  let logs: string[];
  let originalExit: typeof process.exitCode;
  beforeEach(() => {
    logs = [];
    originalExit = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
  });
  afterEach(() => { process.exitCode = originalExit; vi.restoreAllMocks(); });

  it("creates the first space, then opens another window on it without adding tabs or spaces", async () => {
    const f = fixture();
    await f.run();
    expect(JSON.parse(logs[0]!)).toMatchObject({ ok: true, opened: ["tui", "advisor", "operator"] });
    const existing = structuredClone(f.tabs);
    await f.run(["--window", "--json"]);
    expect(f.tabs).toEqual(existing);
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.focus).toHaveBeenCalledExactlyOnceWith("tab-0");
    expect(f.exec.mock.calls.filter(([file]) => file === "/usr/bin/osascript")).toHaveLength(2);
    expect(JSON.parse(logs[1]!)).toMatchObject({ ok: true, opened: [], pages: 0, reusedWorkspace: { id: "ws-0", tabId: "tab-0", view: "kernel" } });
    expect(process.exitCode).toBeUndefined();
    for (const [, args] of f.exec.mock.calls.filter(([file]) => file === "/usr/bin/env")) {
      expect(args.slice(0, 8)).toEqual(["-u", "TMUX", "-u", "HERDR_SESSION", "-u", "HERDR_SOCKET_PATH", "HERDR_SOCKET_PATH=/daemon home/herdr.sock", "/fixture/bin/herdr"]);
    }
  });

  it("keeps all existing pages and duplicate spaces, selecting only the first matching tab", async () => {
    const tabs = [
      { workspace_id: "renamed", tab_id: "first", label: "openrig:kernel#l1/1" },
      { workspace_id: "renamed", tab_id: "second", label: "openrig:kernel#l1/2" },
      { workspace_id: "duplicate", tab_id: "third", label: "openrig:kernel#l2" },
    ];
    const f = fixture(structuredClone(tabs));
    await f.run([]);
    expect(f.tabs).toEqual(tabs);
    expect(f.focus).toHaveBeenCalledExactlyOnceWith("first");
    expect(f.post).not.toHaveBeenCalled();
    expect(logs[0]).toContain('Reused herdr workspace renamed for view "kernel"');
    expect(logs[0]).not.toMatch(/Prepared|No tiles opened/);
    expect(process.exitCode).toBeUndefined();
  });

  it.each(["kernel-other", "kernel#other", "rig:kernel"])("does not reuse the different view %s", async other => {
    const f = fixture([{ workspace_id: "same-human-name", tab_id: "unrelated", label: `openrig:${other}#l1` }]);
    await f.run();
    expect(f.focus).not.toHaveBeenCalled();
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logs[0]!)).toMatchObject({ ok: true, opened: ["tui", "advisor", "operator"] });
  });

  it("uses the complete resolved view id even when it contains a delimiter", async () => {
    const f = fixture([{ workspace_id: "saved", tab_id: "exact", label: "openrig:kernel#other#l1" }], "kernel#other");
    await f.run();
    expect(f.focus).toHaveBeenCalledExactlyOnceWith("exact");
    expect(f.post).not.toHaveBeenCalled();
  });

  it.each(["malformed", "lost", "wrong shape"])("does not create a duplicate after %s inventory", async kind => {
    const f = fixture();
    f.list.mockImplementation(async () => {
      if (kind === "lost") throw new Error("reply lost");
      return kind === "malformed" ? "{" : JSON.stringify({ result: {} });
    });
    await f.run();
    expect(f.post).not.toHaveBeenCalled();
    expect(f.focus).not.toHaveBeenCalled();
    expect(JSON.parse(logs[0]!)).toMatchObject({ ok: false, error: expect.stringContaining("outcome could not be confirmed") });
    expect(process.exitCode).toBe(1);
  });

  it.each(["lost", "different tab"])("does not create a replacement or retry focus after a %s focus reply", async kind => {
    const f = fixture([{ workspace_id: "existing", tab_id: "first", label: "openrig:kernel#l1" }]);
    f.focus.mockImplementation(async () => {
      if (kind === "lost") throw new Error("focus applied, reply lost");
      return JSON.stringify({ result: { tab: { tab_id: "other", workspace_id: "existing" } } });
    });
    await f.run();
    expect(f.focus).toHaveBeenCalledTimes(1);
    expect(f.post).not.toHaveBeenCalled();
    expect(JSON.parse(logs[0]!)).toMatchObject({ ok: false, error: expect.stringContaining("outcome could not be confirmed") });
    expect(process.exitCode).toBe(1);
  });
});
