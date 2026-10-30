import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWindowsProviderCommand } from "../src/domain/windows-provider-command.js";
import { verifyClaudePaneProcess, type NativeProcessRow } from "../src/domain/native-process-lineage.js";
import { windowsArguments } from "../src/adapters/windows-argv.js";

it.runIf(process.platform === "win32").each(["claude", "codex"] as const)("canonicalizes both selected npm %s interpreter and script", name => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-npm-alias-"));
  try {
    const packageName = name === "claude" ? "@anthropic-ai/claude-code" : "@openai/codex";
    const pkg = path.join(root, "node_modules", ...packageName.split("/")); fs.mkdirSync(pkg, { recursive: true });
    const script = path.join(pkg, "cli.js"), node = path.join(root, "node.exe");
    fs.writeFileSync(script, "// owned, never executed"); fs.writeFileSync(node, "owned identity fixture; never executed");
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: packageName, bin: { [name]: "cli.js" } }));
    fs.writeFileSync(path.join(root, `${name}.cmd`), `@echo off\r\n"node" "%dp0%\\node_modules\\${packageName.replaceAll("/", "\\")}\\cli.js" %*\r\n`);
    expect(resolveWindowsProviderCommand(name, { PATH: root, PATHEXT: ".CMD;.EXE" }, root)).toEqual({
      command: fs.realpathSync.native(node), prefix: [fs.realpathSync.native(script)],
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it.runIf(process.platform === "win32")("keeps selected native provider identity aligned with the OS long path", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-native-alias-"));
  try {
    const file = path.join(root, "claude.exe"); fs.writeFileSync(file, "owned executable identity fixture; never executed");
    const selected = resolveWindowsProviderCommand("claude", { PATH: root, PATHEXT: ".EXE" }, root);
    const actual = fs.realpathSync.native(file);
    const rows: NativeProcessRow[] = [
      { platform: "win32", pid: 10, ppid: 1, command: '"C:\\Windows\\System32\\cmd.exe"', executableName: "cmd.exe", executablePath: "C:\\Windows\\System32\\cmd.exe", startedAt: "2026-10-30T02:00:00Z" },
      { platform: "win32", pid: 11, ppid: 10, command: windowsArguments([actual, "--resume", "owned-token"]), executableName: "claude.exe", executablePath: actual, startedAt: "2026-10-30T02:00:01Z" },
    ];
    const proof = await verifyClaudePaneProcess({ target: "owned", tmux: { getPanePid: async () => 10, getPaneCommand: async () => "claude" },
      listProcesses: () => rows, selectedExecutable: selected.command, expectedToken: "owned-token", requireResume: true });
    expect(proof?.process.pid).toBe(11);
    expect(selected.command).toBe(actual);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
