import { expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ResumeMetadataRefresher } from "../src/domain/resume-metadata-refresher.js";
import * as lineage from "../src/domain/native-process-lineage.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

it.runIf(process.platform === "win32")("dispatches a recognized npm Claude probe with exact script identity and refuses unverified results", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resume-npm-native-"));
  const idle = vi.spyOn(lineage, "verifyPaneIdleShell").mockResolvedValue(true);
  const identity = vi.spyOn(lineage, "verifyClaudePaneProcess").mockResolvedValue(null);
  try {
    const pkg = path.join(root, "node_modules", "@anthropic-ai", "claude-code");
    fs.mkdirSync(pkg, { recursive: true });
    const script = path.join(pkg, "cli.js");
    const observed = path.join(root, "observed.json");
    fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(observed)},JSON.stringify(process.argv.slice(2)))`);
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", bin: { claude: "cli.js" } }));
    fs.writeFileSync(path.join(root, "claude.cmd"), '@echo off\r\n"node" "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
    vi.stubEnv("PATH", [root, path.dirname(process.execPath)].join(path.delimiter));
    vi.stubEnv("PATHEXT", ".CMD;.EXE");
    const sendShellCommand = vi.fn(async (_session: string, command: string) => {
      execFileSync(path.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
        { cwd: root, windowsHide: true, timeout: 10000, stdio: "pipe" });
      return { ok: true };
    });
    const killSession = vi.fn(async () => ({ ok: true }));
    const tmux = { isNativeWindows: true, createSession: vi.fn(async () => ({ ok: true })),
      getPaneCommand: vi.fn(async () => "node"), capturePaneContent: vi.fn(async () => ""),
      sendShellCommand, killSession } as unknown as TmuxAdapter;
    const refresher = new ResumeMetadataRefresher({ sessionRegistry: {} as SessionRegistry,
      tmuxAdapter: tmux, homeDir: root, sleep: async () => {} });
    const result = await (refresher as unknown as { defaultProbeClaudeResume(name: string, token: string, cwd: string): Promise<string> })
      .defaultProbeClaudeResume("fixture@owned", "11111111-1111-4111-8111-111111111111", root);
    expect(result).toBe("inconclusive");
    expect(sendShellCommand).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(observed, "utf8"))).toEqual(expect.arrayContaining(["--resume", "11111111-1111-4111-8111-111111111111"]));
    expect(identity).toHaveBeenCalledWith(expect.objectContaining({ selectedExecutable: fs.realpathSync.native(process.execPath),
      selectedScript: fs.realpathSync.native(script), requireResume: true }));
    expect(killSession).toHaveBeenCalledTimes(1);
  } finally { idle.mockRestore(); identity.mockRestore(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); }
});
