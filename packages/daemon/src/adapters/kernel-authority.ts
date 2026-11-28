import { validateClaudePermissionRules } from "../domain/claude-permission-rules.js";
import { claudeAutoModeForLaunch, validateClaudeAutoMode } from "../domain/claude-auto-mode.js";
import type { NodeBinding } from "../domain/runtime-adapter.js";
import { nonInterruptiveArgs } from "./non-interruptive.js";
import { isValidThresholdPercent } from "../domain/claude-compaction-enforcer.js";
import { SettingsStore } from "../domain/user-settings/settings-store.js";
import { shellQuote } from "./shell-quote.js";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { HOOK_BRIDGE_TIMEOUT_SECONDS } from "../domain/hook-bridge.js";

import { KERNEL_CLAUDE_ALLOW, TEAM_CLAUDE_ALLOW, TEAM_CLAUDE_ASK, RECEIVING_AGENT_NO_ASK } from "../../assets/claude-permission-policies.cjs";
export { KERNEL_CLAUDE_ALLOW, TEAM_CLAUDE_ALLOW, TEAM_CLAUDE_ASK, RECEIVING_AGENT_NO_ASK };

type LaunchChoice = Pick<NodeBinding, "kernelAuthority" | "teamPermissionDefault" | "nonInterruptive" | "launchPosture" | "permissionMode" | "claudePermissions" | "claudeAutoMode"> & {
  /** Whether OpenRig's managed compaction acts on this Claude launch; read from the policy when absent. */
  managedCompaction?: boolean;
  /** Slice 13: the seat opted in to its hook bridge, so this launch adds the bridge's hooks. */
  hookBridge?: boolean;
  /** #3416 (3): the throttled status line of a seat that opted in, set in this launch's --settings value. */
  statusLine?: Record<string, unknown>;
};

/** Slice 13: an opted-in Claude seat's hook bridge, merged into the session's one --settings value beside any hooks
 *  already there. SessionStart and Stop run the waiter as `asyncRewake` command hooks (Claude Code 2.1.322's schema:
 *  "runs in background and wakes the model on exit code 2"), with a timeout past an hour idle; UserPromptSubmit runs the
 *  quick turn marker. Each command is this daemon's node and the bundled script, quoted for the shell. */
export function withHookBridge(args: string[], on: boolean, script = fileURLToPath(new URL("../../assets/claude-hook-bridge.cjs", import.meta.url))): string[] {
  if (!on || !existsSync(script)) return args;
  const command = (mode: string) => [process.execPath, script, mode].map(shellQuote).join(" ");
  const waiter = { type: "command", command: command("waiter"), asyncRewake: true, timeout: HOOK_BRIDGE_TIMEOUT_SECONDS };
  const bridge: Record<string, unknown[]> = {
    SessionStart: [{ hooks: [waiter] }],
    Stop: [{ hooks: [waiter] }],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: command("turn"), timeout: 5 }] }],
  };
  const at = args.indexOf("--settings");
  const settings = at < 0 ? {} : JSON.parse(args[at + 1]!) as Record<string, unknown>;
  const hooks = { ...((settings.hooks ?? {}) as Record<string, unknown[]>) };
  for (const [event, entries] of Object.entries(bridge)) hooks[event] = [...(hooks[event] ?? []), ...entries];
  const value = JSON.stringify({ ...settings, hooks });
  return at < 0 ? [...args, "--settings", value] : [...args.slice(0, at + 1), value, ...args.slice(at + 2)];
}

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
    let args = withHookBridge(withIdleCompactionOff(claudeOperationalArgs(choice), choice.managedCompaction ?? managedCompactionActive()), choice.hookBridge === true);
    if (choice.claudePermissions !== undefined) {
      const rules = validateClaudePermissionRules(choice.claudePermissions);
      args = withSettings(args, settings => {
        const permissions = (settings.permissions ?? {}) as { allow?: string[]; ask?: string[]; deny?: string[] };
        // A seat's asks go in Claude's native permissions.ask field, beside any the defaults already list.
        return { ...settings, permissions: { ...permissions,
          allow: [...(permissions.allow ?? []), ...rules.allow], deny: [...(permissions.deny ?? []), ...rules.deny],
          ...(rules.ask ? { ask: [...(permissions.ask ?? []), ...rules.ask] } : {}) } };
      });
    }
    if (choice.statusLine !== undefined) {
      const statusLine = choice.statusLine;
      args = withSettings(args, settings => ({ ...settings, statusLine }));
    }
    const { block } = claudeAutoModeForLaunch(choice.claudeAutoMode);
    if (block !== undefined) {
      const autoMode = validateClaudeAutoMode(block);
      args = withSettings(args, settings => ({ ...settings, autoMode }));
    }
    return args;
  }
  return choice.kernelAuthority ? [] : nonInterruptiveArgs(runtime, choice);
}

/** Rewrites the launch's one --settings value, or adds it. */
function withSettings(args: string[], change: (settings: Record<string, unknown>) => Record<string, unknown>): string[] {
  const at = args.indexOf("--settings");
  const value = JSON.stringify(change(at < 0 ? {} : JSON.parse(args[at + 1]!) as Record<string, unknown>));
  return at < 0 ? [...args, "--settings", value] : [...args.slice(0, at + 1), value, ...args.slice(at + 2)];
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
