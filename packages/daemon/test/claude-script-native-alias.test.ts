import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyClaudePaneProcess, type NativeProcessRow } from "../src/domain/native-process-lineage.js";
import { windowsArguments } from "../src/adapters/windows-argv.js";

it.runIf(process.platform === "win32")("joins an owned selected Claude script through native aliases without admitting another script", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-script-alias-"));
  const alias = path.join(root, "alias");
  try {
    const directory = path.join(root, "selected"); fs.mkdirSync(directory);
    const script = path.join(directory, "cli.js"); fs.writeFileSync(script, "// owned identity witness, never executed");
    const other = path.join(directory, "other.js"); fs.writeFileSync(other, "// distinct");
    fs.symlinkSync(directory, alias, "junction");
    const node = process.execPath;
    const values: NativeProcessRow[] = [
      { platform: "win32", pid: 100, ppid: 1, command: '"C:\\Windows\\System32\\cmd.exe"', executableName: "cmd.exe", executablePath: "C:\\Windows\\System32\\cmd.exe", startedAt: "2026-10-30T01:00:00Z" },
      { platform: "win32", pid: 101, ppid: 100, command: windowsArguments([node, script, "--resume", "owned-token"]), executableName: "node.exe", executablePath: node, startedAt: "2026-10-30T01:00:01Z" },
    ];
    const input = { target: "owned", tmux: { getPanePid: async () => 100, getPaneCommand: async () => "node" },
      listProcesses: () => values, selectedExecutable: node, selectedScript: path.join(alias, "CLI.js"), expectedToken: "owned-token", requireResume: true };
    expect((await verifyClaudePaneProcess(input))?.process.pid).toBe(101);
    expect(await verifyClaudePaneProcess({ ...input, selectedScript: other })).toBeNull();
    expect(await verifyClaudePaneProcess({ ...input, expectedToken: "another-token" })).toBeNull();
    expect(await verifyClaudePaneProcess({ ...input, listProcesses: () => [...values, { ...values[1]!, pid: 102 }] })).toBeNull();
    expect(await verifyClaudePaneProcess({ ...input, selectedScript: path.join(directory, "missing.js") })).toBeNull();
  } finally { if (fs.existsSync(alias)) fs.unlinkSync(alias); fs.rmSync(root, { recursive: true, force: true }); }
});
