import { describe, expect, it } from "vitest";
import { claudeSettingsTransportProblem, operationalLaunchArgs } from "../src/adapters/kernel-authority.js";

describe("Claude inline settings transport", () => {
  it("accepts an argument below the byte bound and rejects the boundary including its NUL", () => {
    expect(claudeSettingsTransportProblem(["--settings", "x".repeat(131071)])).toBeUndefined();
    expect(claudeSettingsTransportProblem(["--settings", "x".repeat(131072)])).toMatch(/131072.*bytes/);
  });

  it("counts UTF-8 bytes rather than JavaScript characters", () => {
    const value = JSON.stringify({ text: "🙂".repeat(40000) });
    expect(value.length).toBeLessThan(131072);
    expect(claudeSettingsTransportProblem(["--settings", value])).toMatch(/UTF-8 bytes/);
  });

  it("includes --settings= in the captured inline argument's size", () => {
    expect(claudeSettingsTransportProblem([`--settings=${"x".repeat(131061)}`])).toMatch(/131072.*bytes/);
  });

  it("does not change composed permissions, hooks, compaction, status line or auto mode", () => {
    const args = operationalLaunchArgs("claude-code", { teamPermissionDefault: true, managedCompaction: true,
      hookBridge: true, claudePermissions: { deny: ["Read(/example/private/**)"] },
      statusLine: { type: "command", command: "echo fixture" }, claudeAutoMode: { environment: ["$defaults", "fixture"] } });
    const before = [...args];
    expect(claudeSettingsTransportProblem(args)).toBeUndefined();
    expect(args).toEqual(before);
    const value = JSON.parse(args[args.indexOf("--settings") + 1]!);
    expect(value).toMatchObject({ permissions: { deny: ["Read(/example/private/**)"] }, idleCompaction: false,
      statusLine: { command: "echo fixture" }, autoMode: { environment: ["$defaults", "fixture"] } });
    expect(value.hooks).toBeDefined();
  });

  it("keeps ordinary settings filenames and arguments without settings unchanged", () => {
    expect(claudeSettingsTransportProblem(["--settings", "/example/session settings.json", "--resume", "same"])).toBeUndefined();
    expect(claudeSettingsTransportProblem(["--resume", "same"])).toBeUndefined();
  });

  it("reports size without echoing the settings", () => {
    const value = JSON.stringify({ permissions: { deny: ["sensitive-fixture-marker" + "x".repeat(131072)] } });
    const problem = claudeSettingsTransportProblem(["--settings", value]);
    expect(problem).toContain("No Claude launch command was sent");
    expect(problem).not.toContain("sensitive-fixture-marker");
  });
});
