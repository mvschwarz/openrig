import { memoryProjectionFiles } from "./helpers/omp-files.js";
// Test suite for plugin-primitive Phase 3a slice 3.1 — adapter plugin
// directory projection. Per velocity-guard cadence boundary (c)
// 2026-05-10: prove the runtime adapters copy a real plugin tree
// (nested .claude-plugin/ + skills/ + hooks/ subdirs) to the runtime
// plugin location, not just compute targetDir math.
//
// Claude target: <cwd>/.claude/plugins/<id>/
// Codex target:  <cwd>/.codex/plugins/<id>/
//
// Plugin tree shape (per DESIGN.md §5.5 + IMPL-PRD §2.2):
//   <plugin-root>/
//     .claude-plugin/plugin.json     (Claude manifest)
//     .codex-plugin/plugin.json      (Codex manifest; absent for Claude-only plugin)
//     skills/<id>/SKILL.md           (one or more skill subdirs)
//     hooks/{claude,codex}.json      (hook event configs)
//     hooks/scripts/<file>.cjs       (hook command scripts)

import { describe, it, expect, vi } from "vitest";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import { OmpTuiRuntimeAdapter } from "../src/adapters/omp-tui-runtime-adapter.js";
import { OmpSeatLauncher } from "../src/adapters/omp-seat-launch.js";
import type { ProjectionPlan, ProjectionEntry } from "../src/domain/projection-planner.js";
import type { NodeBinding } from "../src/domain/types.js";

// ----- Mock helpers shared with existing adapter tests -----

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
    _store: store,
  } as CodexAdapterFsOps & { _store: Record<string, string> };
}

function makeBinding(cwd = "/cwd"): NodeBinding {
  return {
    id: "b1", nodeId: "n1", tmuxSession: "test", tmuxWindow: null, tmuxPane: null,
    cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd,
  };
}

function makePluginEntry(id: string, absolutePath: string): ProjectionEntry {
  return {
    category: "plugin",
    effectiveId: id,
    sourceSpec: "test-spec",
    sourcePath: "/specs/test-spec",
    resourcePath: absolutePath,
    absolutePath,
    classification: "safe_projection",
  };
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
// Plugin tree fixtures
// ============================================================

const OPENRIG_CORE_TREE = {
  "/p/openrig-core/.claude-plugin/plugin.json": '{"name":"openrig-core","version":"0.1.0"}',
  "/p/openrig-core/.codex-plugin/plugin.json": '{"name":"openrig-core","version":"0.1.0","description":"openrig"}',
  "/p/openrig-core/skills/openrig-user/SKILL.md": "# openrig-user\nUse for ...",
  "/p/openrig-core/skills/openrig-architect/SKILL.md": "# openrig-architect",
  "/p/openrig-core/hooks/claude.json": '{"hooks":{"SessionStart":[]}}',
  "/p/openrig-core/hooks/codex.json": '{"hooks":{"SessionStart":[]}}',
  "/p/openrig-core/hooks/scripts/activity-relay.cjs": "// relay script body",
  "/p/openrig-core/README.md": "# openrig-core plugin",
};

describe.each(["claude-code", "codex", "omp-tui"] as const)("shared plugin contract: %s", runtime => {
  it("projects the same dual-manifest plugin, hook commands and skills, and refreshes changed content", async () => {
    const files = { ...OPENRIG_CORE_TREE,
      "/p/openrig-core/package.json": JSON.stringify({ omp: { extensions: ["omp/index.js"] } }),
      "/p/openrig-core/omp/index.js": "export default function activate() {}",
      "/p/openrig-core/hooks/claude.json": JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/activity-relay.cjs"' }] }] } }),
      "/p/openrig-core/hooks/codex.json": JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: 'node "${PLUGIN_ROOT}/hooks/scripts/activity-relay.cjs"' }] }] } }),
    };
    const fs = mockClaudeFs(files);
    Object.assign(fs, memoryProjectionFiles(fs._store));
    fs.exists = p => p in fs._store || Object.keys(fs._store).some(file => file.startsWith(`${p}/`));
    fs.copyFile = (src, dest) => { fs._store[dest] = fs.readFile(src); };
    const tmux = mockTmux();
    const launcher = new OmpSeatLauncher({ tmux, fsOps: fs, stateRoot: "/state", seatExtensionPath: "/assets/omp/openrig-seat.js" });
    const adapter = runtime === "omp-tui" ? new OmpTuiRuntimeAdapter({ tmux, fsOps: fs, launcher })
      : runtime === "codex" ? new CodexRuntimeAdapter({ tmux, fsOps: fs }) : new ClaudeCodeAdapter({ tmux, fsOps: fs });
    const target = runtime === "omp-tui" ? `${launcher.paths("test").pluginsDir}/openrig-core` : `/cwd/.${runtime === "codex" ? "codex" : "claude"}/plugins/openrig-core`;
    const plan = { ...makePlan([makePluginEntry("openrig-core", "/p/openrig-core")]), runtime };
    const result = await adapter.project(plan, makeBinding());
    expect(result.failed).toEqual([]);
    expect(result.projected).toEqual(["openrig-core"]);
    for (const [source, content] of Object.entries(files)) expect(fs._store[target + source.slice("/p/openrig-core".length)]).toBe(content);
    fs._store["/p/openrig-core/hooks/scripts/activity-relay.cjs"] = "// updated command";
    await adapter.project(plan, makeBinding());
    expect(fs._store[`${target}/hooks/scripts/activity-relay.cjs`]).toBe("// updated command");
    if (runtime === "omp-tui") {
      expect(launcher.pluginRoots("test")).toEqual([target]);
      await adapter.project({ ...plan, entries: [] }, makeBinding());
      expect(launcher.pluginRoots("test")).toEqual([]);
    }
  });
});

// ============================================================
// Claude Code adapter — plugin tree projection
// ============================================================

describe("Claude Code adapter — plugin directory projection", () => {
  it("copies entire plugin tree to <cwd>/.claude/plugins/<id>/ preserving nested structure", async () => {
    const fs = mockClaudeFs(OPENRIG_CORE_TREE);
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makePluginEntry("openrig-core", "/p/openrig-core")]);

    const result = await adapter.project(plan, makeBinding("/cwd"));

    expect(result.projected).toContain("openrig-core");
    expect(result.failed).toEqual([]);

    // All 8 source files should land at the correct nested target paths
    expect(fs._store["/cwd/.claude/plugins/openrig-core/.claude-plugin/plugin.json"]).toBe('{"name":"openrig-core","version":"0.1.0"}');
    expect(fs._store["/cwd/.claude/plugins/openrig-core/.codex-plugin/plugin.json"]).toBe('{"name":"openrig-core","version":"0.1.0","description":"openrig"}');
    expect(fs._store["/cwd/.claude/plugins/openrig-core/skills/openrig-user/SKILL.md"]).toBe("# openrig-user\nUse for ...");
    expect(fs._store["/cwd/.claude/plugins/openrig-core/skills/openrig-architect/SKILL.md"]).toBe("# openrig-architect");
    expect(fs._store["/cwd/.claude/plugins/openrig-core/hooks/claude.json"]).toBe('{"hooks":{"SessionStart":[]}}');
    expect(fs._store["/cwd/.claude/plugins/openrig-core/hooks/codex.json"]).toBe('{"hooks":{"SessionStart":[]}}');
    expect(fs._store["/cwd/.claude/plugins/openrig-core/hooks/scripts/activity-relay.cjs"]).toBe("// relay script body");
    expect(fs._store["/cwd/.claude/plugins/openrig-core/README.md"]).toBe("# openrig-core plugin");
  });

  it("plugin projection lands at .claude/plugins/, NOT .claude/skills/ or other category dirs (drift discriminator)", async () => {
    const fs = mockClaudeFs({ "/p/test-plugin/.claude-plugin/plugin.json": "{}", "/p/test-plugin/skills/x/SKILL.md": "# x" });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makePluginEntry("test-plugin", "/p/test-plugin")]);

    await adapter.project(plan, makeBinding("/cwd"));

    // Lands at the plugin dir
    expect(fs._store["/cwd/.claude/plugins/test-plugin/.claude-plugin/plugin.json"]).toBe("{}");
    // Does NOT land at the skills dir (the skill SKILL.md inside the plugin is part of the plugin tree, not promoted to .claude/skills)
    expect(fs._store["/cwd/.claude/skills/test-plugin/SKILL.md"]).toBeUndefined();
    expect(fs._store["/cwd/.claude/skills/x/SKILL.md"]).toBeUndefined();
    // The plugin's nested skill stays inside the plugin tree
    expect(fs._store["/cwd/.claude/plugins/test-plugin/skills/x/SKILL.md"]).toBe("# x");
  });

  it("multiple plugins project into separate <id> subdirs", async () => {
    const fs = mockClaudeFs({
      "/p/plugin-a/.claude-plugin/plugin.json": '{"name":"plugin-a"}',
      "/p/plugin-a/skills/a-skill/SKILL.md": "# a",
      "/p/plugin-b/.claude-plugin/plugin.json": '{"name":"plugin-b"}',
      "/p/plugin-b/skills/b-skill/SKILL.md": "# b",
    });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([
      makePluginEntry("plugin-a", "/p/plugin-a"),
      makePluginEntry("plugin-b", "/p/plugin-b"),
    ]);

    const result = await adapter.project(plan, makeBinding("/cwd"));

    expect(result.projected).toContain("plugin-a");
    expect(result.projected).toContain("plugin-b");
    expect(fs._store["/cwd/.claude/plugins/plugin-a/skills/a-skill/SKILL.md"]).toBe("# a");
    expect(fs._store["/cwd/.claude/plugins/plugin-b/skills/b-skill/SKILL.md"]).toBe("# b");
    // Plugins stay isolated; b's skill is NOT under a's plugin tree
    expect(fs._store["/cwd/.claude/plugins/plugin-a/skills/b-skill/SKILL.md"]).toBeUndefined();
  });

  it("plugin re-projection is a no-op when hash matches (idempotent)", async () => {
    const fs = mockClaudeFs({
      "/p/openrig-core/.claude-plugin/plugin.json": "{}",
      "/cwd/.claude/plugins/openrig-core/.claude-plugin/plugin.json": "{}", // already projected with same content
    });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makePluginEntry("openrig-core", "/p/openrig-core")]);

    let writeCount = 0;
    const origWrite = fs.writeFile;
    fs.writeFile = (p, c) => { writeCount++; origWrite(p, c); };

    await adapter.project(plan, makeBinding("/cwd"));

    // Hash-match should skip the write — no spurious overwrites of unchanged plugin files
    expect(writeCount).toBe(0);
  });
});

// ============================================================
// Codex adapter — plugin tree projection
// ============================================================

describe("Codex adapter — plugin directory projection", () => {
  it("copies entire plugin tree to <cwd>/.codex/plugins/<id>/ preserving nested structure", async () => {
    const fs = mockCodexFs(OPENRIG_CORE_TREE);
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makePluginEntry("openrig-core", "/p/openrig-core")]);

    const result = await adapter.project(plan, makeBinding("/cwd"));

    expect(result.projected).toContain("openrig-core");
    expect(result.failed).toEqual([]);

    // All 8 source files should land at the correct nested Codex target paths
    expect(fs._store["/cwd/.codex/plugins/openrig-core/.claude-plugin/plugin.json"]).toBe('{"name":"openrig-core","version":"0.1.0"}');
    expect(fs._store["/cwd/.codex/plugins/openrig-core/.codex-plugin/plugin.json"]).toBe('{"name":"openrig-core","version":"0.1.0","description":"openrig"}');
    expect(fs._store["/cwd/.codex/plugins/openrig-core/skills/openrig-user/SKILL.md"]).toBe("# openrig-user\nUse for ...");
    expect(fs._store["/cwd/.codex/plugins/openrig-core/hooks/codex.json"]).toBe('{"hooks":{"SessionStart":[]}}');
    expect(fs._store["/cwd/.codex/plugins/openrig-core/hooks/scripts/activity-relay.cjs"]).toBe("// relay script body");
  });

  it("Codex plugin lands at .codex/plugins/ NOT .agents/skills/ (drift discriminator vs skill projection)", async () => {
    const fs = mockCodexFs({
      "/p/test-plugin/.codex-plugin/plugin.json": "{}",
      "/p/test-plugin/skills/x/SKILL.md": "# x",
    });
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makePluginEntry("test-plugin", "/p/test-plugin")]);

    await adapter.project(plan, makeBinding("/cwd"));

    expect(fs._store["/cwd/.codex/plugins/test-plugin/.codex-plugin/plugin.json"]).toBe("{}");
    expect(fs._store["/cwd/.codex/plugins/test-plugin/skills/x/SKILL.md"]).toBe("# x");
    // Nested skill NOT promoted to runtime skills dir
    expect(fs._store["/cwd/.agents/skills/test-plugin/SKILL.md"]).toBeUndefined();
    expect(fs._store["/cwd/.agents/skills/x/SKILL.md"]).toBeUndefined();
  });
});

// ============================================================
// Cross-runtime layer-discrimination — same plugin, different targets
// ============================================================

describe("Plugin projection — cross-runtime target discrimination", () => {
  it("same plugin source projects to .claude/plugins on Claude AND .codex/plugins on Codex (distinct targets)", async () => {
    const claudeFs = mockClaudeFs(OPENRIG_CORE_TREE);
    const codexFs = mockCodexFs(OPENRIG_CORE_TREE);
    const claudeAdapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: claudeFs });
    const codexAdapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: codexFs });
    const plan = makePlan([makePluginEntry("openrig-core", "/p/openrig-core")]);

    await claudeAdapter.project(plan, makeBinding("/cwd"));
    await codexAdapter.project(plan, makeBinding("/cwd"));

    // Claude target distinct from Codex target
    expect(claudeFs._store["/cwd/.claude/plugins/openrig-core/.claude-plugin/plugin.json"]).toBeDefined();
    expect(claudeFs._store["/cwd/.codex/plugins/openrig-core/.codex-plugin/plugin.json"]).toBeUndefined();

    expect(codexFs._store["/cwd/.codex/plugins/openrig-core/.codex-plugin/plugin.json"]).toBeDefined();
    expect(codexFs._store["/cwd/.claude/plugins/openrig-core/.claude-plugin/plugin.json"]).toBeUndefined();
  });
});
