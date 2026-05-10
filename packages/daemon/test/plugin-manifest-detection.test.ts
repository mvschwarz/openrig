// Test suite for plugin-primitive Phase 3a slice 3.1 — HG-1.3 plugin
// manifest detection + plugin_type runtime applicability filtering.
// Per velocity-guard Checkpoint C carried concern + IMPL-PRD §1.3 HG-1.3.
//
// Three forms must be detected + routed correctly:
//   - Claude-only plugin: source has .claude-plugin/ but no .codex-plugin/
//   - Codex-only plugin:  source has .codex-plugin/ but no .claude-plugin/
//   - Dual-manifest:      source has BOTH .claude-plugin/ and .codex-plugin/
//                         (Obra Superpowers shape)
//
// Filtering rules (per DESIGN.md §5.1 PluginResource.pluginType):
//   - pluginType: "claude" → only Claude adapter projects this plugin
//   - pluginType: "codex"  → only Codex adapter projects this plugin
//   - pluginType: "auto" (or omitted) → adapter projects only if its
//     runtime-specific manifest dir exists in the source

import { describe, it, expect, vi } from "vitest";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../src/domain/projection-planner.js";
import type { NodeBinding } from "../src/domain/types.js";

function mockTmux() {
  return {
    sessionExists: vi.fn().mockResolvedValue(true),
    sendKeys: vi.fn().mockResolvedValue(undefined),
    capturePaneContent: vi.fn().mockResolvedValue(""),
    getPaneCommand: vi.fn().mockResolvedValue(""),
    listSessions: vi.fn().mockResolvedValue([]),
    runCommandInSession: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    setEnvVar: vi.fn().mockResolvedValue(undefined),
  } as unknown as ConstructorParameters<typeof ClaudeCodeAdapter>[0]["tmux"];
}

function mockClaudeFs(files?: Record<string, string>): ClaudeAdapterFsOps & { _store: Record<string, string> } {
  const store: Record<string, string> = { ...files };
  return {
    readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`Not found: ${p}`); },
    writeFile: (p: string, c: string) => { store[p] = c; },
    exists: (p: string) => p in store,
    mkdirp: () => {},
    copyFile: () => {},
    listFiles: (dir: string) => Object.keys(store).filter((k) => k.startsWith(dir + "/")).map((k) => k.slice(dir.length + 1)),
    homedir: "/home/test",
    _store: store,
  } as ClaudeAdapterFsOps & { _store: Record<string, string> };
}

function mockCodexFs(files?: Record<string, string>): CodexAdapterFsOps & { _store: Record<string, string> } {
  const store: Record<string, string> = { ...files };
  return {
    readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`Not found: ${p}`); },
    writeFile: (p: string, c: string) => { store[p] = c; },
    exists: (p: string) => p in store,
    mkdirp: () => {},
    listFiles: (dir: string) => Object.keys(store).filter((k) => k.startsWith(dir + "/")).map((k) => k.slice(dir.length + 1)),
    homedir: "/home/test",
    _store: store,
  } as CodexAdapterFsOps & { _store: Record<string, string> };
}

function makeBinding(cwd = "/cwd"): NodeBinding {
  return {
    id: "b1", nodeId: "n1", tmuxSession: "test", tmuxWindow: null, tmuxPane: null,
    cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd,
  };
}

function makePluginEntry(id: string, absolutePath: string, pluginType?: "claude" | "codex" | "auto"): ProjectionEntry {
  return {
    category: "plugin",
    effectiveId: id,
    sourceSpec: "test-spec",
    sourcePath: "/specs/test-spec",
    resourcePath: absolutePath,
    absolutePath,
    classification: "safe_projection",
    // Carry pluginType through ProjectionEntry; planner is responsible for
    // setting it from the qr.resource.pluginType field.
    pluginType,
  } as ProjectionEntry & { pluginType?: "claude" | "codex" | "auto" };
}

function makePlan(entries: ProjectionEntry[]): ProjectionPlan {
  return {
    runtime: "claude-code",
    cwd: "/cwd",
    entries,
    startup: { files: [], actions: [] },
    conflicts: [],
    noOps: [],
    diagnostics: [],
  };
}

// ============================================================
// Plugin tree fixtures — three manifest shapes
// ============================================================

const CLAUDE_ONLY_TREE = {
  "/p/claude-only/.claude-plugin/plugin.json": '{"name":"claude-only"}',
  "/p/claude-only/skills/c1/SKILL.md": "# c1",
};

const CODEX_ONLY_TREE = {
  "/p/codex-only/.codex-plugin/plugin.json": '{"name":"codex-only","version":"1.0","description":"d"}',
  "/p/codex-only/skills/x1/SKILL.md": "# x1",
};

const DUAL_TREE = {
  "/p/dual/.claude-plugin/plugin.json": '{"name":"dual"}',
  "/p/dual/.codex-plugin/plugin.json": '{"name":"dual","version":"1.0","description":"d"}',
  "/p/dual/skills/d1/SKILL.md": "# d1",
};

// ============================================================
// Claude adapter — runtime applicability filtering
// ============================================================

describe("Claude adapter — plugin_type runtime applicability filtering (HG-1.3)", () => {
  it("projects Claude-only plugin (plugin_type unset; .claude-plugin/ only) to .claude/plugins/", async () => {
    const fs = mockClaudeFs(CLAUDE_ONLY_TREE);
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makePluginEntry("claude-only", "/p/claude-only", "auto")]);

    const result = await adapter.project(plan, makeBinding("/cwd"));

    expect(result.projected).toContain("claude-only");
    expect(fs._store["/cwd/.claude/plugins/claude-only/.claude-plugin/plugin.json"]).toBeDefined();
  });

  it("SKIPS Codex-only plugin (no .claude-plugin/ dir; auto-detect) — does NOT project to .claude/plugins/", async () => {
    const fs = mockClaudeFs(CODEX_ONLY_TREE);
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makePluginEntry("codex-only", "/p/codex-only", "auto")]);

    const result = await adapter.project(plan, makeBinding("/cwd"));

    // Skipped because the plugin has no .claude-plugin/ manifest — auto-detection
    // says this isn't applicable to Claude runtime.
    expect(result.skipped).toContain("codex-only");
    expect(fs._store["/cwd/.claude/plugins/codex-only/.codex-plugin/plugin.json"]).toBeUndefined();
    expect(fs._store["/cwd/.claude/plugins/codex-only/skills/x1/SKILL.md"]).toBeUndefined();
  });

  it("projects dual-manifest plugin (both manifests present; auto-detect) to .claude/plugins/", async () => {
    const fs = mockClaudeFs(DUAL_TREE);
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makePluginEntry("dual", "/p/dual", "auto")]);

    const result = await adapter.project(plan, makeBinding("/cwd"));

    expect(result.projected).toContain("dual");
    expect(fs._store["/cwd/.claude/plugins/dual/.claude-plugin/plugin.json"]).toBeDefined();
    expect(fs._store["/cwd/.claude/plugins/dual/skills/d1/SKILL.md"]).toBeDefined();
  });

  it("explicit plugin_type=claude forces projection even if .claude-plugin/ missing (operator override)", async () => {
    const fs = mockClaudeFs(CODEX_ONLY_TREE);
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makePluginEntry("codex-only", "/p/codex-only", "claude")]);

    const result = await adapter.project(plan, makeBinding("/cwd"));

    expect(result.projected).toContain("codex-only");
    expect(fs._store["/cwd/.claude/plugins/codex-only/.codex-plugin/plugin.json"]).toBeDefined();
  });

  it("explicit plugin_type=codex SKIPS Claude projection even if .claude-plugin/ exists", async () => {
    const fs = mockClaudeFs(CLAUDE_ONLY_TREE);
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makePluginEntry("claude-only", "/p/claude-only", "codex")]);

    const result = await adapter.project(plan, makeBinding("/cwd"));

    expect(result.skipped).toContain("claude-only");
    expect(fs._store["/cwd/.claude/plugins/claude-only/.claude-plugin/plugin.json"]).toBeUndefined();
  });
});

// ============================================================
// Codex adapter — runtime applicability filtering
// ============================================================

describe("Codex adapter — plugin_type runtime applicability filtering (HG-1.3)", () => {
  it("projects Codex-only plugin (plugin_type unset; .codex-plugin/ only) to .codex/plugins/", async () => {
    const fs = mockCodexFs(CODEX_ONLY_TREE);
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makePluginEntry("codex-only", "/p/codex-only", "auto")]);

    const result = await adapter.project(plan, makeBinding("/cwd"));

    expect(result.projected).toContain("codex-only");
    expect(fs._store["/cwd/.codex/plugins/codex-only/.codex-plugin/plugin.json"]).toBeDefined();
  });

  it("SKIPS Claude-only plugin (no .codex-plugin/ dir; auto-detect) — does NOT project to .codex/plugins/", async () => {
    const fs = mockCodexFs(CLAUDE_ONLY_TREE);
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makePluginEntry("claude-only", "/p/claude-only", "auto")]);

    const result = await adapter.project(plan, makeBinding("/cwd"));

    expect(result.skipped).toContain("claude-only");
    expect(fs._store["/cwd/.codex/plugins/claude-only/.claude-plugin/plugin.json"]).toBeUndefined();
  });

  it("projects dual-manifest plugin to .codex/plugins/", async () => {
    const fs = mockCodexFs(DUAL_TREE);
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makePluginEntry("dual", "/p/dual", "auto")]);

    const result = await adapter.project(plan, makeBinding("/cwd"));

    expect(result.projected).toContain("dual");
    expect(fs._store["/cwd/.codex/plugins/dual/.codex-plugin/plugin.json"]).toBeDefined();
  });

  it("explicit plugin_type=claude SKIPS Codex projection even if .codex-plugin/ exists", async () => {
    const fs = mockCodexFs(CODEX_ONLY_TREE);
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makePluginEntry("codex-only", "/p/codex-only", "claude")]);

    const result = await adapter.project(plan, makeBinding("/cwd"));

    expect(result.skipped).toContain("codex-only");
    expect(fs._store["/cwd/.codex/plugins/codex-only/.codex-plugin/plugin.json"]).toBeUndefined();
  });
});

// ============================================================
// Drift discriminator — three plugins, three different filter outcomes per adapter
// ============================================================

describe("Plugin manifest detection — cross-runtime drift discriminator", () => {
  it("three plugins (claude-only, codex-only, dual) project distinctly per adapter (drift discriminator)", async () => {
    const allTrees = { ...CLAUDE_ONLY_TREE, ...CODEX_ONLY_TREE, ...DUAL_TREE };
    const claudeFs = mockClaudeFs(allTrees);
    const codexFs = mockCodexFs(allTrees);
    const claudeAdapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: claudeFs });
    const codexAdapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: codexFs });
    const plan = makePlan([
      makePluginEntry("claude-only", "/p/claude-only", "auto"),
      makePluginEntry("codex-only", "/p/codex-only", "auto"),
      makePluginEntry("dual", "/p/dual", "auto"),
    ]);

    const claudeResult = await claudeAdapter.project(plan, makeBinding("/cwd"));
    const codexResult = await codexAdapter.project(plan, makeBinding("/cwd"));

    // Claude: projects claude-only + dual; SKIPS codex-only
    expect(claudeResult.projected.sort()).toEqual(["claude-only", "dual"]);
    expect(claudeResult.skipped).toContain("codex-only");

    // Codex: projects codex-only + dual; SKIPS claude-only
    expect(codexResult.projected.sort()).toEqual(["codex-only", "dual"]);
    expect(codexResult.skipped).toContain("claude-only");

    // Cross-check: NO plugin lands at the wrong runtime target
    expect(claudeFs._store["/cwd/.claude/plugins/codex-only/.codex-plugin/plugin.json"]).toBeUndefined();
    expect(codexFs._store["/cwd/.codex/plugins/claude-only/.claude-plugin/plugin.json"]).toBeUndefined();
  });
});
