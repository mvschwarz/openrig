import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { setupCommand, runSetup, type SetupDeps, type SetupResult } from "../src/commands/setup.js";
import type { DoctorDeps } from "../src/commands/doctor.js";

function makeDeps(overrides?: Partial<SetupDeps>): SetupDeps {
  return {
    exec: (cmd: string) => {
      if (cmd === "brew --version") return "Homebrew 4.0\n";
      if (cmd === "tmux -V") return "tmux 3.4\n";
      if (cmd === "cmux capabilities --json") return '{"capabilities":[]}\n';
      if (cmd === "cmux --help") return "cmux help\n";
      if (cmd === "claude --version") return "2.1.101 (Claude Code)\n";
      if (cmd === "claude auth status") return "Authenticated\n";
      if (cmd === "codex --version") return "codex-cli 0.118.0\n";
      if (cmd === "codex login status") return "Logged in\n";
      if (cmd === "jq --version") return "jq-1.7\n";
      if (cmd === "gh --version") return "gh 2.0\n";
      return "";
    },
    readFile: () => null,
    writeFile: vi.fn(),
    exists: () => false,
    platform: "darwin",
    ...overrides,
  };
}

function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; exitCode: number | undefined }> {
  const logs: string[] = [];
  const orig = console.log;
  let exitCode: number | undefined;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  const origExitCode = process.exitCode;
  return fn()
    .then(() => {
      exitCode = process.exitCode;
      process.exitCode = origExitCode;
      return { logs, exitCode };
    })
    .finally(() => { console.log = orig; });
}

function expectRuntimeConfigDisclosure(result: SetupResult): void {
  expect(result.runtimeConfig).toHaveLength(5);
  expect(result.runtimeConfig).toEqual(expect.arrayContaining([
    {
      scope: "global",
      runtime: "claude-code",
      path: "~/.claude/settings.json",
      purpose: "Allow OpenRig commands without Claude permission prompts.",
    },
    {
      scope: "global",
      runtime: "claude-code",
      path: "~/.claude.json",
      purpose: "Pre-trust managed workspaces and mark Claude onboarding complete.",
    },
    {
      scope: "project",
      runtime: "claude-code",
      path: ".claude/settings.local.json",
      purpose: expect.stringContaining("statusLine"),
    },
    {
      scope: "project",
      runtime: "claude-code",
      path: ".mcp.json",
      purpose: "Configure project-local MCP servers for Claude-managed workspaces.",
    },
    {
      scope: "global",
      runtime: "codex",
      path: "~/.codex/config.toml",
      purpose: "Pre-trust managed workspaces and configure Codex MCP servers.",
    },
  ]));
}

describe("rig setup", () => {
  it("wired via createProgram", async () => {
    const { createProgram } = await import("../src/index.js");
    const program = createProgram();
    const setupCmd = program.commands.find((c) => c.name() === "setup");
    expect(setupCmd).toBeDefined();
  });

  it("--dry-run --json returns structured plan with core profile and expected step ids", async () => {
    const deps = makeDeps();
    const program = new Command();
    program.addCommand(setupCommand(deps));

    const { logs } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "setup", "--dry-run", "--json"]),
    );

    const result = JSON.parse(logs.join("\n")) as SetupResult;
    expect(result.profile).toBe("core");
    expect(result.platform).toBe("darwin");
    const stepIds = result.steps.map((s) => s.id);
    expect(stepIds).toContain("brew");
    expect(stepIds).toContain("tmux_install");
    expect(stepIds).toContain("cmux_install");
    expect(stepIds).toContain("claude_install");
    expect(stepIds).toContain("claude_auth");
    expect(stepIds).toContain("codex_install");
    expect(stepIds).toContain("codex_auth");
    expect(stepIds).toContain("tmux_config");
    expect(stepIds).toContain("verify");
    // No full-profile extras
    expect(stepIds).not.toContain("jq_install");
    expect(stepIds).not.toContain("gh_install");
    // All steps should be skipped in dry run
    expect(result.steps.every((s) => s.status === "skipped")).toBe(true);
    expectRuntimeConfigDisclosure(result);
  });

  it("--dry-run --full --json includes full profile with core + extra step ids", async () => {
    const deps = makeDeps();
    const program = new Command();
    program.addCommand(setupCommand(deps));

    const { logs } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "setup", "--dry-run", "--full", "--json"]),
    );

    const result = JSON.parse(logs.join("\n")) as SetupResult;
    expect(result.profile).toBe("full");
    const stepIds = result.steps.map((s) => s.id);
    // Core steps still present
    expect(stepIds).toContain("brew");
    expect(stepIds).toContain("tmux_install");
    expect(stepIds).toContain("cmux_install");
    expect(stepIds).toContain("claude_install");
    expect(stepIds).toContain("claude_auth");
    expect(stepIds).toContain("codex_install");
    expect(stepIds).toContain("codex_auth");
    expect(stepIds).toContain("tmux_config");
    expect(stepIds).toContain("verify");
    // Full extras added
    expect(stepIds).toContain("jq_install");
    expect(stepIds).toContain("gh_install");
  });

  it("--dry-run --json exits 0 (plan-only, not a failure)", async () => {
    const deps = makeDeps();
    const program = new Command();
    program.addCommand(setupCommand(deps));

    const { exitCode } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "setup", "--dry-run", "--json"]),
    );

    expect(exitCode).toBeUndefined(); // undefined means 0
  });

  it("--dry-run does not make mutating exec calls", async () => {
    const execSpy = vi.fn(() => "");
    const deps = makeDeps({ exec: execSpy });
    await runSetup(deps, { dryRun: true });
    expect(execSpy).not.toHaveBeenCalled();
  });

  it("core profile execution with all tools present returns pass/applied steps and ready=true", async () => {
    const writeSpy = vi.fn();
    const deps = makeDeps({ writeFile: writeSpy });
    const result = await runSetup(deps, {});

    expect(result.profile).toBe("core");
    expect(result.ready).toBe(true);

    const brew = result.steps.find((s) => s.id === "brew");
    expect(brew?.status).toBe("pass");

    const tmux = result.steps.find((s) => s.id === "tmux_install");
    expect(tmux?.status).toBe("pass");

    const cmux = result.steps.find((s) => s.id === "cmux_install");
    expect(cmux?.status).toBe("pass");

    const claudeInstall = result.steps.find((s) => s.id === "claude_install");
    expect(claudeInstall?.status).toBe("pass");

    const claudeAuth = result.steps.find((s) => s.id === "claude_auth");
    expect(claudeAuth?.status).toBe("pass");

    const codexInstall = result.steps.find((s) => s.id === "codex_install");
    expect(codexInstall?.status).toBe("pass");

    const codexAuth = result.steps.find((s) => s.id === "codex_auth");
    expect(codexAuth?.status).toBe("pass");

    const tmuxConfig = result.steps.find((s) => s.id === "tmux_config");
    expect(tmuxConfig?.status).toBe("applied");

    const verify = result.steps.find((s) => s.id === "verify");
    expect(verify?.status).toBe("pass");
  });

  it("full profile extends core with jq_install and gh_install", async () => {
    const deps = makeDeps();
    const result = await runSetup(deps, { full: true });

    expect(result.profile).toBe("full");
    const stepIds = result.steps.map((s) => s.id);
    // Core steps present
    expect(stepIds).toContain("brew");
    expect(stepIds).toContain("tmux_install");
    // Full extras present
    expect(stepIds).toContain("jq_install");
    expect(stepIds).toContain("gh_install");

    const jq = result.steps.find((s) => s.id === "jq_install");
    expect(jq?.status).toBe("pass");
    const gh = result.steps.find((s) => s.id === "gh_install");
    expect(gh?.status).toBe("pass");
  });

  it("installs missing Claude Code with npm and verifies auth", async () => {
    let claudeInstalled = false;
    const deps = makeDeps({
      exec: (cmd: string) => {
        if (cmd === "brew --version") return "Homebrew 4.0\n";
        if (cmd === "tmux -V") return "tmux 3.4\n";
        if (cmd === "cmux capabilities --json") return '{"capabilities":[]}\n';
        if (cmd === "claude --version") {
          if (claudeInstalled) return "2.1.101 (Claude Code)\n";
          throw new Error("command not found: claude");
        }
        if (cmd === "npm install -g @anthropic-ai/claude-code") {
          claudeInstalled = true;
          return "installed claude\n";
        }
        if (cmd === "claude auth status") return "Authenticated\n";
        if (cmd === "codex --version") return "codex-cli 0.118.0\n";
        if (cmd === "codex login status") return "Logged in\n";
        return "";
      },
    });

    const result = await runSetup(deps, {});

    const claudeInstall = result.steps.find((s) => s.id === "claude_install");
    expect(claudeInstall?.status).toBe("applied");

    const claudeAuth = result.steps.find((s) => s.id === "claude_auth");
    expect(claudeAuth?.status).toBe("pass");
  });

  it("fails setup honestly when Codex is installed but not logged in", async () => {
    const deps = makeDeps({
      exec: (cmd: string) => {
        if (cmd === "brew --version") return "Homebrew 4.0\n";
        if (cmd === "tmux -V") return "tmux 3.4\n";
        if (cmd === "cmux capabilities --json") return '{"capabilities":[]}\n';
        if (cmd === "claude --version") return "2.1.101 (Claude Code)\n";
        if (cmd === "claude auth status") return "Authenticated\n";
        if (cmd === "codex --version") return "codex-cli 0.118.0\n";
        if (cmd === "codex login status") throw new Error("not logged in");
        return "";
      },
    });

    const result = await runSetup(deps, {});

    const codexAuth = result.steps.find((s) => s.id === "codex_auth");
    expect(codexAuth?.status).toBe("fail");
    expect(result.ready).toBe(false);
  });

  it("does not fail Linux setup just because Homebrew is unavailable", async () => {
    const deps = makeDeps({
      platform: "linux",
      exec: (cmd: string) => {
        if (cmd === "tmux -V") return "tmux 3.4\n";
        if (cmd === "cmux capabilities --json") throw new Error("not found");
        if (cmd === "cmux --help") throw new Error("not found");
        if (cmd === "claude --version") return "2.1.101 (Claude Code)\n";
        if (cmd === "claude auth status") return "Authenticated\n";
        if (cmd === "codex --version") return "codex-cli 0.118.0\n";
        if (cmd === "codex login status") return "Logged in\n";
        throw new Error(`unexpected: ${cmd}`);
      },
    });

    const result = await runSetup(deps, {});

    const brew = result.steps.find((s) => s.id === "brew");
    expect(brew?.status).toBe("skipped");
    expect(result.ready).toBe(true);
  });

  it("brew failure does not crash — later brew-dependent steps are skipped honestly", async () => {
    const deps = makeDeps({
      exec: (cmd: string) => {
        if (cmd === "brew --version") throw new Error("command not found: brew");
        if (cmd === "tmux -V") throw new Error("command not found: tmux");
        if (cmd === "cmux capabilities --json") throw new Error("not found");
        if (cmd === "cmux --help") throw new Error("not found");
        throw new Error(`unexpected: ${cmd}`);
      },
    });
    const result = await runSetup(deps, {});

    expect(result.ready).toBe(false);

    const brew = result.steps.find((s) => s.id === "brew");
    expect(brew?.status).toBe("fail");

    const tmux = result.steps.find((s) => s.id === "tmux_install");
    expect(tmux?.status).toBe("skipped");

    const cmux = result.steps.find((s) => s.id === "cmux_install");
    expect(cmux?.status).toBe("skipped");

    // verify step should reflect the failures
    const verify = result.steps.find((s) => s.id === "verify");
    expect(verify?.status).toBe("warn");
  });

  it("result includes verification section with real doctor check names including async cmux_daemon", async () => {
    const deps = makeDeps();
    const doctorDeps: DoctorDeps = {
      exists: () => true,
      baseDir: "/install/cli/dist",
      exec: (cmd: string) => {
        if (cmd === "tmux -V") return "tmux 3.4\n";
        if (cmd === "cmux capabilities --json") return '{"capabilities":["surface.focus"]}\n';
        if (cmd === "cmux --help") return "cmux help\n";
        return "";
      },
      checkPort: async () => true,
      configStore: { resolve: () => ({ daemon: { port: 7433, host: "127.0.0.1" }, db: { path: "/tmp/openrig/openrig.sqlite" }, transcripts: { enabled: true, path: "/tmp/openrig/transcripts" } }) },
      platform: "darwin",
      mkdirp: () => {},
      checkWritable: () => {},
      fetch: async () => { throw new Error("ECONNREFUSED"); },
    };

    const result = await runSetup(deps, { doctorDeps });

    // verification section must exist
    expect(result.verification).toBeDefined();
    expect(Array.isArray(result.verification!.checks)).toBe(true);

    const checkNames = result.verification!.checks.map((c) => c.name);
    // Must include real doctor check names
    expect(checkNames).toContain("node_version");
    expect(checkNames).toContain("tmux");
    expect(checkNames).toContain("cmux_shell");
    // Must include async doctor check (cmux_daemon resolved)
    expect(checkNames).toContain("cmux_daemon");

    // cmux_daemon should be skipped (daemon not reachable)
    const cmuxDaemon = result.verification!.checks.find((c) => c.name === "cmux_daemon");
    expect(cmuxDaemon?.status).toBe("skipped");

    // Doctor statuses used as-is, not renamed
    const nodeCheck = result.verification!.checks.find((c) => c.name === "node_version");
    expect(["pass", "warn", "fail", "skipped"]).toContain(nodeCheck?.status);
  });

  it("non-dry-run results include the same structured runtime config disclosure", async () => {
    const deps = makeDeps();

    const result = await runSetup(deps, {});

    expectRuntimeConfigDisclosure(result);
  });

  it("ready is false only when setup steps or verification checks have fail status", async () => {
    // All tools present, all doctor checks pass
    const deps = makeDeps();
    const doctorDeps: DoctorDeps = {
      exists: () => true,
      baseDir: "/install/cli/dist",
      exec: (cmd: string) => {
        if (cmd === "tmux -V") return "tmux 3.4\n";
        if (cmd === "cmux capabilities --json") return '{"capabilities":["surface.focus"]}\n';
        if (cmd === "cmux --help") return "cmux help\n";
        return "";
      },
      checkPort: async () => true,
      configStore: { resolve: () => ({ daemon: { port: 7433, host: "127.0.0.1" }, db: { path: "/tmp/openrig/openrig.sqlite" }, transcripts: { enabled: true, path: "/tmp/openrig/transcripts" } }) },
      platform: "darwin",
      mkdirp: () => {},
      checkWritable: () => {},
      fetch: async () => { throw new Error("ECONNREFUSED"); },
    };

    const result = await runSetup(deps, { doctorDeps });

    // No fail statuses in steps or verification -> ready=true
    expect(result.ready).toBe(true);

    // warn/skipped alone do not flip ready to false
    const hasWarnOrSkipped = [
      ...result.steps,
      ...(result.verification?.checks ?? []),
    ].some((c) => c.status === "warn" || c.status === "skipped");
    // cmux_daemon is skipped, so this should be true
    expect(hasWarnOrSkipped).toBe(true);
    // But ready is still true
    expect(result.ready).toBe(true);
  });

  it("tmux install failure returns structured fail, does not crash setup", async () => {
    const deps = makeDeps({
      exec: (cmd: string) => {
        if (cmd === "brew --version") return "Homebrew 4.0\n";
        if (cmd === "tmux -V") throw new Error("not found");
        if (cmd === "brew install tmux") throw new Error("brew install failed");
        if (cmd === "cmux capabilities --json") return '{"capabilities":[]}\n';
        return "";
      },
    });
    const result = await runSetup(deps, {});

    const tmux = result.steps.find((s) => s.id === "tmux_install");
    expect(tmux?.status).toBe("fail");
    expect(result.ready).toBe(false);

    // Other steps still attempted
    const cmux = result.steps.find((s) => s.id === "cmux_install");
    expect(cmux).toBeDefined();
    expect(cmux?.status).toBe("pass");
  });
});
