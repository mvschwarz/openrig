import { describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "../src/client.js";
import { openTerminalWindow, type WindowDeps } from "../src/terminal-window.js";

function fixture(options: { herdr?: boolean; ghostty?: string; refusal?: number; empty?: boolean; alive?: boolean } = {}) {
  const panes = ["tui", "advisor", "operator"].map(seat => ({ seat, label: seat, paneCommand: `tmux attach-session -t '=fixture-${seat}'` }));
  const composed = { id: "kernel", opened: options.empty ? [] : panes, pages: options.empty ? [] : [panes], columns: 3, absent: [], degraded: [] };
  const preview = { planId: "bound-plan", composed, status: { launch: { socketPath: "/daemon home/herdr.sock", session: "daemon-session" } } };
  const get = vi.fn(async (url: string) => ({ status: 200, data: url.includes("preview") ? preview : { providers: [{ liveness: { alive: options.alive !== false } }] } }));
  const post = vi.fn(async () => options.refusal ? { status: options.refusal, data: { error: "view changed" } } : { status: 200, data: { provider: "herdr", ok: true, opened: panes.map(p => p.seat), absent: [], degraded: [], pages: 1 } });
  const client = { baseUrl: "http://localhost:7433", get, post } as unknown as DaemonClient;
  let pane = 0;
  const exec = vi.fn(async (file: string, args: string[]) => {
    if (file === "/usr/bin/env" && args.at(-1) === "list") return JSON.stringify({ result: { workspaces: [] } });
    if (args.includes("--version")) {
      if (options.herdr === false) throw new Error("not installed");
      return "herdr 0.9.3";
    }
    if (file === "/usr/libexec/PlistBuddy") return options.ghostty ?? "1.2.0";
    if (file === "/usr/bin/osascript") return options.ghostty === "1.3.0" ? "tab" : "window";
    if (file === "/bin/sh") return args[1] === "command -v herdr" ? "/fixture/bin/herdr" : "/fixture/bin/tmux";
    if (args.at(-1) === "default-size") return "120x40";
    if (args[0] === "show-options" && args.at(-1) === "window-size") return "latest";
    if (args.includes("#{pane_id}")) return `%${++pane}`;
    return "";
  });
  const deps: WindowDeps = { platform: "darwin", env: { HOME: "/fixture", HERDR_SESSION: "wrong-session", HERDR_SOCKET_PATH: "/wrong.sock" }, exists: () => !!options.ghostty, exec, launch: vi.fn(async () => {}), sleep: vi.fn(async () => {}), id: () => "owned-test" };
  return { client, deps, get, post, exec, preview };
}

describe("desktop terminal view", () => {
  it.each([true, false])("rejects a changed preview before opening a window (Herdr installed: %s)", async herdr => {
    const f = fixture({ herdr });
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps, "prior-plan");
    expect(result).toMatchObject({ ok: false, opened: [], error: expect.stringContaining("changed since preview") });
    expect(f.exec.mock.calls.some(([file, args]) => file === "/usr/bin/osascript" || args.includes("new-session"))).toBe(false);
    expect(f.post).not.toHaveBeenCalled();
  });

  it("opens the previewed tmux layout when the expected plan still matches", async () => {
    const f = fixture({ herdr: false });
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps, "bound-plan");
    expect(result).toMatchObject({ ok: true, provider: "tmux", opened: ["tui", "advisor", "operator"] });
  });

  it("opens a new Ghostty tab and applies the same daemon plan and Herdr endpoint", async () => {
    const f = fixture({ ghostty: "1.3.0" });
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result).toMatchObject({ ok: true, opened: ["tui", "advisor", "operator"], window: { app: "Ghostty", surface: "tab" } });
    const launch = f.exec.mock.calls.find(([file]) => file === "/usr/bin/osascript")!;
    expect(launch[1][1]).toContain("new tab in front window");
    expect(launch[1][1]).toContain("new window with configuration");
    expect(launch[1][1]).not.toMatch(/set (bounds|number of columns|number of rows)/);
    expect(result.notes).toContain("Ghostty's macOS scripting interface does not expose window size. Enlarge the new view manually if its columns are cramped; existing window settings were kept.");
    expect(launch[1][2]).toContain("HERDR_SOCKET_PATH='/daemon home/herdr.sock'");
    expect(launch[1][2]).not.toContain("--session");
    expect(launch[1][2]).toContain("-u HERDR_SESSION");
    expect(launch[1][2]).not.toContain("wrong-session");
    expect(f.post).toHaveBeenCalledExactlyOnceWith("/api/terminal/open", { view: "saved:kernel", provider: "herdr", expectedPlan: "bound-plan" }, { timeoutMs: 45_000 });
  });

  it("uses a new system Terminal window without requiring an existing terminal", async () => {
    const f = fixture();
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result.window).toEqual({ app: "Terminal", surface: "window" });
    const script = f.exec.mock.calls.find(([file]) => file === "/usr/bin/osascript")![1][1];
    expect(script).toContain('tell application "Terminal"');
    expect(script).toContain("do script (item 1 of argv)");
    expect(script).not.toContain("in front window");
    expect(script).not.toMatch(/number of (columns|rows)|bounds|position|size|tabs of|repeat with/);
    expect(script).not.toMatch(/settings set|default settings|System Events/);
    expect(result.notes).toContain("Terminal opened with its own window sizing. Resize or move the new view manually if needed; OpenRig did not request a size or position change.");
  });

  it("keeps the Terminal view and reports manual sizing without reopening", async () => {
    const f = fixture();
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result).toMatchObject({ ok: true, window: { app: "Terminal", surface: "window" } });
    expect(result.notes?.join(" ")).toContain("Resize or move the new view manually");
    expect(result.notes?.join(" ")).not.toContain("tab reports 140");
    expect(f.exec.mock.calls.filter(([file]) => file === "/usr/bin/osascript")).toHaveLength(1);
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.deps.launch).not.toHaveBeenCalled();
  });

  it("creates only a new tmux viewer with the composed three-column ordering", async () => {
    const f = fixture({ herdr: false });
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result).toMatchObject({ ok: true, provider: "tmux", opened: ["tui", "advisor", "operator"] });
    const tmux = f.exec.mock.calls.filter(([file]) => file === "/fixture/bin/tmux").map(([,args]) => args);
    expect(tmux.filter(args => args[0] === "new-session")).toHaveLength(1);
    expect(tmux.filter(args => args[0] === "split-window")).toHaveLength(2);
    expect(tmux.filter(args => args[0] === "select-pane").map(args => args.at(-1))).toEqual(["tui", "advisor", "operator"]);
    expect(tmux).toContainEqual(["select-layout", "-t", "openrig-view-owned-test:view-1", "even-horizontal"]);
    expect(tmux.flat().join(" ")).not.toMatch(/kill|respawn|send-keys/);
    expect(f.post).not.toHaveBeenCalled();
  });

  it("names the setup next step when tmux lookup exits nonzero", async () => {
    const f = fixture({ herdr: false });
    const original = f.deps.exec;
    f.deps.exec = vi.fn(async (file, args) => {
      if (file === "/bin/sh" && args[1] === "command -v tmux") throw new Error("Command failed: /bin/sh -c command -v tmux");
      return original(file, args);
    });
    expect(await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps)).toMatchObject({ ok: false, error: expect.stringContaining("tmux is unavailable; run rig setup first.") });
    expect(f.exec.mock.calls.some(([file]) => file === "/usr/bin/osascript" || file === "/fixture/bin/tmux")).toBe(false);
    expect(f.post).not.toHaveBeenCalled();
  });

  it.each(["remote", "headless", "empty"])("%s makes no window or tmux mutations", async reason => {
    const f = fixture({ empty: reason === "empty" });
    if (reason === "remote") Object.assign(f.client, { baseUrl: "http://192.0.2.2:7433" });
    if (reason === "headless") Object.assign(f.deps, { platform: "linux", env: {} });
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ code: "terminal_window_failed", windowAttempted: false });
    expect(f.exec.mock.calls.some(([file]) => file === "/usr/bin/osascript" || file === "/fixture/bin/tmux")).toBe(false);
    expect(f.post).not.toHaveBeenCalled();
  });

  it("returns Automation denial without replaying in another terminal or applying a layout", async () => {
    const f = fixture();
    const original = f.deps.exec;
    f.deps.exec = vi.fn(async (file, args) => {
      if (file === "/usr/bin/osascript") throw new Error("Automation denied");
      return original(file, args);
    });
    expect(await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps)).toMatchObject({ ok: false, windowAttempted: true, error: expect.stringContaining("Terminal window status is unknown. Automation denied"), opened: [] });
    expect(vi.mocked(f.deps.exec).mock.calls.filter(([file]) => file === "/usr/bin/osascript")).toHaveLength(1);
    expect(f.post).not.toHaveBeenCalled();
  });

  it.each([409, 503])("preserves HTTP %s refusal after a window opens", async refusal => {
    const f = fixture({ refusal });
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("view changed"), opened: [], window: { app: "Terminal" } });
    expect(f.post).toHaveBeenCalledTimes(1);
  });

  it("does not apply a layout when the launched socket never becomes ready", async () => {
    const f = fixture({ alive: false });
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Inspect the new terminal before retrying");
    expect(f.deps.sleep).toHaveBeenCalledTimes(20);
    expect(f.post).not.toHaveBeenCalled();
  });

  it("explicit tmux choice bypasses Herdr and supports a Linux desktop launcher", async () => {
    const f = fixture();
    Object.assign(f.deps, { platform: "linux", env: { DISPLAY: ":fixture" } });
    const result = await openTerminalWindow(f.client, "saved:kernel", "tmux", f.deps);
    expect(result).toMatchObject({ ok: true, provider: "tmux", window: { app: "ghostty", surface: "window-requested" } });
    expect(f.exec.mock.calls.some(([,args]) => args.includes("--version"))).toBe(false);
    expect(f.deps.launch).toHaveBeenCalledTimes(1);
  });

  it.each<[string, string[]]>([
    ["ghostty", ["--window-width=140", "--window-height=40", "-e"]],
    ["gnome-terminal", ["--window", "--geometry=140x40", "--"]],
    ["konsole", ["-p", "TerminalColumns=140", "-p", "TerminalRows=40", "-e"]],
    ["xterm", ["-geometry", "140x40", "-e"]],
    ["x-terminal-emulator", ["-e"]],
  ])("uses %s per-launch sizing without changing the command or selection order", async (app, prefix) => {
    const f = fixture();
    Object.assign(f.deps, { platform: "linux", env: { DISPLAY: ":fixture" } });
    const original = f.deps.exec;
    f.deps.exec = vi.fn(async (file, args) => {
      if (file === "/bin/sh" && args[1]?.startsWith("command -v ") && args[1] !== "command -v herdr") {
        if (args[1] === `command -v ${app}` || (app === "x-terminal-emulator" && args[1] === "command -v xterm")) return `/bin/${app}`;
        throw new Error("absent");
      }
      return original(file, args);
    });
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    const calls = vi.mocked(f.deps.launch).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(app);
    expect(calls[0]![1].slice(0, -1)).toEqual([...prefix, "/bin/sh", "-c"]);
    expect(calls[0]![1].at(-1)).toBe("env -u TMUX -u HERDR_SESSION -u HERDR_SOCKET_PATH HERDR_SOCKET_PATH='/daemon home/herdr.sock' '/fixture/bin/herdr'");
    expect(result).toMatchObject({ ok: true, window: { app, surface: "window-requested" } });
    expect(result.notes?.join(" ")).toContain(app === "x-terminal-emulator" ? "no portable size option" : "Requested 140 columns by 40 rows");
  });
});
