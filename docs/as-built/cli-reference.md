# OpenRig CLI Reference

Verified against the shipped CLI on 2026-04-09 using:
- `packages/cli/src/index.ts`
- `packages/cli/src/commands/*.ts`
- `packages/cli/src/mcp-server.ts`
- live help from `node packages/cli/dist/index.js ... --help`

This document reflects the current `rig` surface as shipped. Where live help text is narrower than the implementation, notes call that out explicitly.

## Overview

- Binary: `rig`
- Top-level command groups: `41`
- Output mode: human-readable by default; many commands also support `--json`
- Daemon-backed commands fail when the daemon is stopped or unhealthy; `daemon`, `config`, `preflight`, and `doctor` also have local responsibilities
- Managed apps are launched through the normal spec/library surfaces; the canonical shipped example is `rig up secrets-manager`
- Legacy surface still shipped: `package`

## Top-Level Commands

| Command | Description |
| --- | --- |
| `daemon` | Manage the OpenRig daemon |
| `status` | Show rig status |
| `snapshot` | Manage rig snapshots |
| `restore` | Restore a rig from a snapshot |
| `export` | Export a rig spec as YAML |
| `import` | Import a rig spec from YAML |
| `ui` | UI commands |
| `package` | Manage agent packages (legacy) |
| `bootstrap` | Bootstrap a rig from a spec file |
| `requirements` | Check requirements for a rig spec |
| `discover` | Scan for unmanaged tmux sessions |
| `attach` | Attach the current shell or agent into a rig node |
| `bind` | Bind a discovered session to a rig node |
| `adopt` | Materialize topology and bind discovered live sessions |
| `bundle` | Manage rig bundles |
| `up` | Bootstrap a rig from a spec or bundle |
| `down` | Tear down a rig |
| `env` | Inspect and control rig environment services |
| `ps` | List rigs and their status |
| `mcp` | MCP server for agent integration |
| `agent` | Manage agent specs |
| `spec` | Manage rig specs |
| `transcript` | Read agent transcript output |
| `send` | Send a message to an agent's terminal |
| `capture` | Capture terminal output from agent sessions |
| `broadcast` | Send a message to multiple agent sessions |
| `ask` | Query rig evidence from transcript/chat history |
| `chatroom` | Chat room for rig communication |
| `specs` | Browse, preview, and manage the spec library |
| `whoami` | Show current managed identity in an OpenRig topology |
| `config` | Inspect and change OpenRig configuration |
| `preflight` | Check system readiness for OpenRig |
| `doctor` | Verify OpenRig install health |
| `destroy` | Destroy OpenRig local state for recovery |
| `expand` | Add a pod to a running rig |
| `unclaim` | Release an adopted session without killing tmux |
| `release` | Release claimed sessions from a rig |
| `launch` | Launch or relaunch a node in a running rig |
| `remove` | Remove a node from a running rig |
| `shrink` | Remove an entire pod from a running rig |
| `setup` | Prepare the machine for OpenRig |

## Core Daemon and System Commands

### `rig daemon`

Usage: `rig daemon <subcommand>`

Subcommands:
- `start [--port <port>] [--host <host>] [--db <path>]`
- `stop`
- `status`
- `logs [--follow]`

Notes:
- `start` launches the daemon process and accepts runtime overrides for port, host, and DB path.
- `logs` reads daemon log output and can follow it.

### `rig status`

Usage: `rig status`

Notes:
- Human-oriented summary command.
- Prints daemon state, rig summary, and cmux availability.
- Does not support `--json`.

### `rig ui`

Usage: `rig ui open`

Subcommands:
- `open`

### `rig config`

Usage:
- `rig config [--json]`
- `rig config get <key>`
- `rig config set <key> <value>`
- `rig config reset`

Supported keys:
- `daemon.port`
- `daemon.host`
- `db.path`
- `transcripts.enabled`
- `transcripts.path`

Precedence:
- CLI flag
- environment variable
- config file
- default

### `rig preflight`

Usage: `rig preflight [--json]`

Notes:
- Runs system readiness checks from local configuration.
- On failure, prints what failed, why it matters, and how to fix it.

### `rig doctor`

Usage: `rig doctor [--json]`

Notes:
- Verifies install health for packaged/local CLI usage.
- Checks daemon dist, UI dist, Node version, `tmux`, optional `cmux` control health, writable state paths, and daemon port availability.
- On macOS, also warns when tmux mouse mode appears disabled, gives the current-server fix (`tmux set -g mouse on`), and points to the persistent fix in `~/.tmux.conf`.
- `cmux` issues are warnings, not hard failures. OpenRig still works without `cmux`; only `Open CMUX` workflows are unavailable.
- `--json` is suitable for agent use and only exits non-zero on real failures, not warnings.

### `rig destroy`

Usage:
- `rig destroy --state [--backup] --yes --confirm destroy-openrig-state`
- `rig destroy --all [--backup] --yes --confirm destroy-openrig-state`

Notes:
- This is the destructive recovery surface for polluted local OpenRig state.
- `--state` stops the daemon, clears the active OpenRig listener on the configured port if needed, rotates or deletes the effective state root, and recreates an empty state root.
- `--all` includes `--state` plus managed tmux session cleanup for sessions that are discoverable from the current OpenRig database.
- `--backup` moves the state root aside to a collision-safe timestamped path such as `~/.openrig.backup-YYYYMMDD-HHMMSS`.
- Managed tmux cleanup is intentionally conservative. It only removes sessions that are present in current DB state; unrelated tmux sessions are left alone.
- Human output prints a compact destroy plan followed by the destroy result.

### `rig mcp`

Usage: `rig mcp serve [--port <port>]`

Subcommands:
- `serve`

Shipped MCP tools:
- `rig_up`
- `rig_down`
- `rig_ps`
- `rig_status`
- `rig_snapshot_create`
- `rig_snapshot_list`
- `rig_restore`
- `rig_discover`
- `rig_bind`
- `rig_bundle_inspect`
- `rig_agent_validate`
- `rig_rig_validate`
- `rig_rig_nodes`
- `rig_send`
- `rig_capture`
- `rig_chatroom_send`
- `rig_chatroom_watch`

## Rig Lifecycle and Specs

### `rig bootstrap`

Usage: `rig bootstrap <spec> [--plan] [--yes] [--json]`

Arguments:
- `spec`: path to a rig spec YAML file or a library name

Notes:
- Bare names resolve through the spec library before falling back to the raw source value.

### `rig requirements`

Usage: `rig requirements <spec> [--json]`

Arguments:
- `spec`: path to a rig spec YAML file

Notes:
- `rig requirements` is the spec/app-specific dependency surface.
- Use `rig doctor` for host-level install health, then `rig requirements <spec>` for rig-specific requirements.

### `rig up`

Usage: `rig up <source> [--plan] [--yes] [--target <root>] [--json]`

Arguments:
- `source`: path to `.yaml` or `.rigbundle`, or a bare name

Actual source resolution:
- Absolute/relative YAML path: boot from that spec
- `.rigbundle` path: install/bootstrap from that bundle
- Bare name without slash/extension:
  - first checks the spec library
  - if no library match, treats it as an existing rig restore/power-on target
  - if both a library spec and existing rig share the same name, exits with an ambiguity error

Current behavior notes:
- `--target <root>` is only for bundle/package installation. It does not override agent working directories.
- `local:` `agent_ref` values resolve relative to the rig spec directory, not the caller shell cwd.
- If you copy a built-in spec to a new directory, keep its `agents/` tree beside it or rewrite those refs to `path:/absolute/path`.
- Managed apps are first-class `up` targets. `rig up secrets-manager` launches the shipped Vault example from the library.

Success modes:
- fresh boot
- restored existing rig
- partial boot (non-zero exit)

### `rig down`

Usage: `rig down <rigId> [--delete] [--force] [--snapshot] [--json]`

Flags:
- `--delete`: delete the rig record after teardown
- `--force`: kill sessions immediately
- `--snapshot`: take a snapshot before teardown

Notes:
- When `--snapshot` succeeds, human output includes the restore command.
- If the rig name is uniquely reusable, the handoff prefers `rig up <rigName>`.

### `rig env`

Usage:
- `rig env status <rig> [--json]`
- `rig env logs <rig> [service] [--tail <n>]`
- `rig env down <rig> [--volumes]`

Notes:
- This surface is only meaningful for service-backed rigs and managed apps.
- `status` resolves rig names or IDs and returns the env receipt with an honest freshness probe. The response includes `probeStatus` (fresh/stale/no_orchestrator) so operators can distinguish current truth from cached state.
- `logs` proxies compose-backed service logs; `[service]` is optional.
- `down` tears down the rig environment. `--volumes` overrides the stored down policy to force volume removal via `docker compose down --volumes`.
- Note: `rig ps` does not yet surface env health. Runtime env truth is available through `rig env status` and the rig drawer `Env` tab.

### `rig ps`

Usage:
- `rig ps [--json]`
- `rig ps --nodes [--json]`

Notes:
- `rig ps` lists rig summaries.
- `rig ps --nodes` expands into a cross-rig node inventory including session name, runtime, startup status, restore outcome, attach command, resume command, and latest error.
- Exit codes are defined in help:
  - `0` success
  - `1` daemon not running
  - `2` daemon fetch failure

### `rig snapshot`

Usage:
- `rig snapshot <rigId>`
- `rig snapshot list <rigId>`

Subcommands:
- `list <rigId>`

### `rig restore`

Usage: `rig restore <snapshotId> --rig <rigId>`

Important:
- `--rig <rigId>` is required by the source code, even though the help text does not visually mark it as required.

Notes:
- Human output prints each restored node and any failed node error.
- Non-zero exit if any restored node fails.

### `rig export`

Usage: `rig export <rigId> [-o|--output <path>]`

Default output path:
- `rig.yaml`

### `rig import`

Usage:
- `rig import <path> [--instantiate] [--materialize-only] [--preflight] [--target-rig <rigId>] [--rig-root <root>]`

Notes:
- Accepts YAML rig specs.
- `--target-rig` is additive materialization into an existing rig.
- `--rig-root` is used for pod-aware resolution.

### `rig bundle`

Usage: `rig bundle <subcommand>`

Subcommands:
- `create <spec> -o <path> [--name <name>] [--bundle-version <ver>] [--include-packages <refs...>] [--rig-root <root>] [--json]`
- `inspect <path> [--json]`
- `install <path> [--plan] [--yes] [--target <root>] [--json]`

Important:
- `bundle create` requires `-o, --output <path>` by source definition.

### `rig package` (legacy)

Usage: `rig package <subcommand>`

Subcommands:
- `validate <path>`
- `plan <path> [--target <dir>] [--runtime <runtime>] [--role <name>]`
- `install <path> [--target <dir>] [--runtime <runtime>] [--role <name>] [--allow-merge]`
- `rollback <installId>`
- `list`

Notes:
- The package surface is explicitly marked legacy in the shipped CLI.

### `rig spec`

Usage: `rig spec <subcommand>`

Subcommands:
- `validate <path> [--json]`
- `preflight <path> [--rig-root <root>] [--json]`

### `rig agent`

Usage: `rig agent validate <path> [--json]`

Subcommands:
- `validate <path>`

### `rig specs`

Usage: `rig specs <subcommand>`

Subcommands:
- `ls [--kind <kind>] [--json]`
- `show <name-or-id> [--json]`
- `preview <name-or-id> [--json]`
- `add <path> [--json]`
- `sync [--json]`
- `remove <name-or-id> [--json]`
- `rename <name-or-id> <new-name> [--json]`

Notes:
- `specs` is the library surface for rigs, agents, and managed apps.
- `preview` returns structured review data from the daemon.
- `add` validates the file as either RigSpec or AgentSpec before copying it into the user library.
- `preview secrets-manager` is the canonical managed-app review example.

## Discovery and Topology Mutation

### `rig discover`

Usage: `rig discover [--json] [--draft]`

Notes:
- Scans unmanaged tmux sessions.
- `--draft` generates a candidate rig spec from the discovery set.

### `rig attach`

Usage:
- `rig attach --self --rig <rigId> --node <logicalId> [--cwd <path>] [--display-name <name>] [--print-env] [--json]`
- `rig attach --self --rig <rigId> --pod <namespace> --member <name> --runtime <runtime> [--cwd <path>] [--display-name <name>] [--print-env] [--json]`

Notes:
- `--self` is currently required.
- Node attach and pod-create attach are exclusive modes.
- In tmux-backed shells, the command records tmux attachment metadata; otherwise it records an `external_cli` attachment.
- `--print-env` prints shell exports for `OPENRIG_NODE_ID` and `OPENRIG_SESSION_NAME`.

### `rig bind`

Usage: `rig bind <discoveredId> --rig <rigId> (--node <logicalId> | --pod <namespace> --member <name>)`

Important:
- `--rig <rigId>` is required.
- Binding mode is exclusive:
  - existing node: `--node <logicalId>`
  - create new node: `--pod <namespace> --member <name>`

### `rig adopt`

Usage:
- `rig adopt <path> --bind <logicalId=tmuxSessionOrDiscoveryId> [--bind ...] [--target-rig <rigId>] [--rig-root <root>] [--json]`

Important:
- `--bind` is required and repeatable.
- The input file must be a pod-aware RigSpec with `pods`.

Notes:
- Materializes the topology first, then resolves/binds discovered sessions.
- In JSON mode, emits the materialized nodes plus binding results.

### `rig expand`

Usage: `rig expand <rig-id> <pod-fragment-path> [--json] [--rig-root <path>]`

Notes:
- Adds a pod fragment to a running rig.
- `--rig-root` controls agent resolution.

### `rig unclaim`

Usage: `rig unclaim <sessionRef> [--json]`

Notes:
- Releases an adopted session without killing its tmux session.

### `rig release`

Usage: `rig release <rigId> [--delete] [--json]`

Notes:
- Releases all claimed/adopted sessions from a rig without killing their tmux sessions.
- `--delete` removes the rig record after a clean release.
- OpenRig-launched nodes still require `rig down`.

### `rig launch`

Usage: `rig launch <rigId> <nodeRef> [--json]`

Notes:
- Launches or relaunches a node in a running rig.
- `nodeRef` can be a logical ID or node ID.

### `rig remove`

Usage: `rig remove <rigId> <nodeRef> [--json]`

Notes:
- Removes a single node from a running rig.

### `rig shrink`

Usage: `rig shrink <rigId> <podRef> [--json]`

Notes:
- Removes an entire pod from a running rig.
- `podRef` can be a pod namespace or pod ID.

## Identity, Communication, and Context

### `rig whoami`

Usage: `rig whoami [--node-id <id>] [--session <name>] [--json]`

Identity resolution order:
1. `--node-id`
2. `--session`
3. `OPENRIG_NODE_ID` / `RIGGED_NODE_ID`
4. `OPENRIG_SESSION_NAME` / `RIGGED_SESSION_NAME`
5. tmux pane metadata `@rigged_node_id`
6. tmux pane metadata `@rigged_session_name`
7. raw tmux session name

Notes:
- If the daemon is unreachable but an identity source can still be resolved, `--json` returns a partial result instead of crashing.
- Human-readable output includes transcript location and context usage when available.
- In Claude Code projects, unattended `rig whoami` on boot may require the local permissions allow list to include `Bash(rig:*)`.

### `rig transcript`

Usage: `rig transcript <session> [--tail <lines>] [--grep <pattern>] [--json]`

Defaults:
- `--tail 50`

Notes:
- Reads transcript files, not pane scrollback.
- `--grep` treats the pattern as regex.

### `rig send`

Usage: `rig send <session> <text> [--verify] [--force] [--json]`

Notes:
- Uses the two-step send pattern automatically: paste text, wait, submit Enter.
- `--verify` requests delivery verification.
- `--force` overrides mid-task safety checks.

### `rig capture`

Usage:
- `rig capture <session> [--lines <n>] [--json]`
- `rig capture --rig <name> [--lines <n>] [--json]`
- `rig capture --pod <name> --rig <name> [--lines <n>] [--json]`

Default:
- `--lines 20`

### `rig broadcast`

Usage: `rig broadcast <text> [--rig <name>] [--pod <name>] [--force] [--json]`

Notes:
- Without `--rig` or `--pod`, broadcasts across all running sessions in all rigs.

### `rig ask`

Usage: `rig ask <rig> <question> [--json]`

Current implementation:
- Queries `/api/ask`
- Returns:
  - the original question
  - a rig summary (`name`, `status`, `nodeCount`, `runningCount`, `uptime`)
  - evidence excerpts from transcripts
  - optional chat excerpts
  - `insufficient` flag
  - optional guidance text

Important:
- The live help description says “Search rig transcript history with a natural language question,” but the shipped behavior is broader than plain transcript grep and narrower than a topology/lifecycle synthesis layer.
- This command is a daemon-backed evidence query, not a second LLM invocation.

### `rig chatroom`

Usage: `rig chatroom <subcommand>`

Subcommands:
- `send <rig> <message> [--sender <name>]`
- `history <rig> [--topic <name>] [--after <id>] [--since <ts>] [--sender <name>] [--limit <n>] [--json]`
- `wait <rig> [--after <id>] [--topic <name>] [--sender <name>] [--timeout <seconds>] [--json]`
- `clear <rig>`
- `topic <rig> <topic-name> [--body <text>] [--sender <name>]`
- `watch <rig> [--tmux]`

Notes:
- All chatroom subcommands take the rig name as a positional argument.
- `history` filters are composable: `--sender`, `--since`, `--after`, `--topic` can be combined.
- `wait` blocks until new matching messages arrive or times out (exit 1). Same filter semantics as `history`.
- `clear` is destructive and rig-scoped. Removes all messages for that rig.
- `watch --tmux` starts a dedicated tmux watcher session.

## Commands Not Present

These are not current top-level `rig` commands:
- `rig claim`
- `rig blame`
- `rig replay`

If older docs or habits mention them, treat those references as stale.
