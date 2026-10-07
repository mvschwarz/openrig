# Getting started: meet the kernel, then make one useful change

Install OpenRig, use a working provider login, and meet the kernel operator with
the advisor and TUI beside it. No starter team is needed to reach that view.
Tell the operator what you want to do, then choose a project team for a bounded
change you can exercise. Reuse the accounts and terminal tools you already have.

Want the **welcome screen**, the **OpenRig view**, or to **show me my agents** / **see my agents**?
After installation and sign-in, the path is `rig daemon start` (if stopped),
then `rig terminal open saved:kernel --window`. The second command opens the
desktop window itself. An agent can run it from its shell on the daemon's
desktop; it does not need to type into your current terminal. See
[Open the kernel conversations](#open-the-kernel-conversations).
`rig tui` is the team dashboard; installation ends when you are talking to the
operator in the welcome view.

## Before you start

You need Node.js 22 or 24 and tmux, on macOS or Linux. On Linux, the
distribution's own Node.js can be older (Ubuntu 24.04's is 18); install a
supported version with [nvm](https://github.com/nvm-sh/nvm) (`nvm install 22`)
or NodeSource. On a Mac with Apple
silicon, use Node.js 22 (see the [compatibility
history](../releases/v0.5.15.md#known-compatibility-limitation)). Native
Windows isn't supported. On Windows, use WSL2: it's the Windows route OpenRig
supports, though OpenRig's automated tests don't run on it yet. One user's
[working setup](#wsl2-a-reported-working-setup) is below. Node 20 and
odd-numbered releases (23, 25 and so on) are not supported; Node 26 and later
even-numbered releases are untested.

**Choose permissions before starting the team.** Ordinary OpenRig launches use
Codex's `-s workspace-write`, with approval policy from your native configuration,
or Claude Code's `acceptEdits`, which still leaves commands subject to native
rules and prompts. A team seat with no permission policy, per-seat choice or
(for Codex) named profile also gets a per-launch
[team default](rig-spec.md#team-launch-defaults): Claude runs ordinary `rig`
commands, project reads and common tests without prompting, while lifecycle
commands such as `rig up` and `rig down` still ask; Codex also gets the OpenRig
workspace root and its pod's state directory as writable directories. The
kernel's own seats get a wider operational default. Codex's
sandbox normally blocks network access, including the local OpenRig daemon, so
before that plain launch OpenRig asks Codex for its own configuration and adds
network access inside the sandbox only when Codex answers that no configuration
layer sets `sandbox_workspace_write.network_access` and no managed requirement
could restrict it; if Codex can't be asked or doesn't answer in time, the launch
is left unchanged. To keep it off, set `network_access = false` under
`[sandbox_workspace_write]` in your Codex configuration. If Codex does not answer
within a few seconds, the seat starts without it. A command allowance does not
change general sandbox/network settings. The starter's `profile: default` selects OpenRig resources, not a native
permission profile.
Agent-guided setup [recommends keeping the team default](#have-your-agent-configure-permissions)
and offers to remember selected OpenRig commands in your native settings only if
you want that. An existing explicit choice is reused; No or no answer keeps the
team default and leaves settings unchanged. Broader access is separate.

If permission prompts are slowing you down, consider the
[workshop bundle](https://openrig.dev/rigs/workshop). It ships with broad access
and [non-interruptive mode](non-interruptive-mode.md): its agents bypass
permission prompts and supported harness warning dialogs. The listing and
before-install view explain that access before you choose it.

> Everything below reports **what is currently true**, never a guarantee that
> downstream work will succeed. "Daemon up" does not mean every agent is healthy;
> "kernel ready" does not mean every kernel agent is healthy; a workspace root
> being *live* does not mean it is the *right* one for your project.

## WSL2: a reported working setup

WSL2 is the Windows route OpenRig supports. OpenRig's automated tests don't run on
it yet; this is one user's working setup.
[dajiaohuang](https://github.com/dajiaohuang)
[ran OpenRig 0.6.6 under WSL2](https://github.com/mvschwarz/openrig/issues/88#issuecomment-6043925546)
on Ubuntu 24.04, with Node.js 24.14.1, tmux 3.4, Codex CLI 0.161.0 and Pi
(`@earendil-works/pi-coding-agent`) 1.0.4, headless, as the distribution's root
user.

- **What worked**, with one Codex seat and one Pi seat: `rig doctor`, starting
  the daemon (`rig daemon start --no-kernel`), launching both seats, replies to
  `rig send` and `rig capture`, and stopping with `rig down --snapshot`
  followed by a warm restore with `rig up --existing`.
- **What mattered:**
  - the install and the OpenRig instance on the Linux filesystem;
  - Linux-native Node.js and harnesses, not the Windows `npm` or `pi` that WSL
    inherits;
  - Pi credentials the managed seat can reach, because a global Pi login isn't
    shared with managed seats. This user put them in the seat's agent
    directory. For `openrouter`, `zai`, `kimi-coding` or `minimax`, a key in the
    daemon environment also works (`OPENROUTER_API_KEY`, `ZAI_API_KEY`,
    `KIMI_API_KEY` or `MINIMAX_API_KEY`): name it in
    `recovery.provider_auth_env_allowlist`, give the seat a `<provider>/<id>`
    model, then restart the daemon and relaunch the seat. Any other provider
    goes in the seat's agent directory;
  - the current `@earendil-works/pi-coding-agent` package in its own npm prefix,
    not the deprecated `@mariozechner` one.
- **Not tested:** the kernel and operator, herdr, reboot, suspend and resume,
  cross-host operation and long-running work.

## Install and sign in

**Agents:** if you're setting OpenRig up for someone, load the `rigs` skill and follow it. It carries the install, the
welcome screen and the handoff to the operator as one procedure. From 0.6.7, OpenRig installs it as `rigs` in
`~/.claude/skills` and `~/.agents/skills` when the daemon starts. Before that, add it with
`npx skills add mvschwarz/openrig --skill rigs`, or read [`skills/rigs/SKILL.md`](../../skills/rigs/SKILL.md).

**One command, for the full setup.** It needs Node.js 22 or 24 with npm already installed. The preview prints what the
script will do and changes nothing:

```sh
curl -fsSL https://raw.githubusercontent.com/mvschwarz/openrig/v0.6.6/scripts/install.sh | sh -s -- --dry-run
```

The same command without `--dry-run`,
`curl -fsSL https://raw.githubusercontent.com/mvschwarz/openrig/v0.6.6/scripts/install.sh | sh`, installs the
latest published `@openrig/cli` with `npm install -g`,
runs the Node.js and SQLite check, then `rig setup --dry-run` and `rig setup`. `rig setup` checks both Claude Code and
Codex and may install a missing one, as described below. A failed step prints
`FAILED [n/4] <command or check> (exit <code>)`. Where a provider isn't signed in yet, step 4 ends that way and
`rig setup` lists each sign-in under "Some steps need attention". If the only remaining failures are provider
sign-ins, the install steps finished: sign in to each selected provider as below, then continue at
[Start the kernel](#start-the-kernel-and-check-its-state). To install only what the selected providers need, go step
by step instead:

### Choose your providers

Ask: **“Which working account do you want this team to use: Claude Code, Codex,
or both?”** Reuse an explicit choice already made. Recommend the account the
user already has working; a second subscription is not a prerequisite.

Install OpenRig (`npm install -g @openrig/cli`) and check `tmux -V`. With npm 11 or later, an `npm warn install-scripts` line for `@openrig/cli` is expected: only the postinstall Node.js and SQLite check was skipped, and `node "$(npm root -g)/@openrig/cli/scripts/check-abi.mjs"` runs it. Check **only the selected providers**:

- Claude Code: `claude --version` and `claude auth status`. If sign-in is missing,
  ask once: “Please run `claude auth login` in your launch environment.”
- Codex: `codex --version` and `codex login status`. If sign-in is missing,
  ask once: “Please run `codex login` in your launch environment.”

Install a missing selected CLI using its provider's installation instructions.
The other provider's CLI/login is optional. Herdr is installed by default unless
you decline it; cmux remains optional. Do not copy credentials
or start repeated sign-in attempts. Recheck the selected login after the user
completes it. `rig setup --dry-run` previews the broader setup; applying
`rig setup` checks **both** harnesses and installs a missing one with npm; on
macOS it uses an existing Homebrew (it does not install Homebrew) to install a
missing tmux (elsewhere tmux is checked, not installed). Herdr installs on
macOS and Linux; pass `--no-herdr` to decline it. Setup also
writes an OpenRig-managed block (mouse on, a longer history) into `~/.tmux.conf`.
It is optional for this selected-provider path, not a requirement to fix an unused
provider.

## Start the kernel and check its state

With a working selected login, start the daemon if it is stopped, then read its
state and the kernel seats:

```sh
rig daemon start  # only if the daemon is stopped
rig status
rig ps --nodes --rig kernel
```

Starting the kernel, including its operator and advisor, is part of installing
OpenRig. Keep it for a normal install: it helps you choose and start your project
team. `rig daemon start --no-kernel` is for automation or an explicit request to
omit the kernel; it leaves you without that operator.

On a fresh instance, explicit daemon startup chooses the kernel variant from
successful native auth probes: Claude alone, Codex alone, or both. It starts the
kernel in the background without a project starter. An absent unused provider is
fine; if both accounts are authenticated, the kernel uses both even when your
later project uses just one. A request to use only one provider for everything
is a separate choice.

**Started is not ready.** Read the `Kernel:` boot state in `rig status` and the
individual seat state in `rig ps --nodes --rig kernel`. The view may open while
agents finish starting; describe that state, without claiming they are ready.
A missing or unknown readiness signal is not proof of readiness. Follow
[Incomplete setup and restart](#incomplete-setup-and-restart) for login, trust,
startup or missing-seat problems.

`rig setup` itself does not start the daemon. Preserve a daemon and kernel that
already exist: ordinary daemon startup skips a managed kernel, and
`OPENRIG_NO_KERNEL=1` skips automatic kernel startup. If neither runtime is
authenticated, kernel boot reports `auth_blocked`. Do not restart or recreate an
existing kernel merely to open its view. The startup TUI (`rig`) offers its own
kernel setup and individual-seat recovery; it does not automatically boot agents
when it starts the daemon.

## Open the kernel conversations

This is the **welcome screen** or **OpenRig view**: TUI | advisor | operator, in a new terminal window or tab.
**Agents:** the `rigs` skill says when to open it, what to check, what to do when it can't open, and how to hand the
person's goal to the operator; [Install and sign in](#install-and-sign-in) says how to load it.

`rig setup` installs Herdr by default on macOS and Linux. If the person declines
Herdr, use `rig setup --no-herdr`; the welcome view can use plain tmux. Setup
checks both PATH and the installer's default `~/.local/bin/herdr` location. It
leaves existing cmux settings alone and does not open a view during setup.

On a Mac, the installing agent also asks once, "Install Ghostty for the OpenRig
view?" On Yes it reruns setup with `--ghostty`, preserving earlier choices such
as `--no-herdr`. This installs the
[documented Homebrew cask](https://ghostty.org/docs/install/binary) and checks for
the app. On No it uses `--no-ghostty`; Terminal.app remains available. Plain setup
reports this offer without installing Ghostty or waiting for input. The person
types no command.

This command opens it in a new terminal tab or window itself, so nobody copies or types commands. Over SSH or
without a local display it can't, and the [headless handoff](#headless-or-ssh-handoff) applies:

```sh
rig terminal open saved:kernel --window --json
```

Run this on the daemon's desktop, as the same user. The command prefers a new
Ghostty tab on macOS when Ghostty 1.3 or newer is installed, otherwise a new
Terminal window. With no existing window, including an installation run from
Claude Desktop, it creates one. macOS may ask for Automation permission; let the
person answer that system prompt. A denied or uncertain action is reported once,
not replayed in another app. On Linux a local graphical display and a supported
terminal are required (Ghostty, the system terminal, GNOME Terminal, Konsole or
xterm). Linux reports a window request; verify what actually appeared.

The command runs Herdr when installed, using the daemon's configured session and
socket. Otherwise it creates a plain tmux viewing session. Explicitly choose the
latter with `--provider tmux --window`. Neither route types into or replaces the
installing agent's terminal. Existing conversations continue in their original
sessions.

Opening the same Herdr view with the same current plan selects its existing
OpenRig workspace in the new window, preserving its tabs and contents. The receipt
reports reuse and any currently absent or degraded seats; it does not claim to
refresh the layout or create new tiles. Changed membership or attachment targets
create a fresh workspace. A note identifies older workspaces and gives the command
to close them after inspection; nothing is closed automatically. If the workspace
inventory cannot be read, the command creates a fresh workspace and reports the
inventory problem.

### Confirm the view

The default `saved:kernel` composition is **TUI | advisor | operator**, in three
columns, for Claude-only, Codex-only and mixed kernels. The queue worker remains
reachable through the TUI. The composition uses the installed kernel's current
bindings; no YAML edit, seat launch or daemon restart is needed. A custom saved
view named `kernel` still takes precedence.

Inspect `opened`, `absent`, `degraded`, `window` and any notes. Confirm the new
surface visibly shows the intended conversations and TUI, and that the original
terminal remains intact. The person sees Herdr only in a terminal they can see.
Creating its workspace or switching the shared TUI to `:terminals` does not open
that terminal. A created window or successful CLI response alone is not visual
confirmation. A partial view remains partial. If the shared TUI tile shows a
shell, the installing agent starts `rig tui` in that new tile.

Opening the view can happen while the kernel finishes starting. Report its actual
state; do not start or restore seats just to obtain a view. If the kernel is absent
or blocked, follow [Incomplete setup and restart](#incomplete-setup-and-restart).

### What can interrupt installation and the welcome screen

For an installing agent, a blocked step needs an explanation, not silence. Name
the command, the reported reason and what remains unfinished. These checks cover
different points in the same journey:

| What you see | Why and what to do next |
| --- | --- |
| A missing Node.js, npm or tmux; an install download or command fails | The named prerequisite or install step did not finish. Read its error and the [platform and provider instructions](#install-and-sign-in), resolve that step, then recheck it. `FAILED [4/4]` with only selected-provider sign-ins outstanding means the package installed but those logins still need the person. |
| The installing harness refuses a tool call or asks for permission | Its native rules, sandbox or automatic permission decision apply before OpenRig can run. Claude Code's [auto mode can deny calls](https://code.claude.com/docs/en/auto-mode-config) as well as approve them. Show the specific refusal and ask the person to review it in the harness permission controls or run that named step themselves. Keep their chosen restrictions; a refused call does not prove the OpenRig command failed. |
| Herdr or Ghostty installation is unavailable or declined | Herdr is optional for the view: `--window` uses plain tmux when Herdr is absent, and its install failure is a warning. On macOS, Terminal.app is the fallback when supported Ghostty is absent. An explicitly requested Ghostty install can fail setup; resolve that install or decline it with `--no-ghostty`, preserving earlier choices. Address separate required-tool or login failures. Existing cmux remains supported. |
| macOS asks for Automation access, or the window action is denied | The command asks the desktop terminal app to open a new surface. Let the person answer the system prompt. Read the error and inspect any new window before retrying an uncertain action; do not silently switch apps and open a duplicate. |
| No local display, or the configured daemon is remote | `--window` needs the daemon's desktop. An SSH shell or remote daemon address alone does not give the agent that desktop. Explain the limit and use the [manual](#talk-to-the-operator-in-any-terminal) or [SSH handoff](#headless-or-ssh-handoff) with the actual operator binding. |
| Herdr shows its introduction or agent-integration panel | These are Herdr's first-run panels. Follow the displayed controls: Return continues the intro and Esc closes the integration panel. Opening this view does not require installing Herdr's agent integrations or changing your Claude/Codex settings. |
| Three columns are cramped in an 80×24 window | The desktop app's window size can be smaller than the composed layout. Enlarge the newly opened window so the dashboard and conversations are readable. Changing or restarting the team is unnecessary. |
| The command returned, but visibility is unconfirmed | With authorized desktop tools, inspect the new window and a screenshot of its contents. A window listing alone proves only that a window exists. If the agent has only shell access, report what the command confirmed and ask the person to confirm the visible TUI, advisor and operator. Do not report visual success without seeing it. |

After a failure, inspect any newly opened surface before retrying. A tmux failure
may name a newly created viewing session for inspection. Do not replace a failed
local desktop action with commands for the person to copy; finish or explain the
failed action. Close only the viewing window, or use **Ctrl-b, then d** in plain
tmux, to leave the underlying conversations running.

### Existing provider workspaces

The existing provider-only commands remain available when a terminal is already
open. They create a workspace inside that provider, without opening an OS window:

```sh
rig terminal views --json
rig terminal open saved:kernel --provider herdr --json
rig terminal open saved:kernel --provider cmux --json
```

Use `rig terminal status --json` to inspect provider availability and liveness.
For the first desktop handoff, use `--window`. Only if the window cannot open,
`rig tui --shared` is the dashboard-only fallback, not the operator's conversation.

### Talk to the operator in any terminal

For an explicitly requested manual attachment, inspect the current bindings:

```sh
rig ps --nodes --rig kernel --json
```

Find `logicalId: operator.agent` and use its `canonicalSessionName` in a new
terminal on the same host and account:

```sh
env -u TMUX tmux attach-session -t '=<canonicalSessionName>'
```

The installing agent fills in the actual session name. This optional manual route
is separate from the first-install desktop action above.

### Plain terminal: a new viewing session

`rig terminal open saved:kernel --provider tmux --window --json` creates and opens
the three-column view itself. It reuses the daemon's composition and preserves
existing sessions. The result names the viewing session. No pane names or shell
commands need to be assembled by the person.

### Headless or SSH handoff

A provider running on the server opens no window on the person's desktop. From a new terminal window or tab on their
own machine, connect over SSH with the known host and account, then attach:
- **the operator's conversation**, with the command in
  [Talk to the operator in any terminal](#talk-to-the-operator-in-any-terminal);
- **the Herdr view**, with the command that `rig terminal open saved:kernel --window` prints when it can't open a
  window. It names the installed Herdr, wherever setup put it, and the daemon's socket. Then
  `rig terminal open saved:kernel --provider herdr --json` selects the view in it.

No new account or credential provisioning is part of this. **Agents:** the `rigs` skill gives the person this as one
filled-in command.

### Installing-agent handoff

The kernel's operator takes the person's goal and project folder, helps them choose and start a team, and hands the
goal to the team's lead. The person can type the goal in the operator's pane (attach with the command
[above](#talk-to-the-operator-in-any-terminal)), or the agent that installed OpenRig sends it. The `rig tui --shared`
fallback shows the dashboard, not this conversation. If the operator needs attention, use the
[recovery routes](#incomplete-setup-and-restart).

**Agents:** the `rigs` skill's step 2 has the exact `rig send` to the operator and says when installation is finished.

Stopping OpenRig keeps a team's work, and the branch a team makes is your
change: an agent tidying up says what's on it before offering to remove it. The
operator starts a team when you ask for one in its conversation, so an agent
reporting back checks `rig ps` or the team's tasks before saying a team started
on its own.

## Choose your first team

Tell the kernel operator what you want to do. It asks about your goal, presents
three teams with one recommendation, and fits the team to the providers you have.
Review that choice before launching it.

`rig specs preview starter --kind rig` and the factory preview include the three
choices and their uses, in text and JSON. The reminder respects a team you already
picked; previewing a spec does not launch it.

| Team | Talk to | Agents and purpose |
| --- | --- | --- |
| `starter` | `dev-build@starter` | `dev-build` (Claude Code) and `dev-review` (Codex, pinned `gpt-6-astra`) for one bounded change |
| `workshop` | `orch-lead@workshop` | A lead, builder, QA and reviewer for ongoing work in one repository. It's a rig bundle, not built in: the operator installs it from its pinned listing |
| `factory` | `orch-lead@factory` | Seven: a lead, advisor, build, QA, design and two independent reviewers for sustained product work. It uses the most concurrent capacity |

As shipped, `starter` needs both Claude Code and Codex. With only one of them, the
operator writes an adapted copy of the team for your providers and keeps its name;
there are no per-provider variants. `first-project` is starter's old name and
still starts it, so an old `rig up first-project` now starts a Claude builder and a
Codex reviewer. If you already have a rig named `first-project` (or `starter`),
`rig up first-project` refuses instead and names the `rig up <name> --existing`
command that brings that rig back.

Claude seats use the native default model, as the Claude kernel does: OpenRig
does not pass a model override. Read the selected harness's configured model and
show it alongside the team and launch command before proceeding. Confirm account access to any pin; if unavailable,
ask for a supported model choice rather than silently substituting a model or
provider. After launch, confirm the actual native model before assigning work.

### Launch the starter team

```sh
cd <your-repository>
rig specs preview starter --kind rig
rig up starter --cwd . --plan
rig up starter --cwd .
rig status
rig ps --nodes --rig starter
```

Preview the selected seats, models and resources. Plan checks resolution and
preflight for the working directory. The kernel is already your entry point; this step starts the chosen project
team. Read readiness for the project seats, not only daemon health. Resolve a named authentication, trust or permission prompt before giving
that seat work. When a seat stops at such a prompt, `rig up` reports
`Status: partial`, prints `Startup attention (<seat>): <reason>` and exits 1;
`rig ps --nodes` repeats it as "Startup details". The reason ends with the command
to run once the prompt is answered: `rig seat continue <seat>`, which delivers the
seat's startup context in the same conversation. No new team is needed when
returning to an existing project.

When a seat pauses, open its existing terminal with **o** in the startup view.
Read the proposed command, working directory and target instance. For an intended
local `rig` call, choose the native prompt's one-time approval if that is the scope
you want; a saved command-prefix allowance also affects future matching calls.
Decline an unexpected operation and tell the same agent what to do instead.
Approval controls whether an action may run; the sandbox controls its filesystem
and network access. Turning approvals off does not grant network access.

After answering, watch for the command's result and the agent continuing. Read
the corresponding task and its history from your ordinary terminal. If an
operation timed out, read its result before asking for another attempt: it may
already have taken effect. A delivered message or disappearing prompt alone is
not progress. If startup is still waiting for context delivery, use **c** (or
`rig seat continue <seat>`) for the same occupant, then **r** to refresh. If the
command times out, check `rig seat status <seat>` before trying again. Do not
start another seat to clear a prompt.

Starter is a deliberately small starting point. For a bigger team, `factory` is
built in (seven agents, using more concurrent capacity), and so are the specialist
teams `code-review`, `research` and `pm`. Inspect `rig specs ls --kind rig` and
`rig specs preview <name> --kind rig` before selecting one (`pm` is also an agent
spec's name, so a preview without `--kind rig` reports it as ambiguous). A team published on GitHub, such
as workshop, installs from its folder link with `rig up <link>` (see
[publishing a rig bundle](publishing-a-rig-bundle.md)).

## Give the builder an outcome

For example, in a project that imports CSV files:

```sh
rig send dev-build@starter 'Improve the CSV import error when a required column is missing: name the column and leave the existing data unchanged. Add a regression check, ask dev-review for an independent check of the exact candidate, and record the result and how I can try it. Keep the change local; do not publish.'
```

Replace the example with a real problem in your repository. Include what the
user should observe, a boundary and how success can be checked. The builder
creates and claims a durable task, implements it, and routes the selected
independent check. You should not have to relay the review between terminals.
`rig send` is the initial conversation; the queue and repository artifacts
retain the work. An unbound shell does not need to impersonate a queue owner.

Seat addresses carry the rig name (for example, `dev-build@starter`). From an
actual project seat, follow the work with
`rig queue list --limit 1000`: its default scope is the caller's current rig.
`queue list` has no `--rig` option. From an observer shell or another rig, use
`rig queue list --destination dev-build@starter --limit 1000` and the same
command for `dev-review@starter`, after verifying those live addresses.
These show each destination's obligations, not a whole-rig view. An unbound shell
must not pretend to be a seat to change scope; use `--all-rigs` only when that
broader view is intended. Then read `rig queue show <id> --full` and
`rig queue transitions <id>`. A delivered message is not a reviewed result.
Read the artifact, exercise its behavior, and check the candidate reviewed.

## Share the dashboard and return to it

For “show me my agents” or the welcome screen, the installing agent runs
`rig terminal open saved:kernel --window` and checks the result. It does not
finish by suggesting a dashboard command for the person to type.

**Only if that window cannot open**, `rig tui --shared` is the dashboard-only
fallback. Explain the window failure and help with this fallback if chosen;
it does not show the advisor or operator conversation.

A fresh kernel runs the ordinary TUI in its existing `operator-human` terminal.
This command attaches another client to that terminal. **Ctrl-b, then d**
detaches without quitting the TUI; return with the same command and the view
stays where it was. Another authorized agent can capture or operate that same
pane. It should tell you before changing your view. The terminal is not a
human inbox and does not prove anyone is watching it.

Plain `rig tui` remains an independent local view. If an older kernel or a TUI
you quit shows a shell, run `rig tui` in that shell once. `--shared` does not
start or replace a terminal, so a missing binding is reported with recovery
guidance rather than creating a second kernel.

Herdr users follow the same launch and task path. To place the managed team in
Herdr, use `rig terminal open starter --provider herdr`; for the shared
dashboard together with the kernel conversations, use the
[saved first view](#open-the-kernel-conversations). The equivalent
cmux provider is also available. Read the opened/absent/degraded result: a
partial terminal view is not a healthy team. Repeated terminal-open calls can
create another provider workspace; return to the one already open when you
want to preserve it. This is terminal integration, not native plugin enrollment.

For team views with interactive panes, the open result distinguishes the dashboard
overview from the team's lead conversation and asks whether you can see the team.
This reminder is omitted from the default kernel view and entirely read-only watch
views. If the provider cannot open, each labelled fallback command joins a different
seat. Keep all returned commands
complete when sharing them; a created workspace alone does not confirm visibility.

## Continue real project work

Return to the same owner with the next outcome, citing the earlier result.
The seat address and durable queue survive closing your viewing terminal.
Keep intent, acceptance and evidence in the repository's existing project,
mission and slice artifacts; the starter reads those before inventing a path.
`rig context work-install` lists what the project declares (intent, context files,
skills). Without `--project` it picks the project by the seat's rig, then by the
working directory, and stops with `project_required` and the exact `--project`
commands only if several still match.

If the project has no work tree, start with `rig workspace doctor` and
`rig scope mission create --help`, then `rig scope slice create --help`. Set
the actual intended outcome before creating work. `rig scope` retains what is
being built. When repeated coordination warrants a workflow, discover with
`rig workflow specs`, inspect its owners and inputs, and instantiate the
selected name with `rig workflow instantiate --help`. A workflow is not needed
merely to make the first local change.

For a continuing team, [OpenRig Software Factory](../../packages/daemon/specs/agents/shared/skills/core/openrig-software-factory/SKILL.md)
offers manual/team work, queue-supported orchestration without Workflow, and an
optional explicit Workflow path, with wake defaults, token costs and permission
choices visible. Give its short request to your existing agent. After
installation, discover the compatible bundled recipe with `rig context show
skills/core/openrig-software-factory --json`; retain a missing/version-mismatch
result rather than silently using newer instructions. Its growth section keeps
three choices clear: stay with the pair, add one or two seats to the running rig
with `rig grow` and no YAML, or optionally author a custom rig. It covers
new-seat context/work ownership, concurrency costs and saving the expanded spec.
This guide remains the short first-use path.

## Stop your teams

`rig down <rig-name>` ends that rig's agent sessions and work in progress.
Read `rig ps --nodes --rig <rig-name>` first so you can see who will stop.
For example, to stop starter:

```sh
rig down starter
```

For "stop everything", list the rigs with `rig ps --json` and run `rig down`
for each one you want stopped. Include `kernel` last if you want its operator,
advisor and queue worker stopped too; its operator cannot continue helping
after its own session ends. Check each result before calling the shutdown done.

`rig daemon stop` stops only the background service and preserves agent tmux
sessions. If you also want that service stopped, run it after stopping the rigs.
If the operator is handling this full shutdown and kernel is included, it gives you this
last step before running `rig down kernel`: once kernel is down, run
`rig daemon stop` in your own shell and check the result. The operator's session
ends with kernel, so it cannot run that final command for you afterwards.
If the daemon is already stopped, use `rig daemon start --no-kernel` to restore
the lifecycle API without booting a new kernel, then stop the remaining rigs.

## Incomplete setup and restart

| Observation | Next action |
| --- | --- |
| Tool missing or login fails | Use the specific setup/auth hint; recheck that executable in the launch shell. Do not send work to an unready seat. |
| "Startup attention" or "Startup details" names a prompt | Answer the login, trust or bypass prompt in that seat's terminal, then run the `rig seat continue <seat>` it shows. |
| "Readiness timeout after 30s — harness did not become interactive" | The harness took longer than the readiness window. Raise it for the next launch with `rig config set runtime.readiness_timeout_seconds <1-600>`, then relaunch that seat. |
| Daemon is healthy, kernel is still starting | Read `rig status` and `rig ps --nodes --rig kernel`; kernel readiness is separate. |
| Shared terminal is absent | Inspect the existing kernel binding and recovery state; use standalone `rig tui` while resolving it. |
| Viewing terminal was closed | Open the conversations again with `rig terminal open saved:kernel --window`; `rig tui --shared` is only the dashboard fallback if that window cannot open. Do not relaunch the team. |
| Daemon restarted but tmux survived | Re-read `rig status` and the existing queue; a daemon restart is not a fresh project. |
| Host reboot lost tmux sessions | Open `rig`, start the daemon if needed (press **S** if it opens on the work views), and select the existing rig and seats. Resume is the default; a fresh conversation needs a separate decision. |
| Launch reports no usable snapshot | Inspect the existing rig and retained project files, then follow the same-seat recovery below. |
| Work is waiting on a prompt or decision | Read the row, transition and named prompt; preserve the obligation until the missing decision arrives. |

If a snapshot is unavailable, the startup view checks the selected seat's
retained startup source and authoritative occupant relation. It reports a
missing or ambiguous source instead of selecting an arbitrary historical row.
Repair the named source, retry, or leave the seat stopped. Check the retained
queue, project notes and observed result before continuing work.

`rig setup` prints the short form of this path after ready, incomplete and dry-run
results; JSON output includes it as `nextSteps`. This guidance does not mean the
kernel is ready: retain any named failures, check the actual seat state, then
offer `rig terminal open saved:kernel --window`. If the person chooses a manual
attachment after a failure, derive the exact command from the current operator
binding [above](#talk-to-the-operator-in-any-terminal); not every failure prints
one. Hand the goal and project folder to the ready
operator rather than implementing the project during installation. `rig status`
points back here while no rigs are registered.

### Use the startup and work TUI

Type `rig` in an ordinary terminal to open the startup and work TUI. It shows
the daemon address; **d** expands the selected instance path and diagnostics.
If the daemon is stopped, press Enter
to start that daemon, then choose the rigs and seats you want. Kernel is
recommended first; selecting its operator does not start every kernel seat.
The same view is available with **S** from ordinary TUI work.
**?** opens Help even while connection checks are pending. **w** skips startup;
**Esc** goes back, or leaves startup from its first page. These choices do not
start a daemon or a seat. **L** opens local reading before or after connecting:
choose configured Specs, project intent, projects, or missions and slices, then
select a directory or file. **r** reads the selected source again; **Esc** returns.
Local reading uses this machine's configured workspace paths and file allowlist,
including when the selected daemon address is remote. It shows disk provenance,
missing or denied sources, binary files and the 1 MiB text truncation boundary.
These disk snapshots may change after reading and do not supply live queue,
execution or topology state. Once connected, the TUI opens the ordinary work
views by itself unless you have already pressed a key; **S** returns to startup.
A stalled live read does not prevent Help or local reading.
When terminal transport is unavailable, **t** starts the empty terminal service
so recovery choices can be inspected. It launches no seats.

For a previously occupied seat, Enter attempts its previous conversation.
If history is unavailable, read the reason. **f** opens a separate fresh-start
decision for that named seat; **Esc** declines without launching it. A confirmed
fresh conversation receives the configured context and retains the old history,
but does not resume that history. Authentication or runtime failures require
repair of that prerequisite. **o** opens the existing native terminal here; detach
to return (tmux defaults to Ctrl-b, then d). Decide native trust/auth prompts
there. If a fresh start paused before context delivery, **c** finishes that
delivery to the same occupant (from a shell, `rig seat continue <seat>` does the
same). **r** reads actual state again; **d** expands details.

## Kernel framing (what `rig setup` does and does not do)

Explicit CLI daemon startup retains its automatic kernel behavior. The TUI
starts the daemon with kernel auto-boot disabled so the user can select seats:

- `rig setup` installs/verifies the runtime; it does not start the daemon or the
  kernel.
- Starting the daemon (`rig daemon start`, or implicitly via `rig up` or `rig context add`) is what
  boots the kernel rig in the background.
- Starting it from bare `rig` prepares no agents automatically. The TUI offers
  kernel setup and individual seat selection after connecting.
- **Kernel readiness is a distinct signal from daemon health.** The daemon's HTTP
  health binds early; the kernel can still be booting or a kernel agent can be
  unhealthy while the daemon is up. `rig status` surfaces kernel readiness
  separately (via `/api/kernel/status`); `rig daemon start --wait-for-kernel`
  polls it.

## The scope <-> workflow bridge

Two related primitives, often confused by new operators:

- **`rig scope`** manages **durable, on-disk artifacts** - missions and slices
  (markdown/YAML files in your workspace). These are the persistent record of
  *what work exists*.
- **`rig workflow`** manages a **runtime instance** - when you
  `rig workflow instantiate <name>`, the daemon creates a workflow instance plus
  an **entry qitem** that routes the first step to an owner. This is the live
  coordination of *who does the next step*.

Scope files retain what the work is; workflow instances and their queue packets
retain who acts next. Creating or editing a mission does not start work. You can
instantiate a named workflow with `rig workflow instantiate <name> --root-objective <text> --created-by <session>` (both options are needed), or explicitly
inspect an authored lifecycle with `rig workflow compile` and create its runtime
with `rig workflow instantiate-lifecycle`. Compilation alone does not start work.
[OpenRig Software Factory](../../packages/daemon/specs/agents/shared/skills/core/openrig-software-factory/SKILL.md)
shows a small reviewed example and how to retain custody through a genuine wait.

## Have your agent configure permissions

For a team with no permission policy, your agent recommends keeping the
[team default](rig-spec.md#team-launch-defaults), unless you already made an
explicit choice for these harnesses and this scope. It offers additional
remembered allowances only if you want them:

> Remember these selected OpenRig commands in your native settings for this
> project? This is separate from the team launch default; stricter rules and
> Claude lifecycle asks remain. **Yes / No — keep the team default**

A remembered allowance can cover the whole `rig` family, but on Claude team
seats lifecycle commands such as `rig up` and `rig down` still ask. It is not
global YOLO or permission to invent work. The scope is your personal settings
for this project unless you explicitly choose user-wide sessions, which can
affect your other projects.

On an actual **Yes**, the agent backs up the relevant files, adds the existing
native rules without duplicates, and preserves stricter rules and unrelated
settings. It checks bare and actual absolute-path invocations, rule loading and
repeated harmless reads in the target conversation. No or no answer leaves
settings alone and keeps the team default. Unsupported scope or a
managed restriction is reported; it is not permission to grant broader access.

The agent remembers an explicit choice, scope and exact additions in existing
onboarding context, so setup does not ask again. You do not need to approve each
routine edit separately. To undo, say **“Undo the OpenRig command allowances
added by this setup; keep my other rules.”** The agent removes only its recorded
additions, preserves earlier rules and later edits, and verifies reloading.
Other pre-existing allowances may still permit commands after this undo.

Use the maintained **Applying a permission policy** procedure:

```sh
rig context get skills/applying-a-permission-policy/SKILL.md
```

In a source checkout, read [its source](../../packages/daemon/assets/plugins/openrig-core/skills/applying-a-permission-policy/SKILL.md).
In an npm installation, the same file is under
`@openrig/cli/daemon/assets/plugins/openrig-core/skills/applying-a-permission-policy/SKILL.md`
below the matching `npm root -g` or local `npm root`. Use the version supplying
your `rig` executable. It covers Codex/Claude command rules, actual config roots,
preserving restrictions and verifying the target conversation. A missing guide or
unsupported native version is a reported gap, not permission to silently bypass.

The broader launch-mode recipes below are optional. Command-family rules do not
require changing the starter's sandbox or everyone else's defaults.

## Opt-in permissive operation

Permissive operation lets agents act with your account's filesystem and network
access with fewer permission stops. They can damage files or send data without
another confirmation. Use it only for work and an environment you deliberately
trust; it does not supply missing credentials or override organization policy.

Make changes in a **user-owned spec before its first launch**. To customize the
starter, run `rig specs show starter --kind rig` and find its `Path`, ending
in `specs/rigs/launch/starter/rig.yaml`. Copy that whole `specs` directory to
`./openrig-specs` in your repository, keeping its layout: copying only `rig.yaml`
breaks its relative agent and culture references. Leave the installed copy alone.
The examples below use `./openrig-specs/rigs/launch/starter/rig.yaml`. If you
already have a running `starter`, follow the existing-session advice below
before changing it; this is not a live permission switch.

### Codex: select sandbox and approvals together

For Codex versions supporting named `.config.toml` profiles, create
`~/.codex/starter-permissive.config.toml` (under `CODEX_HOME` instead if you
set it for the daemon's launch environment):

```toml
sandbox_mode = "danger-full-access"
approval_policy = "never"
```

In the copied rig, add this field to **each Codex member** that should use it (in
starter, that's `dev.review`); keep the member's existing `profile: default`:

```yaml
codex_config_profile: starter-permissive
```

Leave `permission_policy` absent or set it to `none`, with no member-level YOLO
override. OpenRig then passes `-p starter-permissive` instead of its default
`-s workspace-write`, so the native profile supplies both settings. Higher-priority
native project configuration or managed requirements can still change/refuse the
result. Inspect native `/status` before assigning work.

```sh
rig policy current --spec ./openrig-specs/rigs/launch/starter/rig.yaml
rig up ./openrig-specs/rigs/launch/starter/rig.yaml --cwd . --plan
rig up ./openrig-specs/rigs/launch/starter/rig.yaml --cwd .
```

OpenRig's `permission_policy: builtin:yolo` setting selects
`-s danger-full-access -a never` on fresh, resume and fork launches, replacing
the named-profile argument. The profile recipe above remains useful when you
want to maintain those choices in native configuration. The legacy
environment-only `OPENRIG_YOLO=1` path remains sandbox-only when no resolved
policy is present. A standalone `codex --yolo` command is not an OpenRig setting.
At full access, Codex can show its full-access and GPT-5.1 migration notices at
first launch. When OpenRig itself selects full bypass for the seat (`builtin:yolo`,
a `full_bypass` flag policy, or an explicit seat `full_bypass`), `rig up <spec> --non-interruptive` hides them
with per-launch `-c` overrides (see [non-interruptive mode](non-interruptive-mode.md)).
Full access chosen inside a native Codex profile, with `permission_policy` absent or
`none`, doesn't qualify.

To return to a restricted next launch, change the selected profile to:

```toml
sandbox_mode = "workspace-write"
approval_policy = "on-request"

[sandbox_workspace_write]
network_access = false
```

### Per-seat permission mode

Permission mode is the native execution choice; work posture is project guidance.
For an existing managed seat, select future-launch permissions explicitly:

```sh
rig seat set-permissions dev-build@starter --mode full_bypass --reason "Operator selected broader access"
rig seat status dev-build@starter --json
```

This records the actor, reason and old/new choice on that seat. It does not
relaunch it, alter native history, change sibling seats, or edit permission
rules/hooks. A later lifecycle action remains a separate decision. The explicit
seat choice overrides the inherited member/rig policy; `--mode inherit` clears
it without changing that inherited policy. `floor` selects the existing normal
launch path (including a Codex named profile when configured); it does not
rewrite a native profile or force its approval settings. An explicit `floor`
also replaces any team or kernel launch default with the plain floor flags;
`inherit` brings the default back.

Codex and Claude accept `floor` and `full_bypass`. Additional Claude native modes,
including `auto`, require support advertised by the managed executable's help.
OpenRig resolves the first executable on its managed launch PATH at the seat's
absolute working directory, then uses that exact path for discovery and launch.
It does not use interactive shell aliases or a shell's modified PATH. Relative
PATH entries and a relative `CLAUDE_CONFIG_DIR` resolve from the seat directory.

For these explicit native modes, fresh, resume, fork and legacy restore use the
same managed environment: PATH, HOME, `CLAUDE_CONFIG_DIR` (default HOME/.claude)
and the configured classic-renderer setting. Other shell customizations are
excluded. The existing managed identity and allowlisted provider-auth channel
is retained by variable name; credentials are not copied into launch commands
or capability evidence. Help runs without that credential channel. Existing
login files remain under the managed home. Configure the daemon's managed
launch environment deliberately before selecting a mode; this is not a probe
of an arbitrary interactive shell.

Each selection and each later launch checks support again, without a cache.
A changed node/occupant, binding, cwd, executable or capability environment
refuses at the next check: after help, before selection/audit mutation, and
immediately before paste and Enter. A failure after a valid paste is partial
input, not a successful launch or a claim that earlier input was rolled back.
An existing explicit selection is retained on refusal; no fallback is chosen.
Ordinary and inherited launch paths are unchanged. The status response
distinguishes desired settings, generation-bound
launch arguments and an unverified native effect. Inspect the native session
after an authorized launch before claiming its actual permission behavior.

The rig-level verbs are `rig policy permissions list`, `show`, `current` and
`apply`. Existing `rig policy list/show/current/apply` remain compatibility
aliases with the same JSON and exit behavior. Pi resource trust and the per-seat
typing guard are separate controls.

### Claude Code: a different launch flag

In the shipped `starter`, `dev-build` runs Claude Code. For a **Claude Code** seat,
OpenRig normally passes `--permission-mode acceptEdits`: edits can proceed, while
other actions follow native rules and prompts. For a seat with no permission
policy or per-seat choice it also passes the per-launch team default (`--settings` allowing ordinary
`rig` commands, project reads and common tests, with a session hook asking for
lifecycle commands while allowing literal help forms such as `rig down --help`);
personal and project rules still apply. Nothing is written to your settings files. To explicitly select the bypass launch flag for that rig:

```sh
rig policy apply yolo --spec ./my-claude-rig/rig.yaml
rig policy current --spec ./my-claude-rig/rig.yaml
```

This records `permission_policy: builtin:yolo`; the next managed launch passes
`--dangerously-skip-permissions`. Member-level policies take precedence.

On a machine where nobody has accepted it yet, Claude Code then shows its
bypass-permissions warning in each new seat, and OpenRig reports the seat as
needing attention without sending its startup context. Either accept the warning
once beforehand (run `claude --dangerously-skip-permissions` in your repository,
accept, then `/exit`; Claude Code remembers it), or accept it in the seat and run
`rig seat continue <seat>`. Or launch with `rig up <spec> --non-interruptive`,
which accepts it with a launch flag and writes nothing to your settings; see
[non-interruptive mode](non-interruptive-mode.md).

`rig policy apply auto --spec ./my-claude-rig/rig.yaml` (also `rig setup --policy
auto --spec ./my-claude-rig/rig.yaml`) records `builtin:auto` instead: Claude seats launch with
`--permission-mode auto`, and Codex and Pi seats, which have no auto mode, launch
at the floor. To return future launches to the team default, remove
`permission_policy` from the spec along with any member-level bypass override.
`rig policy apply none --spec ./my-claude-rig/rig.yaml` instead records plain
`acceptEdits` without the team allowances. Native rules
and managed restrictions still matter; this flag is not a promise about sandbox
or account access. See [Claude permissions](https://code.claude.com/docs/en/permissions).

**Already running:** changing a file or running `rig policy apply` does not revoke
a live agent's permissions, nor rewrite a stored rig's policy on restore. Pause
work and use the native permission controls for that conversation (current
Codex and Claude CLIs expose `/permissions`); inspect the effective mode again.
Keep the launch spec/profile consistent for subsequent launches. If the native
version cannot apply the change in place, preserve the work and use the supported
same-seat stop/resume path after checking its retained policy; do not erase the
rig or start a duplicate to reset permissions. A resume can reapply the stored
launch mode, so verify the native mode again before continuing work.

## Custom settings and precedence

- **OpenRig:** member `permission_policy` overrides rig `permission_policy`.
  Normal managed launches bind the default mode explicitly when neither is set;
  exporting `OPENRIG_YOLO=1` in a client shell is not a reliable per-team recipe.
  A custom policy file is relative to the declaring rig spec, with no absolute
  path or `..`. `surface: flag` selects a launch mode. Config-surface policies
  (`locked`, `standard`, `open`, or custom) describe intent: recording one does
  not translate and enforce its rules. Apply and inspect the actual native
  settings separately. See [RigSpec policy references](rig-spec.md#attaching-a-permission-policy).
- **Codex:** personal settings live in `~/.codex/config.toml` or `CODEX_HOME`;
  trusted project settings live in `.codex/config.toml`. Current precedence is
  CLI overrides, trusted project settings, selected profile, user settings,
  cloud defaults when supplied, `/etc/codex/config.toml` on Unix, then built-in
  defaults, subject to managed requirements. OpenRig's explicit sandbox flag
  wins over a file's `sandbox_mode`; use `codex_config_profile` for a custom
  sandbox instead. For workspace edits with network access while retaining
  approvals, use a named profile with `sandbox_mode = "workspace-write"`,
  `approval_policy = "on-request"` and `[sandbox_workspace_write]`
  `network_access = true`. That grants network access generally, not just to
  the local daemon. See [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-basic)
  and [sandbox/approval controls](https://learn.chatgpt.com/docs/agent-approvals-security).
- **Claude Code:** use `~/.claude/settings.json`, shared project
  `.claude/settings.json`, or personal project `.claude/settings.local.json`.
  Managed settings precede launch flags, then project-local, project-shared and
  user settings. Permission-rule lists combine; a higher-level allow is not a
  way to defeat a deny. OpenRig's `acceptEdits` launch flag overrides a file's
  `permissions.defaultMode`; selected runtime resources may also merge into
  project-local settings. See [Claude settings and precedence](https://code.claude.com/docs/en/settings)
  and [OpenRig's runtime config disclosure](agent-startup-guide.md#runtime-config-disclosure).

These recipes do not establish every provider/version/config combination.
Check the installed version and effective settings. Newer permission-profile or
automatic review features are provider choices, not implicit OpenRig capabilities.
Selecting rules or a broader mode does not change the shipped defaults.
