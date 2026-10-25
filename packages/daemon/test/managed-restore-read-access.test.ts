import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
/** A directory's two spellings, as Claude Code checks a read through a symlink: as given, and where it resolves (macOS's
 *  /tmp is /private/tmp). The same when nothing on the way is a link. */
function spellings(dir: string): string[] {
  let real = dir; const rest: string[] = [];
  for (;;) {
    try { real = path.join(realpathSync.native(real), ...rest); break; }
    catch { rest.unshift(path.basename(real)); real = path.dirname(real); }
  }
  return [...new Set([path.resolve(dir), real])];
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
    ...spellings(f.home).flatMap(home => [
      `Read(/${home}/compaction/restore-pending/owner@rig.json)`,
      `Read(/${home}/plugins/openrig-core/skills/refocusing/SKILL.md)`,
      `Read(/${home}/plugins/openrig-core/skills/claude-compaction-restore/SKILL.md)`,
      `Read(/${home}/compaction/post-compact-extra/owner@rig.md)`,
      `Read(/${home}/compaction/post-compact-extra.md)`,
      `Read(/${home}/compaction/preparation/owner@rig/*/RESTORE-MAP.md)`,
    ]),
    ...spellings(f.cwd).map(cwd => `Read(/${cwd}/.openrig/compaction/preparation/owner@rig/*/RESTORE-MAP.md)`),
    ...spellings("/tmp/claude-compaction-restore").flatMap(packets =>
      ["restore-instructions.md", "restore-summary.json", "transcript.txt", "transcript-narrative.txt", "touched-files.md"]
        .map(file => `Read(/${packets}/${CHILD}-*/${file})`)),
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

it("grants each restore file both where it's named and where it resolves, when a directory on the way is a symlink", async () => {
  // Claude Code applies an allow rule to a read through a symlink only when the requested path and the file it resolves to
  // both match, so a Mac seat (whose /tmp is /private/tmp) or a symlinked home or project needs both spellings.
  const { withManagedRestoreReads } = await import("../src/domain/managed-restore-read-access.js");
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "restore-link-"))); roots.push(root);
  for (const dir of ["home", "project", "packets"]) mkdirSync(path.join(root, `real-${dir}`));
  for (const dir of ["home", "project", "packets"]) symlinkSync(path.join(root, `real-${dir}`), path.join(root, dir));
  // The packet root may not exist yet at launch: it keeps its name under the nearest real parent.
  vi.stubEnv("OPENRIG_COMPACTION_OUT_ROOT", path.join(root, "packets", "not-yet"));
  const allow = JSON.parse(withManagedRestoreReads([], { openrigHome: path.join(root, "home"), session: "owner@rig",
    cwd: path.join(root, "project"), nativeSessionId: CHILD })[1]!).permissions.allow as string[];
  for (const [named, real] of [["home", "real-home"], ["project", "real-project"]] as const) {
    const rule = named === "home" ? "compaction/restore-pending/owner@rig.json" : ".openrig/compaction/preparation/owner@rig/*/RESTORE-MAP.md";
    expect(allow).toContain(`Read(/${root}/${named}/${rule})`);
    expect(allow).toContain(`Read(/${root}/${real}/${rule})`);
  }
  expect(allow).toContain(`Read(/${root}/packets/not-yet/${CHILD}-*/restore-instructions.md)`);
  expect(allow).toContain(`Read(/${root}/real-packets/not-yet/${CHILD}-*/restore-instructions.md)`);
  // Every grant stays inside the fixture at either spelling.
  expect(allow.every(rule => rule.startsWith(`Read(/${root}/`))).toBe(true);
});

it("grants the generic post-compact-extra.md and the configured extra file and preparation root the restore reads", async () => {
  // With no per-seat file, the restore request names the global extra (policies.claude_compaction.message_file_path,
  // by default <home>/compaction/post-compact-extra.md), even before it exists; with policies.claude_compaction.preparation_root
  // set, the restore map lives under that root. Reading either must not stop at an approval.
  const { withManagedRestoreReads } = await import("../src/domain/managed-restore-read-access.js");
  const f = fixture();
  const allowOf = (policy: { extraInstructionFile?: string; preparationRoot?: string } = {}) => JSON.parse(withManagedRestoreReads([],
    { openrigHome: f.home, session: "owner@rig", cwd: f.cwd, nativeSessionId: CHILD, ...policy })[1]!).permissions.allow as string[];
  for (const home of spellings(f.home)) expect(allowOf()).toContain(`Read(/${home}/compaction/post-compact-extra.md)`);
  const custom = path.join(f.root, "elsewhere", "team-restore.md");
  const prep = path.join(f.root, "maps");
  const allow = allowOf({ extraInstructionFile: custom, preparationRoot: prep });
  for (const dir of spellings(path.dirname(custom))) expect(allow).toContain(`Read(/${dir}/team-restore.md)`);
  for (const dir of spellings(prep)) expect(allow).toContain(`Read(/${dir}/owner@rig/*/RESTORE-MAP.md)`);
  // Exact files only: nothing else in that directory, and no other seat's maps.
  expect(allow.some(rule => rule.includes("/elsewhere/") && !rule.endsWith("/team-restore.md)"))).toBe(false);
  expect(allow.some(rule => rule.includes("/maps/") && !rule.includes("/maps/owner@rig/"))).toBe(false);
});

// A Read(//abs) rule as a whole-path pattern: `*` is one path segment, `\x` is a literal x.
const ruleRegex = (rule: string) => new RegExp(`^${rule.slice("Read(/".length, -1).replace(/\\(.)|\*|([.+?^${}()|[\]])/g,
  (_m, lit, meta) => lit !== undefined ? lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : meta !== undefined ? `\\${meta}` : "[^/]*")}$`);

it.each([
  { name: "default settings" },
  { name: "a configured extra file and preparation root", configured: true },
  { name: "a configured extra file that is a symlink to a file elsewhere", configured: true, link: true },
  { name: "a configured extra file set with outer whitespace", configured: true, padded: true },
])("$name: every file the restore request names is granted where it's named and where it resolves", async ({ configured, link, padded }) => {
  // Parity with the enforcer's own restore request, so a resolver fallback added without a grant fails here rather than at a
  // native approval. The JSONL fallback is left out: the request names it only when the marker and the map are both missing.
  const { withManagedRestoreReads } = await import("../src/domain/managed-restore-read-access.js");
  const { buildPostCompactRestorePrompt } = await import("../src/domain/claude-compaction-enforcer.js");
  vi.stubEnv("OPENRIG_COMPACTION_OUT_ROOT", "/tmp/claude-compaction-restore");
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "restore-parity-"))); roots.push(root);
  const home = path.join(root, "home"), cwd = path.join(root, "project"), prep = configured ? path.join(root, "maps") : null;
  const extra = configured ? path.join(root, "elsewhere", "team-restore.md") : path.join(home, "compaction", "post-compact-extra.md");
  if (link) {
    mkdirSync(path.join(root, "shared")); writeFileSync(path.join(root, "shared", "context.md"), "");
    mkdirSync(path.dirname(extra)); symlinkSync(path.join(root, "shared", "context.md"), extra);
  }
  const setting = configured ? (padded ? `  ${extra}\n` : extra) : null;
  const map = path.join(prep ?? path.join(home, "compaction", "preparation"), "owner@rig", "att-1", "RESTORE-MAP.md");
  // The request names the setting trimmed.
  const prompt = buildPostCompactRestorePrompt({ sessionName: "owner@rig", openrigHome: home, attemptMapPath: map, sessionId: CHILD,
    postCompactInstructionFilePath: setting ?? extra });
  const named = [...prompt.matchAll(/(\/[^\s;,]+?)(?=[.;,]?(?:\s|$))/g)].map(m => m[1]!).filter(p => p.startsWith(root));
  const allow = (JSON.parse(withManagedRestoreReads([], { openrigHome: home, session: "owner@rig", cwd, nativeSessionId: CHILD,
    extraInstructionFile: setting, preparationRoot: prep })[1]!).permissions.allow as string[]).filter(rule => rule.startsWith("Read(/"));
  expect(named).toContain(extra);
  expect(named.length).toBeGreaterThanOrEqual(4);
  // Claude Code needs both the path read and the file it resolves to.
  expect(named.flatMap(spellings).filter(p => !allow.some(rule => ruleRegex(rule).test(p)))).toEqual([]);
  // Exact files only: the link's target and nothing beside it, and nothing outside the fixture but the packet root.
  expect(allow.filter(rule => rule.startsWith(`Read(/${root}/shared/`))).toEqual(link ? [`Read(/${root}/shared/context.md)`] : []);
  expect(allow.filter(rule => !rule.startsWith(`Read(/${root}/`) && !rule.includes("/claude-compaction-restore/"))).toEqual([]);
});

it("both Claude launch paths grant the configured extra file the restore will name", async () => {
  const f = fixture();
  const custom = path.join(f.root, "elsewhere", "team-restore.md");
  const restoreReadPolicy = () => ({ extraInstructionFile: custom, preparationRoot: null });
  const adapter = new ClaudeCodeAdapter({ tmux: f.tmux, stateDir: f.home, sessionIdFactory: () => CHILD, restoreReadPolicy,
    fsOps: { readFile: () => "", writeFile: () => {}, exists: () => false, mkdirp: () => {}, copyFile: () => {} } });
  vi.spyOn(adapter as any, "verifyResumeLaunch").mockResolvedValue({ ok: true });
  expect((await adapter.launchHarness(f.binding, { name: "owner@rig" })).ok).toBe(true);
  expect(settings(f.commands.at(-1)!).permissions.allow).toContain(`Read(/${spellings(path.dirname(custom))[0]}/team-restore.md)`);
  const resume = new ClaudeResumeAdapter(f.tmux, { openrigHome: f.home, restoreReadPolicy });
  vi.spyOn(resume as any, "verifyResume").mockResolvedValue({ ok: true });
  await resume.resume("owner@rig", "claude_id", CHILD, f.cwd, "floor", undefined, undefined, "node", undefined, undefined, false, true);
  expect(settings(f.commands.at(-1)!).permissions.allow).toContain(`Read(/${spellings(path.dirname(custom))[0]}/team-restore.md)`);
});
