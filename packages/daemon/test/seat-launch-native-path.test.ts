import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { codexDaemonSupportProbe } from "../src/domain/codex-daemon-support.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
it.runIf(process.platform === "win32").each(["fresh", "resume", "fork"] as const)("native %s pins the probed npm interpreter while retaining pane tool PATH and the paired rig", async kind => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "native-seat-path-"))); roots.push(root);
  const bin = path.join(root, "npm"), nodeBin = path.join(root, "separate interpreter"), user = path.join(root, "user tools");
  for (const dir of [bin, nodeBin, user]) fs.mkdirSync(dir);
  fs.symlinkSync(process.execPath, path.join(nodeBin, "node.exe"));
  const pkg = path.join(bin, "node_modules", "@openai", "codex"); fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } }));
  fs.writeFileSync(path.join(pkg, "bin", "codex.js"), "if(process.argv.includes('--help'))console.log('Usage: codex [OPTIONS]\\n  --no-daemon');else console.log(JSON.stringify({started:true,node:process.execPath,path:process.env.PATH,args:process.argv.slice(2)}));");
  fs.writeFileSync(path.join(bin, "codex.cmd"), '@echo off\r\n@setlocal\r\n@set "dp0=%~dp0"\r\nnode "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
  const cli = path.join(root, "paired-rig.cjs"); fs.writeFileSync(cli, "console.log('owned paired rig');");
  const identity: Record<string, string> = { OPENRIG_NODE_ID: "node", OPENRIG_SESSION_NAME: "seat@rig", OPENRIG_RUNTIME: "codex", OPENRIG_OCCUPANT_GENERATION: "generation" };
  const tmux = { getSessionEnv: vi.fn(async (_s: string, key: string) => identity[key]), getPaneCommand: vi.fn(async () => "powershell"), sendShellCommand: vi.fn(async () => ({ ok: true })) };
  const launchPath = [bin, nodeBin].join(path.delimiter), env = { PATH: launchPath, OPENRIG_HOME: path.join(root, "instance"), PATHEXT: ".CMD;.EXE" };
  const launch = new SeatLaunchEnvironment(tmux as never, env, root, cli, undefined, "win32");
  const adapter = new CodexRuntimeAdapter({ tmux: tmux as never, seatLaunchEnvironment: launch, launchPath,
    detectDaemonSupport: codexDaemonSupportProbe(launchPath), resolveGitAddDirs: async () => [], listProcesses: () => [], sleep: async () => {},
    fsOps: { readFile: () => "", writeFile: () => {}, exists: () => false, mkdirp: () => {}, homedir: root } });
  vi.spyOn(adapter as any, "dismissSkippableCodexUpdatePrompt").mockResolvedValue(undefined);
  vi.spyOn(adapter as any, "verifyResumeLaunch").mockResolvedValue({ ok: true });
  vi.spyOn(adapter as any, "captureFreshThreadId").mockResolvedValue("new-thread");
  vi.spyOn(adapter as any, "captureVerifiedForkId").mockResolvedValue("new-thread");
  const result = await adapter.launchHarness({ id: "b", nodeId: "node", tmuxSession: "seat@rig", tmuxPane: "%1", cwd: root } as never,
    { name: "seat", ...(kind === "resume" ? { resumeToken: "old" } : kind === "fork" ? { forkSource: { kind: "native_id", value: "parent" } } : {}) });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  const command = (tmux.sendShellCommand.mock.calls.at(-1) as unknown as string[])[1]!;
  const shell = path.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const childEnv = { SystemRoot: process.env.SystemRoot, TEMP: root, TMP: root, USERPROFILE: root, HOME: root, PATH: user };
  const run = promisify(execFile);
  const { stdout } = await run(shell, ["-NoProfile", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { cwd: root, env: childEnv, timeout: 15000, windowsHide: true });
  const observed = JSON.parse(stdout);
  expect(observed.started).toBe(true); expect(fs.realpathSync.native(observed.node)).toBe(fs.realpathSync.native(process.execPath));
  const [owned, ...rest] = observed.path.split(path.delimiter);
  expect(rest.join(path.delimiter)).toBe(user);
  expect(fs.readdirSync(owned).sort()).toEqual(["rig", "rig.cmd", "rig.ps1"]);
  const paired = await run(shell, ["-NoProfile", "-Command", "& rig"], { cwd: root, env: { ...childEnv, PATH: observed.path }, timeout: 15000, windowsHide: true });
  expect(paired.stdout.trim()).toBe("owned paired rig");
}, 30000);
