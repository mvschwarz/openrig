# OpenRig

[![npm version](https://img.shields.io/npm/v/@openrig/cli)](https://www.npmjs.com/package/@openrig/cli) [![npm downloads](https://img.shields.io/npm/dw/@openrig/cli)](https://www.npmjs.com/package/@openrig/cli) [![License: Apache 2.0](https://img.shields.io/github/license/mvschwarz/openrig)](LICENSE) [![GitHub stars](https://img.shields.io/github/stars/mvschwarz/openrig?style=social)](https://github.com/mvschwarz/openrig/stargazers)

A harness wraps a model. A rig wraps your harnesses. Define your agent team in YAML, boot it with one command. Claude Code and Codex in the same rig, managed as one system.

OpenRig is open-source software for building and running your own network of agents. It turns AI coding agents from a pile of terminal sessions into a persistent, organized team. Talk to a lead agent about the outcome you want; it can coordinate specialists across teams and bring you results and decisions that need your attention. Start with a repository and one useful change, then keep the team's work and context at the same addresses.

It's the open-source system behind my AI civilization experiments.

**Guide:** [Getting started](docs/reference/getting-started.md) · **Stuck?** [Help](docs/reference/help.md) · **Questions:** [Q&A](https://github.com/mvschwarz/openrig/discussions/92) · **Updates and demos:** [@_feralmachine on X](https://x.com/_feralmachine)

## See it running

![The OpenRig TUI: the build rig as a graph, then as a table of seats with runtime, model, context and state, then one seat in detail (real recording, 10 seconds)](assets/readme/openrig-agents-working.gif)

**Start here:** [the guided first-use path](docs/reference/getting-started.md): install, talk to the kernel operator, then choose a team for your first useful change.

Not setting this up today? Get the next walkthrough and occasional OpenRig updates → https://openrig.dev/follow

## Install and first run

Requires Node.js 22 or 24 and tmux, on macOS or Linux. On Linux, the distribution's own Node.js can be older (Ubuntu 24.04's is 18); install a supported version with [nvm](https://github.com/nvm-sh/nvm) (`nvm install 22`) or NodeSource. On a Mac with Apple silicon, use Node.js 22 ([compatibility history](docs/releases/v0.5.15.md#known-compatibility-limitation)). On Windows, use WSL2, the Windows route OpenRig supports; native Windows isn't supported. OpenRig's automated tests don't run on WSL2 yet; see [one user's working setup](docs/reference/getting-started.md#wsl2-a-reported-working-setup). Launching a rig writes provider hooks and workspace trust settings. Before running the commands below, read [what OpenRig changes on your machine](#what-openrig-changes-on-your-machine) and back up the relevant files.

**One command.** This runs OpenRig's install script from the `v0.6.6` release. It checks Node.js and npm, installs the latest published `@openrig/cli` with `npm install -g`, runs the Node.js and SQLite check, then runs `rig setup --dry-run` and `rig setup`. The first line prints that plan and changes nothing:

```bash
curl -fsSL https://raw.githubusercontent.com/mvschwarz/openrig/v0.6.6/scripts/install.sh | sh -s -- --dry-run
curl -fsSL https://raw.githubusercontent.com/mvschwarz/openrig/v0.6.6/scripts/install.sh | sh
```

If a provider isn't signed in yet, the last step reports `FAILED [4/4]`, and `rig setup` lists the sign-in under "Some steps need attention". If the only remaining failures are provider sign-ins, the install steps finished; sign in to each selected provider as below and continue.

**Or step by step:**

```bash
npm install -g @openrig/cli
rig setup --dry-run
```

To install with Bun instead, run `bun add -g @openrig/cli`. OpenRig still runs on Node.js, so install Node.js 22 as well. Bun may block this package's postinstall script, in which case the Node.js and SQLite check described under [what OpenRig changes on your machine](#what-openrig-changes-on-your-machine) does not run at install time.

npm 11 and later can skip that postinstall script and print `npm warn install-scripts` naming `@openrig/cli`. That's expected: the CLI still works, and only the Node.js and SQLite check was skipped. To run it yourself, use `node "$(npm root -g)/@openrig/cli/scripts/check-abi.mjs"`; `rig doctor` checks the Node.js version only.

Choose the working account you already have: **Claude Code, Codex, or both**. Reuse an explicit choice; no second subscription is required. `rig setup --dry-run` previews the broader setup; applying `rig setup` checks both harnesses and installs a missing one, plus Herdr unless declined with `--no-herdr`. On macOS, the installing agent offers Ghostty once. Setup leaves an existing cmux installation alone. It is optional for the [selected-provider path](docs/reference/getting-started.md#choose-your-providers).

A team seat with no permission policy, per-seat choice or (for Codex) named profile launches with OpenRig's [team default](docs/reference/rig-spec.md#team-launch-defaults): Claude runs ordinary `rig` commands, project reads and common tests without prompting, while lifecycle commands such as `rig up` and `rig down` still ask; Codex also gets the OpenRig workspace and its pod's state directory as writable directories. Before launching, your agent recommends keeping that default, and offers to remember selected OpenRig commands in your native settings only if you want that, at personal project scope unless you explicitly choose user-wide sessions. It is not global YOLO or permission to invent work. On Yes, the agent [adds and verifies native rules](docs/reference/getting-started.md#have-your-agent-configure-permissions); No or no answer keeps the team default and leaves settings unchanged. An existing explicit choice is reused. Say “Undo the OpenRig command allowances added by this setup” to remove only its additions.

If permission prompts are slowing you down, consider the
[workshop bundle](https://openrig.dev/rigs/workshop). It ships with broad access
and [non-interruptive mode](docs/reference/non-interruptive-mode.md): its agents
bypass permission prompts and supported harness warning dialogs. The listing
and before-install view explain that access before you choose it.

Check `tmux -V` and only your selected CLI/login: `claude --version` plus
`claude auth status`, or `codex --version` plus `codex login status`. If needed,
sign in once with `claude auth login` or `codex login`; do not install or log in
to an unused provider.

### Open the switchboard

Ask your agent to **“open the switchboard”**, **“open the OpenRig view”** or
**“show me my agents”**, **“show me the terminals”** / **“let me see my agents.”** After checking the selected login, it runs:

```sh
rig daemon start  # if stopped
rig terminal open saved:kernel --window
```

`--window` opens a new terminal tab or window itself, or a space in your current
Herdr session. Below 120 measured columns,
the **operator** fills the first page; from 120, the dashboard and operator share
it equally. The advisor has a separate tab or tmux window.
An installing agent can run it from its shell on the daemon's
desktop; the person copies nothing. It uses Herdr when installed, otherwise
the same layout in plain tmux, and preserves existing conversations. `rig tui`
is the team dashboard. Installation is finished when you are talking to the
operator; if you choose to talk later, that handoff remains pending.

If setup stops, read the named step: missing tools and selected-provider logins
need their specific setup action. A harness permission rule, sandbox or automatic
permission decision can also block the installing agent's command. The agent
should name the command and reported reason, then help you resolve that specific
step within your chosen permissions. A permission refusal is not an OpenRig
installation result.

The desktop may need an Automation approval; SSH/headless sessions may have no
display. Herdr can show first-run panels, and an 80×24 window can cramp the view.
Follow [the switchboard checks and next steps](docs/reference/getting-started.md#what-can-interrupt-installation-and-the-switchboard).
Herdr is visible only inside a terminal you can see. Changing the shared TUI to
`:terminals` does not open that terminal. The agent checks the visible window when
it has desktop access and says what it could not verify otherwise. Over headless
SSH, it asks you to open a new terminal window or tab and gives the exact connection
and attachment command for the current view. If you choose a manual attachment
after a failure,
ask the installing agent for the exact command using your current operator
session; run that in a new terminal window.

The kernel's operator helps you pick a first team. It asks what you want to build,
recommends one of three, and fits it to the providers you have.

| Team | Talk to | Agents and purpose |
| --- | --- | --- |
| `starter` | `dev-build@starter` | A Claude Code builder and Codex reviewer for one bounded change |
| `workshop` | `orch-lead@workshop` | A lead, builder, QA and reviewer for ongoing work in one repository; a rig bundle the operator installs from its pinned listing |
| `factory` | `orch-lead@factory` | Seven: a lead, advisor, build, QA, design and two independent reviewers for sustained product work |

As shipped, `starter` uses both Claude Code and Codex. With only one of them, ask
the kernel operator to adapt it: it writes a copy of the team for your providers
under the same name. `first-project` is starter's old name and still starts it,
unless you already have a rig named `first-project` or `starter`: then it refuses
and names the `rig up <name> --existing` command that brings that rig back.
Show the selected runtime, configured model and command before launch; confirm the
account supports the model instead of silently falling back. The kernel starts
automatically and selects from available authenticated providers independently of
these teams. A missing unused provider is not a setup requirement.

To launch the starter yourself instead (the manual path, without the operator):

```bash
cd /path/to/your/repository
rig specs preview starter --kind rig
rig up starter --cwd . --plan
rig up starter --cwd .
```

To see your agents, use `rig terminal open saved:kernel --window`. If that window cannot open, `rig tui --shared` is the named dashboard-only fallback; it does not show the operator conversation. The installing agent should resolve or explain the window failure, not finish by suggesting a command for you to type. Closing a viewing terminal does not mean you should relaunch the team.

Check project-seat readiness with `rig ps --nodes --rig starter` and resolve any authentication, trust or permission prompt before assigning work. If a seat stopped at such a prompt before its startup context arrived, `rig ps` shows the `rig seat continue <seat>` command that delivers it once the prompt is answered. Then give the builder one bounded outcome from your repository:

```bash
rig send dev-build@starter 'Implement <one useful change>. Track the task in the queue and return its ID. Keep it local, verify the behavior, ask dev-review in this rig to check the exact candidate, and record the result and how I can try it.'
rig queue list --destination dev-build@starter --limit 1000
```

Sending a message does not itself create a queue item; the builder records the task. Read the final artifact and the review of its exact candidate, then return to the same builder for the next change. [The guided first-use path](docs/reference/getting-started.md) covers readiness, a useful task, a reviewed result, Herdr/cmux terminals and recovery.

Not setting this up today? Get the next walkthrough and occasional OpenRig updates → https://openrig.dev/follow

## Community

- **Questions:** [Discussions › Q&A](https://github.com/mvschwarz/openrig/discussions/categories/q-a)
- **Bugs and feature requests:** [open an issue](https://github.com/mvschwarz/openrig/issues/new/choose)
- **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md) · [Security policy](SECURITY.md) · [Getting help](.github/SUPPORT.md)
- **Videos:** [youtube.com/@openrig](https://www.youtube.com/@openrig)
- **Releases:** [GitHub Releases](https://github.com/mvschwarz/openrig/releases) and npm `@openrig/cli`

We aim to acknowledge issues and pull requests within one day; see [CONTRIBUTING.md](CONTRIBUTING.md#what-to-expect-from-us) for review targets.

## What OpenRig changes on your machine

OpenRig writes instance state, provider integration and workspace files as part
of setup and operation. These include **trust settings and executable hooks**.
The summary below follows this source revision; check `rig --version` when
using a published package, since repository guidance can be ahead of npm.

| When | What changes and why |
| --- | --- |
| **npm installation** | Installs the CLI (`rig` and `openrig-tui`), bundled components and dependencies under your npm prefix (with Bun, under Bun's global directory). OpenRig's postinstall checks the Node.js version and that the SQLite module loads; Bun may block this script. It does not run daemon or provider setup. |
| **`rig setup`** | Attempts missing tools and writes an OpenRig block in `~/.tmux.conf` for mouse support and scrollback. Installs herdr by default on macOS and Linux unless declined with `--no-herdr`; an unavailable herdr install is a warning. On macOS the installing agent offers Ghostty, and `--ghostty` attempts it after acceptance. Existing cmux settings are left unchanged. `--full` adds workstation tools. `--dry-run` shows setup's plan without applying it. |
| **Daemon startup** | Creates/updates instance state under `OPENRIG_HOME` (normally `~/.openrig`), including its database and managed plugin resources. Seeds the `openrig-skills` discovery skill in `~/.claude/skills` and `~/.agents/skills`, subject to existing version ownership. With `runtime.codex.hooks_enabled` enabled (the default), writes Codex hook configuration and trust records as described below—even before a rig launches. |
| **Rig/seat launch and attachment** | Creates tmux sessions, supplies seat identity and daemon connection environment, and projects selected guidance, skills, plugins and runtime resources into the workspace. Managed startup pre-trusts the workspace. Claude context collection can also be provisioned for attached sessions and refreshed during monitoring. In a Git repository, newly created files under `.codex/plugins/shared:openrig-core/` (or the unqualified `.codex/plugins/openrig-core/`) are added to the repository's Git `info/exclude` inside an `# BEGIN OpenRig generated files` block; new `AGENTS.md`, `CLAUDE.md` and `CLAUDE.local.md` files stay visible with a warning. |
| **Bundle install** (`rig bundle install`, or `rig up` with a `.rigbundle` or GitHub link) | Writes the bundle's files into the install target: `--target`, or the current directory for `rig up` and for a GitHub link. `rig bundle install` with a local archive needs `--target`. Routes its declared skills, plugins and context packs into your libraries. A GitHub link's archive is kept under `OPENRIG_HOME/bundle-imports/`, and installs are recorded in `OPENRIG_HOME/bundle-audit.jsonl`. A bundle that carries a project creates it under `workspace.projects_root` and records it, with the rig's association, in the workspace catalog. |
| **Explicit permission configuration** | The built-in bootstrap does **not** add `rig` command allow rules to your settings files; a team seat with no permission policy, per-seat choice or (for Codex) named profile gets the per-launch [team default](docs/reference/rig-spec.md#team-launch-defaults) instead. Agent-guided setup recommends keeping it and requires your actual answer before the agent [adds remembered rules at your chosen scope](docs/reference/getting-started.md#have-your-agent-configure-permissions). No/no answer keeps the team default and preserves settings; existing choices and stricter rules remain relevant. Broader access is separate. |

The provider files are separate from instance state. Here `~` means the daemon
user's home; changing `OPENRIG_HOME` alone does not isolate provider configuration.

- **Claude Code:** startup writes workspace trust and onboarding completion.
  With an explicit permission mode, it uses the launch-selected `HOME/.claude.json`,
  or `<CLAUDE_CONFIG_DIR>/.claude.json` when that variable is set. Classic startup
  writes `HOME/.claude.json`, and also `<CLAUDE_CONFIG_DIR>/.claude.json` when the
  daemon has that variable set. In the workspace, `.claude/settings.local.json` receives
  the context collector's `statusLine` command and selected activity hooks;
  helper scripts live under `.openrig/`. Selected settings/MCP resources can also
  change that settings file and `.mcp.json`. The shared settings resource sets
  `permissions.defaultMode` to `acceptEdits` and enables Exa/Context7 MCP entries;
  selected MCP resources configure those external services. Built-in bootstrap
  no longer writes a command allowlist to `~/.claude/settings.json` or removes
  older allowances. `CLAUDE_CONFIG_DIR` does not relocate the project-local writes.
- **Codex:** writes the daemon's `CODEX_HOME/config.toml` (normally
  `~/.codex/config.toml`). Startup enables hooks, adds the OpenRig activity relay
  commands and pre-writes trust hashes for those commands. Seat startup adds
  `trust_level = "trusted"` for the workspace; selected config resources can
  add MCP settings. Recognized update notices can be skipped during launch,
  recording the skipped version in Codex's cache; this is not an update install.

Activity relays send event type/subtype, seat/runtime identity, timestamps and
native session identity to the configured OpenRig daemon's `/api/activity/hooks`
endpoint, using its activity token. That payload excludes prompt text and tool
arguments. Claude's collector writes context/token usage, session/transcript-path
metadata and available rate-limit data to the instance's `state/context-usage`
and `state/provider-usage`. Provider and selected MCP connections have their own
data flows. Daemon plugin initialization also checks the OpenRig plugin release
endpoint on GitHub.

Managed launches supply `HOME`, `CODEX_HOME` and `OPENRIG_*` identity/connection
variables. Claude uses `--permission-mode acceptEdits` and defaults to the classic
renderer for terminal scrollback. Codex uses `-s workspace-write` unless a named
profile governs its sandbox; the default does not force an approval-policy flag.
On that plain launch OpenRig first asks Codex for its own configuration and adds
`-c sandbox_workspace_write.network_access=true` only when Codex answers that no
configuration layer sets network access and no managed requirement could restrict
it, so the seat can reach the local daemon. If Codex can't be asked or doesn't
answer in time, the launch is left unchanged.
Fresh Codex launches also add writable access to the workspace's `.git` and the
pod's shared queue-state directory with `--add-dir`; the shared root comes from
`OPENRIG_SHARED_DOCS_ROOT` or `~/.openrig/shared-docs`.
A team seat with no permission policy, per-seat choice or (for Codex) named
profile also gets the per-launch team default: Claude gets `--settings` allowing
ordinary `rig` commands, project reads and common tests, with lifecycle commands
as ask rules, and Codex also gets the OpenRig workspace root as a writable
directory. Neither writes a permission file.
Seats of the rig named `kernel` launch with an operational default instead,
unless a permission policy, a per-seat choice or (for Codex) a named profile
applies: Claude in `acceptEdits` with a per-launch allow list for its file tools
and operational commands (including reads under your home folder), and Codex with
`-s danger-full-access -a never`. Neither writes a permission file.
YOLO is **off by default**. An explicitly selected full-bypass policy selects
Claude's `--dangerously-skip-permissions` or Codex's
`-s danger-full-access -a never`. The legacy environment-only `OPENRIG_YOLO=1`
path, with no policy attached, selects Claude's bypass flag, Pi's `--approve` and
Codex's `-s danger-full-access` without `-a never`; a resolved policy overrides
that environment setting. The `builtin:auto` policy launches Claude with
`--permission-mode auto`; Codex and Pi seats launch as they do without a policy (a
named Codex profile still governs its sandbox, and Pi keeps its configured
resource trust).
`--non-interruptive` on `rig up` or `rig bundle install` additionally passes
per-launch flags to full-bypass seats so Claude's bypass warning and Codex's
full-access and GPT-5.1 migration notices don't stop startup; it writes nothing to
their settings files and is saved on the rig. See
[non-interruptive mode](docs/reference/non-interruptive-mode.md).

Permission mode controls native execution permissions; work posture is separate
project guidance. Use `rig policy permissions list|show|current|apply` for rig
policy configuration (the four `rig policy` aliases remain compatible). Use
`rig seat set-permissions <seat> --mode <mode> --reason <text>` for an audited
future-launch choice: `floor`, `full_bypass`, or `inherit` to clear the seat
override. Additional Claude modes such as `auto` require support from the exact
managed Claude executable at the seat's working directory; selection and launch
each check it. Unsupported or changed contexts refuse without a fallback.
This does not relaunch the seat
or change its current native process, history, rules or hooks. `rig seat status`
separates the desired selection from the last launch arguments; neither proves
native enforcement. See the [permission guide](docs/reference/getting-started.md#per-seat-permission-mode).

Managed hook blocks target OpenRig's entries and retain unrelated hooks, but
trust entries, selected resource keys and Claude's existing status-line command
can be replaced. Some writers recover unreadable settings as empty objects;
this is not a complete preservation or rollback guarantee. Back up relevant
files before first use. Daemon/bootstrap writes are automatic and do not each
have an interactive preview; `rig setup --dry-run` does not preview every later
startup effect.

## What It Does

OpenRig is a multi-agent harness — it manages the system that coding agents form when you run them together. Not the agents themselves, but the team they create: which sessions are running, how they relate, how to recover after a reboot, and how to stop it from becoming terminal sprawl.

- **Define** topologies in YAML (RigSpec) with pods, edges, and continuity policies
- **Boot** everything with `rig up` — tmux sessions, harnesses, startup files, readiness checks
- **See** rigs, pods, and seats in the TUI topology table and graph; inspect projects, specs, feeds, and instance health
- **Discover** existing Claude Code and Codex sessions in tmux and adopt them into a managed rig
- **Snapshot** the topology with `rig down --snapshot`, restore by name with `rig up <name>`
- **Communicate** across agents with `rig send`, `rig broadcast`, and `rig chatroom`
- **Protect** a seat where you type by hand: `rig seat set-typing-guard <seat> --enabled true --reason <text>` holds automatic messages and wakes instead of typing them into that seat (off by default; see `rig seat set-typing-guard --help`)
- **Connect** Slack through an app you create in your own workspace; the experimental `rig slack manifest` prints that app's manifest ([setup guide](docs/reference/slack-app-setup.md))
- **Evolve** running topologies with `rig grow`, `rig shrink`, `rig launch`, `rig remove`

Every agent runs in a tmux session you can attach to, inspect, and work with directly.

## Teams

Three teams grow with you, and the kernel operator helps you pick one:

- **`starter`**: a builder and a reviewer for one bounded change.
- **`workshop`**: a lead, a builder, QA and a reviewer for ongoing work in one repository. It's a rig bundle, installed from its pinned listing.
- **`factory`**: seven agents (a lead, an advisor, build, QA, design and two independent reviewers) for sustained product work. You bring ideas to the advisor, and the lead runs the team.

```bash
rig specs preview factory --kind rig
rig up factory
```

Specialist teams: `code-review` (two independent reviews), `research` (an analyst and a synthesizer) and `pm` (a product lead, a researcher and a builder for prototypes).

Also built in: `secrets-manager`, a HashiCorp Vault instance run by a specialist agent.

Browse the library:

```bash
rig specs ls
```

## How It Works

OpenRig is a local daemon + CLI + terminal UI + MCP server, built on tmux. The older React web UI remains in maintenance mode with best-effort support.

```
CLI / TUI / MCP
      |
Hono HTTP daemon
      |
  Domain services
      |
  SQLite + tmux + runtime adapters
```

- **CLI**: Commands for both humans and agents to launch teams, inspect state, send messages, track owned work, and manage context.
- **TUI**: Topology explorer, table and graph views, seat details, Specs, Projects, Terminals, Feed, and System. Navigate with the keyboard, mouse, or command bar.
- **MCP**: Tools so agents can manage their own topology (`rig_up`, `rig_ps`, `rig_send`, `rig_chatroom_send`, etc.)
- **Runtimes**: Native Claude Code and Codex sessions, terminal nodes, and Pi and Oh My Pi via RPC runners.

## Terminal UI and Workspaces

The TUI shows the team's coordination state; herdr and cmux show the actual agent terminals alongside it. Use `rig tui commands` to list the TUI's command-bar navigation, or [try the interactive TUI tour](https://openrig.dev/tour/workspace).

![OpenRig TUI topology graph showing seven agent seats grouped into product, development, and QA pods](assets/ui/screenshots/tui-topology.png)

*Captured from the interactive TUI demo using fictional project data.*

With herdr installed and connected, open the starter's terminals together:

```bash
rig terminal open starter --provider herdr
```

For cmux, use `--provider cmux`. In the TUI, a rig's detail view has a `term ▸ rig <name>` link that opens every running seat of that rig in the default terminal provider; with herdr that is up to 16 seats per tab, in a workspace named after the rig. The underlying sessions remain accessible through tmux. See the [terminal workspace guide](docs/reference/getting-started.md#share-the-dashboard-and-return-to-it) for setup and returning to an existing view.

## Key Concepts

- **RigSpec**: Declarative multi-agent harness definition in YAML. Pods, members, edges, continuity policies, culture file.
- **AgentSpec**: Reusable agent blueprint with skills, guidance, hooks, profiles, and startup contracts.
- **Seat**: A stable role and address in a rig, such as `dev-build@starter`. The conversation occupying it can change while its identity and authored context remain.
- **Pod**: A group of related seats with shared guidance and context. Each agent still has its own context window.
- **Discovery**: `rig discover` fingerprints existing tmux sessions. `rig adopt` brings them under management.
- **Snapshot/Restore**: `rig down --snapshot` captures full state. `rig up <name>` restores from latest snapshot. Restore reports per-node outcomes: resumed, fresh-primed, awaiting-decision (the original conversation can't resume; choose `--fresh`), attention_required, or failed.
- **RigBundle**: Portable archive with vendored AgentSpecs and SHA-256 integrity. Share topologies across machines. `rig up`, `rig bundle create`, `inspect` and `install` also take a GitHub folder link, `rig bundle check` checks a folder before you share it, and `rig bundle inspect` shows what a bundle will do before you install it. See [publishing a rig bundle](docs/reference/publishing-a-rig-bundle.md).
- **Culture**: A rig's `CULTURE.md` (its `culture_file`) sets coordination norms for the group, on top of OpenRig's default culture, which every seat receives.

## Agent-Managed Software

A rig can package actual software alongside the agents that manage it. The shipped example is `secrets-manager`: a HashiCorp Vault instance operated by a specialist agent.

```bash
rig up secrets-manager
rig env status secrets-manager
rig send vault-specialist@secrets-manager "Check Vault health and report status." --verify
```

Requires Docker for service-backed rigs.

## Upgrading an existing instance

For an existing installation, follow the [upgrade procedure](skills/_canonical/core/openrig-upgrade/SKILL.md) and the [0.5.14 release notes](docs/releases/v0.5.14.md); notes for later releases are in [CHANGELOG.md](CHANGELOG.md). Preserve live seats during the upgrade; `rig down` is not an upgrade step. Upgrading to 0.6.0 also requires Node.js 22 or 24: see [Moving off Node 20](#moving-off-node-20) and the [0.6.0 release notes](docs/releases/v0.6.0.md).

### Moving off Node 20

OpenRig 0.6.0 supports Node.js 22 and 24 only. Its SQLite binding
(better-sqlite3 13) requires Node 22 or newer. Node 20 is no longer supported;
the install check refuses it with an explanation.

If you run OpenRig on Node 20, switch Node first, then reinstall the CLI under
the new Node (a version manager keeps a separate global package set for each
Node):

```bash
nvm install 22          # or 24; fnm or your package manager work the same way
npm install -g @openrig/cli
rig --version
```

Your existing OpenRig data stays where it is. The daemon reopens the same
database under the new binding and applies any pending migrations in place.
Restart the daemon under the new Node by following the upgrade procedure above.

### Crossing the 0.5.9 layout boundary

The migration below still applies when upgrading from a pre-0.5.9 instance.

0.5.9 makes `$OPENRIG_HOME/context` the addressable context library, writes
Claude telemetry to `state/context-usage` (and provider telemetry to
`state/provider-usage`), and installs the default System World at
`context/system/system-world.yaml`. Existing instances cross this boundary by
an **Agent-Operated Migration** from the shipped `openrig-upgrade` skill. The
target runtime reads canonical-first with legacy-fallback while new writes use
the canonical roots; a custom context-library root stays stable during
activation. This is not a directory rename to do while an old collector writes.

```bash
# SKILL_DIR is the installed openrig-upgrade skill directory.
node "$SKILL_DIR/scripts/migrate-telemetry-state-0.5.9.mjs" --help
node "$SKILL_DIR/scripts/migrate-telemetry-state-0.5.9.mjs" --home "$OPENRIG_HOME"
node "$SKILL_DIR/scripts/migrate-telemetry-state-0.5.9.mjs" --home "$OPENRIG_HOME" --apply-state --preimage /safe/path/layout-0.5.9-before

# Activate the exact target runtime separately. After every bounded legacy tail is followed by newer paired samples at both new state roots:
node "$SKILL_DIR/scripts/migrate-telemetry-state-0.5.9.mjs" --home "$OPENRIG_HOME" --verify --preimage /safe/path/layout-0.5.9-before > /safe/path/layout-0.5.9-verify.json

# Run the separately invoked non-destructive finalizer only with that exact receipt:
node "$SKILL_DIR/scripts/migrate-telemetry-state-0.5.9.mjs" --home "$OPENRIG_HOME" --apply-library --preimage /safe/path/layout-0.5.9-before --verification /safe/path/layout-0.5.9-verify.json

# Restore only helper-owned preparation/finalizer effects if the observed upgrade must be reversed:
node "$SKILL_DIR/scripts/migrate-telemetry-state-0.5.9.mjs" --home "$OPENRIG_HOME" --rollback /safe/path/layout-0.5.9-before
```

`--help` prints the phase grammar without inventorying the instance. No phase
flag intentionally runs the read-only plan; unknown options fail nonzero before
plan or mutation.

Every phase emits JSON. Stop on any issue or incomplete receipt and follow its
`next` action; do not continue from copied legacy telemetry or retry a partial
mutation blindly. Preparation leaves legacy state and collector settings in
place. Verification accepts exact tail bytes only when that same seat has newer
paired context and provider samples under `state/`; finalization revalidates the
accepted tails, copies the library without overwrite, and switches config last.
The helper never removes the legacy telemetry or library. Retirement follows
separate stable runtime, writer, reader, and recovery proof. Daemon, database,
seat, plugin, and release lifecycle actions remain agent-owned.


## Requirements

- Node.js 22 or 24 (the supported versions in this release). Node 20 is no
  longer supported. Node 26 and other versions are untested. On a Mac with Apple
  silicon, use Node.js 22: see the [compatibility history](docs/releases/v0.5.15.md#known-compatibility-limitation).
- tmux
- macOS or Linux. On Windows, use WSL2, the Windows route OpenRig supports; native
  Windows isn't supported. OpenRig's automated tests don't run on WSL2 yet; one user's
  working setup is in the [getting-started guide](docs/reference/getting-started.md#wsl2-a-reported-working-setup)

Optional:
- herdr or cmux for terminal workspaces showing the agents together
- Docker for service-backed rigs and managed apps

## Setup and Troubleshooting

- `rig setup` attempts core machine preparation: it installs a missing Claude Code or Codex and writes tmux defaults. It installs Herdr by default on macOS and Linux; use `--no-herdr` if you decline it. On macOS it also installs a missing tmux with an existing Homebrew; elsewhere install tmux yourself (setup only checks it). On a Mac, the installing agent offers Ghostty once; accepting uses `rig setup --ghostty`, and declining leaves Terminal.app available. Existing cmux settings are preserved. It reports what it tried and what actually succeeded. If something fails, it gives the local agent enough context to finish the job.
- `rig setup --full` attempts a broader operator workstation setup (jq, gh, via Homebrew, so macOS only) on top of core.
- `rig doctor` inspects current system health and helps diagnose problems after setup. Use it when something stops working or after machine changes. It shares setup's local provider login checks. These do not prove provider acceptance or a working agent; also inspect `rig ps --nodes --rig <rig>`.

Both commands support `--json` for agent-driven workflows.

Before setup or managed launch, review [what OpenRig changes on your machine](#what-openrig-changes-on-your-machine), including provider trust, hooks and selected runtime resources.

Already-running adopted sessions may need restart before they pick up newly written runtime config.

**For agents:** First ask which available provider(s) the user wants, reusing an explicit choice. Recommend the working account they already have and follow the selected-provider guide above. Offer core setup (`rig setup`) or the fuller workstation path (`rig setup --full`) only when they want those additional tools. Inspect the result with `--json` and use `rig doctor` to finish any remaining machine-specific issues. Then start the daemon if it is stopped, ask “Open the OpenRig switchboard now?”, run `rig terminal open saved:kernel --window --json` on yes (no commands for the person to copy), and hand the person's goal and project folder to the kernel operator ([installing-agent handoff](docs/reference/getting-started.md#installing-agent-handoff)). Installation is finished when the person is talking to the operator; don't implement the project yourself. When OpenRig itself misbehaves, read [docs/reference/help.md](docs/reference/help.md) (installed agents can run `rig context get help`; the same text is at [openrig.dev/help/agents](https://www.openrig.dev/help/agents)): it covers the next step, known problems, and how to reach the team if you're still stuck.

## Comparison with Claude Managed Agents

OpenRig is open source and self-hosted, with Claude Code and Codex in the same team. You operate it on your own infrastructure; the selected providers' model usage costs still apply.

[Full comparison](https://openrig.dev/compare/claude-managed-agents)

## Links

- **Website**: [openrig.dev](https://openrig.dev)
- **Docs**: [openrig.dev/docs](https://openrig.dev/docs) ([documentation index for agents](https://openrig.dev/llms.txt))
- **Blog**: [openrig.dev/blog](https://openrig.dev/blog) · [Why I Built OpenRig](https://esoteric.run/blog/why-i-built-openrig)
- **Open Specification**: [openrig.dev/specs](https://openrig.dev/specs)
- **Videos**: [youtube.com/@openrig](https://www.youtube.com/@openrig)
- **X**: [@_feralmachine](https://twitter.com/_feralmachine)
- **Follow the project**: [openrig.dev/follow](https://openrig.dev/follow)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=mvschwarz/openrig&type=Date)](https://star-history.com/#mvschwarz/openrig&Date)

## License

Apache 2.0
