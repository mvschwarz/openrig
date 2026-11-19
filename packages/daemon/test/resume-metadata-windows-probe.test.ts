import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { ResumeMetadataRefresher } from "../src/domain/resume-metadata-refresher.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { verifyPaneIdleShell, verifyClaudePaneProcess } from "../src/domain/native-process-lineage.js";
import { resolveWindowsProviderCommand } from "../src/domain/windows-provider-command.js";

vi.mock("../src/domain/native-process-lineage.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/domain/native-process-lineage.js")>(),
  observeClaudePaneRuntime: vi.fn(async () => null),
  verifyPaneIdleShell: vi.fn(), verifyClaudePaneProcess: vi.fn(),
}));
vi.mock("../src/domain/windows-provider-command.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/domain/windows-provider-command.js")>(),
  resolveWindowsProviderCommand: vi.fn(),
}));

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); });
beforeEach(() => {
  vi.mocked(verifyPaneIdleShell).mockResolvedValue(true);
  vi.mocked(verifyClaudePaneProcess).mockResolvedValue({ panePid: 100, process: { pid: 200, ppid: 100, command: "fixture" }, fingerprint: "owned" });
  vi.mocked(resolveWindowsProviderCommand).mockReturnValue({ command: "C:\\fixture\\claude.exe", prefix: [] });
});

function fixture(selection?: "none", ownHome = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-refresh-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = createFullTestDb(); cleanups.push(() => db.close());
  const rigs = new RigRepository(db), registry = new SessionRegistry(db), rig = rigs.createRig("probe");
  const node = rigs.addNode(rig.id, "owner", { runtime: "claude-code", cwd: root });
  if (selection) rigs.setNodeClaudeMcp(node.id, selection);
  const session = registry.registerSession(node.id, "owner@probe");
  registry.updateResumeToken(session.id, "claude_id", "fixture-history", "operator");
  let launched = false;
  const tmux = {
    isNativeWindows: true,
    createSession: vi.fn(async (_session: string, _cwd?: string) => ({ ok: true })),
    getPaneCommand: vi.fn(async () => launched ? "claude.exe" : "powershell.exe"),
    getPanePid: vi.fn(async () => 100),
    capturePaneContent: vi.fn(async () => launched ? "Claude Code\n❯ " : "PS C:\\fixture>"),
    sendText: vi.fn(async () => ({ ok: true })), sendKeys: vi.fn(async () => ({ ok: true })),
    sendShellCommand: vi.fn(async (_session: string, _command: string) => { launched = true; return { ok: true }; }),
    killSession: vi.fn(async (_session: string) => ({ ok: true })),
  };
  const config = ownHome ? path.join(root, "config's 中文") : path.join(root, ".claude");
  const refresher = new ResumeMetadataRefresher({ sessionRegistry: registry, tmuxAdapter: tmux as unknown as TmuxAdapter,
    listClaudeProcesses: async () => [], homeDir: root, ...(ownHome ? { seatHome: () => config } : {}), sleep: async () => {} });
  const refresh = () => refresher.refresh([{ nodeId: node.id, sessionId: session.id, sessionName: session.sessionName,
    runtime: "claude-code", resumeType: "claude_id", resumeToken: "fixture-history", cwd: root }]);
  const status = () => registry.getSessionsForRig(rig.id)[0]!;
  return { tmux, refresh, status, config, root };
}

describe("native Windows shutdown resume probe", () => {
  it.each([undefined, "none"] as const)("uses a native child environment and verifies saved MCP choice %s", async selection => {
    const f = fixture(selection); await f.refresh();
    expect(f.status()).toMatchObject({ resumeToken: "fixture-history", resumeLastProbeStatus: "resumable" });
    expect(f.tmux.sendShellCommand).toHaveBeenCalledOnce();
    const command = vi.mocked(f.tmux.sendShellCommand).mock.calls[0] as unknown as [string, string];
    expect(command[1]).toContain("ProcessStartInfo");
    expect(command[1]).toContain("EnvironmentVariables['CLAUDE_CONFIG_DIR']");
    expect(command[1]).toContain(f.config.replaceAll("'", "''"));
    expect(command[1].includes("--strict-mcp-config")).toBe(selection === "none");
    expect(verifyPaneIdleShell).toHaveBeenCalled();
    expect(verifyClaudePaneProcess).toHaveBeenCalledWith(expect.objectContaining({ expectedToken: "fixture-history", selectedExecutable: "C:\\fixture\\claude.exe" }));
    expect(f.tmux.sendText).not.toHaveBeenCalled(); expect(f.tmux.sendKeys).not.toHaveBeenCalled();
    expect(f.tmux.killSession).toHaveBeenCalledOnce();
  });
  it("sends nothing when native idle-shell proof is unavailable", async () => {
    vi.mocked(verifyPaneIdleShell).mockResolvedValue(false);
    const f = fixture(); await f.refresh();
    expect(f.status()).toMatchObject({ resumeToken: "fixture-history", resumeLastProbeStatus: "inconclusive" });
    expect(f.tmux.sendShellCommand).not.toHaveBeenCalled(); expect(f.tmux.sendText).not.toHaveBeenCalled();
    expect(f.tmux.killSession).toHaveBeenCalledOnce();
  });
  it("pins the daemon-selected home when the seat declares no separate home", async () => {
    const f = fixture(undefined, false); await f.refresh();
    expect(f.tmux.sendShellCommand.mock.calls[0]?.[1]).toContain(f.config.replaceAll("'", "''"));
    expect(f.status()).toMatchObject({ resumeLastProbeStatus: "resumable" });
  });
  it("does not accept stale Claude chrome without exact native identity", async () => {
    vi.mocked(verifyClaudePaneProcess).mockResolvedValue(null);
    const f = fixture(); await f.refresh();
    expect(f.status()).toMatchObject({ resumeToken: "fixture-history", resumeLastProbeStatus: "inconclusive" });
    expect(f.tmux.sendShellCommand).toHaveBeenCalledOnce();
    expect(f.tmux.killSession).toHaveBeenCalledOnce();
  });
  it.each(["unavailable", "npm launcher"])("does not create a probe for an unprovable executable: %s", async reason => {
    if (reason === "unavailable") vi.mocked(resolveWindowsProviderCommand).mockImplementation(() => { throw new Error("fixture missing"); });
    else vi.mocked(resolveWindowsProviderCommand).mockReturnValue({ command: "C:\\fixture\\node.exe", prefix: ["C:\\fixture\\cli.js"] });
    const f = fixture(); await f.refresh();
    expect(f.status()).toMatchObject({ resumeToken: "fixture-history", resumeLastProbeStatus: "inconclusive" });
    expect(f.tmux.createSession).not.toHaveBeenCalled();
    expect(f.tmux.sendShellCommand).not.toHaveBeenCalled();
  });
  it.each([false, true])("requires native identity for an explicit history failure: %s", async proven => {
    if (!proven) vi.mocked(verifyClaudePaneProcess).mockResolvedValue(null);
    const f = fixture(); f.tmux.capturePaneContent.mockResolvedValue("No conversation found");
    await f.refresh();
    expect(f.status()).toMatchObject({ resumeToken: "fixture-history", resumeLastProbeStatus: proven ? "not_resumable" : "inconclusive" });
    expect(f.tmux.sendShellCommand).toHaveBeenCalledOnce(); expect(f.tmux.killSession).toHaveBeenCalledOnce();
  });
  it("cleans only the probe session after a failed native dispatch", async () => {
    const f = fixture(); f.tmux.sendShellCommand.mockResolvedValue({ ok: false }); await f.refresh();
    expect(f.status()).toMatchObject({ resumeToken: "fixture-history", resumeLastProbeStatus: "inconclusive" });
    expect(f.tmux.killSession).toHaveBeenCalledOnce();
    expect(f.tmux.killSession.mock.calls[0]?.[0]).toMatch(/^rigged-refresh-owner-probe-/);
  });
  it.skipIf(process.platform !== "win32")("executes the rendered command through PowerShell with an owned inert native stub", async () => {
    const f = fixture("none"), bin = path.join(f.root, "bin's 中文"); fs.mkdirSync(bin);
    const stub = path.join(bin, "claude.exe"), receipt = path.join(f.root, "argv.txt");
    const source = String.raw`using System;using System.IO;using System.Linq;using System.Text;
public static class OwnedProbe {
  static string B(string s){return Convert.ToBase64String(Encoding.UTF8.GetBytes(s));}
  public static int Main(string[] args){
    File.WriteAllLines(Environment.GetEnvironmentVariable("OPENRIG_NATIVE_PROBE_RECEIPT"),
      new[]{B(Environment.GetEnvironmentVariable("CLAUDE_CONFIG_DIR")??""),B(Environment.CurrentDirectory)}.Concat(args.Select(B)).ToArray());return 0;
  }
}`;
    const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const compile = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'\nAdd-Type -TypeDefinition @'\n${source}\n'@ -OutputAssembly $env:OPENRIG_NATIVE_PROBE_BINARY -OutputType ConsoleApplication`;
    const run = (script: string) => execFileSync(powershell,
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { env: { ...process.env, OPENRIG_NATIVE_PROBE_BINARY: stub, OPENRIG_NATIVE_PROBE_RECEIPT: receipt },
        cwd: f.root, windowsHide: true, timeout: 10_000, stdio: "pipe" });
    run(compile);
    vi.mocked(resolveWindowsProviderCommand).mockReturnValue({ command: stub, prefix: [] });
    await f.refresh();
    const [, command] = f.tmux.sendShellCommand.mock.calls[0] as unknown as [string, string];
    run(command);
    const [config, cwd, ...argv] = fs.readFileSync(receipt, "utf8").trim().split(/\r?\n/).map(s => Buffer.from(s, "base64").toString("utf8"));
    expect(config).toBe(f.config); expect(fs.realpathSync.native(cwd!)).toBe(fs.realpathSync.native(f.root));
    expect(argv[argv.indexOf("--resume") + 1]).toBe("fixture-history");
    expect(argv[argv.indexOf("--name") + 1]).toBe("owner@probe");
    expect(argv[argv.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    expect(argv.filter(s => s === "--strict-mcp-config")).toHaveLength(1);
  }, 20_000);
});
