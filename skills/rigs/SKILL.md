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
machine without a yes. Starting OpenRig and a team writes files: Codex hooks and settings in
`~/.codex/config.toml`, a discovery skill in `~/.claude/skills` and `~/.agents/skills`, and, in the repository, managed
guidance in `AGENTS.md` or `CLAUDE.md` plus the team's skills and plugins. Say so before you ask to start them
([the full list](https://github.com/mvschwarz/openrig#what-openrig-changes-on-your-machine)).

## 1. Install OpenRig, if it isn't installed

- **Check first:** `rig --version`. If it prints a version, go to step 2.
- **What it needs:** macOS or Linux, Node.js 22 or 24, tmux, and Claude Code or Codex signed in. Check only what's
  missing: `node --version`, `tmux -V`, `claude auth status` or `codex login status`.
- **Install:** `npm install -g @openrig/cli`, then `rig preflight` (Node, tmux, the daemon port and state folders)
  and `rig doctor`.
- **Then go on to step 2:** say it's installed and ask what they want worked on, and in which repository. A plain
  "install OpenRig" includes this. Stop here only if they say not to start a team.
- **If something fails:** `rig context get help` is the help guide for the installed version. If `rig` itself won't
  run, use https://www.openrig.dev/help/agents. Getting started: https://openrig.dev/docs/getting-started

## 2. Start a team, or join one

- **Start OpenRig:** `rig daemon status`, and `rig daemon start` if it isn't running. `rig preflight` and `rig doctor`
  don't start it. Starting it also starts OpenRig's own team, the kernel. Keep it: its operator can set up a team.
- **Ask what the team should work on, and in which repository,** unless the person has already said. Keep their words
  for step 3.
- **See what's running:** `rig ps`, then `rig ps --nodes --rig <rig>` for a team's agents. If a team is already
  running in that repository, offer to use it.
- **Offer a team:** list the built-in teams with `rig specs ls --kind rig` and look at one with
  `rig specs preview <name> --kind rig`. For a first team, offer `starter`: a Claude Code builder and a Codex
  reviewer, so it needs both signed in. Say which checkout and branch it will work in. Check the plan with
  `rig up starter --cwd <repo> --plan`, then start it with `rig up starter --cwd <repo>` once the person says yes.
- **With only Claude Code or only Codex,** hand the goal and repository to the kernel's operator instead. It adapts a
  team to what they have, starts it on their yes and gives the goal to the team's lead. The steps are under
  "Installing-agent handoff" in `rig context get reference/getting-started.md`. Then follow the lead's task as in
  step 3.
- **Check it's ready before you say so:** `rig ps --nodes --rig <rig>`. If an agent is stopped at a prompt or a menu,
  read it with `rig capture <seat>@<rig>` and answer with the key that screen shows (`rig send --help` says how to
  send a digit, a letter or Escape), or ask the person. Capture it again before sending anything more.
- **Or join this session to a team:**
  `rig attach --self --rig <rigId> --pod <pod> --member <name> --runtime <claude-code|codex> --print-env` adds this
  session as a new member of a pod. `--node <logicalId>` binds it to an existing seat instead. Attach once, and keep
  the variables it prints (`OPENRIG_NODE_ID` and `OPENRIG_SESSION_NAME`). Each command may run in a fresh shell, so put
  them in front of every later `rig` command. Check with `rig whoami --json`.
- **Replies:** other agents can't type into this session. Read work sent to you with
  `rig queue list --destination <your address>` and `rig queue show <id> --full`, and read an agent's screen with
  `rig capture <seat>@<rig>`.

## 3. Hand the person's work to the team

- **Find the agent that owns the change:** `rig specs preview <name> --kind rig` says what each seat does
  (`dev-build@starter` in `starter`; the lead, `orch-lead`, in `workshop` and `factory`).
- **Hand it over:** write the goal to a file: what to change, in which repository and branch, what done looks like,
  and that the result comes back to you (the branch or commit, the review, any PR text). Then
  `rig queue create --source <your name> --destination <seat>@<rig> --body-file <file>`. Tell that agent with
  `rig send <seat>@<rig> "task <id> is yours"`. A message informs, and a queue task is the work someone owns.
  `--source` names you when this session hasn't joined the team.
- **Follow it to the result:** a task that changed hands isn't finished. `rig queue show <id> --full` names the seat it
  went to, and that seat's next task is the one whose `handedOffFrom` is your task
  (`rig queue list --destination <seat>@<rig> -a -o json`). Follow each handoff until an agent reports the result, and
  use `rig capture <seat>@<rig>` to see what it's doing. Then read what it produced and tell the person what the team
  actually did (the branch, commit, review or PR text), not just that you sent it.
- **Then ask what's next.** If no team can take the work, fix that or ask the person. Don't quietly do it yourself.
- **Other ways to work with the team:** `rig send <seat>@<rig> "..."` types into an agent's terminal,
  `rig capture <seat>@<rig>` reads its screen, and `rig ps --nodes --rig <rig>` shows who's on it.

## 4. Find out more

- **How OpenRig works:** `rig context profile world-public --situation fresh`.
- **What you can do:** `rig context get onboarding-width` (the capability map).
- **Everything in the library:** `rig context list`.
- **Exact syntax:** `rig <command> --help` is always current for the installed version.

Written for OpenRig 0.6.6. When something here and `--help` disagree, `--help` wins.
