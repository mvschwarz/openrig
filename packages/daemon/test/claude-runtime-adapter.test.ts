import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import type { NodeBinding, ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../src/domain/projection-planner.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { claudePostureFlag } from "../src/adapters/yolo-mode.js";

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

// 51-07 A1 — a per-agent model declared in the spec must reach the claude launch command.
// binding.model already arrives (resolver → instantiator :1728); this pins the ADAPTER emitting it
// on all three launch builders. RED-first: the three --model tests fail on main (0 model refs in the
// adapter); the byte-identical + posture pins are invariants that stay green through the change.
describe("launchHarness — per-agent --model reaches the claude launch (51-07 A1)", () => {
  const MODEL = "claude-haiku-4-5";
  const POSTURE = claudePostureFlag(process.env, undefined); // the acceptEdits floor — the posture pin baseline

  const withModel = (model?: string): NodeBinding => ({ ...makeBinding(), model } as NodeBinding);
  const adapterWith = (tmux: TmuxAdapter) => new ClaudeCodeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });
  const lastCmd = (tmux: TmuxAdapter): string => {
    const calls = (tmux.sendText as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    return (calls[calls.length - 1]?.[1] as string) ?? "";
  };

  it("FRESH launch emits --model when the binding declares one", async () => {
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(withModel(MODEL), { name: "seat" });
    expect(lastCmd(tmux)).toContain(`--model '${MODEL}'`);
  });

  it("RESUME launch emits --model", async () => {
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(withModel(MODEL), { name: "seat", resumeToken: "tok-123" });
    expect(lastCmd(tmux)).toContain(`--model '${MODEL}'`);
  });

  it("FORK launch emits --model", async () => {
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(withModel(MODEL), { name: "seat", forkSource: { kind: "native_id", value: "parent-xyz" } });
    expect(lastCmd(tmux)).toContain(`--model '${MODEL}'`);
  });

  // absent → deterministic bytes (no --model added). Baseline now carries the OPR.0.5.3.1
  // classic-renderer prefix by default (see the scrollback-restore describe below).
  it("absent model → the resume command is exact bytes (no --model, posture intact)", async () => {
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(withModel(undefined), { name: "seat", resumeToken: "tok-123" });
    expect(lastCmd(tmux)).toBe(`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 claude ${POSTURE} --resume 'tok-123' --name seat`);
  });

  // D1 pin — posture BYTE-UNCHANGED both directions: the ONLY delta with/without model is the
  // additive ` --model '<x>'`; posture and every other token are byte-identical.
  it("adds ONLY --model — posture and structure byte-unchanged (additive-only)", async () => {
    const tmuxNo = mockTmux(); await adapterWith(tmuxNo).launchHarness(withModel(undefined), { name: "seat", resumeToken: "T" });
    const tmuxYes = mockTmux(); await adapterWith(tmuxYes).launchHarness(withModel(MODEL), { name: "seat", resumeToken: "T" });
    const noModel = lastCmd(tmuxNo), withMdl = lastCmd(tmuxYes);
    expect(noModel).toContain(POSTURE);
    expect(withMdl).toContain(POSTURE);
    expect(withMdl.replace(` --model '${MODEL}'`, "")).toBe(noModel);
  });
});

describe("launchHarness — per-agent --effort reaches the claude launch (#75)", () => {
  const EFFORT = "high";
  const POSTURE = claudePostureFlag(process.env, undefined);

  const withEffort = (effort?: string, model?: string): NodeBinding => ({ ...makeBinding(), effort, model } as NodeBinding);
  const adapterWith = (tmux: TmuxAdapter) => new ClaudeCodeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });
  const lastCmd = (tmux: TmuxAdapter): string => {
    const calls = (tmux.sendText as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    return (calls[calls.length - 1]?.[1] as string) ?? "";
  };

  it("FRESH launch emits --effort when the binding declares one", async () => {
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(withEffort(EFFORT), { name: "seat" });
    expect(lastCmd(tmux)).toContain(`--effort '${EFFORT}'`);
  });

  it("RESUME launch emits --effort", async () => {
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(withEffort(EFFORT), { name: "seat", resumeToken: "tok-123" });
    expect(lastCmd(tmux)).toContain(`--effort '${EFFORT}'`);
  });

  it("FORK launch emits --effort", async () => {
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(withEffort(EFFORT), { name: "seat", forkSource: { kind: "native_id", value: "parent-xyz" } });
    expect(lastCmd(tmux)).toContain(`--effort '${EFFORT}'`);
  });

  it("emits both --model and --effort when both declared", async () => {
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(withEffort(EFFORT, "claude-haiku-4-5"), { name: "seat", resumeToken: "tok-123" });
    expect(lastCmd(tmux)).toContain(`--model 'claude-haiku-4-5'`);
    expect(lastCmd(tmux)).toContain(`--effort '${EFFORT}'`);
  });

  it("absent effort → command byte-identical", async () => {
    const tmuxNo = mockTmux(); await adapterWith(tmuxNo).launchHarness(withEffort(undefined), { name: "seat", resumeToken: "T" });
    const tmuxYes = mockTmux(); await adapterWith(tmuxYes).launchHarness(withEffort(EFFORT), { name: "seat", resumeToken: "T" });
    const noEffort = lastCmd(tmuxNo), withEff = lastCmd(tmuxYes);
    expect(noEffort).toContain(POSTURE);
    expect(withEff).toContain(POSTURE);
    expect(withEff.replace(` --effort '${EFFORT}'`, "")).toBe(noEffort);
  });
});

// OPR.0.5.3.1 slice 01 — Claude scrollback restore. Every managed launch path must prepend
// CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 by default (classic renderer -> native scrollback);
// an explicit OPENRIG_CLAUDE_DISABLE_ALTERNATE_SCREEN=0 opts back into fullscreen (byte-identical
// to pre-change). RED-first: the default-prefix pins fail on main (adapter emits no prefix).
describe("launchHarness — classic-renderer env prefix (OPR.0.5.3.1 scrollback restore)", () => {
  const POSTURE = claudePostureFlag(process.env, undefined);
  const adapterWith = (tmux: TmuxAdapter) => new ClaudeCodeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });
  const lastCmd = (tmux: TmuxAdapter): string => {
    const calls = (tmux.sendText as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    return (calls[calls.length - 1]?.[1] as string) ?? "";
  };
  const PREFIX = "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 ";

  afterEach(() => {
    delete process.env.OPENRIG_CLAUDE_DISABLE_ALTERNATE_SCREEN;
  });

  it("FRESH launch prepends the classic-renderer prefix by default", async () => {
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(makeBinding(), { name: "seat" });
    expect(lastCmd(tmux).startsWith(PREFIX + "claude ")).toBe(true);
  });

  it("RESUME launch carries the prefix", async () => {
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(makeBinding(), { name: "seat", resumeToken: "tok-123" });
    expect(lastCmd(tmux)).toBe(`${PREFIX}claude ${POSTURE} --resume 'tok-123' --name seat`);
  });

  it("FORK launch carries the prefix", async () => {
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(makeBinding(), { name: "seat", forkSource: { kind: "native_id", value: "parent-xyz" } });
    expect(lastCmd(tmux).startsWith(PREFIX + "claude ")).toBe(true);
  });

  it("override OPENRIG_CLAUDE_DISABLE_ALTERNATE_SCREEN=0 omits the prefix (byte-identical to pre-change)", async () => {
    process.env.OPENRIG_CLAUDE_DISABLE_ALTERNATE_SCREEN = "0";
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(makeBinding(), { name: "seat", resumeToken: "tok-123" });
    expect(lastCmd(tmux)).toBe(`claude ${POSTURE} --resume 'tok-123' --name seat`);
  });
});

// The non-managed launch command is parsed by the pane shell, so the resume token must stay one
// argument whatever it contains — the same quoting as the restore path (claude-resume.ts).
describe("launchHarness — the resume token is one shell argument", () => {
  const adapterWith = (tmux: TmuxAdapter) => new ClaudeCodeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });
  const lastCmd = (tmux: TmuxAdapter): string => {
    const calls = (tmux.sendText as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    return (calls[calls.length - 1]?.[1] as string) ?? "";
  };
  // Parse the command with a real shell; `claude` is a function that prints its argv, one per line.
  const argvOf = (cmd: string): string[] =>
    execFileSync("/bin/sh", ["-c", `claude() { printf '%s\\n' "$@"; }; ${cmd}`], { encoding: "utf8" }).split("\n").slice(0, -1);

  it.each(["tok; echo injected", "$(echo injected)", "two words", "it's"])("keeps %j after --resume as one argument", async (token) => {
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(makeBinding(), { name: "seat", resumeToken: token });
    const argv = argvOf(lastCmd(tmux));
    expect(argv.slice(argv.indexOf("--resume"))).toEqual(["--resume", token, "--name", "seat"]);
  });

  it("gives a UUID token the same argv as the unquoted form", async () => {
    const token = "11111111-1111-4111-8111-111111111111";
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(makeBinding(), { name: "seat", resumeToken: token });
    const cmd = lastCmd(tmux);
    expect(argvOf(cmd)).toEqual(argvOf(cmd.replace(`'${token}'`, token)));
    expect(argvOf(cmd).slice(-4)).toEqual(["--resume", token, "--name", "seat"]);
  });
});

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
    (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue("user@example.test rigged %");
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
        "<!-- BEGIN OpenRig MANAGED BLOCK: using-openrig.md -->",
        "# Using OpenRig",
        "Old guidance",
        "<!-- END OpenRig MANAGED BLOCK: using-openrig.md -->",
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
    expect(content).toContain("BEGIN OpenRig MANAGED BLOCK: openrig-start.md");
    expect(content).not.toContain("BEGIN OpenRig MANAGED BLOCK: using-openrig.md");
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
    expect(tmux.sendKeys).toHaveBeenCalledWith("r01-impl", ["Enter"]);
  });

  // OPR.0.3.3.16 - a >100KB send_text startup pack must still travel through the
  // sendText -> sleep -> sendKeys(["Enter"]) sequence unchanged. The large-payload
  // buffer mechanics live in TmuxAdapter; the adapter's job is to hand the full
  // content to sendText and fire the single trailing submit.
  it("delivers a large (>100KB) send_text startup file via sendText then submits with Enter", async () => {
    const tmux = mockTmux();
    const big = "L".repeat(120 * 1024);
    const fs = mockFs({ "/rig/startup/big-pack.md": big });
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: fs, sleep: async () => {} });
    const file: ResolvedStartupFile = {
      path: "startup/big-pack.md", absolutePath: "/rig/startup/big-pack.md", ownerRoot: "/rig",
      deliveryHint: "send_text", required: true, appliesOn: ["fresh_start", "restore"],
    };

    const result = await adapter.deliverStartup([file], makeBinding());

    expect(result.delivered).toBe(1);
    expect(result.failed).toEqual([]);
    // The full payload is handed to sendText (TmuxAdapter routes it to the buffer path).
    expect(tmux.sendText).toHaveBeenCalledWith("r01-impl", big);
    // Single trailing submit preserved.
    expect(tmux.sendKeys).toHaveBeenCalledWith("r01-impl", ["Enter"]);
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

  // T9c: file-shaped subagent under PRODUCTION listFiles semantics. The in-memory
  // mockFs above returns [] for a file path, but production wires listFiles to a
  // recursive fs.readdirSync walk (startup.ts), which throws ENOTDIR on a file —
  // an unguarded probe lands the entry in ProjectionResult.failed and it is never
  // projected. This drives project() through a real-fs-backed listFiles.
  it("projects file-shaped subagent when listFiles throws ENOTDIR (production readdirSync semantics)", async () => {
    const tempRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-claude-projection-"));
    const srcFile = nodePath.join(tempRoot, "agents", "base", "subagents", "reviewer.yaml");
    fs.mkdirSync(nodePath.dirname(srcFile), { recursive: true });
    fs.writeFileSync(srcFile, "name: reviewer");
    const cwd = nodePath.join(tempRoot, "project");
    fs.mkdirSync(cwd, { recursive: true });

    const adapter = new ClaudeCodeAdapter({
      tmux: mockTmux(),
      fsOps: {
        readFile: (p: string) => fs.readFileSync(p, "utf-8"),
        writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
        exists: (p: string) => fs.existsSync(p),
        mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
        copyFile: (src: string, dest: string) => fs.copyFileSync(src, dest),
        listFiles: (dir: string) => fs.readdirSync(dir),
      },
    });
    const plan: ProjectionPlan = {
      runtime: "claude-code", cwd,
      entries: [makeEntry({ category: "subagent", effectiveId: "reviewer", absolutePath: srcFile, resourcePath: "subagents/reviewer.yaml" })],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };

    const result = await adapter.project(plan, makeBinding(cwd));

    expect(result.failed).toEqual([]);
    expect(result.projected).toEqual(["reviewer"]);
    expect(fs.readFileSync(nodePath.join(cwd, ".claude", "agents", "reviewer.yaml"), "utf-8")).toBe("name: reviewer");
  });

  it("applies claude_settings_fragment runtime resources to project-local Claude settings", async () => {
    const fs = mockFs({
      "/agents/base/runtime/claude-settings.json": JSON.stringify({
        permissions: {
          defaultMode: "acceptEdits",
          allow: ["Bash(npm:*)"],
          ask: ["Bash(rig up:*)"],
        },
        enabledMcpjsonServers: ["context7"],
      }),
      "/project/.claude/settings.local.json": JSON.stringify({
        customSetting: true,
        permissions: {
          allow: ["Bash(existing:*)"],
          ask: ["Bash(existing-ask:*)"],
        },
        enabledMcpjsonServers: ["existing"],
      }),
    });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan: ProjectionPlan = {
      runtime: "claude-code", cwd: "/project",
      entries: [makeEntry({
        category: "runtime_resource",
        effectiveId: "claude-settings",
        resourceType: "claude_settings_fragment",
        absolutePath: "/agents/base/runtime/claude-settings.json",
        resourcePath: "runtime/claude-settings.json",
      })],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };

    const result = await adapter.project(plan, makeBinding());

    expect(result).toEqual({ projected: ["claude-settings"], skipped: [], failed: [] });
    const store = (fs as unknown as { _store: Record<string, string> })._store;
    const settings = JSON.parse(store["/project/.claude/settings.local.json"]!);
    expect(settings.customSetting).toBe(true);
    expect(settings.permissions.defaultMode).toBe("acceptEdits");
    expect(settings.permissions.allow).toEqual(["Bash(existing:*)", "Bash(npm:*)"]);
    expect(settings.permissions.ask).toEqual(["Bash(existing-ask:*)", "Bash(rig up:*)"]);
    expect(settings.enabledMcpjsonServers).toEqual(["existing", "context7"]);
    expect(store["/project/.claude/extensions/claude-settings/claude-settings.json"]).toBeUndefined();
  });

  it("applies claude_mcp_fragment runtime resources to project-local MCP config", async () => {
    const fs = mockFs({
      "/agents/base/runtime/claude-mcp.json": JSON.stringify({
        mcpServers: {
          context7: { type: "http", url: "https://mcp.context7.com/mcp" },
        },
      }),
      "/project/.mcp.json": JSON.stringify({
        mcpServers: {
          existing: { type: "http", url: "https://example.com/mcp" },
        },
      }),
    });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan: ProjectionPlan = {
      runtime: "claude-code", cwd: "/project",
      entries: [makeEntry({
        category: "runtime_resource",
        effectiveId: "claude-mcp",
        resourceType: "claude_mcp_fragment",
        absolutePath: "/agents/base/runtime/claude-mcp.json",
        resourcePath: "runtime/claude-mcp.json",
      })],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };

    const result = await adapter.project(plan, makeBinding());

    expect(result).toEqual({ projected: ["claude-mcp"], skipped: [], failed: [] });
    const store = (fs as unknown as { _store: Record<string, string> })._store;
    const mcp = JSON.parse(store["/project/.mcp.json"]!);
    expect(Object.keys(mcp.mcpServers)).toEqual(["existing", "context7"]);
    expect(mcp.mcpServers.existing.url).toBe("https://example.com/mcp");
    expect(mcp.mcpServers.context7.url).toBe("https://mcp.context7.com/mcp");
  });

  it("fails projection honestly for malformed Claude runtime settings fragments", async () => {
    const fs = mockFs({ "/agents/base/runtime/claude-settings.json": "[]" });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan: ProjectionPlan = {
      runtime: "claude-code", cwd: "/project",
      entries: [makeEntry({
        category: "runtime_resource",
        effectiveId: "claude-settings",
        resourceType: "claude_settings_fragment",
        absolutePath: "/agents/base/runtime/claude-settings.json",
        resourcePath: "runtime/claude-settings.json",
      })],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };

    const result = await adapter.project(plan, makeBinding());

    expect(result.projected).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.effectiveId).toBe("claude-settings");
    expect(result.failed[0]!.error).toContain("must be a JSON object");
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
      "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 claude --permission-mode acceptEdits --session-id 11111111-1111-4111-8111-111111111111 --name dev-impl@test-rig"
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
      "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 claude --permission-mode acceptEdits --resume 'abc-123' --name dev-impl@test-rig"
    );
  });

  it("launchHarness returns retry_fresh when Claude reports no conversation found for the requested resume token", async () => {
    const tmux = mockTmux();
    (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("zsh");
    (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue(
      "No conversation found with session ID: abc-123\nuser@example.test %"
    );
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-impl@test-rig", resumeToken: "abc-123" });

    expect(result).toEqual({
      ok: false,
      error: "Claude resume failed: no conversation found for the requested session",
      recovery: "retry_fresh",
    });
  });

  it("launchHarness auto-accepts Claude workspace trust prompt only when explicitly configured", async () => {
    const tmux = mockTmux();
    (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("claude");
    (tmux.capturePaneContent as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([
        "Accessing workspace:",
        "/project",
        "❯ 1. Yes, I trust this folder",
        "  2. No, exit",
      ].join("\n"))
      .mockResolvedValue([
        "Claude Code v2.1.89",
        "❯ Ready",
      ].join("\n"));
    const adapter = new ClaudeCodeAdapter({
      tmux,
      fsOps: mockFs(),
      sleep: async () => {},
      autoDriveProviderPrompts: true,
    });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-impl@test-rig", resumeToken: "abc-123" });

    expect(result).toEqual({
      ok: true,
      resumeToken: "abc-123",
      resumeType: "claude_id",
      appliedLaunch: { runtime: "claude-code", axis: "permission", state: "observed", value: "acceptEdits", reason: "emitted_launch_arguments" },
    });
    expect(tmux.sendKeys).toHaveBeenCalledTimes(2);
    expect(tmux.sendKeys).toHaveBeenNthCalledWith(2, "r01-impl", ["Enter"]);
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
      appliedLaunch: { runtime: "claude-code", axis: "permission", state: "observed", value: "acceptEdits", reason: "emitted_launch_arguments" },
    });
  });

  it.each<[string, string[]]>([
    ["the only same-name file matches", ["assigned.json"]],
    ["another same-name seat is first", ["other.json", "assigned.json"]],
    ["only another same-name seat has written its file", ["other.json"]],
  ])("fresh launch retains its assigned ID when %s", async (_case, files) => {
    const tmux = mockTmux();
    const assignedId = "11111111-1111-4111-8111-111111111111";
    const otherId = "22222222-2222-4222-8222-222222222222";
    const sessionData: Record<string, string> = {
      "assigned.json": JSON.stringify({ pid: 12345, sessionId: assignedId, name: "dev-impl@test-rig" }),
      "other.json": JSON.stringify({ pid: 67890, sessionId: otherId, name: "dev-impl@test-rig" }),
    };
    const fs = mockFs({});
    const fsWithDir = {
      ...fs,
      readdir: (dir: string) => dir.includes("sessions") ? files : [],
      homedir: "/mock-home",
      readFile: (p: string) => {
        const data = sessionData[nodePath.basename(p)];
        if (data) return data;
        return fs.readFile(p);
      },
      exists: (p: string) => p.includes("sessions") || fs.exists(p),
    };
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: fsWithDir, sessionIdFactory: () => assignedId });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-impl@test-rig" });

    expect(tmux.sendText).toHaveBeenCalledWith("r01-impl", expect.stringContaining(`--session-id ${assignedId}`));
    expect(result).toMatchObject({ ok: true, resumeToken: assignedId, resumeType: "claude_id" });
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
    expect(store["/project/CLAUDE.md"]).toContain("BEGIN OpenRig MANAGED BLOCK: using-openrig.md");
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

  // OPR.0.4.8.2 agnostic rip-out: the whole "Permission-config-at-spawn: Bash convenience
  // baseline provisioning" section (7 provisionRigPermissions tests) is REMOVED — the writer
  // (assessment C2) is deleted. Replacement coverage: agnostic-rip-out.test.ts asserts (a) a
  // fresh startup authors no ~/.claude/settings.json for permissions; (b) a pre-existing
  // provenance-marked settings file is left byte-identical (no retro-scrub).

  // Pre-rip 'provisions project-local Claude hooks without clobbering
  // existing local settings or persisting the hook token' test removed in
  // plugin-primitive Phase 3a slice 3.1 — activity-hook auto-injection
  // ripped (provisionActivityHooks gone). Replacement coverage:
  // activity-hook-rip-proof.test.ts asserts (a) no .openrig/activity-hook-relay.cjs
  // file written; (b) no OpenRig-injected hook entries in settings.local.json;
  // (c) pre-existing user-authored hooks PRESERVED untouched; (d) source
  // grep confirms provisionActivityHooks/upsertCommandHook/etc. removed
  // from adapter source.
});
