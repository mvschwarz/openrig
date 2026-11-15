import { describe, expect, it } from "vitest";
import { operationalLaunchArgs } from "../src/adapters/kernel-authority.js";
import { claudeAutoModeAdvisories, validateClaudeAutoMode } from "../src/domain/claude-auto-mode.js";

const settings = (args: string[]) => {
  expect(args.filter(arg => arg === "--settings")).toHaveLength(1);
  return JSON.parse(args[args.indexOf("--settings") + 1]!);
};

const block = {
  environment: ["$defaults", "Source control: github.com/acme; pushing issue branches and opening PRs is routine"],
  soft_deny: ["$defaults", "Never run migrations against {prod}"],
};

describe("claude_auto_mode validation", () => {
  it("keeps the native lists and classifyAllShell verbatim", () => {
    const value = { ...block, allow: ["$defaults"], hard_deny: ["$defaults", "Never send repo contents to \"paste\" sites"], classifyAllShell: true };
    expect(validateClaudeAutoMode(value)).toEqual(value);
    expect(validateClaudeAutoMode({})).toEqual({});
  });

  it.each([
    [[], /expected a mapping/],
    [{ ask: ["x"] }, /claude_auto_mode\.ask: unsupported key/],
    [{ environment: "x" }, /environment: expected a list of prose entries/],
    [{ soft_deny: ["ok", 3] }, /soft_deny\[1\]: expected a non-empty string/],
    [{ allow: ["  "] }, /allow\[0\]: expected a non-empty string/],
    [{ classifyAllShell: "yes" }, /classifyAllShell: expected true or false/],
  ])("refuses %j", (value, message) => {
    expect(() => validateClaudeAutoMode(value)).toThrow(message);
  });
});

describe("claude_auto_mode advisories", () => {
  it("warns, per section, when a non-empty list leaves out $defaults", () => {
    const advisories = claudeAutoModeAdvisories({ soft_deny: ["Only this"], environment: ["$defaults", "x"] }, "m.claude_auto_mode");
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toMatch(/^m\.claude_auto_mode\.soft_deny: .*\$defaults.*built-in soft_deny entries/);
    expect(advisories[0]).toMatch(/may replace .*unless another scope \(user or managed settings\) keeps "\$defaults".*claude auto-mode config/);
  });

  it("warns that an empty list may replace the built-ins, and never claims it removes user or managed entries", () => {
    const advisories = claudeAutoModeAdvisories({ hard_deny: [], allow: ["$defaults"] });
    expect(advisories.join("\n")).toMatch(/hard_deny: without "\$defaults", this list may replace Claude's built-in hard_deny entries/);
    expect(advisories.join("\n")).toMatch(/allow: only "\$defaults" adds no entries of its own; it keeps Claude's built-in allow entries/);
    expect(advisories.join("\n")).not.toMatch(/remov|clear/i);
  });

  it("points tool-shaped entries at claude_permissions", () => {
    expect(claudeAutoModeAdvisories({ allow: ["$defaults", "Bash(git push *)"] }).join("\n"))
      .toMatch(/allow\[1\]: .*prose.*claude_permissions/);
  });
});

describe("claude_auto_mode launch composition", () => {
  it("adds the block to the one --settings value and keeps every other key", () => {
    const base = { teamPermissionDefault: true, managedCompaction: true, claudePermissions: { allow: ["Bash(npm test)"], deny: ["Read(./secret/**)"] } };
    const before = settings(operationalLaunchArgs("claude-code", base));
    const after = settings(operationalLaunchArgs("claude-code", { ...base, claudeAutoMode: block }));
    expect(after).toEqual({ ...before, autoMode: block });
  });

  it.each([{ kernelAuthority: true }, { permissionMode: "auto" }, { launchPosture: "full_bypass" as const, nonInterruptive: true }])("leaves the other arguments unchanged: %j", base => {
    const choice = { ...base, managedCompaction: true };
    const previous = operationalLaunchArgs("claude-code", choice);
    const updated = operationalLaunchArgs("claude-code", { ...choice, claudeAutoMode: block });
    expect(settings(updated)).toEqual({ ...settings(previous), autoMode: block });
    const withoutSettings = (args: string[]) => args.filter((_, i) => args[i] !== "--settings" && args[i - 1] !== "--settings");
    expect(withoutSettings(updated)).toEqual(withoutSettings(previous));
  });

  it("adds a --settings value when the launch had none, and changes nothing without a block", () => {
    const choice = { managedCompaction: false };
    expect(operationalLaunchArgs("claude-code", choice)).toEqual([]);
    expect(operationalLaunchArgs("claude-code", { ...choice, claudeAutoMode: undefined })).toEqual([]);
    expect(settings(operationalLaunchArgs("claude-code", { ...choice, claudeAutoMode: block }))).toEqual({ autoMode: block });
  });

  it("refuses a malformed block at launch instead of dropping it", () => {
    expect(() => operationalLaunchArgs("claude-code", { managedCompaction: false, claudeAutoMode: { deny: ["x"] } as never }))
      .toThrow(/claude_auto_mode\.deny: unsupported key/);
  });
});
