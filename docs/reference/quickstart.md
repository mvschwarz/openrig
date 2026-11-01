# Getting started

OpenRig runs a team of coding agents (Claude Code, Codex and others) on your project, each in its own terminal. You
talk to one agent, and it hands work to the others. The team keeps its tasks and messages between sessions.

Most people let their coding agent set it up. This page explains what happens either way, so nothing is a black
box, and shows how to do each step by hand if you'd rather.

## The quick way: let your coding agent do it

In your project folder, add OpenRig's `rigs` skill to the agent you use:

```sh
# Claude Code
npx skills add https://github.com/mvschwarz/openrig/tree/<release-tag>/skills/rigs --skill rigs --agent claude-code
# Codex
npx skills add https://github.com/mvschwarz/openrig/tree/<release-tag>/skills/rigs --skill rigs --agent codex
```

For a new install, use the latest release's tag, for example `v0.7.5`. If OpenRig is already installed, use the tag
that matches `rig --version`, or upgrade first. If the command fails with `npx: command not found`, Node.js isn't
installed or isn't on your PATH yet (see [What you need](#what-you-need)). Then type `/rigs` in Claude Code, or `$rigs` in Codex, and say what
you want built.

The skill has your agent work through the steps below in order. It says what it will run and change before it runs
it, and it asks before installing anything on your system. It finishes when you're talking to the operator.

## How the pieces fit

- **`rig`** is the command you and your agents use. It comes from the npm package `@openrig/cli`.
- **The daemon** is a small background service on your machine. It keeps tasks, messages and state in a local
  database. `rig daemon start` starts it.
- **tmux** runs each agent in its own terminal session. Agents keep running when you close a window, and one agent
  can type into another's terminal.
- **The kernel** is OpenRig's own small team, which starts with the daemon. You talk to its **operator**, which
  starts and runs teams for you. Its **advisor** helps you think through what you want.
- **Your team** (a *rig*) is the set of agents that work on your project, such as `starter`.
- **The OpenRig view** is a terminal window with the operator and, beside it or on another page, a dashboard of your
  agents.

## What you need

- macOS or Linux. On Windows, use WSL2 ([one person's working setup](getting-started.md#wsl2-a-reported-working-setup)).
- Node.js 22 or 24 (on Apple silicon, Node.js 22) and tmux.
- Claude Code or Codex, signed in. One is enough to start.

If `node --version` does not show a supported version, first check your existing Node installation and PATH.
Ask your coding agent to help use the toolchain already on your machine. On a Mac, a shared Homebrew installation
may belong to another user; do not change its ownership to complete this setup. After correcting PATH or installing
Node, open a new terminal and check `node --version` and `npx --version` before continuing.

On a Mac where you aren't an administrator, or where another account owns Homebrew, install Node.js in your own home
folder with [nvm](https://github.com/nvm-sh/nvm); nvm itself needs no administrator password. A new Mac account has no
`~/.zshrc`, and nvm's installer only adds itself to a profile file that already exists, so create one first:

```sh
touch ~/.zshrc
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash
```

Then open a new terminal and run `nvm install 22`. If nvm's installer says you need Apple's command line tools, run
`xcode-select --install`, then its install command again. That's nvm v0.40.8's install command; [nvm's
page](https://github.com/nvm-sh/nvm#install--update-script) has the newest.

## What happens, step by step

Each step shows the command, so you can run it yourself.

### 1. Install the `rig` command

```sh
npm install -g @openrig/cli
rig --version
```

This installs the CLI globally under your npm prefix. `rig --version` prints the version and a commit, such as
`0.6.12 (9e5382dd)`. With npm 11 or later, an `npm warn install-scripts` line is expected: it means only the
Node.js and SQLite check was skipped.

### 2. Set up the tools around it

```sh
rig setup --providers claude
```

Use `codex` or `both` in place of `claude` to match the coding agents you use. Add `--dry-run` first to see the plan without changing anything. Setup does four things:
- it checks Node.js, tmux and your sign-in;
- it installs a missing tmux (with Homebrew on macOS, if you have it) or the coding agent you chose;
- it installs Herdr, a terminal workspace app the OpenRig view can use, unless you add `--no-herdr`;
- it adds an OpenRig block to `~/.tmux.conf` (mouse support and longer scrollback).

It doesn't start anything. It ends with a summary of what's done and what still needs you. A missing sign-in shows
there: run `claude auth login` or `codex login`, then carry on.

### 3. Start OpenRig

```sh
rig daemon start
rig status
rig ps --nodes --rig kernel
```

The daemon starts and boots the kernel with the coding agents you're signed in to, or both if you're signed in to both.

**What starting OpenRig changes, for the coding agents you use** (paths are the usual defaults):
- **For Codex:** hooks and trust in `~/.codex/config.toml`, when OpenRig or a Codex agent starts.
- **For Claude Code:** workspace trust in `~/.claude.json`, and activity hooks in the project's
  `.claude/settings.local.json`, plus a status line unless you already have your own.
- **For both:** small discovery skills in `~/.claude/skills` and `~/.agents/skills`.
- **Kernel access:** by default the kernel gets broader permissions than a project team gets by default. On Codex
  that's full access with no approval prompts. On Claude Code, its file tools, web fetches and operational commands,
  including reads under your home folder, run without asking. A permission policy, per-agent choice or Codex profile
  changes that.

OpenRig doesn't guarantee it can preserve or roll back these files, so back them up first. [Everything OpenRig writes, and why](../../README.md#what-openrig-changes-on-your-machine).

Started isn't the same as ready. `rig status` shows a `Kernel:` line, and `rig ps --nodes --rig kernel` shows each
kernel agent's state. They can take a moment after the daemon is up.

### 4. Open the OpenRig view

```sh
rig terminal open saved:kernel --window
```

**What you'll see:**
- **Where it opens:** a new terminal window or tab. If your agent is already running inside Herdr, it opens a new
  Herdr space instead. It uses Herdr when installed, plain tmux otherwise.
- **Layout:** in a narrow window, or when the width can't be measured, the operator fills the first page. From 120
  columns, the dashboard and the operator share it. The advisor has its own tab.
- **On a Mac:** you may be asked to let your terminal app be controlled. Allowing it is fine.
- **Over SSH or with no display:** the window can't open. The command says why and, where it can, prints a command
  to run in a new terminal. Otherwise your agent works out the exact command to join the operator.

You're installed when you're talking to the operator.

### 5. Start your first team

Tell the operator what you want built, and in which folder. It recommends one of three teams:
- `starter`: a builder and a reviewer, for one bounded change;
- `workshop`: a lead, a builder, QA and a reviewer, for ongoing work in one repository;
- `factory`: seven agents, for sustained product work.

Before it starts one, it tells you what starting a team in your folder changes: managed guidance in `AGENTS.md` or
`CLAUDE.md`, plus the team's skills. Then it waits for your yes. As shipped, `starter` uses both Claude Code and
Codex. With only one of them, ask the operator to adapt it.

By hand, from your repository (the first command shows what it would start, and starts nothing):

```sh
rig up starter --cwd . --plan
rig up starter --cwd .
rig ps --nodes --rig starter
```

If an agent stops at a sign-in, trust or permission prompt, `rig up` reports `Status: partial` and names the prompt.
Answer it in that agent's terminal, then run the `rig seat continue <seat>` command it prints. The team is ready
for work once its agents show as ready in `rig ps --nodes --rig starter`.

### 6. Give the team work, and stop it

```sh
rig send dev-build@starter 'Fix <one useful thing>. Ask dev-review to check it, and record the result and how I can try it.'
rig queue list --destination dev-build@starter
```

The builder records the work as a task, so you can follow it with `rig queue`. When you're done, `rig down starter`
stops that team. `rig daemon stop` stops the background service and leaves agent sessions running.

## The one-command install

Instead of steps 1 and 2 (the first line shows the plan and changes nothing):

```sh
curl -fsSL https://openrig.dev/install.sh | sh -s -- --dry-run
curl -fsSL https://openrig.dev/install.sh | sh
```

It checks Node.js and npm, installs the latest `@openrig/cli`, then runs `rig setup`. It doesn't know which coding agent
you use, so it checks and may install both. For just one, use steps 1 and 2. If a sign-in is missing, setup reports
it as the step to finish: sign in, then continue at step 3.

## What these words mean

- **Rig:** a team of agents, started with one command. Your first one is usually `starter`.
- **Seat:** one agent's role and address in a team, such as `dev-build@starter`.
- **Harness:** the software around the model that an agent runs in: Claude Code, Codex or Pi.
- **Kernel:** OpenRig's own small team, which starts with OpenRig. It isn't your project's team.
- **Operator:** the kernel's agent you talk to first. It recommends a team for your goal and starts it when you say
  yes.
- **Advisor:** the kernel's agent for thinking through what you want before a team starts. It has its own tab.
- **OpenRig view:** the terminal view that opens on the operator. In a wide window the dashboard sits beside it;
  otherwise, or when the width can't be measured, the dashboard is on its own page. `saved:kernel` in
  `rig terminal open saved:kernel` is the name of this saved view.

## Learn it in this order

1. **How OpenRig works:** [the world and its purpose](../../packages/daemon/assets/onboarding/01-world-and-purpose.md),
   the first page a new agent in a team gets. It's written to agents, and it's the shortest account of rigs, seats and
   queued work. Your install has the same page under `$(npm root -g)/@openrig/cli/daemon/assets/onboarding/`.
2. **First use:** this page, and [what these words mean](#what-these-words-mean).
3. **One command:** `rig <command> --help` is the exact answer for the version you have installed, and `rig --help`
   lists every command.
4. **Every command and flag:** the [CLI reference](../as-built/cli-reference.md).
   It describes the source commit it names, so where it and your installed `--help` disagree, `--help` is right for
   your version.

## More

- **Every detail of setup:** troubleshooting, permissions, headless and SSH use, and what can stop the view from
  opening. See the [setup reference](getting-started.md).
- **Stuck?** Run `rig context get help`, or read [Help](help.md).
