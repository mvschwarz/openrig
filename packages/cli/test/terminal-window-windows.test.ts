import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DaemonClient } from "../src/client.js";
import { defaultWindowDeps, openTerminalWindow, type WindowDeps } from "../src/terminal-window.js";
import { composeView } from "../../daemon/src/domain/terminal/view-composer.js";
import { windowsArguments } from "../../daemon/src/adapters/windows-argv.js";
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
    exec: vi.fn(async (file) => file.endsWith("\\where.exe") ? "C:\\Users\\user\\wt.exe\r\n" : "1\r\n"),
    launch, sleep: async () => {}, id: () => "owned", herdrConfig: () => { throw new Error("No Herdr config should be written"); },
  };
  const client = { baseUrl: "http://127.0.0.1:7433", get } as unknown as DaemonClient;
  return { panes, get, launch, deps, client };
}
describe("Windows desktop terminal view", () => {
  it.skipIf(process.platform !== "win32")("runs system discovery with an owned PATH containing no system tools", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openrig-window-tools-"));
    try {
      const witness = path.join(root, "wt.exe");
      writeFileSync(witness, "Owned lookup witness; never executed.");
      const real = defaultWindowDeps();
      for (const key of Object.keys(real.env)) if (key.toUpperCase() === "PATH") delete real.env[key];
      real.env.Path = root;
      const systemRoot = process.env.SystemRoot!;
      const f = fixture();
      f.deps.env = { systemroot: systemRoot, Path: root };
      f.deps.exec = vi.fn(async (file, args) => {
        const output = await real.exec(file, args, 10_000);
        if (file.endsWith("\\powershell.exe")) {
          expect(output.trim()).toMatch(/^\d+$/);
          return "1"; // Desktop eligibility is mocked; no window is opened.
        }
        return output;
      });
      expect(await openTerminalWindow(f.client, "saved", "tmux", f.deps)).toMatchObject({ ok: true });
      expect(f.launch).toHaveBeenCalledOnce();
      const [binary] = f.launch.mock.calls[0]! as unknown as [string, string[]];
      expect(realpathSync.native(binary)).toBe(realpathSync.native(witness));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("locates native system tools independently of PATH and uses the selected system root", async () => {
    const f = fixture();
    f.deps.env = { systemroot: "D:\\Windows", Path: "C:\\owned-tools" };
    expect(await openTerminalWindow(f.client, "saved", "tmux", f.deps)).toMatchObject({ ok: true });
    expect(f.deps.exec).toHaveBeenCalledWith("D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", expect.any(Array), 1000);
    expect(f.deps.exec).toHaveBeenCalledWith("D:\\Windows\\System32\\where.exe", ["wt.exe"]);
    const [, args] = f.launch.mock.calls[0]! as unknown as [string, string[]];
    expect(args).toContain("D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });
  it("keeps a sixteen-pane real composition within the native command-line limit", async () => {
    const f=fixture();
    const members=Array.from({length:16},(_,i)=>({seat:'seat'+i,label:'seat'+i,tmuxSession:'seat'+i+'@fixture',host:null,alive:true,readOnly:true}));
    const composed=composeView('saved',members,{localPlatform:'win32',localTmux:'C:\\Program Files\\psmux\\tmux.exe',localTmuxServer:['-L','owned'],resolveHost:()=>null,panesPerPage:16});
    f.get.mockResolvedValue({status:200,data:{planId:'current',composed,status:{}}});
    expect(await openTerminalWindow(f.client,'saved','tmux',f.deps)).toMatchObject({ok:true});
    const [binary,args]=f.launch.mock.calls[0]! as unknown as [string,string[]];
    expect(windowsArguments([binary,...args]).length).toBeLessThan(32767);
  });
  it("renders the actual daemon composition through the native tile executable", async () => {
    const f = fixture();
    const composed = composeView("saved", [{ seat:"owned", label:"owned", tmuxSession:"owned@fixture", host:null, alive:true, readOnly:true }], {
      localPlatform:"win32", localTmux:"C:\\Program Files\\psmux\\tmux.exe", localTmuxServer:["-L","owned namespace"], resolveHost:()=>null,
    });
    f.get.mockResolvedValue({ status:200, data:{ planId:"current", composed, status:{} } });
    expect(await openTerminalWindow(f.client,"saved","tmux",f.deps,"current")).toMatchObject({ok:true,provider:"tmux",opened:["owned"]});
    expect(composed.opened[0]!.attachArgv?.[0]).toMatch(/powershell\.exe$/i);
    const [,args]=f.launch.mock.calls[0]! as unknown as [string,string[]];
    const at=args.indexOf("-EncodedCommand");
    const launch=Buffer.from(args[at+1]!,"base64").toString("utf16le");
    expect(launch).toContain("windows-tile-attach.ps1"); expect(launch).not.toContain("FileName = '/bin/sh'");
  });
  it("keeps inherited Rex markers on the Windows Terminal route", async () => {
    const f = fixture(); f.deps.env = { TERM_PROGRAM: "rex", REX_SESSION: "inherited" };
    expect(await openTerminalWindow(f.client, "saved", undefined, f.deps)).toMatchObject({ ok: true, provider: "tmux" });
    expect(f.launch).toHaveBeenCalledOnce();
    expect((f.deps.exec as ReturnType<typeof vi.fn>).mock.calls.some(([file]) => file === "/bin/sh")).toBe(false);
  });
  it("refuses explicit Rex on Windows before any native or POSIX subprocess", async () => {
    const f = fixture();
    const result = await openTerminalWindow(f.client, "saved", "rex", f.deps);
    expect(result).toMatchObject({ ok: false, provider: "rex", windowAttempted: false });
    expect(result.error).toContain("Rex is unavailable on Windows");
    expect(f.deps.exec).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled();
  });
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
  it.each([{ CI: "true" }, { SSH_TTY: "remote" }, { ci: "true" }, { ssh_tty: "remote" }])("opens nothing in a background/remote caller %j", async (env) => {
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
