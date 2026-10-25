import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import type { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

const CHILD = "11111111-1111-4111-8111-111111111111";
const PARENT = "22222222-2222-4222-8222-222222222222";
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(managed = false) {
  vi.stubEnv("OPENRIG_COMPACTION_OUT_ROOT", "/tmp/claude-compaction-restore");
  const root = mkdtempSync(path.join(tmpdir(), "restore-read-")); roots.push(root);
  const cwd = path.join(root, "project"), home = path.join(root, "instance");
  mkdirSync(cwd); mkdirSync(path.join(home, "compaction", "restore-pending"), { recursive: true });
  const marker = path.join(home, "compaction", "restore-pending", "owner@rig.json");
  writeFileSync(marker, JSON.stringify({ sessionName: "owner@rig", sessionId: CHILD }));
  const commands: string[] = [];
  const send = vi.fn(async (_seat: string, cmd: string) => { commands.push(cmd); return { ok: true }; });
  const tmux = { sendText: send, sendShellCommand: send,
    sendKeys: vi.fn(async () => ({ ok: true })) } as unknown as TmuxAdapter;
  const claudeManagedLaunch = { prepare: vi.fn(async () => ({
    command: (args: string[]) => `claude ${args.map(shellQuote).join(" ")}`, assertCurrent: () => {},
  })) } as unknown as ClaudeManagedLaunch;
  const adapter = new ClaudeCodeAdapter({ tmux, stateDir: home, sessionIdFactory: () => CHILD,
    ...(managed ? { claudeManagedLaunch } : {}),
    fsOps: { readFile: () => "", writeFile: () => {}, exists: () => false, mkdirp: () => {}, copyFile: () => {} } });
  // Only native readiness is replaced: these tests exercise the real command builders and shell argv.
  vi.spyOn(adapter as any, "verifyResumeLaunch").mockResolvedValue({ ok: true });
  const binding = { nodeId: "node", cwd, tmuxSession: "owner@rig", launchPosture: "floor", teamPermissionDefault: true, ...(managed ? { permissionMode: "acceptEdits" } : {}) } as NodeBinding;
  return { root, cwd, home, marker, commands, tmux, adapter, binding, claudeManagedLaunch };
}
function settings(command: string) {
  // No provider executable: a private shell function records its arguments with NUL separators.
  const args = execFileSync("/bin/sh", ["-c", `claude() { printf '%s\\0' "$@"; }; ${command}`], { encoding: "utf8" }).split("\0");
  expect(args.filter(x => x === "--settings")).toHaveLength(1);
  return JSON.parse(args[args.indexOf("--settings") + 1]!);
}

it.each([
  { kind: "fresh", managed: false }, { kind: "fork", managed: false }, { kind: "resume", managed: false },
  { kind: "fresh", managed: true }, { kind: "fork", managed: true }, { kind: "resume", managed: true },
])("$kind, explicit mode=$managed: command grants only the canonical seat files and launched conversation packet", async ({ kind, managed }) => {
  const f = fixture(managed);
  expect((await f.adapter.launchHarness(f.binding, { name: "owner@rig",
    ...(kind === "fork" ? { forkSource: { kind: "native_id" as const, value: PARENT } } : {}),
    ...(kind === "resume" ? { resumeToken: CHILD } : {}) })).ok).toBe(true);
  const allow = settings(f.commands[0]!).permissions.allow as string[];
  expect(allow.filter(rule => rule.startsWith("Read(") && rule !== "Read(./**)")).toEqual([
    `Read(/${f.marker})`,
    `Read(/${f.home}/plugins/openrig-core/skills/refocusing/SKILL.md)`,
    `Read(/${f.home}/plugins/openrig-core/skills/claude-compaction-restore/SKILL.md)`,
    `Read(/${f.home}/compaction/post-compact-extra/owner@rig.md)`,
    `Read(/${f.home}/compaction/preparation/owner@rig/*/RESTORE-MAP.md)`,
    `Read(/${f.cwd}/.openrig/compaction/preparation/owner@rig/*/RESTORE-MAP.md)`,
    ...["restore-instructions.md", "restore-summary.json", "transcript.txt", "transcript-narrative.txt", "touched-files.md"]
      .map(file => `Read(//tmp/claude-compaction-restore/${CHILD}-*/${file})`),
  ]);
});

it("runtime-switch command keys restore files to the canonical seat, not its staging session", async () => {
  const f = fixture(true);
  f.binding.tmuxSession = "openrig-switch-x";
  expect((await f.adapter.launchHarness(f.binding, { name: "owner@rig" })).ok).toBe(true);
  const allow = settings(f.commands[0]!).permissions.allow as string[];
  expect(allow).toContain(`Read(/${f.marker})`);
  expect(allow.some(rule => rule.includes("openrig-switch-x"))).toBe(false);
});

it.each([false, true])("legacy resume, explicit mode=%s: command keeps the exact marker allowance, launched conversation packet and permission mode", async managed => {
  const f = fixture(managed);
  const adapter = new ClaudeResumeAdapter(f.tmux, { openrigHome: f.home, ...(managed ? { claudeManagedLaunch: f.claudeManagedLaunch } : {}) });
  vi.spyOn(adapter as any, "verifyResume").mockResolvedValue({ ok: true });
  await adapter.resume("owner@rig", "claude_id", CHILD, f.cwd, "floor", undefined, managed ? "acceptEdits" : undefined, "node", undefined, undefined, false, true);
  const allow = settings(f.commands[0]!).permissions.allow as string[];
  expect(allow).toContain(`Read(/${f.marker})`);
  expect(allow).toContain(`Read(//tmp/claude-compaction-restore/${CHILD}-*/restore-instructions.md)`);
  expect(f.commands[0]).toMatch(/--permission-mode'? '?acceptEdits/);
});

it("keeps native deny/ask and hook settings while adding only this seat's restore reads", async () => {
  const { withManagedRestoreReads } = await import("../src/domain/managed-restore-read-access.js");
  const f = fixture();
  const original = { permissions: { allow: ["Read(./**)"], deny: [`Read(/${f.marker})`], ask: ["Read(//tmp/**)"] }, hooks: { PreToolUse: [] }, idleCompaction: false };
  const args = ["--settings", JSON.stringify(original)];
  const context = { openrigHome: f.home, session: "owner@rig", cwd: f.cwd, nativeSessionId: CHILD };
  const once = withManagedRestoreReads(args, context);
  const merged = JSON.parse(once[1]!);
  expect(merged.permissions.deny).toEqual(original.permissions.deny);
  expect(merged.permissions.ask).toEqual(original.permissions.ask);
  expect(merged.hooks).toEqual(original.hooks);
  expect(merged.idleCompaction).toBe(false);
  expect(withManagedRestoreReads(once, context)).toEqual(once);
  const legacy = JSON.parse(withManagedRestoreReads([], { ...context, nativeSessionId: "legacy name" })[1]!);
  expect(legacy.permissions.allow.some((rule: string) => rule.includes("claude-compaction-restore/legacy"))).toBe(false);
});
