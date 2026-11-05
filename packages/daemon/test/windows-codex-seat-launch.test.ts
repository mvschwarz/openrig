import { expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";
import { shellQuote } from "../src/adapters/shell-quote.js";

it.runIf(process.platform === "win32").each([false, true])("launches a recognized npm Codex through its pinned Node entry with exact native args (mixed environment=%s)", async mixed => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native codex seat ' 中文-"));
  try {
    const bin = path.join(root, "npm bin"), packageRoot = path.join(bin, "node_modules", "@openai", "codex");
    fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } }));
    fs.writeFileSync(path.join(packageRoot, "bin", "codex.js"), "require('fs').writeFileSync(process.argv[2],JSON.stringify({args:process.argv.slice(3),home:process.env.CODEX_HOME,node:process.env.OPENRIG_NODE_ID,lines:process.env.OPENRIG_TRANSCRIPTS_LINES}));");
    fs.writeFileSync(path.join(bin, "codex.cmd"), `@echo off\r\n@setlocal\r\n@set "dp0=%~dp0"\r\n"${process.execPath}" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`);
    const cli = path.join(root, "rig.mjs"); fs.writeFileSync(cli, "// synthetic paired CLI, never invoked\n");
    const identity: Record<string, string> = { OPENRIG_NODE_ID: "owned", OPENRIG_SESSION_NAME: "owned@fixture", OPENRIG_RUNTIME: "codex", OPENRIG_OCCUPANT_GENERATION: "generation" };
    const tmux = new TmuxAdapter(async () => { throw new Error("No multiplexer process is used"); });
    vi.spyOn(tmux, "getPaneCommand").mockResolvedValue("powershell");
    vi.spyOn(tmux, "getSessionEnv").mockImplementation(async (_session, key) => identity[key]);
    const home = path.join(root, "selected home"), output = path.join(root, "result.json");
    const selectedPath = [bin, path.dirname(process.execPath)].join(path.delimiter);
    fs.writeFileSync(path.join(bin, "codex.com"), "decoy: never execute; selected PATHEXT puts CMD first");
    const env = mixed ? { Path: selectedPath, PathExt: ".CMD;.COM;.EXE", OpenRig_Home: path.join(root, "instance"), openrig_transcripts_lines: "123" }
      : { PATH: selectedPath, PATHEXT: ".CMD;.COM;.EXE", OPENRIG_HOME: path.join(root, "instance"), OPENRIG_TRANSCRIPTS_LINES: "123" };
    const launch = new SeatLaunchEnvironment(tmux, env, root, cli, home, "win32");
    const args = [output, "space word", "中文;$literal", "a'b", 'double"quote', "", "trailing\\", "%OPENRIG_NODE_ID%", "amp&word"];
    const command = await launch.command("owned@fixture", `codex ${args.map(shellQuote).join(" ")}`, { codexCwd: root, runtime: "codex", nodeId: "owned", generation: "generation" });
    execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { windowsHide: true, encoding: "utf8", timeout: 15000, stdio: "pipe" });
    expect(JSON.parse(fs.readFileSync(output, "utf8"))).toEqual({ args: args.slice(1), home, node: "owned", lines: "123" });
    const prior = fs.readFileSync(output, "utf8");
    fs.writeFileSync(path.join(bin, "codex.cmd"), "@echo off\r\nrem unrelated launcher\r\n");
    await expect(launch.command("owned@fixture", "codex --version", { codexCwd: root, runtime: "codex", nodeId: "owned" })).rejects.toThrow("no POSIX fallback was typed");
    expect(fs.readFileSync(output, "utf8")).toBe(prior);
  } finally { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); }
});
