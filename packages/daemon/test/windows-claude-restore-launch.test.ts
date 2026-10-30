import { expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { writeWindowsNodeFixture } from "../../../scripts/windows-node-fixture.mjs";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

const child = "11111111-1111-4111-8111-111111111111";
const parent = "22222222-2222-4222-8222-222222222222";

it.skipIf(process.platform !== "win32").each(["fresh", "fork", "resume", "legacy-resume", "script-fresh", "script-resume"] as const)(
  "native pinned Claude %s preserves restore settings through PowerShell", async scenario => {
    const kind = scenario.replace(/^script-/, "");
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), "claude restore [owned]-")));
    try {
      const cwd = path.join(root, "seat's workspace"), home = path.join(root, "instance");
      fs.mkdirSync(cwd); fs.mkdirSync(home);
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
      const custom = path.join(root, "extra [owned].md");
      const seatLaunchEnvironment = new SeatLaunchEnvironment(tmux, env, root, cli, undefined, "win32");
      const adapter = new ClaudeCodeAdapter({ tmux, stateDir: home, sessionIdFactory: () => child,
        seatLaunchEnvironment,
        restoreReadPolicy: () => ({ extraInstructionFile: custom }),
        fsOps: { readFile: () => "", writeFile: () => {}, exists: () => false, mkdirp: () => {}, copyFile: () => {} } });
      // This checks command construction/OS execution, not provider readiness.
      vi.spyOn(adapter as any, "verifyResumeLaunch").mockResolvedValue({ ok: true });
      const binding = { nodeId: "node", cwd, tmuxSession: "owner@rig", claudeExecutable: executable,
        ...(script ? { claudeScript: script } : {}),
        claudePermissions: { allow: ["Read(./work/**)"], deny: ["Read(./private/**)"] },
        launchPosture: "floor", teamPermissionDefault: true } as NodeBinding;
      const legacy = new ClaudeResumeAdapter(tmux, { openrigHome: home, seatLaunchEnvironment,
        restoreReadPolicy: () => ({ extraInstructionFile: custom }) });
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
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 20000,
);
