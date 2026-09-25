# OpenRig

A harness wraps a model. A rig wraps your harnesses. Define your agent team in YAML, boot it with one command. Claude Code and Codex in the same rig, managed as one system.

OpenRig turns AI coding agents from a pile of terminal sessions into a persistent, organized team. Talk to a lead agent about the outcome you want; it can coordinate specialists across teams and bring you results and decisions that need your attention. Start with a repository and one useful change, then keep the team's work and context at the same addresses.

The terminal UI is the shared dashboard; the CLI drives work and coordination. The older web UI is in maintenance mode with best-effort support.

```bash
npm install -g @openrig/cli
rig setup --dry-run
cd /path/to/your/repository
rig up first-project --cwd .
rig tui --shared
```

`first-project` has two native Codex seats: an owner and a checker. The kernel
provides separate operational support and a shared TUI terminal. Check
`codex login status` and inspect `rig up first-project --cwd . --plan` before
launching. [The guided first-use path](docs/reference/getting-started.md) covers
readiness, a useful task, a reviewed result, Herdr/cmux terminals and recovery.
Review setup's plan before applying `rig setup`: it checks both native
harnesses and cmux. This starter requires tmux and authenticated Codex; the
other harness and terminal provider are optional for its repository task.

## First Run

Check readiness, then give the owner a bounded outcome from your repository:

```bash
rig ps --nodes --rig first-project
rig send dev-owner@first-project 'Implement <one useful change>. Track the task in the queue and return its ID. Keep it local, verify the behavior, ask dev-check@first-project to check the exact candidate, and record the result and how I can try it.'
rig queue list --destination dev-owner@first-project --limit 1000
```

Sending a message does not itself create a queue item; the owner records the task.
Read the final artifact and the review of its exact candidate. Return to the
same owner for the next change. To leave the shared dashboard without stopping
it, press Ctrl-b then d; `rig tui --shared` returns to that view. Plain `rig tui`
opens an independent view. Closing a viewing terminal does not mean you should
relaunch the team.

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

## What It Does

OpenRig is a multi-agent harness — it manages the system that coding agents form when you run them together. Not the agents themselves, but the team they create: which sessions are running, how they relate, how to recover after a reboot, and how to stop it from becoming terminal sprawl.

- **Define** topologies in YAML (RigSpec) with pods, edges, and continuity policies
- **Boot** everything with `rig up` — tmux sessions, harnesses, startup files, readiness checks
- **See** rigs, pods, and seats in the TUI topology table and graph; inspect projects, specs, feeds, and instance health
- **Discover** existing Claude Code and Codex sessions in tmux and adopt them into a managed rig
- **Snapshot** the topology with `rig down --snapshot`, restore by name with `rig up <name>`
- **Communicate** across agents with `rig send`, `rig broadcast`, and `rig chatroom`
- **Evolve** running topologies with `rig expand`, `rig shrink`, `rig launch`, `rig remove`

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

OpenRig is a local daemon + CLI + terminal UI + MCP server, built on tmux. The older React web UI remains in maintenance mode.

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

Managed runtime boot (during `rig up`) may modify runtime config for core bootstrap and spec-selected runtime resources. `rig setup` discloses these paths so agents know what may be changed:
- global Claude: `~/.claude/settings.json` for minimal OpenRig command allowlisting
- global Claude state: `~/.claude.json` for managed workspace trust and onboarding completion
- project Claude: `.claude/settings.local.json` for context collector/activity hooks and selected `claude_settings_fragment` resources
- project Claude MCP: `.mcp.json` for selected `claude_mcp_fragment` resources
- global Codex: `~/.codex/config.toml` for workspace trust and selected `codex_config_fragment` resources

Already-running adopted sessions may need restart before they pick up newly written runtime config.

**For agents:** Ask the user whether they want core setup (`rig setup`) or the fuller workstation path (`rig setup --full`) before choosing the invocation. Inspect the result with `--json` and use `rig doctor` to finish any remaining machine-specific issues.

## Comparison with Claude Managed Agents

OpenRig is open source and self-hosted, with Claude Code and Codex in the same team. You operate it on your own infrastructure; the selected providers' model usage costs still apply.

[Full comparison](https://openrig.dev/compare/claude-managed-agents)

## Links

- **Website**: [openrig.dev](https://openrig.dev)
- **Blog**: [Why I Built OpenRig](https://esoteric.run/blog/why-i-built-openrig)
- **Docs**: [openrig.dev/docs](https://openrig.dev/docs)
- **Open Specification**: [openrig.dev/specs](https://openrig.dev/specs)
- **Twitter**: [@_feralmachine](https://twitter.com/_feralmachine)

## License

Apache 2.0
