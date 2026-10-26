import { describe, expect, it } from "vitest";
import { operationalLaunchArgs, TEAM_CLAUDE_ALLOW } from "../src/adapters/kernel-authority.js";

const settings = (args: string[]) => {
  expect(args.filter(arg => arg === "--settings")).toHaveLength(1);
  return JSON.parse(args[args.indexOf("--settings") + 1]!);
};

describe("per-member Claude permission rules", () => {
  it("gives members independent rules while retaining team hooks and compaction settings", () => {
    const defaults = { teamPermissionDefault: true, managedCompaction: true };
    const first = { ...defaults, claudePermissions: { allow: ["Bash(node lane-a.mjs *)"], deny: ["Read(./lane-b/**)"] } };
    const second = { ...defaults, claudePermissions: { allow: ["Bash(node lane-b.mjs *)"], deny: ["Read(./lane-a/**)"] } };
    const a = settings(operationalLaunchArgs("claude-code", first));
    const b = settings(operationalLaunchArgs("claude-code", second));
    expect(a.permissions).toEqual({ allow: [...TEAM_CLAUDE_ALLOW, ...first.claudePermissions.allow], deny: first.claudePermissions.deny });
    expect(b.permissions).toEqual({ allow: [...TEAM_CLAUDE_ALLOW, ...second.claudePermissions.allow], deny: second.claudePermissions.deny });
    expect(a.hooks).toEqual(settings(operationalLaunchArgs("claude-code", defaults)).hooks);
    expect(a.idleCompaction).toBe(false);
  });

  it.each([{ kernelAuthority: true }, { permissionMode: "default" }, { launchPosture: "full_bypass" as const, nonInterruptive: true }])("keeps the selected mode and existing launch settings: %j", base => {
    const choice = { ...base, managedCompaction: true };
    const previous = operationalLaunchArgs("claude-code", choice);
    const updated = operationalLaunchArgs("claude-code", { ...choice, claudePermissions: { allow: [], deny: ["Read(./private/**)"] } });
    const before = settings(previous), after = settings(updated);
    for (const key of Object.keys(before).filter(key => key !== "permissions")) expect(after[key]).toEqual(before[key]);
    expect(after.permissions.allow).toEqual(before.permissions?.allow ?? []);
    expect(after.permissions.deny).toEqual(["Read(./private/**)"]);
    const withoutSettings = (args: string[]) => args.filter((_, i) => args[i] !== "--settings" && args[i - 1] !== "--settings");
    expect(withoutSettings(updated)).toEqual(withoutSettings(previous));
  });

  it("rejects an explicit rule block that could otherwise discard intended restrictions", () => {
    const choice = { managedCompaction: false, claudePermissions: { deny: ["Read(./private/**)"], ask: ["Bash"] } };
    expect(() => operationalLaunchArgs("claude-code", choice)).toThrow(/claude_permissions.*ask/);
  });
});
