import type { CodexPermissionEnvelope } from "../src/domain/codex-rebuild-permissions.js";
import { mockShellCommand } from "./helpers/shell-command-mock.js";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import Database from "better-sqlite3";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import type { NodeBinding, ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../src/domain/projection-planner.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { seedCodexThreads } from "./helpers/codex-state.js";
import { execFileSync } from "node:child_process";
import { provenCodexResume } from "./helpers/codex-resume-proof.js";

// Verbatim 250-byte Codex 0.160.0 menu capture, SHA-256
// 45c70fc01c7d33f4652c9d42523f631734c62aac76f449ff0f2c15e99680ac9b.
const currentUpdatePrompt = fs.readFileSync(new URL("./fixtures/codex-update-0.160.0.txt", import.meta.url), "utf8");
const currentTrustPrompt = fs.readFileSync(new URL("./fixtures/codex-trust-0.156.1.txt", import.meta.url), "utf8");
const firstLoginPrompt = fs.readFileSync(new URL("./fixtures/codex-first-login.txt", import.meta.url), "utf8");

const CODEX_FLOOR_EFFECT = {
  runtime: "codex",
  axis: "sandbox",
  state: "observed",
  value: "workspace-write",
  reason: "emitted_launch_arguments",
} as const;

function mockTmux(overrides?: Partial<TmuxAdapter>): TmuxAdapter {
  const tmux = {
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "codex"),
    capturePaneContent: vi.fn(async () => "OpenAI Codex (v0.0.0)\n› Ask Codex to do anything"),
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPanePid: vi.fn(async () => null),
    ...overrides,
  } as unknown as TmuxAdapter;
  return mockShellCommand(tmux);
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

/** Model file and directory Git markers through the adapter's filesystem seam. */
function mockProjectFs(files: Record<string, string>, markers: Record<string, "file" | "directory">): CodexAdapterFsOps {
  const ops = mockFs(files);
  const exists = ops.exists;
  ops.exists = (path) => path in markers || exists(path);
  ops.statMode = (path) => {
    const kind = markers[path];
    if (!kind) throw new Error(`Cannot stat ${path}`);
    return kind === "directory" ? fs.constants.S_IFDIR : fs.constants.S_IFREG;
  };
  return ops;
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

function testQueueRoot(sharedDocsRoot = nodePath.join(os.homedir(), ".openrig", "shared-docs")): string {
  return nodePath.join(sharedDocsRoot, "rigs", "test-rig", "state", "dev");
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function expectedFreshLaunchCommand(options: { cwd?: string; model?: string; effort?: string; queueRoot?: string | null } = {}): string {
  const cwd = options.cwd ?? "/project";
  const gitDirArg = ` --add-dir ${quote(nodePath.join(cwd, ".git"))}`;
  const queueDirArg = options.queueRoot === null ? "" : ` --add-dir ${quote(options.queueRoot ?? testQueueRoot())}`;
  const modelArg = options.model ? ` -m ${quote(options.model)}` : "";
  const effortArg = options.effort ? ` -c ${quote(`model_reasoning_effort="${options.effort}"`)}` : "";
  return `codex -s workspace-write '-c' 'check_for_update_on_startup=false' -C ${quote(cwd)}${gitDirArg}${queueDirArg}${modelArg}${effortArg}`;
}

function expectedResumeCommand(token = "sess-456", queueRoot: string | null = testQueueRoot(), model?: string, effort?: string): string {
  const queueDirArg = queueRoot === null ? "" : `--add-dir ${quote(queueRoot)} `;
  const modelArg = model ? ` -m ${quote(model)}` : "";
  const effortArg = effort ? ` -c ${quote(`model_reasoning_effort="${effort}"`)}` : "";
  return `codex -s workspace-write '-c' 'check_for_update_on_startup=false'${modelArg}${effortArg} resume ${queueDirArg}${quote(token)}`;
}

function expectedForkCommand(parentId = "parent-thread-id", options: { model?: string; effort?: string; queueRoot?: string | null } = {}): string {
  const queueDirArg = options.queueRoot === null ? "" : ` --add-dir ${quote(options.queueRoot ?? testQueueRoot())}`;
  const modelArg = options.model ? ` -m ${quote(options.model)}` : "";
  const effortArg = options.effort ? ` -c ${quote(`model_reasoning_effort="${options.effort}"`)}` : "";
  return `codex -s workspace-write '-c' 'check_for_update_on_startup=false'${modelArg}${effortArg} fork${queueDirArg} ${quote(parentId)}`;
}

function expectedProfileFreshLaunchCommand(profile: string, options: { cwd?: string; model?: string; queueRoot?: string | null } = {}): string {
  const cwd = options.cwd ?? "/project";
  const gitDirArg = ` --add-dir ${quote(nodePath.join(cwd, ".git"))}`;
  const queueDirArg = options.queueRoot === null ? "" : ` --add-dir ${quote(options.queueRoot ?? testQueueRoot())}`;
  const modelArg = options.model ? ` -m ${quote(options.model)}` : "";
  return `codex -p ${quote(profile)} '-c' 'check_for_update_on_startup=false' -C ${quote(cwd)}${gitDirArg}${queueDirArg}${modelArg}`;
}

function expectedProfileResumeCommand(profile: string, token = "sess-456", queueRoot: string | null = testQueueRoot()): string {
  const queueDirArg = queueRoot === null ? "" : `--add-dir ${quote(queueRoot)} `;
  return `codex -p ${quote(profile)} '-c' 'check_for_update_on_startup=false' resume ${queueDirArg}${quote(token)}`;
}

beforeEach(() => {
  // ENV-COUPLING HARDEN (housekeeping, qitem-20260711131501-e43707b0). DRIFT
  // VERDICT for the two launchHarness profile/model tests: ENV-SENSITIVITY,
  // NOT a stale assertion and NOT a product regression. launchHarness
  // CORRECTLY honors OPENRIG_SHARED_DOCS_ROOT for the Codex queue-state
  // writable root — that behavior is proven by the dedicated
  // "uses OPENRIG_SHARED_DOCS_ROOT" test, which stubs it explicitly. But the
  // profile/model launch-command tests assume the unset-fallback that
  // testQueueRoot() encodes (os.homedir()/.openrig/shared-docs). Some run
  // environments (the substrate host, provisioned VMs) export the var, which
  // flapped those two tests pass/fail while byte-identical. Neutralize the
  // ambient value so the default is deterministic; unstubAllEnvs() restores.
  vi.stubEnv("OPENRIG_SHARED_DOCS_ROOT", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function createCodexLogsDb(homeDir: string, pid: number, threadId: string, dbName = "logs_1.sqlite"): void {
  const codexDir = nodePath.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  seedCodexThreads(homeDir, [threadId]);
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
  it("launches the probed executable despite a different login-shell PATH", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "codex-launch-path-"));
    try {
      const selected = nodePath.join(root, "selected tools");
      const stale = nodePath.join(root, "stale");
      fs.mkdirSync(selected); fs.mkdirSync(stale);
      fs.writeFileSync(nodePath.join(selected, "codex"), "#!/bin/sh\nprintf selected", { mode: 0o755 });
      fs.writeFileSync(nodePath.join(stale, "codex"), "#!/bin/sh\nprintf stale", { mode: 0o755 });
      const tmux = mockTmux();
      const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), launchPath: selected + ":/usr/bin:/bin", sleep: async () => {} });
      await adapter.launchHarness(makeBinding(), { name: "operator@example-rig" });
      const command = vi.mocked(tmux.sendText).mock.calls[0]![1];
      const output = execFileSync("/bin/sh", ["-c", command], { env: { ...process.env, PATH: stale + ":/usr/bin:/bin" }, encoding: "utf8" });
      expect(output).toBe("selected");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
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

  it("checkReady reports a first-login gate instead of waiting for the runtime", async () => {
    const tmux = mockTmux({ capturePaneContent: vi.fn(async () => firstLoginPrompt) });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), listProcesses: () => [] });
    expect(await adapter.checkReady(makeBinding())).toMatchObject({ ready: false, code: "login_required" });
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(tmux.sendKeys).not.toHaveBeenCalled();
  });

  it.each(["bash", "node"])("checkReady rechecks a %s wrapper before reporting its first-login gate", async (paneCommand) => {
    for (const fixture of ["codex-first-login-no-daemon.txt", "codex-first-login-no-daemon-80x24.txt", "codex-api-key-login-no-daemon.txt"]) {
      const paneContent = fs.readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), "utf8");
      const tmux = mockTmux({
        getPaneCommand: vi.fn(async () => paneCommand),
        getPanePid: vi.fn(async () => 900),
        capturePaneContent: vi.fn(async () => paneContent),
      });
      const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), listProcesses: () => [
        { pid: 900, ppid: 1, command: paneCommand === "bash" ? "/bin/bash" : "node launcher", pgid: 900, tpgid: 901, executableName: paneCommand, startedAt: "Sat Jan  1 12:00:00 2000" },
        { pid: 901, ppid: 900, command: "codex", pgid: 901, tpgid: 901, executableName: "codex", startedAt: "Sat Jan  1 12:00:01 2000" },
      ] });
      expect(await adapter.checkReady(makeBinding()), fixture).toMatchObject({ ready: false, code: "login_required" });
      expect(tmux.capturePaneContent).toHaveBeenCalledTimes(2);
    }
  });

  it("checkReady does not revive a first-login screen left behind in an idle shell", async () => {
    const paneContent = fs.readFileSync(new URL("./fixtures/codex-api-key-login-no-daemon.txt", import.meta.url), "utf8");
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "bash"),
      getPanePid: vi.fn(async () => 900),
      capturePaneContent: vi.fn(async () => paneContent),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), listProcesses: () => [
      { pid: 900, ppid: 1, command: "/bin/bash", pgid: 900, tpgid: 900, executableName: "bash", startedAt: "Sat Jan  1 12:00:00 2000" },
    ] });
    expect(await adapter.checkReady(makeBinding())).toMatchObject({ ready: false, code: "returned_to_shell" });
  });

  it("checkReady accepts a non-gpt warning footer only with a verified Codex process", async () => {
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "zsh"),
      getPanePid: vi.fn(async () => 900),
      capturePaneContent: vi.fn(async () => [
        "› ",
        "  Ready · Context 13% used · anthropic/claude-3.5-sonnet         ⚠ 2 warnings · f2 to view",
      ].join("\n")),
    });
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "/bin/zsh", pgid: 900, tpgid: 901, executableName: "zsh", startedAt: "Sat Jan  1 12:00:00 2000" },
        { pid: 901, ppid: 900, command: "codex --model anthropic/claude-3.5-sonnet", pgid: 901, tpgid: 901, executableName: "codex", startedAt: "Sat Jan  1 12:00:01 2000" },
      ],
    });

    expect(await adapter.checkReady(makeBinding())).toEqual({ ready: true });
  });

  it("does not promote a stale shell capture after a verified Codex process appears", async () => {
    let captures = 0;
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "zsh"),
      getPanePid: vi.fn(async () => 900),
      capturePaneContent: vi.fn(async () => {
        captures++;
        return captures === 1
          ? "› \n  Ready · Context 13% used · anthropic/claude-3.5-sonnet         ⚠ 2 warnings · f2 to view"
          : "  project2 · main\n› codex resume 019a136b-0000-7000-8000-000000000001";
      }),
    });
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "/bin/zsh", pgid: 900, tpgid: 901, executableName: "zsh", startedAt: "Sat Jan  1 12:00:00 2000" },
        { pid: 901, ppid: 900, command: "codex --model anthropic/claude-3.5-sonnet", pgid: 901, tpgid: 901, executableName: "codex", startedAt: "Sat Jan  1 12:00:01 2000" },
      ],
    });

    expect(await adapter.checkReady(makeBinding())).toMatchObject({ ready: false });
    expect(captures).toBe(2);
  });

  it("checkReady returns false when the pane has fallen back to a shell prompt", async () => {
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "zsh"),
      getPanePid: vi.fn(async () => 900),
      capturePaneContent: vi.fn(async () => "user@example.test rigged %"),
    });
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "/bin/zsh", pgid: 900, tpgid: 900, executableName: "zsh", startedAt: "Sat Jan  1 12:00:00 2000" },
      ],
    });

    const result = await adapter.checkReady(makeBinding());

    expect(result).toEqual({
      ready: false,
      reason: "The probe pane returned to a shell instead of staying inside the runtime.",
      code: "returned_to_shell",
    });
  });

  it("checkReady returns awaiting_runtime when paneCommand is a shell that is not a proven idle shell", async () => {
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "bash"),
      getPanePid: vi.fn(async () => 900),
      capturePaneContent: vi.fn(async () => "booting wrapper..."),
    });
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "/bin/bash", pgid: 900, tpgid: 901, executableName: "bash", startedAt: "Sat Jan  1 12:00:00 2000" },
        { pid: 901, ppid: 900, command: "codex", pgid: 901, tpgid: 901, executableName: "codex", startedAt: "Sat Jan  1 12:00:00 2000" },
      ],
    });

    const result = await adapter.checkReady(makeBinding());

    expect(result).toEqual({
      ready: false,
      reason: "The pane shows a shell that is not a proven idle shell; a launch script may still be starting Codex.",
      code: "awaiting_runtime",
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
        "<!-- BEGIN OpenRig MANAGED BLOCK: using-openrig.md -->",
        "# Using OpenRig",
        "Old guidance",
        "<!-- END OpenRig MANAGED BLOCK: using-openrig.md -->",
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
    expect(content).toContain("BEGIN OpenRig MANAGED BLOCK: openrig-start.md");
    expect(content).not.toContain("BEGIN OpenRig MANAGED BLOCK: using-openrig.md");
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
    expect(tmux.sendKeys).toHaveBeenCalledWith("r01-qa", ["Enter"]);
  });

  // OPR.0.3.3.16 - a >100KB send_text startup pack must still travel through the
  // sendText -> sleep -> sendKeys(["Enter"]) sequence unchanged. The large-payload
  // buffer mechanics live in TmuxAdapter; the adapter hands the full content to
  // sendText and fires the single trailing submit.
  it("delivers a large (>100KB) send_text startup file via sendText then submits with Enter", async () => {
    const tmux = mockTmux();
    const big = "L".repeat(120 * 1024);
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs({ "/rig/startup/big-pack.md": big }),
      sleep: async () => {},
    });
    const file: ResolvedStartupFile = {
      path: "startup/big-pack.md", absolutePath: "/rig/startup/big-pack.md", ownerRoot: "/rig",
      deliveryHint: "send_text", required: true, appliesOn: ["fresh_start", "restore"],
    };

    const result = await adapter.deliverStartup([file], makeBinding());

    expect(result.delivered).toBe(1);
    expect(result.failed).toEqual([]);
    // The full payload is handed to sendText (TmuxAdapter routes it to the buffer path).
    expect(tmux.sendText).toHaveBeenCalledWith("r01-qa", big);
    // Single trailing submit preserved.
    expect(tmux.sendKeys).toHaveBeenCalledWith("r01-qa", ["Enter"]);
  });

  // T12: replay on restore is safe for already-projected content
  it("replay on restore is safe for already-projected content", async () => {
    const fs = mockFs({
      "/rig/guide.md": "# Guidance",
      "/project/AGENTS.md": "<!-- BEGIN OpenRig MANAGED BLOCK: guide.md -->\n# Guidance\n<!-- END OpenRig MANAGED BLOCK: guide.md -->",
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
    const blockCount = (content.match(/BEGIN OpenRig MANAGED BLOCK/g) ?? []).length;
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
      // Housekeeping B1 fixback: inject a controlled preflight so no real
      // `codex -p fleet mcp list` subprocess runs. Assertions below unchanged —
      // they were always about launch-command shape, now tested hermetically.
      verifyProfilePreflight: async (profile) => ({ ok: true, profile }),
    });
    const binding = { ...makeBinding(), codexConfigProfile: "fleet" };

    const result = await adapter.launchHarness(binding, { name: "dev-qa@test-rig" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith("r01-qa", expectedProfileFreshLaunchCommand("fleet"));
  });

  it("omits generated writable roots for a read-only profile on fresh, resume and fork launches", async () => {
    const codexHome = "/private/codex";
    const fsOps = mockFs({ [`${codexHome}/locked.config.toml`]: 'sandbox_mode = "read-only"\napproval_policy = "never"\n' });
    const resolveGitAddDirs = vi.fn(async () => ["/project/.git"]);
    const options = [
      { name: "dev-qa@test-rig" },
      { name: "dev-qa@test-rig", resumeToken: "sess-456" },
      { name: "dev-qa@test-rig", forkSource: { kind: "native_id" as const, value: "parent-thread-id" } },
    ];
    for (const opts of options) {
      const proof = provenCodexResume("sess-456");
      const tmux = mockTmux({ getPanePid: proof.getPanePid });
      const adapter = new CodexRuntimeAdapter({
        tmux, fsOps, codexHome, resolveGitAddDirs,
        listProcesses: proof.listProcesses as never, readResumeEvidence: proof.readResumeEvidence,
        sleep: async () => {},
        verifyProfilePreflight: async (profile) => ({ ok: true, profile }),
      });
      const binding = { ...makeBinding(), codexConfigProfile: "locked", model: "gpt-5.5", effort: "high" };

      await adapter.launchHarness(binding, opts);

      const command = vi.mocked(tmux.sendText).mock.calls[0]?.[1];
      expect(command).toContain("-p 'locked'");
      expect(command).toContain("-m 'gpt-5.5'");
      expect(command).toContain("model_reasoning_effort=\"high\"");
      expect(command).not.toContain("--add-dir");
      expect(command).not.toContain("workspace-write");
      expect(command).not.toContain("danger-full-access");
    }
    expect(resolveGitAddDirs).not.toHaveBeenCalled();
  });

  it.each(['sandbox_mode = "workspace-write"\n', 'sandbox_mode = [\n'])(
    "ignores above-root config %s on fresh, resume and fork launches", async aboveRootConfig => {
      const codexHome = "/private/codex";
      const fsOps = mockProjectFs({
        [`${codexHome}/locked.config.toml`]: 'sandbox_mode = "read-only"\n',
        "/workspace/.codex/config.toml": aboveRootConfig,
      }, { "/workspace/repo/.git": "file" });
      const resolveGitAddDirs = vi.fn(async () => ["/outside/repo-metadata"]);
      for (const opts of [
        { name: "dev-qa@test-rig" },
        { name: "dev-qa@test-rig", resumeToken: "sess-456" },
        { name: "dev-qa@test-rig", forkSource: { kind: "native_id" as const, value: "parent-thread-id", pendingIdAllowed: true } },
      ]) {
        const proof = provenCodexResume("sess-456");
        const tmux = mockTmux({ getPanePid: proof.getPanePid });
        const adapter = new CodexRuntimeAdapter({
          tmux, fsOps, codexHome, resolveGitAddDirs,
          listProcesses: proof.listProcesses as never, readResumeEvidence: proof.readResumeEvidence,
          sleep: async () => {}, verifyProfilePreflight: async profile => ({ ok: true, profile }),
        });
        expect(await adapter.launchHarness({ ...makeBinding("/workspace/repo/src"), codexConfigProfile: "locked" }, opts)).toMatchObject({ ok: true });
        expect(vi.mocked(tmux.sendText).mock.calls[0]?.[1]).not.toContain("--add-dir");
      }
      expect(resolveGitAddDirs).not.toHaveBeenCalled();
    },
  );

  it("accepts a .git directory with HEAD as the root and skips an incomplete nearer .git directory", async () => {
    const codexHome = "/private/codex";
    const fsOps = mockProjectFs({
      [`${codexHome}/locked.config.toml`]: 'sandbox_mode = "read-only"\n',
      "/workspace/.codex/config.toml": 'sandbox_mode = "workspace-write"\n',
      "/workspace/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/workspace/repo/.codex/config.toml": 'sandbox_mode = "workspace-write"\n',
    }, { "/workspace/repo/.git": "directory", "/workspace/repo/src/.git": "directory" });
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({
      tmux, fsOps, codexHome, resolveGitAddDirs: async () => ["/outside/repo-metadata"],
      listProcesses: () => [], sleep: async () => {}, verifyProfilePreflight: async profile => ({ ok: true, profile }),
    });
    expect(await adapter.launchHarness({ ...makeBinding("/workspace/repo/src"), codexConfigProfile: "locked" }, { name: "dev-qa@test-rig" })).toMatchObject({ ok: true });
    const command = vi.mocked(tmux.sendText).mock.calls[0]?.[1];
    expect(command).toContain("--add-dir '/outside/repo-metadata'");
    expect(command).toContain(`--add-dir '${testQueueRoot()}'`);
  });

  it("keeps roots when permission-only marker mode cannot prove an incomplete .git is a file", async () => {
    const codexHome = "/private/codex";
    const fsOps = mockProjectFs({
      [`${codexHome}/locked.config.toml`]: 'sandbox_mode = "read-only"\n',
      "/workspace/repo/.codex/config.toml": 'sandbox_mode = "workspace-write"\n',
    }, { "/workspace/repo/.git": "file", "/workspace/repo/src/.git": "directory" });
    const statMode = fsOps.statMode!;
    fsOps.statMode = path => path === "/workspace/repo/src/.git" ? 0o755 : statMode(path);
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({
      tmux, fsOps, codexHome, resolveGitAddDirs: async () => ["/outside/repo-metadata"],
      listProcesses: () => [], sleep: async () => {}, verifyProfilePreflight: async profile => ({ ok: true, profile }),
    });
    expect(await adapter.launchHarness({ ...makeBinding("/workspace/repo/src"), codexConfigProfile: "locked" }, { name: "dev-qa@test-rig" })).toMatchObject({ ok: true });
    expect(vi.mocked(tmux.sendText).mock.calls[0]?.[1]).toContain("--add-dir '/outside/repo-metadata'");
  });

  it("retains roots when custom project markers or marker metadata make discovery uncertain", async () => {
    const codexHome = "/private/codex";
    for (const fsOps of [
      mockProjectFs({ [`${codexHome}/locked.config.toml`]: 'sandbox_mode = "read-only"\n',
        [`${codexHome}/config.toml`]: 'project_root_markers = [".repo"]\n' }, { "/workspace/repo/.git": "file" }),
      mockFs({ [`${codexHome}/locked.config.toml`]: 'sandbox_mode = "read-only"\n', "/workspace/repo/.git": "gitdir: elsewhere" }),
    ]) {
      const tmux = mockTmux();
      const adapter = new CodexRuntimeAdapter({
        tmux, fsOps, codexHome, resolveGitAddDirs: async () => ["/outside/repo-metadata"],
        listProcesses: () => [], sleep: async () => {}, verifyProfilePreflight: async profile => ({ ok: true, profile }),
      });
      expect(await adapter.launchHarness({ ...makeBinding("/workspace/repo/src"), codexConfigProfile: "locked" }, { name: "dev-qa@test-rig" })).toMatchObject({ ok: true });
      expect(vi.mocked(tmux.sendText).mock.calls[0]?.[1]).toContain("--add-dir '/outside/repo-metadata'");
    }
  });

  it.each([
    ["default system", "/etc/codex", "/etc/codex/config.toml"],
    ["custom system directory", "/private/system-codex", "/private/system-codex/config.toml"],
    ["legacy managed", "/etc/codex", "/etc/codex/managed_config.toml"],
  ])("keeps roots for %s project markers loaded before discovery", async (_label, codexSystemConfigDir, layerPath) => {
    const codexHome = "/private/codex";
    const fsOps = mockProjectFs({
      [`${codexHome}/locked.config.toml`]: 'sandbox_mode = "read-only"\n',
      [layerPath]: 'project_root_markers = [".repo"]\n',
      "/workspace/.codex/config.toml": 'sandbox_mode = "workspace-write"\n',
    }, { "/workspace/repo/.git": "file", "/workspace/.repo": "file" });
    const writeFile = vi.spyOn(fsOps, "writeFile");
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({
      tmux, fsOps, codexHome, codexSystemConfigDir, resolveGitAddDirs: async () => ["/outside/repo-metadata"],
      listProcesses: () => [], sleep: async () => {}, verifyProfilePreflight: async profile => ({ ok: true, profile }),
    });
    expect(await adapter.launchHarness({ ...makeBinding("/workspace/repo/src"), codexConfigProfile: "locked" }, { name: "dev-qa@test-rig" })).toMatchObject({ ok: true });
    expect(vi.mocked(tmux.sendText).mock.calls[0]?.[1]).toContain("--add-dir '/outside/repo-metadata'");
    expect(writeFile).not.toHaveBeenCalledWith(layerPath, expect.anything());
  });

  it.each([
    ["named permissions", 'default_permissions = ":workspace"\n'],
    ["malformed markers", "project_root_markers = [\n"],
    ["unreadable config", "present but unreadable"],
  ])("keeps roots for %s in a fixed system layer", async (label, systemConfig) => {
    const codexHome = "/private/codex";
    const tmux = mockTmux();
    const fsOps = mockProjectFs({
      [`${codexHome}/locked.config.toml`]: 'sandbox_mode = "read-only"\n',
      "/etc/codex/config.toml": systemConfig,
    }, { "/workspace/repo/.git": "file" });
    if (label === "unreadable config") {
      const readFile = fsOps.readFile;
      fsOps.readFile = path => {
        if (path === "/etc/codex/config.toml") throw new Error("injected read failure");
        return readFile(path);
      };
    }
    const adapter = new CodexRuntimeAdapter({
      tmux, codexHome, fsOps,
      resolveGitAddDirs: async () => ["/outside/repo-metadata"],
      listProcesses: () => [], sleep: async () => {}, verifyProfilePreflight: async profile => ({ ok: true, profile }),
    });
    expect(await adapter.launchHarness({ ...makeBinding("/workspace/repo/src"), codexConfigProfile: "locked" }, { name: "dev-qa@test-rig" })).toMatchObject({ ok: true });
    expect(vi.mocked(tmux.sendText).mock.calls[0]?.[1]).toContain("--add-dir '/outside/repo-metadata'");
  });

  it("keeps generated roots when a project layer makes a read-only profile writable", async () => {
    const codexHome = "/private/codex";
    const projectPath = "/project/.codex/config.toml";
    const projectContent = 'sandbox_mode = "workspace-write"\n';
    const fsOps = mockProjectFs({
      [`${codexHome}/locked.config.toml`]: 'sandbox_mode = "read-only"\n',
      [projectPath]: projectContent,
    }, { "/project/.git": "file" });
    const writeFile = vi.spyOn(fsOps, "writeFile");
    const options = [
      { name: "dev-qa@test-rig" },
      { name: "dev-qa@test-rig", resumeToken: "sess-456" },
      { name: "dev-qa@test-rig", forkSource: { kind: "native_id" as const, value: "parent-thread-id", pendingIdAllowed: true } },
    ];
    for (const opts of options) {
      const proof = provenCodexResume("sess-456");
      const tmux = mockTmux({ getPanePid: proof.getPanePid });
      const adapter = new CodexRuntimeAdapter({
        tmux, fsOps, codexHome, resolveGitAddDirs: async () => ["/project/.git"],
        listProcesses: proof.listProcesses as never, readResumeEvidence: proof.readResumeEvidence,
        sleep: async () => {}, verifyProfilePreflight: async (profile) => ({ ok: true, profile }),
      });

      const result = await adapter.launchHarness({ ...makeBinding("/project/src"), codexConfigProfile: "locked" }, opts);

      expect(result, JSON.stringify(opts)).toMatchObject({ ok: true });
      const command = vi.mocked(tmux.sendText).mock.calls[0]?.[1];
      expect(command).toContain("-p 'locked'");
      if (!opts.resumeToken && !opts.forkSource) expect(command).toContain("--add-dir '/project/.git'");
      expect(command).toContain(`--add-dir '${testQueueRoot()}'`);
    }
    expect(fsOps.readFile(projectPath)).toBe(projectContent);
    expect(writeFile).not.toHaveBeenCalledWith(projectPath, expect.anything());
  });

  it("keeps generated roots when a project config layer cannot be parsed", async () => {
    const codexHome = "/private/codex";
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({
      tmux, codexHome, fsOps: mockFs({
        [`${codexHome}/locked.config.toml`]: 'sandbox_mode = "read-only"\n',
        "/project/.codex/config.toml": "sandbox_mode = [\n",
      }),
      resolveGitAddDirs: async () => ["/project/.git"],
      listProcesses: () => [], sleep: async () => {},
      verifyProfilePreflight: async (profile) => ({ ok: true, profile }),
    });

    const result = await adapter.launchHarness({ ...makeBinding(), codexConfigProfile: "locked" }, { name: "dev-qa@test-rig" });

    expect(result.ok).toBe(true);
    const command = vi.mocked(tmux.sendText).mock.calls[0]?.[1];
    expect(command).toContain("--add-dir '/project/.git'");
    expect(command).toContain(`--add-dir '${testQueueRoot()}'`);
  });

  it("does not treat the lower-priority user config as a project override", async () => {
    const codexHome = "/home/test/.codex";
    const resolveGitAddDirs = vi.fn(async () => ["/home/test/project/.git"]);
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({
      tmux, codexHome, fsOps: mockFs({
        [`${codexHome}/locked.config.toml`]: 'sandbox_mode = "read-only"\n',
        [`${codexHome}/config.toml`]: 'sandbox_mode = "workspace-write"\n',
      }),
      resolveGitAddDirs, listProcesses: () => [], sleep: async () => {},
      verifyProfilePreflight: async (profile) => ({ ok: true, profile }),
    });

    const result = await adapter.launchHarness({ ...makeBinding("/home/test/project"), codexConfigProfile: "locked" }, { name: "dev-qa@test-rig" });

    expect(result.ok).toBe(true);
    expect(vi.mocked(tmux.sendText).mock.calls[0]?.[1]).not.toContain("--add-dir");
    expect(resolveGitAddDirs).not.toHaveBeenCalled();
  });

  it("keeps generated roots when named permissions or unreadable user config leave the sandbox uncertain", async () => {
    const codexHome = "/home/test/.codex";
    for (const files of [
      { [`${codexHome}/locked.config.toml`]: 'sandbox_mode = "read-only"\ndefault_permissions = ":workspace"\n' },
      { [`${codexHome}/locked.config.toml`]: 'sandbox_mode = "read-only"\n',
        [`${codexHome}/config.toml`]: 'default_permissions = ":workspace"\n' },
      { [`${codexHome}/locked.config.toml`]: 'sandbox_mode = "read-only"\n',
        [`${codexHome}/config.toml`]: 'default_permissions = [\n' },
    ]) {
      const tmux = mockTmux();
      const adapter = new CodexRuntimeAdapter({
        tmux, codexHome, fsOps: mockFs(files),
        resolveGitAddDirs: async () => ["/home/test/project/.git"],
        listProcesses: () => [], sleep: async () => {},
        verifyProfilePreflight: async (profile) => ({ ok: true, profile }),
      });

      const result = await adapter.launchHarness({ ...makeBinding("/home/test/project"), codexConfigProfile: "locked" }, { name: "dev-qa@test-rig" });

      expect(result.ok).toBe(true);
      const command = vi.mocked(tmux.sendText).mock.calls[0]?.[1];
      expect(command).toContain("--add-dir '/home/test/project/.git'");
      expect(command).toContain(`--add-dir '${testQueueRoot()}'`);
    }
  });

  it("keeps generated roots when an untrusted read-only child can leave a writable parent active", async () => {
    const codexHome = "/private/codex";
    const userPath = `${codexHome}/config.toml`;
    const userContent = '[projects."/project"]\ntrust_level = "trusted"\n[projects."/project/src"]\ntrust_level = "untrusted"\n';
    const fsOps = mockProjectFs({
      [`${codexHome}/locked.config.toml`]: 'sandbox_mode = "read-only"\n',
      [userPath]: userContent,
      "/project/.codex/config.toml": 'sandbox_mode = "workspace-write"\n',
      "/project/src/.codex/config.toml": 'sandbox_mode = "read-only"\n',
    }, { "/project/.git": "file" });
    const writeFile = vi.spyOn(fsOps, "writeFile");
    const resolveGitAddDirs = vi.fn(async () => ["/outside/repo-metadata"]);
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({
      tmux, codexHome, fsOps,
      resolveGitAddDirs, listProcesses: () => [], sleep: async () => {},
      verifyProfilePreflight: async (profile) => ({ ok: true, profile }),
    });

    const result = await adapter.launchHarness({ ...makeBinding("/project/src"), codexConfigProfile: "locked" }, { name: "dev-qa@test-rig" });

    expect(result.ok).toBe(true);
    const command = vi.mocked(tmux.sendText).mock.calls[0]?.[1];
    expect(command).toContain("--add-dir '/outside/repo-metadata'");
    expect(command).toContain(`--add-dir '${testQueueRoot()}'`);
    expect(resolveGitAddDirs).toHaveBeenCalled();
    expect(fsOps.readFile(userPath)).toBe(userContent);
    expect(writeFile).not.toHaveBeenCalledWith(userPath, expect.anything());
  });

  it("keeps generated writable roots for writable, absent and unreadable profiles, and an overriding posture", async () => {
    const codexHome = "/private/codex";
    const files = mockFs({
      [`${codexHome}/writable.config.toml`]: 'sandbox_mode = "workspace-write"\n',
      [`${codexHome}/malformed.config.toml`]: 'sandbox_mode = [\n',
      [`${codexHome}/locked.config.toml`]: 'sandbox_mode = "read-only"\n',
    });
    for (const [profile, launchPosture] of [
      ["writable", undefined], ["missing", undefined], ["malformed", undefined], ["locked", "full_bypass"],
    ] as const) {
      const tmux = mockTmux();
      const adapter = new CodexRuntimeAdapter({
        tmux, fsOps: files, codexHome,
        resolveGitAddDirs: async () => ["/project/.git"],
        listProcesses: () => [], sleep: async () => {},
        verifyProfilePreflight: async (selected) => ({ ok: true, profile: selected }),
      });
      const binding = { ...makeBinding(), codexConfigProfile: profile, launchPosture };

      await adapter.launchHarness(binding, { name: "dev-qa@test-rig" });

      const command = vi.mocked(tmux.sendText).mock.calls[0]?.[1];
      expect(command).toContain(`--add-dir '/project/.git'`);
      expect(command).toContain(`--add-dir '${testQueueRoot()}'`);
      if (launchPosture) expect(command).toContain("-s danger-full-access -a never");
      else expect(command).toContain(`-p '${profile}'`);
    }
  });

  it("preserves a running launch's carried add-dirs without reading its now read-only profile", async () => {
    const codexHome = "/private/codex";
    const profilePath = `${codexHome}/locked.config.toml`;
    const fsOps = mockFs({ [profilePath]: 'sandbox_mode = "read-only"\n' });
    const readFile = vi.spyOn(fsOps, "readFile");
    const verifyProfilePreflight = vi.fn(async (profile: string) => ({ ok: true, profile }));
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps, codexHome, verifyProfilePreflight });
    const binding = { ...makeBinding(), codexConfigProfile: "locked" };

    const result = await adapter.buildResumeCommand(binding, {
      name: "dev-qa@test-rig", resumeToken: "sess-456",
      running: { addDirs: ["/carried/git", "/carried/queue"], daemonOptOut: true, networkOverride: false },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.core).toContain("--add-dir '/carried/git'");
    expect(result.core).toContain("--add-dir '/carried/queue'");
    expect(result.core).not.toContain(testQueueRoot());
    expect(readFile).not.toHaveBeenCalledWith(profilePath);
    expect(verifyProfilePreflight).not.toHaveBeenCalled();
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

  it.each([
    ["legacy", false], ["current", false], ["legacy", true], ["current", true],
  ] as const)("launchHarness skips the %s Codex update prompt exactly once (persistent=%s)", async (layout, persistent) => {
    const initialShell = [
      expectedFreshLaunchCommand(),
      "admin@host project %",
    ].join("\n");
    const updatePrompt = layout === "current" ? currentUpdatePrompt : [
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
      capturePaneScreen: vi.fn()
        .mockResolvedValueOnce(initialShell)
        .mockResolvedValueOnce(updatePrompt)
        .mockResolvedValueOnce(updatePrompt)
        .mockResolvedValue(persistent ? updatePrompt : "OpenAI Codex (v0.120.0)\n› Ask Codex to do anything"),
      getPanePid: vi.fn(async () => 900),
    });
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "-zsh", pgid: 900, tpgid: 901, executableName: "zsh", startedAt: "Sat Jan  1 12:00:00 2000" },
        { pid: 901, ppid: 900, command: "codex", pgid: 901, tpgid: 901, executableName: "codex", startedAt: "Sat Jan  1 12:00:00 2000" },
      ],
      readThreadIdByPid: (pid) => pid === 901 ? "019d45bc-117d-78a3-a4ad-6fb186e5a86d" : undefined,
      sleep: async () => {},
    });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig" });

    expect(result).toEqual({
      ok: true,
      resumeToken: "019d45bc-117d-78a3-a4ad-6fb186e5a86d",
      resumeType: "codex_id",
      appliedLaunch: CODEX_FLOOR_EFFECT,
    });
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText.mock.calls).toEqual([
      ["r01-qa", expectedFreshLaunchCommand()],
    ]);
    const sendKeys = tmux.sendKeys as ReturnType<typeof vi.fn>;
    expect(sendKeys.mock.calls).toEqual([
      ["r01-qa", ["Enter"]],
      ["r01-qa", ["3"]],
    ]);
  });

  it.each(["legacy", "current"])("launchHarness does not choose a %s Codex update action without option 3", async (layout) => {
    const tmux = mockTmux({
      capturePaneScreen: vi.fn(async () => (layout === "current" ? currentUpdatePrompt
        : "✨ Update available! 0.120.0 -> 0.121.0\n  2. Skip\n  3. Skip until next version")
        .replace(/^.*3\. Skip until next version.*$/m, "")),
      getPanePid: vi.fn(async () => 900),
    });
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "-zsh", pgid: 900, tpgid: 901, executableName: "zsh", startedAt: "Sat Jan  1 12:00:00 2000" },
        { pid: 901, ppid: 900, command: "codex", pgid: 901, tpgid: 901, executableName: "codex", startedAt: "Sat Jan  1 12:00:00 2000" },
      ],
      readThreadIdByPid: () => "019d45bc-117d-78a3-a4ad-6fb186e5a86d",
      sleep: async () => {},
    });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig" });

    expect(result.ok).toBe(true);
    // The shell launch gets Enter; no menu key or subsequent Enter is sent.
    expect(vi.mocked(tmux.sendKeys).mock.calls).toEqual([["r01-qa", ["Enter"]]]);
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
      getPaneCommand: vi.fn()
        .mockResolvedValueOnce("zsh").mockResolvedValueOnce("zsh")
        .mockResolvedValueOnce("zsh").mockResolvedValueOnce("zsh")
        .mockResolvedValueOnce("zsh").mockResolvedValueOnce("zsh")
        .mockResolvedValue("codex"),
      capturePaneScreen: vi.fn()
        .mockResolvedValueOnce(initialShell)
        .mockResolvedValueOnce(initialShell)
        .mockResolvedValueOnce(initialShell)
        .mockResolvedValueOnce(initialShell)
        .mockResolvedValueOnce(initialShell)
        .mockResolvedValueOnce(initialShell)
        .mockResolvedValueOnce(updatePrompt)
        .mockResolvedValueOnce(updatePrompt)
        .mockResolvedValue("OpenAI Codex (v0.120.0)\n› Ask Codex to do anything"),
      getPanePid: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(900),
    });
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "-zsh", pgid: 900, tpgid: 901, executableName: "zsh", startedAt: "Sat Jan  1 12:00:00 2000" },
        { pid: 901, ppid: 900, command: "codex", pgid: 901, tpgid: 901, executableName: "codex", startedAt: "Sat Jan  1 12:00:00 2000" },
      ],
      readThreadIdByPid: (pid) => pid === 901 ? "019d45bc-117d-78a3-a4ad-6fb186e5a86d" : undefined,
      sleep: async () => {},
    });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig" });

    expect(result).toEqual({
      ok: true,
      resumeToken: "019d45bc-117d-78a3-a4ad-6fb186e5a86d",
      resumeType: "codex_id",
      appliedLaunch: CODEX_FLOOR_EFFECT,
    });
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText.mock.calls).toEqual([
      ["r01-qa", expectedFreshLaunchCommand()],
    ]);
    expect(tmux.sendKeys).toHaveBeenLastCalledWith("r01-qa", ["3"]);
  });

  it("uses the visible conversation rather than dismissed loading/review scrollback", async () => {
    const tmux = mockTmux({ capturePaneContent: vi.fn(async () => "OpenAI Codex (v0.153.4)\nmodel: loading\nHooks need review\nTrust all and continue"),
      capturePaneScreen: vi.fn(async () => "› Ask Codex to do anything\n  gpt-6-astra xhigh · /work") });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs() });
    expect(await adapter.checkReady(makeBinding())).toEqual({ ready: true });
    expect(tmux.capturePaneContent).not.toHaveBeenCalled();
    vi.mocked(tmux.capturePaneScreen).mockResolvedValue(null);
    expect((await adapter.checkReady(makeBinding())).ready).toBe(false);
  });

  it("does not type a blanket trust choice into fresh hook review", async () => {
    const tmux = mockTmux({ capturePaneContent: vi.fn(async () => "Hooks need review\n1. Review hooks\n2. Trust all and continue\n3. Continue without trusting"), getPanePid: vi.fn(async () => 900) });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {}, listProcesses: () => [] });
    await adapter.launchHarness(makeBinding(), { name: "impl" });
    expect(tmux.sendText).toHaveBeenCalledTimes(1);
    expect(tmux.sendKeys).toHaveBeenCalledTimes(1);
  });

  it("a resume stopped at hook review reports the gate kind, and types nothing into it", async () => {
    const review = "Hooks need review\n1. Review hooks\n2. Trust all and continue\n3. Continue without trusting";
    const tmux = mockTmux({ capturePaneContent: vi.fn(async () => review), capturePaneScreen: vi.fn(async () => review), getPaneCommand: vi.fn(async () => "codex") });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {}, listProcesses: () => [] });
    const result = await adapter.verifyResumeInPane("impl", "tok");
    expect(result).toMatchObject({ ok: false, recovery: "attention_required", gate: "hook_trust_gate" });
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  // What a failed resume reports must match the newest screen observed and what was typed (reporting only).
  const UPDATING = ["✨ Update available! 0.120.0 -> 0.121.0", "Updating Codex..."].join("\n"); // no skip option
  const HOOK_REVIEW = "Hooks need review\n1. Review hooks\n2. Trust all and continue\n3. Continue without trusting";
  const SKIPPABLE = ["✨ Update available! 0.120.0 -> 0.121.0", "› 1. Update now (runs `npm install -g @openai/codex`)", "  2. Skip", "  3. Skip until next version", "Press enter to continue"].join("\n");
  function screens(next: () => string) {
    const capture = vi.fn(async () => next());
    return mockTmux({ capturePaneContent: capture, capturePaneScreen: capture, getPaneCommand: vi.fn(async () => "codex"), getPanePid: vi.fn(async () => 901) });
  }

  it("an update still in progress is reported as an update screen with no choice, and nothing typed", async () => {
    const tmux = screens(() => UPDATING);
    const result = await new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {}, listProcesses: () => [] }).verifyResumeInPane("impl", "tok");
    expect(result).toMatchObject({ ok: false, gate: "update_gate", gateChoice: false, verifierInput: "none" });
    expect(tmux.sendKeys).not.toHaveBeenCalled();
  });

  it("when the update helper's own later capture shows hook review, the report names hook review, not the older update screen", async () => {
    // Count the captures a stable update run makes; then show hook review only at the last one, which is the helper's
    // nested capture on the final quick poll.
    const counter = screens(() => UPDATING);
    await new CodexRuntimeAdapter({ tmux: counter, fsOps: mockFs(), sleep: async () => {}, listProcesses: () => [] }).verifyResumeInPane("impl", "tok");
    const total = (counter.capturePaneScreen as ReturnType<typeof vi.fn>).mock.calls.length;
    let n = 0;
    const tmux = screens(() => (++n === total ? HOOK_REVIEW : UPDATING));
    const result = await new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {}, listProcesses: () => [] }).verifyResumeInPane("impl", "tok");
    expect(n).toBe(total);
    expect(result).toMatchObject({ ok: false, recovery: "attention_required", gate: "hook_trust_gate" });
    expect((result as { evidence: string }).evidence).toContain("Hooks need review");
    expect(tmux.sendKeys).not.toHaveBeenCalled();
  });

  it("a skip key sent to an update prompt that stays on screen is reported as sent, with the choice-bearing update screen", async () => {
    const tmux = screens(() => SKIPPABLE);
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {},
      listProcesses: () => [{ pid: 901, ppid: 1, pgid: 901, tpgid: 901, executableName: "codex", startedAt: "Sat Jan  1 12:00:00 2000", command: "codex" }] });
    const result = await adapter.verifyResumeInPane("impl", "tok");
    expect(tmux.sendKeys).toHaveBeenCalledTimes(1);
    expect(tmux.sendKeys).toHaveBeenCalledWith("impl", ["3"]);
    expect(result).toMatchObject({ ok: false, gate: "update_gate", gateChoice: true, verifierInput: "update_skip_key_sent" });
    // Captured again after the key, so the reported screen isn't the one before it.
    expect(result).not.toHaveProperty("screenBeforeInput");
  });

  // Round 3: the newest observation wins in the order it was taken, including the helper's current-screen recheck, and
  // a screen OpenRig acted on afterwards is reported as the screen before that input.
  const RESUMED = "OpenAI Codex (v0.120.0)\n› Ask Codex to do anything";
  const CODEX_ROW = [{ pid: 901, ppid: 1, pgid: 901, tpgid: 901, executableName: "codex", startedAt: "Sat Jan  1 12:00:00 2000", command: "codex" }];
  /** How many screen captures a run on an unchanging, unskippable update screen makes. */
  async function updatingCaptures(): Promise<number> {
    const counter = screens(() => UPDATING);
    await new CodexRuntimeAdapter({ tmux: counter, fsOps: mockFs(), sleep: async () => {}, listProcesses: () => [] }).verifyResumeInPane("impl", "tok");
    return (counter.capturePaneScreen as ReturnType<typeof vi.fn>).mock.calls.length;
  }

  it("(a) when the helper's current-screen recheck shows hook review, the report names hook review", async () => {
    // Final quick poll: the loop sees the update screen, the helper's first capture is skippable, and its recheck (one
    // capture more than an unskippable run makes) shows hook review. No key is sent.
    const total = await updatingCaptures() + 1;
    let n = 0;
    const tmux = screens(() => { n++; return n === total ? HOOK_REVIEW : n === total - 1 ? SKIPPABLE : UPDATING; });
    const result = await new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {}, listProcesses: () => CODEX_ROW }).verifyResumeInPane("impl", "tok");
    expect(n).toBe(total);
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, recovery: "attention_required", gate: "hook_trust_gate", verifierInput: "none" });
    expect((result as { evidence: string }).evidence).toContain("Hooks need review");
  });

  it("(b) when the helper's capture on the last quick poll shows a resumed screen, no older gate is reported as current", async () => {
    const total = await updatingCaptures();
    let n = 0;
    const tmux = screens(() => (++n === total ? RESUMED : UPDATING));
    const result = await new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {}, listProcesses: () => CODEX_ROW }).verifyResumeInPane("impl", "tok");
    expect(n).toBe(total);
    expect(result).toMatchObject({ ok: false, recovery: "attention_required" });
    expect(result).not.toHaveProperty("gate");
    expect((result as { evidence: string }).evidence).toContain("Ask Codex to do anything");
  });

  it.each([["sent", { ok: true }], ["failed", { ok: false, code: "unknown", message: "injected send failure" }]] as const)(
    "(c) an update prompt first seen on the last quick poll, skip key %s, no later capture: reported as the screen before the key",
    async (outcome, sendResult) => {
      // The loop's capture and the helper's two captures on the final quick poll show the skippable prompt.
      const total = await updatingCaptures() + 1;
      let n = 0;
      const tmux = screens(() => (++n >= total - 2 ? SKIPPABLE : UPDATING));
      (tmux.sendKeys as ReturnType<typeof vi.fn>).mockResolvedValue(sendResult);
      const result = await new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {}, listProcesses: () => CODEX_ROW }).verifyResumeInPane("impl", "tok");
      expect(n).toBe(total);
      expect(tmux.sendKeys).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ ok: false, recovery: "attention_required", gate: "update_gate", gateChoice: true,
        screenBeforeInput: true, verifierInput: outcome === "sent" ? "update_skip_key_sent" : "update_skip_key_failed" });
    });

  it("(d) a current update menu without option 3 is an update screen without a recognised choice, and no key is sent", async () => {
    const menu = fs.readFileSync(nodePath.join(__dirname, "fixtures", "codex-update-0.160.0.txt"), "utf8").replace(/^.*3\. Skip until next version.*$/m, "");
    const tmux = screens(() => menu);
    const result = await new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {}, listProcesses: () => CODEX_ROW }).verifyResumeInPane("impl", "tok");
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, gate: "update_gate", gateChoice: false, verifierInput: "none" });
    expect(result).not.toHaveProperty("screenBeforeInput");
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
      appliedLaunch: CODEX_FLOOR_EFFECT,
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
        { pid: 901, ppid: 900, command: "node /opt/homebrew/bin/codex -s workspace-write -C /project" },
        { pid: 902, ppid: 901, command: "/opt/homebrew/lib/node_modules/@openai/codex/vendor/codex/codex -s workspace-write -C /project" },
      ],
      readThreadIdByPid: (pid) => pid === 902 ? "019d45bc-117d-78a3-a4ad-6fb186e5a86d" : undefined,
      sleep: async () => {},
    });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig" });

    expect(result).toEqual({
      ok: true,
      resumeToken: "019d45bc-117d-78a3-a4ad-6fb186e5a86d",
      resumeType: "codex_id",
      appliedLaunch: CODEX_FLOOR_EFFECT,
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
      appliedLaunch: CODEX_FLOOR_EFFECT,
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
      appliedLaunch: CODEX_FLOOR_EFFECT,
    });
  });

  it("launchHarness sends correct resume command", async () => {
    const proof = provenCodexResume("sess-456");
    const tmux = mockTmux({ getPanePid: proof.getPanePid });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), listProcesses: proof.listProcesses as never, readResumeEvidence: proof.readResumeEvidence });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith("r01-qa", expectedResumeCommand());
  });

  it("0.5.2-07 A2-3: launchHarness threads the SPEC model onto the codex RESUME command (pod-aware restore gap)", async () => {
    const proof = provenCodexResume("sess-456");
    const tmux = mockTmux({ getPanePid: proof.getPanePid });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), listProcesses: proof.listProcesses as never, readResumeEvidence: proof.readResumeEvidence });
    const binding = { ...makeBinding(), model: "gpt-5.4-cheap" };

    const result = await adapter.launchHarness(binding, { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith("r01-qa", expectedResumeCommand("sess-456", testQueueRoot(), "gpt-5.4-cheap"));
  });

  it("0.5.2-07 A2-3: launchHarness threads the SPEC model onto the codex FORK command (fork-instantiate gap)", async () => {
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [],
      sleep: async () => {},
    });
    const binding = { ...makeBinding(), model: "gpt-5.4-cheap" };

    // The command is built + sent BEFORE the post-fork thread-id capture; assert the sent command
    // even though thread capture is not mocked (fork ultimately returns not-captured).
    await adapter.launchHarness(binding, {
      name: "dev-qa@test-rig",
      forkSource: { kind: "native_id", value: "parent-thread-id" },
    });

    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith("r01-qa", expectedForkCommand("parent-thread-id", { model: "gpt-5.4-cheap" }));
  });

  it("#75: launchHarness passes the reasoning effort (-c model_reasoning_effort) on fresh launch", async () => {
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs() });
    const binding = { ...makeBinding(), effort: "high" };

    const result = await adapter.launchHarness(binding, { name: "dev-qa@test-rig" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith("r01-qa", expectedFreshLaunchCommand({ effort: "high" }));
  });

  it("#75: launchHarness threads reasoning effort onto the codex RESUME command", async () => {
    const proof = provenCodexResume("sess-456");
    const tmux = mockTmux({ getPanePid: proof.getPanePid });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), listProcesses: proof.listProcesses as never, readResumeEvidence: proof.readResumeEvidence });
    const binding = { ...makeBinding(), effort: "high" };

    const result = await adapter.launchHarness(binding, { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith("r01-qa", expectedResumeCommand("sess-456", testQueueRoot(), undefined, "high"));
  });

  it("#75: launchHarness threads reasoning effort onto the codex FORK command", async () => {
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [],
      sleep: async () => {},
    });
    const binding = { ...makeBinding(), effort: "high" };

    await adapter.launchHarness(binding, {
      name: "dev-qa@test-rig",
      forkSource: { kind: "native_id", value: "parent-thread-id" },
    });

    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith("r01-qa", expectedForkCommand("parent-thread-id", { effort: "high" }));
  });

  it("#75: launchHarness emits both model (-m) and effort (-c) when both declared", async () => {
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs() });
    const binding = { ...makeBinding(), model: "gpt-5.4-cheap", effort: "high" };

    const result = await adapter.launchHarness(binding, { name: "dev-qa@test-rig" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith("r01-qa", expectedFreshLaunchCommand({ model: "gpt-5.4-cheap", effort: "high" }));
  });

  it("launchHarness passes the requested Codex config profile on resume", async () => {
    const proof = provenCodexResume("sess-456");
    const tmux = mockTmux({ getPanePid: proof.getPanePid });
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: proof.listProcesses as never, readResumeEvidence: proof.readResumeEvidence,
      sleep: async () => {},
      // Housekeeping B1 fixback: controlled preflight (no real codex subprocess).
      verifyProfilePreflight: async (profile) => ({ ok: true, profile }),
    });
    const binding = { ...makeBinding(), codexConfigProfile: "fleet" };

    const result = await adapter.launchHarness(binding, { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith("r01-qa", expectedProfileResumeCommand("fleet"));
  });

  // Housekeeping B1 fixback (S-3) — adapter-boundary failure contract. When the
  // injected profile preflight fails, launchHarness must reject with the adapter's
  // composed error (probe error + "\n  Fix: " + migrationHint) BEFORE constructing
  // or sending any launch command — i.e. tmux.sendText is never called. The rich
  // real-probe failure vectors (legacy table, TOML, timeout, quoting) stay owned by
  // codex-profile-preflight.test.ts; this pins only the adapter's join + ordering.
  it("launchHarness rejects with the composed error and sends nothing when the profile preflight fails", async () => {
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [],
      sleep: async () => {},
      verifyProfilePreflight: async (profile) => ({
        ok: false,
        profile,
        error: `Codex profile '${profile}' failed to load: legacy [profiles.fleet] table present`,
        migrationHint: "Move the profile settings into ~/.codex/fleet.config.toml and remove the legacy [profiles.fleet] table.",
      }),
    });
    const binding = { ...makeBinding(), codexConfigProfile: "fleet" };

    const result = await adapter.launchHarness(binding, { name: "dev-qa@test-rig" });

    expect(result).toEqual({
      ok: false,
      error:
        "Codex profile 'fleet' failed to load: legacy [profiles.fleet] table present" +
        "\n  Fix: Move the profile settings into ~/.codex/fleet.config.toml and remove the legacy [profiles.fleet] table.",
    });
    // Rejection is BEFORE command construction — no launch text ever sent.
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).not.toHaveBeenCalled();
  });

  // Pre-rip 'provisions project-local Codex hooks and feature flag without
  // persisting the hook token' test removed in plugin-primitive Phase 3a
  // slice 3.1 — activity-hook auto-injection ripped (provisionActivityHooks
  // gone). Replacement coverage: codex-hooks-feature-flag.test.ts (slice 3.5
  // ensureCodexFeatureFlag) + activity-hook-rip-proof.test.ts (negative
  // assertions on adapter symbol absence + endpoint-stays).

  it("launchHarness skips the Codex update prompt with one control key during resume verification", async () => {
    const updatePrompt = [
      "✨ Update available! 0.120.0 -> 0.121.0",
      "› 1. Update now (runs `npm install -g @openai/codex`)",
      "  2. Skip",
      "  3. Skip until next version",
      "Press enter to continue",
    ].join("\n");
    const tmux = mockTmux({
      getPanePid: vi.fn(async () => 901),
      capturePaneScreen: vi.fn()
        .mockResolvedValueOnce(updatePrompt)
        .mockResolvedValueOnce(updatePrompt)
        .mockResolvedValue("OpenAI Codex (v0.120.0)\n› Ask Codex to do anything"),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {},
      listProcesses: () => [{ pid: 901, ppid: 1, pgid: 901, tpgid: 901, executableName: "codex", startedAt: "Sat Jan  1 12:00:00 2000", command: "codex resume sess-456" }],
      readResumeEvidence: () => ({ threadId: "sess-456" }),
    });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    // #1524 (b): the result also names the process the resume was proven on, for restore's join.
    expect(result).toEqual({ ok: true, resumeToken: "sess-456", resumeType: "codex_id", appliedLaunch: CODEX_FLOOR_EFFECT,
      resumedProcess: { pid: 901, startedAt: "Sat Jan  1 12:00:00 2000" } });
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText.mock.calls).toEqual([
      ["r01-qa", expectedResumeCommand()],
    ]);
    const sendKeys = tmux.sendKeys as ReturnType<typeof vi.fn>;
    expect(sendKeys.mock.calls).toEqual([
      ["r01-qa", ["Enter"]],
      ["r01-qa", ["3"]],
    ]);
  });

  // 0.5.2-07 A2-3 CONTRACT FLIP: this test previously asserted resume DROPPED the model
  // (`.not.toContain("-m")`) — a pure characterization of the 51-07-A1-era increment-reasoning bug
  // (fresh threaded -m, resume/fork did not), with no reason it should. That is the exact class this
  // slice kills. Corrected: resume now CARRIES -m (top-level flag, same class as the shipped -p), and
  // the queue --add-dir stays intact.
  it("launchHarness passes the SPEC model argument (-m) when resuming Codex", async () => {
    const proof = provenCodexResume("sess-456");
    const tmux = mockTmux({ getPanePid: proof.getPanePid });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), listProcesses: proof.listProcesses as never, readResumeEvidence: proof.readResumeEvidence });
    const binding = { ...makeBinding(), model: "gpt-5.5" };

    const result = await adapter.launchHarness(binding, { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith("r01-qa", expectedResumeCommand("sess-456", testQueueRoot(), "gpt-5.5"));
    expect(sendText.mock.calls[0]?.[1]).toContain(" -m 'gpt-5.5'");
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
      missingConversation: true,
    });
  });

  // Codex auth-refusal pod-aware path. verifyResumeLaunch must surface
  // probe.status === "attention_required" as recovery: "attention_required"
  // with the last-12-line evidence tail. Closes the guard-blocked gap in
  // commit 63ee206 alongside the legacy CodexResumeAdapter path.
  it("launchHarness returns attention_required when Codex post-logout token-refresh fails during resume", async () => {
    const refusalPane = [
      "$ codex -s workspace-write resume sess-456",
      "Error: Your access token could not be refreshed because you have since",
      "logged out or signed in to another account. Please sign in again.",
    ].join("\n");
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "zsh"),
      capturePaneContent: vi.fn(async () => refusalPane),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.recovery).toBe("attention_required");
      expect(result.error).toContain("sign in again");
      // Evidence is the last-12-line tail (mirrors claude-resume.ts:97).
      expect(result.evidence).toBeDefined();
      expect(result.evidence).toContain("access token could not be refreshed");
      expect(result.evidence).toContain("Please sign in again");
    }
  });

  it("launchHarness returns attention_required for `log out and sign in` Codex variant", async () => {
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "zsh"),
      capturePaneContent: vi.fn(async () => [
        "$ codex -s workspace-write resume sess-456",
        "Your access token could not be refreshed.",
        "Please log out and sign in again.",
      ].join("\n")),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.recovery).toBe("attention_required");
  });

  // OPR.0.3.3.21 FR-2 — honest restore gate. verifyResumeLaunch must NOT return
  // launch success when the probe only proves process-alive on an UNRESOLVED
  // gate. Before this slice these all returned { ok: true } (the 04.3
  // bootstrap_failed advisory). Each test below FAILS against that old behavior.

  // THE LOAD-BEARING DISCRIMINATOR (the 04.3 Codex update-flow scenario): an
  // update gate that cannot be auto-dismissed must classify as attention_required,
  // not launch success on process-alive alone.
  it("FR-2 DISCRIMINATOR: resume on an unresolved Codex update gate returns attention_required, not ok:true", async () => {
    const updateGate = [
      "✨ Update available! 0.120.0 -> 0.121.0",
      "Updating Codex...",
    ].join("\n"); // no 'Skip until next version' option -> not auto-dismissable
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "node"),
      capturePaneContent: vi.fn(async () => updateGate), // stays gated every poll
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result.ok).toBe(false); // fails against the pre-fix ok:true-on-gate behavior
    if (!result.ok) {
      expect(result.recovery).toBe("attention_required");
      expect(result.error).toContain("process-alive alone is not proof");
      expect(result.evidence).toContain("Update available");
    }
  });

  it("FR-2: resume on an unresolved Codex trust gate returns attention_required, not ok:true", async () => {
    const trustGate = [
      "Do you trust the contents of this directory?",
      "› 1. Yes, continue",
      "  2. No, exit",
    ].join("\n");
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "codex"),
      capturePaneContent: vi.fn(async () => trustGate),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.recovery).toBe("attention_required");
      expect(result.error.toLowerCase()).toContain("trust");
    }
  });

  it.each([
    ["panel alone", currentTrustPrompt],
    ["trailing heading fragment", `› Earlier conversation prompt\n  Context 81% left · GPT-6-Astra high\n${currentTrustPrompt}\n  Trust this folder?`],
    ["earlier default footer", `› Earlier conversation prompt\n  gpt-5.6-sol high · ~/work\n${currentTrustPrompt}`],
    ["earlier Codex header", `OpenAI Codex (v0.156.1)\n› Earlier conversation prompt\n${currentTrustPrompt}`],
  ])("classifies current folder trust consistently in readiness and resume without answering it: %s", async (_label, paneContent) => {
    let pollCount = 0;
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => { pollCount++; return "codex"; }),
      capturePaneContent: vi.fn(async () => paneContent),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });

    expect(await adapter.checkReady(makeBinding())).toMatchObject({ ready: false, code: "trust_gate" });
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    expect(tmux.sendText).not.toHaveBeenCalled();
    pollCount = 0;
    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.recovery).toBe("attention_required");
      expect(result.error).toContain("workspace trust approval");
    }
    expect(pollCount).toBeLessThanOrEqual(7);
    expect(tmux.sendKeys).toHaveBeenCalledTimes(1);
    expect(tmux.sendKeys).toHaveBeenCalledWith(makeBinding().tmuxSession, ["Enter"]);
  });

  it("accepts readiness and resume after a current-format panel is superseded by a headerless composer", async () => {
    const proof = provenCodexResume("sess-456");
    const tmux = mockTmux({
      getPanePid: proof.getPanePid,
      getPaneCommand: vi.fn(async () => "node"),
      capturePaneContent: vi.fn(async () => `${currentTrustPrompt}\n› Continue\n  5h 71% left · GPT-6-Astra high · Context 81% left`),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), listProcesses: proof.listProcesses as never, readResumeEvidence: proof.readResumeEvidence, sleep: async () => {} });

    expect(await adapter.checkReady(makeBinding())).toEqual({ ready: true });
    expect(await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig", resumeToken: "sess-456" }))
      .toMatchObject({ ok: true, resumeToken: "sess-456" });
  });

  it("FR-2: resume on an unresolved Codex model-selection gate returns attention_required, not ok:true", async () => {
    const modelGate = [
      "Select a model to continue:",
      "› 1. gpt-5.1-codex",
      "  2. gpt-5.1-codex-mini",
    ].join("\n");
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "codex"),
      capturePaneContent: vi.fn(async () => modelGate),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.recovery).toBe("attention_required");
      expect(result.error.toLowerCase()).toContain("model selection");
    }
  });

  it("FR-2: resume that never proves `resumed` within the bounded poll returns attention_required, not ok:true", async () => {
    // Process alive but not yet the foreground runtime, no explicit gate -> the
    // probe stays `inconclusive`; the old fallthrough laundered this to ok:true.
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "node"),
      capturePaneContent: vi.fn(async () => "spawning codex worker..."),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.recovery).toBe("attention_required");
      expect(result.evidence).toBeDefined();
    }
  });

  // OPR.0.3.4.13 — slow-but-valid Codex resume: boot-in-progress for several
  // ticks then the pane becomes a ready Codex TUI → must classify `resumed`
  // with resume metadata, not `attention_required`.
  it("OPR.0.3.4.13: slow Codex resume boot-in-progress then ready TUI classifies resumed with metadata", async () => {
    let callCount = 0;
    const proof = provenCodexResume("019ecd3b-test-thread");
    const tmux = mockTmux({
      getPanePid: proof.getPanePid,
      getPaneCommand: vi.fn(async () => {
        callCount++;
        return callCount <= 10 ? "node" : "codex";
      }),
      capturePaneContent: vi.fn(async () => {
        if (callCount <= 10) return "codex -s workspace-write resume 019ecd3b-test-thread\nCodex v0.128.0\nloading...";
        return "OpenAI Codex (v0.128.0)\n  gpt-5.5 · session 019ecd3b-test-thread\n› ";
      }),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), listProcesses: proof.listProcesses as never, readResumeEvidence: proof.readResumeEvidence, sleep: async () => {} });

    const result = await adapter.launchHarness(makeBinding(), {
      name: "dev-worker@test-rig",
      resumeToken: "019ecd3b-test-thread",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resumeToken).toBe("019ecd3b-test-thread");
      expect(result.resumeType).toBe("codex_id");
    }
  });

  // OPR.0.3.4.13: genuine gates still classify fast — trust gate does NOT
  // get the extended boot-in-progress window.
  it("OPR.0.3.4.13: trust gate still classifies attention_required without extended delay", async () => {
    let pollCount = 0;
    const trustGate = "Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, exit";
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => { pollCount++; return "codex"; }),
      capturePaneContent: vi.fn(async () => trustGate),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.recovery).toBe("attention_required");
    }
    // Trust gate should NOT enter the extended phase (30 attempts).
    // Quick phase = 6 attempts; trust gate breaks out after quick phase.
    expect(pollCount).toBeLessThanOrEqual(7);
  });

  // Guard against breaking the working auto-dismiss: a skippable update gate
  // still auto-dismisses and continues to success (covered end-to-end by
  // "launchHarness skips the Codex update prompt with one control key during resume
  // verification" above) — only UNRESOLVED gates fail loudly.

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

  it("GAP-7 routes workspace trust and runtime config fragments through the injected Codex home", async () => {
    const fs = mockFs({
      "/agents/base/runtime/codex-config.toml": "[mcp_servers.test]\nurl = \"https://example.test\"\n",
    });
    const fsWithHome = { ...fs, homedir: "/daemon-home" };
    const adapter = new CodexRuntimeAdapter({
      tmux: mockTmux(),
      fsOps: fsWithHome,
      codexHome: "/daemon-codex",
    });
    const plan: ProjectionPlan = {
      runtime: "codex", cwd: "/tmp/workspace",
      entries: [makeEntry({
        category: "runtime_resource",
        effectiveId: "codex-test-config",
        resourceType: "codex_config_fragment",
        absolutePath: "/agents/base/runtime/codex-config.toml",
        resourcePath: "runtime/codex-config.toml",
      })],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };

    await adapter.deliverStartup([], makeBinding("/tmp/workspace"));
    await adapter.project(plan, makeBinding("/tmp/workspace"));

    const store = (fsWithHome as unknown as { _store: Record<string, string> })._store;
    expect(store["/daemon-codex/config.toml"]).toContain('[projects."/tmp/workspace"]');
    expect(store["/daemon-codex/config.toml"]).toContain("[mcp_servers.test]");
    expect(store["/daemon-home/.codex/config.toml"]).toBeUndefined();
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

  // --- OPR.0.5.8.12: user-owned Codex tables survive projection ---
  //
  // Before this repair the fragment was spliced in raw, so a user who already
  // owned [mcp_servers.exa] got a duplicate table and Codex refused to start:
  //   "failed to load bootstrap configuration ... duplicate key"
  // (reproduced against codex-cli 0.147.0). Every assertion below ends at the
  // real outcome — the rendered config PARSES — not at a string shape.

  const SHIPPED_FRAGMENT = [
    "[mcp_servers.exa]",
    'url = "https://mcp.exa.ai/mcp"',
    "",
    "[mcp_servers.context7]",
    'url = "https://mcp.context7.com/mcp"',
    "",
  ].join("\n");

  async function projectFragment(userConfig: string, fragment = SHIPPED_FRAGMENT) {
    const fs = mockFs({
      "/agents/base/runtime/codex-config.toml": fragment,
      "/home/tester/.codex/config.toml": userConfig,
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
    const store = (fsWithHome as unknown as { _store: Record<string, string> })._store;
    const project = () => adapter.project(plan, makeBinding("/tmp/workspace"));
    return { project, read: () => store["/home/tester/.codex/config.toml"]! };
  }

  it("keeps a user-owned MCP table and its values when the fragment names the same table", async () => {
    const { project, read } = await projectFragment([
      '[projects."/tmp/workspace"]',
      'trust_level = "trusted"',
      "",
      "[mcp_servers.exa]",
      'url = "https://exa.internal.example/mcp"',
      'api_key = "USER-OWNED"',
      "",
    ].join("\n"));

    expect(await project()).toEqual({ projected: ["codex-default-config"], skipped: [], failed: [] });

    const parsed = parseToml(read()) as Record<string, any>;
    expect(parsed.mcp_servers.exa.url).toBe("https://exa.internal.example/mcp");
    expect(parsed.mcp_servers.exa.api_key).toBe("USER-OWNED");
    // the non-colliding half of the fragment still lands
    expect(parsed.mcp_servers.context7.url).toBe("https://mcp.context7.com/mcp");
    expect(parsed.projects["/tmp/workspace"].trust_level).toBe("trusted");
  });

  it("keeps MULTIPLE user-owned MCP tables when the fragment names all of them", async () => {
    const { project, read } = await projectFragment([
      "[mcp_servers.exa]",
      'url = "https://exa.internal.example/mcp"',
      "",
      "[mcp_servers.context7]",
      'url = "https://c7.internal.example/mcp"',
      "",
    ].join("\n"));

    expect(await project()).toEqual({ projected: ["codex-default-config"], skipped: [], failed: [] });

    const parsed = parseToml(read()) as Record<string, any>;
    expect(parsed.mcp_servers.exa.url).toBe("https://exa.internal.example/mcp");
    expect(parsed.mcp_servers.context7.url).toBe("https://c7.internal.example/mcp");
  });

  it("still lands the whole fragment when the user owns a DIFFERENT table under the same parent", async () => {
    // [mcp_servers.other] and [mcp_servers.exa] share an implied parent and are
    // legal together — a parent-level collision check would wrongly drop both.
    const { project, read } = await projectFragment([
      "[mcp_servers.other]",
      'url = "https://other.example/mcp"',
      "",
    ].join("\n"));

    await project();
    const parsed = parseToml(read()) as Record<string, any>;
    expect(parsed.mcp_servers.other.url).toBe("https://other.example/mcp");
    expect(parsed.mcp_servers.exa.url).toBe("https://mcp.exa.ai/mcp");
    expect(parsed.mcp_servers.context7.url).toBe("https://mcp.context7.com/mcp");
  });

  it("re-projects idempotently over a collision without duplicating the managed block", async () => {
    const { project, read } = await projectFragment([
      "[mcp_servers.exa]",
      'url = "https://exa.internal.example/mcp"',
      "",
    ].join("\n"));

    expect(await project()).toEqual({ projected: ["codex-default-config"], skipped: [], failed: [] });
    const afterFirst = read();
    expect(await project()).toEqual({ projected: ["codex-default-config"], skipped: [], failed: [] });
    const afterSecond = read();

    expect(afterSecond).toBe(afterFirst);
    expect(() => parseToml(afterSecond)).not.toThrow();
    expect(afterSecond.match(/BEGIN OPENRIG MANAGED CODEX CONFIG FRAGMENT: codex-default-config/g)!.length).toBe(1);
    expect((parseToml(afterSecond) as Record<string, any>).mcp_servers.exa.url)
      .toBe("https://exa.internal.example/mcp");
  });

  it("keeps $ sequences in a fragment literal when it is re-projected", async () => {
    const userConfig = '[projects."/tmp/workspace"]\ntrust_level = "trusted"\n';
    const fragment = '[mcp_servers.dollar]\ncommand = "echo $$ $& $` $\'"\n';
    const { project, read } = await projectFragment(userConfig, fragment);

    expect(await project()).toEqual({ projected: ["codex-default-config"], skipped: [], failed: [] });
    const afterFirst = read();
    expect(await project()).toEqual({ projected: ["codex-default-config"], skipped: [], failed: [] });
    const afterSecond = read();

    expect(afterSecond).toBe(afterFirst);
    expect(afterSecond.startsWith(userConfig)).toBe(true);
    expect(afterSecond.match(/BEGIN OPENRIG MANAGED CODEX CONFIG FRAGMENT: codex-default-config/g)!.length).toBe(1);
    expect((parseToml(afterSecond) as Record<string, any>).mcp_servers.dollar.command).toBe("echo $$ $& $` $'");
  });

  it("does not mistake a header after an ESCAPED delimiter inside a multi-line string (r2 NOT-CLEAR, 09-01)", async () => {
    // review50-r2 blocking finding on candidate 4d2ad86c. `\"""` is an escaped
    // quote plus two more, NOT the end of the string, so [mcp_servers.exa] here
    // is string data and the managed exa must still land. The old user-side
    // header scanner read the escape as a terminator and dropped it silently
    // WHILE REPORTING SUCCESS — which the final parse guard cannot catch,
    // because the wrong answer is still valid TOML.
    const userConfig = [
      "[profiles.notes]",
      'text = """',
      '\\"""',
      "[mcp_servers.exa]",
      "this is still string data",
      '"""',
      "",
    ].join("\n");
    const { project, read } = await projectFragment(userConfig);

    // fact 1 — the user genuinely declares no exa table
    expect((parseToml(userConfig) as Record<string, any>).mcp_servers).toBeUndefined();
    // fact 2 — projection succeeds
    expect(await project()).toEqual({ projected: ["codex-default-config"], skipped: [], failed: [] });
    const after = parseToml(read()) as Record<string, any>;
    // fact 3 — BOTH managed tables land
    expect(after.mcp_servers.exa.url).toBe("https://mcp.exa.ai/mcp");
    expect(after.mcp_servers.context7.url).toBe("https://mcp.context7.com/mcp");
    // fact 4 — the user's string is untouched
    expect(after.profiles.notes.text).toBe((parseToml(userConfig) as Record<string, any>).profiles.notes.text);
  });

  it("projects a fragment containing a multi-line nested array (r2 NOT-CLEAR #3, 09-01)", async () => {
    // review50-r2 blocking finding on candidate a760ec27. `  [1, 2],` is a row
    // of a multi-line array, not a table header — but the splitter classified
    // any bracket-leading line as a header, tore the array apart, and the render
    // guard then refused a perfectly valid fragment. Depth, not the line's own
    // text, separates them.
    //
    // AMENDED BY OPR.0.5.8.15, NOT WEAKENED. R2's original repro put the array
    // at root, a shape .15 now refuses outright for an unrelated reason (no
    // root-reopen in TOML). Rewriting the assertion to expect a refusal would
    // have made this pin green while retiring the thing R2 actually cleared, so
    // the array is moved inside a table — the only legal shape — and the depth
    // claim is asserted unchanged. The refusal of the root-level form is pinned
    // separately below.
    const original = 'model = "gpt-5"\n';
    const fragment = ["[managed.data]", "matrix = [", "  [1, 2],", "  [3, 4],", "]", ""].join("\n");
    const { project, read } = await projectFragment(original, fragment);

    const result = await project();
    expect(result).toEqual({ projected: ["codex-default-config"], skipped: [], failed: [] });
    const after = parseToml(read()) as Record<string, any>;
    expect(after.model).toBe("gpt-5");                          // user value preserved
    expect(after.managed.data.matrix).toEqual([[1, 2], [3, 4]]); // array intact, not torn
  });

  it("still finds real headers that follow a multi-line array", async () => {
    // The depth fix must not overshoot: once the array closes we are back at
    // document level, so BOTH following headers are headers again — the
    // colliding one yields to the user, the other lands.
    const original = '[mcp_servers.exa]\nurl = "https://user.example/mcp"\n';
    const fragment = [
      "[managed.data]",
      "matrix = [", "  [1, 2],", "]",
      "[mcp_servers.exa]", 'url = "https://mcp.exa.ai/mcp"',
      "[mcp_servers.context7]", 'url = "https://mcp.context7.com/mcp"', "",
    ].join("\n");
    const { project, read } = await projectFragment(original, fragment);

    expect(await project()).toEqual({ projected: ["codex-default-config"], skipped: [], failed: [] });
    const after = parseToml(read()) as Record<string, any>;
    expect(after.mcp_servers.exa.url).toBe("https://user.example/mcp");   // user wins
    expect(after.mcp_servers.context7.url).toBe("https://mcp.context7.com/mcp");
    expect(after.managed.data.matrix).toEqual([[1, 2]]);                  // array intact
  });

  // --- OPR.0.5.8.15: a fragment's root-level keys refuse instead of binding
  // silently into a user-owned table.
  //
  // Superseded the OPR.0.5.8.12 pin that DOCUMENTED this as inherited behaviour
  // (`matrix` landing as `mcp_servers.other.matrix`). That pin was correct about
  // the mechanism and is now obsolete as a contract: the shape is refused.

  it("refuses a fragment whose keys precede its first table header (OPR.0.5.8.15)", async () => {
    // The spec repro: user's document ends inside [mcp_servers.other], so an
    // appended root key could only ever bind into THEIR table. TOML has no
    // root-reopen syntax, so preserving the author's intent here is impossible,
    // not merely expensive — the honest answer is to refuse and say why.
    const original = '[mcp_servers.other]\nurl = "https://user.example/mcp"\n';
    const { project, read } = await projectFragment(original, "matrix = [[1, 2]]\n");

    const result = await project();
    expect(result.projected).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.error).toMatch(/root-level keys before its first table header/);
    expect(result.failed[0]!.error).toMatch(/open a table first/);   // names the author's fix
    expect(read()).toBe(original);                                   // byte-unchanged
  });

  it("refuses the same shape DETERMINISTICALLY even when the user's file ends at root", async () => {
    // Here the key would in fact have bound at root, so a state-dependent rule
    // would allow it. It is still refused: a fragment author cannot see user
    // state, and a contract that passes or fails on someone else's file is one
    // the author can never reproduce.
    const original = 'model = "gpt-5"\n';
    const { project, read } = await projectFragment(original, "matrix = [[1, 2]]\n");

    const result = await project();
    expect(result.projected).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(read()).toBe(original);
  });

  it("allows comments and blank lines ahead of the first table header", async () => {
    // Refusing on a leading comment would make the rule feel arbitrary and
    // would reject perfectly ordinary authored fragments.
    const original = 'model = "gpt-5"\n';
    const fragment = ["# managed by openrig", "", "[mcp_servers.context7]", 'url = "https://mcp.context7.com/mcp"', ""].join("\n");
    const { project, read } = await projectFragment(original, fragment);

    expect(await project()).toEqual({ projected: ["codex-default-config"], skipped: [], failed: [] });
    expect((parseToml(read()) as Record<string, any>).mcp_servers.context7.url).toBe("https://mcp.context7.com/mcp");
  });

  it("leaves the shipped codex-default-config fragment unaffected (OPR.0.5.8.15 regression)", async () => {
    // The shipped fragment opens with a table header, so the new refusal must
    // not touch it — including its OPR.0.5.8.12 collision behaviour.
    const original = [
      '[projects."/tmp/workspace"]', 'trust_level = "trusted"', "",
      "[mcp_servers.exa]", 'url = "https://exa.internal.example/mcp"', 'api_key = "USER-SECRET"', "",
    ].join("\n");
    const { project, read } = await projectFragment(original);

    expect(await project()).toEqual({ projected: ["codex-default-config"], skipped: [], failed: [] });
    const after = parseToml(read()) as Record<string, any>;
    expect(after.mcp_servers.exa.url).toBe("https://exa.internal.example/mcp");
    expect(after.mcp_servers.exa.api_key).toBe("USER-SECRET");
    expect(after.mcp_servers.context7.url).toBe("https://mcp.context7.com/mcp");
  });

  it("refuses an intrinsically invalid managed fragment instead of deleting it (r2 NOT-CLEAR, 09-01)", async () => {
    // review50-r2 blocking finding on candidate ebfe60d9. "appending this block
    // breaks the parse" has TWO causes — a user collision, or a malformed block.
    // Conflating them let the collision filter DELETE an invalid authored
    // fragment, after which the render guard passed precisely because the bad
    // input was gone, and the receipt said projected.
    const original = 'model = "gpt-5"\n';
    const { project, read } = await projectFragment(original, "[mcp_servers.exa]\nurl =\n");

    const result = await project();
    expect(result.projected).toEqual([]);            // zero projected
    expect(result.failed).toHaveLength(1);           // one failed projection
    expect(result.failed[0]!.error).toMatch(/not valid TOML on its own/);
    expect(read()).toBe(original);                   // user file byte-unchanged
  });

  it("refuses a fragment whose own tables collide with each other", async () => {
    // Closed by the same standalone check: the per-block collision test compares
    // each block against the USER only, so it could never have caught this.
    const original = 'model = "gpt-5"\n';
    const dup = "[mcp_servers.exa]\nurl = \"a\"\n\n[mcp_servers.exa]\nurl = \"b\"\n";
    const { project, read } = await projectFragment(original, dup);

    const result = await project();
    expect(result.projected).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(read()).toBe(original);
  });

  it("leaves the fragment intact when the user's config does not parse, and refuses the write", async () => {
    // No collision can be discriminated against a file we cannot read, so
    // nothing is dropped and the render guard refuses rather than "fixing" it.
    const broken = "[mcp_servers.exa\nurl = \n";
    const { project, read } = await projectFragment(broken);
    const result = await project();
    expect(result.projected).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(read()).toBe(broken);
  });

  it("does not mistake a table header inside a multi-line string for a user-owned table", async () => {
    const { project, read } = await projectFragment([
      "[profiles.notes]",
      'text = """',
      "[mcp_servers.exa]",
      'not a table, just prose"""',
      "",
    ].join("\n"));

    await project();
    // exa was never really declared by the user, so the managed table must land
    expect((parseToml(read()) as Record<string, any>).mcp_servers.exa.url).toBe("https://mcp.exa.ai/mcp");
  });

  it("refuses a duplicate root-level key rather than writing it, file untouched", async () => {
    // Was: a duplicate top-level KEY is not a table collision, so table-dropping
    // cannot save it and the RENDER guard must reject it.
    //
    // AMENDED BY OPR.0.5.8.15. That case is now caught one layer earlier by the
    // root-scope refusal, so the render guard is no longer what stops it. The
    // user-visible contract is unchanged and still pinned here — nothing is
    // written and the file is byte-identical — but the assertion no longer
    // claims WHICH guard fired, because that claim is now false.
    //
    // CORRECTION (orch-lead, 09-01): I reported here that
    // `assertRendersAsLoadableToml` had become unreachable. That was WRONG, and
    // the counterexample was already in this file — the invalid-user-config test
    // below reaches it (userParses=false, so no block is dropped, and the
    // rendered document is still invalid). Verified: that path fails with
    // "would write a config Codex cannot parse". The guard is live; I searched
    // my own imagination and reported the result as a property of the code.
    const original = 'model = "user-choice"\n';
    const { project, read } = await projectFragment(original, 'model = "managed-choice"\n');

    const result = await project();
    expect(result.projected).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.error).toMatch(/left unchanged/);
    expect(read()).toBe(original);
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
    expect(store["/project/AGENTS.md"]).toContain("BEGIN OpenRig MANAGED BLOCK: using-openrig.md");
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

  // File-shaped subagent under PRODUCTION listFiles semantics: the in-memory
  // mockFs returns [] for a file path, but production wires listFiles to a
  // recursive fs.readdirSync walk (startup.ts), which throws ENOTDIR on a file —
  // an unguarded probe lands the entry in ProjectionResult.failed and it is never
  // projected. This drives project() through a real-fs-backed listFiles.
  it("projects file-shaped subagent when listFiles throws ENOTDIR (production readdirSync semantics)", async () => {
    const tempRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-codex-projection-"));
    const srcFile = nodePath.join(tempRoot, "agents", "base", "subagents", "reviewer.yaml");
    fs.mkdirSync(nodePath.dirname(srcFile), { recursive: true });
    fs.writeFileSync(srcFile, "name: reviewer");
    const cwd = nodePath.join(tempRoot, "project");
    fs.mkdirSync(cwd, { recursive: true });

    const adapter = new CodexRuntimeAdapter({
      tmux: mockTmux(),
      fsOps: {
        readFile: (p: string) => fs.readFileSync(p, "utf-8"),
        writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
        exists: (p: string) => fs.existsSync(p),
        mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
        listFiles: (dir: string) => fs.readdirSync(dir),
      },
    });
    const plan: ProjectionPlan = {
      runtime: "codex", cwd,
      entries: [makeEntry({ category: "subagent", effectiveId: "reviewer", absolutePath: srcFile, resourcePath: "subagents/reviewer.yaml" })],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };

    const result = await adapter.project(plan, makeBinding(cwd));

    expect(result.failed).toEqual([]);
    expect(result.projected).toEqual(["reviewer"]);
    expect(fs.readFileSync(nodePath.join(cwd, ".agents", "reviewer.yaml"), "utf-8")).toBe("name: reviewer");
  });
});


describe("rebuild permission continuity", () => {
  it.each(["read-only", "danger-full-access"] as const)("emits the observed %s policy over a named read-only profile", async type => {
    const tmux = mockTmux();
    const codexHome = "/private/codex";
    const adapter = new CodexRuntimeAdapter({ tmux, codexHome,
      fsOps: mockFs({ [`${codexHome}/locked.config.toml`]: 'sandbox_mode = "read-only"\n' }),
      verifyProfilePreflight: async profile => ({ ok: true, profile }), sleep: async () => {} });
    const result = await adapter.launchHarness({ ...makeBinding(), codexConfigProfile: "locked", codexRebuildPermissions: {
      approvalPolicy: "never", sandboxPolicy: { type } } }, { name: "dev-review@test-rig" });
    expect(result).toMatchObject({ ok: true, appliedLaunch: { state: "observed", value: type, approvalPolicy: "never" } });
    expect(vi.mocked(tmux.sendText).mock.calls[0]![1]).toContain(` -p 'locked' -s ${type} -a never`);
    expect(vi.mocked(tmux.sendText).mock.calls[0]![1]).not.toContain("--add-dir");
  });

  it("emits the predecessor policy without adding fresh network/git/team/queue grants", async () => {
    const tmux = mockTmux();
    const readNetworkDefault = vi.fn(async () => ({ apply: true, elapsedMs: 0 }));
    const resolveGitAddDirs = vi.fn(async () => ["/repo/.git"]);
    const prepareTeamWorkspace = vi.fn(() => ["/workspace", "/shared-docs"]);
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {},
      readNetworkDefault, resolveGitAddDirs, prepareTeamWorkspace });
    const envelope = { approvalPolicy: "on-request", sandboxPolicy: { type: "workspace-write",
      network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: false,
      writable_roots: ["/kept dir", "/kept'quote"] } } satisfies CodexPermissionEnvelope;
    const binding = { ...makeBinding("/repo/review"), teamPermissionDefault: true,
      codexRebuildPermissions: envelope };
    expect((await adapter.launchHarness(binding, { name: "dev-review@test-rig" })).ok).toBe(true);
    const command = vi.mocked(tmux.sendText).mock.calls[0]![1];
    expect(command).toContain(" -s workspace-write -a on-request");
    expect(command).toContain("sandbox_workspace_write.network_access=false");
    expect(command).toContain("sandbox_workspace_write.exclude_tmpdir_env_var=true");
    expect(command).toContain("sandbox_workspace_write.exclude_slash_tmp=false");
    expect(command).toContain("sandbox_workspace_write.writable_roots=");
    expect(command).not.toContain("--add-dir");
    expect(readNetworkDefault).not.toHaveBeenCalled();
    expect(resolveGitAddDirs).not.toHaveBeenCalled();
    expect(prepareTeamWorkspace).not.toHaveBeenCalled();
  });
});
