import { expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { writeWindowsNodeFixture } from "../../../scripts/windows-node-fixture.mjs";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ownedWindowsTerminalInvoker } from "./helpers/windows-terminal-owned.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

const child = "11111111-1111-4111-8111-111111111111";
const parent = "22222222-2222-4222-8222-222222222222";

it.runIf(process.platform === "win32" && !!process.env.OPENRIG_TEST_PSMUX)("carries restore settings through an actual isolated stock psmux pane", async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), "claude pane restore [owned]-")));
  const invoke = ownedWindowsTerminalInvoker(root);
  const tmux = new TmuxAdapter(async () => { throw new Error("No POSIX transport"); }, undefined, invoke, "psmux");
  const session = `owned-restore-${process.pid}-${Date.now()}`;
  try {
    const home = path.join(root, "instance"), cwd = path.join(root, "seat's workspace");
    const userHome = path.join(root, "user home"), accountHome = path.join(root, "provider account");
    const daemonUserHome = path.join(root, "daemon user home");
    for (const dir of [home, cwd, userHome, accountHome, daemonUserHome]) fs.mkdirSync(dir);
    vi.stubEnv("HOME", daemonUserHome); vi.stubEnv("USERPROFILE", daemonUserHome);
    const output = path.join(root, "received.json"), script = path.join(root, "owned receiver.mjs"), cli = path.join(root, "rig.mjs");
    fs.writeFileSync(script, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({args:process.argv.slice(2),home:process.env.HOME,userProfile:process.env.USERPROFILE,accountHome:process.env.CLAUDE_CONFIG_DIR}));`);
    fs.writeFileSync(cli, "// inert CLI alias target");
    expect((await tmux.createSession(session, cwd, { OPENRIG_NODE_ID: "owned-node", OPENRIG_SESSION_NAME: session, OPENRIG_HOME: home,
      HOME: userHome, USERPROFILE: userHome })).ok).toBe(true);
    const environment = new SeatLaunchEnvironment(tmux, { ...invoke.environment, HOME: userHome, USERPROFILE: userHome, OPENRIG_HOME: home }, root, cli, undefined, "win32",
      (_node, runtime) => runtime === "claude-code" ? accountHome : undefined);
    const adapter = new ClaudeCodeAdapter({ tmux, stateDir: home, seatLaunchEnvironment: environment, sessionIdFactory: () => child,
      restoreReadPolicy: () => ({ extraInstructionFile: "~\\extra [owned].md" }),
      fsOps: { readFile: () => "", writeFile: () => {}, exists: () => false, mkdirp: () => {}, copyFile: () => {} } });
    const binding = { nodeId: "owned-node", cwd, tmuxSession: session, claudeExecutable: process.execPath, claudeScript: script,
      claudePermissions: { allow: ["Read(./work/**)"], deny: ["Read(./private/**)"] }, launchPosture: "floor", teamPermissionDefault: true } as NodeBinding;
    expect((await adapter.launchHarness(binding, { name: session })).ok).toBe(true);
    await expect.poll(() => fs.existsSync(output), { timeout: 8000 }).toBe(true);
    const received = JSON.parse(fs.readFileSync(output, "utf8"));
    expect(received).toMatchObject({ home: userHome, userProfile: userHome, accountHome });
    const argv: string[] = received.args;
    expect(argv.filter(value => value === "--settings")).toHaveLength(1);
    const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]!);
    expect(settings.permissions.deny).toEqual(["Read(./private/**)"]);
    expect(settings.permissions.allow).toContain("Read(./work/**)");
    const custom = path.join(userHome, "extra [owned].md").replaceAll("\\", "/").replaceAll("[", "\\[").replaceAll("]", "\\]");
    expect(settings.permissions.allow).toContain(`Read(/${custom})`);
    for (const otherHome of [home, accountHome, daemonUserHome]) {
      const wrong = path.join(otherHome, "extra [owned].md").replaceAll("\\", "/").replaceAll("[", "\\[").replaceAll("]", "\\]");
      expect(settings.permissions.allow).not.toContain(`Read(/${wrong})`);
    }
    expect(argv[argv.indexOf("--session-id") + 1]).toBe(child);
    expect((await tmux.probeSession(session)).state).toBe("present");
    expect(await tmux.killSession(session)).toEqual({ ok: true });
    expect((await tmux.probeSession(session)).state).toBe("absent");
  } finally {
    vi.unstubAllEnvs();
    await invoke(["tmux", "kill-session", "-t", `=${session}`]).catch(() => {});
    await invoke(["tmux", "kill-server"]).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 20000);

it.skipIf(process.platform !== "win32").each(["fresh", "fork", "resume", "legacy-resume", "script-fresh", "script-resume"] as const)(
  "native pinned Claude %s preserves restore settings through PowerShell", async scenario => {
    const kind = scenario.replace(/^script-/, "");
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), "claude restore [owned]-")));
    try {
      const cwd = path.join(root, "seat's workspace"), home = path.join(root, "instance");
      fs.mkdirSync(cwd); fs.mkdirSync(home);
      vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home);
      const script = scenario.startsWith("script-") ? path.join(root, "claude entry.mjs") : undefined;
      if (script) fs.writeFileSync(script, "console.log(JSON.stringify(process.argv.slice(2)));\n");
      const executable = script ? process.execPath
        : writeWindowsNodeFixture(root, "claude", "console.log(JSON.stringify(process.argv.slice(2)));");
      const cli = path.join(root, "rig.mjs"); fs.writeFileSync(cli, "// inert owned CLI alias target\n");
      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const env = { SystemRoot: systemRoot, WINDIR: systemRoot, OPENRIG_HOME: home,
        HOME: home, USERPROFILE: home, TEMP: root, TMP: root,
        PATH: [root, path.dirname(process.execPath), path.dirname(powershell), path.join(systemRoot, "System32")].join(path.delimiter) };
      const commands: string[] = [];
      const tmux = { getPaneCommand: async () => "powershell.exe",
        getSessionEnv: async (_session: string, name: string) => ({ OPENRIG_NODE_ID: "node", OPENRIG_SESSION_NAME: "owner@rig" }[name]),
        sendShellCommand: vi.fn(async (_session: string, command: string) => { commands.push(command); return { ok: true }; }),
        sendKeys: vi.fn(async () => ({ ok: true })),
      } as unknown as TmuxAdapter;
      const custom = path.join(home, "extra [owned].md");
      const prefixes = ["~\\", "${OPENRIG_HOME}\\", "$OPENRIG_HOME\\"];
      const configuredExtra = prefixes[["fresh", "fork", "resume", "legacy-resume", "script-fresh", "script-resume"].indexOf(scenario) % prefixes.length]! + "extra [owned].md";
      const seatLaunchEnvironment = new SeatLaunchEnvironment(tmux, env, root, cli, undefined, "win32");
      const adapter = new ClaudeCodeAdapter({ tmux, stateDir: home, sessionIdFactory: () => child,
        seatLaunchEnvironment,
        restoreReadPolicy: () => ({ extraInstructionFile: configuredExtra }),
        fsOps: { readFile: () => "", writeFile: () => {}, exists: () => false, mkdirp: () => {}, copyFile: () => {} } });
      // This checks command construction/OS execution, not provider readiness.
      vi.spyOn(adapter as any, "verifyResumeLaunch").mockResolvedValue({ ok: true });
      const binding = { nodeId: "node", cwd, tmuxSession: "owner@rig", claudeExecutable: executable,
        ...(script ? { claudeScript: script } : {}),
        claudePermissions: { allow: ["Read(./work/**)"], deny: ["Read(./private/**)"] },
        launchPosture: "floor", teamPermissionDefault: true } as NodeBinding;
      const legacy = new ClaudeResumeAdapter(tmux, { openrigHome: home, seatLaunchEnvironment,
        restoreReadPolicy: () => ({ extraInstructionFile: configuredExtra }) });
      vi.spyOn(legacy as any, "verifyResume").mockResolvedValue({ ok: true });
      const result = kind === "legacy-resume"
        ? await legacy.resume("owner@rig", "claude_id", child, cwd, "floor", undefined, undefined,
          "node", undefined, false, false, true, undefined, undefined, binding.claudePermissions, undefined, executable)
        : await adapter.launchHarness(binding, { name: "owner@rig",
        ...(kind === "fork" ? { forkSource: { kind: "native_id" as const, value: parent } } : {}),
        ...(kind === "resume" ? { resumeToken: child } : {}) });
      expect(result.ok).toBe(true); expect(commands).toHaveLength(1);
      const run = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
        Buffer.from("$ErrorActionPreference='Stop'; " + commands[0], "utf16le").toString("base64")],
      { env, cwd, encoding: "utf8", windowsHide: true, timeout: 15000 });
      expect(run.status, run.stderr).toBe(0);
      const argv: string[] = JSON.parse(run.stdout.trim());
      expect(argv.filter(value => value === "--settings")).toHaveLength(1);
      const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]!);
      expect(settings.permissions.allow).toContain("Read(./work/**)");
      expect(settings.permissions.deny).toEqual(["Read(./private/**)"]);
      const nativeHome = home.replaceAll("\\", "/").replaceAll("[", "\\[").replaceAll("]", "\\]");
      expect(settings.permissions.allow).toContain(`Read(/${nativeHome}/compaction/restore-pending/owner@rig.json)`);
      expect(settings.permissions.allow).toContain(`Read(/${nativeHome}/compaction/preparation/owner@rig/*/RESTORE-MAP.md)`);
      const customRule = custom.replaceAll("\\", "/").replaceAll("[", "\\[").replaceAll("]", "\\]");
      expect(settings.permissions.allow).toContain(`Read(/${customRule})`);
      expect(argv[argv.indexOf(kind === "fresh" ? "--session-id" : "--resume") + 1]).toBe(kind === "fork" ? parent : child);
      expect(argv.includes("--fork-session")).toBe(kind === "fork");
      expect(tmux.sendKeys).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); }
  }, 20000,
);
