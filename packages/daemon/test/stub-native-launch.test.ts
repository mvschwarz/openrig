import { expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { StubRuntimeAdapter } from "../src/adapters/stub-runtime-adapter.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

it.runIf(process.platform === "win32")("dispatches the native stub launch through a shell command with exact runner arguments", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stub-native-'用户 &-"));
  try {
    const entry = path.join(root, "owned-runner.cjs");
    const argvFile = path.join(root, "argv.json");
    const state = path.join(root, ".openrig", "stub", "state.json");
    fs.mkdirSync(path.dirname(state), { recursive: true });
    fs.writeFileSync(entry, `const fs=require('fs');fs.writeFileSync(${JSON.stringify(argvFile)},JSON.stringify(process.argv.slice(2)));fs.writeFileSync(${JSON.stringify(state)},JSON.stringify({ready:true,launchId:'owned-launch'}));`);
    const run = (command: string) => execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 10000 });
    let pending = "";
    const sendShellCommand = vi.fn(async (_target: string, command: string) => { run(command); return { ok: true }; });
    const sendKeys = vi.fn(async () => { run(pending); return { ok: true }; });
    const tmux = { sendShellCommand, sendKeys, sendText: vi.fn(async (_target: string, text: string) => { pending = text; return { ok: true }; }) } as unknown as TmuxAdapter;
    const adapter = new StubRuntimeAdapter({ platform: "win32", tmux, runnerEntryPath: entry, newLaunchId: () => "owned-launch",
      fsOps: { exists: fs.existsSync, readFile: file => fs.readFileSync(file, "utf8"), writeFile: (file, text) => fs.writeFileSync(file, text), mkdirp: dir => { fs.mkdirSync(dir, { recursive: true }); } } });
    const session = "owned-seat@fixture";
    expect(await adapter.launchHarness({ tmuxSession: session, cwd: root } as NodeBinding, { name: session, resumeToken: "resume ' & 用户" })).toMatchObject({ ok: true });
    expect(sendShellCommand).toHaveBeenCalledOnce();
    expect(sendKeys).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(argvFile, "utf8"))).toEqual(["--session-name", session, "--cwd", root, "--launch-id", "owned-launch", "--posture", "floor", "--session", "resume ' & 用户"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
