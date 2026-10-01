// Hermetic tests for the Cursor runtime adapter. No live Cursor: command
// construction, isolation env, guidance/skill targets and readiness are
// fake-backed. The live legs are the native-proof task.

import nodePath from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { describe, it, expect, vi } from "vitest";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import {
  CursorRuntimeAdapter, buildCursorLaunchCommand, runCreateChat, cursorSeatConfigDir, resetCursorSeatApprovalMode,
  readCursorChatLaunch, writeCursorChatLaunch, type CursorAdapterFsOps,
} from "../src/adapters/cursor-runtime-adapter.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { ProjectionEntry, ProjectionPlan } from "../src/domain/projection-planner.js";

const STATE_ROOT = "/openrig-home/state/cursor";
const CHAT_ID = "167733b3-080d-4eb0-a30a-7d22c40b5195";

function mockTmux(overrides: Partial<Record<keyof TmuxAdapter, unknown>> = {}) {
  return {
    sendShellCommand: vi.fn(async (): Promise<TmuxResult> => ({ ok: true })),
    sendText: vi.fn(async (): Promise<TmuxResult> => ({ ok: true })),
    sendKeys: vi.fn(async (): Promise<TmuxResult> => ({ ok: true })),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "cursor-agent"),
    capturePaneContent: vi.fn(async () => ""),
    ...overrides,
  } as unknown as TmuxAdapter & { sendShellCommand: ReturnType<typeof vi.fn>; sendText: ReturnType<typeof vi.fn>; sendKeys: ReturnType<typeof vi.fn> };
}

function memFs(files: Record<string, string> = {}): CursorAdapterFsOps & { files: Record<string, string>; dirs: Set<string> } {
  const dirs = new Set<string>();
  return {
    files, dirs,
    readFile: (p) => { if (!(p in files)) throw new Error(`ENOENT: ${p}`); return files[p]!; },
    writeFile: (p, c) => { files[p] = c; },
    exists: (p) => p in files || dirs.has(p),
    mkdirp: (p) => { dirs.add(p); },
    listFiles: () => [],
  };
}

function binding(over: Partial<NodeBinding> = {}): NodeBinding {
  return { nodeId: "node-1", tmuxSession: "review-cursor@skill-library", cwd: "/work/repo", ...over } as NodeBinding;
}

function adapter(over: { tmux?: TmuxAdapter; fs?: CursorAdapterFsOps; createChat?: () => Promise<string> } = {}) {
  return new CursorRuntimeAdapter({
    tmux: over.tmux ?? mockTmux(),
    fsOps: over.fs ?? memFs(),
    stateRoot: STATE_ROOT,
    createChat: over.createChat ?? (async () => CHAT_ID),
    sleep: async () => {},
  });
}

describe("buildCursorLaunchCommand", () => {
  it("isolates config, resumes the chat, trusts the cwd and applies model and approval", () => {
    expect(buildCursorLaunchCommand({ chatId: CHAT_ID, configDir: "/s/node-1", model: "grok-4.7-high", approvalArg: " --auto-review" }))
      .toBe(`exec env CURSOR_CONFIG_DIR='/s/node-1' cursor-agent --resume '${CHAT_ID}' --trust --model 'grok-4.7-high' --auto-review`);
  });
  it("omits --model when none is set and pins PATH when given", () => {
    expect(buildCursorLaunchCommand({ chatId: CHAT_ID, configDir: "/s/n", approvalArg: "", launchPath: "/usr/bin" }))
      .toBe(`exec env PATH='/usr/bin' CURSOR_CONFIG_DIR='/s/n' cursor-agent --resume '${CHAT_ID}' --trust`);
  });
});

describe("CursorRuntimeAdapter.launchHarness", () => {
  it("creates a chat for a fresh seat and returns it as the resume token", async () => {
    const tmux = mockTmux();
    const createChat = vi.fn(async () => `${CHAT_ID}\n`);
    const result = await adapter({ tmux, createChat }).launchHarness(binding({ model: "grok-4.7-high" }), { name: "review-cursor@skill-library" });
    expect(result).toEqual({ ok: true, resumeToken: CHAT_ID, resumeType: "cursor_chat_id" });
    expect(createChat).toHaveBeenCalledWith(expect.objectContaining({ configDir: cursorSeatConfigDir(STATE_ROOT, "node-1"), cwd: "/work/repo" }));
    expect(tmux.sendShellCommand.mock.calls[0]![1]).toContain(`--resume '${CHAT_ID}'`);
    expect(tmux.sendShellCommand.mock.calls[0]![1]).toContain(`CURSOR_CONFIG_DIR='${nodePath.join(STATE_ROOT, "node-1")}'`);
  });

  it("resumes an existing chat without creating a new one", async () => {
    const createChat = vi.fn(async () => "other");
    const result = await adapter({ createChat }).launchHarness(binding(), { name: "s", resumeToken: CHAT_ID });
    expect(createChat).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, resumeToken: CHAT_ID });
  });

  it("maps the auto_review native mode to --auto-review", async () => {
    const tmux = mockTmux();
    await adapter({ tmux }).launchHarness(binding({ permissionMode: "auto_review" }), { name: "s", resumeToken: CHAT_ID });
    expect(tmux.sendShellCommand.mock.calls[0]![1]).toMatch(/ --auto-review$/);
  });

  it("fails clearly when create-chat fails, without launching", async () => {
    const tmux = mockTmux();
    const result = await adapter({ tmux, createChat: async () => { throw new Error("not logged in"); } }).launchHarness(binding(), { name: "s" });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toMatch(/create-chat failed: not logged in/);
    expect(tmux.sendShellCommand).not.toHaveBeenCalled();
  });

  it("refuses a create-chat result that is not a chat id", async () => {
    const result = await adapter({ createChat: async () => "Error: something; rm -rf" }).launchHarness(binding(), { name: "s" });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toMatch(/unusable chat id/);
  });

  it("returns ok:false without launching when the seat config dir cannot be created", async () => {
    const tmux = mockTmux();
    const fs = memFs();
    fs.mkdirp = () => { throw new Error("EACCES: permission denied, mkdir '/openrig-home/state/cursor/node-1'"); };
    const createChat = vi.fn(async () => CHAT_ID);
    const result = await adapter({ tmux, fs, createChat }).launchHarness(binding(), { name: "s" });
    expect(result).toEqual({ ok: false, error: "cursor: could not create the seat config dir: EACCES: permission denied, mkdir '/openrig-home/state/cursor/node-1'" });
    expect(createChat).not.toHaveBeenCalled();
    expect(tmux.sendShellCommand).not.toHaveBeenCalled();
  });

  it("returns ok:false without launching for a permission mode Cursor does not have", async () => {
    const tmux = mockTmux();
    const result = await adapter({ tmux }).launchHarness(binding({ permissionMode: "plan" }), { name: "s", resumeToken: CHAT_ID });
    expect(result).toEqual({ ok: false, error: "Invalid Cursor permission mode 'plan'" });
    expect(tmux.sendShellCommand).not.toHaveBeenCalled();
  });

  it("returns ok:false when the launch command cannot be sent", async () => {
    const tmux = mockTmux({ sendShellCommand: vi.fn(async (): Promise<TmuxResult> => ({ ok: false, code: "send_failed", message: "pane gone" } as TmuxResult)) });
    const result = await adapter({ tmux }).launchHarness(binding(), { name: "s", resumeToken: CHAT_ID });
    expect(result).toEqual({ ok: false, error: "Failed to send launch command: pane gone" });
  });

  it("refuses resume and fork together, and fork alone", async () => {
    expect(await adapter().launchHarness(binding(), { name: "s", resumeToken: CHAT_ID, forkSource: { kind: "native_id", value: "x" } }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/mutually exclusive/) });
    expect(await adapter().launchHarness(binding(), { name: "s", forkSource: { kind: "native_id", value: "x" } }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/not supported/) });
  });
});

describe("Cursor chat launch sidecar (per-chat approval mode)", () => {
  const SEAT_DIR = cursorSeatConfigDir(STATE_ROOT, "node-1");
  const SIDECAR = nodePath.join(SEAT_DIR, "openrig-chat-launch.json");
  const NEW_CHAT = "9a1f0c2e-1111-4222-8333-444455556666";
  const sidecar = (chatId: string, approvalArg: string) => JSON.stringify({ chatId, approvalArg });

  it("starts a fresh chat when the seat drops from auto_review to floor", async () => {
    const fs = memFs({ [SIDECAR]: sidecar(CHAT_ID, " --auto-review") });
    const tmux = mockTmux();
    const createChat = vi.fn(async () => NEW_CHAT);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await adapter({ fs, tmux, createChat }).launchHarness(binding({ launchPosture: "floor" }), { name: "s", resumeToken: CHAT_ID });
      expect(result).toEqual({ ok: true, resumeToken: NEW_CHAT, resumeType: "cursor_chat_id" });
      expect(createChat).toHaveBeenCalledWith(expect.objectContaining({ configDir: SEAT_DIR, cwd: "/work/repo" }));
      const cmd = tmux.sendShellCommand.mock.calls[0]![1] as string;
      expect(cmd).toContain(`--resume '${NEW_CHAT}'`);
      expect(cmd).not.toContain(CHAT_ID);
      expect(cmd).not.toContain("--auto-review");
      expect(JSON.parse(fs.files[SIDECAR]!)).toEqual({ chatId: NEW_CHAT, approvalArg: "" });
      const logged = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain(`[openrig] cursor: permission mode changed since chat ${CHAT_ID.slice(0, 8)}…; starting a fresh chat so the new mode applies`);
      expect(logged).not.toContain(CHAT_ID);
    } finally {
      log.mockRestore();
    }
  });

  it("starts a fresh chat when the seat drops from full_bypass to floor", async () => {
    const fs = memFs({ [SIDECAR]: sidecar(CHAT_ID, " --force") });
    const createChat = vi.fn(async () => NEW_CHAT);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await adapter({ fs, createChat }).launchHarness(binding({ launchPosture: "floor" }), { name: "s", resumeToken: CHAT_ID });
      expect(result).toEqual({ ok: true, resumeToken: NEW_CHAT, resumeType: "cursor_chat_id" });
      expect(createChat).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fs.files[SIDECAR]!)).toEqual({ chatId: NEW_CHAT, approvalArg: "" });
    } finally {
      log.mockRestore();
    }
  });

  it("resumes the chat when its approval arg is unchanged", async () => {
    const fs = memFs({ [SIDECAR]: sidecar(CHAT_ID, " --auto-review") });
    const tmux = mockTmux();
    const createChat = vi.fn(async () => NEW_CHAT);
    const result = await adapter({ fs, tmux, createChat }).launchHarness(binding({ permissionMode: "auto_review" }), { name: "s", resumeToken: CHAT_ID });
    expect(result).toEqual({ ok: true, resumeToken: CHAT_ID, resumeType: "cursor_chat_id" });
    expect(createChat).not.toHaveBeenCalled();
    expect(tmux.sendShellCommand.mock.calls[0]![1]).toContain(`--resume '${CHAT_ID}'`);
    expect(JSON.parse(fs.files[SIDECAR]!)).toEqual({ chatId: CHAT_ID, approvalArg: " --auto-review" });
  });

  it("resumes and writes the sidecar when none exists", async () => {
    const fs = memFs();
    const createChat = vi.fn(async () => NEW_CHAT);
    const result = await adapter({ fs, createChat }).launchHarness(binding({ launchPosture: "floor" }), { name: "s", resumeToken: CHAT_ID });
    expect(result).toMatchObject({ ok: true, resumeToken: CHAT_ID });
    expect(createChat).not.toHaveBeenCalled();
    expect(JSON.parse(fs.files[SIDECAR]!)).toEqual({ chatId: CHAT_ID, approvalArg: "" });
  });

  it("resumes when the sidecar names a different chat", async () => {
    const fs = memFs({ [SIDECAR]: sidecar(NEW_CHAT, " --auto-review") });
    const createChat = vi.fn(async () => NEW_CHAT);
    const result = await adapter({ fs, createChat }).launchHarness(binding({ launchPosture: "floor" }), { name: "s", resumeToken: CHAT_ID });
    expect(result).toMatchObject({ ok: true, resumeToken: CHAT_ID });
    expect(createChat).not.toHaveBeenCalled();
    expect(JSON.parse(fs.files[SIDECAR]!)).toEqual({ chatId: CHAT_ID, approvalArg: "" });
  });

  it("records the approval arg of a fresh launch", async () => {
    const fs = memFs();
    await adapter({ fs }).launchHarness(binding({ permissionMode: "auto_review" }), { name: "s" });
    expect(JSON.parse(fs.files[SIDECAR]!)).toEqual({ chatId: CHAT_ID, approvalArg: " --auto-review" });
  });

  it("treats an unparseable or malformed sidecar as missing", () => {
    for (const content of ["{ broken", "[1]", "null", JSON.stringify({ chatId: 5, approvalArg: "" }), JSON.stringify({ chatId: CHAT_ID })]) {
      expect(readCursorChatLaunch(memFs({ [SIDECAR]: content }), SEAT_DIR)).toBeNull();
    }
    expect(readCursorChatLaunch(memFs(), SEAT_DIR)).toBeNull();
    const fs = memFs();
    writeCursorChatLaunch(fs, SEAT_DIR, { chatId: CHAT_ID, approvalArg: " --force" });
    expect(readCursorChatLaunch(fs, SEAT_DIR)).toEqual({ chatId: CHAT_ID, approvalArg: " --force" });
  });
});

describe("Cursor seat approval mode reset", () => {
  const CONFIG = nodePath.join(cursorSeatConfigDir(STATE_ROOT, "node-1"), "cli-config.json");
  const persisted = () => JSON.stringify({ version: 1, approvalMode: "auto-review", model: { modelId: "grok-4.7-high" }, permissions: { allow: ["Shell(ls)"] } }, null, 2);

  it("rewrites a persisted auto-review back to allowlist on a floor launch, keeping every other key", async () => {
    const fs = memFs({ [CONFIG]: persisted() });
    const tmux = mockTmux();
    const result = await adapter({ fs, tmux }).launchHarness(binding(), { name: "s", resumeToken: CHAT_ID });
    expect(result).toMatchObject({ ok: true });
    expect(JSON.parse(fs.files[CONFIG]!)).toEqual({ version: 1, approvalMode: "allowlist", model: { modelId: "grok-4.7-high" }, permissions: { allow: ["Shell(ls)"] } });
    expect(tmux.sendShellCommand.mock.calls[0]![1]).not.toContain("--auto-review");
  });

  it("leaves the config alone on an auto_review launch", async () => {
    const fs = memFs({ [CONFIG]: persisted() });
    const writeFile = vi.spyOn(fs, "writeFile");
    await adapter({ fs }).launchHarness(binding({ permissionMode: "auto_review" }), { name: "s", resumeToken: CHAT_ID });
    expect(fs.files[CONFIG]).toBe(persisted());
    expect(writeFile).not.toHaveBeenCalledWith(CONFIG, expect.anything());
  });

  it("does not write when the config is missing", () => {
    const fs = memFs();
    const writeFile = vi.spyOn(fs, "writeFile");
    resetCursorSeatApprovalMode(fs, cursorSeatConfigDir(STATE_ROOT, "node-1"));
    expect(writeFile).not.toHaveBeenCalled();
    expect(fs.files[CONFIG]).toBeUndefined();
  });

  it("does not write when the config is unparseable or not an object", () => {
    for (const content of ["{ broken", "[1,2]", "null"]) {
      const fs = memFs({ [CONFIG]: content });
      const writeFile = vi.spyOn(fs, "writeFile");
      resetCursorSeatApprovalMode(fs, cursorSeatConfigDir(STATE_ROOT, "node-1"));
      expect(writeFile).not.toHaveBeenCalled();
      expect(fs.files[CONFIG]).toBe(content);
    }
  });

  it("does not rewrite a config already at allowlist", () => {
    const content = JSON.stringify({ approvalMode: "allowlist", model: "x" });
    const fs = memFs({ [CONFIG]: content });
    const writeFile = vi.spyOn(fs, "writeFile");
    resetCursorSeatApprovalMode(fs, cursorSeatConfigDir(STATE_ROOT, "node-1"), "auto_review");
    resetCursorSeatApprovalMode(fs, cursorSeatConfigDir(STATE_ROOT, "node-1"));
    expect(writeFile).not.toHaveBeenCalled();
  });
});

describe("CursorRuntimeAdapter.deliverStartup and project", () => {
  it("merges guidance into AGENTS.md and installs skills under .agents/skills", async () => {
    const fs = memFs({ "/spec/guidance/culture.md": "Be kind.", "/spec/skills/review-team/SKILL.md": "---\nname: review-team\n---\nReview." });
    const result = await adapter({ fs }).deliverStartup([
      { path: "culture.md", absolutePath: "/spec/guidance/culture.md", ownerRoot: "/spec", deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start"] },
      { path: "review-team/SKILL.md", absolutePath: "/spec/skills/review-team/SKILL.md", ownerRoot: "/spec", deliveryHint: "skill_install", required: true, appliesOn: ["fresh_start"] },
    ], binding());
    expect(result).toEqual({ delivered: 2, failed: [] });
    expect(fs.files["/work/repo/AGENTS.md"]).toContain("Be kind.");
    expect(fs.files["/work/repo/.agents/skills/review-team/SKILL.md"]).toContain("name: review-team");
  });

  it("types send_text startup files, pauses, then submits with a separate C-m", async () => {
    const tmux = mockTmux();
    const fs = memFs({ "/spec/hello.txt": "Read REVIEWER.md." });
    await adapter({ tmux, fs }).deliverStartup([
      { path: "hello.txt", absolutePath: "/spec/hello.txt", ownerRoot: "/spec", deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] },
    ], binding());
    expect(tmux.sendText).toHaveBeenCalledWith("review-cursor@skill-library", "Read REVIEWER.md.");
    expect(tmux.sendKeys).toHaveBeenCalledWith("review-cursor@skill-library", ["C-m"]);
  });
});

describe("CursorRuntimeAdapter.project and listInstalled", () => {
  /** An in-memory fs whose listFiles walks a directory, like the daemon's real fsOps. */
  function treeFs(files: Record<string, string>) {
    const fs = memFs(files);
    fs.listFiles = (dir) => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const found = Object.keys(fs.files).filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
      if (found.length === 0 && !fs.dirs.has(dir)) throw new Error(`ENOTDIR: ${dir}`);
      return found;
    };
    return fs;
  }
  const entry = (over: Partial<ProjectionEntry>): ProjectionEntry => ({
    category: "skill", effectiveId: "x", sourceSpec: "spec", sourcePath: "/spec", resourcePath: "x", absolutePath: "/spec/x", classification: "safe_projection", ...over,
  });
  const plan = (entries: ProjectionEntry[]): ProjectionPlan => ({ runtime: "cursor", cwd: "/work/repo", entries, startup: { files: [], actions: [] } as unknown as ProjectionPlan["startup"], conflicts: [], noOps: [], diagnostics: [] });

  it("copies a directory-shaped skill under .agents/skills/<id>/, keeping its layout", async () => {
    const fs = treeFs({ "/spec/skills/review-team/SKILL.md": "---\nname: review-team\n---", "/spec/skills/review-team/scripts/run.sh": "echo hi" });
    const result = await adapter({ fs }).project(plan([entry({ effectiveId: "review-team", absolutePath: "/spec/skills/review-team" })]), binding());
    expect(result).toEqual({ projected: ["review-team"], skipped: [], failed: [] });
    expect(fs.files["/work/repo/.agents/skills/review-team/SKILL.md"]).toContain("name: review-team");
    expect(fs.files["/work/repo/.agents/skills/review-team/scripts/run.sh"]).toBe("echo hi");
  });

  it("skips a no_op entry without writing", async () => {
    const fs = treeFs({ "/spec/skills/done/SKILL.md": "s" });
    const result = await adapter({ fs }).project(plan([entry({ effectiveId: "done", absolutePath: "/spec/skills/done", classification: "no_op" })]), binding());
    expect(result).toEqual({ projected: [], skipped: ["done"], failed: [] });
    expect(Object.keys(fs.files).some((p) => p.startsWith("/work/repo/"))).toBe(false);
  });

  it("merges a managed_block guidance entry into AGENTS.md", async () => {
    const fs = treeFs({ "/spec/guidance/culture.md": "Be kind.", "/work/repo/AGENTS.md": "# Repo notes\n" });
    const result = await adapter({ fs }).project(plan([entry({ category: "guidance", effectiveId: "culture.md", absolutePath: "/spec/guidance/culture.md", classification: "managed_merge", mergeStrategy: "managed_block" })]), binding());
    expect(result).toEqual({ projected: ["culture.md"], skipped: [], failed: [] });
    expect(fs.files["/work/repo/AGENTS.md"]).toContain("# Repo notes");
    expect(fs.files["/work/repo/AGENTS.md"]).toContain("Be kind.");
  });

  it("skips the shared rig-role guidance block instead of merging it", async () => {
    const fs = treeFs({ "/spec/guidance/rig-role.md": "You are the reviewer." });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await adapter({ fs }).project(plan([entry({ category: "guidance", effectiveId: "rig-role", absolutePath: "/spec/guidance/rig-role.md", classification: "managed_merge", mergeStrategy: "managed_block" })]), binding());
      expect(result).toEqual({ projected: [], skipped: ["rig-role"], failed: [] });
      expect(fs.files["/work/repo/AGENTS.md"]).toBeUndefined();
    } finally {
      log.mockRestore();
    }
  });

  it("skips a plugin entry (plugins are not projected for Cursor)", async () => {
    const fs = treeFs({ "/spec/plugins/p/.codex-plugin/plugin.json": "{}" });
    const result = await adapter({ fs }).project(plan([entry({ category: "plugin", effectiveId: "p", absolutePath: "/spec/plugins/p" })]), binding());
    expect(result).toEqual({ projected: [], skipped: ["p"], failed: [] });
    expect(Object.keys(fs.files).some((p) => p.startsWith("/work/repo/"))).toBe(false);
  });

  it("lists what is installed under .agents/skills", async () => {
    const fs = treeFs({ "/work/repo/.agents/skills/review-team/SKILL.md": "s", "/work/repo/.agents/skills/lint/SKILL.md": "l" });
    fs.dirs.add("/work/repo/.agents/skills");
    const installed = await adapter({ fs }).listInstalled(binding());
    expect(installed.map((r) => r.effectiveId).sort()).toEqual(["lint/SKILL.md", "review-team/SKILL.md"]);
    expect(installed.every((r) => r.category === "skill" && r.installedPath.startsWith("/work/repo/.agents/skills/"))).toBe(true);
  });

  it("lists nothing when .agents/skills does not exist", async () => {
    expect(await adapter({ fs: treeFs({}) }).listInstalled(binding())).toEqual([]);
  });
});

describe("CursorRuntimeAdapter.checkReady", () => {
  it("is ready on Cursor's prompt", async () => {
    const tmux = mockTmux({ capturePaneContent: vi.fn(async () => "  Cursor Agent\n  v2026.09.28-64d2043\n  → Plan, search, build anything\n") });
    expect(await adapter({ tmux }).checkReady(binding())).toEqual({ ready: true });
  });
  it("reports the trust gate code", async () => {
    const tmux = mockTmux({ capturePaneContent: vi.fn(async () => "⚠ Workspace Trust Required\n▶ [a] Trust this workspace") });
    expect(await adapter({ tmux }).checkReady(binding())).toMatchObject({ ready: false, code: "trust_gate" });
  });
});

function fakeSpawn() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  return { child, spawnFn: (() => child) as unknown as typeof spawn };
}
const RC = { configDir: "/c", cwd: "/w" };

describe("runCreateChat", () => {
  it("resolves on the id line and kills a child that never exits", async () => {
    const { child, spawnFn } = fakeSpawn();
    const p = runCreateChat(spawnFn, RC);
    child.stdout.write(`${CHAT_ID}\n`);
    expect(await p).toBe(CHAT_ID);
    expect(child.kill).toHaveBeenCalled();
  });
  it("rejects with the exit code when it exits without an id", async () => {
    const { child, spawnFn } = fakeSpawn();
    const p = runCreateChat(spawnFn, RC);
    child.stderr.write("boom\n");
    await new Promise((r) => setTimeout(r, 5));
    child.emit("close", 1);
    await expect(p).rejects.toThrow(/code 1.*boom/);
  });
  it("rejects when cursor-agent is missing", async () => {
    const { child, spawnFn } = fakeSpawn();
    const p = runCreateChat(spawnFn, RC);
    child.emit("error", Object.assign(new Error("spawn"), { code: "ENOENT" }));
    await expect(p).rejects.toThrow(/cursor-agent not found/);
  });
  it("times out and kills the child", async () => {
    const { child, spawnFn } = fakeSpawn();
    await expect(runCreateChat(spawnFn, { ...RC, timeoutMs: 20 })).rejects.toThrow(/timed out waiting for a chat id/);
    expect(child.kill).toHaveBeenCalled();
  });
  it("rejects once and kills the child when stdout errors, instead of crashing", async () => {
    const { child, spawnFn } = fakeSpawn();
    const p = runCreateChat(spawnFn, RC);
    child.stdout.emit("error", new Error("EPIPE"));
    child.stderr.emit("error", new Error("second"));
    await expect(p).rejects.toThrow(/EPIPE/);
    expect(child.kill).toHaveBeenCalled();
  });
  it("rejects and kills the child when stderr errors", async () => {
    const { child, spawnFn } = fakeSpawn();
    const p = runCreateChat(spawnFn, RC);
    child.stderr.emit("error", new Error("EIO"));
    await expect(p).rejects.toThrow(/EIO/);
    expect(child.kill).toHaveBeenCalled();
  });
  it("caps a long stderr line in the error message", async () => {
    const { child, spawnFn } = fakeSpawn();
    const p = runCreateChat(spawnFn, RC);
    child.stderr.write(`${"x".repeat(5000)}\n`);
    await new Promise((r) => setTimeout(r, 5));
    child.emit("close", 1);
    const err = await p.catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/code 1/);
    expect((err as Error).message.length).toBeLessThan(320);
  });
  it("includes the capped last stderr line on timeout", async () => {
    const { child, spawnFn } = fakeSpawn();
    const p = runCreateChat(spawnFn, { ...RC, timeoutMs: 30 });
    child.stderr.write(`Waiting for login ${"y".repeat(900)}\n`);
    const err = await p.catch((e: Error) => e);
    expect((err as Error).message).toMatch(/^timed out waiting for a chat id: Waiting for login y+/);
    expect((err as Error).message.length).toBeLessThan(260);
    expect(child.kill).toHaveBeenCalled();
  });
  it("joins an id split across chunks", async () => {
    const { child, spawnFn } = fakeSpawn();
    const p = runCreateChat(spawnFn, RC);
    child.stdout.write("8c9c82cc-5887-4e46-");
    await new Promise((r) => setTimeout(r, 5));
    child.stdout.write("ac67-6a5f123fd9f5\n");
    expect(await p).toBe("8c9c82cc-5887-4e46-ac67-6a5f123fd9f5");
  });
});

describe("CursorRuntimeAdapter activity hooks", () => {
  const RELAY_PATH = "/opt/openrig/daemon/assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs";
  it("writes ~/.cursor/hooks.json and leaves an unparseable one untouched", () => {
    const fs = memFs({ [RELAY_PATH]: "// relay" });
    fs.dirs.add("/home/z/.cursor");
    const a = new CursorRuntimeAdapter({ tmux: mockTmux(), fsOps: fs, stateRoot: STATE_ROOT, cursorHome: "/home/z/.cursor", activityRelayPath: RELAY_PATH });
    a.ensureCursorActivityHooks();
    expect(JSON.parse(fs.files["/home/z/.cursor/hooks.json"]!).hooks.stop).toHaveLength(1);
    fs.files["/home/z/.cursor/hooks.json"] = "{ broken";
    a.ensureCursorActivityHooks();
    expect(fs.files["/home/z/.cursor/hooks.json"]).toBe("{ broken");
  });
  it("deletes the file on disable when only OpenRig's entries were in it", () => {
    const fs = memFs({ [RELAY_PATH]: "// relay" });
    fs.dirs.add("/home/z/.cursor");
    const deleted: string[] = [];
    fs.deleteFile = (p) => { deleted.push(p); delete fs.files[p]; };
    const a = new CursorRuntimeAdapter({ tmux: mockTmux(), fsOps: fs, stateRoot: STATE_ROOT, cursorHome: "/home/z/.cursor", activityRelayPath: RELAY_PATH });
    a.ensureCursorActivityHooks();
    a.removeCursorActivityHooks();
    expect(deleted).toEqual(["/home/z/.cursor/hooks.json"]);
  });
  it("does nothing when ~/.cursor does not exist (Cursor not installed)", () => {
    const fs = memFs({ [RELAY_PATH]: "// relay" });
    const a = new CursorRuntimeAdapter({ tmux: mockTmux(), fsOps: fs, stateRoot: STATE_ROOT, cursorHome: "/home/z/.cursor", activityRelayPath: RELAY_PATH });
    a.ensureCursorActivityHooks();
    expect(fs.files["/home/z/.cursor/hooks.json"]).toBeUndefined();
    expect(fs.dirs.has("/home/z/.cursor")).toBe(false);
  });
  it("logs and does not throw when writing hooks.json fails", () => {
    const fs = memFs({ [RELAY_PATH]: "// relay" });
    fs.dirs.add("/home/z/.cursor");
    fs.writeFile = () => { throw Object.assign(new Error("EACCES: permission denied, open '/home/z/.cursor/hooks.json'"), { code: "EACCES" }); };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const a = new CursorRuntimeAdapter({ tmux: mockTmux(), fsOps: fs, stateRoot: STATE_ROOT, cursorHome: "/home/z/.cursor", activityRelayPath: RELAY_PATH });
      expect(() => a.ensureCursorActivityHooks()).not.toThrow();
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/^\[openrig\] cursor activity hooks skipped: EACCES/));
    } finally {
      error.mockRestore();
    }
  });
  it("logs and does not throw when reading hooks.json fails", () => {
    const fs = memFs({ [RELAY_PATH]: "// relay", "/home/z/.cursor/hooks.json": "{}" });
    fs.dirs.add("/home/z/.cursor");
    fs.readFile = () => { throw new Error("EACCES: permission denied"); };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const a = new CursorRuntimeAdapter({ tmux: mockTmux(), fsOps: fs, stateRoot: STATE_ROOT, cursorHome: "/home/z/.cursor", activityRelayPath: RELAY_PATH });
      expect(() => a.ensureCursorActivityHooks()).not.toThrow();
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/cursor activity hooks skipped: EACCES/));
    } finally {
      error.mockRestore();
    }
  });
  it("logs instead of throwing when cleanup fails", () => {
    const fs = memFs({ "/home/z/.cursor/hooks.json": "{\"version\":1,\"hooks\":{}}" });
    fs.readFile = () => { throw new Error("EACCES"); };
    const a = new CursorRuntimeAdapter({ tmux: mockTmux(), fsOps: fs, stateRoot: STATE_ROOT, cursorHome: "/home/z/.cursor", activityRelayPath: RELAY_PATH });
    expect(() => a.removeCursorActivityHooks()).not.toThrow();
  });
});
