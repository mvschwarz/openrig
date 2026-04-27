import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const VALID_STATUS_LINE = JSON.stringify({
  context_window: {
    context_window_size: 200000,
    used_percentage: 67,
    remaining_percentage: 33,
    total_input_tokens: 120000,
    total_output_tokens: 14000,
    current_usage: "67% used",
  },
  session_id: "sess-123",
  session_name: "dev-impl@test",
  transcript_path: "/tmp/transcripts/test.log",
});

describe("Claude Status Line Collector Script", () => {
  let tmpDir: string;
  // Resolve relative to this test file, not process.cwd()
  const collectorPath = join(import.meta.dirname, "../assets/claude-statusline-context.cjs");

  beforeEach(() => {
    tmpDir = join(tmpdir(), `collector-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // T1: Parses valid status line and writes sidecar
  it("parses valid Claude status line JSON and writes sidecar file", () => {
    const outputPath = join(tmpDir, "context", "test.json");
    execSync(`echo '${VALID_STATUS_LINE}' | node ${collectorPath} ${outputPath}`, { encoding: "utf-8" });

    expect(existsSync(outputPath)).toBe(true);
    const content = JSON.parse(readFileSync(outputPath, "utf-8"));
    expect(content.context_window.used_percentage).toBe(67);
    expect(content.context_window.context_window_size).toBe(200000);
    expect(content.session_id).toBe("sess-123");
    expect(content.session_name).toBe("dev-impl@test");
    expect(content.transcript_path).toBe("/tmp/transcripts/test.log");
    expect(content.sampled_at).toBeTruthy();
  });

  // T2: Atomic write (no .tmp left behind on success)
  it("writes atomically — no .tmp file left behind", () => {
    const outputPath = join(tmpDir, "context", "atomic.json");
    execSync(`echo '${VALID_STATUS_LINE}' | node ${collectorPath} ${outputPath}`, { encoding: "utf-8" });

    expect(existsSync(outputPath)).toBe(true);
    expect(existsSync(outputPath + ".tmp")).toBe(false);
  });

  // T3: Malformed stdin — graceful exit, no output
  it("handles malformed stdin gracefully — no output file created", () => {
    const outputPath = join(tmpDir, "context", "bad.json");
    const result = spawnSync("node", [collectorPath, outputPath], {
      encoding: "utf-8",
      input: "not json {{",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("[openrig][collector]");
    expect(existsSync(outputPath)).toBe(false);
  });

  it("writes to a session-specific sidecar when given a context directory", () => {
    const outputDir = join(tmpDir, "context");
    execSync(`echo '${VALID_STATUS_LINE}' | node ${collectorPath} ${outputDir}`, { encoding: "utf-8" });

    const sessionSidecar = join(outputDir, "dev-impl@test.json");
    expect(existsSync(sessionSidecar)).toBe(true);
    const content = JSON.parse(readFileSync(sessionSidecar, "utf-8"));
    expect(content.session_name).toBe("dev-impl@test");
    expect(content.context_window.used_percentage).toBe(67);
  });

  // T3b: No output path arg — silent exit
  it("silently exits with no output path argument", () => {
    // Should not throw
    execSync(`echo '${VALID_STATUS_LINE}' | node ${collectorPath}`, { encoding: "utf-8" });
  });

  it("logs a shape error when a directory target cannot be resolved to a session sidecar", () => {
    const outputDir = join(tmpDir, "context");
    const result = spawnSync("node", [collectorPath, outputDir], {
      encoding: "utf-8",
      input: JSON.stringify({ context_window: { used_percentage: 10 } }),
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("could not resolve output path");
  });
});

describe("ClaudeCodeAdapter Context Collector Provisioning", () => {
  let tmpDir: string;
  let written: Record<string, string>;
  let dirsMade: string[];

  beforeEach(() => {
    tmpDir = join(tmpdir(), `adapter-collector-${Date.now()}`);
    written = {};
    dirsMade = [];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function mockFsOps() {
    return {
      readFile: (p: string) => written[p] ?? (() => { throw new Error("ENOENT"); })(),
      writeFile: (p: string, c: string) => { written[p] = c; },
      exists: (p: string) => p in written,
      mkdirp: (p: string) => { dirsMade.push(p); },
      copyFile: (src: string, dest: string) => { written[dest] = `copied:${src}`; },
      homedir: "/home/tester",
    };
  }

  function mockTmux(): TmuxAdapter {
    return {
      sendText: vi.fn(async () => ({ ok: true as const })),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
      createSession: vi.fn(async () => ({ ok: true as const })),
      killSession: vi.fn(async () => ({ ok: true as const })),
      listSessions: vi.fn(async () => []),
      listWindows: async () => [],
      listPanes: async () => [],
      hasSession: vi.fn(async () => false),
      setSessionOption: vi.fn(async () => ({ ok: true as const })),
      getSessionOption: vi.fn(async () => null),
    } as unknown as TmuxAdapter;
  }

  // T4: deliverStartup provisions settings.local.json
  it("deliverStartup provisions .claude/settings.local.json with statusLine config", async () => {
    const adapter = new ClaudeCodeAdapter({
      tmux: mockTmux(),
      fsOps: mockFsOps(),
      stateDir: tmpDir,
      collectorAssetPath: "/fake/collector.js",
    });

    await adapter.deliverStartup([], { cwd: "/project", tmuxSession: "dev-impl@test", nodeId: "n1" } as any);

    const settingsPath = "/project/.claude/settings.local.json";
    expect(written[settingsPath]).toBeDefined();
    const settings = JSON.parse(written[settingsPath]!);
    expect(settings.statusLine).toBeDefined();
    expect(settings.statusLine.type).toBe("command");
    expect(settings.statusLine.command).toContain("context-collector.cjs");
    expect(settings.statusLine.command).toContain(join(tmpDir, "context"));
  });

  // T5: deliverStartup copies collector script to project
  it("deliverStartup copies collector script to project .openrig/", async () => {
    const adapter = new ClaudeCodeAdapter({
      tmux: mockTmux(),
      fsOps: mockFsOps(),
      stateDir: tmpDir,
      collectorAssetPath: "/daemon/assets/collector.js",
    });

    await adapter.deliverStartup([], { cwd: "/project", tmuxSession: "test", nodeId: "n1" } as any);

    const collectorDest = "/project/.openrig/context-collector.cjs";
    expect(written[collectorDest]).toBe("copied:/daemon/assets/collector.js");
  });

  // T6: Provisioning failure does not block delivery result
  it("provisioning failure does not block node startup", async () => {
    const brokenFs = {
      ...mockFsOps(),
      copyFile: () => { throw new Error("disk full"); },
    };
    const adapter = new ClaudeCodeAdapter({
      tmux: mockTmux(),
      fsOps: brokenFs,
      stateDir: tmpDir,
      collectorAssetPath: "/fake/collector.js",
    });

    const result = await adapter.deliverStartup([], { cwd: "/project", tmuxSession: "test", nodeId: "n1" } as any);

    // Should succeed despite provisioning failure
    expect(result.failed).toHaveLength(0);
  });

  // T7: No provisioning without stateDir/collectorAssetPath
  it("no collector provisioning when stateDir or collectorAssetPath is missing", async () => {
    const adapter = new ClaudeCodeAdapter({
      tmux: mockTmux(),
      fsOps: mockFsOps(),
      // no stateDir, no collectorAssetPath
    });

    await adapter.deliverStartup([], { cwd: "/project", tmuxSession: "test", nodeId: "n1" } as any);

    // Permissions/MCP may still be provisioned, but statusLine (collector) must not be
    const settingsContent = written["/project/.claude/settings.local.json"];
    if (settingsContent) {
      const settings = JSON.parse(settingsContent);
      expect(settings.statusLine).toBeUndefined();
    }
    // Collector script must not be written
    expect(written["/project/.openrig/context-collector.cjs"]).toBeUndefined();
  });

  // T8: Existing settings.local.json with unrelated keys preserved
  it("preserves existing unrelated settings in settings.local.json", async () => {
    const fs = mockFsOps();
    // Pre-existing settings.local.json
    written["/project/.claude/settings.local.json"] = JSON.stringify({ customSetting: true, theme: "dark" });

    const adapter = new ClaudeCodeAdapter({
      tmux: mockTmux(),
      fsOps: fs,
      stateDir: tmpDir,
      collectorAssetPath: "/fake/collector.js",
    });

    await adapter.deliverStartup([], { cwd: "/project", tmuxSession: "test", nodeId: "n1" } as any);

    const settings = JSON.parse(written["/project/.claude/settings.local.json"]!);
    expect(settings.customSetting).toBe(true);
    expect(settings.theme).toBe("dark");
    expect(settings.statusLine).toBeDefined();
    expect(settings.statusLine.type).toBe("command");
    expect(settings.statusLine.command).toContain("context-collector.cjs");
  });

  it("ensureContextCollector is a public best-effort seam for adopted tmux sessions", () => {
    const adapter = new ClaudeCodeAdapter({
      tmux: mockTmux(),
      fsOps: mockFsOps(),
      stateDir: tmpDir,
      collectorAssetPath: "/fake/collector.js",
    });

    adapter.ensureContextCollector({ cwd: "/project", tmuxSession: "dev-impl@test" } as any);

    const settings = JSON.parse(written["/project/.claude/settings.local.json"]!);
    expect(settings.statusLine.type).toBe("command");
    expect(settings.statusLine.command).toContain(join(tmpDir, "context"));
    expect(written["/project/.openrig/context-collector.cjs"]).toBe("copied:/fake/collector.js");
  });

  it("deliverStartup provisions user-scope Claude permissions for rig commands", async () => {
    const adapter = new ClaudeCodeAdapter({
      tmux: mockTmux(),
      fsOps: mockFsOps(),
      stateDir: tmpDir,
      collectorAssetPath: "/fake/collector.js",
    });

    await adapter.deliverStartup([], { cwd: "/project", tmuxSession: "dev-impl@test", nodeId: "n1" } as any);

    const settingsPath = "/home/tester/.claude/settings.json";
    expect(written[settingsPath]).toBeDefined();
    const settings = JSON.parse(written[settingsPath]!);
    expect(settings.permissions.allow).toContain("Bash(rig:*)");
  });

  it("deliverStartup provisions project-scope Claude permissions and MCP config without clobbering existing settings", async () => {
    written["/project/.claude/settings.local.json"] = JSON.stringify({
      customSetting: true,
      permissions: {
        allow: ["Bash(rig:*)", "Bash(npm *)"],
        ask: ["Bash(existing-ask:*)"],
        deny: ["Bash(git push*)", "Bash(git commit*)", "Bash(gh pr *)", "Bash(rm -rf *)", "Bash(custom-danger:*)"],
      },
    });
    written["/project/.mcp.json"] = JSON.stringify({
      mcpServers: {
        existing: { type: "http", url: "https://example.com/mcp" },
      },
    });

    const adapter = new ClaudeCodeAdapter({
      tmux: mockTmux(),
      fsOps: mockFsOps(),
      stateDir: tmpDir,
      collectorAssetPath: "/fake/collector.js",
    });

    await adapter.deliverStartup([], { cwd: "/project", tmuxSession: "dev-impl@test", nodeId: "n1" } as any);

    const settings = JSON.parse(written["/project/.claude/settings.local.json"]!);
    expect(settings.customSetting).toBe(true);
    expect(settings.statusLine.type).toBe("command");
    expect(settings.permissions.defaultMode).toBe("acceptEdits");
    expect(settings.enabledMcpjsonServers).toEqual(["existing", "exa", "context7"]);
    expect(settings.permissions.allow).toContain("Bash(rig:*)");
    expect(settings.permissions.allow.filter((rule: string) => rule === "Bash(rig:*)")).toHaveLength(1);
    expect(settings.permissions.allow).toContain("Bash(npm *)");
    expect(settings.permissions.allow).not.toContain("Read");
    expect(settings.permissions.allow).not.toContain("Edit");
    expect(settings.permissions.allow).not.toContain("Bash(cat *)");
    expect(settings.permissions.ask).toContain("Bash(existing-ask:*)");
    expect(settings.permissions.ask).toContain("Bash(rig up:*)");
    expect(settings.permissions.ask).toContain("Bash(rig down:*)");
    expect(settings.permissions.ask.filter((rule: string) => rule === "Bash(rig up:*)")).toHaveLength(1);
    expect(settings.permissions.ask.filter((rule: string) => rule === "Bash(rig down:*)")).toHaveLength(1);
    expect(settings.permissions.deny).toEqual(["Bash(custom-danger:*)"]);
    expect(settings.permissions.deny).not.toContain("Bash(git push*)");
    expect(settings.permissions.deny).not.toContain("Bash(git commit*)");
    expect(settings.permissions.deny).not.toContain("Bash(gh pr *)");
    expect(settings.permissions.deny).not.toContain("Bash(rm -rf *)");

    const mcpConfig = JSON.parse(written["/project/.mcp.json"]!);
    expect(mcpConfig.mcpServers.existing.url).toBe("https://example.com/mcp");
    expect(mcpConfig.mcpServers.exa.url).toBe("https://mcp.exa.ai/mcp");
    expect(mcpConfig.mcpServers.context7.url).toBe("https://mcp.context7.com/mcp");
  });

  it("deliverStartup keeps project-local Claude permission and MCP rules idempotent across repeated startup", async () => {
    written["/project/.mcp.json"] = JSON.stringify({
      mcpServers: {
        existing: { type: "http", url: "https://example.com/mcp" },
      },
    });

    const adapter = new ClaudeCodeAdapter({
      tmux: mockTmux(),
      fsOps: mockFsOps(),
      stateDir: tmpDir,
      collectorAssetPath: "/fake/collector.js",
    });

    await adapter.deliverStartup([], { cwd: "/project", tmuxSession: "dev-impl@test", nodeId: "n1" } as any);
    await adapter.deliverStartup([], { cwd: "/project", tmuxSession: "dev-impl@test", nodeId: "n1" } as any);

    const settings = JSON.parse(written["/project/.claude/settings.local.json"]!);
    expect(settings.permissions.allow.filter((rule: string) => rule === "Bash(rig:*)")).toHaveLength(1);
    expect(settings.permissions.allow).not.toContain("Read");
    expect(settings.permissions.allow).not.toContain("Edit");
    expect(settings.permissions.ask.filter((rule: string) => rule === "Bash(rig up:*)")).toHaveLength(1);
    expect(settings.permissions.ask.filter((rule: string) => rule === "Bash(rig down:*)")).toHaveLength(1);
    expect(settings.permissions.deny ?? []).not.toContain("Bash(rm -rf *)");
    expect(settings.permissions.deny ?? []).not.toContain("Bash(git push*)");
    expect(settings.permissions.deny ?? []).not.toContain("Bash(git commit*)");
    expect(settings.permissions.deny ?? []).not.toContain("Bash(gh pr *)");
    expect(settings.enabledMcpjsonServers).toEqual(["existing", "exa", "context7"]);

    const mcpConfig = JSON.parse(written["/project/.mcp.json"]!);
    expect(Object.keys(mcpConfig.mcpServers).filter((id) => id === "exa")).toHaveLength(1);
    expect(Object.keys(mcpConfig.mcpServers).filter((id) => id === "context7")).toHaveLength(1);
  });

  it("deliverStartup recovers from array-valued settings.local.json and .mcp.json", async () => {
    // Seed both files with JSON arrays (invalid for object merge)
    written["/project/.claude/settings.local.json"] = "[]";
    written["/project/.mcp.json"] = "[]";

    const adapter = new ClaudeCodeAdapter({
      tmux: mockTmux(),
      fsOps: mockFsOps(),
      stateDir: tmpDir,
      collectorAssetPath: "/fake/collector.js",
    });

    await adapter.deliverStartup([], { cwd: "/project", tmuxSession: "dev-impl@test", nodeId: "n1" } as any);

    // Settings must be a proper object with permissions, not a bare array
    const settings = JSON.parse(written["/project/.claude/settings.local.json"]!);
    expect(settings.permissions.defaultMode).toBe("acceptEdits");
    expect(settings.permissions.allow).toContain("Bash(rig:*)");

    // MCP config must be a proper object with mcpServers, not a bare array
    const mcpConfig = JSON.parse(written["/project/.mcp.json"]!);
    expect(mcpConfig.mcpServers.exa.url).toBe("https://mcp.exa.ai/mcp");
    expect(mcpConfig.mcpServers.context7.url).toBe("https://mcp.context7.com/mcp");
  });

  it("deliverStartup overrides existing restrictive defaultMode with acceptEdits for managed sessions", async () => {
    // Seed a restrictive existing defaultMode that would block managed-session autonomy
    written["/project/.claude/settings.local.json"] = JSON.stringify({
      permissions: {
        defaultMode: "denyAll",
        allow: ["Read"],
      },
    });

    const adapter = new ClaudeCodeAdapter({
      tmux: mockTmux(),
      fsOps: mockFsOps(),
      stateDir: tmpDir,
      collectorAssetPath: "/fake/collector.js",
    });

    await adapter.deliverStartup([], { cwd: "/project", tmuxSession: "dev-impl@test", nodeId: "n1" } as any);

    const settings = JSON.parse(written["/project/.claude/settings.local.json"]!);
    // Must unconditionally force acceptEdits — not inherit the restrictive mode
    expect(settings.permissions.defaultMode).toBe("acceptEdits");
    // Existing allow rules should be merged, not replaced
    expect(settings.permissions.allow).toContain("Read");
    expect(settings.permissions.allow).toContain("Bash(rig:*)");
  });

  it("deliverStartup pre-seeds Claude workspace trust for the managed project", async () => {
    const adapter = new ClaudeCodeAdapter({
      tmux: mockTmux(),
      fsOps: mockFsOps(),
      stateDir: tmpDir,
      collectorAssetPath: "/fake/collector.js",
    });

    await adapter.deliverStartup([], { cwd: "/project", tmuxSession: "dev-impl@test", nodeId: "n1" } as any);

    const statePath = "/home/tester/.claude.json";
    expect(written[statePath]).toBeDefined();
    const state = JSON.parse(written[statePath]!);
    expect(state.projects["/project"].hasTrustDialogAccepted).toBe(true);
  });

  it("deliverStartup marks Claude onboarding complete for fresh managed sessions", async () => {
    const adapter = new ClaudeCodeAdapter({
      tmux: mockTmux(),
      fsOps: mockFsOps(),
      stateDir: tmpDir,
      collectorAssetPath: "/fake/collector.js",
    });

    await adapter.deliverStartup([], { cwd: "/project", tmuxSession: "dev-impl@test", nodeId: "n1" } as any);

    const statePath = "/home/tester/.claude.json";
    expect(written[statePath]).toBeDefined();
    const state = JSON.parse(written[statePath]!);
    expect(state.hasCompletedOnboarding).toBe(true);
  });
});
