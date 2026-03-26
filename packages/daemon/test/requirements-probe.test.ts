import { describe, it, expect, vi } from "vitest";
import { RequirementsProbeRegistry, type RequirementSpec } from "../src/domain/requirements-probe.js";
import type { ExecFn } from "../src/adapters/tmux.js";

function createMockExec(responses: Record<string, string | Error>): ExecFn {
  return vi.fn(async (cmd: string) => {
    for (const [pattern, response] of Object.entries(responses)) {
      if (cmd.includes(pattern)) {
        if (response instanceof Error) throw response;
        return response;
      }
    }
    throw new Error(`command not found`);
  }) as unknown as ExecFn;
}

describe("RequirementsProbeRegistry", () => {
  // T1: CLI tool installed — status='installed', detectedPath populated, version=null
  it("CLI tool installed returns installed with detectedPath and null version", async () => {
    const exec = createMockExec({ "command -v": "/usr/local/bin/ripgrep" });
    const registry = new RequirementsProbeRegistry(exec);

    const result = await registry.probeCli("ripgrep");

    expect(result.status).toBe("installed");
    expect(result.detectedPath).toBe("/usr/local/bin/ripgrep");
    expect(result.version).toBeNull();
    expect(result.kind).toBe("cli_tool");
  });

  // T2: CLI tool missing — status='missing'
  it("CLI tool missing returns missing status", async () => {
    const exec = createMockExec({});
    const registry = new RequirementsProbeRegistry(exec);

    const result = await registry.probeCli("nonexistent-tool");

    expect(result.status).toBe("missing");
    expect(result.detectedPath).toBeNull();
  });

  // T3: Homebrew package installed — version parsed, provider='homebrew'
  it("Homebrew package installed returns installed with parsed version", async () => {
    const exec = createMockExec({ "brew list --versions": "ripgrep 14.1.0" });
    const registry = new RequirementsProbeRegistry(exec, { platform: "darwin" });

    const result = await registry.probeBrew("ripgrep");

    expect(result.status).toBe("installed");
    expect(result.version).toBe("14.1.0");
    expect(result.provider).toBe("homebrew");
    expect(result.kind).toBe("system_package");
  });

  // T4: Homebrew package missing — status='missing', provider='homebrew'
  it("Homebrew package missing returns missing with homebrew provider", async () => {
    const exec = createMockExec({ "brew list --versions": new Error("Error: No such keg") });
    const registry = new RequirementsProbeRegistry(exec, { platform: "darwin" });

    const result = await registry.probeBrew("nonexistent-pkg");

    expect(result.status).toBe("missing");
    expect(result.provider).toBe("homebrew");
  });

  // T5: Non-darwin system_package — status='unsupported', command=null, no exec called
  it("non-darwin system_package returns unsupported with null command", async () => {
    const exec = vi.fn() as unknown as ExecFn;
    const registry = new RequirementsProbeRegistry(exec, { platform: "linux" });

    const result = await registry.probeRequirement({ name: "libssl", kind: "system_package" });

    expect(result.status).toBe("unsupported");
    expect(result.command).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });

  // T6: Probe timeout — status='unknown', error contains 'timed out'
  it("probe timeout returns unknown with timeout error", async () => {
    const exec: ExecFn = () => new Promise(() => {}); // Never resolves
    const registry = new RequirementsProbeRegistry(exec, { timeoutMs: 50 });

    const result = await registry.probeCli("slow-tool");

    expect(result.status).toBe("unknown");
    expect(result.error).toContain("timed out");
  });

  // T7: probeAll returns results in input order
  it("probeAll returns results in input order", async () => {
    const exec = createMockExec({
      "'git'": "/usr/bin/git",
      "'node'": "/usr/local/bin/node",
      "'missing'": new Error("not found"),
    });
    const registry = new RequirementsProbeRegistry(exec);

    const specs: RequirementSpec[] = [
      { name: "git", kind: "cli_tool" },
      { name: "missing", kind: "cli_tool" },
      { name: "node", kind: "cli_tool" },
    ];

    const results = await registry.probeAll(specs);

    expect(results).toHaveLength(3);
    expect(results[0]!.name).toBe("git");
    expect(results[0]!.status).toBe("installed");
    expect(results[1]!.name).toBe("missing");
    expect(results[1]!.status).toBe("missing");
    expect(results[2]!.name).toBe("node");
    expect(results[2]!.status).toBe("installed");
  });

  // T8: command field matches exact shell-quoted command string
  it("probe results include exact shell-quoted command", async () => {
    const exec = createMockExec({ "command -v": "/usr/bin/tmux" });
    const registry = new RequirementsProbeRegistry(exec);

    const result = await registry.probeCli("tmux");

    expect(result.command).toBe("command -v 'tmux'");
  });

  // T9: All probes use mock ExecFn — verify expected commands
  it("probes use mock ExecFn with expected shell-quoted commands", async () => {
    const exec = vi.fn(async () => "/usr/bin/test") as unknown as ExecFn;
    const registry = new RequirementsProbeRegistry(exec, { platform: "darwin" });

    await registry.probeCli("my-tool");
    expect(exec).toHaveBeenCalledWith("command -v 'my-tool'");

    await registry.probeBrew("my-pkg");
    expect(exec).toHaveBeenCalledWith("brew list --versions 'my-pkg'");
  });

  // T10: Probe specific tools (tmux, claude, codex) — each returns installed
  it("probe tmux, claude, codex each returns installed", async () => {
    const exec = createMockExec({
      "'tmux'": "/usr/local/bin/tmux",
      "'claude'": "/usr/local/bin/claude",
      "'codex'": "/usr/local/bin/codex",
    });
    const registry = new RequirementsProbeRegistry(exec);

    const specs: RequirementSpec[] = [
      { name: "tmux", kind: "cli_tool" },
      { name: "claude", kind: "cli_tool" },
      { name: "codex", kind: "cli_tool" },
    ];

    const results = await registry.probeAll(specs);

    for (const result of results) {
      expect(result.status).toBe("installed");
      expect(result.detectedPath).toBeTruthy();
      expect(result.command).toContain("command -v");
    }
  });

  // T11: Shell metacharacter in name — exec receives shell-quoted command
  it("shell metacharacters in name are quoted safely", async () => {
    const exec = vi.fn(async () => { throw new Error("not found"); }) as unknown as ExecFn;
    const registry = new RequirementsProbeRegistry(exec);

    await registry.probeCli("foo; rm -rf /");

    // The name should be single-quoted, preventing injection
    expect(exec).toHaveBeenCalledWith("command -v 'foo; rm -rf /'");
  });

  // T12: probeRequirement preserves installHints from spec onto result
  it("probeRequirement preserves installHints from spec unchanged", async () => {
    const exec = createMockExec({ "command -v": "/usr/bin/rg" });
    const registry = new RequirementsProbeRegistry(exec);

    const hints = { homebrew: "brew install ripgrep", apt: "apt install ripgrep" };
    const result = await registry.probeRequirement({
      name: "rg",
      kind: "cli_tool",
      installHints: hints,
    });

    expect(result.installHints).toEqual(hints);
    expect(result.status).toBe("installed");
  });

  // T13: EACCES probe error -> unknown (not missing) — trust boundary fix
  it("EACCES probe error returns unknown, not missing", async () => {
    const exec = vi.fn(async () => { throw new Error("EACCES: permission denied"); }) as unknown as ExecFn;
    const registry = new RequirementsProbeRegistry(exec);

    const result = await registry.probeCli("rg");

    expect(result.status).toBe("unknown");
    expect(result.error).toContain("EACCES");
  });

  // T14: unknown status does NOT become auto_approvable via planner
  it("unknown probe status maps to manual_only in planner, not auto_approvable", async () => {
    const { ExternalInstallPlanner } = await import("../src/domain/external-install-planner.js");
    const planner = new ExternalInstallPlanner({ platform: "darwin" });

    const probeResult = {
      name: "rg", kind: "cli_tool" as const, status: "unknown" as const,
      version: null, detectedPath: null, provider: null, command: null,
      installHints: null, error: "EACCES: permission denied",
    };

    const plan = planner.planInstalls([probeResult]);
    expect(plan.manualOnly).toHaveLength(1);
    expect(plan.autoApprovable).toHaveLength(0);
  });
});
