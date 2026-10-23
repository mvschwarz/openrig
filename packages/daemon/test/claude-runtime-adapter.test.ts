import { createHash } from "node:crypto";
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
import { resolveReadinessTimeoutMs } from "../src/domain/readiness-timeout.js";
import { claudeCommandSessionToken } from "../src/domain/native-process-lineage.js";

const probeEvidence = expect.objectContaining({
  status: expect.any(String), code: expect.any(String),
  capture: { lines: expect.any(Number), bytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/), columns: null, rows: null },
});

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
    getPanePid: vi.fn(async () => null),
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
    expect(lastCmd(tmux)).toBe(`OPENRIG_RESUME_LAUNCH='tok-123' CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 claude ${POSTURE} --resume 'tok-123' --name seat`);
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
    expect(lastCmd(tmux)).toBe(`OPENRIG_RESUME_LAUNCH='tok-123' ${PREFIX}claude ${POSTURE} --resume 'tok-123' --name seat`);
  });

  it("FORK launch carries the prefix", async () => {
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(makeBinding(), { name: "seat", forkSource: { kind: "native_id", value: "parent-xyz" } });
    expect(lastCmd(tmux).startsWith(PREFIX + "claude ")).toBe(true);
  });

  it("override OPENRIG_CLAUDE_DISABLE_ALTERNATE_SCREEN=0 omits the renderer prefix; the resume keeps its launch marker (#1077)", async () => {
    process.env.OPENRIG_CLAUDE_DISABLE_ALTERNATE_SCREEN = "0";
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(makeBinding(), { name: "seat", resumeToken: "tok-123" });
    expect(lastCmd(tmux)).toBe(`OPENRIG_RESUME_LAUNCH='tok-123' claude ${POSTURE} --resume 'tok-123' --name seat`);
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

// OPR.0.7.0.9: a seat's own launch additions (from its seat storage) reach every Claude launch builder: fresh, resume
// and fork, managed and not. Without them the command is byte-identical (the tests above).
describe("launchHarness — a seat's launch additions", () => {
  const additions = { agent: "openrig:reviewer", appendSystemPromptFile: "/home/u/Open Rig/state/seats/r/dev.impl/claude-code/additions/system-prompt.md", pluginDirs: [] };
  const binding = (): NodeBinding => ({ ...makeBinding(), launchAdditions: additions });
  const lastCmd = (tmux: TmuxAdapter): string => {
    const calls = (tmux.sendText as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    return (calls[calls.length - 1]?.[1] as string) ?? "";
  };
  const argvOf = (cmd: string): string[] =>
    execFileSync("/bin/sh", ["-c", `claude() { printf '%s\\n' "$@"; }; ${cmd}`], { encoding: "utf8" }).split("\n").slice(0, -1);
  const expected = ["--agent", "openrig:reviewer", "--append-system-prompt-file", additions.appendSystemPromptFile];
  const between = (argv: string[], flag: string) => argv.slice(argv.indexOf("--agent"), argv.indexOf(flag));

  it.each([
    ["fresh", {}, "--session-id"],
    ["resume", { resumeToken: "tok-1" }, "--resume"],
    ["fork", { forkSource: { kind: "native_id" as const, value: "parent-1" } }, "--resume"],
  ])("%s: the agent and the prompt file are passed, each one argument, before the identity", async (_name, opts, identityFlag) => {
    const tmux = mockTmux();
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });
    const result = await adapter.launchHarness(binding(), { name: "seat", ...opts });
    expect(result.ok).toBe(true);
    expect(between(argvOf(lastCmd(tmux)), identityFlag)).toEqual(expected);
  });

  it("managed: the same arguments reach the managed command", async () => {
    const tmux = { ...mockTmux(), sendShellCommand: vi.fn(async () => ({ ok: true as const })) } as unknown as TmuxAdapter;
    const seen: string[][] = [];
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {}, sessionIdFactory: () => "fresh-1",
      claudeManagedLaunch: { prepare: async () => ({ command: (args: readonly string[]) => { seen.push([...args]); return "claude"; }, assertCurrent: () => {}, configDir: "/fixture" }) } as never });
    const result = await adapter.launchHarness({ ...binding(), permissionMode: "acceptEdits" }, { name: "seat" });
    expect(result.ok).toBe(true);
    const args = seen[0]!;
    expect(args.slice(args.indexOf("--agent"), args.indexOf("--session-id"))).toEqual(expected);
  });
});

// OPR.0.7.0.9 (K1): the strict identity reader keeps its earlier behaviour for the flags OpenRig already emits. A saved
// model `-custom`, a spec effort `-x` or a session name `-dev-impl@demo` still proves the session it launched, as it did
// before this slice; only `--agent` and `--append-system-prompt-file` use the new value rule.
describe("launchHarness — existing flags with a dash-led value keep their identity proof", () => {
  const argvOf = (cmd: string): string[] =>
    execFileSync("/bin/sh", ["-c", `claude() { printf '%s\\n' "$@"; }; ${cmd}`], { encoding: "utf8" }).split("\n").slice(0, -1);
  it.each([
    [{ model: "-custom" }, "seat"],
    [{ effort: "-x" }, "seat"],
    [{}, "-dev-impl@demo"],
  ])("%j, name %s: the launched argv, as ps shows it, still names its session", async (fields, name) => {
    const tmux = mockTmux();
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {}, sessionIdFactory: () => "11111111-1111-4111-8111-111111111111" });
    expect((await adapter.launchHarness({ ...makeBinding(), ...fields }, { name })).ok).toBe(true);
    const calls = (tmux.sendText as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const argv = argvOf(calls[calls.length - 1]![1] as string);
    expect(claudeCommandSessionToken(["claude", ...argv].join(" "))).toBe("11111111-1111-4111-8111-111111111111");
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
    (tmux.getPanePid as ReturnType<typeof vi.fn>).mockResolvedValue(900);
    (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue("user@example.test rigged %");
    const adapter = new ClaudeCodeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "/bin/zsh", pgid: 900, tpgid: 900, executableName: "zsh", startedAt: "Sat Jan  1 12:00:00 2000" },
      ],
    });

    const result = await adapter.checkReady(makeBinding());

    expect(result).toEqual({
      ready: false,
      reason: "The probe pane returned to a shell instead of staying inside the runtime.",
      code: "returned_to_shell",
    });
  });

  it("checkReady returns awaiting_runtime when the shell label is a launch script still starting Claude", async () => {
    const tmux = mockTmux();
    (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("sh");
    (tmux.getPanePid as ReturnType<typeof vi.fn>).mockResolvedValue(900);
    (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue("booting wrapper...");
    const adapter = new ClaudeCodeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "/bin/sh /tmp/launch.sh", pgid: 900, tpgid: 901, executableName: "sh", startedAt: "Sat Jan  1 12:00:00 2000" },
        { pid: 901, ppid: 900, command: "claude", pgid: 901, tpgid: 901, executableName: "claude", startedAt: "Sat Jan  1 12:00:00 2000" },
      ],
    });

    const result = await adapter.checkReady(makeBinding());

    expect(result).toEqual({
      ready: false,
      reason: "The pane shows a shell that is not a proven idle shell; a launch script may still be starting Claude.",
      code: "awaiting_runtime",
    });
  });

  it("checkReady does not call the pane a shell when the process listing is unavailable", async () => {
    const tmux = mockTmux();
    (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("sh");
    (tmux.getPanePid as ReturnType<typeof vi.fn>).mockResolvedValue(900);
    (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue("");
    const adapter = new ClaudeCodeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => { throw new Error("ps unavailable"); },
    });

    const result = await adapter.checkReady(makeBinding());

    expect(result.ready).toBe(false);
    expect(result.code).toBe("awaiting_runtime");
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

  it.each(["auto", "denyAll"])("keeps a worktree's %s permission selection when projecting shared settings", async mode => {
    const source = "/shared/claude-settings.fragment.json";
    const target = "/project/.claude/settings.local.json";
    const permissions = { defaultMode: mode, allow: ["Read(.)"], deny: ["Read(/private/**)"] };
    const files = mockFs({
      [source]: fs.readFileSync(new URL("../specs/agents/shared/runtime/claude-settings.fragment.json", import.meta.url), "utf8"),
      [target]: JSON.stringify({ permissions, userSetting: "keep" }),
    });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: files });
    const plan: ProjectionPlan = { runtime: "claude-code", cwd: "/project", entries: [makeEntry({
      category: "runtime_resource", effectiveId: "claude-default-settings", resourceType: "claude_settings_fragment", absolutePath: source,
    })], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] };
    await adapter.project(plan, makeBinding());
    await adapter.project(plan, makeBinding());
    const result = JSON.parse((files as unknown as { _store: Record<string, string> })._store[target]!);
    expect(result.permissions).toEqual(permissions);
    expect(result.userSetting).toBe("keep");
    expect(result.enabledMcpjsonServers).toEqual(["exa", "context7"]);
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
      "OPENRIG_RESUME_LAUNCH='abc-123' CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 claude --permission-mode acceptEdits --resume 'abc-123' --name dev-impl@test-rig"
    );
  });

  it("returns diagnostics from the captured login refusal without changing the timeout outcome", async () => {
    const tmux = mockTmux();
    const content = "❯ fixture-private-prompt\n● Login expired · Please run /login\n\n❯";
    vi.mocked(tmux.capturePaneContent).mockResolvedValue(content);
    vi.mocked(tmux.listPanes).mockResolvedValue([{ id: "%1", index: 0, cwd: "/project", width: 100, height: 30, active: true }]);
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });
    const result = await adapter.launchHarness(makeBinding(), { name: "dev-impl@test-rig", resumeToken: "abc-123" });
    expect(result).toEqual({
      ok: false, error: "Claude resume failed: timed out waiting for Claude to become active",
      probe: { status: "failed", code: "login_required", loginRefusal: { message: "Login expired · Please run /login", row: "response" },
        capture: { lines: 4, bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex"), columns: 100, rows: 30 } },
    });
    expect(JSON.stringify(result)).not.toContain("fixture-private-prompt");
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
      probe: probeEvidence,
      error: "Claude resume failed: no conversation found for the requested session",
      recovery: "retry_fresh",
      missingConversation: true,
    });
  });

  it("launchHarness marks a missing conversation that first shows on the read after the wait", async () => {
    const tmux = mockTmux();
    (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("zsh");
    const capture = tmux.capturePaneContent as ReturnType<typeof vi.fn>;
    // The wait reads the pane 16 times; the report first appears on the final read after it.
    for (let read = 0; read < 16; read++) capture.mockResolvedValueOnce("claude --resume abc-123\nuser@example.test %");
    capture.mockResolvedValue("No conversation found with session ID: abc-123\nuser@example.test %");
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-impl@test-rig", resumeToken: "abc-123" });

    expect(capture).toHaveBeenCalledTimes(17);
    expect(result).toEqual({
      ok: false,
      probe: probeEvidence,
      error: "Claude resume failed: no conversation found for the requested session",
      recovery: "retry_fresh",
      missingConversation: true,
    });
  });

  it("launchHarness leaves a pane that is back at its shell unmarked", async () => {
    const tmux = mockTmux();
    (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("zsh");
    (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue("Error: Claude exited\nuser@example.test %");
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-impl@test-rig", resumeToken: "abc-123" });

    expect(result).toEqual({
      ok: false,
      probe: probeEvidence,
      error: "Claude resume failed: pane returned to shell instead of entering Claude",
      recovery: "retry_fresh",
    });
  });

  describe("a resume still starting is watched, not failed (pane command is sh for every OpenRig launch)", () => {
    const startedAt = "Fri Oct 16 15:00:00 2026";
    const pane = { pid: 10, ppid: 1, pgid: 10, tpgid: 10, command: "-zsh", executableName: "zsh", startedAt };
    const launchScript = { pid: 11, ppid: 10, pgid: 11, tpgid: 11, command: "/bin/sh /tmp/openrig-tmux-send.txt", executableName: "sh", startedAt };
    const claude = { pid: 12, ppid: 11, pgid: 11, tpgid: 11, executableName: "claude", startedAt,
      command: "claude --permission-mode acceptEdits --resume abc-123 --name dev-impl@test-rig" };
    const occupied = [{ ...pane, tpgid: 11 }, launchScript, claude];
    const tui = ["Claude Code v2.1.89", "❯ Ready", "  ? for shortcuts"].join("\n");
    // 30 polls of 200 ms: the bound this test gives the wait (the daemon passes runtime.readiness_timeout_seconds).
    const WAIT_MS = 6_000;

    // `screen(read)` is the pane text on the nth capture; `rows(read)` the process list at that point.
    const run = async (opts: { screen?: (read: number) => string; rows?: (read: number) => typeof occupied; paneCommand?: string; readinessTimeoutMs?: number; autoDrive?: boolean } = {}) => {
      let reads = 0;
      const tmux = mockTmux();
      (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue(opts.paneCommand ?? "sh");
      (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockImplementation(async () => (opts.screen ?? (() => ""))(reads++));
      (tmux as unknown as { getPanePid: unknown }).getPanePid = vi.fn(async () => 10);
      const adapter = new ClaudeCodeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {}, autoDriveProviderPrompts: opts.autoDrive, readinessTimeoutMs: "readinessTimeoutMs" in opts ? opts.readinessTimeoutMs : WAIT_MS,
        listProcesses: () => (opts.rows ?? (() => occupied))(reads) });
      const result = await adapter.launchHarness({ ...makeBinding(), tmuxPane: "%1" }, { name: "dev-impl@test-rig", resumeToken: "abc-123" });
      return { result, reads, tmux };
    };

    it("marks the seat resumed when Claude draws its screen after the first window", async () => {
      const { result, reads } = await run({ screen: (read) => (read < 24 ? "" : tui) });
      expect(result).toMatchObject({ ok: true, resumeToken: "abc-123" });
      expect(reads).toBeGreaterThan(17);
      expect(reads).toBeLessThan(30);
    });

    it("marks the seat resumed when the launch script is still running Claude's start when the first window ends", async () => {
      const { result } = await run({ rows: () => [{ ...pane, tpgid: 11 }, launchScript], screen: (read) => (read < 20 ? "" : tui) });
      expect(result).toMatchObject({ ok: true });
    });

    it("ends attention_required, session kept, when Claude runs but its screen is never recognised", async () => {
      const { result, reads } = await run({ screen: () => "something Claude draws that no probe knows" });
      expect(result).toEqual({
        ok: false,
        probe: probeEvidence,
        error: "Claude resume did not finish within 6s; Claude may still be starting, so the launch was kept",
        recovery: "attention_required",
        evidence: "something Claude draws that no probe knows",
      });
      // The bound: the 30 polls plus the one read after them, not an open-ended wait.
      expect(reads).toBe(31);
    });

    it("ends attention_required when the launch script never starts Claude", async () => {
      const { result } = await run({ rows: () => [{ ...pane, tpgid: 11 }, launchScript] });
      expect(result).toMatchObject({ ok: false, recovery: "attention_required" });
    });

    it("waits, then ends attention_required, when the process list can't be read", async () => {
      const tmux = mockTmux();
      (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("sh");
      (tmux as unknown as { getPanePid: unknown }).getPanePid = vi.fn(async () => 10);
      const adapter = new ClaudeCodeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {}, readinessTimeoutMs: WAIT_MS,
        listProcesses: () => { throw new Error("ps unavailable"); } });
      const result = await adapter.launchHarness({ ...makeBinding(), tmuxPane: "%1" }, { name: "dev-impl@test-rig", resumeToken: "abc-123" });
      expect(result).toMatchObject({ ok: false, recovery: "attention_required" });
      expect(tmux.capturePaneContent).toHaveBeenCalledTimes(31);
    });

    it("keeps the bound the setting gives: a longer setting waits for more polls", async () => {
      const { result, reads } = await run({ readinessTimeoutMs: 10_000 });
      expect(result).toMatchObject({ recovery: "attention_required" });
      expect(reads).toBe(51);
    });

    it("still ends in the missing-conversation result when Claude reports it during the extra wait", async () => {
      const { result } = await run({ screen: (read) => (read < 22 ? "" : "No conversation found with session ID: abc-123") });
      expect(result).toEqual({
        ok: false,
        probe: probeEvidence,
        error: "Claude resume failed: no conversation found for the requested session",
        recovery: "retry_fresh",
        missingConversation: true,
      });
    });

    it("still stops at a resume-selection prompt that shows up during the extra wait", async () => {
      const chooser = "Choose a conversation to resume:\n  1. First conversation\n  2. Second conversation";
      const { result, reads } = await run({ screen: (read) => (read < 22 ? "" : chooser) });
      expect(result).toMatchObject({ ok: false, recovery: "attention_required" });
      expect((result as { error: string }).error).toContain("resume-selection prompt");
      // Ended at the prompt, not at the bound.
      expect(reads).toBeLessThan(25);
    });

    it("reports a return to the shell when the pane is back at its shell by the end of the wait", async () => {
      const { result } = await run({ rows: (read) => (read < 25 ? occupied : [pane]) });
      expect(result).toEqual({
        ok: false,
        probe: probeEvidence,
        error: "Claude resume failed: pane returned to shell instead of entering Claude",
        recovery: "retry_fresh",
      });
    });

    it("ends the wait early when Claude exits after the first window: the shell is proven idle, not waited out", async () => {
      // Claude is under the launch script when the first window ends, then exits at read 19; the pane label stays a shell.
      const { result, reads } = await run({ rows: (read) => (read < 19 ? occupied : [pane]) });
      expect(result).toEqual({
        ok: false,
        probe: probeEvidence,
        error: "Claude resume failed: pane returned to shell instead of entering Claude",
        recovery: "retry_fresh",
      });
      // Found at the next once-a-second check, not at the bound (31 reads).
      expect(reads).toBeLessThan(25);
    });

    it("looks at the process table about once a second during the extra wait, not on every poll", async () => {
      let listings = 0;
      const { result } = await run({ rows: () => { listings++; return [{ ...pane, tpgid: 11 }, launchScript]; } });
      expect(result).toMatchObject({ ok: false, recovery: "attention_required" });
      // The 14 extra polls of this bound would cost 28 listings if every one checked.
      expect(listings).toBeLessThan(16);
    });

    // The readiness setting runs 1 to 600 s; the quick window is 3.2 s, so 1 to 3 s leave no room for extra polls.
    describe.each([1000, 2000, 3000])("with a readiness setting of %i ms, no longer than the quick window", (readinessTimeoutMs) => {
      const stuck = [{ ...pane, tpgid: 11 }, launchScript];

      it("still ends attention_required for an unresolved own launch, not the failure that loses the token", async () => {
        const { result, reads } = await run({ readinessTimeoutMs, screen: () => "something Claude draws that no probe knows" });
        expect(result).toMatchObject({ ok: false, recovery: "attention_required" });
        expect(reads).toBe(17);
      });

      it("still ends attention_required when the process list can't be read", async () => {
        const { result } = await run({ readinessTimeoutMs, rows: () => { throw new Error("ps unavailable"); } });
        expect(result).toMatchObject({ ok: false, recovery: "attention_required" });
      });

      it("keeps real failures distinct: a shell proven idle, another occupant and a gate are not attention", async () => {
        expect((await run({ readinessTimeoutMs, rows: () => [pane] })).result).toMatchObject({ ok: false, recovery: "retry_fresh" });
        const other = { ...claude, command: "claude --permission-mode acceptEdits --resume some-other-session --name other" };
        expect((await run({ readinessTimeoutMs, rows: () => [{ ...pane, tpgid: 11 }, launchScript, other] })).result)
          .toEqual({ ok: false, probe: probeEvidence, error: "Claude resume failed: timed out waiting for Claude to become active" });
        expect((await run({ readinessTimeoutMs, rows: () => stuck, screen: () => "● Not logged in · Please run /login" })).result)
          .toEqual({ ok: false, probe: probeEvidence, error: "Claude resume failed: timed out waiting for Claude to become active" });
      });
    });

    it("with 4 s, just above the quick window, waits the four polls that fit, then attention_required", async () => {
      const { result, reads } = await run({ readinessTimeoutMs: 4_000 });
      expect(result).toMatchObject({ ok: false, recovery: "attention_required" });
      expect(reads).toBe(21);
    });

    it("with the default setting, waits the polls its bound gives after the quick window, then attention_required", async () => {
      const { result, reads } = await run({ readinessTimeoutMs: undefined });
      expect(result).toMatchObject({ ok: false, recovery: "attention_required" });
      expect(reads).toBe(16 + Math.floor((resolveReadinessTimeoutMs(undefined) - 3_200) / 200) + 1);
    });

    describe("a different occupant keeps main's result (timed out, no token): only unknown observations get attention", () => {
      const timedOut = { ok: false, probe: probeEvidence, error: "Claude resume failed: timed out waiting for Claude to become active" };
      const codex = { pid: 13, ppid: 11, pgid: 11, tpgid: 11, executableName: "codex", startedAt, command: "codex resume some-codex-session" };
      const otherClaude = { ...claude, command: "claude --permission-mode acceptEdits --resume some-other-session --name other" };
      const booting = [{ ...pane, tpgid: 11 }, launchScript];

      it("a stable Codex under the shell is not waited for", async () => {
        const { result, reads } = await run({ rows: () => [...booting, codex] });
        expect(result).toEqual(timedOut);
        expect(reads).toBe(17);
      });

      it("a Codex under the shell is not waited for at a 1 s setting either", async () => {
        const { result } = await run({ readinessTimeoutMs: 1_000, rows: () => [...booting, codex] });
        expect(result).toEqual(timedOut);
      });

      it("a Claude that names another conversation, there when the first window ends, is not waited for", async () => {
        const { result, reads } = await run({ rows: () => [...booting, otherClaude] });
        expect(result).toEqual(timedOut);
        expect(reads).toBe(17);
      });

      it.each([["a Claude that names another conversation", otherClaude], ["a Codex", codex]])(
        "%s that arrives during the longer wait ends it, at the next check", async (_label, arrival) => {
          const { result, reads } = await run({ rows: (read) => (read < 19 ? booting : [...booting, arrival]) });
          expect(result).toEqual(timedOut);
          expect(reads).toBeLessThan(25);
        });

      // The periodic check ends at attempt 145 of 150 (default) and never fits in 4 s (20 attempts): the occupant changes after it.
      it.each([
        ["4 s setting", 4_000, 18],
        ["default setting", undefined, 148],
      ] as const)("%s: a different occupant arriving after the last periodic check still keeps main's result", async (_label, readinessTimeoutMs, arriveAt) => {
        for (const arrival of [otherClaude, codex]) {
          const { result } = await run({ readinessTimeoutMs, rows: (read) => (read < arriveAt ? booting : [...booting, arrival]) });
          expect(result).toEqual(timedOut);
        }
      });

      describe("with provider-prompt auto-driving on, a trust prompt in the longer wait", () => {
        const trust = "Accessing workspace:\n/fixture\n1. Yes, I trust this folder\n2. No, exit";

        it.each([["a Codex", codex], ["another conversation's Claude", otherClaude]])(
          "from %s that took the pane is not answered: main's result, no Enter", async (_label, arrival) => {
            const { result, tmux } = await run({ autoDrive: true, rows: (read) => (read < 19 ? booting : [...booting, arrival]),
              screen: (read) => (read < 20 ? "" : trust) });
            expect(result).toEqual(timedOut);
            expect(tmux.sendKeys).toHaveBeenCalledTimes(1); // the launch command's own Enter, none for the prompt
          });

        it("with nothing seen under the pane (an occupant the wait hasn't checked) is not answered either", async () => {
          const { result, tmux } = await run({ autoDrive: true, rows: () => booting, screen: (read) => (read < 20 ? "" : trust) });
          expect(result).toEqual(timedOut);
          expect(tmux.sendKeys).toHaveBeenCalledTimes(1);
        });

        it("from this launch's own Claude is answered, and the seat resumes", async () => {
          const { result, tmux } = await run({ autoDrive: true, screen: (read) => (read < 20 ? "" : read < 23 ? trust : tui) });
          expect(result).toMatchObject({ ok: true });
          expect((tmux.sendKeys as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
        });

        it("in the quick window is answered as before, whoever holds the pane", async () => {
          const { tmux } = await run({ autoDrive: true, rows: () => [...booting, codex], screen: (read) => (read < 3 ? trust : "") });
          expect((tmux.sendKeys as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
        });
      });

      describe("a ready-looking screen with an unreadable process list is unknown, not another occupant", () => {
        const ready = "Restored conversation\n❯\u00a0\n  ⏵⏵ bypass permissions on (shift+tab to cycle)";
        const unreadable = () => { throw new Error("ps unavailable"); };

        it("when the first window ends: attention_required, token kept", async () => {
          const { result } = await run({ rows: unreadable, screen: () => ready });
          expect(result).toMatchObject({ ok: false, recovery: "attention_required" });
        });

        it("when it first draws during the longer wait: keeps waiting, then attention_required", async () => {
          const { result, reads } = await run({ rows: unreadable, screen: (read) => (read < 20 ? "" : ready) });
          expect(result).toMatchObject({ ok: false, recovery: "attention_required" });
          expect(reads).toBe(31);
        });

        it("with a list that can be read and shows a look-alike, it is still main's result", async () => {
          const lookAlike = { ...claude, executableName: "printf" };
          const { result } = await run({ rows: (read) => (read < 20 ? booting : [...booting, lookAlike]), screen: (read) => (read < 20 ? "" : ready) });
          expect(result).toEqual(timedOut);
        });
      });

      it("an unknown occupant (nothing seen, own launch script only) is waited for, then attention_required", async () => {
        const { result, reads } = await run({ rows: () => booting });
        expect(result).toMatchObject({ ok: false, recovery: "attention_required" });
        expect(reads).toBe(31);
      });
    });

    it("does not wait at all for a pane that is provably back at its shell when the first window ends", async () => {
      const { result, reads } = await run({ rows: () => [pane] });
      expect(result).toMatchObject({ ok: false, recovery: "retry_fresh" });
      expect(reads).toBe(17);
    });

    it("does not wait for a Claude that names another conversation: another occupant, timed out as before", async () => {
      const other = { ...claude, command: "claude --permission-mode acceptEdits --resume some-other-session --name other" };
      const { result, reads } = await run({ rows: () => [{ ...pane, tpgid: 11 }, launchScript, other] });
      expect(result).toEqual({ ok: false, probe: probeEvidence, error: "Claude resume failed: timed out waiting for Claude to become active" });
      expect(reads).toBe(17);
    });

    it("does not wait for a ready-looking screen whose lineage failed the check: timed out as before", async () => {
      // Claude's composer and footer are on the pane, but the process under it is a look-alike, not this launch's Claude.
      const lookAlike = { ...claude, executableName: "printf" };
      const ready = "Restored conversation\n❯\u00a0\n  ⏵⏵ bypass permissions on (shift+tab to cycle)";
      const { result, reads } = await run({ rows: () => [{ ...pane, tpgid: 11 }, launchScript, lookAlike], screen: () => ready });
      expect(result).toEqual({ ok: false, probe: probeEvidence, error: "Claude resume failed: timed out waiting for Claude to become active" });
      expect(reads).toBe(17);
    });

    it("a look-alike that draws a ready-looking screen during the extra wait ends it, as at the window's end", async () => {
      // Only the launch script under the pane while it boots; at read 20 a look-alike process and Claude's composer appear.
      const lookAlike = { ...claude, executableName: "printf" };
      const ready = "Restored conversation\n❯\u00a0\n  ⏵⏵ bypass permissions on (shift+tab to cycle)";
      const { result, reads } = await run({
        rows: (read) => (read < 20 ? [{ ...pane, tpgid: 11 }, launchScript] : [{ ...pane, tpgid: 11 }, launchScript, lookAlike]),
        screen: (read) => (read < 20 ? "" : ready),
      });
      expect(result).toEqual({ ok: false, probe: probeEvidence, error: "Claude resume failed: timed out waiting for Claude to become active" });
      expect(reads).toBeLessThan(25);
    });

    it("does not wait for a Claude that says it needs a login: timed out as before", async () => {
      const { result, reads } = await run({ screen: () => "● Not logged in · Please run /login" });
      expect(result).toEqual({ ok: false, probe: probeEvidence, error: "Claude resume failed: timed out waiting for Claude to become active" });
      expect(reads).toBe(17);
    });

    it("stops waiting as soon as a real prompt appears during the extra wait: a gate won't clear itself", async () => {
      // A trust prompt that shows up at read 22 ends the wait there; it is not a start in progress.
      const gate = ["Accessing workspace:", "/project", "❯ 1. Yes, I trust this folder", "  2. No, exit"].join("\n");
      const { result, reads } = await run({ screen: (read) => (read < 22 ? "" : gate) });
      expect(result).toEqual({ ok: false, probe: probeEvidence, error: "Claude resume failed: timed out waiting for Claude to become active" });
      expect(reads).toBeLessThan(26);
    });

    it("the bound is per seat: three stuck seats launched one after another each wait their full bound", async () => {
      const reads = [(await run()).reads, (await run()).reads, (await run()).reads];
      // 16 quick polls, 14 more up to the 6 s test bound, and the read after them: 31 each, nothing carried over.
      expect(reads).toEqual([31, 31, 31]);
    });

    it("waits and ends attention_required when tmux names Claude's version string and the screen is never recognised (#86)", async () => {
      const { result } = await run({ paneCommand: "2.1.301", screen: () => "" });
      expect(result).toMatchObject({ ok: false, recovery: "attention_required" });
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

  it("projectEntry skips a legacy `role` projection of the seat's own role file, and still merges shared guidance named `role`", async () => {
    const fs = mockFs({ "/agents/analyst/guidance/role.md": "# You are the analyst", "/rig/guidance/team-role.md": "# Our team's role" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const project = (absolutePath: string, cwd: string) => new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs }).project({
      runtime: "claude-code", cwd,
      entries: [makeEntry({ category: "guidance", effectiveId: "role", mergeStrategy: "managed_block", absolutePath, resourcePath: "guidance/role.md" })],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    }, makeBinding(cwd));
    const store = (fs as unknown as { _store: Record<string, string> })._store;

    // Saved before the id became rig-role: the analyst's own role must not land in the file every pod-mate reads.
    const own = await project("/agents/analyst/guidance/role.md", "/project");
    expect(store["/project/CLAUDE.md"]).toBeUndefined();
    expect(own.skipped).toContain("role");
    // A spec saved that way may have had no other route for the role, so the result says what happened.
    expect(own.warnings).toEqual([expect.stringContaining("role: not merged into /project/CLAUDE.md")]);
    // Guidance that is genuinely shared and happens to be named role still merges.
    const shared = await project("/rig/guidance/team-role.md", "/shared");
    expect(store["/shared/CLAUDE.md"]).toContain("Our team's role");
    expect(shared.projected).toContain("role");
    expect(shared.warnings).toBeUndefined();
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
