import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import { shellQuote } from "../src/adapters/shell-quote.js";

const execute = promisify(execFile);
const homes: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true }); });

describe.runIf(process.platform === "win32")("classic Claude native launch command", () => {
  it.each(["fresh", "resume", "fork"] as const)("executes the %s command with renderer and identity metadata", async kind => {
    vi.stubEnv("OPENRIG_CLAUDE_DISABLE_ALTERNATE_SCREEN", "1");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rig-win-classic-")); homes.push(home);
    const cli = path.join(home, "rig.js"); fs.writeFileSync(cli, "// inert paired CLI fixture");
    const tmux = new TmuxAdapter();
    const identity: Record<string, string> = { OPENRIG_NODE_ID: "node", OPENRIG_SESSION_NAME: "seat@rig", OPENRIG_RUNTIME: "claude-code", OPENRIG_OCCUPANT_GENERATION: "old-generation" };
    vi.spyOn(tmux, "getPaneCommand").mockResolvedValue("powershell.exe");
    vi.spyOn(tmux, "getSessionEnv").mockImplementation(async (_session, key) => identity[key] ?? null);
    const launch = new SeatLaunchEnvironment(tmux, { OPENRIG_HOME: home, PATH: process.env.PATH! }, home, cli, undefined, "win32");
    const receiver = path.join(home, "capture argv.cjs");
    fs.writeFileSync(receiver, `console.log(JSON.stringify({argv:process.argv.slice(2), renderer:process.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN, node:process.env.OPENRIG_NODE_ID, generation:process.env.OPENRIG_OCCUPANT_GENERATION, resumeLaunch:process.env.OPENRIG_RESUME_LAUNCH}));`);
    // Exercise the real native executable boundary without starting Claude.
    const render = launch.command.bind(launch);
    vi.spyOn(launch, "command").mockImplementation(async (session, value, identity) => {
      expect(value).toMatch(/(?:^| )claude /);
      return render(session, value.replace(/\bclaude /, `${shellQuote(process.execPath)} ${shellQuote(receiver)} `), identity);
    });
    let command = "";
    vi.spyOn(tmux, "sendShellCommand").mockImplementation(async (_session, value) => { command = value; return { ok: true }; });
    const fsOps = { readFile: () => "", writeFile: () => {}, exists: () => false, mkdirp: () => {}, copyFile: () => {}, homedir: home };
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps, seatLaunchEnvironment: launch, sleep: async () => {} });
    vi.spyOn(adapter as any, "verifyResumeLaunch").mockResolvedValue({ ok: true });
    const binding: NodeBinding = { id: "b", nodeId: "node", tmuxSession: "seat@rig", tmuxPane: "%1", tmuxWindow: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: home, model: "model space's", launchGeneration: "new-generation" };
    const result = await adapter.launchHarness(binding, { name: "seat", ...(kind === "resume" ? { resumeToken: "original-session" } : kind === "fork" ? { forkSource: { kind: "native_id" as const, value: "parent-session" } } : {}) });
    expect(result.ok).toBe(true);
    const script = "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; " + command + "; Write-Output ('parent=' + $env:OPENRIG_RESUME_LAUNCH)";
    const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", timeout: 10000, windowsHide: true });
    const lines = stdout.trim().split(/\r?\n/);
    expect(lines.at(-1)).toBe("parent=");
    const observed = JSON.parse(lines[0]!);
    expect(observed).toMatchObject({ renderer: "1", node: "node", generation: "new-generation" });
    expect(observed.argv).toContain("model space's");
    if (kind === "resume") { expect(observed.argv).toContain("original-session"); expect(observed.resumeLaunch).toBe("original-session"); }
    else expect(observed.resumeLaunch).toBeUndefined();
    if (kind === "fork") { expect(observed.argv).toContain("parent-session"); expect(observed.argv).toContain("--fork-session"); }
    if (kind === "fresh") expect(observed.argv).toContain("--session-id");
  });
});
