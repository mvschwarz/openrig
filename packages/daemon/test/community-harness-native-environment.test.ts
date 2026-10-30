import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { CommunityHarnessRuntimeAdapter } from "../src/adapters/community-harness-runtime-adapter.js";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

it.runIf(process.platform === "win32").each(["model-set", "model-cleared", "named", "resume", "record", "npm-global", "npm-local", "npm-relative-path", "npm-relative-command", "npm-invalid", "npm-exe-first"])("delivers native community launch environment for %s", async mode => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "community-native-")));
  try {
    const output = path.join(root, "output.json"), script = path.join(root, "owned.cjs"), cli = path.join(root, "rig.mjs");
    fs.writeFileSync(cli, "// owned paired CLI, never called\n");
    fs.writeFileSync(script, `const fs=require('fs'), e=process.env; const received={model:e.OPENRIG_MODEL??null,first:e.OPENRIG_FIRST_INPUT?fs.readFileSync(e.OPENRIG_FIRST_INPUT,'utf8'):null,conversation:e.OPENRIG_CONVERSATION??null,resume:e.OPENRIG_RESUME_REF??null,attempt:e.OPENRIG_LAUNCH_ATTEMPT??null};fs.writeFileSync(${JSON.stringify(output)},JSON.stringify(received));if(e.OPENRIG_LAUNCH_RESULT)fs.writeFileSync(e.OPENRIG_LAUNCH_RESULT,JSON.stringify({format:1,attempt:e.OPENRIG_LAUNCH_ATTEMPT,harness:'synth',nativeRef:'owned-conversation',producer:'owned fixture'}));`);
    let program = [process.execPath, script].map(shellQuote).join(" ");
    let searchPath = path.dirname(process.execPath);
    if (mode.startsWith("npm-")) {
      const local = ["npm-local", "npm-relative-path", "npm-relative-command"].includes(mode);
      const bin = path.join(root, local ? "node_modules/.bin" : "npm bin");
      const pkg = path.join(root, local ? "node_modules/@owned/synth" : "npm bin/node_modules/@owned/synth");
      fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
      fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@owned/synth", bin: { "synth-launch": "bin/cli.cjs" } }));
      fs.copyFileSync(script, path.join(pkg, "bin/cli.cjs"));
      fs.writeFileSync(path.join(bin, "synth-launch.cmd"), `@echo off\r\n"node" "%dp0%\\${local ? ".." : "node_modules"}\\@owned\\synth\\bin\\cli.cjs" %*\r\n`);
      if (!local) fs.writeFileSync(path.join(bin, "synth-launch.cmd"), '@echo off\r\n@setlocal\r\n@set "dp0=%~dp0"\r\n@if exist "%dp0%\\node.exe" (\r\n  @set "_prog=%dp0%\\node.exe"\r\n) else (\r\n  @set "_prog=node"\r\n)\r\n"%_prog%" "%dp0%\\node_modules\\@owned\\synth\\bin\\cli.cjs" %*\r\n');
      if (!local) fs.copyFileSync(process.execPath, path.join(bin, "node.exe"));
      searchPath = [bin, searchPath].join(path.delimiter); program = "synth-launch";
      if (mode === "npm-relative-path") searchPath = ["node_modules/.bin", path.dirname(process.execPath)].join(path.delimiter);
      if (mode === "npm-relative-command") program = shellQuote("./node_modules/.bin/synth-launch");
      if (mode === "npm-invalid") fs.writeFileSync(path.join(bin, "synth-launch.cmd"), "@echo off\r\nrem not a Node npm shim\r\n");
      if (mode === "npm-exe-first") {
        fs.copyFileSync(process.execPath, path.join(bin, "synth-launch.exe"));
        fs.writeFileSync(path.join(pkg, "package.json"), "not used: native executable wins");
        program += " " + shellQuote(script);
      }
    }
    const preset = `format: 1\nname: synth\nmaintainer: Example\nlimits: []\ncommand: ${JSON.stringify(program)}\nfirst_input: true\npasses_model: true\n`
      + (mode === "named" || mode === "resume" ? "names_conversation: true\nresume: true\n" : mode === "record" ? "launch_result: true\n" : "");
    fs.writeFileSync(path.join(root, "synth.yaml"), preset);
    const tmux = new TmuxAdapter(async () => { throw new Error("No real terminal is used"); });
    const identity: Record<string, string> = { OPENRIG_NODE_ID: "owned", OPENRIG_SESSION_NAME: "owned@fixture", OPENRIG_RUNTIME: "synth" };
    vi.spyOn(tmux, "getPaneCommand").mockResolvedValue("powershell");
    vi.spyOn(tmux, "getSessionEnv").mockImplementation(async (_session, key) => identity[key]);
    const daemonCwd = path.join(root, "unrelated daemon directory");
    fs.mkdirSync(daemonCwd);
    const launch = new SeatLaunchEnvironment(tmux, { PATH: searchPath, PATHEXT: mode === "npm-exe-first" ? ".EXE;.CMD" : ".CMD;.EXE", OPENRIG_HOME: path.join(root, "instance") }, daemonCwd, cli, undefined, "win32");
    const sendShellCommand = vi.fn(async (_session: string, command: string, beforeInput?: () => void) => {
      beforeInput?.();
      execFileSync(path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
        { cwd: root, encoding: "utf8", windowsHide: true, timeout: 10000, stdio: "pipe", env: { ...process.env, OPENRIG_MODEL: "inherited", OPENRIG_FIRST_INPUT: "inherited-do-not-read" } });
      return { ok: true as const };
    });
    const adapter = new CommunityHarnessRuntimeAdapter("synth", { tmux: { hasSession: async () => true, getPaneCommand: async () => "node", sendShellCommand }, seatLaunchEnvironment: launch,
      presetsDir: () => root, launchResultRoot: () => path.join(root, "launch-results"), launchResultWait: { timeoutMs: 100, intervalMs: 10 } });
    const model = "owned/model 'quote' $value & % !", first = "owned first input\n'quote' & % !";
    const pending = adapter.launchHarness({ cwd: root, tmuxSession: "owned@fixture", ...(mode !== "model-cleared" ? { model } : {}) } as NodeBinding,
      { name: "owned@fixture", ...(mode !== "model-cleared" ? { firstInputText: first } : {}), ...(mode === "resume" ? { resumeToken: "owned-resume", resumeType: "community:synth" } : {}) });
    if (mode === "npm-invalid") {
      await expect(pending).rejects.toThrow("no POSIX fallback was typed");
      expect(sendShellCommand).not.toHaveBeenCalled(); expect(fs.existsSync(output)).toBe(false); return;
    }
    const result = await pending;
    expect(result).toMatchObject({ ok: true });
    const received = JSON.parse(fs.readFileSync(output, "utf8"));
    expect(received.model).toBe(mode === "model-cleared" ? null : model);
    expect(received.first).toBe(mode === "model-cleared" ? null : first);
    if (mode === "named") expect(received.conversation).toBe(result.resumeToken);
    if (mode === "resume") expect(received.resume).toBe("owned-resume");
    if (mode === "record") { expect(received.attempt).toMatch(/^[0-9a-f-]+$/); expect(result.resumeToken).toBe("owned-conversation"); }
  } finally { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); }
}, 20000);
