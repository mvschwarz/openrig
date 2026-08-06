import { describe, it, expect, vi } from "vitest";
import { createProgram } from "../src/index.js";
import { Command } from "commander";
import { parse as parseYaml } from "yaml";
import { setupCommand, runSetup, goldenPathNextSteps, permissionPolicyMenuLines, type SetupDeps, type SetupResult } from "../src/commands/setup.js";
import type { DoctorDeps } from "../src/commands/doctor.js";
import { resolveCmuxSettingsPath } from "../src/cmux-config.js";

const CMUX_SETTINGS_PATH = resolveCmuxSettingsPath();

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
    mkdirp: vi.fn(),
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
  // OPR.0.4.8.2 agnostic rip-out: the ~/.claude/settings.json disclosure (the global allow-list,
  // C2) is REMOVED — OpenRig no longer writes that file. Disclosure drops from 6 to 5 entries.
  expect(result.runtimeConfig).toHaveLength(5);
  expect(result.runtimeConfig.find((d) => d.path === "~/.claude/settings.json")).toBeUndefined();
  expect(result.runtimeConfig).toEqual(expect.arrayContaining([
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
      purpose: "Apply selected Claude MCP runtime-resource fragments.",
    },
    {
      scope: "global",
      runtime: "codex",
      path: "~/.codex/config.toml",
      purpose: "Pre-trust managed workspaces and apply selected Codex config runtime-resource fragments.",
    },
    {
      scope: "global",
      runtime: "cmux",
      path: "~/.config/cmux/settings.json",
      purpose: "Set cmux socket control to an OpenRig-compatible automation mode.",
    },
  ]));
}

describe("rig setup", () => {
  it("wired via createProgram", async () => {
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
    expect(cmux?.status).toBe("applied");

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

  // OPR.0.3.3.04.2 (AC-1): the ONE canonical ordered golden path over EXISTING
  // verbs (no mega-command), in sequence, with the durable doc reference.
  it("AC-1: goldenPathNextSteps is the ordered sequence over existing verbs, with the durable doc", () => {
    const out = goldenPathNextSteps().join("\n");
    const upIdx = out.indexOf("rig up");
    const statusIdx = out.indexOf("rig status");
    const wsIdx = out.indexOf("rig workspace doctor");
    const wfIdx = out.indexOf("rig workflow instantiate");
    const scopeIdx = out.indexOf("rig scope");
    expect(upIdx).toBeGreaterThan(-1);
    expect(statusIdx).toBeGreaterThan(upIdx);
    expect(wsIdx).toBeGreaterThan(statusIdx);
    expect(wfIdx).toBeGreaterThan(wsIdx);
    expect(scopeIdx).toBeGreaterThan(wfIdx);
    expect(out).toContain("docs/reference/getting-started.md");
    // no magic mega-command - the path is existing verbs only
    expect(out).not.toMatch(/rig (journey|onboarding)\b/);
    // built-in discovery surface is `rig workflow specs` (lists registered specs,
    // built-ins tagged "(built-in)"), NOT `rig workflow list` (lists instances) -
    // the path must point a fresh operator at the right discovery command.
    expect(out).toContain("rig workflow specs");
    expect(out).not.toContain("rig workflow list");
  });

  it("fails setup honestly when tmux is installed but the default control socket is unhealthy", async () => {
    const deps = makeDeps({
      exec: (cmd: string) => {
        if (cmd === "brew --version") return "Homebrew 4.0\n";
        if (cmd === "tmux -V") return "tmux 3.4\n";
        if (cmd === "tmux list-sessions") throw new Error("server exited unexpectedly");
        if (cmd === "cmux capabilities --json") return '{"capabilities":[]}\n';
        if (cmd === "cmux --help") return "cmux help\n";
        if (cmd === "claude --version") return "2.1.101 (Claude Code)\n";
        if (cmd === "claude auth status") return "Authenticated\n";
        if (cmd === "codex --version") return "codex-cli 0.118.0\n";
        if (cmd === "codex login status") return "Logged in\n";
        return "";
      },
    });

    const result = await runSetup(deps, {});

    const tmux = result.steps.find((s) => s.id === "tmux_install");
    expect(tmux?.status).toBe("fail");
    expect(tmux?.message).toContain("control socket");
    expect(tmux?.reason).toContain("server exited unexpectedly");
    expect(tmux?.fixHint).toContain("restart the default tmux server");
    expect(result.ready).toBe(false);
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
        if (cmd === "tmux list-sessions") return "";
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
        if (cmd === "tmux list-sessions") throw new Error("command not found: tmux");
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
      readFile: () => null,
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
      readFile: () => null,
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
    expect(cmux?.status).toBe("applied");
  });

  it("enables cmux automation mode on macOS when cmux is installed but not yet controllable", async () => {
    let cmuxReady = false;
    const seen: string[] = [];
    const writeSpy = vi.fn();
    const deps = makeDeps({
      readFile: (filePath: string) => filePath === CMUX_SETTINGS_PATH ? null : null,
      writeFile: writeSpy,
      exec: (cmd: string) => {
        seen.push(cmd);
        if (cmd === "brew --version") return "Homebrew 4.0\n";
        if (cmd === "tmux -V") return "tmux 3.4\n";
        if (cmd === "cmux capabilities --json") {
          if (cmuxReady) return '{"methods":["surface.focus"]}\n';
          throw new Error("socket not ready");
        }
        if (cmd === "cmux --help") return "cmux help\n";
        if (cmd === "open -a /Applications/cmux.app") {
          cmuxReady = true;
          return "";
        }
        if (cmd === "claude --version") return "2.1.101 (Claude Code)\n";
        if (cmd === "claude auth status") return "Authenticated\n";
        if (cmd === "codex --version") return "codex-cli 0.118.0\n";
        if (cmd === "codex login status") return "Logged in\n";
        return "";
      },
    });

    const result = await runSetup(deps, {});

    const cmux = result.steps.find((s) => s.id === "cmux_install");
    expect(cmux?.status).toBe("applied");
    expect(cmux?.message).toContain("Enabled cmux socket control");
    expect(seen).toContain("open -a /Applications/cmux.app");
    expect(writeSpy).toHaveBeenCalledWith(
      CMUX_SETTINGS_PATH,
      expect.stringContaining("\"socketControlMode\": \"automation\""),
    );
    expect(result.ready).toBe(true);
  });

  it("normalizes restrictive cmux socket control on macOS even when shell cmux already works", async () => {
    const seen: string[] = [];
    const writeSpy = vi.fn();
    const doctorDeps: DoctorDeps = {
      exists: () => true,
      baseDir: "/install/cli/dist",
      readFile: () => null,
      exec: (cmd: string) => {
        if (cmd === "tmux -V") return "tmux 3.4\n";
        if (cmd === "cmux capabilities --json") return '{"capabilities":["surface.focus"]}\n';
        if (cmd === "cmux --help") return "cmux help\n";
        return "";
      },
      checkPort: async () => false,
      configStore: { resolve: () => ({ daemon: { port: 7433, host: "127.0.0.1" }, db: { path: "/tmp/openrig/openrig.sqlite" }, transcripts: { enabled: true, path: "/tmp/openrig/transcripts" } }) },
      platform: "darwin",
      mkdirp: () => {},
      checkWritable: () => {},
      fetch: async (url: string) => {
        if (url.includes("/healthz")) return { ok: true };
        if (url.includes("/api/adapters/cmux/status")) return { ok: true, json: async () => ({ available: true }) };
        throw new Error(`unexpected fetch ${url}`);
      },
    };
    const deps = makeDeps({
      readFile: (filePath: string) => filePath === CMUX_SETTINGS_PATH ? "{\n  \"automation\": {\n    \"socketControlMode\": \"cmuxOnly\"\n  }\n}\n" : null,
      writeFile: writeSpy,
      exec: (cmd: string) => {
        seen.push(cmd);
        if (cmd === "brew --version") return "Homebrew 4.0\n";
        if (cmd === "tmux -V") return "tmux 3.4\n";
        if (cmd === "cmux capabilities --json") return '{"capabilities":["surface.focus"]}\n';
        if (cmd === "cmux --help") return "cmux help\n";
        if (cmd === "cmux reload-config") return "";
        if (cmd === "claude --version") return "2.1.101 (Claude Code)\n";
        if (cmd === "claude auth status") return "Authenticated\n";
        if (cmd === "codex --version") return "codex-cli 0.118.0\n";
        if (cmd === "codex login status") return "Logged in\n";
        return "";
      },
    });

    const result = await runSetup(deps, { doctorDeps });

    const cmux = result.steps.find((s) => s.id === "cmux_install");
    expect(cmux?.status).toBe("applied");
    expect(cmux?.message).toContain("automation");
    expect(seen).toContain("cmux reload-config");
    expect(writeSpy).toHaveBeenCalledWith(
      CMUX_SETTINGS_PATH,
      expect.stringContaining("\"socketControlMode\": \"automation\""),
    );
    expect(result.ready).toBe(true);
  });

  it("fails honestly when cmux stays uncontrollable after automatic macOS setup", async () => {
    const deps = makeDeps({
      readFile: (filePath: string) => filePath === CMUX_SETTINGS_PATH ? "{\n  \"automation\": {\n    \"socketControlMode\": \"cmuxOnly\"\n  }\n}\n" : null,
      exec: (cmd: string) => {
        if (cmd === "brew --version") return "Homebrew 4.0\n";
        if (cmd === "tmux -V") return "tmux 3.4\n";
        if (cmd === "cmux capabilities --json") throw new Error("broken pipe");
        if (cmd === "cmux --help") return "cmux help\n";
        if (cmd === "open -a /Applications/cmux.app") return "";
        if (cmd === "claude --version") return "2.1.101 (Claude Code)\n";
        if (cmd === "claude auth status") return "Authenticated\n";
        if (cmd === "codex --version") return "codex-cli 0.118.0\n";
        if (cmd === "codex login status") return "Logged in\n";
        return "";
      },
    });

    const result = await runSetup(deps, {});

    const cmux = result.steps.find((s) => s.id === "cmux_install");
    expect(cmux?.status).toBe("fail");
    expect(cmux?.message).toContain("cmux installed but control unavailable");
    expect(result.ready).toBe(false);
  });

  it("does not rewrite compatible password mode when shell cmux already works", async () => {
    const writeSpy = vi.fn();
    const deps = makeDeps({
      readFile: (filePath: string) => filePath === CMUX_SETTINGS_PATH ? "{\n  \"automation\": {\n    \"socketControlMode\": \"password\"\n  }\n}\n" : null,
      writeFile: writeSpy,
      exec: (cmd: string) => {
        if (cmd === "brew --version") return "Homebrew 4.0\n";
        if (cmd === "tmux -V") return "tmux 3.4\n";
        if (cmd === "tmux list-sessions") return "";
        if (cmd === "cmux capabilities --json") return '{"capabilities":["surface.focus"]}\n';
        if (cmd === "cmux --help") return "cmux help\n";
        if (cmd === "claude --version") return "2.1.101 (Claude Code)\n";
        if (cmd === "claude auth status") return "Authenticated\n";
        if (cmd === "codex --version") return "codex-cli 0.118.0\n";
        if (cmd === "codex login status") return "Logged in\n";
        throw new Error(`unexpected: ${cmd}`);
      },
    });

    const result = await runSetup(deps, {});

    const cmux = result.steps.find((s) => s.id === "cmux_install");
    expect(cmux?.status).toBe("pass");
    expect(writeSpy).not.toHaveBeenCalledWith(
      CMUX_SETTINGS_PATH,
      expect.any(String),
    );
    expect(result.ready).toBe(true);
  });

  it("fails setup when shell cmux works but the running daemon still cannot control cmux", async () => {
    const doctorDeps: DoctorDeps = {
      exists: () => true,
      baseDir: "/install/cli/dist",
      readFile: () => null,
      exec: (cmd: string) => {
        if (cmd === "tmux -V") return "tmux 3.4\n";
        if (cmd === "cmux capabilities --json") return '{"capabilities":["surface.focus"]}\n';
        if (cmd === "cmux --help") return "cmux help\n";
        return "";
      },
      checkPort: async () => false,
      configStore: { resolve: () => ({ daemon: { port: 7433, host: "127.0.0.1" }, db: { path: "/tmp/openrig/openrig.sqlite" }, transcripts: { enabled: true, path: "/tmp/openrig/transcripts" } }) },
      platform: "darwin",
      mkdirp: () => {},
      checkWritable: () => {},
      fetch: async (url: string) => {
        if (url.includes("/healthz")) return { ok: true };
        if (url.includes("/api/adapters/cmux/status")) return { ok: true, json: async () => ({ available: false }) };
        throw new Error(`unexpected fetch ${url}`);
      },
    };
    const deps = makeDeps({
      readFile: (filePath: string) => filePath === CMUX_SETTINGS_PATH ? "{\n  \"automation\": {\n    \"socketControlMode\": \"password\"\n  }\n}\n" : null,
    });

    const result = await runSetup(deps, { doctorDeps });

    const cmux = result.steps.find((s) => s.id === "cmux_install");
    expect(cmux?.status).toBe("fail");
    expect(cmux?.message).toContain("running daemon still cannot control cmux");
    expect(result.ready).toBe(false);
  });

  it("gives fresh install commands a longer timeout budget and fails cmux honestly when install still errors", async () => {
    const seenTimeouts = new Map<string, number | undefined>();
    const deps = makeDeps({
      exec: (cmd: string, opts?: { timeoutMs?: number }) => {
        if (cmd === "brew --version") return "Homebrew 4.0\n";
        if (cmd === "tmux -V") return "tmux 3.4\n";
        if (cmd === "tmux list-sessions") throw new Error("error connecting to /tmp/tmux (No such file or directory)");
        if (cmd === "cmux capabilities --json") throw new Error("command not found: cmux");
        if (cmd === "cmux --help") throw new Error("command not found: cmux");
        if (cmd === "brew install --cask cmux") {
          seenTimeouts.set(cmd, opts?.timeoutMs);
          throw new Error("spawnSync /bin/sh ETIMEDOUT");
        }
        if (cmd === "claude --version") return "2.1.101 (Claude Code)\n";
        if (cmd === "claude auth status") return "Authenticated\n";
        if (cmd === "codex --version") return "codex-cli 0.118.0\n";
        if (cmd === "codex login status") return "Logged in\n";
        throw new Error(`unexpected: ${cmd}`);
      },
    });

    const result = await runSetup(deps, {});

    expect(seenTimeouts.get("brew install --cask cmux")).toBe(300000);
    const cmux = result.steps.find((s) => s.id === "cmux_install");
    expect(cmux?.status).toBe("fail");
    expect(cmux?.message).toContain("ETIMEDOUT");
    expect(result.ready).toBe(false);
  });

  it("uses the extended timeout budget for npm runtime installs", async () => {
    const seenTimeouts = new Map<string, number | undefined>();
    let claudeInstalled = false;
    let codexInstalled = false;
    const deps = makeDeps({
      exec: (cmd: string, opts?: { timeoutMs?: number }) => {
        if (cmd === "brew --version") return "Homebrew 4.0\n";
        if (cmd === "tmux -V") return "tmux 3.4\n";
        if (cmd === "tmux list-sessions") return "";
        if (cmd === "cmux capabilities --json") return '{"capabilities":[]}\n';
        if (cmd === "claude --version") {
          if (claudeInstalled) return "2.1.101 (Claude Code)\n";
          throw new Error("command not found: claude");
        }
        if (cmd === "npm install -g @anthropic-ai/claude-code") {
          seenTimeouts.set(cmd, opts?.timeoutMs);
          claudeInstalled = true;
          return "installed claude\n";
        }
        if (cmd === "claude auth status") return "Authenticated\n";
        if (cmd === "codex --version") {
          if (codexInstalled) return "codex-cli 0.118.0\n";
          throw new Error("command not found: codex");
        }
        if (cmd === "npm install -g @openai/codex") {
          seenTimeouts.set(cmd, opts?.timeoutMs);
          codexInstalled = true;
          return "installed codex\n";
        }
        if (cmd === "codex login status") return "Logged in\n";
        throw new Error(`unexpected: ${cmd}`);
      },
    });

    const result = await runSetup(deps, {});

    expect(result.ready).toBe(true);
    expect(seenTimeouts.get("npm install -g @anthropic-ai/claude-code")).toBe(300000);
    expect(seenTimeouts.get("npm install -g @openai/codex")).toBe(300000);
  });
});

// Slice-03 Lane B (0.4.8) onboarding RECORD path. RULING-C b4913ed4: the v1 menu EDITS/RECORDS into
// an EXISTING spec only (chosen -> permission_policy: builtin:<name>; deliberate-none ->
// permission_policy: none); NEW INSTALL = no spec = NOTHING WRITTEN = floor by absence. Persistence =
// the RigSpec permission_policy ONLY (P6 fence). Invariants: P3 write-on-explicit-selection-ONLY,
// P1 no absent->deliberate_none upgrade, P2 honest render.
describe("rig setup --policy (onboarding record)", () => {
  const SPEC = "/tmp/onboard-demo/rig.yaml";
  const BASE_SPEC = 'version: "1"\nname: demo-rig\npods: []\nedges: []\n';

  function specDeps(initial: string | null, sink: Record<string, string>): SetupDeps {
    return makeDeps({
      readFile: (p: string) => (p === SPEC ? (p in sink ? sink[p] : initial) : null),
      exists: (p: string) => p === SPEC && (initial !== null || p in sink),
      writeFile: (p: string, c: string) => { sink[p] = c; },
    });
  }

  it("--policy standard records permission_policy: builtin:standard into the existing spec (chosen builtin), least-destructively", async () => {
    const sink: Record<string, string> = {};
    const deps = specDeps(BASE_SPEC, sink);

    const result = await runSetup(deps, { policy: "standard", specPath: SPEC });

    const step = result.steps.find((s) => s.id === "policy_record");
    expect(step?.status).toBe("applied");
    expect(sink[SPEC]).toBeDefined();
    const parsed = parseYaml(sink[SPEC]!) as Record<string, unknown>;
    expect(parsed["permission_policy"]).toBe("builtin:standard");
    // least-destructive: all other keys survive the record.
    expect(parsed["name"]).toBe("demo-rig");
    expect(parsed["version"]).toBe("1");
    expect(parsed["pods"]).toEqual([]);
  });

  it("least-destructive record: preserves comment text/order/quoting/structure, appending ONLY the permission_policy line", async () => {
    const sink: Record<string, string> = {};
    // DISCRIMINATING fixture — a commented, hand-authored-style spec. A parse+serialize round-trip
    // (the pre-revision impl) DROPS every comment here, so this pin is RED against that impl BY
    // CONSTRUCTION; a comment-preserving edit reproduces the file byte-for-byte plus the one new line.
    // SCOPE (honest API limit, probed at the lib): parseDocument preserves comment TEXT, key ORDER,
    // QUOTING, and STRUCTURE — but pre-`#` padding may NORMALIZE (e.g. multiple spaces -> one). This
    // fixture uses single-space padding (parseDocument's fixed point) so the byte-equality is exact;
    // the claim is scoped accordingly, not "every byte of arbitrary formatting survives".
    const commented =
      "# hand-authored: do not clobber\n" +
      'version: "1"\n' +
      "name: demo-rig # the rig name\n" +
      "pods: [] # no pods yet\n" +
      "edges: []\n";
    const deps = specDeps(commented, sink);

    await runSetup(deps, { policy: "standard", specPath: SPEC });

    const written = sink[SPEC]!;
    // Everything survives byte-for-byte; the ONLY delta is the appended permission_policy line.
    expect(written).toBe(commented + "permission_policy: builtin:standard\n");
  });

  it("maps each chosen built-in name to its builtin:<name> ref", async () => {
    for (const name of ["locked", "standard", "open", "yolo"] as const) {
      const sink: Record<string, string> = {};
      const deps = specDeps(BASE_SPEC, sink);
      await runSetup(deps, { policy: name, specPath: SPEC });
      const parsed = parseYaml(sink[SPEC]!) as Record<string, unknown>;
      expect(parsed["permission_policy"]).toBe(`builtin:${name}`);
    }
  });

  it("--policy none records the deliberate-none value permission_policy: none (the WRITE is base-testable; the PARSE round-trip is cross-lane)", async () => {
    const sink: Record<string, string> = {};
    const deps = specDeps(BASE_SPEC, sink);

    const result = await runSetup(deps, { policy: "none", specPath: SPEC });

    const step = result.steps.find((s) => s.id === "policy_record");
    expect(step?.status).toBe("applied");
    const parsed = parseYaml(sink[SPEC]!) as Record<string, unknown>;
    // Deliberate-none is the EXPLICIT recorded value (origin deliberate_none), NOT absence.
    expect(parsed["permission_policy"]).toBe("none");
  });

  it("P3 + anchor 1: NO --policy => NO policy_record step, NO spec write (bare setup byte-unchanged)", async () => {
    const sink: Record<string, string> = {};
    const deps = specDeps(BASE_SPEC, sink);

    const result = await runSetup(deps, {});

    expect(result.steps.find((s) => s.id === "policy_record")).toBeUndefined();
    // Nothing recorded into the spec on the skip/no-selection path.
    expect(sink[SPEC]).toBeUndefined();
  });

  it("P1 + RULING-C: --policy with NO resolvable existing spec records NOTHING (fail step, no phantom write)", async () => {
    const sink: Record<string, string> = {};
    // No spec present anywhere: readFile null, exists false.
    const deps = specDeps(null, sink);

    const result = await runSetup(deps, { policy: "standard", specPath: SPEC });

    const step = result.steps.find((s) => s.id === "policy_record");
    expect(step?.status).toBe("fail");
    expect(sink[SPEC]).toBeUndefined();
    // A record failure must not silently pass as ready.
    expect(result.ready).toBe(false);
  });

  it("rejects an unknown --policy name, records NOTHING", async () => {
    const sink: Record<string, string> = {};
    const deps = specDeps(BASE_SPEC, sink);

    const result = await runSetup(deps, { policy: "bananas" as never, specPath: SPEC });

    const step = result.steps.find((s) => s.id === "policy_record");
    expect(step?.status).toBe("fail");
    // The rejection surfaces the valid set to the operator (message + reason are what they see).
    expect(`${step?.message ?? ""} ${step?.reason ?? ""}`).toMatch(/locked, standard, open, yolo, none/);
    expect(sink[SPEC]).toBeUndefined();
  });

  it("re-recording overwrites a prior permission_policy in place (no duplication)", async () => {
    const sink: Record<string, string> = {};
    const deps = specDeps('version: "1"\nname: demo-rig\npermission_policy: builtin:locked\npods: []\nedges: []\n', sink);

    await runSetup(deps, { policy: "open", specPath: SPEC });

    const written = sink[SPEC]!;
    const parsed = parseYaml(written) as Record<string, unknown>;
    expect(parsed["permission_policy"]).toBe("builtin:open");
    // exactly one permission_policy key in the serialized form.
    expect(written.match(/permission_policy:/g)?.length).toBe(1);
  });

  it("wires --policy and --spec options on the setup command", () => {
    const cmd = setupCommand(makeDeps());
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain("--policy");
    expect(longs).toContain("--spec");
  });

  // CONVERGED @tip 909c33e2 — Lane A's amendment (05931d33, ruled form 5f37e40f) activated
  // `permission_policy: none` as the recorded deliberate_none choice. The cross-lane round-trip is
  // realized at the SANCTIONED ALTITUDE SPLIT (pre-approved by acting-orch), keeping the P6 fence the
  // QA verified — the CLI never imports the daemon:
  //   - CLI WRITE half (asserted here): `--policy none` emits the ruled deliberate_none token
  //     `permission_policy: none` (not a builtin: ref, not an absent field).
  //   - daemon PARSE half: that exact form resolves to origin=deliberate_none, floor==absent, and
  //     NEVER reads a file — proven in packages/daemon/test/deliberate-none-amendment.test.ts.
  // Forcing the parse assertion into this CLI file would require a daemon import — exactly the P6
  // breach the split avoids.
  it("cross-lane round-trip WRITE half: --policy none emits the ruled deliberate_none token (parse half proven daemon-side)", async () => {
    const sink: Record<string, string> = {};
    const deps = specDeps(BASE_SPEC, sink);

    await runSetup(deps, { policy: "none", specPath: SPEC });

    expect(sink[SPEC]).toContain("permission_policy: none\n");
    const parsed = parseYaml(sink[SPEC]!) as Record<string, unknown>;
    expect(parsed["permission_policy"]).toBe("none");
  });
});

// Slice-03 Lane B onboarding MENU COPY. The 0.4.8 lineage has NO TUI, so the "menu" is calm-register
// narrative text presenting the choice. Copy is FROZEN (MENU-COPY-FROZEN-2026-08-04, founder-picked):
// verbatim labels, no "Operator" in copy, exact deliberate-none + skip-line phrasing, NO pre-selected
// default, Standard carries the ⭐ recommendation marker. P2: the render is honest (three-way).
describe("rig setup permission-policy menu copy (frozen)", () => {
  it("renders the frozen top-level labels verbatim", () => {
    const out = permissionPolicyMenuLines().join("\n");
    expect(out).toContain("Policy Mode");
    expect(out).toContain("YOLO Mode");
  });

  it("renders the exact frozen deliberate-none and skip-line copy", () => {
    const out = permissionPolicyMenuLines().join("\n");
    expect(out).toContain("No policy — deliberate choice (recorded)");
    expect(out).toContain("If you skip: OpenRig sets nothing — the usability floor only");
  });

  it("marks Standard with the ⭐ recommendation marker and pre-selects nothing", () => {
    const lines = permissionPolicyMenuLines();
    const standardLine = lines.find((l) => l.includes("Standard"));
    expect(standardLine).toBeDefined();
    expect(standardLine!).toContain("⭐");
    // NO pre-selected default (the ⭐ is a recommendation, not a selection).
    expect(permissionPolicyMenuLines().join("\n")).not.toMatch(/\(default\)|\[selected\]|pre-selected/i);
  });

  it("never names 'Operator' in the copy (YOLO Mode is the user-facing label)", () => {
    expect(permissionPolicyMenuLines().join("\n")).not.toContain("Operator");
  });

  it("holds the calm register — no editorializing / founder-internal wording", () => {
    const out = permissionPolicyMenuLines().join("\n").toLowerCase();
    for (const banned of ["treacherous", "dangerous", "yolo mode is reckless", "footgun"]) {
      expect(out).not.toContain(banned);
    }
  });
});
