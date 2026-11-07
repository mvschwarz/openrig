import { validateClaudePermissionRules } from "../domain/claude-permission-rules.js";
import type { NodeBinding } from "../domain/runtime-adapter.js";
import { nonInterruptiveArgs } from "./non-interruptive.js";
import { isValidThresholdPercent } from "../domain/claude-compaction-enforcer.js";
import { SettingsStore } from "../domain/user-settings/settings-store.js";
import { shellQuote } from "./shell-quote.js";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

import { KERNEL_CLAUDE_ALLOW, TEAM_CLAUDE_ALLOW, TEAM_CLAUDE_ASK } from "../../assets/claude-permission-policies.cjs";
export { KERNEL_CLAUDE_ALLOW, TEAM_CLAUDE_ALLOW, TEAM_CLAUDE_ASK };

type LaunchChoice = Pick<NodeBinding, "kernelAuthority" | "teamPermissionDefault" | "nonInterruptive" | "launchPosture" | "permissionMode" | "claudePermissions"> & {
  /** Whether OpenRig's managed compaction acts on this Claude launch; read from the policy when absent. */
  managedCompaction?: boolean;
};

/** OpenRig's managed compaction acts on Claude seats while its policy is on with a threshold the enforcer accepts (it
 *  treats any other threshold as off). Read fresh at each launch; an unreadable policy reads as off. */
export function managedCompactionActive(store: Pick<SettingsStore, "resolveClaudeCompactionPolicy"> = new SettingsStore()): boolean {
  try {
    const policy = store.resolveClaudeCompactionPolicy();
    return policy.enabled === true && isValidThresholdPercent(policy.thresholdPercent);
  } catch {
    return false;
  }
}

/** While managed compaction acts on a Claude session, Claude's own idle compaction is turned off in the session's one
 *  --settings value (merged into it, or as the only one), so the session compacts through OpenRig's sequence. Claude
 *  Code before 2.1.290 ignores the key. Higher-precedence managed settings still win. */
function withIdleCompactionOff(args: string[], on: boolean): string[] {
  if (!on) return args;
  const at = args.indexOf("--settings");
  if (at === -1) return [...args, "--settings", JSON.stringify({ idleCompaction: false })];
  const settings = JSON.parse(args[at + 1]!) as Record<string, unknown>;
  return [...args.slice(0, at + 1), JSON.stringify({ ...settings, idleCompaction: false }), ...args.slice(at + 2)];
}

/** Selects a built-in hook policy; keeps native allow/ask settings when the optional hook is absent. */
function claudeCommandSettings(kind: "kernel" | "team"): string[] {
  const allow = kind === "kernel" ? KERNEL_CLAUDE_ALLOW : TEAM_CLAUDE_ALLOW;
  const ask = kind === "kernel" ? [] : TEAM_CLAUDE_ASK;
  const permissions = { allow, ...(ask.length ? { ask } : {}) };
  const hook = fileURLToPath(new URL("../../assets/claude-team-permissions.cjs", import.meta.url));
  if (!existsSync(hook)) return ["--settings", JSON.stringify({ permissions })];
  const command = [process.execPath, hook, kind].map(shellQuote).join(" ");
  return ["--settings", JSON.stringify({
    permissions: { allow },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command, timeout: 5 }] }] },
  })];
}

/** Session flags only; never writes a personal/project permission file. */
export function operationalLaunchArgs(runtime: string, choice: LaunchChoice): string[] {
  if (runtime === "codex") {
    // Managed seats leave Codex upgrades to the operator. This is launch-local;
    // it does not write config or accept a rate-limit model switch.
    return ["-c", "check_for_update_on_startup=false", ...nonInterruptiveArgs(runtime,
      choice.kernelAuthority ? { launchPosture: "full_bypass", nonInterruptive: true } : choice)];
  }
  if (runtime === "claude-code") {
    const args = withIdleCompactionOff(claudeOperationalArgs(choice), choice.managedCompaction ?? managedCompactionActive());
    if (choice.claudePermissions === undefined) return args;
    const rules = validateClaudePermissionRules(choice.claudePermissions);
    const at = args.indexOf("--settings");
    const settings = at < 0 ? {} : JSON.parse(args[at + 1]!) as Record<string, unknown>;
    const permissions = (settings.permissions ?? {}) as { allow?: string[]; deny?: string[] };
    const value = JSON.stringify({ ...settings, permissions: { ...permissions,
      allow: [...(permissions.allow ?? []), ...rules.allow], deny: [...(permissions.deny ?? []), ...rules.deny] } });
    return at < 0 ? [...args, "--settings", value] : [...args.slice(0, at + 1), value, ...args.slice(at + 2)];
  }
  return choice.kernelAuthority ? [] : nonInterruptiveArgs(runtime, choice);
}

/** Applies kernel or eligible team defaults before falling back to the explicit launch posture. */
function claudeOperationalArgs(choice: LaunchChoice): string[] {
  if (choice.kernelAuthority) return claudeCommandSettings("kernel");
  if (choice.teamPermissionDefault && !choice.permissionMode && (!choice.launchPosture || choice.launchPosture === "floor")) {
    return claudeCommandSettings("team");
  }
  return nonInterruptiveArgs("claude-code", choice);
}

export function operationalLaunchArg(runtime: string, choice: LaunchChoice): string {
  return operationalLaunchArgs(runtime, choice).map(arg => ` ${shellQuote(arg)}`).join("");
}
