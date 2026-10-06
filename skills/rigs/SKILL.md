---
name: rigs
description: Use when the user types /rigs, or asks to install OpenRig, to join this session to an OpenRig team, or to work with a team of Claude Code or Codex agents from here.
---

# rigs: your route into OpenRig

OpenRig runs a team of coding agents (Claude Code, Codex and others) side by side in tmux. A local daemon keeps their
tasks, messages and state, so the team keeps working across restarts. This skill gets OpenRig installed, joins this
session to a team, and shows how to work with the team from here.

Tell the person what you're about to run and why before you run it. Don't install system packages or change their
machine without a yes.

## 1. Install OpenRig, if it isn't installed

- **Check first:** `rig --version`. If it prints a version, go to step 2.
- **What it needs:** macOS or Linux, Node.js 22 or 24, tmux, and Claude Code or Codex signed in. Check only what's
  missing: `node --version`, `tmux -V`, `claude auth status` or `codex login status`.
- **Install:** `npm install -g @openrig/cli`, then `rig preflight` (Node, tmux, the daemon port and state folders)
  and `rig doctor`.
- **If something fails:** `rig context get help` is the help guide for the installed version. If `rig` itself won't
  run, use https://www.openrig.dev/help/agents. Getting started: https://openrig.dev/docs/getting-started

## 2. Start a team, or join one

- **See what's running:** `rig ps`, then `rig ps --nodes --rig <rig>` for a team's agents.
- **OpenRig's own team (the kernel)** starts with the daemon and looks after OpenRig itself and its dashboard.
- **Start a team in a repository:** list the built-in teams with `rig specs ls --kind rig`, look at one with
  `rig specs preview <name> --kind rig`, check the plan with `rig up <name> --cwd <repo> --plan`, then start it with
  `rig up <name> --cwd <repo>` once the person says yes.
- **Join this session to a team:** `rig attach --self --rig <rigId> --pod <pod> --member <name>` adds this session as
  a new member of a pod. `--node <logicalId>` binds it to an existing seat instead. Add `--print-env` and export what it
  prints, so later `rig` commands know who you are. Check with `rig whoami --json`.

## 3. Work with the team

- **Who's on it:** `rig whoami --json` (your peers and how you're connected) and `rig ps --nodes --rig <rig>`.
- **Message an agent:** `rig send <seat>@<rig> "..."`. It types into that agent's terminal.
- **Read an agent's screen:** `rig capture <seat>`.
- **Hand off work that must get done:** write the task to a file, then
  `rig queue create --destination <seat>@<rig> --body-file <file>`. Follow it with
  `rig queue list --destination <seat>@<rig>` and `rig queue show <id> --full`. A message informs, and a queue task is
  the work someone owns.

## 4. Find out more

- **How OpenRig works:** `rig context profile world-public --situation fresh`.
- **What you can do:** `rig context get onboarding-width` (the capability map).
- **Everything in the library:** `rig context list`.
- **Exact syntax:** `rig <command> --help` is always current for the installed version.

Written for OpenRig 0.6.5. When something here and `--help` disagree, `--help` wins.
