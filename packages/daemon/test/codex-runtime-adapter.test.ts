import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import Database from "better-sqlite3";
import { describe, it, expect, vi } from "vitest";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import type { NodeBinding, ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
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

function createCodexLogsDb(homeDir: string, pid: number, threadId: string): void {
  const codexDir = nodePath.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const db = new Database(nodePath.join(codexDir, "logs_1.sqlite"));
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
    expect(sendText).toHaveBeenCalledWith("r01-qa", "codex -C '/project' -a never -s workspace-write");
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

  it("launchHarness sends correct resume command", async () => {
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs() });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith("r01-qa", "codex resume sess-456");
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
});
