import type { NodeBinding } from "../domain/runtime-adapter.js";
import { nonInterruptiveArgs } from "./non-interruptive.js";
import { shellQuote } from "./shell-quote.js";

// Command families used for rig lifecycle, substrate inspection, remote operations and upgrades.
// These are tool allowances, not containment: node/npm/ssh can themselves run arbitrary code.
export const KERNEL_CLAUDE_ALLOW = [
  "Skill", "Read", "Edit", "Write", "Glob", "Grep",
  ...["rig", "tmux", "node", "npm", "git", "ssh", "scp", "rsync", "curl",
    "uname", "ps", "pgrep", "lsof", "df", "du", "ls", "cat", "head", "tail", "rg", "grep",
    "find", "stat", "date", "sleep", "mkdir", "cp", "mv", "chmod", "tar", "shasum"]
    .map(command => `Bash(${command}:*)`),
  // Read-only provider login checks, so the operator can check a chosen team's provider without a prompt.
  "Bash(claude auth status:*)", "Bash(codex login status:*)",
  "Read(~/**)",
];

// Team defaults are command allowances, not containment. A project's test runner can run code.
// Native deny/ask rules remain in force; lifecycle asks precede the broad rig allow.
export const TEAM_CLAUDE_ALLOW = [
  "Skill", "Read(./**)", "Glob", "Grep", "Bash(rig:*)",
  ...["pwd", "ls", "cat", "head", "tail", "rg", "grep", "find"].map(command => `Bash(${command}:*)`),
  ...["npm test", "npm run test", "pnpm test", "pnpm run test", "yarn test", "yarn run test",
    "bun test", "bun run test", "node --test", "npx vitest", "npx jest", "pytest", "python -m pytest",
    "python3 -m pytest", "go test", "cargo test", "make test"].map(command => `Bash(${command}:*)`),
];
export const TEAM_CLAUDE_ASK = [
  "up", "down", "start", "launch", "restore", "fork", "bootstrap", "create", "add", "remove",
  "grow", "shrink", "expand", "archive", "unarchive", "destroy",
  "daemon start", "daemon stop", "bundle install", "seat launch", "seat continue", "seat stop",
  "seat clean", "seat handover", "seat switch-client", "seat set-permissions", "seat set-model",
].map(command => `Bash(rig ${command}:*)`);

type LaunchChoice = Pick<NodeBinding, "kernelAuthority" | "teamPermissionDefault" | "nonInterruptive" | "launchPosture" | "permissionMode">;

/** Session flags only; never writes a personal/project permission file. */
export function operationalLaunchArgs(runtime: string, choice: LaunchChoice): string[] {
  if (!choice.kernelAuthority) {
    if (runtime === "claude-code" && choice.teamPermissionDefault && !choice.permissionMode
      && (!choice.launchPosture || choice.launchPosture === "floor")) {
      return ["--settings", JSON.stringify({ permissions: { allow: TEAM_CLAUDE_ALLOW, ask: TEAM_CLAUDE_ASK } })];
    }
    return nonInterruptiveArgs(runtime, choice);
  }
  if (runtime === "claude-code") {
    return ["--settings", JSON.stringify({ permissions: { allow: KERNEL_CLAUDE_ALLOW } })];
  }
  // Kernel host operations include signaling the daemon and upgrading outside cwd.
  // Codex's full-access/never posture is coarse; acknowledge its warning for this launch only.
  return runtime === "codex"
    ? nonInterruptiveArgs(runtime, { launchPosture: "full_bypass", nonInterruptive: true })
    : [];
}

export function operationalLaunchArg(runtime: string, choice: LaunchChoice): string {
  return operationalLaunchArgs(runtime, choice).map(arg => ` ${shellQuote(arg)}`).join("");
}
