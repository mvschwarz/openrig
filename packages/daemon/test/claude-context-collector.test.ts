import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync, copyFileSync, chmodSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { replaceFile } from "../src/adapters/replace-file.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";
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
  rate_limits: {
    five_hour: { used_percentage: 42, resets_at: "2026-08-04T15:00:00.000Z" },
    seven_day: { used_percentage: 7, resets_at: "2026-08-10T00:00:00.000Z" },
  },
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

  it("stamps the managed occupant generation inherited by the collector process", () => {
    const outputPath = join(tmpDir, "context", "generation.json");
    const result = spawnSync("node", [collectorPath, outputPath], {
      encoding: "utf-8",
      input: VALID_STATUS_LINE,
      env: { ...process.env, OPENRIG_OCCUPANT_GENERATION: "generation-current" },
    });

    expect(result.status).toBe(0);
    const content = JSON.parse(readFileSync(outputPath, "utf-8"));
    expect(content.occupant_generation).toBe("generation-current");
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

  it("writes a seat-keyed subscription provider_usage cache atomically from rate_limits", () => {
    const contextDir = join(tmpDir, "context");
    const usageDir = join(tmpDir, "provider-usage");
    const result = spawnSync("node", [collectorPath, contextDir, usageDir], {
      encoding: "utf-8",
      input: VALID_STATUS_LINE,
    });

    expect(result.status).toBe(0);
    const cachePath = join(usageDir, "dev-impl@test.json");
    expect(existsSync(cachePath)).toBe(true);
    expect(existsSync(cachePath + ".tmp")).toBe(false);
    const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(cache).toMatchObject({
      seatSession: "dev-impl@test",
      accountKind: "subscription",
      rateLimits: {
        five_hour: { usedPercent: 42, resetsAt: "2026-08-04T15:00:00.000Z" },
        seven_day: { usedPercent: 7, resetsAt: "2026-08-10T00:00:00.000Z" },
      },
    });
    expect(cache.accountRef).toBeUndefined();
  });

  it("converts Claude Unix-second reset times to ISO strings", () => {
    const contextDir = join(tmpDir, "context");
    const usageDir = join(tmpDir, "provider-usage");
    const statusLine = JSON.parse(VALID_STATUS_LINE);
    statusLine.rate_limits.five_hour.resets_at = 1_770_000_000;
    statusLine.rate_limits.seven_day.resets_at = 1_770_086_400;
    const result = spawnSync("node", [collectorPath, contextDir, usageDir], {
      encoding: "utf-8",
      input: JSON.stringify(statusLine),
    });

    expect(result.status).toBe(0);
    const cache = JSON.parse(readFileSync(join(usageDir, "dev-impl@test.json"), "utf-8"));
    expect(cache.rateLimits).toEqual({
      five_hour: { usedPercent: 42, resetsAt: new Date(1_770_000_000_000).toISOString() },
      seven_day: { usedPercent: 7, resetsAt: new Date(1_770_086_400_000).toISOString() },
    });
  });

  it("omits rate-limit windows with out-of-range numeric reset times", () => {
    const contextDir = join(tmpDir, "context");
    const usageDir = join(tmpDir, "provider-usage");
    const statusLine = JSON.parse(VALID_STATUS_LINE);
    statusLine.rate_limits.five_hour.resets_at = Number.MAX_VALUE;
    const result = spawnSync("node", [collectorPath, contextDir, usageDir], {
      encoding: "utf-8",
      input: JSON.stringify(statusLine),
    });

    expect(result.status).toBe(0);
    const cache = JSON.parse(readFileSync(join(usageDir, "dev-impl@test.json"), "utf-8"));
    expect(cache.rateLimits.five_hour).toBeUndefined();
    expect(cache.rateLimits.seven_day.resetsAt).toBe("2026-08-10T00:00:00.000Z");
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

  /** Provide filesystem operations for collector fixtures. */
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

  /** Supply a terminal adapter without starting a real session. */
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
    expect(settings.statusLine.command).toContain(join(tmpDir, "state", "context-usage"));
    expect(settings.statusLine.command).toContain(join(tmpDir, "state", "provider-usage"));
    expect(dirsMade).toContain(join(tmpDir, "state", "context-usage"));
    expect(dirsMade).toContain(join(tmpDir, "state", "provider-usage"));
  });

  // #421: the seat cwd can be a shared repo whose project-local settings other sessions read.
  describe("project-local settings preservation (#421)", () => {
    const settingsPath = "/project/.claude/settings.local.json";
    const deliver = async () => {
      const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: mockFsOps(), stateDir: tmpDir, collectorAssetPath: "/fake/collector.js" });
      await adapter.deliverStartup([], { cwd: "/project", tmuxSession: "dev-impl@test", nodeId: "n1" } as any);
    };

    it("keeps a user's own status line command and the rest of the file", async () => {
      written[settingsPath] = JSON.stringify({ statusLine: { type: "command", command: "~/bin/my-status.sh", padding: 1 }, permissions: { allow: ["Bash(ls:*)"] } }, null, 2);
      await deliver();
      const settings = JSON.parse(written[settingsPath]!);
      expect(settings.statusLine).toEqual({ type: "command", command: "~/bin/my-status.sh", padding: 1 });
      expect(settings.permissions).toEqual({ allow: ["Bash(ls:*)"] });
    });

    it("refreshes a stale OpenRig collector command and keeps other status line keys", async () => {
      written[settingsPath] = JSON.stringify({ statusLine: { type: "command", command: "node /old/.openrig/context-collector.cjs /old/ctx /old/prov", padding: 2 } });
      await deliver();
      const statusLine = JSON.parse(written[settingsPath]!).statusLine;
      expect(statusLine.command).toBe(`${shellQuote(process.execPath)} ${shellQuote("/project/.openrig/context-collector.cjs")} ${shellQuote(join(tmpDir, "state", "context-usage"))} ${shellQuote(join(tmpDir, "state", "provider-usage"))}`);
      expect(statusLine.padding).toBe(2);
    });

    it("refreshes the three-token collector command OpenRig wrote before provider usage", async () => {
      written[settingsPath] = JSON.stringify({ statusLine: { type: "command", command: "node /project/.openrig/context-collector.cjs /old/state/context" } });
      await deliver();
      expect(JSON.parse(written[settingsPath]!).statusLine.command).toBe(`${shellQuote(process.execPath)} ${shellQuote("/project/.openrig/context-collector.cjs")} ${shellQuote(join(tmpDir, "state", "context-usage"))} ${shellQuote(join(tmpDir, "state", "provider-usage"))}`);
    });

    it("installs the collector into a status line that has no command", async () => {
      written[settingsPath] = JSON.stringify({ statusLine: { padding: 3 } });
      await deliver();
      const statusLine = JSON.parse(written[settingsPath]!).statusLine;
      expect(statusLine).toMatchObject({ type: "command", padding: 3 });
      expect(statusLine.command).toContain("/project/.openrig/context-collector.cjs");
    });

    it("leaves a settings file it cannot parse byte-for-byte untouched", async () => {
      const unparseable = '{ "permissions": { "allow": ["Bash(ls:*)"] }, ';
      written[settingsPath] = unparseable;
      await deliver();
      expect(written[settingsPath]).toBe(unparseable);
    });

    // Only the exact command OpenRig writes is ours; a command that merely contains the path is the user's.
    it.each([
      "node /old/.openrig/context-collector.cjs /old/ctx /old/prov; ~/bin/my-status.sh",
      "node /old/.openrig/context-collector.cjs /old/ctx /old/prov && ~/bin/my-status.sh",
      "node /old/.openrig/context-collector.cjs /old/ctx /old/prov;~/bin/my-status.sh",
      "node /old/.openrig/context-collector.cjs\n~/bin/my-status.sh",
      "node /old/.openrig/context-collector.cjs /old/ctx /old/prov\r\n~/bin/my-status.sh",
      "node /old/.openrig/context-collector.cjs /old/ctx\n~/bin/my-status.sh",
      "node /old/.openrig/context-collector.cjs /old/ctx\r\n~/bin/my-status.sh",
      "node /tools/.openrig/context-collector.cjs.backup",
      `${shellQuote(process.execPath)} '/old/.openrig/context-collector.cjs' '/old/ctx' '/old/prov' 'extra'`,
      "'/custom/wrapper' '/old/.openrig/context-collector.cjs' '/old/ctx' '/old/prov'",
    ])("keeps a user command that only contains the collector path: %j", async (command) => {
      const original = JSON.stringify({ statusLine: { type: "command", command, padding: 1 } }, null, 2);
      written[settingsPath] = original;
      await deliver();
      expect(written[settingsPath]).toBe(original);
    });

    it.each(["", "  \n"])("installs the collector into an empty settings file (%j)", async (text) => {
      written[settingsPath] = text;
      await deliver();
      expect(written[settingsPath]).toContain("/project/.openrig/context-collector.cjs");
      expect(JSON.parse(written[settingsPath]!).statusLine).toEqual({
        type: "command",
        command: `${shellQuote(process.execPath)} ${shellQuote("/project/.openrig/context-collector.cjs")} ${shellQuote(join(tmpDir, "state", "context-usage"))} ${shellQuote(join(tmpDir, "state", "provider-usage"))}`,
      });
    });
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
    expect(settings.statusLine.command).toContain(join(tmpDir, "state", "context-usage"));
    expect(settings.statusLine.command).toContain(join(tmpDir, "state", "provider-usage"));
    expect(written["/project/.openrig/context-collector.cjs"]).toBe("copied:/fake/collector.js");
  });

  // OPR.0.4.8.2 AGNOSTIC PERMISSION RIP-OUT, ADOPTED for the 0.5.0 fold by PM ruling 2026-08-05
  // (fold-wave qitem 79159e6f): the user-scope `Bash(rig:*)` permission write (provisionRigPermissions
  // / CONVENIENCE_BASELINE, assessment row C2) is RIPPED OUT — deliverStartup NEVER touches
  // ~/.claude/settings.json permissions; policy lives only in the sanctioned permission_policy surface.
  // This INVERTS the prior 0.5.0 "provisions user-scope permissions" pin (contradictory content the
  // ruling resolved in favor of the rip-out). Cites: PM ruling 2026-08-05; rip-out commit 1c4e2db1
  // ("the new code simply never touches settings.json"); missions/release-0.4.8/slices/
  // 02-agnostic-permission-rip-out (PERMISSION-POLICY-RESTEER).
  it("deliverStartup does NOT write user-scope Claude settings.json permissions (OPR.0.4.8.2 rip-out C2)", async () => {
    const adapter = new ClaudeCodeAdapter({
      tmux: mockTmux(),
      fsOps: mockFsOps(),
      stateDir: tmpDir,
      collectorAssetPath: "/fake/collector.js",
    });

    await adapter.deliverStartup([], { cwd: "/project", tmuxSession: "dev-impl@test", nodeId: "n1" } as any);

    // The rip-out guarantee: no user-scope settings.json is written (permission injection is gone).
    const settingsPath = "/home/tester/.claude/settings.json";
    expect(written[settingsPath]).toBeUndefined();
  });

  it("deliverStartup does not inject project-scope Claude permissions or MCP config without runtime resources", async () => {
    written["/project/.claude/settings.local.json"] = JSON.stringify({
      customSetting: true,
      permissions: {
        allow: ["Bash(npm *)"],
        ask: ["Bash(existing-ask:*)"],
        deny: ["Bash(custom-danger:*)"],
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
    expect(settings.enabledMcpjsonServers).toBeUndefined();
    expect(settings.permissions.allow).toEqual(["Bash(npm *)"]);
    expect(settings.permissions.ask).toEqual(["Bash(existing-ask:*)"]);
    expect(settings.permissions.deny).toEqual(["Bash(custom-danger:*)"]);

    const mcpConfig = JSON.parse(written["/project/.mcp.json"]!);
    expect(mcpConfig.mcpServers.existing.url).toBe("https://example.com/mcp");
    expect(mcpConfig.mcpServers.exa).toBeUndefined();
    expect(mcpConfig.mcpServers.context7).toBeUndefined();
  });

  it("deliverStartup keeps context collector idempotent without adding permission or MCP rules", async () => {
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
    expect(settings.statusLine.type).toBe("command");
    expect(settings.permissions).toBeUndefined();
    expect(settings.enabledMcpjsonServers).toBeUndefined();

    const mcpConfig = JSON.parse(written["/project/.mcp.json"]!);
    expect(Object.keys(mcpConfig.mcpServers)).toEqual(["existing"]);
  });

  it("deliverStartup leaves an array-valued settings.local.json (and .mcp.json) as they are", async () => {
    written["/project/.claude/settings.local.json"] = "[]";
    written["/project/.mcp.json"] = "[]";

    const adapter = new ClaudeCodeAdapter({
      tmux: mockTmux(),
      fsOps: mockFsOps(),
      stateDir: tmpDir,
      collectorAssetPath: "/fake/collector.js",
    });

    await adapter.deliverStartup([], { cwd: "/project", tmuxSession: "dev-impl@test", nodeId: "n1" } as any);

    // Valid JSON that isn't an object is the owner's: the status line isn't installed over it.
    expect(written["/project/.claude/settings.local.json"]).toBe("[]");
    expect(written["/project/.mcp.json"]).toBe("[]");
  });

  it("deliverStartup leaves existing project-local permission mode untouched without runtime resources", async () => {
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
    expect(settings.permissions.defaultMode).toBe("denyAll");
    expect(settings.permissions.allow).toEqual(["Read"]);
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


describe("provisioned collector command shell paths", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "openrig-collector-shell-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  /** Provision a collector in the supplied private shell-path fixture. */
  function provision(cwd: string, stateDir: string, command?: string) {
    const settings = join(cwd, ".claude", "settings.local.json");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    if (command !== undefined) writeFileSync(settings, JSON.stringify({ statusLine: { command, padding: 2 }, permissions: { allow: ["Read"] } }));
    const adapter = new ClaudeCodeAdapter({
      tmux: {} as TmuxAdapter, stateDir,
      collectorAssetPath: join(import.meta.dirname, "../assets/claude-statusline-context.cjs"),
      fsOps: {
        readFile: (p) => readFileSync(p, "utf8"), writeFile: (p, text) => writeFileSync(p, text),
        exists: existsSync, mkdirp: (p) => { mkdirSync(p, { recursive: true }); }, copyFile: copyFileSync,
      },
    });
    adapter.ensureContextCollector({ cwd });
    return JSON.parse(readFileSync(settings, "utf8"));
  }
  it.each(["workspace with spaces", "O'Brien workspace"])("runs the real collector through /bin/sh for %s", (name) => {
    const state = join(root, "state " + name);
    const settings = provision(join(root, name), state);
    const result = spawnSync("/bin/sh", ["-c", settings.statusLine.command], {
      input: VALID_STATUS_LINE, encoding: "utf8", env: { ...process.env, OPENRIG_OCCUPANT_GENERATION: "fixture-generation" },
    });
    expect(result.status, result.stderr).toBe(0);
    const context = JSON.parse(readFileSync(join(state, "state", "context-usage", "dev-impl@test.json"), "utf8"));
    const usage = JSON.parse(readFileSync(join(state, "state", "provider-usage", "dev-impl@test.json"), "utf8"));
    expect(context.context_window.used_percentage).toBe(67);
    expect(context.occupant_generation).toBe("fixture-generation");
    expect(usage.rateLimits.five_hour.usedPercent).toBe(42);
  });
  it("refreshes an owned quoted command when the state directory changes", () => {
    const cwd = join(root, "O'Brien project");
    const original = provision(cwd, join(root, "old state")).statusLine.command;
    const settings = provision(cwd, join(root, "new state"), original);
    expect(settings.statusLine.command).not.toBe(original);
    expect(settings.statusLine.command).toContain("new state");
    expect(settings.statusLine.padding).toBe(2);
    expect(settings.permissions).toEqual({ allow: ["Read"] });
  });
  it.each(["; echo mine", " | cat", " && echo mine", " extra", "\n echo mine"])("preserves a composed quoted user command: %s", (suffix) => {
    const cwd = join(root, "quoted project");
    const original = provision(cwd, join(root, "old state")).statusLine.command + suffix;
    expect(provision(cwd, join(root, "new state"), original).statusLine.command).toBe(original);
  });
});

describe("re-seating the collector from a read-only asset", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "openrig-collector-readonly-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  /** Build a collector adapter using private real files and the supplied copy operation. */
  function adapterFor(asset: string, copyFile: (src: string, dest: string) => void) {
    return new ClaudeCodeAdapter({
      tmux: {} as TmuxAdapter, stateDir: join(root, "state"), collectorAssetPath: asset,
      fsOps: {
        readFile: (p) => readFileSync(p, "utf8"), writeFile: (p, text) => writeFileSync(p, text),
        exists: existsSync, mkdirp: (p) => { mkdirSync(p, { recursive: true }); }, copyFile,
      },
    });
  }

  it("plain copyFileSync cannot overwrite the read-only copy it made last time", () => {
    if (process.getuid?.() === 0) return; // root ignores file modes
    const asset = join(root, "asset.cjs");
    writeFileSync(asset, "// v1\n");
    chmodSync(asset, 0o444);
    const cwd = join(root, "seat");
    const adapter = adapterFor(asset, copyFileSync);
    adapter.ensureContextCollector({ cwd });
    expect(() => adapter.ensureContextCollector({ cwd })).toThrow(/EACCES/);
  });

  it.skipIf(process.getuid?.() === 0)("updates a writable collector in a readonly directory", () => {
    const asset = join(root, "asset.cjs");
    writeFileSync(asset, "// v1\n"); chmodSync(asset, 0o644);
    const cwd = join(root, "seat");
    const parent = join(cwd, ".openrig");
    const adapter = adapterFor(asset, replaceFile);
    adapter.ensureContextCollector({ cwd });
    chmodSync(parent, 0o555);
    try {
      writeFileSync(asset, "// v2\n");
      adapter.ensureContextCollector({ cwd });
      adapter.ensureContextCollector({ cwd });
      expect(readFileSync(join(parent, "context-collector.cjs"), "utf8")).toBe("// v2\n");
      expect(statSync(parent).mode & 0o777).toBe(0o555);
      expect(readdirSync(parent).filter(f => f.includes(".tmp"))).toEqual([]);
    } finally { chmodSync(parent, 0o755); }
  });

  it.skipIf(process.getuid?.() === 0)("updates a writable activity relay in a readonly directory", async () => {
    const asset = join(root, "relay.cjs");
    writeFileSync(asset, "// relay v1\n"); chmodSync(asset, 0o755);
    const stateDir = join(root, "relay-state");
    const cwd = join(root, "relay-seat");
    const adapter = new ClaudeCodeAdapter({
      tmux: {} as TmuxAdapter, stateDir, activityRelayPath: asset,
      claudeHooksManifestPath: join(import.meta.dirname, "../assets/plugins/openrig-core/hooks/claude.json"),
      fsOps: { readFile: p => readFileSync(p, "utf8"), writeFile: (p, text) => writeFileSync(p, text),
        exists: existsSync, mkdirp: p => { mkdirSync(p, { recursive: true }); }, copyFile: replaceFile,
        statMode: p => statSync(p).mode, chmod: chmodSync },
    });
    const plan = { runtime: "claude-code", cwd, entries: [{ category: "runtime_resource", resourceType: "claude_activity_hooks",
      effectiveId: "activity", classification: "safe_projection", sourceSpec: "shared", sourcePath: asset,
      resourcePath: "activity", absolutePath: asset }], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] } as ProjectionPlan;
    expect((await adapter.project(plan, { cwd } as NodeBinding)).projected).toContain("activity");
    const parent = join(stateDir, "state/claude-activity-hooks");
    chmodSync(parent, 0o555);
    try {
      writeFileSync(asset, "// relay v2\n");
      expect((await adapter.project(plan, { cwd } as NodeBinding)).projected).toContain("activity");
      expect(readFileSync(join(parent, "activity-relay.cjs"), "utf8")).toBe("// relay v2\n");
      expect(statSync(join(parent, "activity-relay.cjs")).mode & 0o777).toBe(0o755);
      expect(statSync(parent).mode & 0o777).toBe(0o555);
      expect(readdirSync(parent)).toEqual(["activity-relay.cjs"]);
    } finally { chmodSync(parent, 0o755); }
  });

  it("replaceFile re-seats it on every poll, including after the asset changes", () => {
    const asset = join(root, "asset.cjs");
    writeFileSync(asset, "// v1\n");
    chmodSync(asset, 0o444);
    const cwd = join(root, "seat");
    const dest = join(cwd, ".openrig", "context-collector.cjs");
    const adapter = adapterFor(asset, replaceFile);
    adapter.ensureContextCollector({ cwd });
    adapter.ensureContextCollector({ cwd });
    expect(readFileSync(dest, "utf8")).toBe("// v1\n");

    chmodSync(asset, 0o644);
    writeFileSync(asset, "// v2\n");
    chmodSync(asset, 0o444);
    adapter.ensureContextCollector({ cwd });
    expect(readFileSync(dest, "utf8")).toBe("// v2\n");
    expect(statSync(dest).mode & 0o222).toBe(0);
    expect(readdirSync(join(cwd, ".openrig")).filter((f) => f.includes(".tmp"))).toEqual([]);
  });
});
