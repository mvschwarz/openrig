import { describe, it, expect, vi } from "vitest";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import type { NodeBinding, ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../src/domain/projection-planner.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

function mockTmux(): TmuxAdapter {
  return {
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "claude"),
    capturePaneContent: vi.fn(async () => ""),
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

  it("checkReady returns false when the pane has fallen back to a shell prompt", async () => {
    const tmux = mockTmux();
    (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("zsh");
    (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue("mschwarz@host rigged %");
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: mockFs() });

    const result = await adapter.checkReady(makeBinding());

    expect(result).toEqual({
      ready: false,
      reason: "The probe pane returned to a shell instead of staying inside the runtime.",
      code: "returned_to_shell",
    });
  });

  it("checkReady returns false when Claude is blocked on the workspace trust prompt", async () => {
    const tmux = mockTmux();
    (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("claude");
    (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue(
      [
        "Accessing workspace:",
        "/some/workspace",
        "",
        "Quick safety check: Is this a project you created or one you trust?",
        "1. Yes, I trust this folder",
        "2. No, exit",
      ].join("\n")
    );
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: mockFs() });

    const result = await adapter.checkReady(makeBinding());

    expect(result).toEqual({
      ready: false,
      reason: "Claude is waiting for workspace trust approval before the session can become interactive.",
      code: "trust_gate",
    });
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

  it("replaces legacy using-openrig managed block when delivering openrig-start guidance", async () => {
    const fs = mockFs({
      "/rig/openrig-start.md": "# OpenRig Start\n\nNew guidance",
      "/project/CLAUDE.md": [
        "<!-- BEGIN RIGGED MANAGED BLOCK: using-openrig.md -->",
        "# Using OpenRig",
        "Old guidance",
        "<!-- END RIGGED MANAGED BLOCK: using-openrig.md -->",
      ].join("\n"),
    });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
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
    const content = store["/project/CLAUDE.md"]!;
    expect(content).toContain("BEGIN RIGGED MANAGED BLOCK: openrig-start.md");
    expect(content).not.toContain("BEGIN RIGGED MANAGED BLOCK: using-openrig.md");
    expect(content).toContain("New guidance");
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
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: fs, sleep: async () => {} });
    const file: ResolvedStartupFile = {
      path: "startup/init.sh", absolutePath: "/rig/startup/init.sh", ownerRoot: "/rig",
      deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"],
    };
    await adapter.deliverStartup([file], makeBinding());
    expect(tmux.sendText).toHaveBeenCalledWith("r01-impl", "echo hello");
    expect(tmux.sendKeys).toHaveBeenCalledWith("r01-impl", ["C-m"]);
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
      "claude --permission-mode acceptEdits --session-id 11111111-1111-4111-8111-111111111111 --name dev-impl@test-rig"
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
    expect(sendText).toHaveBeenCalledWith(
      "r01-impl",
      "claude --permission-mode acceptEdits --resume abc-123 --name dev-impl@test-rig"
    );
  });

  it("launchHarness returns retry_fresh when Claude reports no conversation found for the requested resume token", async () => {
    const tmux = mockTmux();
    (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("zsh");
    (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue(
      "No conversation found with session ID: abc-123\nmschwarz@host %"
    );
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-impl@test-rig", resumeToken: "abc-123" });

    expect(result).toEqual({
      ok: false,
      error: "Claude resume failed: no conversation found for the requested session",
      recovery: "retry_fresh",
    });
  });

  it("launchHarness treats a live Claude TUI as success even when tmux reports a version-string foreground command", async () => {
    const tmux = mockTmux();
    (tmux.getPaneCommand as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("zsh")
      .mockResolvedValue("2.1.89");
    (tmux.capturePaneContent as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("")
      .mockResolvedValue(
        [
          "Claude Code v2.1.89",
          "❯ Baseline warmup 4/6 for dev.impl.",
          "────────────────────────────────────────────────────────────────────────────────",
          "  ? for shortcuts                                             ● high · /effort",
        ].join("\n")
      );
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });

    const result = await adapter.launchHarness(makeBinding(), {
      name: "dev-impl@test-rig",
      resumeToken: "abc-123",
    });

    expect(result).toEqual({
      ok: true,
      resumeToken: "abc-123",
      resumeType: "claude_id",
    });
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

  // --- Regenerator bug repair: rig-role managed-block skip ---
  //
  // The rig-role managed-block injector pairs target-file × spec independently
  // of seat identity, causing CLAUDE.md to receive the wrong seat's body on
  // multi-seat pods. Per architect SHAPE 1: skip mergeManagedBlock when the
  // block id is `rig-role`. Per-seat delivery travels via startup.files
  // send_text path instead. Skip must be logged (never silent).

  it("projectEntry skips rig-role guidance managed block; CLAUDE.md is not written", async () => {
    const fs = mockFs({ "/agents/impl/guidance/role.md": "# You are `impl`\nTDD discipline." });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan: ProjectionPlan = {
      runtime: "claude-code", cwd: "/project",
      entries: [makeEntry({
        category: "guidance", effectiveId: "rig-role", mergeStrategy: "managed_block",
        absolutePath: "/agents/impl/guidance/role.md", resourcePath: "guidance/role.md",
      })],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };

    const result = await adapter.project(plan, makeBinding());

    const store = (fs as unknown as { _store: Record<string, string> })._store;
    expect(store["/project/CLAUDE.md"]).toBeUndefined();
    // ProjectionResult contract: rig-role must appear in `skipped`, NOT `projected` —
    // otherwise the adapter reports work it did not do (violates honest-detection).
    expect(result.skipped).toContain("rig-role");
    expect(result.projected).not.toContain("rig-role");
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("skip: effectiveId is rig-role")
    );
    logSpy.mockRestore();
  });

  it("projectEntry reports non-rig-role guidance in `projected`, not `skipped` (regression on contract)", async () => {
    const fs = mockFs({ "/agents/base/guidance/using-openrig.md": "# Using OpenRig\nhub guidance" });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan: ProjectionPlan = {
      runtime: "claude-code", cwd: "/project",
      entries: [makeEntry({
        category: "guidance", effectiveId: "using-openrig.md", mergeStrategy: "managed_block",
        absolutePath: "/agents/base/guidance/using-openrig.md", resourcePath: "guidance/using-openrig.md",
      })],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };

    const result = await adapter.project(plan, makeBinding());

    expect(result.projected).toContain("using-openrig.md");
    expect(result.skipped).not.toContain("using-openrig.md");
  });

  it("projectEntry still merges non-rig-role guidance blocks (regression)", async () => {
    const fs = mockFs({ "/agents/base/guidance/using-openrig.md": "# Using OpenRig\nhub guidance" });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan: ProjectionPlan = {
      runtime: "claude-code", cwd: "/project",
      entries: [makeEntry({
        category: "guidance", effectiveId: "using-openrig.md", mergeStrategy: "managed_block",
        absolutePath: "/agents/base/guidance/using-openrig.md", resourcePath: "guidance/using-openrig.md",
      })],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };

    await adapter.project(plan, makeBinding());

    const store = (fs as unknown as { _store: Record<string, string> })._store;
    expect(store["/project/CLAUDE.md"]).toContain("BEGIN RIGGED MANAGED BLOCK: using-openrig.md");
    expect(store["/project/CLAUDE.md"]).toContain("hub guidance");
  });

  it("deliverStartup skips rig-role guidance_merge; delivered is NOT incremented (honest metrics)", async () => {
    const fs = mockFs({ "/rig/rig-role": "# You are `impl`\nrole body" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const file: ResolvedStartupFile = {
      path: "rig-role", absolutePath: "/rig/rig-role", ownerRoot: "/rig",
      deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start", "restore"],
    };

    const result = await adapter.deliverStartup([file], makeBinding());

    // StartupDeliveryResult contract: skip does NOT count as delivered —
    // otherwise delivered drifts from actual writes (violates honest-detection).
    expect(result.delivered).toBe(0);
    expect(result.failed).toEqual([]);
    const store = (fs as unknown as { _store: Record<string, string> })._store;
    expect(store["/project/CLAUDE.md"]).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("skip: effectiveId is rig-role")
    );
    logSpy.mockRestore();
  });

  // --- Permission-config-at-spawn: standard-safe baseline provisioning ---

  it("provisionRigPermissions applies standard-safe baseline on fresh settings", async () => {
    const fs = mockFs({});
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: { ...fs, homedir: "/home/test" } });

    // Trigger provisioning via deliverStartup (which calls provisionManagedBootstrap)
    await adapter.deliverStartup([], makeBinding());

    const store = (fs as unknown as { _store: Record<string, string> })._store;
    const settings = JSON.parse(store["/home/test/.claude/settings.json"] ?? "{}");
    const allow: string[] = settings.permissions?.allow ?? [];

    expect(allow).toContain("Bash(rig:*)");
    expect(allow).toContain("Bash(ls:*)");
    expect(allow).toContain("Bash(cat:*)");
    expect(allow).toContain("Bash(tail:*)");
    expect(allow).toContain("Bash(head:*)");
    expect(allow).toContain("Bash(wc:*)");
    expect(allow).toContain("Bash(grep:*)");
    expect(allow).toContain("Bash(rg:*)");
    expect(allow).toContain("Bash(pwd)");
    expect(allow).toContain("Bash(echo:*)");
    expect(allow).toContain("Bash(which:*)");
  });

  it("provisionRigPermissions is additive — preserves existing allow entries", async () => {
    const fs = mockFs({
      "/home/test/.claude/settings.json": JSON.stringify({
        permissions: { allow: ["Bash(npm:*)", "Bash(git:*)"] },
      }),
    });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: { ...fs, homedir: "/home/test" } });

    await adapter.deliverStartup([], makeBinding());

    const store = (fs as unknown as { _store: Record<string, string> })._store;
    const settings = JSON.parse(store["/home/test/.claude/settings.json"] ?? "{}");
    const allow: string[] = settings.permissions?.allow ?? [];

    // Pre-existing entries preserved
    expect(allow).toContain("Bash(npm:*)");
    expect(allow).toContain("Bash(git:*)");
    // Baseline entries added
    expect(allow).toContain("Bash(ls:*)");
    expect(allow).toContain("Bash(rig:*)");
  });

  it("provisionRigPermissions is idempotent — no duplicates on re-run", async () => {
    const fs = mockFs({});
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: { ...fs, homedir: "/home/test" } });

    // Run twice
    await adapter.deliverStartup([], makeBinding());
    await adapter.deliverStartup([], makeBinding());

    const store = (fs as unknown as { _store: Record<string, string> })._store;
    const settings = JSON.parse(store["/home/test/.claude/settings.json"] ?? "{}");
    const allow: string[] = settings.permissions?.allow ?? [];

    // Each pattern appears exactly once
    const rigCount = allow.filter((p: string) => p === "Bash(rig:*)").length;
    expect(rigCount).toBe(1);
    const lsCount = allow.filter((p: string) => p === "Bash(ls:*)").length;
    expect(lsCount).toBe(1);
  });

  it("provisionRigPermissions writes provenance marker", async () => {
    const fs = mockFs({});
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: { ...fs, homedir: "/home/test" } });

    await adapter.deliverStartup([], makeBinding());

    const store = (fs as unknown as { _store: Record<string, string> })._store;
    const settings = JSON.parse(store["/home/test/.claude/settings.json"] ?? "{}");

    expect(settings._openrig_provenance).toBeDefined();
    expect(settings._openrig_provenance.author).toBe("openrig-at-spawn");
    expect(settings._openrig_provenance.baseline).toBe("standard-safe");
  });

  it("provisionRigPermissions preserves existing deny/ask entries", async () => {
    const fs = mockFs({
      "/home/test/.claude/settings.json": JSON.stringify({
        permissions: {
          deny: ["Bash(rm:*)"],
          ask: ["Bash(git push:*)"],
          allow: [],
        },
      }),
    });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: { ...fs, homedir: "/home/test" } });

    await adapter.deliverStartup([], makeBinding());

    const store = (fs as unknown as { _store: Record<string, string> })._store;
    const settings = JSON.parse(store["/home/test/.claude/settings.json"] ?? "{}");

    expect(settings.permissions.deny).toEqual(["Bash(rm:*)"]);
    expect(settings.permissions.ask).toEqual(["Bash(git push:*)"]);
  });

  it("provisionRigPermissions preserves non-permissions keys", async () => {
    const fs = mockFs({
      "/home/test/.claude/settings.json": JSON.stringify({
        theme: "dark",
        mcpServers: { context7: {} },
        permissions: { allow: [] },
      }),
    });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: { ...fs, homedir: "/home/test" } });

    await adapter.deliverStartup([], makeBinding());

    const store = (fs as unknown as { _store: Record<string, string> })._store;
    const settings = JSON.parse(store["/home/test/.claude/settings.json"] ?? "{}");

    expect(settings.theme).toBe("dark");
    expect(settings.mcpServers).toEqual({ context7: {} });
  });
});
