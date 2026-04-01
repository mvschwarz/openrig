import { describe, it, expect, vi } from "vitest";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import type { NodeBinding, ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../src/domain/projection-planner.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

function mockTmux(): TmuxAdapter {
  return {
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
  } as unknown as TmuxAdapter;
}

function mockFs(files?: Record<string, string>): ClaudeAdapterFsOps {
  const store: Record<string, string> = { ...files };
  return {
    readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`Not found: ${p}`); },
    writeFile: (p: string, c: string) => { store[p] = c; },
    exists: (p: string) => p in store,
    mkdirp: () => {},
    copyFile: () => {},
    listFiles: (dir: string) => Object.keys(store).filter((k) => k.startsWith(dir + "/")).map((k) => k.slice(dir.length + 1)),
    _store: store,
  } as ClaudeAdapterFsOps & { _store: Record<string, string> };
}

function makeBinding(cwd = "/project"): NodeBinding {
  return {
    id: "b1", nodeId: "n1", tmuxSession: "r01-impl", tmuxWindow: null, tmuxPane: null,
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

describe("Claude Code runtime adapter", () => {
  // T1: implements all four methods
  it("implements all four methods", () => {
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: mockFs() });
    expect(typeof adapter.listInstalled).toBe("function");
    expect(typeof adapter.project).toBe("function");
    expect(typeof adapter.deliverStartup).toBe("function");
    expect(typeof adapter.checkReady).toBe("function");
    expect(adapter.runtime).toBe("claude-code");
  });

  // T3: auto guidance merge for .md file
  it("auto chooses guidance_merge for .md startup file", async () => {
    const fs = mockFs({ "/rig/startup/guide.md": "# Guide content" });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const file: ResolvedStartupFile = {
      path: "startup/guide.md", absolutePath: "/rig/startup/guide.md", ownerRoot: "/rig",
      deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"],
    };
    const result = await adapter.deliverStartup([file], makeBinding());
    expect(result.delivered).toBe(1);
    const store = (fs as unknown as { _store: Record<string, string> })._store;
    expect(store["/project/CLAUDE.md"]).toContain("Guide content");
  });

  // T4: auto skill install for SKILL.md
  it("auto chooses skill_install for SKILL.md content", async () => {
    const fs = mockFs({ "/rig/skills/deep/SKILL.md": "# SKILL Deep PR Review" });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const file: ResolvedStartupFile = {
      path: "skills/deep/SKILL.md", absolutePath: "/rig/skills/deep/SKILL.md", ownerRoot: "/rig",
      deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"],
    };
    const result = await adapter.deliverStartup([file], makeBinding());
    expect(result.delivered).toBe(1);
  });

  // T5: auto send-text for generic content
  it("auto falls back to send_text for generic file", async () => {
    const tmux = mockTmux();
    const fs = mockFs({ "/rig/startup/init.sh": "echo hello" });
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: fs });
    const file: ResolvedStartupFile = {
      path: "startup/init.sh", absolutePath: "/rig/startup/init.sh", ownerRoot: "/rig",
      deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"],
    };
    await adapter.deliverStartup([file], makeBinding());
    expect(tmux.sendText).toHaveBeenCalledWith("r01-impl", "echo hello");
  });

  // T6: duplicate delivery is idempotent
  it("duplicate projection is idempotent via hash check", async () => {
    const fs = mockFs({
      "/agents/base/skills/test/SKILL.md": "skill content",
      "/project/.claude/skills/test-skill/SKILL.md": "skill content", // same content
    });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan: ProjectionPlan = {
      runtime: "claude-code", cwd: "/project",
      entries: [makeEntry({ absolutePath: "/agents/base/skills/test/SKILL.md" })],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };
    const result = await adapter.project(plan, makeBinding());
    // Same hash — should be projected (copy is idempotent but still counted)
    expect(result.failed).toHaveLength(0);
  });

  // T9: projection handles directory-shaped skill resources
  it("projects skill directory to .claude/skills/{id}/", async () => {
    const fs = mockFs({
      "/agents/base/skills/test/SKILL.md": "skill content",
      "/agents/base/skills/test/helper.ts": "export default {}",
    });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan: ProjectionPlan = {
      runtime: "claude-code", cwd: "/project",
      entries: [makeEntry({ absolutePath: "/agents/base/skills/test" })],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };
    await adapter.project(plan, makeBinding());
    const store = (fs as unknown as { _store: Record<string, string> })._store;
    expect(store["/project/.claude/skills/test-skill/SKILL.md"]).toBe("skill content");
    expect(store["/project/.claude/skills/test-skill/helper.ts"]).toBe("export default {}");
  });

  // T9b: file-shaped subagent projects correctly
  it("projects file-shaped subagent to .claude/agents/", async () => {
    const fs = mockFs({ "/agents/base/subagents/reviewer.yaml": "name: reviewer" });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan: ProjectionPlan = {
      runtime: "claude-code", cwd: "/project",
      entries: [makeEntry({ category: "subagent", effectiveId: "reviewer", absolutePath: "/agents/base/subagents/reviewer.yaml", resourcePath: "subagents/reviewer.yaml" })],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };
    await adapter.project(plan, makeBinding());
    const store = (fs as unknown as { _store: Record<string, string> })._store;
    expect(store["/project/.claude/agents/reviewer.yaml"]).toBe("name: reviewer");
  });

  // NS-T04: launchHarness tests
  it("launchHarness sends correct fresh launch command", async () => {
    const tmux = mockTmux();
    const adapter = new ClaudeCodeAdapter({
      tmux,
      fsOps: mockFs(),
      sessionIdFactory: () => "11111111-1111-4111-8111-111111111111",
    });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-impl@test-rig" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith(
      "r01-impl",
      "claude --session-id 11111111-1111-4111-8111-111111111111 --name dev-impl@test-rig"
    );
    if (result.ok) {
      expect(result.resumeToken).toBe("11111111-1111-4111-8111-111111111111");
      expect(result.resumeType).toBe("claude_id");
    }
  });

  it("launchHarness sends correct resume command with token", async () => {
    const tmux = mockTmux();
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: mockFs() });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-impl@test-rig", resumeToken: "abc-123" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith("r01-impl", "claude --resume abc-123 --name dev-impl@test-rig");
  });

  it("launchHarness captures resume token from session file", async () => {
    const tmux = mockTmux();
    const sessionData = JSON.stringify({ pid: 12345, sessionId: "abc-session-id", name: "dev-impl@test-rig" });
    const fs = mockFs({});
    // Add readdir + homedir capabilities
    const fsWithDir = {
      ...fs,
      readdir: (dir: string) => dir.includes("sessions") ? ["12345.json"] : [],
      homedir: "/mock-home",
      readFile: (p: string) => {
        if (p.includes("12345.json")) return sessionData;
        return fs.readFile(p);
      },
      exists: (p: string) => p.includes("sessions") || fs.exists(p),
    };
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: fsWithDir });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-impl@test-rig" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resumeToken).toBe("abc-session-id");
      expect(result.resumeType).toBe("claude_id");
    }
  });

  it("launchHarness returns error when no tmux session bound", async () => {
    const tmux = mockTmux();
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: mockFs() });
    const binding = { ...makeBinding(), tmuxSession: null };

    const result = await adapter.launchHarness(binding, { name: "test" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No tmux session");
  });
});
