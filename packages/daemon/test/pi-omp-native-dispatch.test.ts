import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { PiRuntimeAdapter } from "../src/adapters/pi-runtime-adapter.js";
import { OmpRuntimeAdapter } from "../src/adapters/omp-runtime-adapter.js";
import { PiResumeAdapter } from "../src/adapters/pi-resume.js";
import { OmpResumeAdapter } from "../src/adapters/omp-resume.js";
import { piSeatPaths } from "../src/adapters/pi-runner-protocol.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

it.runIf(process.platform === "win32").each([["pi", false], ["omp", false], ["pi", true]] as const)("dispatches native %s fresh and resume commands without POSIX quoting (route refusal: %s)", async (runtime, routed) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-native-"));
  try {
    const cwd = path.join(root, "working '用户 & space");
    fs.mkdirSync(cwd);
    const session = "owned@fixture", stateRoot = path.join(root, "state");
    const seat = piSeatPaths(stateRoot, session);
    const sessionFile = path.join(root, "owned session.jsonl");
    fs.writeFileSync(sessionFile, "owned synthetic history");
    const entry = path.join(cwd, "owned runner.cjs"), argvFile = path.join(root, "argv.json");
    fs.writeFileSync(entry, `const fs=require('fs'),a=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(argvFile)},JSON.stringify(a));fs.writeFileSync(${JSON.stringify(seat.runnerStatePath)},JSON.stringify({ready:true,updatedAt:new Date().toISOString(),launchId:a[a.indexOf('--launch-id')+1],sessionFile:${JSON.stringify(sessionFile)}}));`);
    const tmux = { sendShellCommand: async (_target: string, command: string) => {
      if (command === "owned-unroutable-command") return { ok: false, code: "launch_path_too_long" };
      execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 10000 });
      return { ok: true };
    } } as unknown as TmuxAdapter;
    const io = { exists: fs.existsSync, readFile: (file: string) => fs.readFileSync(file, "utf8"), writeFile: (file: string, text: string) => fs.writeFileSync(file, text), mkdirp: (dir: string) => { fs.mkdirSync(dir, { recursive: true }); } };
    const Adapter = runtime === "pi" ? PiRuntimeAdapter : OmpRuntimeAdapter;
    const Resume = runtime === "pi" ? PiResumeAdapter : OmpResumeAdapter;
    const model = "fixture/model ' & 用户";
    const seatLaunchEnvironment = routed ? { command: async () => "owned-unroutable-command" } as never : undefined;
    const adapter = new Adapter({ platform: "win32", tmux, fsOps: io, stateRoot, runnerEntryPath: entry, newLaunchId: () => "owned-fresh", seatLaunchEnvironment });
    const fresh = await adapter.launchHarness({ tmuxSession: session, cwd, model, launchPosture: "floor" } as NodeBinding, { name: session });
    expect(fresh, JSON.stringify(fresh)).toMatchObject({ ok: true, resumeToken: sessionFile });
    let args: string[] = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    expect(args[args.indexOf("--cwd") + 1]).toBe(cwd);
    expect(args[args.indexOf("--model") + 1]).toBe(model);
    const resume = new Resume(tmux, io, { stateRoot, runnerEntryPath: entry }, { newLaunchId: () => "owned-resume", seatLaunchEnvironment });
    expect(await resume.resume(session, `${runtime}_session_file`, sessionFile, cwd, model, "floor")).toMatchObject({ ok: true });
    args = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    expect(args[args.indexOf("--session") + 1]).toBe(sessionFile);
    expect(args[args.indexOf("--launch-id") + 1]).toBe("owned-resume");
    expect(args.includes("--runtime")).toBe(runtime === "omp");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
