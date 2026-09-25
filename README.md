# OpenRig

A harness wraps a model. A rig wraps your harnesses. Define your agent team in YAML, boot it with one command. Claude Code and Codex in the same rig, managed as one system.

OpenRig turns AI coding agents from a pile of terminal sessions into a persistent, organized team. Talk to a lead agent about the outcome you want; it can coordinate specialists across teams and bring you results and decisions that need your attention. Start with a repository and one useful change, then keep the team's work and context at the same addresses.

## Install and first run

Requires Node.js 20, 22 or 24 and tmux. Launching a rig writes provider hooks and workspace trust settings. Before running the commands below, read [what OpenRig changes on your machine](#what-openrig-changes-on-your-machine) and back up the relevant files.

```bash
npm install -g @openrig/cli
rig setup --dry-run
```

Review setup's plan before applying `rig setup`: it checks both native harnesses and cmux. This starter requires tmux and authenticated Codex; the other harness and terminal provider are optional for its repository task.

Before launching, ask your agent to [configure your chosen permissions](docs/reference/getting-started.md#have-your-agent-configure-permissions): keep prompts, remember selected commands, or deliberately choose broader access. The agent handles setup and verification; OpenRig's shipped defaults stay unchanged.

Check prerequisites in your launch shell:

```bash
tmux -V
codex --version
codex login status
```

Resolve missing tools or login before continuing. From your repository, inspect the plan before launching the two Codex seats, an owner and a checker:

```bash
cd /path/to/your/repository
rig up first-project --cwd . --plan
rig up first-project --cwd .
rig tui --shared
```

The kernel provides separate operational support and the shared dashboard. To detach without stopping the dashboard, press Ctrl-b then d; `rig tui --shared` returns to that view. Plain `rig tui` opens an independent view. Closing a viewing terminal does not mean you should relaunch the team.

Check project-seat readiness with `rig ps --nodes --rig first-project` and resolve any authentication, trust or permission prompt before assigning work. Then give the owner one bounded outcome from your repository:

```bash
rig send dev-owner@first-project 'Implement <one useful change>. Track the task in the queue and return its ID. Keep it local, verify the behavior, ask dev-check@first-project to check the exact candidate, and record the result and how I can try it.'
rig queue list --destination dev-owner@first-project --limit 1000
```

Sending a message does not itself create a queue item; the owner records the task. Read the final artifact and the review of its exact candidate, then return to the same owner for the next change. [The guided first-use path](docs/reference/getting-started.md) covers readiness, a useful task, a reviewed result, Herdr/cmux terminals and recovery.

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
| **npm installation** | Installs the CLI, bundled components and dependencies under your npm prefix. OpenRig's postinstall checks Node/SQLite compatibility; it does not run daemon or provider setup. |
| **`rig setup`** | Attempts missing tools and writes an OpenRig block in `~/.tmux.conf` for mouse support and scrollback. On macOS it can install cmux and enable its automation socket control in `~/.config/cmux/settings.json`. `--full` adds workstation tools. `--dry-run` shows setup's plan without applying it. |
| **Daemon startup** | Creates/updates instance state under `OPENRIG_HOME` (normally `~/.openrig`), including its database and managed plugin resources. Seeds the `openrig-skills` discovery skill in `~/.claude/skills` and `~/.agents/skills`, subject to existing version ownership. With `runtime.codex.hooks_enabled` enabled (the default), writes Codex hook configuration and trust records as described below—even before a rig launches. |
| **Rig/seat launch and attachment** | Creates tmux sessions, supplies seat identity and daemon connection environment, and projects selected guidance, skills, plugins and runtime resources into the workspace. Managed startup pre-trusts the workspace. Claude context collection can also be provisioned for attached sessions and refreshed during monitoring. |
| **Explicit permission configuration** | The built-in bootstrap does **not** add `rig` command allow rules. Ask your agent to [apply your chosen project or user scope](docs/reference/getting-started.md#have-your-agent-configure-permissions); existing rules remain relevant. Broader access is a separate choice. |

The provider files are separate from instance state. Here `~` means the daemon
user's home; changing `OPENRIG_HOME` alone does not isolate provider configuration.

- **Claude Code:** managed startup writes workspace trust and onboarding completion
  to `~/.claude.json`. In the workspace, `.claude/settings.local.json` receives
  the context collector's `statusLine` command and selected activity hooks;
  helper scripts live under `.openrig/`. Selected settings/MCP resources can also
  change that settings file and `.mcp.json`. The shared settings resource sets
  `permissions.defaultMode` to `acceptEdits` and enables Exa/Context7 MCP entries;
  selected MCP resources configure those external services. Built-in bootstrap
  no longer writes a command allowlist to `~/.claude/settings.json` or removes
  older allowances. The trust writer uses the daemon home, so a custom
  `CLAUDE_CONFIG_DIR` is not a general relocation of these writes.
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
profile governs its sandbox; OpenRig does not force an approval-policy flag.
Fresh Codex launches also add writable access to the workspace's `.git` and the
pod's shared queue-state directory with `--add-dir`; the shared root comes from
`OPENRIG_SHARED_DOCS_ROOT` or `~/.openrig/shared-docs`.
YOLO is **off by default**. Explicit `OPENRIG_YOLO=1` or a full-bypass seat policy
selects Claude's `--dangerously-skip-permissions` or Codex's
`-s danger-full-access`; a resolved seat policy takes precedence over the
environment setting.

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
- **Evolve** running topologies with `rig grow`, `rig shrink`, `rig launch`, `rig remove`

Every agent runs in a tmux session you can attach to, inspect, and work with directly.

## Starter Rigs

Use `first-project` for the focused first-use path. `product-team` is an optional
larger product-development example:

```bash
rig specs preview product-team --kind rig
rig up product-team
```

Use it when you want a larger product squad: two orchestrators, implementation, QA, design, and two independent reviewers.

For a smaller starter, use `conveyor`:

```bash
rig specs preview conveyor --kind rig
rig up conveyor
```

`conveyor` is a four-seat starter mixing Claude Code and Codex. It shows a handoff path through intake, planning, build, and review; `first-project` remains the smaller two-seat starting point.

Also ships: `implementation-pair`, `adversarial-review`, `research-team`, and `secrets-manager` (HashiCorp Vault managed by a specialist agent).

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
- **Runtimes**: Native Claude Code and Codex sessions, terminal nodes, and a Pi adapter using an RPC runner inside a terminal pane.

## Terminal UI and Workspaces

The TUI shows the team's coordination state; herdr and cmux show the actual agent terminals alongside it. Use `rig tui commands` to list the TUI's command-bar navigation, or [try the interactive TUI tour](https://openrig.dev/tour/workspace).

![OpenRig TUI topology graph showing seven agent seats grouped into product, development, and QA pods](assets/ui/screenshots/tui-topology.png)

*Captured from the interactive TUI demo using fictional project data.*

With herdr installed and connected, open the starter's terminals together:

```bash
rig terminal open first-project --provider herdr
```

For cmux, use `--provider cmux`. The underlying sessions remain accessible through tmux. See the [terminal workspace guide](docs/reference/getting-started.md#share-the-dashboard-and-return-to-it) for setup and returning to an existing view.

## Key Concepts

- **RigSpec**: Declarative multi-agent harness definition in YAML. Pods, members, edges, continuity policies, culture file.
- **AgentSpec**: Reusable agent blueprint with skills, guidance, hooks, profiles, and startup contracts.
- **Seat**: A stable role and address in a rig, such as `dev-owner@first-project`. The conversation occupying it can change while its identity and authored context remain.
- **Pod**: A group of related seats with shared guidance and context. Each agent still has its own context window.
- **Discovery**: `rig discover` fingerprints existing tmux sessions. `rig adopt` brings them under management.
- **Snapshot/Restore**: `rig down --snapshot` captures full state. `rig up <name>` restores from latest snapshot. Restore reports per-node outcomes (resumed, fresh, or failed).
- **RigBundle**: Portable archive with vendored AgentSpecs and SHA-256 integrity. Share topologies across machines.
- **Culture**: CULTURE.md sets coordination norms for the group. Research rigs get exploratory culture. Implementation rigs get conservative, trust-but-verify culture.

## Agent-Managed Software

A rig can package actual software alongside the agents that manage it. The shipped example is `secrets-manager`: a HashiCorp Vault instance operated by a specialist agent.

```bash
rig up secrets-manager
rig env status secrets-manager
rig send vault-specialist@secrets-manager "Check Vault health and report status." --verify
```

Requires Docker for service-backed rigs.

## Upgrading an existing instance

For an existing installation, follow the [upgrade procedure](skills/_canonical/core/openrig-upgrade/SKILL.md) and the [0.5.14 release notes](docs/releases/v0.5.14.md). Preserve live seats during the upgrade; `rig down` is not an upgrade step.

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

- Node.js 20, 22, or 24 (the supported versions in this release)
- tmux

Optional:
- herdr or cmux for terminal workspaces showing the agents together
- Docker for service-backed rigs and managed apps

## Setup and Troubleshooting

- `rig setup` attempts core machine preparation: tmux, cmux, Claude Code, Codex, and tmux defaults. It reports what it tried and what actually succeeded. If something fails, it gives the local agent enough context to finish the job.
- `rig setup --full` attempts a broader operator workstation setup (jq, gh) on top of core.
- `rig doctor` inspects current system health and helps diagnose problems after setup. Use it when something stops working or after machine changes.

Both commands support `--json` for agent-driven workflows.

Before setup or managed launch, review [what OpenRig changes on your machine](#what-openrig-changes-on-your-machine), including provider trust, hooks and selected runtime resources.

Already-running adopted sessions may need restart before they pick up newly written runtime config.

**For agents:** Ask the user whether they want core setup (`rig setup`) or the fuller workstation path (`rig setup --full`) before choosing the invocation. Inspect the result with `--json` and use `rig doctor` to finish any remaining machine-specific issues.

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

## License

Apache 2.0
