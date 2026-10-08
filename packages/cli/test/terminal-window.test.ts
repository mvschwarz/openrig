import { describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "../src/client.js";
import { openTerminalWindow, type WindowDeps } from "../src/terminal-window.js";
import { shellQuote } from "../src/cross-host-executor.js";

function fixture(options: { herdr?: boolean; ghostty?: string; refusal?: number; empty?: boolean; alive?: boolean } = {}) {
  const panes = ["tui", "advisor", "operator"].map(seat => ({ seat, label: seat, paneCommand: `tmux attach-session -t '=fixture-${seat}'` }));
  const composed = { id: "kernel", opened: options.empty ? [] : panes, pages: options.empty ? [] : [panes], columns: 3, absent: [], degraded: [] };
  const preview = { planId: "bound-plan", composed, status: { launch: { socketPath: "/daemon home/herdr.sock", session: "daemon-session" } } };
  const get = vi.fn(async (url: string): Promise<{ status: number; data: unknown }> => ({ status: 200, data: url.includes("preview") ? preview : { providers: [{ liveness: { alive: options.alive !== false } }] } }));
  const post = vi.fn(async (): Promise<{ status: number; data: unknown }> => options.refusal ? { status: options.refusal, data: { error: "view changed" } } : { status: 200, data: { provider: "herdr", ok: true, opened: panes.map(p => p.seat), absent: [], degraded: [], pages: 1 } });
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
  const deps: WindowDeps = { platform: "darwin", env: { HOME: "/fixture", TERM_PROGRAM: options.ghostty ? "ghostty" : "Apple_Terminal", HERDR_SESSION: "wrong-session", HERDR_SOCKET_PATH: "/wrong.sock" }, exists: () => !!options.ghostty, exec, launch: vi.fn(async () => {}), sleep: vi.fn(async () => {}), herdrConfig: vi.fn(() => "/fixture/private herdr.toml"), id: () => "owned-test" };
  return { client, deps, get, post, exec, preview };
}

describe("desktop terminal view", () => {
  it.each([
    { TERM_PROGRAM: "Apple_Terminal" },
    { TERM_PROGRAM: "tmux", __CFBundleIdentifier: "com.apple.Terminal" },
    { __CFBundleIdentifier: "com.apple.Terminal" },
  ])("keeps a Terminal caller in Terminal even with Ghostty installed: %j", async env => {
    const f = fixture({ ghostty: "1.3.0" });
    f.deps.env = env;
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result).toMatchObject({ ok: true, window: { app: "Terminal" } });
    const scripts = f.exec.mock.calls.filter(([file]) => file === "/usr/bin/osascript");
    expect(scripts).toHaveLength(1);
    expect(scripts[0]![1][1]).toContain('tell application "Terminal"');
    expect(f.exec.mock.calls.some(([file]) => file === "/usr/bin/open" || file === "/usr/libexec/PlistBuddy")).toBe(false);
  });

  it.each([
    { TERM_PROGRAM: "ghostty" },
    { TERM_PROGRAM: "tmux", __CFBundleIdentifier: "com.mitchellh.ghostty" },
  ])("uses Ghostty only for a Ghostty host: %j", async env => {
    const f = fixture({ ghostty: "1.3.0" });
    f.deps.env = env;
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result).toMatchObject({ ok: true, window: { app: "Ghostty" } });
    expect(f.exec.mock.calls.some(([file]) => file === "/usr/bin/open")).toBe(false);
  });

  it.each([
    {},
    { TERM_PROGRAM: "tmux" },
    { TERM_PROGRAM: "vscode", __CFBundleIdentifier: "com.apple.Terminal" },
    { TERM_PROGRAM: "iTerm.app" },
    { TERM_PROGRAM: "Apple_Terminal", CI: "true" },
    { TERM_PROGRAM: "Apple_Terminal", SSH_CONNECTION: "192.0.2.1 1 192.0.2.2 2" },
  ])("returns one endpoint-bound command without opening anything for %j", async env => {
    const f = fixture({ ghostty: "1.3.0" });
    f.deps.env = env;
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result).toMatchObject({ ok: false, windowAttempted: false, opened: [], code: "terminal_window_failed" });
    expect(result.error).toContain("No terminal window was opened.");
    expect(result.error).toContain("run: env -u TMUX -u HERDR_SESSION -u HERDR_SOCKET_PATH HERDR_SOCKET_PATH='/daemon home/herdr.sock' HERDR_CONFIG_PATH='/fixture/private herdr.toml' '/fixture/bin/herdr'");
    expect(f.deps.herdrConfig).toHaveBeenCalledExactlyOnceWith("/daemon home/herdr.sock");
    expect(result.notes).toEqual([
      "After the person starts Herdr, have the agent place this view by running: rig terminal open 'saved:kernel' --provider herdr",
      "Your Herdr config is kept when present; otherwise the sidebar starts open at 160 columns and collapsed below.",
    ]);
    expect(result.error).not.toContain("\n");
    expect(f.exec.mock.calls.some(([file]) => file === "/usr/bin/osascript" || file === "/usr/bin/open")).toBe(false);
    expect(f.deps.launch).not.toHaveBeenCalled();
    expect(f.deps.sleep).not.toHaveBeenCalled();
    expect(f.post).not.toHaveBeenCalled();
  });

  it.each([
    new Error("EACCES: cannot read Herdr config"),
    new SyntaxError("Invalid TOML"),
    new Error("EROFS: cannot write private Herdr config"),
  ])("keeps the ordinary manual command when preparation fails over SSH: %s", async error => {
    const f = fixture();
    f.deps.env = { SSH_TTY: "/dev/pts/1", HERDR_CONFIG_PATH: "/fixture/original config.toml" };
    const originalEnv = { ...f.deps.env };
    f.deps.herdrConfig = vi.fn(() => { throw error; });
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result).toMatchObject({ ok: false, windowAttempted: false, opened: [], code: "terminal_window_failed" });
    expect(result.error).toContain("No terminal window was opened. This is an SSH session");
    expect(result.error).toContain("run: env -u TMUX -u HERDR_SESSION -u HERDR_SOCKET_PATH HERDR_SOCKET_PATH='/daemon home/herdr.sock' '/fixture/bin/herdr'");
    expect(result.notes).toEqual([
      "After the person starts Herdr, have the agent place this view by running: rig terminal open 'saved:kernel' --provider herdr",
      `Could not prepare OpenRig's private Herdr settings (${error.message}); Herdr starts with its usual sidebar.`,
    ]);
    expect(f.deps.env).toEqual(originalEnv);
    expect(f.deps.herdrConfig).toHaveBeenCalledExactlyOnceWith("/daemon home/herdr.sock");
    expect(f.exec.mock.calls.some(([file]) => file === "/usr/bin/osascript" || file === "/usr/bin/open")).toBe(false);
    expect(f.deps.launch).not.toHaveBeenCalled();
    expect(f.deps.sleep).not.toHaveBeenCalled();
    expect(f.post).not.toHaveBeenCalled();
  });

  it.each([
    { platform: "darwin", env: { TERM_PROGRAM: "vscode" }, reason: "No local macOS desktop session", where: "new terminal window" },
    { platform: "darwin", env: { TERM_PROGRAM: "Apple_Terminal", CI: "true" }, reason: "CI run", where: "new terminal window" },
    { platform: "darwin", env: { TERM_PROGRAM: "Apple_Terminal", SSH_TTY: "/dev/ttys1" }, reason: "SSH session", where: "new SSH session" },
    { platform: "linux", env: {}, reason: "No desktop display", where: "new SSH session" },
  ] as const)("explains $reason and the manual follow-up", async ({ platform, env, reason, where }) => {
    const f = fixture();
    Object.assign(f.deps, { platform, env });
    const result = await openTerminalWindow(f.client, "saved:team's view", undefined, f.deps);
    expect(result).toMatchObject({ ok: false, windowAttempted: false });
    expect(result.error).toContain(reason);
    expect(result.error).toContain(where);
    expect(result.error).not.toContain("daemon's desktop");
    expect(result.notes?.[0]).toContain("rig terminal open 'saved:team'\\''s view' --provider herdr");
    expect(f.post).not.toHaveBeenCalled();
    expect(f.deps.launch).not.toHaveBeenCalled();
    expect(f.deps.sleep).not.toHaveBeenCalled();
  });

  it.each([
    { app: "gnome-terminal", env: { GNOME_TERMINAL_SERVICE: ":1.42" } },
    { app: "konsole", env: { KONSOLE_VERSION: "250801" } },
    { app: "xterm", env: { XTERM_VERSION: "XTerm(402)" } },
  ])("opens $app from its own host signal with or without tmux", async ({ app, env }) => {
    for (const program of [undefined, "tmux"]) {
      const f = fixture();
      Object.assign(f.deps, { platform: "linux", env: { DISPLAY: ":fixture", TERM_PROGRAM: program, ...env } });
      const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
      expect(result).toMatchObject({ ok: true, window: { app } });
      expect(f.deps.launch).toHaveBeenCalledExactlyOnceWith(app, expect.any(Array));
    }
  });

  it.each([
    { VTE_VERSION: "8200" },
    { TERM_PROGRAM: "vscode", GNOME_TERMINAL_SERVICE: ":1.42" },
  ])("does not guess a Linux host from shared or inherited signals: %j", async env => {
    const f = fixture();
    Object.assign(f.deps, { platform: "linux", env: { DISPLAY: ":fixture", ...env } });
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result).toMatchObject({ ok: false, windowAttempted: false });
    expect(f.deps.launch).not.toHaveBeenCalled();
  });

  it.each(["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"])("refuses Linux %s even with a forwarded display", async signal => {
    for (const display of [{}, { DISPLAY: ":forwarded" }, { WAYLAND_DISPLAY: "wayland-1" }]) {
      const f = fixture();
      Object.assign(f.deps, { platform: "linux", env: { TERM_PROGRAM: "ghostty", [signal]: "present", ...display } });
      const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
      expect(result).toMatchObject({ ok: false, windowAttempted: false, error: expect.stringContaining("SSH session") });
      expect(result.error).toContain("new SSH session to the daemon's host");
      expect(f.deps.launch).not.toHaveBeenCalled();
      expect(f.deps.sleep).not.toHaveBeenCalled();
      expect(f.post).not.toHaveBeenCalled();
    }
  });

  it.each(["0", "false"])("does not mistake CI=%s for a CI run", async CI => {
    const f = fixture();
    f.deps.env.CI = CI;
    expect(await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps)).toMatchObject({ ok: true, window: { app: "Terminal" } });
    expect(f.exec.mock.calls.filter(([file]) => file === "/usr/bin/osascript")).toHaveLength(1);
  });

  it("still refuses a recognized Linux host without a display", async () => {
    const f = fixture();
    Object.assign(f.deps, { platform: "linux", env: { GNOME_TERMINAL_SERVICE: ":1.42" } });
    expect(await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps)).toMatchObject({ ok: false, windowAttempted: false, error: expect.stringContaining("No desktop display") });
    expect(f.deps.launch).not.toHaveBeenCalled();
  });

  it.each([false, true])("makes the remote first pane interactive (Herdr installed=%s, no endpoint)", async herdr => {
    const f = fixture({ herdr });
    f.deps.env = {};
    Object.assign(f.preview, { status: {} });
    f.preview.composed.opened[0]!.paneCommand = "ssh 'user@remote-host' 'tmux attach-session -t =operator'";
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result).toMatchObject({ ok: false, windowAttempted: false });
    expect(result.error).toContain("run: env -u TMUX ssh -t 'user@remote-host' 'tmux attach-session -t =operator'");
    expect(result.notes).toEqual([]);
    expect(f.deps.herdrConfig).not.toHaveBeenCalled();
    expect(f.post).not.toHaveBeenCalled();
    expect(f.deps.launch).not.toHaveBeenCalled();
    expect(f.exec.mock.calls.some(([file]) => file === "ssh" || file === "/usr/bin/osascript")).toBe(false);
  });

  it("returns the first composed attach command when no Herdr is available", async () => {
    const f = fixture({ herdr: false });
    f.deps.env = {};
    const result = await openTerminalWindow(f.client, "saved:kernel", "tmux", f.deps);
    expect(result).toMatchObject({ ok: false, windowAttempted: false, opened: [] });
    expect(result.error).toContain("run: env -u TMUX tmux attach-session -t '=fixture-tui'");
    expect(f.deps.herdrConfig).not.toHaveBeenCalled();
    expect(f.exec.mock.calls.some(([file]) => file === "/fixture/bin/tmux" || file === "/usr/bin/osascript")).toBe(false);
    expect(f.post).not.toHaveBeenCalled();
  });

  it.each([undefined, "1.2.0"])("never falls back from unscriptable Ghostty (%s) to Terminal", async ghostty => {
    const f = fixture({ ghostty });
    f.deps.env.TERM_PROGRAM = "ghostty";
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result).toMatchObject({ ok: false, windowAttempted: false });
    expect(f.exec.mock.calls.some(([file]) => file === "/usr/bin/osascript" || file === "/usr/bin/open")).toBe(false);
    expect(f.post).not.toHaveBeenCalled();
  });

  it("does not select an unrelated installed Linux terminal", async () => {
    const f = fixture();
    Object.assign(f.deps, { platform: "linux", env: { DISPLAY: ":fixture", TERM_PROGRAM: "vscode" } });
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result).toMatchObject({ ok: false, windowAttempted: false });
    expect(f.deps.launch).not.toHaveBeenCalled();
    expect(f.post).not.toHaveBeenCalled();
  });

  it.each([true, false])("rejects a changed preview before opening a window (Herdr installed: %s)", async herdr => {
    const f = fixture({ herdr });
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps, "prior-plan");
    expect(result).toMatchObject({ ok: false, opened: [], error: expect.stringContaining("changed since preview") });
    expect(f.exec.mock.calls.some(([file, args]) => file === "/usr/bin/osascript" || args.includes("new-session"))).toBe(false);
    expect(f.post).not.toHaveBeenCalled();
    expect(f.deps.herdrConfig).not.toHaveBeenCalled();
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
    expect(result.notes).toContain("Ghostty keeps the person's window size; layout uses the hosting terminal's measured width when available.");
    expect(launch[1][2]).toContain("HERDR_SOCKET_PATH='/daemon home/herdr.sock'");
    expect(launch[1][2]).toContain("HERDR_CONFIG_PATH='/fixture/private herdr.toml'");
    expect(f.deps.herdrConfig).toHaveBeenNthCalledWith(1, "/daemon home/herdr.sock");
    expect(f.deps.herdrConfig).toHaveBeenNthCalledWith(2, "/daemon home/herdr.sock", 160);
    expect(launch[1][2]).not.toContain("--session");
    expect(launch[1][2]).toContain("-u HERDR_SESSION");
    expect(launch[1][2]).not.toContain("wrong-session");
    expect(f.post).toHaveBeenCalledExactlyOnceWith("/api/terminal/open", { view: "saved:kernel", provider: "herdr", expectedPlan: "bound-plan" }, { timeoutMs: 45_000 });
  });

  it("uses a new Terminal window when called from Terminal", async () => {
    const f = fixture();
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result.window).toEqual({ app: "Terminal", surface: "window" });
    const script = f.exec.mock.calls.find(([file]) => file === "/usr/bin/osascript")![1][1];
    expect(script).toContain('tell application "Terminal"');
    expect(script).toContain("do script (item 1 of argv)");
    expect(script).not.toContain("in front window");
    expect(script).toContain("set personBounds to bounds of front window");
    expect(script).toContain("set bounds of viewWindow to personBounds");
    expect(script.indexOf("set personBounds")).toBeLessThan(script.indexOf('do script ""'));
    expect(script.indexOf("set bounds")).toBeLessThan(script.indexOf("do script (item 1 of argv) in viewTab"));
    expect(script).toContain("number of columns of viewTab");
    expect(script).not.toMatch(/set number of (columns|rows)|set position/);
    expect(script).not.toMatch(/settings set|default settings|System Events/);
    expect(result.notes).toContain("The new Terminal view copies the person's front-window bounds when available; existing window settings were kept.");
  });

  it("copies the existing Terminal bounds without reopening", async () => {
    const f = fixture();
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result).toMatchObject({ ok: true, window: { app: "Terminal", surface: "window" } });
    expect(result.notes?.join(" ")).toContain("copies the person's front-window bounds");
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

  it.each([
    new Error("EACCES: cannot read Herdr config"),
    new SyntaxError("Invalid TOML"),
    new Error("EROFS: cannot write private Herdr config"),
  ])("opens one window with the original configuration when preparation fails: %s", async error => {
    const f = fixture();
    f.deps.env["HERDR_CONFIG_PATH"] = "/fixture/original config.toml";
    const originalEnv = { ...f.deps.env };
    f.deps.herdrConfig = vi.fn(() => { throw error; });
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result).toMatchObject({
      ok: true, opened: ["tui", "advisor", "operator"], window: { app: "Terminal", surface: "window" },
    });
    const launches = f.exec.mock.calls.filter(([file]) => file === "/usr/bin/osascript");
    expect(launches).toHaveLength(1);
    expect(launches[0]![1][2]).toBe("env -u TMUX -u HERDR_SESSION -u HERDR_SOCKET_PATH HERDR_SOCKET_PATH='/daemon home/herdr.sock' '/fixture/bin/herdr'");
    expect(f.deps.env).toEqual(originalEnv);
    expect(f.deps.herdrConfig).toHaveBeenCalledExactlyOnceWith("/daemon home/herdr.sock");
    expect(f.post).toHaveBeenCalledExactlyOnceWith("/api/terminal/open", { view: "saved:kernel", provider: "herdr", expectedPlan: "bound-plan" }, { timeoutMs: 45_000 });
    expect(result.notes).toContain(`Could not prepare OpenRig's private Herdr settings (${error.message}); Herdr starts with its usual sidebar.`);
    expect(result.notes?.join(" ")).not.toContain("sidebar collapsed");
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
    Object.assign(f.deps, { platform: "linux", env: { DISPLAY: ":fixture", TERM_PROGRAM: "ghostty" } });
    const result = await openTerminalWindow(f.client, "saved:kernel", "tmux", f.deps);
    expect(result).toMatchObject({ ok: true, provider: "tmux", window: { app: "ghostty", surface: "window-requested" } });
    expect(f.exec.mock.calls.some(([,args]) => args.includes("--version"))).toBe(false);
    expect(f.deps.launch).toHaveBeenCalledTimes(1);
    expect(f.deps.herdrConfig).not.toHaveBeenCalled();
  });

  it.each<[string, string[]]>([
    ["ghostty", ["--window-width=140", "--window-height=40", "-e"]],
    ["gnome-terminal", ["--window", "--geometry=140x40", "--"]],
    ["konsole", ["-p", "TerminalColumns=140", "-p", "TerminalRows=40", "-e"]],
    ["xterm", ["-geometry", "140x40", "-e"]],
  ])("uses %s per-launch sizing for the hosting terminal without changing the command", async (app, prefix) => {
    const f = fixture();
    Object.assign(f.deps, { platform: "linux", env: { DISPLAY: ":fixture", TERM_PROGRAM: app } });
    const original = f.deps.exec;
    f.deps.exec = vi.fn(async (file, args) => {
      if (file === "/bin/sh" && args[1]?.startsWith("command -v ") && args[1] !== "command -v herdr") {
        if (args[1] === `command -v ${app}`) return `/bin/${app}`;
        throw new Error("absent");
      }
      return original(file, args);
    });
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    const calls = vi.mocked(f.deps.launch).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(app);
    expect(calls[0]![1].slice(0, -1)).toEqual([...prefix, "/bin/sh", "-c"]);
    expect(calls[0]![1].at(-1)).toBe("env -u TMUX -u HERDR_SESSION -u HERDR_SOCKET_PATH HERDR_SOCKET_PATH='/daemon home/herdr.sock' HERDR_CONFIG_PATH='/fixture/private herdr.toml' '/fixture/bin/herdr'");
    expect(result).toMatchObject({ ok: true, window: { app, surface: "window-requested" } });
    expect(result.notes?.join(" ")).toContain("Requested 140 columns by 40 rows");
  });
});

// Synthetic desktop results test the CLI/daemon width binding; native window geometry is a separate check.
describe("measured welcome layout", () => {
  function kernelFixture(herdr = true) {
    const f = fixture({ herdr });
    Object.assign(f.preview.composed, { kernelLayout: "dual-runtime" });
    f.get.mockImplementation(async url => {
      if (!url.includes("preview")) return { status: 200, data: { providers: [{ liveness: { alive: true } }] } };
      const columns = Number(new URL(url, "http://fixture").searchParams.get("viewportColumns"));
      const [dashboard, advisor, operator] = f.preview.composed.opened;
      const pages = columns >= 120 ? [[dashboard!, operator!], [advisor!]] : [[operator!], [dashboard!], [advisor!]];
      return { status: 200, data: { ...f.preview, planId: columns >= 120 ? "wide" : "narrow", composed: { ...f.preview.composed, pages, opened: pages.flat(), columns: columns >= 120 ? 2 : 1 } } };
    });
    return f;
  }

  it.each([119, 120, 159, 160, 174])("binds the Terminal-reported width %i to preview and open", async columns => {
    const f = kernelFixture();
    const original = f.deps.exec;
    f.deps.exec = vi.fn(async (file, args) => file === "/usr/bin/osascript" ? `window:${columns}` : original(file, args));
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result.ok).toBe(true);
    expect(f.get).toHaveBeenCalledWith(`/api/terminal/preview?view=saved%3Akernel&provider=herdr&viewportColumns=${columns}`);
    expect(f.post).toHaveBeenCalledExactlyOnceWith("/api/terminal/open", { view: "saved:kernel", provider: "herdr", viewportColumns: columns, expectedPlan: columns >= 120 ? "wide" : "narrow" }, { timeoutMs: 45_000 });
    expect(vi.mocked(f.deps.exec).mock.calls.filter(([file]) => file === "/usr/bin/osascript")).toHaveLength(1);
  });

  it("uses a Ghostty shell tool's hosting-terminal measurement without requiring a stdin TTY", async () => {
    const f = kernelFixture();
    f.deps.env = { TERM_PROGRAM: "ghostty" };
    f.deps.exists = () => true;
    f.deps.columns = async () => 120;
    const original = f.deps.exec;
    f.deps.exec = async (file, args) => file === "/usr/libexec/PlistBuddy" ? "1.3.1" : file === "/usr/bin/osascript" ? "tab" : original(file, args);
    expect((await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps)).ok).toBe(true);
    expect(f.post).toHaveBeenCalledWith("/api/terminal/open", expect.objectContaining({ viewportColumns: 120, expectedPlan: "wide" }), expect.anything());
  });

  it("leaves an unknown width narrow and says so", async () => {
    const f = kernelFixture();
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result.ok).toBe(true);
    expect(result.notes?.join(" ")).toContain("width could not be measured");
    expect(f.post).toHaveBeenCalledWith("/api/terminal/open", { view: "saved:kernel", provider: "herdr", expectedPlan: "narrow" }, expect.anything());
  });

  it("does not silently replace an explicit expected plan after measuring a different layout", async () => {
    const f = kernelFixture();
    const original = f.deps.exec;
    f.deps.exec = async (file, args) => file === "/usr/bin/osascript" ? "window:174" : original(file, args);
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps, "narrow");
    expect(result).toMatchObject({ ok: false, windowAttempted: true });
    expect(result.error).toContain("differs from the expected preview");
    expect(f.post).not.toHaveBeenCalled();
  });

  it("chooses generated sidebar settings in the new terminal, after its bounds are copied", async () => {
    const f = kernelFixture();
    f.deps.herdrConfig = (_socket, columns) => columns === 160 ? "/fixture/wide.toml" : "/fixture/narrow.toml";
    await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    const launch = f.exec.mock.calls.find(([file]) => file === "/usr/bin/osascript")!;
    // Terminal passes this line to the login shell, which need not understand POSIX conditionals.
    const command = `set -- $(stty size 2>/dev/null); if [ "${'${2:-0}'}" -ge 160 ]; then export HERDR_CONFIG_PATH='/fixture/wide.toml'; else export HERDR_CONFIG_PATH='/fixture/narrow.toml'; fi; exec env -u TMUX -u HERDR_SESSION -u HERDR_SOCKET_PATH HERDR_SOCKET_PATH='/daemon home/herdr.sock' '/fixture/bin/herdr'`;
    expect(launch[1][2]).toBe(`/bin/sh -c ${shellQuote(command)}`);
    expect(launch[1][1]!.indexOf("set bounds")).toBeLessThan(launch[1][1]!.indexOf("do script (item 1 of argv) in viewTab"));
  });
});


describe("welcome launcher for desktop apps and an existing Herdr client", () => {
  function desktop(env: NodeJS.ProcessEnv, ghostty?: string) {
    const f = fixture({ ghostty });
    f.deps.env = { HOME: "/fixture", ...env };
    const original = f.deps.exec;
    f.deps.exec = vi.fn(async (file, args, timeoutMs) => file === "/bin/launchctl" ? "Aqua\n" : file === "/usr/bin/osascript" ? "window" : original(file, args, timeoutMs));
    return f;
  }

  it.each([{}, { TERM_PROGRAM: "iTerm.app" }, { TERM_PROGRAM: "vscode" }])("opens Terminal from a desktop caller when Ghostty is absent: %j", async env => {
    const f = desktop(env);
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result).toMatchObject({ ok: true, window: { app: "Terminal", surface: "window" } });
    const launches = vi.mocked(f.deps.exec).mock.calls.filter(([file]) => file === "/usr/bin/osascript");
    expect(launches).toHaveLength(1);
    expect(launches[0]![2]).toBe(120_000);
    expect(launches[0]![1][1]).toContain('tell application "Terminal"');
    expect(launches[0]![1][1]).not.toContain("set personBounds to bounds of front window");
    expect(result.notes?.join(" ")).toContain("fine to click Allow");
    expect(result.notes?.join(" ")).toContain("own new-window size");
  });

  it.each([{}, { TERM_PROGRAM: "iTerm.app" }, { TERM_PROGRAM: "vscode" }])("prefers a new Ghostty window for a desktop caller: %j", async env => {
    const f = desktop(env, "1.3.0");
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result).toMatchObject({ ok: true, window: { app: "Ghostty" } });
    const launches = vi.mocked(f.deps.exec).mock.calls.filter(([file]) => file === "/usr/bin/osascript");
    expect(launches).toHaveLength(1);
    expect(launches[0]![1][1]).toContain("if false then");
    expect(launches[0]![1][1]).toContain("new window with configuration cfg");
    expect(result.notes?.join(" ")).toContain("control Ghostty");
    expect(f.post).toHaveBeenCalledTimes(1);
  });

  it("explains the Allow prompt before invoking the app, including on failure", async () => {
    const f = desktop({}, "1.3.0");
    const order: string[] = [];
    f.deps.notice = message => { expect(message).toContain("fine to click Allow"); order.push("notice"); };
    const original = f.deps.exec;
    f.deps.exec = async (file, args) => {
      if (file === "/usr/bin/osascript") { order.push("launch"); throw new Error("Automation denied"); }
      return original(file, args);
    };
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(order).toEqual(["notice", "launch"]);
    expect(result).toMatchObject({ ok: false, windowAttempted: true });
    expect(result.notes?.join(" ")).toContain("control Ghostty");
  });

  it.each(["1.2.0", "plist failure"])("uses Terminal before launch when a desktop caller cannot use Ghostty: %s", async version => {
    const f = desktop({ TERM_PROGRAM: "vscode" }, "1.2.0");
    const original = f.deps.exec;
    f.deps.exec = vi.fn(async (file, args) => {
      if (file === "/usr/libexec/PlistBuddy" && version === "plist failure") throw new Error("unreadable plist");
      return original(file, args);
    });
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result).toMatchObject({ ok: true, window: { app: "Terminal" } });
    expect(result.notes?.join(" ")).toContain("using Terminal for this desktop caller");
    const calls = vi.mocked(f.deps.exec).mock.calls.filter(([file]) => file === "/usr/bin/osascript");
    expect(calls).toHaveLength(1);
    expect(calls[0]![1][1]).toContain('tell application "Terminal"');
    expect(calls[0]![1][1]).not.toContain('tell application "Ghostty"');
  });

  it.each(["message", "stderr"])("gives Automation settings and a manual command after denial in %s without replay", async where => {
    const f = desktop({}, "1.3.0");
    const original = f.deps.exec;
    const denied = "Not authorized to send Apple events. (-1743)";
    f.deps.exec = vi.fn(async (file, args) => {
      if (file === "/usr/bin/osascript") throw where === "message" ? new Error(denied) : Object.assign(new Error("command failed"), { stderr: denied });
      return original(file, args);
    });
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result).toMatchObject({ ok: false, windowAttempted: true });
    expect(result.notes?.join(" ")).toContain("System Settings > Privacy & Security > Automation");
    expect(result.notes?.join(" ")).toContain("run: env -u TMUX -u HERDR_SESSION -u HERDR_SOCKET_PATH HERDR_SOCKET_PATH='/daemon home/herdr.sock' HERDR_CONFIG_PATH='/fixture/private herdr.toml' '/fixture/bin/herdr'");
    expect(result.notes?.join(" ")).toContain("rig terminal open 'saved:kernel' --provider herdr");
    expect(vi.mocked(f.deps.exec).mock.calls.filter(([file]) => file === "/usr/bin/osascript")).toHaveLength(1);
    expect(f.post).not.toHaveBeenCalled();
  });

  it("does not borrow a VS Code pane width for a new Ghostty window of unknown width", async () => {
    const f = desktop({ TERM_PROGRAM: "vscode" }, "1.3.0");
    f.deps.columns = async () => 200;
    Object.assign(f.preview.composed, { kernelLayout: "dual-runtime" });
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result.ok).toBe(true);
    expect(result.notes?.join(" ")).toContain("width could not be measured");
    expect(f.get).toHaveBeenCalledWith("/api/terminal/preview?view=saved%3Akernel&provider=herdr&viewportColumns=200");
    expect(f.get).toHaveBeenCalledWith("/api/terminal/preview?view=saved%3Akernel&provider=herdr");
    expect(f.post).toHaveBeenCalledWith("/api/terminal/open", { view: "saved:kernel", provider: "herdr", expectedPlan: "bound-plan" }, expect.anything());
  });

  it.each(["Background", "System", "", "error"])("keeps guidance-only behavior without a confirmed desktop: %s", async manager => {
    const f = desktop({}); const original = f.deps.exec;
    f.deps.exec = vi.fn(async (file, args) => {
      if (file === "/bin/launchctl") { if (manager === "error") throw new Error("probe failed"); return manager; }
      return original(file, args);
    });
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result).toMatchObject({ ok: false, windowAttempted: false });
    expect(result.error).toContain("No local macOS desktop session");
    expect(vi.mocked(f.deps.exec).mock.calls.some(([file]) => file === "/usr/bin/osascript")).toBe(false);
    expect(f.post).not.toHaveBeenCalled();
  });

  it.each(["denied", "timed out"])("never retries or changes apps after an uncertain desktop launch: %s", async message => {
    const f = desktop({}, "1.3.0"); const original = f.deps.exec;
    f.deps.exec = vi.fn(async (file, args) => { if (file === "/usr/bin/osascript") throw new Error(message); return original(file, args); });
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result).toMatchObject({ ok: false, windowAttempted: true });
    expect(result.error).toContain("status is unknown");
    expect(vi.mocked(f.deps.exec).mock.calls.filter(([file]) => file === "/usr/bin/osascript")).toHaveLength(1);
    expect(f.post).not.toHaveBeenCalled();
  });

  it.each([{}, { HERDR_SESSION: "personal" }, { HERDR_SOCKET_PATH: "/personal/herdr.sock" }])("opens a fresh space in the current Herdr endpoint without a window: %j", async extra => {
    const f = fixture();
    f.deps.env = { HOME: "/fixture", TERM_PROGRAM: "herdr", __CFBundleIdentifier: "com.apple.Terminal", ...extra };
    f.preview.status.launch.socketPath = extra.HERDR_SOCKET_PATH ?? (extra.HERDR_SESSION ? "/fixture/.config/herdr/sessions/personal/herdr.sock" : "/fixture/.config/herdr/herdr.sock");
    f.deps.columns = async () => 174;
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result).toMatchObject({ ok: true }); expect(result.window).toBeUndefined();
    expect(f.post).toHaveBeenCalledExactlyOnceWith("/api/terminal/open", { view: "saved:kernel", provider: "herdr", expectedPlan: "bound-plan", viewportColumns: 174 }, { timeoutMs: 45_000 });
    expect(f.deps.herdrConfig).not.toHaveBeenCalled(); expect(f.deps.launch).not.toHaveBeenCalled();
    expect(f.exec.mock.calls.some(([file]) => file === "/usr/bin/osascript" || file === "/bin/launchctl")).toBe(false);
    // Read-only Herdr calls only: the inventory before opening, then which space is focused.
    const list = ["/usr/bin/env", ["-u", "TMUX", "-u", "HERDR_SESSION", "-u", "HERDR_SOCKET_PATH", `HERDR_SOCKET_PATH=${f.preview.status.launch.socketPath}`, "/fixture/bin/herdr", "workspace", "list"]];
    expect(f.exec.mock.calls.filter(([file]) => file === "/usr/bin/env")).toEqual([list, list]);
    expect(result.notes?.at(-1)).toBe("Herdr did not confirm the view's space is focused; ask the person whether they see it.");
  });

  it("says the switchboard space is showing when the person's Herdr reports it focused", async () => {
    const f = fixture();
    f.deps.env = { HOME: "/fixture", TERM_PROGRAM: "herdr" };
    f.preview.status.launch.socketPath = "/fixture/.config/herdr/herdr.sock";
    (f.preview.composed as typeof f.preview.composed & { spaceLabel?: string }).spaceLabel = "switchboard";
    let lists = 0;
    f.exec.mockImplementation(async (file: string, args: string[]) => {
      if (file === "/usr/bin/env" && args.at(-1) === "list") return JSON.stringify({ result: { workspaces: ++lists > 1 ? [{ workspace_id: "w2", label: "switchboard", focused: true }] : [] } });
      if (args.includes("--version")) return "herdr 0.9.3";
      return file === "/bin/sh" ? "/fixture/bin/herdr" : "";
    });
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result).toMatchObject({ ok: true });
    expect(result.notes?.at(-1)).toBe("Herdr shows the switchboard space in the person's current session.");
  });

  it("does not place the current Herdr caller's view on a different daemon endpoint", async () => {
    const f = fixture(); f.deps.env.TERM_PROGRAM = "herdr";
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result).toMatchObject({ ok: false, windowAttempted: false });
    expect(result.error).toContain("endpoint differs"); expect(f.post).not.toHaveBeenCalled();
    expect(f.deps.herdrConfig).not.toHaveBeenCalled();
  });

  it("reports a current-Herdr daemon refusal without claiming that a space opened", async () => {
    const f = fixture({ refusal: 409 });
    f.deps.env.TERM_PROGRAM = "herdr";
    f.deps.env.HERDR_SOCKET_PATH = f.preview.status.launch.socketPath;
    // A structured daemon refusal still has the ordinary result shape.
    f.post.mockResolvedValue({ status: 409, data: { provider: "herdr", ok: false, error: "preview changed", opened: [], absent: [], degraded: [], pages: 0 } });
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("preview changed") });
    expect(result.notes?.join(" ")).not.toContain("Opened the view");
    expect(f.deps.launch).not.toHaveBeenCalled();
  });

  it.each([{ CI: "true" }, { SSH_CONNECTION: "remote" }, { SSH_CLIENT: "remote" }, { SSH_TTY: "/dev/ttys1" }])("keeps current-Herdr opens behind the CI/SSH boundary: %j", async extra => {
    const f = fixture(); f.deps.env = { HOME: "/fixture", TERM_PROGRAM: "herdr", ...extra };
    const result = await openTerminalWindow(f.client, "saved:kernel", undefined, f.deps);
    expect(result).toMatchObject({ ok: false, windowAttempted: false });
    expect(f.post).not.toHaveBeenCalled();
  });
});
