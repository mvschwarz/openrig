import fs from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { withClaudeLaunchTelemetry } from "../src/adapters/claude-launch-telemetry.js";
import { operationalLaunchArgs } from "../src/adapters/kernel-authority.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { claudeActivityRelayPath, managedClaudeNodeCommand } from "../src/domain/claude-activity-hooks.js";

const fixtureRoots: string[] = [];
afterEach(() => { for (const root of fixtureRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-telemetry-"));
  fixtureRoots.push(root);
  const cwd = path.join(root, "project"), configDir = path.join(root, "user"), openrigHome = path.join(root, "state");
  fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
  fs.mkdirSync(configDir);
  const material = { cwd, configDir, openrigHome, session: "test@rig", collector: path.join(root, "collector.cjs"),
    relay: claudeActivityRelayPath(openrigHome), events: [{ event: "SessionStart", timeout: 5 }], throttleSeconds: null };
  const warnings: string[] = [];
  const local = path.join(cwd, ".claude", "settings.local.json");
  const compose = (args: string[] = []) => withClaudeLaunchTelemetry(args, material, warnings);
  const read = (args: string[]) => JSON.parse(args[args.indexOf("--settings") + 1]!);
  return { ...material, local, material, warnings, compose, read };
}

describe("Claude seat launch telemetry", () => {
  it("adds telemetry to one launch combining permissions, the hook bridge and managed compaction", () => {
    const f = fixture();
    const args = operationalLaunchArgs("claude-code", { teamPermissionDefault: true, managedCompaction: true, hookBridge: true });
    const prior = f.read(args);
    const composed = f.compose(args);
    expect(composed.filter(arg => arg === "--settings")).toHaveLength(1);
    expect(f.read(composed)).toMatchObject({ ...prior, statusLine: { type: "command", command: expect.stringContaining(f.collector) },
      hooks: { ...prior.hooks, SessionStart: [...prior.hooks.SessionStart, { hooks: [{ type: "command", command: expect.stringContaining(f.relay) }] }] } });
    expect(fs.existsSync(f.local)).toBe(false);
  });

  it.each(["user", "project", "local", "flag"] as const)("keeps a %s status line while preparing selected activity hooks", layer => {
    const f = fixture();
    const renderer = { statusLine: { type: "command", command: "printf '%s' user-renderer" } };
    const filename = layer === "flag" ? undefined : { user: path.join(f.configDir, "settings.json"), project: path.join(f.cwd, ".claude", "settings.json"),
      local: f.local }[layer];
    if (filename) fs.writeFileSync(filename, JSON.stringify(renderer));
    const result = f.read(f.compose(layer === "flag" ? ["--settings", JSON.stringify(renderer)] : []));
    expect(result.statusLine).toEqual(layer === "flag" ? renderer.statusLine : undefined);
    expect(result.hooks).toHaveProperty("SessionStart");
    if (filename) expect(fs.readFileSync(filename, "utf8")).toBe(JSON.stringify(renderer));
  });

  it("reuses an exact legacy hook command without changing the file older sessions read", () => {
    const f = fixture();
    const command = managedClaudeNodeCommand(process.execPath, f.relay).replace(/^exec /, "");
    const oldSettings = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] }, other: "keep" });
    fs.writeFileSync(f.local, oldSettings);
    expect(f.read(f.compose()).hooks.SessionStart[0].hooks[0].command).toEqual(command);
    expect(fs.readFileSync(f.local, "utf8")).toBe(oldSettings);
  });

  it("keeps a malformed project settings file and does not override an unreadable status-line choice", () => {
    const f = fixture();
    fs.writeFileSync(f.local, "{unparseable");
    expect(f.read(f.compose()).statusLine).toBeUndefined();
    expect(f.warnings.join(" ")).toContain("left the status line to Claude");
    expect(fs.readFileSync(f.local, "utf8")).toBe("{unparseable");
  });

  it.skipIf(process.platform === "win32")("leaves the status line alone when an enabled settings path is a FIFO", async () => {
    const f = fixture();
    const file = path.join(f.configDir, "settings.json");
    execFileSync("mkfifo", [file]);
    // A writer releases the old blocking reader so the regression fails without hanging the runner.
    const writer = spawn(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], '{}')", file], { stdio: "ignore" });
    const exited = once(writer, "close");
    try {
      const settings = f.read(f.compose());
      expect(settings.statusLine).toBeUndefined();
      expect(settings.hooks).toHaveProperty("SessionStart");
      expect(f.warnings).toEqual([expect.stringContaining("left the status line to Claude")]);
    } finally {
      writer.kill();
      await exited;
    }
  });

  it.skipIf(process.platform === "win32")("preserves a renderer reached through a regular settings symlink", () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.configDir, "renderer.json"), '{"statusLine":{"type":"command","command":"echo custom"}}');
    fs.symlinkSync("renderer.json", path.join(f.configDir, "settings.json"));
    expect(f.read(f.compose()).statusLine).toBeUndefined();
    expect(f.warnings).toEqual([]);
  });

  it.each([true, false])("handles an unreadable worktree root when local settings enabled is %s", localEnabled => {
    const f = fixture();
    const dotGit = path.join(f.cwd, ".git");
    fs.writeFileSync(dotGit, "gitdir: /main/.git/worktrees/project\n");
    const read = vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("unreadable fixture"), { code: "EACCES" });
    });
    try {
      const settings = f.read(f.compose(localEnabled ? [] : ["--setting-sources=user,project"]));
      expect(settings.hooks).toHaveProperty("SessionStart");
      if (localEnabled) {
        expect(read).toHaveBeenCalledWith(dotGit, "utf8");
        expect(settings.statusLine).toBeUndefined();
        expect(f.warnings).toEqual([expect.stringContaining("project root")]);
      } else {
        expect(read).not.toHaveBeenCalledWith(dotGit, "utf8");
        expect(settings.statusLine.command).toContain(f.collector);
        expect(f.warnings).toEqual([]);
      }
    } finally {
      read.mockRestore();
    }
  });

  it("does not skip the collector for a user settings source that the launch excluded", () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.configDir, "settings.json"), '{"statusLine":{"type":"command","command":"echo custom"}}');
    expect(f.read(f.compose(["--setting-sources=project,local"])).statusLine.command).toContain(f.collector);
  });

  it("replaces an earlier launch's own collector when the throttle selection changes", () => {
    const f = fixture();
    const prior = withClaudeLaunchTelemetry([], { ...f.material, throttleSeconds: 17 }, []);
    expect(f.read(prior).statusLine.command).toContain(" -lt 17 ");
    expect(f.read(f.compose(prior)).statusLine.command).toMatch(/^exec /);
  });

  it("composes telemetry into the captured settings on native resume", async () => {
    const f = fixture();
    const original = '{"custom":"kept"}';
    fs.writeFileSync(path.join(f.cwd, "operator.json"), original);
    const sendText = vi.fn(async (_session: string, _command: string) => ({ ok: false as const, message: "fixture stops before native dispatch" }));
    const adapter = new ClaudeResumeAdapter({ sendText } as unknown as TmuxAdapter, {
      openrigHome: f.openrigHome, launchTelemetry: async ({ args }) => f.compose(args),
    });
    await adapter.resume(f.session, "claude_id", "same", f.cwd, undefined, undefined, undefined, "node", undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, "/bin/claude", undefined, undefined,
      { args: ["--settings", "operator.json"], warnings: [] });
    const command = sendText.mock.calls[0]?.[1] ?? "";
    const file = /'(\/[^']*private-[a-f0-9]{64}\.json)'/.exec(command)?.[1];
    expect(file).toBeDefined();
    expect(JSON.parse(fs.readFileSync(file!, "utf8"))).toMatchObject({ custom: "kept",
      statusLine: { type: "command", command: expect.stringContaining(f.collector) }, hooks: { SessionStart: expect.any(Array) } });
    expect(command).toContain("'--resume' 'same'");
    expect(fs.readFileSync(path.join(f.cwd, "operator.json"), "utf8")).toBe(original);
  });

  it.each(["fresh", "fork"] as const)("sends managed telemetry through the %s launch entry point without project settings writes", async kind => {
    const f = fixture();
    const original = '{"user":"kept"}';
    fs.writeFileSync(f.local, original);
    const sendText = vi.fn(async (_session: string, _command: string) => ({ ok: true as const }));
    const adapter = new ClaudeCodeAdapter({ tmux: { sendText, sendKeys: async () => ({ ok: true as const }) } as unknown as TmuxAdapter,
      fsOps: { readFile: file => fs.readFileSync(file, "utf8"), writeFile: fs.writeFileSync, copyFile: fs.copyFileSync,
        exists: fs.existsSync, mkdirp: dir => { fs.mkdirSync(dir, { recursive: true }); } },
      stateDir: f.openrigHome, collectorAssetPath: f.collector,
      launchTelemetry: async ({ args }) => f.compose(args) });
    const binding = { id: "bind", nodeId: "node", cwd: f.cwd, tmuxSession: f.session };
    await adapter.deliverStartup([], binding);
    expect(await adapter.launchHarness(binding, { name: f.session,
      ...(kind === "fork" ? { forkSource: { kind: "native_id" as const, value: "parent" } } : {}) })).toMatchObject({ ok: true });
    expect(sendText.mock.calls[0]?.[1]).toContain(f.collector);
    expect(sendText.mock.calls[0]?.[1]).toContain(f.relay);
    expect(fs.readFileSync(f.local, "utf8")).toBe(original);
    expect(fs.existsSync(path.join(f.cwd, ".openrig", "context-collector.cjs"))).toBe(false);
  });
});
