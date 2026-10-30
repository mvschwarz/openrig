import { describe, it, expect } from "vitest";
import { ExternalInstallPlanner } from "../src/domain/external-install-planner.js";
import type { ProbeResult } from "../src/domain/requirements-probe.js";

function makeProbe(overrides: Partial<ProbeResult> & { name: string; status: ProbeResult["status"] }): ProbeResult {
  return {
    kind: "cli_tool",
    version: null,
    detectedPath: null,
    provider: null,
    command: null,
    installHints: null,
    error: null,
    ...overrides,
  };
}

describe("ExternalInstallPlanner", () => {
  it.each(["constructor", "__proto__", "toString", "git; echo unexpected", "Git.Git"])("keeps unmapped Windows tool %s manual-only", name => {
    const plan = new ExternalInstallPlanner({ platform: "win32" }).planInstalls([makeProbe({ name, status: "missing" })]);
    expect(plan.actions[0]).toMatchObject({ classification: "manual_only", commandPreview: null, provider: null });
    expect(plan.actions[0]).not.toHaveProperty("commandArgv");
  });
  // T1: Missing CLI tool on darwin -> auto_approvable, brew install
  it("missing CLI tool on darwin -> auto_approvable with brew install", () => {
    const planner = new ExternalInstallPlanner({ platform: "darwin" });

    const plan = planner.planInstalls([
      makeProbe({ name: "ripgrep", status: "missing" }),
    ]);

    expect(plan.actions).toHaveLength(1);
    expect(plan.autoApprovable).toHaveLength(1);
    const action = plan.actions[0]!;
    expect(action.requirementName).toBe("ripgrep");
    expect(action.classification).toBe("auto_approvable");
    expect(action.provider).toBe("homebrew");
    expect(action.commandPreview).toBe("brew install 'ripgrep'");
  });

  // T2: Missing CLI tool on non-darwin -> manual_only
  it("missing CLI tool on non-darwin -> manual_only", () => {
    const planner = new ExternalInstallPlanner({ platform: "linux" });

    const plan = planner.planInstalls([
      makeProbe({ name: "ripgrep", status: "missing" }),
    ]);

    expect(plan.actions).toHaveLength(1);
    expect(plan.manualOnly).toHaveLength(1);
    const action = plan.actions[0]!;
    expect(action.classification).toBe("manual_only");
    expect(action.provider).toBeNull();
    expect(action.commandPreview).toBeNull();
  });

  // T3: Already installed -> no action, name in alreadyInstalled
  it("already installed -> no action, name in alreadyInstalled", () => {
    const planner = new ExternalInstallPlanner({ platform: "darwin" });

    const plan = planner.planInstalls([
      makeProbe({ name: "git", status: "installed", detectedPath: "/usr/bin/git" }),
    ]);

    expect(plan.actions).toHaveLength(0);
    expect(plan.alreadyInstalled).toEqual(["git"]);
  });

  // T4: installHints preserved on action but not in commandPreview
  it("installHints preserved on action, not used in commandPreview", () => {
    const hints = { homebrew: "brew install ripgrep", apt: "sudo apt install ripgrep" };
    const planner = new ExternalInstallPlanner({ platform: "darwin" });

    const plan = planner.planInstalls([
      makeProbe({ name: "ripgrep", status: "missing", installHints: hints }),
    ]);

    const action = plan.actions[0]!;
    expect(action.installHints).toEqual(hints);
    // commandPreview is the trusted provider command, not from hints
    expect(action.commandPreview).toBe("brew install 'ripgrep'");
    expect(action.commandPreview).not.toContain("sudo");
  });

  // T5: Multiple missing -> multiple actions in input order
  it("multiple missing requirements produce actions in input order", () => {
    const planner = new ExternalInstallPlanner({ platform: "darwin" });

    const plan = planner.planInstalls([
      makeProbe({ name: "ripgrep", status: "missing" }),
      makeProbe({ name: "jq", status: "installed", detectedPath: "/usr/bin/jq" }),
      makeProbe({ name: "fd", status: "missing" }),
    ]);

    expect(plan.actions).toHaveLength(2);
    expect(plan.actions[0]!.requirementName).toBe("ripgrep");
    expect(plan.actions[1]!.requirementName).toBe("fd");
    expect(plan.alreadyInstalled).toEqual(["jq"]);
  });

  // T6: commandPreview uses shell-quoted name
  it("commandPreview uses shell-quoted package name", () => {
    const planner = new ExternalInstallPlanner({ platform: "darwin" });

    const plan = planner.planInstalls([
      makeProbe({ name: "my-pkg", status: "missing" }),
    ]);

    expect(plan.actions[0]!.commandPreview).toBe("brew install 'my-pkg'");
  });

  // T7: status='unsupported' -> manual_only
  it("unsupported probe status -> manual_only", () => {
    const planner = new ExternalInstallPlanner({ platform: "darwin" });

    const plan = planner.planInstalls([
      makeProbe({ name: "libssl", status: "unsupported", kind: "system_package" }),
    ]);

    expect(plan.actions).toHaveLength(1);
    expect(plan.manualOnly).toHaveLength(1);
    expect(plan.actions[0]!.classification).toBe("manual_only");
    expect(plan.actions[0]!.reason).toContain("no trusted provider");
  });

  // T8: Split arrays correct
  it("plan splits actions into auto/review/manual arrays", () => {
    const planner = new ExternalInstallPlanner({ platform: "darwin" });

    const plan = planner.planInstalls([
      makeProbe({ name: "ripgrep", status: "missing" }),
      makeProbe({ name: "libssl", status: "unsupported", kind: "system_package" }),
      makeProbe({ name: "git", status: "installed", detectedPath: "/usr/bin/git" }),
    ]);

    expect(plan.autoApprovable).toHaveLength(1);
    expect(plan.autoApprovable[0]!.requirementName).toBe("ripgrep");
    expect(plan.reviewRequired).toHaveLength(0);
    expect(plan.manualOnly).toHaveLength(1);
    expect(plan.manualOnly[0]!.requirementName).toBe("libssl");
    expect(plan.alreadyInstalled).toEqual(["git"]);
  });

  // T9: status='unknown' -> manual_only (probe failed)
  it("unknown probe status -> manual_only with probe-failed reason", () => {
    const planner = new ExternalInstallPlanner({ platform: "darwin" });

    const plan = planner.planInstalls([
      makeProbe({ name: "slow-tool", status: "unknown", error: "probe timed out" }),
    ]);

    expect(plan.actions).toHaveLength(1);
    expect(plan.manualOnly).toHaveLength(1);
    const action = plan.actions[0]!;
    expect(action.classification).toBe("manual_only");
    expect(action.reason).toContain("probe failed");
    expect(action.commandPreview).toBeNull();
  });

  // T10: Missing system_package on darwin -> auto_approvable, brew install
  it("missing system_package on darwin -> auto_approvable with brew install", () => {
    const planner = new ExternalInstallPlanner({ platform: "darwin" });

    const plan = planner.planInstalls([
      makeProbe({ name: "openssl", status: "missing", kind: "system_package" }),
    ]);

    expect(plan.actions).toHaveLength(1);
    expect(plan.autoApprovable).toHaveLength(1);
    const action = plan.actions[0]!;
    expect(action.requirementName).toBe("openssl");
    expect(action.kind).toBe("system_package");
    expect(action.classification).toBe("auto_approvable");
    expect(action.provider).toBe("homebrew");
    expect(action.commandPreview).toBe("brew install 'openssl'");
  });
});
