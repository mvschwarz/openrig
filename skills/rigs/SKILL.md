---
name: rigs
description: Use when the user types /rigs, or asks to install OpenRig, to join this session to an OpenRig team, or to work with a team of Claude Code or Codex agents from here.
---

# rigs: your route into OpenRig

OpenRig runs a team of coding agents (Claude Code, Codex and others) side by side in tmux. A local daemon keeps their
tasks, messages and state, so the team keeps working across restarts. This skill gets OpenRig installed, gets a team
working on what the person wants, and shows how to work with that team from here.

**The goal is a team doing the person's work, not just an install.** Go through the steps in order and stop early only
if the person asks you to. When they say what they want built, hand it to the team (step 3) instead of building it
yourself.

Tell the person what you're about to run and why before you run it. Don't install system packages or change their
machine without a yes.

## 1. Install OpenRig, if it isn't installed

- **Check first:** `rig --version`. If it prints a version, go to step 2.
- **What it needs:** macOS or Linux, Node.js 22 or 24, tmux, and Claude Code or Codex signed in. Check only what's
  missing: `node --version`, `tmux -V`, `claude auth status` or `codex login status`.
- **Install:** `npm install -g @openrig/cli`, then `rig preflight` (Node, tmux, the daemon port and state folders)
  and `rig doctor`.
- **Then go on to step 2.** Stop after the install only if the person asked for the install and nothing else.
- **If something fails:** `rig context get help` is the help guide for the installed version. If `rig` itself won't
  run, use https://www.openrig.dev/help/agents. Getting started: https://openrig.dev/docs/getting-started

## 2. Start a team, or join one

- **Start OpenRig:** `rig daemon status`, and `rig daemon start` if it isn't running. `rig preflight` and `rig doctor`
  don't start it. Starting it also starts OpenRig's own team (the kernel), which looks after OpenRig itself.
- **Ask what the team should work on, and in which repository,** unless the person has already said. Keep their words
  for step 3.
- **See what's running:** `rig ps`, then `rig ps --nodes --rig <rig>` for a team's agents. If a team is already
  running in that repository, offer to use it.
- **Offer a team:** list the built-in teams with `rig specs ls --kind rig` and look at one with
  `rig specs preview <name> --kind rig`. For a first team, offer the small builder-and-reviewer team (`starter` from
  0.6.6, `first-project` in 0.6.5) and say in a sentence what it is. Check the plan with
  `rig up <name> --cwd <repo> --plan`, then start it with `rig up <name> --cwd <repo>` once the person says yes.
- **Check it's ready before you say so:** `rig ps --nodes --rig <rig>`. If an agent is stopped at a prompt or a menu,
  read it with `rig capture <seat>@<rig>`, then answer it or ask the person.
- **Or join this session to a team:**
  `rig attach --self --rig <rigId> --pod <pod> --member <name> --runtime <claude-code|codex> --print-env` adds this
  session as a new member of a pod. `--node <logicalId>` binds it to an existing seat instead. Attach once, and keep
  the variables it prints (`OPENRIG_NODE_ID` and `OPENRIG_SESSION_NAME`). Each command may run in a fresh shell, so put
  them in front of every later `rig` command. Check with `rig whoami --json`.
- **Replies:** other agents can't type into this session. Read work sent to you with
  `rig queue list --destination <your address>` and `rig queue show <id> --full`, and read an agent's screen with
  `rig capture <seat>@<rig>`.

## 3. Hand the person's work to the team

- **Find the agent that owns the change:** `rig specs preview <name> --kind rig` says what each seat does (the builder
  in `starter`, the owner in `first-project`).
- **Hand it over:** write the goal to a file (what to change, in which repository, and what done looks like), then
  `rig queue create --source <your name> --destination <seat>@<rig> --body-file <file>`. Tell that agent with
  `rig send <seat>@<rig> "task <id> is yours"`. A message informs, and a queue task is the work someone owns.
  `--source` names you when this session hasn't joined the team.
- **Follow it and read the result back:** `rig queue show <id> --full` and `rig capture <seat>@<rig>`. Tell the person
  what the team actually did (its notes, the branch or the PR), not just that you sent it.
- **Then ask what's next.** If no team can take the work, fix that or ask the person. Don't quietly do it yourself.
- **Other ways to work with the team:** `rig send <seat>@<rig> "..."` types into an agent's terminal,
  `rig capture <seat>@<rig>` reads its screen, and `rig ps --nodes --rig <rig>` shows who's on it.

## 4. Find out more

- **How OpenRig works:** `rig context profile world-public --situation fresh`.
- **What you can do:** `rig context get onboarding-width` (the capability map).
- **Everything in the library:** `rig context list`.
- **Exact syntax:** `rig <command> --help` is always current for the installed version.

Written for OpenRig 0.6.5, with the team names 0.6.6 uses. When something here and `--help` disagree, `--help` wins.
