import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { setupCommand, runSetup, type SetupDeps, type SetupResult } from "../src/commands/setup.js";

function makeDeps(overrides?: Partial<SetupDeps>): SetupDeps {
  return {
    exec: (cmd: string) => {
      if (cmd === "brew --version") return "Homebrew 4.0\n";
      if (cmd === "tmux -V") return "tmux 3.4\n";
      if (cmd === "cmux capabilities --json") return '{"capabilities":[]}\n';
      if (cmd === "cmux --help") return "cmux help\n";
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
    expect(stepIds).toContain("tmux_config");
    expect(stepIds).toContain("verify");
    // No full-profile extras
    expect(stepIds).not.toContain("jq_install");
    expect(stepIds).not.toContain("gh_install");
    // All steps should be skipped in dry run
    expect(result.steps.every((s) => s.status === "skipped")).toBe(true);
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

  it("--dry-run does not make mutating exec calls", () => {
    const execSpy = vi.fn(() => "");
    const deps = makeDeps({ exec: execSpy });
    runSetup(deps, { dryRun: true });
    expect(execSpy).not.toHaveBeenCalled();
  });

  it("core profile execution with all tools present returns pass/applied steps and ready=true", () => {
    const writeSpy = vi.fn();
    const deps = makeDeps({ writeFile: writeSpy });
    const result = runSetup(deps, {});

    expect(result.profile).toBe("core");
    expect(result.ready).toBe(true);

    const brew = result.steps.find((s) => s.id === "brew");
    expect(brew?.status).toBe("pass");

    const tmux = result.steps.find((s) => s.id === "tmux_install");
    expect(tmux?.status).toBe("pass");

    const cmux = result.steps.find((s) => s.id === "cmux_install");
    expect(cmux?.status).toBe("pass");

    const tmuxConfig = result.steps.find((s) => s.id === "tmux_config");
    expect(tmuxConfig?.status).toBe("applied");

    const verify = result.steps.find((s) => s.id === "verify");
    expect(verify?.status).toBe("pass");
  });

  it("full profile extends core with jq_install and gh_install", () => {
    const deps = makeDeps();
    const result = runSetup(deps, { full: true });

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

  it("brew failure does not crash — later brew-dependent steps are skipped honestly", () => {
    const deps = makeDeps({
      exec: (cmd: string) => {
        if (cmd === "brew --version") throw new Error("command not found: brew");
        if (cmd === "tmux -V") throw new Error("command not found: tmux");
        if (cmd === "cmux capabilities --json") throw new Error("not found");
        if (cmd === "cmux --help") throw new Error("not found");
        throw new Error(`unexpected: ${cmd}`);
      },
    });
    const result = runSetup(deps, {});

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

  it("tmux install failure returns structured fail, does not crash setup", () => {
    const deps = makeDeps({
      exec: (cmd: string) => {
        if (cmd === "brew --version") return "Homebrew 4.0\n";
        if (cmd === "tmux -V") throw new Error("not found");
        if (cmd === "brew install tmux") throw new Error("brew install failed");
        if (cmd === "cmux capabilities --json") return '{"capabilities":[]}\n';
        return "";
      },
    });
    const result = runSetup(deps, {});

    const tmux = result.steps.find((s) => s.id === "tmux_install");
    expect(tmux?.status).toBe("fail");
    expect(result.ready).toBe(false);

    // Other steps still attempted
    const cmux = result.steps.find((s) => s.id === "cmux_install");
    expect(cmux).toBeDefined();
    expect(cmux?.status).toBe("pass");
  });
});
