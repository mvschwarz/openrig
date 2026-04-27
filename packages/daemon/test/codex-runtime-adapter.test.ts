import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, it, expect, vi } from "vitest";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import type { NodeBinding, ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../src/domain/projection-planner.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

function mockTmux(overrides?: Partial<TmuxAdapter>): TmuxAdapter {
  return {
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "codex"),
    capturePaneContent: vi.fn(async () => "OpenAI Codex (v0.0.0)"),
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPanePid: vi.fn(async () => null),
    ...overrides,
  } as unknown as TmuxAdapter;
}

function mockFs(files?: Record<string, string>): CodexAdapterFsOps {
  const store: Record<string, string> = { ...files };
  return {
    readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`Not found: ${p}`); },
    writeFile: (p: string, c: string) => { store[p] = c; },
    exists: (p: string) => p in store,
    mkdirp: () => {},
    listFiles: (dir: string) => Object.keys(store).filter((k) => k.startsWith(dir + "/")).map((k) => k.slice(dir.length + 1)),
    _store: store,
  } as CodexAdapterFsOps & { _store: Record<string, string> };
}

function makeBinding(cwd = "/project"): NodeBinding {
  return {
    id: "b1", nodeId: "n1", tmuxSession: "r01-qa", tmuxWindow: null, tmuxPane: null,
    cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd,
  };
}

function makeEntry(overrides?: Partial<ProjectionEntry>): ProjectionEntry {
  return {
    category: "skill", effectiveId: "test-skill", sourceSpec: "base", sourcePath: "/agents/base",
    resourcePath: "skills/test", absolutePath: "/agents/base/skills/test/SKILL.md",
    classification: "safe_projection", ...overrides,
  };
}

function testQueueRoot(sharedDocsRoot = nodePath.join(os.homedir(), "code", "substrate", "shared-docs")): string {
  return nodePath.join(sharedDocsRoot, "rigs", "test-rig", "state", "dev");
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function expectedFreshLaunchCommand(options: { cwd?: string; model?: string; queueRoot?: string | null } = {}): string {
  const cwd = options.cwd ?? "/project";
  const gitDirArg = ` --add-dir ${quote(nodePath.join(cwd, ".git"))}`;
  const queueDirArg = options.queueRoot === null ? "" : ` --add-dir ${quote(options.queueRoot ?? testQueueRoot())}`;
  const modelArg = options.model ? ` -m ${quote(options.model)}` : "";
  return `codex -C ${quote(cwd)}${gitDirArg}${queueDirArg}${modelArg} -a never -s workspace-write`;
}

function expectedResumeCommand(token = "sess-456", queueRoot: string | null = testQueueRoot()): string {
  const queueDirArg = queueRoot === null ? "" : ` --add-dir ${quote(queueRoot)}`;
  return `codex resume${queueDirArg} ${quote(token)}`;
}

function expectedProfileFreshLaunchCommand(profile: string, options: { cwd?: string; model?: string; queueRoot?: string | null } = {}): string {
  const cwd = options.cwd ?? "/project";
  const gitDirArg = ` --add-dir ${quote(nodePath.join(cwd, ".git"))}`;
  const queueDirArg = options.queueRoot === null ? "" : ` --add-dir ${quote(options.queueRoot ?? testQueueRoot())}`;
  const modelArg = options.model ? ` -m ${quote(options.model)}` : "";
  return `codex -p ${quote(profile)} -C ${quote(cwd)}${gitDirArg}${queueDirArg}${modelArg}`;
}

function expectedProfileResumeCommand(profile: string, token = "sess-456", queueRoot: string | null = testQueueRoot()): string {
  const queueDirArg = queueRoot === null ? "" : ` --add-dir ${quote(queueRoot)}`;
  return `codex -p ${quote(profile)} resume${queueDirArg} ${quote(token)}`;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

function createCodexLogsDb(homeDir: string, pid: number, threadId: string, dbName = "logs_1.sqlite"): void {
  const codexDir = nodePath.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const db = new Database(nodePath.join(codexDir, dbName));
  try {
    db.exec(`
      CREATE TABLE logs (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        ts_nanos INTEGER NOT NULL,
        process_uuid TEXT NOT NULL,
        thread_id TEXT
      );
    `);
    db.prepare(
      "INSERT INTO logs (ts, ts_nanos, process_uuid, thread_id) VALUES (?, ?, ?, ?)"
    ).run(
      1,
      1,
      `pid:${pid}:test-process`,
      threadId
    );
  } finally {
    db.close();
  }
}

describe("Codex runtime adapter", () => {
  // T2: implements all four methods
  it("implements all four methods", () => {
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: mockFs() });
    expect(typeof adapter.listInstalled).toBe("function");
    expect(typeof adapter.project).toBe("function");
    expect(typeof adapter.deliverStartup).toBe("function");
    expect(typeof adapter.checkReady).toBe("function");
    expect(adapter.runtime).toBe("codex");
  });

  // T7: checkReady returns true for responsive session
  it("checkReady returns true for responsive session", async () => {
    const tmux = mockTmux({ hasSession: vi.fn(async () => true) });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs() });
    const result = await adapter.checkReady(makeBinding());
    expect(result.ready).toBe(true);
  });

  it("checkReady returns false when the pane has fallen back to a shell prompt", async () => {
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "zsh"),
      capturePaneContent: vi.fn(async () => "mschwarz@host rigged %"),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs() });

    const result = await adapter.checkReady(makeBinding());

    expect(result).toEqual({
      ready: false,
      reason: "The probe pane returned to a shell instead of staying inside the runtime.",
      code: "returned_to_shell",
    });
  });

  it("checkReady returns false when Codex is blocked on the workspace trust prompt", async () => {
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "codex"),
      capturePaneContent: vi.fn(async () => [
        "> You are in /some/workspace",
        "",
        "  Do you trust the contents of this directory? Working with untrusted contents",
        "  comes with higher risk of prompt injection.",
        "",
        "› 1. Yes, continue",
        "  2. No, quit",
        "",
        "  Press enter to continue",
      ].join("\n")),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs() });

    const result = await adapter.checkReady(makeBinding());

    expect(result).toEqual({
      ready: false,
      reason: "Codex is waiting for workspace trust approval before the session can become interactive.",
      code: "trust_gate",
    });
  });

  it("checkReady returns false when Codex is blocked on a numbered model-selection prompt", async () => {
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "codex-aarch64-a"),
      capturePaneContent: vi.fn(async () => [
        "╭───────────────────────────────────────╮",
        "│ >_ OpenAI Codex (v0.124.0)            │",
        "╰───────────────────────────────────────╯",
        "",
        "› 1. Switch to gpt-5.1-codex-mini Optimized for codex. Cheaper,",
        "  2. Switch to gpt-5.4-codex Stronger for complex tasks.",
        "  3. Keep current model",
        "",
        "  gpt-5.4 default · ~/code/openrig",
      ].join("\n")),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs() });

    const result = await adapter.checkReady(makeBinding());

    expect(result).toEqual({
      ready: false,
      reason: "Codex is waiting for model selection before the session can become interactive.",
      code: "model_selection_gate",
    });
  });

  it("checkReady returns true when Codex is interactive even if an update banner remains in scrollback", async () => {
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "codex"),
      capturePaneContent: vi.fn(async () => [
        "✨ Update available! 0.120.0 -> 0.121.0",
        "Run npm install -g @openai/codex to update.",
        "",
        "╭───────────────────────────────────────╮",
        "│ >_ OpenAI Codex (v0.120.0)            │",
        "│                                       │",
        "│ model:     gpt-5.4   /model to change │",
        "│ directory: ~/code/openrig             │",
        "╰───────────────────────────────────────╯",
        "",
        "› Improve documentation in @filename",
        "",
        "  gpt-5.4 default · ~/code/openrig",
      ].join("\n")),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs() });

    const result = await adapter.checkReady(makeBinding());

    expect(result).toEqual({ ready: true });
  });

  it("checkReady returns true when a resumed Codex pane is foregrounded through node and only the live prompt footer remains in recent scrollback", async () => {
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "node"),
      capturePaneContent: vi.fn(async () => [
        "› Without using tools or reading files, reply in exactly one line: CONFIRM",
        "  CODEX2_B_20260418T1431 crimson-delta-pulse. Remember both exact lines for",
        "  later continuity verification.",
        "",
        "",
        "• CONFIRM CODEX2_B_20260418T1431 crimson-delta-pulse",
        "",
        "",
        "› Use /skills to list available skills",
        "",
        "  gpt-5.4 default · ~/code/openrig",
        "",
        "",
      ].join("\n")),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs() });

    const result = await adapter.checkReady(makeBinding());

    expect(result).toEqual({ ready: true });
  });

  // T8: listInstalled reports projected resources
  it("listInstalled reports projected resources in .agents/", async () => {
    const fs = mockFs({
      "/project/.agents/skills": "", // directory marker
      "/project/.agents/skills/deep-review/SKILL.md": "content",
    });
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });
    const result = await adapter.listInstalled(makeBinding());
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.category).toBe("skill");
  });

  // T10: deliverStartup does NOT execute startup actions
  it("deliverStartup only handles files, no action execution", async () => {
    // Verify that the interface only accepts ResolvedStartupFile[], not StartupAction[]
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs({ "/rig/file.md": "content" }), sleep: async () => {} });
    const file: ResolvedStartupFile = {
      path: "file.md", absolutePath: "/rig/file.md", ownerRoot: "/rig",
      deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start"],
    };
    const result = await adapter.deliverStartup([file], makeBinding());
    expect(result.delivered).toBe(1);
    // No action-related methods called — only file delivery
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  it("replaces legacy using-openrig managed block when delivering openrig-start guidance", async () => {
    const fs = mockFs({
      "/rig/openrig-start.md": "# OpenRig Start\n\nNew guidance",
      "/project/AGENTS.md": [
        "<!-- BEGIN RIGGED MANAGED BLOCK: using-openrig.md -->",
        "# Using OpenRig",
        "Old guidance",
        "<!-- END RIGGED MANAGED BLOCK: using-openrig.md -->",
      ].join("\n"),
    });
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });
    const file: ResolvedStartupFile = {
      path: "openrig-start.md",
      absolutePath: "/rig/openrig-start.md",
      ownerRoot: "/rig",
      deliveryHint: "guidance_merge",
      required: true,
      appliesOn: ["fresh_start", "restore"],
    };

    await adapter.deliverStartup([file], makeBinding());

    const store = (fs as unknown as { _store: Record<string, string> })._store;
    const content = store["/project/AGENTS.md"]!;
    expect(content).toContain("BEGIN RIGGED MANAGED BLOCK: openrig-start.md");
    expect(content).not.toContain("BEGIN RIGGED MANAGED BLOCK: using-openrig.md");
    expect(content).toContain("New guidance");
  });

  // T11: structured failure on delivery error
  it("returns structured failure when delivery fails", async () => {
    const fs = mockFs({}); // empty — file not found
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });
    const file: ResolvedStartupFile = {
      path: "missing.md", absolutePath: "/rig/missing.md", ownerRoot: "/rig",
      deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start"],
    };
    const result = await adapter.deliverStartup([file], makeBinding());
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.path).toBe("missing.md");
    expect(result.failed[0]!.error).toContain("Not found");
  });

  it("submits send_text startup files after pasting", async () => {
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs({ "/rig/startup/init.sh": "echo hello" }),
      sleep: async () => {},
    });
    const file: ResolvedStartupFile = {
      path: "startup/init.sh", absolutePath: "/rig/startup/init.sh", ownerRoot: "/rig",
      deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"],
    };

    await adapter.deliverStartup([file], makeBinding());

    expect(tmux.sendText).toHaveBeenCalledWith("r01-qa", "echo hello");
    expect(tmux.sendKeys).toHaveBeenCalledWith("r01-qa", ["C-m"]);
  });

  // T12: replay on restore is safe for already-projected content
  it("replay on restore is safe for already-projected content", async () => {
    const fs = mockFs({
      "/rig/guide.md": "# Guidance",
      "/project/AGENTS.md": "<!-- BEGIN RIGGED MANAGED BLOCK: guide.md -->\n# Guidance\n<!-- END RIGGED MANAGED BLOCK: guide.md -->",
    });
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });
    const file: ResolvedStartupFile = {
      path: "guide.md", absolutePath: "/rig/guide.md", ownerRoot: "/rig",
      deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start", "restore"],
    };

    // Deliver twice — should replace managed block, not duplicate
    await adapter.deliverStartup([file], makeBinding());
    await adapter.deliverStartup([file], makeBinding());

    const store = (fs as unknown as { _store: Record<string, string> })._store;
    const content = store["/project/AGENTS.md"]!;
    const blockCount = (content.match(/BEGIN RIGGED MANAGED BLOCK/g) ?? []).length;
    expect(blockCount).toBe(1); // exactly one block, not two
  });

  // NS-T04: launchHarness tests
  it("launchHarness sends correct fresh launch command", async () => {
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [],
      sleep: async () => {},
    });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith("r01-qa", expectedFreshLaunchCommand());
  });

  it("launchHarness passes the requested Codex model on fresh launch", async () => {
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [],
      sleep: async () => {},
    });
    const binding = { ...makeBinding(), model: "gpt-5.5" };

    const result = await adapter.launchHarness(binding, { name: "dev-qa@test-rig" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith("r01-qa", expectedFreshLaunchCommand({ model: "gpt-5.5" }));
  });

  it("launchHarness uses the requested Codex config profile without overriding sandbox or approval policy", async () => {
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [],
      sleep: async () => {},
    });
    const binding = { ...makeBinding(), codexConfigProfile: "fleet" };

    const result = await adapter.launchHarness(binding, { name: "dev-qa@test-rig" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith("r01-qa", expectedProfileFreshLaunchCommand("fleet"));
  });

  it("launchHarness passes the disposable proof Codex model on fresh launch", async () => {
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [],
      sleep: async () => {},
    });
    const binding = { ...makeBinding(), model: "gpt-5.1-codex-mini" };

    const result = await adapter.launchHarness(binding, { name: "dev-qa@test-rig" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith(
      "r01-qa",
      expectedFreshLaunchCommand({ model: "gpt-5.1-codex-mini" })
    );
  });

  it("launchHarness uses OPENRIG_SHARED_DOCS_ROOT for the Codex queue state writable root", async () => {
    vi.stubEnv("OPENRIG_SHARED_DOCS_ROOT", "/custom/shared-docs");
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [],
      sleep: async () => {},
    });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith(
      "r01-qa",
      expectedFreshLaunchCommand({ queueRoot: testQueueRoot("/custom/shared-docs") })
    );
  });

  it("launchHarness does not guess a queue state writable root for non-canonical session names", async () => {
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [],
      sleep: async () => {},
    });

    const result = await adapter.launchHarness(makeBinding(), { name: "devqa@test-rig" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith("r01-qa", expectedFreshLaunchCommand({ queueRoot: null }));
  });

  it("launchHarness skips the non-mutating Codex update prompt before capturing a fresh thread id", async () => {
    const initialShell = [
      expectedFreshLaunchCommand(),
      "admin@host project %",
    ].join("\n");
    const updatePrompt = [
      "✨ Update available! 0.120.0 -> 0.121.0",
      "Release notes: https://github.com/openai/codex/releases/latest",
      "› 1. Update now (runs `npm install -g @openai/codex`)",
      "  2. Skip",
      "  3. Skip until next version",
      "Press enter to continue",
    ].join("\n");
    const tmux = mockTmux({
      getPaneCommand: vi.fn()
        .mockResolvedValueOnce("zsh")
        .mockResolvedValue("codex"),
      capturePaneContent: vi.fn()
        .mockResolvedValueOnce(initialShell)
        .mockResolvedValueOnce(updatePrompt)
        .mockResolvedValue("OpenAI Codex (v0.120.0)"),
      getPanePid: vi.fn(async () => 900),
    });
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "-zsh" },
        { pid: 901, ppid: 900, command: "codex" },
      ],
      readThreadIdByPid: (pid) => pid === 901 ? "019d45bc-117d-78a3-a4ad-6fb186e5a86d" : undefined,
      sleep: async () => {},
    });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig" });

    expect(result).toEqual({
      ok: true,
      resumeToken: "019d45bc-117d-78a3-a4ad-6fb186e5a86d",
      resumeType: "codex_id",
    });
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText.mock.calls).toEqual([
      ["r01-qa", expectedFreshLaunchCommand()],
      ["r01-qa", "3"],
    ]);
    const sendKeys = tmux.sendKeys as ReturnType<typeof vi.fn>;
    expect(sendKeys.mock.calls).toEqual([
      ["r01-qa", ["Enter"]],
      ["r01-qa", ["Enter"]],
    ]);
  });

  it("launchHarness does not choose a Codex update action unless skip-until-next-version is visible", async () => {
    const tmux = mockTmux({
      capturePaneContent: vi.fn(async () => [
        "✨ Update available! 0.120.0 -> 0.121.0",
        "Press enter to continue",
      ].join("\n")),
    });
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [],
      sleep: async () => {},
    });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText.mock.calls).toEqual([
      ["r01-qa", expectedFreshLaunchCommand()],
    ]);
  });

  it("launchHarness keeps checking for a skippable Codex update while waiting for a fresh thread id", async () => {
    const initialShell = [
      expectedFreshLaunchCommand(),
      "admin@host project %",
    ].join("\n");
    const updatePrompt = [
      "✨ Update available! 0.120.0 -> 0.121.0",
      "› 1. Update now (runs `npm install -g @openai/codex`)",
      "  2. Skip",
      "  3. Skip until next version",
      "Press enter to continue",
    ].join("\n");
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "zsh"),
      capturePaneContent: vi.fn()
        .mockResolvedValueOnce(initialShell)
        .mockResolvedValueOnce(initialShell)
        .mockResolvedValueOnce(initialShell)
        .mockResolvedValueOnce(initialShell)
        .mockResolvedValueOnce(initialShell)
        .mockResolvedValueOnce(initialShell)
        .mockResolvedValueOnce(updatePrompt)
        .mockResolvedValue("OpenAI Codex (v0.120.0)"),
      getPanePid: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(900),
    });
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "-zsh" },
        { pid: 901, ppid: 900, command: "codex" },
      ],
      readThreadIdByPid: (pid) => pid === 901 ? "019d45bc-117d-78a3-a4ad-6fb186e5a86d" : undefined,
      sleep: async () => {},
    });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig" });

    expect(result).toEqual({
      ok: true,
      resumeToken: "019d45bc-117d-78a3-a4ad-6fb186e5a86d",
      resumeType: "codex_id",
    });
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText.mock.calls).toEqual([
      ["r01-qa", expectedFreshLaunchCommand()],
      ["r01-qa", "3"],
    ]);
  });

  it("launchHarness captures a fresh Codex thread id from the live child process", async () => {
    const tmux = mockTmux({
      getPanePid: vi.fn(async () => 900),
    });
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "-zsh" },
        { pid: 901, ppid: 900, command: "codex" },
      ],
      readThreadIdByPid: (pid) => pid === 901 ? "019d45bc-117d-78a3-a4ad-6fb186e5a86d" : undefined,
      sleep: async () => {},
    });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig" });

    expect(result).toEqual({
      ok: true,
      resumeToken: "019d45bc-117d-78a3-a4ad-6fb186e5a86d",
      resumeType: "codex_id",
    });
  });

  it("launchHarness captures a fresh Codex thread id from a nested wrapper -> vendor codex process tree", async () => {
    const tmux = mockTmux({
      getPanePid: vi.fn(async () => 900),
    });
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "-zsh" },
        { pid: 901, ppid: 900, command: "node /opt/homebrew/bin/codex -C /project -a never -s workspace-write" },
        { pid: 902, ppid: 901, command: "/opt/homebrew/lib/node_modules/@openai/codex/vendor/codex/codex -C /project -a never -s workspace-write" },
      ],
      readThreadIdByPid: (pid) => pid === 902 ? "019d45bc-117d-78a3-a4ad-6fb186e5a86d" : undefined,
      sleep: async () => {},
    });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig" });

    expect(result).toEqual({
      ok: true,
      resumeToken: "019d45bc-117d-78a3-a4ad-6fb186e5a86d",
      resumeType: "codex_id",
    });
  });

  it("launchHarness captures a fresh Codex thread id from the child process home directory", async () => {
    const tempRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "rigged-codex-home-"));
    const actualHome = nodePath.join(tempRoot, "actual-home");
    createCodexLogsDb(actualHome, 901, "019d45bc-117d-78a3-a4ad-6fb186e5a86d");

    const tmux = mockTmux({
      getPanePid: vi.fn(async () => 900),
    });
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: {
        readFile: (p: string) => fs.readFileSync(p, "utf-8"),
        writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
        exists: (p: string) => fs.existsSync(p),
        mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
        listFiles: (dir: string) => fs.readdirSync(dir),
        homedir: "/wrong-home",
      },
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "-zsh" },
        { pid: 901, ppid: 900, command: "codex" },
      ],
      resolveHomeDirByPid: (pid) => pid === 901 ? actualHome : undefined,
      sleep: async () => {},
    });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig" });

    expect(result).toEqual({
      ok: true,
      resumeToken: "019d45bc-117d-78a3-a4ad-6fb186e5a86d",
      resumeType: "codex_id",
    });
  });

  it("launchHarness captures a fresh Codex thread id from the current versioned logs database", async () => {
    const tempRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "rigged-codex-home-"));
    const actualHome = nodePath.join(tempRoot, "actual-home");
    createCodexLogsDb(actualHome, 901, "019d45bc-117d-78a3-a4ad-6fb186e5a86d", "logs_2.sqlite");

    const tmux = mockTmux({
      getPanePid: vi.fn(async () => 900),
    });
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: {
        readFile: (p: string) => fs.readFileSync(p, "utf-8"),
        writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
        exists: (p: string) => fs.existsSync(p),
        mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
        listFiles: (dir: string) => fs.readdirSync(dir),
        homedir: "/wrong-home",
      },
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "-zsh" },
        { pid: 901, ppid: 900, command: "codex" },
      ],
      resolveHomeDirByPid: (pid) => pid === 901 ? actualHome : undefined,
      sleep: async () => {},
    });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig" });

    expect(result).toEqual({
      ok: true,
      resumeToken: "019d45bc-117d-78a3-a4ad-6fb186e5a86d",
      resumeType: "codex_id",
    });
  });

  it("launchHarness sends correct resume command", async () => {
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs() });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith("r01-qa", expectedResumeCommand());
  });

  it("launchHarness passes the requested Codex config profile on resume", async () => {
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [],
      sleep: async () => {},
    });
    const binding = { ...makeBinding(), codexConfigProfile: "fleet" };

    const result = await adapter.launchHarness(binding, { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith("r01-qa", expectedProfileResumeCommand("fleet"));
  });

  it("provisions project-local Codex hooks and feature flag without persisting the hook token", async () => {
    const fs = mockFs({
      "/daemon/assets/openrig-activity-hook-relay.cjs": "relay script",
      "/project/.codex/hooks.json": JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                { type: "command", command: "node ./existing-hook.cjs", timeout: 10 },
              ],
            },
          ],
        },
      }),
      "/project/.codex/config.toml": "[features]\ncodex_hooks = false\n",
    });
    const adapter = new CodexRuntimeAdapter({
      tmux: mockTmux(),
      fsOps: { ...fs, homedir: "/home/test" },
      activityHookRelayAssetPath: "/daemon/assets/openrig-activity-hook-relay.cjs",
    });

    await adapter.deliverStartup([], makeBinding());
    await adapter.deliverStartup([], makeBinding());

    const store = (fs as unknown as { _store: Record<string, string> })._store;
    expect(store["/project/.openrig/activity-hook-relay.cjs"]).toBe("relay script");
    expect(store["/project/.codex/config.toml"]).toContain("codex_hooks = true");
    expect(store["/home/test/.codex/hooks.json"]).toBeUndefined();

    const hooksConfig = JSON.parse(store["/project/.codex/hooks.json"]!);
    const hookJson = JSON.stringify(hooksConfig);
    expect(hookJson).toContain("node ./existing-hook.cjs");
    expect(hookJson).toContain("node '/project/.openrig/activity-hook-relay.cjs'");
    expect(hookJson).toContain("SessionStart");
    expect(hookJson).toContain("UserPromptSubmit");
    expect(hookJson).toContain("Stop");
    expect(hookJson).not.toContain("secret-token");

    const relayCommandMatches = hookJson.match(/activity-hook-relay\.cjs/g) ?? [];
    expect(relayCommandMatches).toHaveLength(3);
  });

  it("launchHarness skips the non-mutating Codex update prompt during resume verification", async () => {
    const updatePrompt = [
      "✨ Update available! 0.120.0 -> 0.121.0",
      "› 1. Update now (runs `npm install -g @openai/codex`)",
      "  2. Skip",
      "  3. Skip until next version",
      "Press enter to continue",
    ].join("\n");
    const tmux = mockTmux({
      capturePaneContent: vi.fn()
        .mockResolvedValueOnce(updatePrompt)
        .mockResolvedValue("OpenAI Codex (v0.120.0)"),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result).toEqual({ ok: true, resumeToken: "sess-456", resumeType: "codex_id" });
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText.mock.calls).toEqual([
      ["r01-qa", expectedResumeCommand()],
      ["r01-qa", "3"],
    ]);
    const sendKeys = tmux.sendKeys as ReturnType<typeof vi.fn>;
    expect(sendKeys.mock.calls).toEqual([
      ["r01-qa", ["Enter"]],
      ["r01-qa", ["Enter"]],
    ]);
  });

  it("launchHarness does not pass a model argument when resuming Codex", async () => {
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs() });
    const binding = { ...makeBinding(), model: "gpt-5.5" };

    const result = await adapter.launchHarness(binding, { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith("r01-qa", expectedResumeCommand());
    expect(sendText.mock.calls[0]?.[1]).not.toContain("-m");
    expect(sendText.mock.calls[0]?.[1]).toContain("--add-dir");
  });

  it("launchHarness returns retry_fresh when Codex reports no saved session for the requested resume token", async () => {
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "zsh"),
      capturePaneContent: vi.fn(async () => [
        "No saved session found for id sess-456",
        "admin@host openrig %",
      ].join("\n")),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result).toEqual({
      ok: false,
      error: "Codex resume failed: no saved session found for the requested session",
      recovery: "retry_fresh",
    });
  });

  it("deliverStartup pre-seeds Codex trust for the managed project", async () => {
    const fs = mockFs({});
    const fsWithHome = { ...fs, homedir: "/home/tester" };
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fsWithHome });

    await adapter.deliverStartup([], makeBinding("/tmp/workspace"));

    const store = (fsWithHome as unknown as { _store: Record<string, string> })._store;
    const content = store["/home/tester/.codex/config.toml"];
    expect(content).toBeDefined();
    expect(content).toContain('[projects."/tmp/workspace"]');
    expect(content).toContain('trust_level = "trusted"');
  });

  it("deliverStartup does not inject Codex MCP servers without runtime resources", async () => {
    const fs = mockFs({
      "/home/tester/.codex/config.toml": '[projects."/tmp/workspace"]\ntrust_level = "trusted"\n',
    });
    const fsWithHome = { ...fs, homedir: "/home/tester" };
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fsWithHome });

    await adapter.deliverStartup([], makeBinding("/tmp/workspace"));

    const store = (fsWithHome as unknown as { _store: Record<string, string> })._store;
    const content = store["/home/tester/.codex/config.toml"];
    expect(content).toContain('[projects."/tmp/workspace"]');
    expect(content).toContain('trust_level = "trusted"');
    expect(content).not.toContain('[mcp_servers.exa]');
    expect(content).not.toContain('[mcp_servers.context7]');
  });

  it("applies codex_config_fragment runtime resources to the global Codex config idempotently", async () => {
    const fs = mockFs({
      "/agents/base/runtime/codex-config.toml": [
        "[mcp_servers.exa]",
        'url = "https://mcp.exa.ai/mcp"',
        "",
        "[mcp_servers.context7]",
        'url = "https://mcp.context7.com/mcp"',
        "",
      ].join("\n"),
      "/home/tester/.codex/config.toml": '[projects."/tmp/workspace"]\ntrust_level = "trusted"\n',
    });
    const fsWithHome = { ...fs, homedir: "/home/tester" };
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fsWithHome });
    const plan: ProjectionPlan = {
      runtime: "codex", cwd: "/tmp/workspace",
      entries: [makeEntry({
        category: "runtime_resource",
        effectiveId: "codex-default-config",
        resourceType: "codex_config_fragment",
        absolutePath: "/agents/base/runtime/codex-config.toml",
        resourcePath: "runtime/codex-config.toml",
      })],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };

    const first = await adapter.project(plan, makeBinding("/tmp/workspace"));
    const second = await adapter.project(plan, makeBinding("/tmp/workspace"));

    expect(first).toEqual({ projected: ["codex-default-config"], skipped: [], failed: [] });
    expect(second).toEqual({ projected: ["codex-default-config"], skipped: [], failed: [] });
    const store = (fsWithHome as unknown as { _store: Record<string, string> })._store;
    const content = store["/home/tester/.codex/config.toml"];
    expect(content).toContain('[projects."/tmp/workspace"]');
    expect(content).toContain('trust_level = "trusted"');
    expect(content.match(/\[mcp_servers\.exa\]/g)?.length ?? 0).toBe(1);
    expect(content.match(/\[mcp_servers\.context7\]/g)?.length ?? 0).toBe(1);
    expect(content.match(/BEGIN OPENRIG MANAGED CODEX CONFIG FRAGMENT: codex-default-config/g)?.length ?? 0).toBe(1);
  });

  // --- Regenerator bug repair: rig-role managed-block skip ---
  //
  // Parallel to the Claude Code adapter fix. The same rig-role seat-collision
  // symptom occurs for AGENTS.md on Codex members. Per architect SHAPE 1:
  // skip mergeManagedBlock when the block id is `rig-role`; log honest skip.

  it("projectEntry skips rig-role guidance managed block; AGENTS.md is not written", async () => {
    const fs = mockFs({ "/agents/qa/guidance/role.md": "# You are `qa`\ngate discipline." });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan: ProjectionPlan = {
      runtime: "codex", cwd: "/project",
      entries: [{
        category: "guidance", effectiveId: "rig-role", mergeStrategy: "managed_block",
        sourceSpec: "base", sourcePath: "/agents/qa",
        resourcePath: "guidance/role.md", absolutePath: "/agents/qa/guidance/role.md",
        classification: "safe_projection",
      } as ProjectionEntry],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };

    const result = await adapter.project(plan, makeBinding());

    const store = (fs as unknown as { _store: Record<string, string> })._store;
    expect(store["/project/AGENTS.md"]).toBeUndefined();
    // ProjectionResult contract: rig-role must appear in `skipped`, NOT `projected`.
    expect(result.skipped).toContain("rig-role");
    expect(result.projected).not.toContain("rig-role");
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("skip: effectiveId is rig-role")
    );
    logSpy.mockRestore();
  });

  it("projectEntry reports non-rig-role guidance in `projected`, not `skipped` (regression on contract)", async () => {
    const fs = mockFs({ "/agents/base/guidance/using-openrig.md": "# Using OpenRig\nhub guidance" });
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan: ProjectionPlan = {
      runtime: "codex", cwd: "/project",
      entries: [{
        category: "guidance", effectiveId: "using-openrig.md", mergeStrategy: "managed_block",
        sourceSpec: "base", sourcePath: "/agents/base",
        resourcePath: "guidance/using-openrig.md",
        absolutePath: "/agents/base/guidance/using-openrig.md",
        classification: "safe_projection",
      } as ProjectionEntry],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };

    const result = await adapter.project(plan, makeBinding());

    expect(result.projected).toContain("using-openrig.md");
    expect(result.skipped).not.toContain("using-openrig.md");
  });

  it("projectEntry still merges non-rig-role guidance blocks (regression)", async () => {
    const fs = mockFs({ "/agents/base/guidance/using-openrig.md": "# Using OpenRig\nhub guidance" });
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan: ProjectionPlan = {
      runtime: "codex", cwd: "/project",
      entries: [{
        category: "guidance", effectiveId: "using-openrig.md", mergeStrategy: "managed_block",
        sourceSpec: "base", sourcePath: "/agents/base",
        resourcePath: "guidance/using-openrig.md",
        absolutePath: "/agents/base/guidance/using-openrig.md",
        classification: "safe_projection",
      } as ProjectionEntry],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };

    await adapter.project(plan, makeBinding());

    const store = (fs as unknown as { _store: Record<string, string> })._store;
    expect(store["/project/AGENTS.md"]).toContain("BEGIN RIGGED MANAGED BLOCK: using-openrig.md");
    expect(store["/project/AGENTS.md"]).toContain("hub guidance");
  });

  it("deliverStartup skips rig-role guidance_merge; delivered is NOT incremented (honest metrics)", async () => {
    const fs = mockFs({ "/rig/rig-role": "# You are `qa`\nrole body" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });
    const file: ResolvedStartupFile = {
      path: "rig-role", absolutePath: "/rig/rig-role", ownerRoot: "/rig",
      deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start", "restore"],
    };

    const result = await adapter.deliverStartup([file], makeBinding());

    // StartupDeliveryResult contract: skip does NOT count as delivered.
    expect(result.delivered).toBe(0);
    expect(result.failed).toEqual([]);
    const store = (fs as unknown as { _store: Record<string, string> })._store;
    expect(store["/project/AGENTS.md"]).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("skip: effectiveId is rig-role")
    );
    logSpy.mockRestore();
  });
});
