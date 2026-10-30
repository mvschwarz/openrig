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

it.runIf(process.platform === "win32").each(["model-set", "model-cleared", "named", "resume", "record"])("delivers native community launch environment for %s", async mode => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "community-native-")));
  try {
    const output = path.join(root, "output.json"), script = path.join(root, "owned.cjs"), cli = path.join(root, "rig.mjs");
    fs.writeFileSync(cli, "// owned paired CLI, never called\n");
    fs.writeFileSync(script, `const fs=require('fs'), e=process.env; const received={model:e.OPENRIG_MODEL??null,first:e.OPENRIG_FIRST_INPUT?fs.readFileSync(e.OPENRIG_FIRST_INPUT,'utf8'):null,conversation:e.OPENRIG_CONVERSATION??null,resume:e.OPENRIG_RESUME_REF??null,attempt:e.OPENRIG_LAUNCH_ATTEMPT??null};fs.writeFileSync(${JSON.stringify(output)},JSON.stringify(received));if(e.OPENRIG_LAUNCH_RESULT)fs.writeFileSync(e.OPENRIG_LAUNCH_RESULT,JSON.stringify({format:1,attempt:e.OPENRIG_LAUNCH_ATTEMPT,harness:'synth',nativeRef:'owned-conversation',producer:'owned fixture'}));`);
    const preset = `format: 1\nname: synth\nmaintainer: Example\nlimits: []\ncommand: ${JSON.stringify([process.execPath, script].map(shellQuote).join(" "))}\nfirst_input: true\npasses_model: true\n`
      + (mode === "named" || mode === "resume" ? "names_conversation: true\nresume: true\n" : mode === "record" ? "launch_result: true\n" : "");
    fs.writeFileSync(path.join(root, "synth.yaml"), preset);
    const tmux = new TmuxAdapter(async () => { throw new Error("No real terminal is used"); });
    const identity: Record<string, string> = { OPENRIG_NODE_ID: "owned", OPENRIG_SESSION_NAME: "owned@fixture", OPENRIG_RUNTIME: "synth" };
    vi.spyOn(tmux, "getPaneCommand").mockResolvedValue("powershell");
    vi.spyOn(tmux, "getSessionEnv").mockImplementation(async (_session, key) => identity[key]);
    const launch = new SeatLaunchEnvironment(tmux, { PATH: path.dirname(process.execPath), OPENRIG_HOME: path.join(root, "instance") }, root, cli, undefined, "win32");
    const sendShellCommand = vi.fn(async (_session: string, command: string, beforeInput?: () => void) => {
      beforeInput?.();
      execFileSync(path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
        { encoding: "utf8", windowsHide: true, timeout: 10000, stdio: "pipe", env: { ...process.env, OPENRIG_MODEL: "inherited", OPENRIG_FIRST_INPUT: "inherited-do-not-read" } });
      return { ok: true as const };
    });
    const adapter = new CommunityHarnessRuntimeAdapter("synth", { tmux: { hasSession: async () => true, getPaneCommand: async () => "node", sendShellCommand }, seatLaunchEnvironment: launch,
      presetsDir: () => root, launchResultRoot: () => path.join(root, "launch-results"), launchResultWait: { timeoutMs: 100, intervalMs: 10 } });
    const model = "owned/model 'quote' $value & % !", first = "owned first input\n'quote' & % !";
    const result = await adapter.launchHarness({ tmuxSession: "owned@fixture", ...(mode !== "model-cleared" ? { model } : {}) } as NodeBinding,
      { name: "owned@fixture", ...(mode !== "model-cleared" ? { firstInputText: first } : {}), ...(mode === "resume" ? { resumeToken: "owned-resume", resumeType: "community:synth" } : {}) });
    expect(result).toMatchObject({ ok: true });
    const received = JSON.parse(fs.readFileSync(output, "utf8"));
    expect(received.model).toBe(mode === "model-cleared" ? null : model);
    expect(received.first).toBe(mode === "model-cleared" ? null : first);
    if (mode === "named") expect(received.conversation).toBe(result.resumeToken);
    if (mode === "resume") expect(received.resume).toBe("owned-resume");
    if (mode === "record") { expect(received.attempt).toMatch(/^[0-9a-f-]+$/); expect(result.resumeToken).toBe("owned-conversation"); }
  } finally { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); }
}, 20000);
