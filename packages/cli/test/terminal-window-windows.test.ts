import { describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "../src/client.js";
import { openTerminalWindow, type WindowDeps } from "../src/terminal-window.js";
// Exact literal quoting used by daemon domain/terminal/view-composer.ts.
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

function fixture() {
  const panes = [
    { seat: "local", label: "中文; unsafe-title", paneCommand: `${shellQuote("C:\\Program Files\\psmux\\tmux.exe")} attach -r -t ${shellQuote("seat'one")}` },
    { seat: "remote", label: "remote", paneCommand: `ssh ${shellQuote("user@host")} ${shellQuote("tmux attach -t 'remote'")}` },
  ];
  const get = vi.fn(async () => ({ status: 200, data: { planId: "current", composed: { id: "saved", opened: panes, pages: [[panes[0]], [panes[1]]], absent: [], degraded: [] }, status: {} } }));
  const launch = vi.fn(async () => {});
  const deps: WindowDeps = {
    platform: "win32", env: {}, exists: () => true,
    exec: vi.fn(async (file) => file === "where.exe" ? "C:\\Users\\user\\wt.exe\r\n" : "1\r\n"),
    launch, sleep: async () => {}, id: () => "owned", herdrConfig: () => { throw new Error("No Herdr config should be written"); },
  };
  const client = { baseUrl: "http://127.0.0.1:7433", get } as unknown as DaemonClient;
  return { panes, get, launch, deps, client };
}
describe("Windows desktop terminal view", () => {
  it("opens the composed pages in a new Windows Terminal without a Unix shell or source mutations", async () => {
    const f = fixture();
    const result = await openTerminalWindow(f.client, "saved:中文", undefined, f.deps, "current");
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ ok: true, provider: "tmux", pages: 2, opened: ["local", "remote"], window: { app: "Windows Terminal" } });
    expect(f.launch).toHaveBeenCalledOnce();
    const [binary, args] = f.launch.mock.calls[0]! as unknown as [string, string[]];
    expect(binary).toBe("C:\\Users\\user\\wt.exe");
    expect(args.slice(0, 2)).toEqual(["--window", "new"]);
    expect(args.filter(arg => arg === "new-tab")).toHaveLength(2);
    expect(args).toContain("中文  unsafe-title");
    const scripts = args.flatMap((arg, i) => arg === "-EncodedCommand" ? [Buffer.from(args[i + 1]!, "base64").toString("utf16le")] : []);
    expect(scripts[0]).toContain("$openrigStart.FileName = 'C:\\Program Files\\psmux\\tmux.exe'");
    expect(scripts[0]).toContain('$openrigStart.Arguments = \'"attach" "-r" "-t" "seat\'\'one"\'');
    expect(scripts[1]).toContain("$openrigStart.FileName = 'ssh'");
    expect(f.deps.exec).not.toHaveBeenCalledWith("/bin/sh", expect.anything());
    expect(result.notes?.join(" ")).toContain("not visual confirmation");
  });
  it.each([{ CI: "true" }, { SSH_TTY: "remote" }])("opens nothing in a background/remote caller %j", async (env) => {
    const f = fixture(); f.deps.env = env;
    expect(await openTerminalWindow(f.client, "saved", undefined, f.deps)).toMatchObject({ ok: false, windowAttempted: false });
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
  });
  it("rejects a stale expected plan before launching", async () => {
    const f = fixture();
    expect(await openTerminalWindow(f.client, "saved", "tmux", f.deps, "old")).toMatchObject({ ok: false, windowAttempted: false });
    expect(f.launch).not.toHaveBeenCalled();
  });
  it("does not evaluate expanded pane commands", async () => {
    const f = fixture(); f.panes[0]!.paneCommand = "$(whoami)";
    expect(await openTerminalWindow(f.client, "saved", "tmux", f.deps)).toMatchObject({ ok: false, windowAttempted: false });
    expect(f.launch).not.toHaveBeenCalled();
  });
  it("does not retry a launch whose outcome is unknown", async () => {
    const f = fixture(); f.launch.mockRejectedValue(new Error("uncertain"));
    expect(await openTerminalWindow(f.client, "saved", "tmux", f.deps)).toMatchObject({ ok: false, windowAttempted: true });
    expect(f.launch).toHaveBeenCalledOnce();
  });
});
