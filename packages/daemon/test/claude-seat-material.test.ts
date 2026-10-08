import nodeFs from "node:fs";
import nodePath from "node:path";
import { describe, it, expect, vi } from "vitest";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { operationalLaunchArgs } from "../src/adapters/kernel-authority.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding, ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import type { ProjectionEntry, ProjectionPlan } from "../src/domain/projection-planner.js";
import {
  claudeSeatLaunchArgs, claudeSeatMaterialPaths, listClaudeSeatSkillRoots, mergeClaudeSettings,
  type ClaudeSeatMaterialMode,
} from "../src/domain/claude-seat-material.js";

const HOME = "/home/op/.openrig";
const SESSION = "dev-impl@rig";
const CWD = "/repo";
const seat = claudeSeatMaterialPaths(HOME, SESSION);
const RELAY_ASSET = nodePath.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
const HOOKS_MANIFEST = nodePath.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/claude.json");

type StoreFs = ClaudeAdapterFsOps & { _store: Record<string, string> };

function mockFs(files: Record<string, string> = {}): StoreFs {
  const store: Record<string, string> = {
    [RELAY_ASSET]: nodeFs.readFileSync(RELAY_ASSET, "utf-8"),
    [HOOKS_MANIFEST]: nodeFs.readFileSync(HOOKS_MANIFEST, "utf-8"),
    ...files,
  };
  return {
    readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`Not found: ${p}`); },
    writeFile: (p: string, c: string) => { store[p] = c; },
    exists: (p: string) => p in store || Object.keys(store).some((k) => k.startsWith(`${p}/`)),
    mkdirp: () => {},
    copyFile: (src: string, dest: string) => { store[dest] = store[src] ?? `copy of ${src}`; },
    listFiles: (dir: string) => {
      const files = Object.keys(store).filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1));
      if (files.length === 0 && dir in store) throw new Error("ENOTDIR");
      return files;
    },
    _store: store,
  };
}

function mockTmux(): TmuxAdapter {
  return {
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "claude"),
    capturePaneContent: vi.fn(async () => "❯ "),
    getPanePid: vi.fn(async () => null),
    listPanes: vi.fn(async () => []),
  } as unknown as TmuxAdapter;
}

function lastCommand(tmux: TmuxAdapter): string {
  const calls = (tmux.sendText as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return (calls.at(-1)?.[1] as string) ?? "";
}

function binding(overrides: Partial<NodeBinding> = {}): NodeBinding {
  return {
    id: "b1", nodeId: "n1", tmuxSession: SESSION, tmuxWindow: null, tmuxPane: null,
    cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: CWD, ...overrides,
  };
}

function adapter(fs: StoreFs, tmux = mockTmux(), mode: ClaudeSeatMaterialMode = "seat", stateDir = HOME) {
  return new ClaudeCodeAdapter({
    tmux, fsOps: fs, sleep: async () => {}, stateDir,
    collectorAssetPath: "/assets/collector.cjs",
    activityRelayPath: RELAY_ASSET, claudeHooksManifestPath: HOOKS_MANIFEST,
    resolveSeatMaterial: () => mode,
  });
}

function entry(overrides: Partial<ProjectionEntry>): ProjectionEntry {
  return {
    category: "skill", effectiveId: "x", sourceSpec: "base", sourcePath: "/agents/base",
    resourcePath: "x", absolutePath: "/agents/base/x", classification: "safe_projection", ...overrides,
  };
}

const flag = (name: string, value: string) => `'${name}' '${value}'`;

function inCwd(fs: StoreFs): string[] {
  return Object.keys(fs._store).filter((k) => k.startsWith(`${CWD}/`));
}

describe("mergeClaudeSettings", () => {
  it("merges objects by key and appends arrays, so one --settings carries both", () => {
    const merged = mergeClaudeSettings(
      { statusLine: { type: "command", command: "a" }, hooks: { Stop: [{ hooks: [{ command: "relay" }] }] }, permissions: { allow: ["Read"] } },
      { hooks: { Stop: [{ hooks: [{ command: "team" }] }], PreToolUse: [{ matcher: "Bash" }] }, permissions: { allow: ["Read", "Bash(rig:*)"] } },
    );
    expect(merged).toEqual({
      statusLine: { type: "command", command: "a" },
      hooks: { Stop: [{ hooks: [{ command: "relay" }] }, { hooks: [{ command: "team" }] }], PreToolUse: [{ matcher: "Bash" }] },
      permissions: { allow: ["Read", "Bash(rig:*)"] },
    });
  });
});

describe("claudeSeatLaunchArgs", () => {
  it("replaces the operational --settings with one merged file and adds the seat's material", () => {
    const fs = mockFs({
      [seat.settingsPath]: JSON.stringify({ statusLine: { type: "command", command: "collector" } }),
      [seat.guidancePath]: "guidance",
      [seat.mcpPath]: "{}",
    });
    const operational = operationalLaunchArgs("claude-code", { teamPermissionDefault: true });
    const args = claudeSeatLaunchArgs(fs, seat, operational);
    expect(args).toEqual([
      "--settings", seat.launchSettingsPath,
      "--plugin-dir", seat.pluginDir,
      "--mcp-config", seat.mcpPath,
      "--append-system-prompt-file", seat.guidancePath,
    ]);
    const launchSettings = JSON.parse(fs._store[seat.launchSettingsPath]!);
    expect(launchSettings.statusLine.command).toBe("collector");
    expect(launchSettings.permissions.allow.length).toBeGreaterThan(0);
    expect(JSON.parse(fs._store[seat.pluginManifestPath]!).name).toBe("openrig");
  });

  it("omits MCP and guidance flags when the seat has none", () => {
    const args = claudeSeatLaunchArgs(mockFs(), seat, []);
    expect(args).toEqual(["--settings", seat.launchSettingsPath, "--plugin-dir", seat.pluginDir]);
  });

  it("refuses a seat directory with whitespace, which ps-based identity proof would split", () => {
    const spaced = claudeSeatMaterialPaths("/Users/op/Application Support/openrig", SESSION);
    expect(() => claudeSeatLaunchArgs(mockFs(), spaced, [])).toThrow(/whitespace/);
  });
});

describe("ClaudeCodeAdapter with seat_material: seat", () => {
  it("projects skills, subagents, settings, MCP and guidance into the seat directory and nothing into the cwd", async () => {
    const fs = mockFs({
      "/agents/base/skills/review/SKILL.md": "---\nname: review\n---\n",
      "/agents/base/agents/helper.md": "helper",
      "/agents/base/settings.json": JSON.stringify({ env: { A: "1" } }),
      "/agents/base/mcp.json": JSON.stringify({ mcpServers: { s: { type: "http", url: "http://x" } } }),
      "/agents/base/guidance/culture.md": "be plain",
      "/agents/base/plugin/.claude-plugin/plugin.json": "{}",
    });
    const plan: ProjectionPlan = { runtime: "claude-code", cwd: CWD, entries: [
      entry({ category: "skill", effectiveId: "review", absolutePath: "/agents/base/skills/review" }),
      entry({ category: "subagent", effectiveId: "helper", absolutePath: "/agents/base/agents/helper.md" }),
      entry({ category: "runtime_resource", effectiveId: "settings", resourceType: "claude_settings_fragment", absolutePath: "/agents/base/settings.json" }),
      entry({ category: "runtime_resource", effectiveId: "mcp", resourceType: "claude_mcp_fragment", absolutePath: "/agents/base/mcp.json" }),
      entry({ category: "runtime_resource", effectiveId: "activity", resourceType: "claude_activity_hooks", absolutePath: "/agents/base/x" }),
      entry({ category: "guidance", effectiveId: "culture.md", mergeStrategy: "managed_block", absolutePath: "/agents/base/guidance/culture.md" }),
      entry({ category: "plugin", effectiveId: "openrig-core", pluginType: "claude", absolutePath: "/agents/base/plugin" }),
    ] } as ProjectionPlan;

    const result = await adapter(fs).project(plan, binding());

    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual(["openrig-core"]);
    expect(inCwd(fs)).toEqual([]);
    expect(fs._store[nodePath.join(seat.skillsRoot, "review", "SKILL.md")]).toContain("name: review");
    expect(fs._store[nodePath.join(seat.agentsDir, "helper.md")]).toBe("helper");
    expect(fs._store[seat.guidancePath]).toContain("be plain");
    expect(JSON.parse(fs._store[seat.mcpPath]!).mcpServers.s.url).toBe("http://x");
    const settings = JSON.parse(fs._store[seat.settingsPath]!);
    expect(settings.env).toEqual({ A: "1" });
    expect(JSON.stringify(settings.hooks)).toContain("activity-relay.cjs");
    expect(JSON.parse(fs._store[seat.pluginManifestPath]!).name).toBe("openrig");
  });

  it("delivers startup guidance, startup skills and the context collector into the seat directory", async () => {
    const fs = mockFs({
      "/assets/collector.cjs": "collector",
      "/specs/guidance/role.md": "role",
      "/specs/skills/kickoff/SKILL.md": "---\nname: kickoff\n---\n",
    });
    const files: ResolvedStartupFile[] = [
      { path: "guidance/role.md", absolutePath: "/specs/guidance/role.md", ownerRoot: "/specs", deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start"] },
      { path: "skills/kickoff/SKILL.md", absolutePath: "/specs/skills/kickoff/SKILL.md", ownerRoot: "/specs", deliveryHint: "skill_install", required: true, appliesOn: ["fresh_start"] },
    ];
    const result = await adapter(fs).deliverStartup(files, binding());

    expect(result.failed).toEqual([]);
    expect(inCwd(fs)).toEqual([]);
    expect(fs._store[seat.guidancePath]).toContain("role");
    expect(fs._store[nodePath.join(seat.skillsRoot, "kickoff", "SKILL.md")]).toContain("kickoff");
    expect(fs._store[seat.collectorPath]).toBe("collector");
    expect(JSON.parse(fs._store[seat.settingsPath]!).statusLine.command).toContain(seat.collectorPath);
  });

  it("keeps the context monitor's collector refresh out of the cwd when it names the seat only by session", () => {
    const fs = mockFs({ "/assets/collector.cjs": "collector" });
    adapter(fs).ensureContextCollector({ cwd: CWD, tmuxSession: SESSION });
    expect(inCwd(fs)).toEqual([]);
    expect(fs._store[seat.collectorPath]).toBe("collector");
  });

  it.each([
    ["fresh", {}],
    ["resume", { resumeToken: "tok-1" }],
    ["fork", { forkSource: { kind: "native_id" as const, value: "parent-1" } }],
  ])("hands the seat its material on a %s launch", async (_kind, opts) => {
    const fs = mockFs({ [seat.guidancePath]: "guidance", [seat.mcpPath]: "{}" });
    const tmux = mockTmux();
    await adapter(fs, tmux).launchHarness(binding(), { name: "seat", ...opts });
    const cmd = lastCommand(tmux);
    expect(cmd).toContain(flag("--settings", seat.launchSettingsPath));
    expect(cmd).toContain(flag("--plugin-dir", seat.pluginDir));
    expect(cmd).toContain(flag("--mcp-config", seat.mcpPath));
    expect(cmd).toContain(flag("--append-system-prompt-file", seat.guidancePath));
  });

  it("leaves the cwd-mode launch command byte-identical", async () => {
    const seatless = mockTmux();
    await new ClaudeCodeAdapter({ tmux: seatless, fsOps: mockFs(), sleep: async () => {}, sessionIdFactory: () => "sid" })
      .launchHarness(binding({ teamPermissionDefault: true }), { name: "seat" });
    const cwdMode = mockTmux();
    await new ClaudeCodeAdapter({ tmux: cwdMode, fsOps: mockFs(), sleep: async () => {}, sessionIdFactory: () => "sid", resolveSeatMaterial: () => "cwd" })
      .launchHarness(binding({ teamPermissionDefault: true }), { name: "seat" });
    expect(lastCommand(cwdMode)).toBe(lastCommand(seatless));
  });

  it("fails the launch instead of writing to the cwd when the seat directory cannot be used", async () => {
    const tmux = mockTmux();
    const result = await adapter(mockFs(), tmux, "seat", "/Users/op/Application Support/openrig").launchHarness(binding(), { name: "seat" });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/whitespace/) });
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  it("reports, without touching, material an earlier cwd-mode projection left in the checkout", async () => {
    const fs = mockFs({
      [`${CWD}/CLAUDE.md`]: "# Repo\n<!-- BEGIN OpenRig MANAGED BLOCK: culture.md -->\nx\n<!-- END OpenRig MANAGED BLOCK: culture.md -->\n",
      [`${CWD}/.openrig/skill-loadouts/claude-code.json`]: "{}",
    });
    const before = { ...fs._store };
    const result = await adapter(fs).project({ runtime: "claude-code", cwd: CWD, entries: [] } as ProjectionPlan, binding());
    expect(result.warnings?.join("\n")).toMatch(/CLAUDE\.md \(OpenRig managed blocks\).*skill-loadouts|skill-loadouts.*CLAUDE\.md/s);
    for (const path of Object.keys(before).filter((k) => k.startsWith(CWD))) expect(fs._store[path]).toBe(before[path]);
  });

  // Regression: the first check compared stripManagedBlocks(text) with text, and stripping also trims,
  // so any CLAUDE.md ending in a newline was reported (seen on a real rig up).
  it("does not report a repository's own CLAUDE.md that holds no managed blocks", async () => {
    const fs = mockFs({ [`${CWD}/CLAUDE.md`]: "# Team repo\n\nRepository rules for everyone.\n" });
    const result = await adapter(fs).project({ runtime: "claude-code", cwd: CWD, entries: [] } as ProjectionPlan, binding());
    expect(result.warnings ?? []).toEqual([]);
  });

  it("lists installed skills from the seat directory", async () => {
    const fs = mockFs({ [nodePath.join(seat.skillsRoot, "review", "SKILL.md")]: "x" });
    const installed = await adapter(fs).listInstalled(binding());
    expect(installed.map((r) => r.installedPath)).toEqual([nodePath.join(seat.skillsRoot, "review", "SKILL.md")]);
  });
});

describe("ClaudeResumeAdapter with seat material", () => {
  it("passes the same seat flags on the legacy resume path", async () => {
    const tmux = mockTmux();
    const fs = mockFs({ [seat.guidancePath]: "guidance" });
    const claude = adapter(fs, mockTmux());
    const resume = new ClaudeResumeAdapter(tmux, {
      launchMaterialArgs: (s, args) => claude.launchMaterialArgs(s, args), pollMs: 1, maxWaitMs: 1, sleep: async () => {},
    });
    await resume.resume(SESSION, "claude_id", "tok-1", CWD, undefined, null, undefined, "n1");
    const cmd = lastCommand(tmux);
    expect(cmd).toContain(`--resume 'tok-1'`);
    expect(cmd).toContain(flag("--plugin-dir", seat.pluginDir));
    expect(cmd).toContain(flag("--append-system-prompt-file", seat.guidancePath));
  });
});

describe("listClaudeSeatSkillRoots", () => {
  it("names every seat directory's skill folder for the audit", () => {
    const roots = listClaudeSeatSkillRoots(HOME, () => ["b@rig", "a@rig"]);
    expect(roots).toEqual([
      nodePath.join(HOME, "state", "claude-seats", "a@rig", "plugin", "skills"),
      nodePath.join(HOME, "state", "claude-seats", "b@rig", "plugin", "skills"),
    ]);
    expect(listClaudeSeatSkillRoots(HOME, () => { throw new Error("ENOENT"); })).toEqual([]);
  });
});
