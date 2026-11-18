// Slice 13: an opted-in Claude seat's launch adds the hook bridge's hooks to its one --settings value, beside the
// hooks already there, and a seat that didn't opt in launches byte-identical. The identity proof that reads --settings
// back from `ps` still finds the session.
import { describe, expect, it } from "vitest";
import { operationalLaunchArgs, withHookBridge } from "../src/adapters/kernel-authority.js";
import { claudeCommandSessionToken, processArgv } from "../src/domain/native-process-lineage.js";
import { HOOK_BRIDGE_TIMEOUT_SECONDS } from "../src/domain/hook-bridge.js";

const settingsOf = (args: string[]) => JSON.parse(args[args.indexOf("--settings") + 1]!) as { hooks?: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>> };

describe("the hook bridge's launch hooks (slice 13)", () => {
  it("leaves a launch that didn't opt in exactly as it was", () => {
    const choice = { kernelAuthority: true, managedCompaction: false };
    expect(operationalLaunchArgs("claude-code", { ...choice, hookBridge: false })).toEqual(operationalLaunchArgs("claude-code", choice));
  });

  it("adds asyncRewake waiters at SessionStart and Stop and a quick turn marker, beside the hooks already there", () => {
    const args = operationalLaunchArgs("claude-code", { kernelAuthority: true, managedCompaction: false, hookBridge: true });
    const { hooks } = settingsOf(args);
    expect(hooks?.PreToolUse).toHaveLength(1); // the team-permission hook is kept
    for (const event of ["SessionStart", "Stop"]) {
      expect(hooks?.[event]).toEqual([{ hooks: [expect.objectContaining({ type: "command", asyncRewake: true, timeout: HOOK_BRIDGE_TIMEOUT_SECONDS,
        command: expect.stringMatching(/claude-hook-bridge\.cjs'? '?waiter'?$/) })] }]);
    }
    expect(hooks?.UserPromptSubmit?.[0]?.hooks[0]).toMatchObject({ type: "command", timeout: 5, command: expect.stringMatching(/turn'?$/) });
    expect(hooks?.UserPromptSubmit?.[0]?.hooks[0]).not.toHaveProperty("asyncRewake");
    expect(HOOK_BRIDGE_TIMEOUT_SECONDS).toBeGreaterThan(3600);
  });

  it("merges into an existing --settings value and appends to an event's hooks", () => {
    const base = ["--settings", JSON.stringify({ permissions: { allow: ["Read"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] } })];
    const merged = settingsOf(withHookBridge(base, true)) as { permissions?: unknown; hooks: Record<string, unknown[]> };
    expect(merged.permissions).toEqual({ allow: ["Read"] });
    expect(merged.hooks.Stop).toHaveLength(2);
    expect(withHookBridge(base, true, "/no/such/script.cjs")).toEqual(base);
  });

  it("keeps the identity proof's reading of --settings from ps", () => {
    const args = operationalLaunchArgs("claude-code", { kernelAuthority: true, managedCompaction: false, hookBridge: true });
    const value = args[args.indexOf("--settings") + 1]!;
    const ps = `claude --session-id 11111111-1111-4111-8111-111111111111 --settings ${value} --name dev-impl@team`;
    expect(claudeCommandSessionToken(ps)).toBe("11111111-1111-4111-8111-111111111111");
    const argv = processArgv(ps);
    expect(JSON.parse(argv[argv.indexOf("--settings") + 1]!)).toEqual(JSON.parse(value));
  });
});
