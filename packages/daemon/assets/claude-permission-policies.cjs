"use strict";

// Command families used for rig lifecycle, substrate inspection, remote operations and upgrades.
// These are tool allowances, not containment: node/npm/python/ssh can themselves run arbitrary code.
const KERNEL_CLAUDE_ALLOW = [
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
// Team agents run most rig commands without a prompt. The commands that start, stop or remove teams or
// agents ask, and so do six kept for a person: import (its --instantiate mode launches nodes, and a
// prefix can't tell its modes apart), seat set-permissions and policy apply under both spellings (an
// explicit permission choice stays with a person), setup (its --policy option records one, and a prefix
// can't tell that from ordinary setup), and compact (it replaces a peer's working context). Other rig
// commands (archive, attach, config set, seat set-model and the like) fall under the Bash(rig:*) allowance.
const TEAM_CLAUDE_ALLOW = [
  "Skill", "Read(./**)", "Glob", "Grep", "Bash(rig:*)",
  ...["pwd", "ls", "cat", "head", "tail", "rg", "grep", "find"].map(command => `Bash(${command}:*)`),
  ...["npm test", "npm run test", "pnpm test", "pnpm run test", "yarn test", "yarn run test",
    "bun test", "bun run test", "node --test", "npx vitest", "npx jest", "pytest", "python -m pytest",
    "python3 -m pytest", "go test", "cargo test", "make test"].map(command => `Bash(${command}:*)`),
];
const TEAM_CLAUDE_ASK = [
  "up", "down", "start", "launch", "restore", "fork", "bootstrap", "create", "add", "remove",
  "grow", "shrink", "expand", "destroy", "handover", "env down",
  "daemon start", "daemon stop", "bundle install", "seat launch", "seat stop", "seat handover", "seat restart",
  "import", "seat set-permissions", "policy apply", "policy permissions apply", "setup", "compact",
].map(command => `Bash(rig ${command}:*)`);

module.exports = { KERNEL_CLAUDE_ALLOW, TEAM_CLAUDE_ALLOW, TEAM_CLAUDE_ASK };
