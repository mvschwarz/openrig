import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminalCommand, type TerminalDeps } from "../src/commands/terminal.js";
import type { WindowDeps } from "../src/terminal-window.js";

vi.mock("../src/daemon-lifecycle.js", async () => ({
  ...await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js"),
  getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
  getDaemonUrl: vi.fn(() => "http://localhost:7433"),
}));

const planId = "0123456789abcdef".repeat(4);
const label = (id = "kernel", token = "l1") => `openrig:${id}#${planId.slice(0, 16)}#${token}`;
interface Tab { workspace_id: string; tab_id: string; label: string }
const spaceLabels: Record<string, string> = { "openrig-kernel": "openrig kernel", "old-name": "switchboard" };
function fixture(tabs: Tab[] = [], id = "kernel", session?: string) {
  const socketPath = session === undefined ? "/daemon home/herdr.sock" : `/daemon home/sessions/${session}/herdr.sock`;
  const panes = ["tui", "advisor", "operator"].map(seat => ({ seat, label: seat, paneCommand: `tmux attach -t 'fixture-${seat}'` }));
  const composed = { id, opened: panes, pages: [panes], absent: [] as Array<{ seat: string; host: string | null; reason: string }>, degraded: [] as Array<{ seat: string; host: string; reason: string }> };
  const get = vi.fn(async (url: string) => ({ status: 200, data: url.includes("preview") ? {
    planId, composed, ...(session !== undefined ? { session } : {}),
    status: { launch: { socketPath, ...(session !== undefined ? { session } : {}) } },
  } : { ...(session !== undefined ? { session } : {}), providers: [{ liveness: { alive: true }, ...(session !== undefined ? { status: { launch: { socketPath, session } } } : {}) }] } }));
  const post = vi.fn(async () => {
    tabs.push({ workspace_id: `ws-${tabs.length}`, tab_id: `tab-${tabs.length}`, label: label(id) });
    return { status: 200, data: { provider: "herdr", ...(session !== undefined ? { session } : {}), ok: true, opened: panes.map(p => p.seat), absent: [], degraded: [], pages: 1 } };
  });
  const workspaces = vi.fn(async () => JSON.stringify({ result: { workspaces: [...new Set(tabs.map(tab => tab.workspace_id))].map(workspace_id => ({ workspace_id, label: spaceLabels[workspace_id] })) } }));
  const list = vi.fn(async (workspace: string) => JSON.stringify({ id: "cli:tab:list", result: { tabs: tabs.filter(tab => tab.workspace_id === workspace) } }));
  const focus = vi.fn(async (tabId: string) => JSON.stringify({ id: "cli:tab:focus", result: { tab: tabs.find(tab => tab.tab_id === tabId) } }));
  const paneList = vi.fn(async (workspace: string) => JSON.stringify({ result: { panes: tabs
    .filter(tab => tab.workspace_id === workspace)
    .flatMap(tab => (composed.pages.length > 1 ? composed.pages[Number(tab.label.split("/").at(-1)) - 1] ?? [] : composed.opened)
      .map(pane => ({ workspace_id: workspace, tab_id: tab.tab_id, pane_id: `${tab.tab_id}-${pane.seat}` }))) } }));
  const processInfo = vi.fn(async (paneId: string) => JSON.stringify({ result: { process_info: {
    pane_id: paneId, foreground_processes: [{ pid: 101 + panes.findIndex(pane => paneId.endsWith(`-${pane.seat}`)) }],
  } } }));
  const clients = vi.fn(async () => panes.map((pane, i) => `${101 + i}\tfixture-${pane.seat}\t0`).join("\n"));
  const exec = vi.fn(async (file: string, args: string[]) => {
    if (file === "/usr/bin/osascript") return "window-sized";
    if (args.includes("--version")) return "herdr 0.9.3";
    if (file === "/bin/sh") return args[1] === "command -v tmux" ? "/fixture/bin/tmux" : "/fixture/bin/herdr";
    if (file === "/fixture/bin/tmux") return clients();
    if (args.includes("process-info")) return processInfo(args.at(-1)!);
    if (args.includes("pane")) return paneList(args.at(-1)!);
    if (file === "/usr/bin/env" && args.at(-2) === "workspace" && args.at(-1) === "list") return workspaces();
    if (file === "/usr/bin/env" && args.at(-3) === "list" && args.at(-2) === "--workspace") return list(args.at(-1)!);
    if (file === "/usr/bin/env" && args.at(-2) === "focus") return focus(args.at(-1)!);
    throw new Error(`Unexpected command: ${file} ${args.join(" ")}`);
  });
  const windowDeps: WindowDeps = {
    platform: "darwin", env: { TERM_PROGRAM: "Apple_Terminal", HERDR_SESSION: "wrong", HERDR_SOCKET_PATH: "/wrong.sock" },
    exists: () => false, exec, launch: vi.fn(async () => {}), sleep: vi.fn(async () => {}), herdrConfig: vi.fn(() => "/fixture/private herdr.toml"), id: () => "fixture",
  };
  const deps: TerminalDeps = {
    lifecycleDeps: {} as TerminalDeps["lifecycleDeps"], windowDeps,
    clientFactory: () => ({ baseUrl: "http://localhost:7433", get, post }) as unknown as ReturnType<TerminalDeps["clientFactory"]>,
  };
  return { tabs, composed, workspaces, list, focus, paneList, processInfo, clients, exec, post, get, socketPath, windowDeps, run: (args: string[] = ["--json"]) => new Command().addCommand(terminalCommand(deps)).parseAsync(["terminal", "open", `saved:${id}`, ...args], { from: "user" }) };
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

  it("a named session scopes every reuse inventory and focus command to the selected socket", async () => {
    const f = fixture([{ workspace_id: "existing", tab_id: "existing-tab", label: label() }], "kernel", "prod");
    await f.run(["--session", "prod", "--json"]);
    expect(process.exitCode).toBeUndefined();
    expect(f.focus).toHaveBeenCalledExactlyOnceWith("existing-tab"); expect(f.post).not.toHaveBeenCalled();
    expect(JSON.parse(logs[0]!)).toMatchObject({ ok: true, session: "prod", reusedWorkspace: { id: "existing" } });
    for (const [, args] of f.exec.mock.calls.filter(([file]) => file === "/usr/bin/env")) expect(args).toContain(`HERDR_SOCKET_PATH=${f.socketPath}`);
    expect(f.get.mock.calls.every(([url]) => url.includes("session=prod"))).toBe(true);
  });

  it("stale-view cleanup guidance names the selected socket and never closes another workspace", async () => {
    const f = fixture([{ workspace_id: "old", tab_id: "old-tab", label: label() }], "kernel", "prod");
    f.processInfo.mockResolvedValue(JSON.stringify({ result: { process_info: { pane_id: "unrelated", foreground_processes: [] } } }));
    await f.run(["--session", "prod", "--json"]);
    expect(f.post).toHaveBeenCalledExactlyOnceWith("/api/terminal/open", { view: "saved:kernel", provider: "herdr", session: "prod", expectedPlan: planId }, { timeoutMs: 45_000 });
    expect(JSON.parse(logs[0]!).notes.join("\n")).toContain(`env -u HERDR_SESSION HERDR_SOCKET_PATH='${f.socketPath}' '/fixture/bin/herdr' workspace close 'old'`);
    expect(f.exec.mock.calls.some(([, args]) => args.includes("close"))).toBe(false);
  });


  it.each(["plain shells", "detached clients", "wrong session", "read-only mismatch"])("recomposes a matching saved plan with %s", async state => {
    const old = { workspace_id: "restored", tab_id: "old-tab", label: label() };
    const f = fixture([old]);
    if (state === "plain shells") f.processInfo.mockImplementation(async paneId => JSON.stringify({ result: { process_info: { pane_id: paneId, foreground_processes: [{ pid: 999, name: "zsh" }] } } }));
    if (state === "detached clients") f.clients.mockResolvedValue("");
    if (state === "wrong session") f.clients.mockResolvedValue("101\tunrelated\t0\n102\tfixture-advisor\t0\n103\tfixture-operator\t0");
    if (state === "read-only mismatch") f.clients.mockResolvedValue("101\tfixture-tui\t1\n102\tfixture-advisor\t0\n103\tfixture-operator\t0");
    await f.run();
    expect(f.focus).not.toHaveBeenCalled();
    expect(f.post).toHaveBeenCalledExactlyOnceWith("/api/terminal/open", { view: "saved:kernel", provider: "herdr", expectedPlan: planId }, { timeoutMs: 45_000 });
    expect(f.tabs[0]).toEqual(old);
    expect(JSON.parse(logs[0]!)).toMatchObject({ ok: true, notes: expect.arrayContaining([expect.stringContaining("Could not confirm live attachments in workspace restored")]) });
  });

  it.each(["missing page", "dead second page"])("checks all pages before reuse: %s", async state => {
    const f = fixture([
      { workspace_id: "old", tab_id: "first", label: label("kernel", "l1/1") },
      { workspace_id: "old", tab_id: "second", label: label("kernel", "l1/2") },
      { workspace_id: "old", tab_id: "third", label: label("kernel", "l1/3") },
    ]);
    f.composed.pages = f.composed.opened.map(pane => [pane]);
    if (state === "missing page") f.tabs.splice(1, 1);
    else f.processInfo.mockImplementation(async paneId => JSON.stringify({ result: { process_info: { pane_id: paneId, foreground_processes: [{ pid: paneId.startsWith("second-") ? 999 : paneId.startsWith("first-") ? 101 : 103 }] } } }));
    await f.run();
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.focus).not.toHaveBeenCalled();
  });

  it.each(["missing panes", "wrong workspace", "wrong process pane", "lost process reply", "malformed process reply"])("keeps old contents and creates once when attachment inventory is unconfirmed: %s", async state => {
    const f = fixture([{ workspace_id: "old", tab_id: "first", label: label() }]);
    if (state === "missing panes") f.paneList.mockResolvedValue(JSON.stringify({ result: { panes: [] } }));
    if (state === "wrong workspace") f.paneList.mockResolvedValue(JSON.stringify({ result: { panes: [{ workspace_id: "other", tab_id: "first", pane_id: "first-tui" }] } }));
    if (state === "wrong process pane") f.processInfo.mockResolvedValue(JSON.stringify({ result: { process_info: { pane_id: "other", foreground_processes: [{ pid: 101 }] } } }));
    if (state === "lost process reply") f.processInfo.mockRejectedValue(new Error("reply lost"));
    if (state === "malformed process reply") f.processInfo.mockResolvedValue("{");
    await f.run();
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.focus).not.toHaveBeenCalled();
    expect(f.exec.mock.calls.some(([, args]) => args.includes("close") || args.includes("send-text"))).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it("reuses a live matching copy after a stale one instead of creating repeatedly", async () => {
    const f = fixture([
      { workspace_id: "restored", tab_id: "stale", label: label("kernel", "old") },
      { workspace_id: "live", tab_id: "fresh", label: label("kernel", "new") },
    ]);
    f.processInfo.mockImplementation(async paneId => JSON.stringify({ result: { process_info: { pane_id: paneId,
      foreground_processes: [{ pid: paneId.startsWith("stale-") ? 999 : 101 + ["tui", "advisor", "operator"].findIndex(seat => paneId.endsWith(seat)) }],
    } } }));
    await f.run();
    expect(f.focus).toHaveBeenCalledExactlyOnceWith("fresh");
    expect(f.post).not.toHaveBeenCalled();
    expect(f.tabs).toHaveLength(2);
  });

  it("does not reuse a live space with the same tab names under another space name", async () => {
    const f = fixture([{ workspace_id: "old-name", tab_id: "named", label: "tui · advisor · operator" }]);
    (f.composed as typeof f.composed & { spaceLabel?: string }).spaceLabel = "openrig kernel";
    await f.run();
    expect(f.focus).not.toHaveBeenCalled();
    expect(f.post).toHaveBeenCalledTimes(1);
  });

  it.each([["live", true], ["plain shells", false]] as const)("finds a named view's space by its tab names and reuses it only when attached: %s", async (state, reused) => {
    const f = fixture([{ workspace_id: "openrig-kernel", tab_id: "named", label: "tui · advisor · operator" }]);
    (f.composed as typeof f.composed & { spaceLabel?: string }).spaceLabel = "openrig kernel";
    if (state === "plain shells") f.processInfo.mockImplementation(async paneId => JSON.stringify({ result: { process_info: { pane_id: paneId, foreground_processes: [{ pid: 999, name: "zsh" }] } } }));
    await f.run();
    if (reused) {
      expect(f.focus).toHaveBeenCalledExactlyOnceWith("named");
      expect(f.post).not.toHaveBeenCalled();
    } else {
      expect(f.focus).not.toHaveBeenCalled();
      expect(f.post).toHaveBeenCalledTimes(1);
    }
  });

  it("confirms an absolute tmux command, quoted session alias and read-only attachment", async () => {
    const f = fixture([{ workspace_id: "old", tab_id: "first", label: label() }]);
    f.composed.opened[0]!.paneCommand = "'/fixture/bin/tmux' attach -r -t 'alias'\"'\"'s session'";
    f.clients.mockResolvedValue("101\talias's session\t1\n102\tfixture-advisor\t0\n103\tfixture-operator\t0");
    await f.run();
    expect(f.focus).toHaveBeenCalledExactlyOnceWith("first");
    expect(f.post).not.toHaveBeenCalled();
  });

  it("ignores an inert filler once the expected tiles have live attachments", async () => {
    const f = fixture([{ workspace_id: "old", tab_id: "first", label: label() }]);
    f.paneList.mockResolvedValue(JSON.stringify({ result: { panes: ["blank", "tui", "advisor", "operator"].map(seat => ({ workspace_id: "old", tab_id: "first", pane_id: `first-${seat}` })) } }));
    f.processInfo.mockImplementation(async paneId => JSON.stringify({ result: { process_info: { pane_id: paneId,
      ...(paneId.endsWith("blank") ? {} : { foreground_processes: [{ pid: 101 + ["tui", "advisor", "operator"].findIndex(seat => paneId.endsWith(seat)) }] }),
    } } }));
    await f.run();
    expect(f.focus).toHaveBeenCalledExactlyOnceWith("first");
    expect(f.post).not.toHaveBeenCalled();
  });

  it("creates a fresh SSH view when local attachment inventory cannot prove it", async () => {
    const f = fixture([{ workspace_id: "old", tab_id: "first", label: label() }]);
    f.composed.opened[0]!.paneCommand = "ssh 'remote' 'tmux attach -t remote-seat'";
    await f.run();
    expect(f.focus).not.toHaveBeenCalled();
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
  });

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

  it("creates once and then focuses the same plan inside Herdr without a window or config change", async () => {
    const f = fixture();
    f.windowDeps.env = { TERM_PROGRAM: "herdr", HERDR_SOCKET_PATH: "/daemon home/herdr.sock" };
    await f.run();
    await f.run();
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.tabs).toHaveLength(1);
    expect(f.focus).toHaveBeenCalledExactlyOnceWith("tab-0");
    expect(JSON.parse(logs[1]!)).toMatchObject({ ok: true, reusedWorkspace: { id: "ws-0", tabId: "tab-0", view: "kernel" } });
    expect(JSON.parse(logs[1]!).window).toBeUndefined();
    expect(f.exec.mock.calls.some(([file]) => file === "/usr/bin/osascript")).toBe(false);
    expect(f.windowDeps.herdrConfig).not.toHaveBeenCalled();
    expect(f.windowDeps.launch).not.toHaveBeenCalled();
  });

  it("keeps an uncertain current-Herdr focus from creating or launching a replacement", async () => {
    const f = fixture([{ workspace_id: "existing", tab_id: "first", label: label() }]);
    f.windowDeps.env = { TERM_PROGRAM: "herdr", HERDR_SOCKET_PATH: "/daemon home/herdr.sock" };
    f.focus.mockRejectedValue(new Error("focus reply lost"));
    await f.run();
    expect(f.focus).toHaveBeenCalledTimes(1);
    expect(f.post).not.toHaveBeenCalled();
    expect(f.exec.mock.calls.some(([file]) => file === "/usr/bin/osascript")).toBe(false);
    expect(JSON.parse(logs[0]!)).toMatchObject({ ok: false, error: expect.stringContaining("current Herdr view outcome could not be confirmed") });
    expect(process.exitCode).toBe(1);
  });

  it("keeps all existing pages and duplicate spaces, selecting only the first matching tab", async () => {
    const tabs = [
      { workspace_id: "renamed", tab_id: "first", label: label("kernel", "l1/1") },
      { workspace_id: "renamed", tab_id: "second", label: label("kernel", "l1/2") },
      { workspace_id: "duplicate", tab_id: "third", label: label("kernel", "l2") },
    ];
    const f = fixture(structuredClone(tabs));
    await f.run([]);
    expect(f.tabs).toEqual(tabs);
    expect(f.focus).toHaveBeenCalledExactlyOnceWith("first");
    expect(f.post).not.toHaveBeenCalled();
    expect(f.list.mock.calls).toEqual([["renamed"], ["duplicate"]]);
    expect(logs[0]).toContain('Reused herdr workspace renamed for view "kernel"');
    expect(logs[0]).not.toMatch(/Prepared|No tiles opened/);
    expect(process.exitCode).toBeUndefined();
  });

  it("reopens the first page even when the dashboard or advisor is listed first", async () => {
    const tabs = [
      { workspace_id: "kernel", tab_id: "advisor", label: label("kernel", "l1/3") },
      { workspace_id: "kernel", tab_id: "dashboard", label: label("kernel", "l1/2") },
      { workspace_id: "kernel", tab_id: "operator", label: label("kernel", "l1/1") },
    ];
    const f = fixture(structuredClone(tabs));
    f.composed.opened = [f.composed.opened[2]!, f.composed.opened[0]!, f.composed.opened[1]!];
    f.composed.pages = f.composed.opened.map(pane => [pane]);
    await f.run();
    expect(f.focus).toHaveBeenCalledExactlyOnceWith("operator");
    expect(f.tabs).toEqual(tabs);
    expect(f.post).not.toHaveBeenCalled();
    expect(JSON.parse(logs[0]!)).toMatchObject({ ok: true, reusedWorkspace: { tabId: "operator" } });
  });

  it.each(["kernel-other", "kernel#other", "rig:kernel"])("does not reuse the different view %s", async other => {
    const f = fixture([{ workspace_id: "same-human-name", tab_id: "unrelated", label: label(other) }]);
    await f.run();
    expect(f.focus).not.toHaveBeenCalled();
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logs[0]!)).toMatchObject({ ok: true, opened: ["tui", "advisor", "operator"] });
  });

  it("does not treat a label without the layout delimiter as a view marker", async () => {
    const f = fixture([{ workspace_id: "unrelated", tab_id: "plain", label: "openrig:kernelx" }]);
    await f.run();
    expect(f.focus).not.toHaveBeenCalled();
    expect(f.post).toHaveBeenCalledTimes(1);
  });

  it("uses the complete resolved view id even when it contains a delimiter", async () => {
    const f = fixture([{ workspace_id: "saved", tab_id: "exact", label: label("kernel#other") }], "kernel#other");
    await f.run();
    expect(f.focus).toHaveBeenCalledExactlyOnceWith("exact");
    expect(f.post).not.toHaveBeenCalled();
  });

  it.each(["malformed", "lost", "wrong shape"])("creates a first space with a note after %s workspace inventory", async kind => {
    const f = fixture();
    f.workspaces.mockImplementation(async () => {
      if (kind === "lost") throw new Error("reply lost");
      return kind === "malformed" ? "{" : JSON.stringify({ result: {} });
    });
    await f.run();
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.focus).not.toHaveBeenCalled();
    expect(JSON.parse(logs[0]!)).toMatchObject({ ok: true, notes: expect.arrayContaining([expect.stringContaining("Could not check existing Herdr workspaces")]) });
    expect(process.exitCode).toBeUndefined();
  });

  it.each(["malformed", "lost", "wrong shape"])("creates with a note after %s scoped tab inventory, preserving existing spaces", async kind => {
    const initial = [{ workspace_id: "existing", tab_id: "first", label: label() }];
    const f = fixture(structuredClone(initial));
    f.list.mockImplementation(async () => {
      if (kind === "lost") throw new Error("reply lost");
      return kind === "malformed" ? "{" : JSON.stringify({ result: { tabs: [{ tab_id: "bad" }] } });
    });
    await f.run();
    expect(f.list).toHaveBeenCalledExactlyOnceWith("existing");
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.focus).not.toHaveBeenCalled();
    expect(f.tabs[0]).toEqual(initial[0]);
    expect(JSON.parse(logs[0]!)).toMatchObject({ ok: true, notes: expect.arrayContaining([expect.stringContaining("Could not check existing Herdr workspaces")]) });
  });

  it.each(["openrig:kernel#l1", "openrig:kernel#fedcba9876543210#l1/1"])("creates the current plan and names the retained stale workspace for %s", async oldLabel => {
    const old = { workspace_id: "old-space", tab_id: "old-tab", label: oldLabel };
    const f = fixture([old]);
    await f.run();
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.focus).not.toHaveBeenCalled();
    expect(f.tabs[0]).toEqual(old);
    expect(JSON.parse(logs[0]!)).toMatchObject({ ok: true, notes: expect.arrayContaining([expect.stringContaining("herdr workspace close 'old-space'")]) });
  });

  it("retains the current preview's absent and degraded members when reusing a partial view", async () => {
    const f = fixture([{ workspace_id: "partial", tab_id: "first", label: label() }]);
    f.composed.opened = f.composed.opened.slice(0, 1);
    f.composed.pages = [f.composed.opened];
    f.composed.absent.push({ seat: "operator", host: null, reason: "not running" });
    f.composed.degraded.push({ seat: "advisor", host: "remote", reason: "no SSH route" });
    await f.run();
    expect(f.focus).toHaveBeenCalledExactlyOnceWith("first");
    expect(f.post).not.toHaveBeenCalled();
    expect(JSON.parse(logs[0]!)).toMatchObject({ ok: true, opened: [], pages: 0, absent: f.composed.absent, degraded: f.composed.degraded });
  });

  it.each(["lost", "different tab"])("does not create a replacement or retry focus after a %s focus reply", async kind => {
    const f = fixture([{ workspace_id: "existing", tab_id: "first", label: label() }]);
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
