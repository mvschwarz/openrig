import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync, copyFileSync, chmodSync, statSync, readdirSync, utimesSync, lstatSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { contextCollectorPath } from "../src/domain/telemetry-state-paths.js";
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

  it("keeps simultaneous collectors for one seat from colliding on the temporary sidecar", async () => {
    const contextDir = join(tmpDir, "context");
    const providerUsageDir = join(tmpDir, "provider-usage");
    const barrierDir = join(tmpDir, "barrier");
    const hookPath = join(tmpDir, "rename-barrier.cjs");
    mkdirSync(barrierDir, { recursive: true });
    writeFileSync(hookPath, `
      const fs = require("node:fs");
      const path = require("node:path");
      const barrierDir = process.env.OPENRIG_COLLECTOR_BARRIER;
      const renameSync = fs.renameSync;
      let waited = false;
      fs.renameSync = function (from, to, ...args) {
        if (!waited && barrierDir && path.basename(path.dirname(to)) === "context" && String(from).includes(".tmp")) {
          waited = true;
          fs.writeFileSync(path.join(barrierDir, process.pid + ".ready"), "ready");
          const gate = new Int32Array(new SharedArrayBuffer(4));
          const deadline = Date.now() + 10000;
          while (fs.readdirSync(barrierDir).filter((name) => name.endsWith(".ready")).length < 2 && Date.now() < deadline) {
            Atomics.wait(gate, 0, 0, 2);
          }
          if (fs.readdirSync(barrierDir).filter((name) => name.endsWith(".ready")).length < 2) throw new Error("barrier timed out");
        }
        return renameSync.call(fs, from, to, ...args);
      };
    `);

    const run = (usedPercentage: number) => new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--require", hookPath, collectorPath, contextDir, providerUsageDir], {
        env: {
          ...process.env,
          OPENRIG_COLLECTOR_BARRIER: barrierDir,
        },
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stderr }));
      const input = JSON.parse(VALID_STATUS_LINE);
      input.context_window.used_percentage = usedPercentage;
      input.rate_limits.five_hour.used_percentage = usedPercentage;
      child.stdin.end(JSON.stringify(input));
    });

    const results = await Promise.all([run(42), run(47)]);
    expect(results.map((result) => result.status)).toEqual([0, 0]);
    expect(readdirSync(barrierDir).filter((name) => name.endsWith(".ready"))).toHaveLength(2);
    expect(results.map((result) => result.stderr)).toEqual(["", ""]);
    const providerUsagePath = join(providerUsageDir, "dev-impl@test.json");
    expect(existsSync(providerUsagePath)).toBe(true);
    expect(JSON.parse(readFileSync(providerUsagePath, "utf-8")).seatSession).toBe("dev-impl@test");
  });

  // T1: Parses valid status line and writes sidecar
  it("parses valid Claude status line JSON and writes sidecar file", () => {
    const outputPath = join(tmpDir, "context", "test.json");
    execFileSync(process.execPath, [collectorPath, outputPath], { input: VALID_STATUS_LINE, encoding: "utf-8" });

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
    execFileSync(process.execPath, [collectorPath, outputPath], { input: VALID_STATUS_LINE, encoding: "utf-8" });

    expect(existsSync(outputPath)).toBe(true);
    expect(existsSync(outputPath + ".tmp")).toBe(false);
  });

  it("cleans up its staged file when rename fails on repeated refreshes", () => {
    const outputPath = join(tmpDir, "context", "blocked.json");
    mkdirSync(outputPath, { recursive: true });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = spawnSync("node", [collectorPath, outputPath], {
        encoding: "utf-8",
        input: VALID_STATUS_LINE,
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("failed to collect Claude context status line");
      expect(readdirSync(join(tmpDir, "context")).filter((name) => name.startsWith("blocked.json.tmp-"))).toEqual([]);
    }
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
    execFileSync(process.execPath, [collectorPath, outputDir], { input: VALID_STATUS_LINE, encoding: "utf-8" });

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
    execFileSync(process.execPath, [collectorPath], { input: VALID_STATUS_LINE, encoding: "utf-8" });
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
      readFile: (p: string) => written[p] ?? (["/fake/collector.js", "/daemon/assets/collector.js"].includes(p) ? `copied:${p}` : (() => { throw new Error("ENOENT"); })()),
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
      expect(statusLine.command).toBe(`exec ${shellQuote(process.execPath)} ${shellQuote(contextCollectorPath(tmpDir))} ${shellQuote(join(tmpDir, "state", "context-usage"))} ${shellQuote(join(tmpDir, "state", "provider-usage"))}`);
      expect(statusLine.padding).toBe(2);
    });

    it("refreshes the three-token collector command OpenRig wrote before provider usage", async () => {
      written[settingsPath] = JSON.stringify({ statusLine: { type: "command", command: "node /project/.openrig/context-collector.cjs /old/state/context" } });
      await deliver();
      expect(JSON.parse(written[settingsPath]!).statusLine.command).toBe(`exec ${shellQuote(process.execPath)} ${shellQuote(contextCollectorPath(tmpDir))} ${shellQuote(join(tmpDir, "state", "context-usage"))} ${shellQuote(join(tmpDir, "state", "provider-usage"))}`);
    });

    it("installs the collector into a status line that has no command", async () => {
      written[settingsPath] = JSON.stringify({ statusLine: { padding: 3 } });
      await deliver();
      const statusLine = JSON.parse(written[settingsPath]!).statusLine;
      expect(statusLine).toMatchObject({ type: "command", padding: 3 });
      expect(statusLine.command).toContain(contextCollectorPath(tmpDir));
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
      "echo /instance/state/claude-context-collector/context-collector.cjs /ctx /prov",
      "node /instance/state/claude-context-collector/context-collector.cjs /ctx /prov extra",
    ])("keeps a user command that only contains the collector path: %j", async (command) => {
      const original = JSON.stringify({ statusLine: { type: "command", command, padding: 1 } }, null, 2);
      written[settingsPath] = original;
      await deliver();
      expect(written[settingsPath]).toBe(original);
    });

    it.each(["", "  \n"])("installs the collector into an empty settings file (%j)", async (text) => {
      written[settingsPath] = text;
      await deliver();
      expect(written[settingsPath]).toContain(contextCollectorPath(tmpDir));
      expect(JSON.parse(written[settingsPath]!).statusLine).toEqual({
        type: "command",
        command: `exec ${shellQuote(process.execPath)} ${shellQuote(contextCollectorPath(tmpDir))} ${shellQuote(join(tmpDir, "state", "context-usage"))} ${shellQuote(join(tmpDir, "state", "provider-usage"))}`,
      });
    });
  });

  // T5: deliverStartup copies collector script to instance state
  it("deliverStartup copies collector script to instance state", async () => {
    const adapter = new ClaudeCodeAdapter({
      tmux: mockTmux(),
      fsOps: mockFsOps(),
      stateDir: tmpDir,
      collectorAssetPath: "/daemon/assets/collector.js",
    });

    await adapter.deliverStartup([], { cwd: "/project", tmuxSession: "test", nodeId: "n1" } as any);

    const collectorDest = contextCollectorPath(tmpDir);
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
    expect(written[contextCollectorPath(tmpDir)]).toBeUndefined();
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
    expect(written[contextCollectorPath(tmpDir)]).toBe("copied:/fake/collector.js");
    expect(dirsMade).not.toContain("/project/.openrig");
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


describe("instance-owned collector provisioning", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "openrig-instance-collector-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function fixture() {
    const cwd = join(root, "seat");
    const stateDir = join(root, "instance");
    const asset = join(root, "shipped.cjs");
    mkdirSync(cwd);
    copyFileSync(join(import.meta.dirname, "../assets/claude-statusline-context.cjs"), asset);
    const fsOps = {
      readFile: (p: string) => readFileSync(p, "utf8"),
      writeFile: vi.fn((p: string, text: string) => writeFileSync(p, text)),
      exists: existsSync,
      mkdirp: vi.fn((p: string) => { mkdirSync(p, { recursive: true }); }),
      copyFile: vi.fn((src: string, dest: string) => copyFileSync(src, dest)),
    };
    const adapter = new ClaudeCodeAdapter({ tmux: {} as TmuxAdapter, stateDir, collectorAssetPath: asset, fsOps });
    const dest = contextCollectorPath(stateDir);
    const settings = join(cwd, ".claude", "settings.local.json");
    return { cwd, stateDir, asset, fsOps, adapter, dest, settings };
  }

  it("copies the shipped bytes into instance state and repeated polls write nothing", () => {
    const f = fixture();
    f.adapter.ensureContextCollector({ cwd: f.cwd });
    expect(existsSync(join(f.cwd, ".openrig", "context-collector.cjs"))).toBe(false);
    expect(existsSync(join(f.cwd, ".openrig"))).toBe(false);
    expect(readFileSync(f.dest)).toEqual(readFileSync(f.asset));
    expect(JSON.parse(readFileSync(f.settings, "utf8")).statusLine.command).toBe(
      `exec ${shellQuote(process.execPath)} ${shellQuote(f.dest)} ${shellQuote(join(f.stateDir, "state", "context-usage"))} ${shellQuote(join(f.stateDir, "state", "provider-usage"))}`,
    );
    expect(f.fsOps.copyFile).toHaveBeenCalledWith(f.asset, f.dest, { atomicOnly: true });

    const paths = [f.dest, f.settings, join(f.stateDir, "state", "claude-context-collector")];
    const past = new Date("2026-01-01T00:00:00Z");
    for (const p of paths) utimesSync(p, past, past);
    const before = paths.map(p => ({ mtime: statSync(p).mtimeMs, inode: statSync(p).ino }));
    const content = [readFileSync(f.dest), readFileSync(f.settings)];
    f.fsOps.copyFile.mockClear();
    f.fsOps.writeFile.mockClear();
    f.adapter.ensureContextCollector({ cwd: f.cwd });
    expect(f.fsOps.copyFile).not.toHaveBeenCalled();
    expect(f.fsOps.writeFile).not.toHaveBeenCalled();
    expect(paths.map(p => ({ mtime: statSync(p).mtimeMs, inode: statSync(p).ino }))).toEqual(before);
    expect([readFileSync(f.dest), readFileSync(f.settings)]).toEqual(content);
  });

  it("shares one instance copy across seats, and compares content even when mtimes match", () => {
    const f = fixture();
    f.adapter.ensureContextCollector({ cwd: f.cwd });
    const otherCwd = join(root, "other-seat");
    mkdirSync(otherCwd);
    f.adapter.ensureContextCollector({ cwd: otherCwd });
    expect(f.fsOps.copyFile).toHaveBeenCalledTimes(1);
    expect(existsSync(join(otherCwd, ".openrig"))).toBe(false);
    expect(JSON.parse(readFileSync(join(otherCwd, ".claude", "settings.local.json"), "utf8")).statusLine.command)
      .toContain(shellQuote(f.dest));

    writeFileSync(f.asset, "// updated collector\n");
    const past = new Date("2026-01-01T00:00:00Z");
    for (const p of [f.asset, f.dest]) utimesSync(p, past, past);
    f.adapter.ensureContextCollector({ cwd: f.cwd });
    expect(f.fsOps.copyFile).toHaveBeenCalledTimes(2);
    expect(readFileSync(f.dest)).toEqual(readFileSync(f.asset));
    expect(f.fsOps.writeFile).toHaveBeenCalledTimes(2); // One settings install per seat.
  });

  it.each([false, true])("migrates a legacy cwd command and removes older collector bytes (provider argument=%s)", (provider) => {
    const f = fixture();
    const legacy = join(f.cwd, ".openrig", "context-collector.cjs");
    mkdirSync(join(f.cwd, ".claude"));
    mkdirSync(join(f.cwd, ".openrig"));
    writeFileSync(legacy, "// older collector\n");
    expect(readFileSync(legacy)).not.toEqual(readFileSync(f.asset));
    writeFileSync(f.settings, JSON.stringify({
      statusLine: { type: "command", command: `node ${legacy} /old/context${provider ? " /old/provider" : ""}`, padding: 2 },
      permissions: { allow: ["Read"] },
    }));
    f.adapter.ensureContextCollector({ cwd: f.cwd });
    const settings = JSON.parse(readFileSync(f.settings, "utf8"));
    expect(settings.statusLine.command).toContain(shellQuote(f.dest));
    expect(settings.statusLine.command).not.toContain(legacy);
    expect(settings.statusLine.padding).toBe(2);
    expect(settings.permissions).toEqual({ allow: ["Read"] });
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(join(f.cwd, ".openrig"))).toBe(false);
  });

  it("keeps a person's wrapper settings and legacy file untouched", () => {
    const f = fixture();
    const legacy = join(f.cwd, ".openrig", "context-collector.cjs");
    mkdirSync(dirname(legacy));
    writeFileSync(legacy, "// wrapper's collector\n");
    mkdirSync(dirname(f.settings));
    const text = JSON.stringify({ statusLine: { type: "command", command: `sh './my-wrapper.sh' ${shellQuote(legacy)}` } });
    writeFileSync(f.settings, text);

    f.adapter.ensureContextCollector({ cwd: f.cwd });

    expect(readFileSync(f.settings, "utf8")).toBe(text);
    expect(f.fsOps.writeFile).not.toHaveBeenCalled();
    expect(readFileSync(legacy, "utf8")).toBe("// wrapper's collector\n");
  });

  it.each(["a symlink", "another file"])("repoints the legacy command while preserving %s", (kind) => {
    const f = fixture();
    const legacy = join(f.cwd, ".openrig", "context-collector.cjs");
    const other = join(f.cwd, ".openrig", "keep.txt");
    mkdirSync(dirname(legacy));
    writeFileSync(other, "keep me\n");
    if (kind === "a symlink") symlinkSync(other, legacy);
    else writeFileSync(legacy, "// older collector\n");
    mkdirSync(dirname(f.settings));
    writeFileSync(f.settings, JSON.stringify({ statusLine: { type: "command", command: `node ${legacy} /old/context` } }));

    f.adapter.ensureContextCollector({ cwd: f.cwd });

    expect(JSON.parse(readFileSync(f.settings, "utf8")).statusLine.command).toContain(shellQuote(f.dest));
    expect(readFileSync(other, "utf8")).toBe("keep me\n");
    expect(existsSync(dirname(legacy))).toBe(true);
    if (kind === "a symlink") expect(lstatSync(legacy).isSymbolicLink()).toBe(true);
    else expect(existsSync(legacy)).toBe(false);
  });

  it("keeps the legacy file when the settings repoint cannot be written", () => {
    const f = fixture();
    const legacy = join(f.cwd, ".openrig", "context-collector.cjs");
    mkdirSync(dirname(legacy));
    writeFileSync(legacy, "// older collector\n");
    mkdirSync(dirname(f.settings));
    const text = JSON.stringify({ statusLine: { type: "command", command: `node ${legacy} /old/context` } });
    writeFileSync(f.settings, text);
    f.fsOps.writeFile.mockImplementationOnce(() => { throw new Error("settings write failed"); });

    expect(() => f.adapter.ensureContextCollector({ cwd: f.cwd })).toThrow("settings write failed");
    expect(readFileSync(f.settings, "utf8")).toBe(text);
    expect(readFileSync(legacy, "utf8")).toBe("// older collector\n");
  });

  it("replaces an unreadable instance copy, and provisions nothing when the shipped asset cannot be read", () => {
    const f = fixture();
    f.adapter.ensureContextCollector({ cwd: f.cwd });
    // The instance copy turns unreadable: the next poll replaces it instead of failing.
    const unreadable = {
      ...f.fsOps,
      readFile: (p: string) => { if (p === f.dest) throw new Error("EACCES"); return readFileSync(p, "utf8"); },
      copyFile: vi.fn((src: string, dest: string) => copyFileSync(src, dest)),
    };
    const retry = new ClaudeCodeAdapter({ tmux: {} as TmuxAdapter, stateDir: f.stateDir, collectorAssetPath: f.asset, fsOps: unreadable });
    expect(() => retry.ensureContextCollector({ cwd: f.cwd })).not.toThrow();
    expect(unreadable.copyFile).toHaveBeenCalledWith(f.asset, f.dest, { atomicOnly: true });
    expect(readFileSync(f.dest)).toEqual(readFileSync(f.asset));

    // The shipped asset itself is gone: the poll provisions nothing and still does not throw.
    const noAsset = {
      ...f.fsOps,
      readFile: (p: string) => { if (p === f.asset) throw new Error("ENOENT"); return readFileSync(p, "utf8"); },
      copyFile: vi.fn((src: string, dest: string) => copyFileSync(src, dest)),
      writeFile: vi.fn((p: string, text: string) => writeFileSync(p, text)),
    };
    const broken = new ClaudeCodeAdapter({ tmux: {} as TmuxAdapter, stateDir: f.stateDir, collectorAssetPath: f.asset, fsOps: noAsset });
    expect(() => broken.ensureContextCollector({ cwd: f.cwd })).not.toThrow();
    expect(noAsset.copyFile).not.toHaveBeenCalled();
    expect(noAsset.writeFile).not.toHaveBeenCalled();
  });

  it("a copy that cannot be staged leaves the existing copy and the poll alone", () => {
    const f = fixture();
    f.adapter.ensureContextCollector({ cwd: f.cwd });
    const failing = {
      ...f.fsOps,
      copyFile: vi.fn(() => { throw new Error("staging failed"); }),
    };
    const retry = new ClaudeCodeAdapter({ tmux: {} as TmuxAdapter, stateDir: f.stateDir, collectorAssetPath: f.asset, fsOps: failing });
    writeFileSync(f.asset, "// updated collector\n");
    expect(() => retry.ensureContextCollector({ cwd: f.cwd })).not.toThrow();
    expect(failing.copyFile).toHaveBeenCalledWith(f.asset, f.dest, { atomicOnly: true });
    expect(readFileSync(f.dest)).not.toBe("// updated collector\n");
  });

  it("does nothing when the seat folder is missing", () => {
    const f = fixture();
    const adapter = new ClaudeCodeAdapter({ tmux: {} as TmuxAdapter, stateDir: f.stateDir, collectorAssetPath: f.asset,
      fsOps: { ...f.fsOps, folderPresent: () => false } });
    adapter.ensureContextCollector({ cwd: join(root, "missing-seat") });
    expect(f.fsOps.copyFile).not.toHaveBeenCalled();
    expect(f.fsOps.writeFile).not.toHaveBeenCalled();
    expect(f.fsOps.mkdirp).not.toHaveBeenCalled();
    expect(existsSync(f.stateDir)).toBe(false);
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
        exists: existsSync, mkdirp: (p) => { mkdirSync(p, { recursive: true }); }, copyFile: (src: string, dest: string) => copyFileSync(src, dest),
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

  it("skips an identical read-only copy, but plain copyFileSync cannot overwrite it after an asset change", () => {
    if (process.getuid?.() === 0) return; // root ignores file modes
    const asset = join(root, "asset.cjs");
    writeFileSync(asset, "// v1\n");
    chmodSync(asset, 0o444);
    const cwd = join(root, "seat");
    const adapter = adapterFor(asset, (src, dest) => copyFileSync(src, dest));
    adapter.ensureContextCollector({ cwd });
    expect(() => adapter.ensureContextCollector({ cwd })).not.toThrow();
    chmodSync(asset, 0o644);
    writeFileSync(asset, "// v2\n");
    expect(() => adapter.ensureContextCollector({ cwd })).toThrow(/EACCES/);
  });

  it.skipIf(process.getuid?.() === 0)("updates a writable collector in a readonly directory", () => {
    const asset = join(root, "asset.cjs");
    writeFileSync(asset, "// v1\n"); chmodSync(asset, 0o644);
    const cwd = join(root, "seat");
    const parent = dirname(contextCollectorPath(join(root, "state")));
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

  it("replaceFile re-seats the instance collector only after the asset changes", () => {
    const asset = join(root, "asset.cjs");
    writeFileSync(asset, "// v1\n");
    chmodSync(asset, 0o444);
    const cwd = join(root, "seat");
    const dest = contextCollectorPath(join(root, "state"));
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
    expect(readdirSync(dirname(dest)).filter((f) => f.includes(".tmp"))).toEqual([]);
  });
});
