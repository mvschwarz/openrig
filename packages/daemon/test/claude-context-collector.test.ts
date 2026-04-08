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
  it("no provisioning when stateDir or collectorAssetPath is missing", async () => {
    const adapter = new ClaudeCodeAdapter({
      tmux: mockTmux(),
      fsOps: mockFsOps(),
      // no stateDir, no collectorAssetPath
    });

    await adapter.deliverStartup([], { cwd: "/project", tmuxSession: "test", nodeId: "n1" } as any);

    // No settings.local.json written
    expect(written["/project/.claude/settings.local.json"]).toBeUndefined();
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
});
