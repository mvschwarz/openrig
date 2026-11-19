import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claudeSeatTokenStep } from "../src/domain/claude-seat-token.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { renderWindowsManagedLaunch, renderWindowsLaunch } from "../src/adapters/windows-launch.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";
import { ACCOUNT_HOME_PROVIDER_ENV } from "../src/domain/seat-runtime-home.js";

const exec = promisify(execFile);
describe.skipIf(process.platform !== "win32")("native Claude seat token", () => {
  const fixture = async (fn: (root: string, receiver: string, token: string) => Promise<void>) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openrig-token-native-"));
    const receiver = path.join(root, "receiver.cjs"), token = path.join(root, "token's file.txt");
    await writeFile(token, "synthetic-seat-token\r\n");
    await writeFile(receiver, `require('node:fs').writeFileSync(process.argv[2],'started');console.log(JSON.stringify({token:process.env.CLAUDE_CODE_OAUTH_TOKEN==='synthetic-seat-token',old:process.env.CLAUDE_CODE_OAUTH_TOKEN==='synthetic-old',absent:process.env.CLAUDE_CODE_OAUTH_TOKEN===undefined,key:process.env.ANTHROPIC_API_KEY===undefined}));`);
    try { await fn(root, receiver, token); } finally { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); }
  };
  const execute = (script: string) => exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    windowsHide: true, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, ANTHROPIC_API_KEY: "synthetic-pane-key", CLAUDE_CODE_OAUTH_TOKEN: "synthetic-old" },
  });

  it.each(["classic", "managed"])("reads token only at %s child start, removes outranking credentials and preserves pane values", mode => fixture(async (root, receiver, token) => {
    const step = claudeSeatTokenStep({ label: "test", tokenFile: token }, shellQuote, { platform: "win32", required: true });
    const args = [receiver, path.join(root, "started")];
    const command = mode === "classic"
      ? renderWindowsLaunch([process.execPath, ...args].map(shellQuote).join(" "), {}, { beforeStart: step })
      : renderWindowsManagedLaunch(process.execPath, args, root, { SystemRoot: process.env.SystemRoot! }, ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"], step);
    expect(command).not.toContain("synthetic-seat-token");
    const { stdout } = await execute(command + "; Write-Output ($env:ANTHROPIC_API_KEY -eq 'synthetic-pane-key'); Write-Output ($env:CLAUDE_CODE_OAUTH_TOKEN -eq 'synthetic-old')");
    const lines = stdout.trim().split(/\r?\n/);
    expect(JSON.parse(lines[0]!)).toMatchObject({ token: true, key: true });
    expect(lines.slice(1)).toEqual(["True", "True"]);
  }));

  it("refuses a required unreadable token before starting the child", () => fixture(async (root, receiver) => {
    const marker = path.join(root, "never-started");
    const step = claudeSeatTokenStep({ label: "test", tokenFile: path.join(root, "missing") }, shellQuote, { platform: "win32", required: true });
    const command = renderWindowsLaunch([process.execPath, receiver, marker].map(shellQuote).join(" "), {}, { beforeStart: step });
    await expect(execute(command)).rejects.toThrow();
    await expect(access(marker)).rejects.toThrow();
  }));

  it.each([false, true])("optional empty token removes inherited token only when requested=%s", removeOnFailure => fixture(async (root, receiver, token) => {
    await writeFile(token, "\r\n");
    const step = claudeSeatTokenStep({ label: "test", tokenFile: token }, shellQuote, { platform: "win32", removeOnFailure });
    const command = renderWindowsLaunch([process.execPath, receiver, path.join(root, "started")].map(shellQuote).join(" "), {}, { beforeStart: step });
    const { stdout, stderr } = await execute(command);
    expect(JSON.parse(stdout.trim())).toMatchObject({ token: false, old: !removeOnFailure, absent: removeOnFailure, key: false });
    expect(stderr).toContain("wasn't applied");
    expect(stderr).not.toContain("synthetic-old");
  }));

  it("classic account selection clears inherited credentials and carries its token step", () => fixture(async (root, receiver, token) => {
    const tmux = new TmuxAdapter();
    vi.spyOn(tmux, "getPaneCommand").mockResolvedValue("powershell.exe");
    vi.spyOn(tmux, "getSessionEnv").mockImplementation(async (_session, name) => ({ OPENRIG_NODE_ID: "node", OPENRIG_SESSION_NAME: "seat", OPENRIG_RUNTIME: "claude-code" })[name as "OPENRIG_NODE_ID"] ?? null);
    const cli = path.join(root, "rig.js"); await writeFile(cli, "// fixture");
    const launch = new SeatLaunchEnvironment(tmux, { OPENRIG_HOME: root, PATH: process.env.PATH! }, root, cli, undefined, "win32");
    const step = claudeSeatTokenStep({ label: "test", tokenFile: token }, shellQuote, { platform: "win32", required: true });
    const command = await launch.command("seat", [process.execPath, receiver, path.join(root, "started")].map(shellQuote).join(" "), {
      nodeId: "node", runtime: "claude-code", accountHome: root, claudeTokenStep: step,
    });
    expect(command).toContain(step);
    for (const name of ACCOUNT_HOME_PROVIDER_ENV) expect(command).toContain(`EnvironmentVariables.Remove('${name}')`);
    expect(JSON.parse((await execute(command)).stdout.trim())).toMatchObject({ token: true, key: true });
  }));
});
