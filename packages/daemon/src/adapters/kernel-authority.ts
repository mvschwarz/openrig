import type { NodeBinding } from "../domain/runtime-adapter.js";
import { nonInterruptiveArgs } from "./non-interruptive.js";
import { shellQuote } from "./shell-quote.js";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

// Command families used for rig lifecycle, substrate inspection, remote operations and upgrades.
// These are tool allowances, not containment: node/npm/python/ssh can themselves run arbitrary code.
export const KERNEL_CLAUDE_ALLOW = [
  "Skill", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch",
  ...["rig", "tmux", "node", "npm", "git", "ssh", "scp", "rsync", "curl",
    "uname", "ps", "pgrep", "lsof", "df", "du", "ls", "cat", "head", "tail", "rg", "grep",
    "find", "stat", "date", "sleep", "mkdir", "cp", "mv", "chmod", "tar", "shasum",
    "cd", "pwd", "echo", "printf", "wc", "sort", "python", "python3"]
    .map(command => `Bash(${command}:*)`),
  "Bash(command -v:*)",
  // Read-only provider login checks, so the operator can check a chosen team's provider without a prompt.
  "Bash(claude auth status:*)", "Bash(codex login status:*)",
  "Read(~/**)",
];

// Team defaults are command allowances, not containment. A project's test runner can run code.
// Native deny/ask rules remain in force. The session hook owns generated lifecycle
// asks so that a help invocation is not caught by an unconditional ask prefix.
export const TEAM_CLAUDE_ALLOW = [
  "Skill", "Read(./**)", "Glob", "Grep", "Bash(rig:*)",
  ...["pwd", "ls", "cat", "head", "tail", "rg", "grep", "find"].map(command => `Bash(${command}:*)`),
  ...["npm test", "npm run test", "pnpm test", "pnpm run test", "yarn test", "yarn run test",
    "bun test", "bun run test", "node --test", "npx vitest", "npx jest", "pytest", "python -m pytest",
    "python3 -m pytest", "go test", "cargo test", "make test"].map(command => `Bash(${command}:*)`),
];
export const TEAM_CLAUDE_ASK = [
  "up", "down", "start", "launch", "restore", "fork", "bootstrap", "create", "add", "remove",
  "grow", "shrink", "expand", "archive", "unarchive", "destroy", "compact", "setup", "import", "adopt",
  "attach", "bind", "handover", "unclaim", "release", "reconcile-session", "env down",
  "policy apply", "config set", "config reset",
  "daemon start", "daemon stop", "bundle install", "seat launch", "seat continue", "seat stop",
  "seat clean", "seat handover", "seat switch-client", "seat set-permissions", "seat set-model",
].map(command => `Bash(rig ${command}:*)`);

type LaunchChoice = Pick<NodeBinding, "kernelAuthority" | "teamPermissionDefault" | "nonInterruptive" | "launchPosture" | "permissionMode">;

function claudeCommandSettings(allow: string[], ask: string[] = []): string[] {
  const permissions = { allow, ...(ask.length ? { ask } : {}) };
  const hook = fileURLToPath(new URL("../../assets/claude-team-permissions.cjs", import.meta.url));
  if (!existsSync(hook)) return ["--settings", JSON.stringify({ permissions })];
  const policy = Buffer.from(JSON.stringify({ allow, ask })).toString("base64");
  const command = [process.execPath, hook, policy].map(shellQuote).join(" ");
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
  if (!choice.kernelAuthority) {
    if (runtime === "claude-code" && choice.teamPermissionDefault && !choice.permissionMode
      && (!choice.launchPosture || choice.launchPosture === "floor")) {
      return claudeCommandSettings(TEAM_CLAUDE_ALLOW, TEAM_CLAUDE_ASK);
    }
    return nonInterruptiveArgs(runtime, choice);
  }
  if (runtime === "claude-code") {
    return claudeCommandSettings(KERNEL_CLAUDE_ALLOW);
  }
  return [];
}

export function operationalLaunchArg(runtime: string, choice: LaunchChoice): string {
  return operationalLaunchArgs(runtime, choice).map(arg => ` ${shellQuote(arg)}`).join("");
}
