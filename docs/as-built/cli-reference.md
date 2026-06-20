---
kind: as-built
title: OpenRig CLI Reference — Full rig Command Surface
status: active
topics: [runtime-control, agent-runtime]
domains: [operating-advisor, engineering-advisor, orchestrator]
applies-when: |
  Need the exact rig CLI surface — command groups, subcommands, flags,
  JSON output, cross-host, coordination primitives.
siblings: [README.md, architecture/daemon-core.md]
prerequisite-reads: [README.md]
last-verified-against-source: 8d55ea60
last-updated: 2026-06-20
---

# OpenRig CLI Reference

Verified against the shipped CLI on 2026-06-15 (v0.3.4) using:
- `packages/cli/src/index.ts`
- `packages/cli/src/commands/*.ts`
- `packages/cli/src/mcp-server.ts`
- live help from `node packages/cli/dist/index.js ... --help`

This document reflects the current `rig` surface as shipped. Where live help text is narrower than the implementation, notes call that out explicitly.

## Overview

- Binary: `rig`
- Top-level command groups: `64`
- Output mode: human-readable by default; many commands also support `--json`
- Daemon-backed commands fail when the daemon is stopped or unhealthy; `daemon`, `config`, `preflight`, and `doctor` also have local responsibilities
- Managed apps are launched through the normal spec/library surfaces; the canonical shipped example is `rig up secrets-manager`
- Legacy surface still shipped: `package`

## Top-Level Commands

| Command | Description |
| --- | --- |
| `daemon` | Manage the OpenRig daemon |
| `start` | Recovery entrypoint — daemon + kernel + per-rig restore (interactive or headless) |
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
| `reconcile-session` | No-launch, no-input adopt of a hand-resumed session |
| `bundle` | Manage rig bundles |
| `up` | Bootstrap a rig from a spec or bundle |
| `down` | Tear down a rig |
| `archive` | Archive a rig (soft + reversible: hides it from the default view, retains all data) |
| `unarchive` | Unarchive a rig (reverse of `rig archive`): returns it to the default view |
| `add` | Add a member to an existing pod in a running rig (`add_member` converge op) |
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
| `stream` | Coordination L1 — append-only intake stream |
| `queue` | Coordination L3 — owned-work queue + inbox/outbox |
| `project` | Coordination L2 — agent-backed classifier with daemon-enforced lease + idempotency + reclaim |
| `view` | Coordination L5 — daemon-backed views over coordination state |
| `watchdog` | Coordination Watchdog — daemon-native scheduler |
| `workflow` | Daemon-native Workflow Runtime — declarative spec + transactional-scribe step projection |
| `restore-packet` | Generate, read, and validate cross-runtime restore packets |
| `restore-check` | Check restore readiness across running rigs |
| `context` | Show context-usage across running agents |
| `compact-plan` | Plan Claude compact-in-place candidates without compacting anything |
| `heartbeat` | Show workflow execution proof state from queue files |
| `seat` | Inspect OpenRig seat observability state |
| `agent-image` | Browse, snapshot, and manage agent images |
| `context-pack` | Browse, preview, send, and install operator-authored context packs |
| `workspace` | Workspace primitive — typed-kind tooling (frontmatter validation) |
| `plugin` | Inspect plugins (read-only) — list, show, used-by, validate |
| `scope` | Scope tree primitive — missions, slices, sub-slices |
| `policy` | Operator context-mode bindings (sleep/desk/mobile/away/focus/debug) |

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
- `rig config [--json] [--with-source]`
- `rig config get <key> [--show-source]`
- `rig config set <key> <value>`
- `rig config reset [<key>]`
- `rig config init-workspace [--root <path>] [--force] [--dry-run] [--json]`

Supported keys:
- `daemon.port`
- `daemon.host`
- `db.path`
- `transcripts.enabled`
- `transcripts.path`
- `workspace.root` (and other workspace-rooted paths used by `init-workspace`)
- `snapshots.periodic.enabled` (default `true`) — daemon-side periodic snapshot scheduler on/off (v0.3.4)
- `snapshots.periodic.interval_seconds` (default `300`) — interval between periodic snapshots
- `snapshots.periodic.retention_keep` (default `10`) — number of periodic snapshots to retain per rig

Precedence:
- CLI flag
- environment variable
- config file
- default

Notes:
- `--with-source` (top-level) and `--show-source` (`get`) report per-key source/default for honest provenance.
- `init-workspace` scaffolds the default workspace at `~/.openrig/workspace/` (or the `--root` override) with mission/slice folders. `--force` overwrites scaffolded files (does NOT remove directories); `--dry-run` previews without writing. New in v0.3.0.
- `snapshots.periodic.*` (v0.3.4): the daemon-side scheduler takes periodic snapshots per rig at `interval_seconds` and retains the newest `retention_keep`. At restore time, newest-wins between `auto-periodic` and `auto-pre-down` snapshots.

Legacy env compatibility: the original runtime keys still accept deprecated
`RIGGED_*` aliases. New typed config keys use `OPENRIG_*` only.

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

### `rig start`

Usage:
- `rig start` (interactive: daemon + kernel + pick-and-restore)
- `rig start --last [--json]` (headless: restore rigs that were last running)
- `rig start --all [--json]` (headless: restore all rigs with restore-usable snapshots)
- `rig start --rigs <name> [<name>...] [--json]` (headless: restore only the named rigs)

Notes:
- Recovery entrypoint introduced in v0.3.4 (slice 01). Sequencing-only: composes daemon start + kernel auto-boot wait + per-rig restore primitives; re-codes nothing.
- NOT the getting-started boot hero — that remains `rig up <starter>`. `rig start` is for post-reboot/crash recovery.
- TTY interactive flow lists last-running candidates with a readiness summary (`[ready to resume]`, `[will ask before fresh]`, `[fresh start]`, `[mixed]`), then offers restore-all or a spacebar multi-select picker.
- Headless modes (`--last`, `--all`, `--rigs`) take zero prompts; if a node returns `awaiting-decision`, the CLI reports it honestly and prints the `rig up --existing <rig> --fresh <logicalId>` command to take action.
- Surface source-verified against `packages/cli/src/commands/start.ts` at `03a5f915` (v0.3.4).

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

Usage: `rig up <source> [--plan] [--yes] [--cwd <path>] [--target <root>] [--existing] [--fresh <seats...>] [--json]`

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
- `--cwd <path>` overrides launch working directory for all members for this run only. For path-form `rig up <install-internal-spec>` invocations the CLI defaults `cwd` to the caller's directory (slice-22 Bug 3) so library specs match path-form behavior.
- `--target <root>` is only for bundle/package installation. It does not override agent working directories.
- `--existing` skips the library-spec name resolution and treats `<source>` as an existing rig name directly (disambiguates when a library spec and a stopped rig share the same name).
- `--plan` previews the restore without executing (read-only). The preview honors an honest async timeout and reports per-node intended action.
- `--fresh <seats...>` deliberately fresh-primes the named seats (logical ids) instead of resuming their original sessions (operation B); reported in the per-node status vocabulary as `fresh-primed`. Repeatable: `--fresh seat-a --fresh seat-b` or `--fresh seat-a seat-b`.
- `local:` `agent_ref` values resolve relative to the rig spec directory, not the caller shell cwd.
- If you copy a built-in spec to a new directory, keep its `agents/` tree beside it or rewrite those refs to `path:/absolute/path`.
- Managed apps are first-class `up` targets. `rig up secrets-manager` launches the shipped Vault example from the library.
- v0.3.2 paper-cut fix-round (slice-22): pre-launch failures now return structured HTTP 4xx (`cycle_error` / `preflight_failed` / `validation_failed` / `service_boot_failed`) instead of bare 500; failed boots no longer leave orphan rig records on disk.
- v0.3.4: `rig up` is resume-original-by-default for existing rigs. Per-seat opt-in to deliberate fresh-prime is via `--fresh <seats...>`. The five-term restore status vocabulary surfaced per-node is `resumed` / `fresh-primed` / `awaiting-decision` / `attention_required` / `failed`. On TTY, `awaiting-decision` nodes trigger an interactive [y/N] ASK; in headless mode they are reported honestly with the exact `rig up --existing <rig> --fresh <logicalId>` follow-up command.

Success modes:
- fresh boot
- restored existing rig
- partial boot (non-zero exit)

### `rig down`

Usage: `rig down <rig> [--delete] [--force] [--snapshot] [--json]`

`<rig>` accepts a rig **name or id**, symmetric with `rig up`. A name is
resolved to its id via the active (non-archived) rig summary before teardown.

Flags:
- `--delete`: delete the rig record after teardown
- `--force`: kill sessions immediately
- `--snapshot`: take a snapshot before teardown

Notes:
- When `--snapshot` succeeds, human output includes the restore command.
- If the rig name is uniquely reusable, the handoff prefers `rig up <rigName>`.
- Destructive-op safety: if a name matches more than one rig, `rig down`
  refuses to tear down any of them and lists the matching ids - re-run with
  `rig down <id>`. An id always resolves directly (ids are never ambiguous).

### `rig archive`

Usage: `rig archive <rigId> [--force] [--json]`

Flags:
- `--force`: archive even if the rig is running or degraded
- `--json`: JSON output for agents

Notes:
- Soft, reversible archive: hides the rig from the default explorer and `rig ps`, while retaining the rig record, topology, and snapshots.
- Different from `rig down --delete` (delete is destructive; archive is recoverable).
- Archived rigs are hidden from default `rig ps`; use `rig ps --include-archived` to see them.
- Archiving a running or degraded rig requires `--force`; without it the call returns HTTP `409` with a three-part honest error and exits `2`.
- Reverse with `rig unarchive <rigId>`.
- Emits `rig.archived` SSE event.
- Surface source-verified against `packages/cli/src/commands/archive.ts` at `53794fbe` (v0.3.3).

### `rig unarchive`

Usage: `rig unarchive <rigId> [--json]`

Notes:
- Reverse of `rig archive`: clears the `archived_at` flag so the rig returns to the default explorer and `rig ps` view.
- Always non-destructive (the row and snapshots were retained while archived); no `--force` and no running-rig guard.
- Emits `rig.unarchived` SSE event.
- Surface source-verified against `packages/cli/src/commands/unarchive.ts` at `53794fbe` (v0.3.3).

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
- `rig ps [--json] [--full] [--rig <name>] [--session <sess>] [--limit <n>] [--fields <list>] [--summary] [--filter <key=value>] [--host <id>]`
- `rig ps --nodes [--json] [--full] [--rig <name>] [--session <sess>] [--limit <n>] [--fields <list>] [--summary] [--filter <key=value>] [--active] [--host <id>]`

Notes:
- **v0.4.0 — compact-by-default**: the default `--json` output is a compact TL;DR projection per node (slice 25): `session`, `rig`, `activity` (state + reason), `assigned` / `pending` counts. Same breadth as today (all visible nodes still listed) — projection-trim, not scope-narrowing. `--full` returns the complete record (raw byte-equivalent passthrough — preserves the prior shape including `tmuxAttachCommand`, `resumeCommand`, `contextUsage`, `agentActivity` full, `restoreOutcome`, etc.). Closes a ~77,000-token status-glance incident at root; even a narrow status check is now cheap.
- **`--rig <name>` / `--session <sess>` (slice 25)**: narrow the listing further by rig name or canonical session name.
- **Daemon node-list payload trimmed at source (slice 26)**: `recoveryGuidance` is no longer serialized as near-identical templated prose on every node — relocated to a guidance-by-reference map at the top level so the 4 current consumers still resolve it. `contextUsage` is a compact summary in the list payload (full telemetry remains retrievable per-node via `rig whoami` / detail queries). Even `--full` and the UI consumers stop paying for the redundant per-node blobs.
- `rig ps` lists rig summaries. Default human columns: `RIG`, `NODES`, `RUNNING`, `STATUS`, `LIFECYCLE`, `UPTIME`, `SNAPSHOT`. The `LIFECYCLE` column shows the rig-level fold of per-node lifecycle states with codes `run`/`rec`/`stp`/`deg`/`att`.
- `rig ps --nodes` expands into a cross-rig node inventory. Default human columns include `STATUS`, `STARTUP`, `LIFECYCLE`, `ACTIVITY`, `RESTORE`, `ERROR` so startup-time and live runtime state can be compared side-by-side without composing a separate diagnostic command.
- JSON output for both rig and node tiers includes a `rigName` alias (equal to `name`) for forward compatibility; agent code should prefer `rigName`. Default `--json` is a bare array (back-compat); the envelope shape `{entries, totalRigs|totalNodes, truncated, hint?}` is only used when `--limit`, `--fields`, `--summary`, or `--filter` is set.
- Default human output is bounded for context-window safety: rigs truncate at 50 with a footer naming the total + `--full` opt-out, nodes truncate at 100 with the same shape. `--full` disables truncation. `--limit <n>` sets an explicit bound.
- `--summary` emits aggregate counts only (`byStatus`, `byLifecycle` for rigs; `bySessionStatus`, `byLifecycle` for nodes); useful for quick fleet checks without per-entry detail. Cross-facet disagreement (e.g. a `running` rig with `attention_required` nodes) is not directly visible in summary mode — narrow with `--filter lifecycleState=attention_required` instead.
- `--fields <list>` projects JSON output to a comma-separated allow-list of top-level fields. Unknown keys are rejected before any HTTP call with an error naming the unknown key(s) and the sorted supported list. Exit code on rejection is `1`. Accepted (rig-level): `rigId`, `name`, `rigName`, `nodeCount`, `runningCount`, `status`, `lifecycleState`, `uptime`, `latestSnapshot`. Accepted (node-level, with `--nodes`): `rigId`, `rigName`, `logicalId`, `podId`, `podNamespace`, `canonicalSessionName`, `nodeKind`, `runtime`, `sessionStatus`, `startupStatus`, `restoreOutcome`, `lifecycleState`, `tmuxAttachCommand`, `resumeCommand`, `latestError`, `agentActivity`. `name` is rig-level only; for node entries use `rigName` (the rejection error includes a hint). Nested fields (e.g. `agentActivity.state`) are not drilled; pass the whole object name (e.g. `agentActivity`) and read the nested value downstream.
- `--filter <key=value>` accepts `status`, `lifecycleState`, `name-prefix`, `name`, and `agentActivity.state` (PL-019; node-level — use with `--nodes`). Unknown keys are rejected before any HTTP call with a clear error naming the supported list. For `agentActivity.state`, allowed values are `running`, `needs_input`, `idle`, `unknown`; invalid values fail fast with a three-part error (what failed / what's allowed / what to do).
- `--active` (PL-019; node-level) is sugar for `--filter agentActivity.state=running`. Combining `--active` with `--filter` is rejected — pick one explicit form. Output is identical to the explicit-filter form on the same fixture.
- `--host <id>` routes the same command to a remote host declared in `~/.openrig/hosts.yaml` via single-hop ssh (CLI-side shell-out; daemon untouched). Forwards every shaping flag (`--nodes`, `--full`, `--limit`, `--fields`, `--summary`, `--filter`, `--json`) to the remote `rig ps`. The remote rig's output is verbatim passthrough on success; failure is distinguished into `ssh-unreachable` / `permission-gate` / `remote-daemon-unreachable` / `remote-command-failed` per the closed cross-host execution contract.
- Exit codes:
  - `0` success
  - `1` daemon not running, or invalid `--filter` / `--limit`
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

### `rig restore-check`

Usage: `rig restore-check [--rig <name>] [--as <session>] [--full] [--no-queue] [--no-hooks] [--json]`

Notes:
- Checks restore readiness across running rigs (or one rig with `--rig` / one seat with `--as`).
- **v0.4.0 — summary + not-ready default (slice 29)**: default output is a summary block (total seats / ready / not-ready / error-degraded counts) PLUS only the **not-ready** seats listed compactly (seat + readiness reason). `--full` (or `--json --full`) returns today's complete per-seat readiness across the fleet. The daemon skips per-seat detail assembly for ready seats when compact (computes verdict, omits detail). Closes the largest measured token bomb on the read-command surface (~79,000 tokens → low thousands).
- The summary default correctly identifies EVERY not-ready seat (no false-ready omission) — the actionable signal is lossless even though detail is dropped for ready seats.
- `--no-queue` skips queue file checks; `--no-hooks` skips hook checks.
- Exit codes: `0` restorable (or restorable with caveats), `1` not restorable (red blockers found), `2` unknown / probe error.

### `rig restore-packet`

Usage: `rig restore-packet <subcommand>`

Subcommands:
- `write [options]` — generate a restore packet from a source session or JSONL file.
- `read <packet-dir> [--json]` — render a restore packet's contents (human or JSON).
- `validate <packet-dir> [--json]` — validate a restore packet against the v0 schema.

Notes:
- Packet shape is the cross-runtime v0 standard (Claude Code and Codex transcripts both supported via runtime parsers + redaction).
- `write` emits a packet directory with the canonical schema files plus `omitted-records` accounting.
- `read` and `validate` operate on existing packet directories and do not mutate them.

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
- `create <spec> -o <path> [--name <name>] [--bundle-version <ver>] [--include-packages <refs...>] [--rig-root <root>] [--notes <text>] [--min-daemon-version <ver>] [--min-cli-version <ver>] [--json]` — pack a rig spec + its declared content into a `.rigbundle`. v0.3.2 slice-05 ships first-class cross-primitive bundling: skills + plugins (hybrid) + workflow_specs + context_packs + agent_images vendor end-to-end with both-sides path containment, symlink escape protection, and integrity hashing.
- `inspect <path> [--json]` — inspect a `.rigbundle` manifest. v0.3.2 surfaces the cross-primitive content fields as first-class.
- `install <path> [--plan] [--yes] [--target <root>] [--skip-version-check] [--force] [--json]` — install a `.rigbundle`. Routes each declared content kind to its canonical library under `$OPENRIG_HOME`. `--skip-version-check` is an operator-explicit override of the install-time daemon/CLI compatibility gate (NOT recommended). `--force` is an operator-explicit override of the install-time conflict check (NOT recommended; conflicts may produce partial install state).
- `history [--rig <name>] [--since <iso>] [--json]` — list bundle install audit records from `~/.openrig/bundle-audit.jsonl`. Filters by target rig name and earliest `installedAt`.

Important:
- `bundle create` requires `-o, --output <path>` by source definition.
- v0.3.2 install timeout bumped (was 5s — too short for tmux-session-bootstrapping installs).
- Deferred to 0.3.3 (per release packet): agent/port/managed-app collision detection (Item 4.3), broader install-into-existing-rig pathway acceptance (Item 4.4), and the `--target-name` CLI flag (slice-05 Item-3 sub-scopes; design-contingent on CLI surface decision).

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
- `add` accepts either a YAML spec file or a full spec directory containing `rig.yaml` or `agent.yaml`.
- Directory adds copy the whole tree into the user library so adjacent agents, guidance, skills, and docs remain available.
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

### `rig reconcile-session`

Usage:
- `rig reconcile-session <session> [--rig <rigId>] [--node <logicalId>] [--no-launch] [--json]`

Arguments:
- `session`: canonical session name (e.g. `dev-impl@my-rig`) of the LIVE session to adopt.

Flags:
- `--rig` and `--node` are paired disambiguators (both required together) when the session resolves ambiguously.
- `--no-launch` is the only mode this command has; accepted for explicitness.

Notes:
- No-launch, no-input adopt of a hand-resumed canonical session (slice 03 / v0.3.4). The operator already resumed the session externally (e.g. `claude --resume`, `codex resume`) inside its canonical tmux session; the daemon still shows the seat down.
- Binds the live process to its OWN persisted node (same node id, no re-key) and updates the projection so `rig ps` / topology / send / capture / queue routing work again.
- NEVER launches, relaunches, kills, replays startup, presses resume menus, compacts, or types into the pane.
- Anything that could not be proven is reported as projection drift; conversation continuity is never claimed.
- Surface source-verified against `packages/cli/src/commands/reconcile-session.ts` at `03a5f915` (v0.3.4).

### `rig expand`

Usage: `rig expand <rig-id> <pod-fragment-path> [--json] [--rig-root <path>]`

Notes:
- Adds a pod fragment to a running rig.
- `--rig-root` controls agent resolution.
- Member YAML may carry `session_source` (see "Session source declaration" below) to start the new seat from a prior native conversation (`mode: fork`) or from operator-declared artifacts (`mode: rebuild`).

### `rig add`

Usage: `rig add <rig-id> <pod-namespace> <member-fragment-path> [--json] [--rig-root <path>]`

Arguments:
- `<rig-id>`: id of the target rig
- `<pod-namespace>`: namespace of the existing pod to add the member to
- `<member-fragment-path>`: path to a YAML/JSON member-fragment file (spec snake_case fields)

Notes:
- The `add_member` converge op verb: adds a member to an existing pod in a running rig from a YAML/JSON member-fragment file.
- Member fragment accepts both the bare form (top-level member fields) and the wrapper form (`{ member: {...}, edges?: [...] }`). A top-level `edges:` field in the bare form is lifted as pod-local edges and is NOT silently dropped.
- A present-but-non-array `edges` field is rejected with an honest error (no silent drop).
- `--rig-root <path>` controls agent resolution.
- HTTP outcomes: `201` on success (with the new node + persisted edges + optional warnings); `409 member_conflict`; `400 validation_failed` / `preflight_failed`; `404 pod_not_found` (lists existing pods).
- Exit code is non-zero if the HTTP call failed OR the new node did not fully launch (`status !== "launched"`).
- Surface source-verified against `packages/cli/src/commands/add.ts` at `53794fbe` (v0.3.3).

### Session source declaration (`session_source`)

Member YAML in a rig spec or `rig expand` payload may declare a launch-time `session_source` to control how the new managed seat derives its starting context. Two modes are supported in v1:

```yaml
# Fork from a prior native runtime conversation. Captures and persists a NEW
# post-fork token; the parent token is NEVER persisted onto the new seat.
members:
  - id: reviewer-2
    runtime: claude-code        # or "codex"; not valid on terminal
    session_source:
      mode: fork
      ref:
        kind: native_id         # v1 fork mode supports "native_id" only
        value: "0b0165d7-cb4d-4650-90de-15c0a1ede9e6"
```

```yaml
# Rebuild from operator-declared artifacts (CULTURE, role doc, handover packet,
# queue files, session logs). Fresh-launches the harness and seeds the running
# TUI with the artifacts in the operator-declared trust-precedence order.
# The seat's continuityOutcome is `rebuilt` (NEVER `fresh`/`resumed`/`forked`)
# and NO `resumeToken` is persisted.
members:
  - id: writer-2
    runtime: claude-code        # or "codex"; not valid on terminal
    session_source:
      mode: rebuild
      ref:
        kind: artifact_set      # v1 rebuild mode supports "artifact_set" only
        value:                  # ordered list, highest-trust first
          - <substrate-shared-docs>/rigs/<rig>/CULTURE.md
          - <substrate-shared-docs>/specs/agents/<role>.md
          - /path/to/handover-packet.md
          - /path/to/state/<pod>/<member>.queue.md
          - /path/to/state/<pod>/shared.session.log
          - /path/to/state/<pod>/<member>.session.log
```

Notes:
- `terminal` runtime rejects `session_source` (no native fork primitive; no agent context to rebuild).
- `mode: fork` requires `ref.kind: native_id` and a non-empty `ref.value` string. Other ref kinds (`artifact_path`, `name`, `last`) are reserved shapes for follow-up slices and are refused in v1 fork mode.
- `mode: rebuild` requires `ref.kind: artifact_set` and a non-empty `ref.value` array of paths. Missing paths are recorded as gaps and the launch proceeds with what resolved; if NO declared paths resolve, the launch fails with a clear error.
- The two modes are mutually exclusive on a given member; mixing is a schema error.

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

Usage: `rig launch <rigId> [nodeRef] [--seats <ids>] [--hold-reason <reason>] [--json]`

Notes:
- Launches or relaunches a node in a running rig.
- `nodeRef` (optional) can be a logical ID or node ID for the single-target form.
- `--seats <ids>` (v0.3.4, slice 11) takes a comma-separated list of logical IDs for node-granular managed partial restore — launch a named subset of seats while holding the rest. Retires the prior `pod_aware_launch_unsupported` dead-end.
- `--hold-reason <reason>` records the reason non-target seats are being held; surfaced via observability so the held state is auditable.

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

Usage: `rig whoami [--node-id <id>] [--session <name>] [--host <id>] [--full | --verbose] [--json]`

Identity resolution order:
1. `--node-id`
2. `--session`
3. `OPENRIG_NODE_ID` / `RIGGED_NODE_ID`
4. `OPENRIG_SESSION_NAME` / `RIGGED_SESSION_NAME`
5. tmux pane metadata `@rigged_node_id`
6. tmux pane metadata `@rigged_session_name`
7. raw tmux session name

Notes:
- **v0.4.0 — compact-by-default (slice 27)**: `rig whoami` and `rig whoami --json` default to identity-recovery essentials only — `identity` (rig / pod / member / sessionName / runtime / cwd / logicalId / ids), `peers` (names only: logicalId + sessionName per peer), `edges` (directional `kind` + `to.sessionName`), `transcriptPath`. Daemon skips the `contextUsageStore` lookup and `runtimeContext` build when compact is requested (also saves daemon work). The first command every agent runs on boot + every compaction-restore now costs ~192 tokens instead of ~909.
- **`--full` (alias `--verbose`)** returns today's complete payload including `contextUsage`, `commands`, `peersNote`, `runtimeContext` — byte / shape parity with the v0.3.4 default (back-compat for any consumer that reads those fields).
- The compact-default is an ALLOWLIST projection (not a denylist) — future payload fields default to `--full` and cannot silently re-bloat the every-boot path.
- If the daemon is unreachable but an identity source can still be resolved, `--json` returns a partial result instead of crashing.
- Human-readable output (compact default) shows identity + peers + edges + transcript path. `--full` adds context usage block, commands list, peersNote prose, runtimeContext.
- `peers[]` is this rig's roster excluding self (no edge filter); use `edges{}` for directional relationships and `rig ps --nodes` for node inventory including self + live state.
- In Claude Code projects, unattended `rig whoami` on boot may require the local permissions allow list to include `Bash(rig:*)`.
- `--host <id>` routes the same command to a remote host declared in `~/.openrig/hosts.yaml` via single-hop ssh (CLI-side shell-out; daemon untouched). Identity resolution happens on the REMOTE rig (each host has its own daemon + tmux + identity context); local `--node-id`/`--session`/`--full` flags are forwarded to the remote `rig whoami` invocation. The remote rig's output is verbatim passthrough on success; failure is distinguished into the same `ssh-unreachable` / `permission-gate` / `remote-daemon-unreachable` / `remote-command-failed` enum as `rig ps --host` and `rig send --host`.

### `rig transcript`

Usage: `rig transcript <session> [--tail <lines>] [--grep <pattern>] [--json]`

Defaults:
- `--tail 50`

Notes:
- Reads transcript files, not pane scrollback.
- `--grep` treats the pattern as regex.

### `rig send`

Usage: `rig send <session> <text> [--verify] [--force] [--wait-for-idle <s>] [--host <id>] [--json]`

Notes:
- Uses the two-step send pattern automatically: paste text, wait, submit Enter.
- `--verify` requests delivery verification.
- `--force` overrides mid-task safety checks.
- `--host <id>` routes the same command to a remote host declared in `~/.openrig/hosts.yaml` via single-hop ssh; see "Cross-host execution" below. SSH success is NOT verify success — the remote rig's `Verified: yes/no` is what counts and is surfaced verbatim.

### `rig capture`

Usage:
- `rig capture <session> [--lines <n>] [--host <id>] [--json]`
- `rig capture --rig <name> [--lines <n>] [--host <id>] [--json]`
- `rig capture --pod <name> --rig <name> [--lines <n>] [--host <id>] [--json]`

Default:
- `--lines 20`

Notes:
- `--host <id>` routes the same command to a remote host declared in `~/.openrig/hosts.yaml` via single-hop ssh; see "Cross-host execution" below.

### Cross-host execution (`--host <id>`)

`rig send` and `rig capture` accept a `--host <id>` flag that routes the
command to a remote host over single-hop SSH. v0 is CLI-side shell-out
only — the local daemon is not involved in routing, and there is no
daemon-to-daemon networking. The remote host is expected to have its own
managed `rig` available on `$PATH`.

Hosts are declared by the operator in `~/.openrig/hosts.yaml`:

```yaml
hosts:
  - id: vm-claude-test
    transport: ssh
    target: vm-claude-test.local
    user: your-username  # optional
    notes: "Tart VM"     # optional
  - id: laptop-b
    transport: ssh
    target: laptop-b.tail-scale-net
    user: your-username
```

Validation rules:

- `hosts` is required and must be a non-null array.
- Each entry: `id` required (non-empty, unique), `transport` required (v0 supports `ssh` only), `target` required (non-empty — DNS name, SSH config alias, or IP).
- `user` and `notes` are optional.
- The file is operator-managed; v0 does NOT include any sub-command to add, remove, or list hosts (operators edit the YAML directly).
- A missing or invalid file returns a clear error pointing at the canonical path.

The CLI distinguishes four structured failure modes (operators get an
actionable error per mode; JSON output preserves the `failedStep` enum):

- `ssh-unreachable` — SSH itself failed (connection refused, host key mismatch, etc.). Verify SSH access and the registry entry.
- `permission-gate` — SSH hit an auth/permission gate (Permission denied, Keychain). The error includes a hint to the keychain-over-SSH field note.
- `remote-daemon-unreachable` — SSH succeeded but the remote `rig` reported the remote daemon was not reachable. Start it with `ssh <target> rig daemon start`.
- `remote-command-failed` — SSH succeeded but the remote `rig` exited non-zero for some other reason; the remote stderr is surfaced.

Out of scope for v0: non-SSH transports; `--host` on `rig ps` / `rig whoami` / other commands; connection pooling; multi-hop SSH; cross-host queue routing; cross-host seat handover.

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

## Coordination Primitive (PL-004 Phase A)

Two top-level commands back the SQLite-canonical coordination layer. They speak only to the daemon HTTP API; they do NOT touch the POC `rigx-stream-proto` / `rigx-queue-proto` filesystem state. POC and daemon coexist at OPERATOR level only.

### `rig stream`

Usage: `rig stream <subcommand>` — L1 append-only intake stream.

Subcommands:
- `emit --source <session> --body <text> [--hint-destination <session>] [--hint-type <type>] [--hint-urgency <urgency>] [--hint-tags <csv>] [--interrupt] [--id <streamItemId>] [--json]`
- `list [--source <session>] [--hint-destination <session>] [--limit <n>] [--after <sortKey>] [--include-archived] [--json]`
- `show <streamItemId> [--json]`
- `archive <streamItemId> [--json]`

Notes:
- `--id` is for idempotency; same id returns the same row, body of subsequent calls is ignored.
- `archive` is soft — the row remains for audit and is excluded from `list` unless `--include-archived` is passed.

### `rig queue`

Usage: `rig queue <subcommand>` — L3 owned-work queue plus inbox/outbox.

Subcommands:
- `create --source <session> --destination <session> (--body <text> | --body-file <path>) [--mission <id>] [--slice <id>] [--priority <p>] [--tier <t>] [--tags <csv>] [--target-repo <name>] [--no-nudge] [--expires-at <iso>] [--id <qitemId>] [--json]` — v0.3.2 slice-21 FR-4 adds `--body-file <path>` (use `-` for stdin) which kills the backtick-shell-corruption class for multiline bodies, and first-class `--mission <id>` / `--slice <id>` flags that translate to `mission:<id>` / `slice:<id>` tags (compose with `--tags`). Exactly one of `--body` / `--body-file` must be provided.
- `claim <qitemId> --destination <session> [--json]` — pending → in-progress; computes closure_required_at from tier
- `unclaim <qitemId> --destination <session> [--reason <text>] [--json]` — in-progress → pending
- `update <qitemId> --actor <session> --state <state> [--closure-reason <r>] [--closure-target <t>] [--note <text>] [--json]`
- `handoff <qitemId> --from <session> --to <session> [--body <text>] [--note <text>] [--priority <p>] [--tier <t>] [--tags <csv>] [--json]` — transactional close-as-handed-off + create-new
- `fallback <qitemId> --destination <session> [--reason <text>] [--json]` — reroute to fallback seat
- `show <qitemId> [--json]`
- `transitions <qitemId> [--json]` — append-only transition log
- `list [--destination <session>] [--source <session>] [--mine] [--state <csv>] [-a | --all] [-A | --all-rigs] [--full] [-o <json|wide>] [--limit <n>] [--json]` — **v0.4.0 grammar (slices 28 + 32, docker / kubectl-aligned)**:
  - **`rig queue list`** (no flags) → active states only (`pending` / `in-progress` / `claimed` / `blocked` / `handed-off`; NOT `done` / `canceled`), **current-rig** breadth, compact rows: `qitemId`, `state`, `source→destination` (or `current-owner`), `closure_reason` / `closure_target` (when handed-off / blocked), `mission`, `slice`, `tier` / `priority`, `age` / `updated_at`, short title, capped tags. Excludes: full body, chain_of_record, transition history, proof / artifact blobs.
  - **`-a` / `--all`** → include closed / done history within the current breadth (docker `-a` axis: history).
  - **`-A` / `--all-rigs`** → cross-rig breadth (kubectl `-A` axis: breadth). Composable with `-a`, `--mine`, `--full`.
  - **`--full`** → add body + chain-of-record + full tags + transition history to whichever scope is selected (field-breadth axis).
  - **`-o json|wide`** → encoding, compact-by-default. `-o json` does NOT imply full body (compact JSON is token-safe + machine-parseable); `--full -o json` returns the full JSON.
  - **`--mine`** → just the caller's items.
  - `--destination <s>` / `--source <s>` / `--state <csv>` keep working and compose with the new flags.
  - The four axes (scope × history × field-breadth × encoding) are orthogonal and composable. The bare unscoped firehose that aggregated cross-rig + full-history (~64,000 tokens on the live host) is retired as a default — opt-in via `-A -a --full`.
  - Use `rig queue show <qitemId>` for the full single-item view (kubectl `describe` / docker `inspect` pattern).
- `overdue [--json]` — in-progress qitems past closure_required_at
- `inbox-drop <destinationSession> --sender <session> --body <text> [--tags <csv>] [--urgency <u>] [--audit <pointer>] [--id <inboxId>] [--json]`
- `inbox-absorb <inboxId> --receiver <session> [--json]` — promote a pending inbox entry to a queue_item
- `inbox-deny <inboxId> --receiver <session> --reason <text> [--json]`
- `inbox-pending <destinationSession> [--json]`
- `outbox-record --sender <session> --destination <session> --body <text> [--tags <csv>] [--urgency <u>] [--audit <pointer>] [--id <outboxId>] [--json]`
- `outbox-list <senderSession> [--limit <n>] [--json]`

Hot-potato strict-rejection (load-bearing API contract):
- `update --state done` REQUIRES `--closure-reason` from one of: `handed_off_to`, `blocked_on`, `denied`, `canceled`, `no-follow-on`, `escalation`. Missing or invalid reason → exit 1 with structured error naming the 6 valid values.
- `closure-reason` of `handed_off_to`, `blocked_on`, or `escalation` additionally requires `--closure-target`.
- All hot-potato enforcement happens at the daemon domain layer; every surface (CLI, future MCP, future UI) inherits the same guarantee.

Closure-reason semantics:
- `handed_off_to` — work continues at a different seat (target = new owner). `handoff` subcommand is the preferred path; `update` accepts it for non-handoff terminal closures.
- `blocked_on` — parked pending another qitem (target = blocker qitem_id).
- `denied` — receiver rejected the work.
- `canceled` — sender or receiver withdrew.
- `no-follow-on` — terminal completion, nothing else needed.
- `escalation` — kicked up to a higher tier (target = escalation target).

## Coordination Project / Classifier and View (PL-004 Phase B)

Two top-level commands extend the coordination layer with L2 (project / classifier) and L5 (views).

### `rig project`

Usage: `rig project <subcommand>` — L2 agent-backed classifier with daemon-enforced lease + idempotency + reclaim.

Subcommands:
- `lease-acquire [options]` — acquire the active classifier lease for the caller.
- `lease-heartbeat [options]` — send a heartbeat for an active classifier lease (extends TTL).
- `lease-show [options]` — show the currently-active classifier lease.
- `reclaim-classifier [options]` — operator verb to reclaim the active classifier lease. Use `--if-dead` to refuse if holder is still alive.
- `classify <streamItemId> [options]` — project a stream item with classification fields. Idempotent on `stream_item_id`; requires an active lease.
- `list [options]` — list project classifications with filters.
- `show <projectId> [options]` — show one project classification.

Notes:
- Lease semantics: only one classifier holds the active lease at a time. Heartbeats extend TTL; lease expiry frees the slot for the next acquirer.
- `classify` enforces L1→L2 foreign-key existence: the referenced `stream_items` row must exist or the call is rejected before any state mutation.
- `reclaim-classifier` is the operator-side verb to recover from a hung classifier; `--if-dead` adds a liveness guard so a still-heartbeating classifier is not stolen from.

### `rig view`

Usage: `rig view <subcommand>` — L5 daemon-backed views over coordination state.

Subcommands:
- `list [options]` — list built-in + custom views.
- `show <viewName> [options]` — run a view (built-in or custom).
- `register [options]` — register or update a custom view.

Built-in views:
- `recently-active`, `founder`, `pod-load`, `escalations`, `held`, `activity`.

Notes:
- Views emit a `view.changed` SSE event on every state mutation that affects them. Queue update mutations bridge to `queue.updated` and then to `view.changed` for all six built-in views (Phase B R2).
- Custom view registration writes to the `views_custom` table; the daemon hot-reloads on registration.

## Coordination Watchdog (PL-004 Phase C)

`rig watchdog` registers, lists, inspects, and stops daemon-native scheduler jobs. The scheduler runs inside the daemon supervision tree and persists state in SQLite (`watchdog_jobs`/`watchdog_history`); jobs survive daemon restarts. Three policies are available at v1: `periodic-reminder`, `artifact-pool-ready`, and `edge-artifact-required`. The fourth POC policy `workflow-keepalive` is rejected with `policy_deferred_to_phase_d` and ships in Phase D.

### `rig watchdog`

- `register --spec <path> --policy <name> --target-session <s> --interval-seconds <n> --registered-by <s>` — register a job from a YAML spec; `--active-wake-interval-seconds` and `--scan-interval-seconds` are pool-ready-specific opt-ins.
- `list` — list all jobs (active + stopped + terminal).
- `show <job_id>` — show one job.
- `status <job_id>` — show job + recent evaluation history (last 20 entries).
- `stop <job_id> [--reason <text>]` — operator stop; scheduler skips the job thereafter.

History records only loud evaluations: `sent` (delivery executed) or `terminal` (policy declared the job done). Quiet skip reasons (`not_due`, `no_actionable_artifacts`, `no_missing_edge_artifacts`, `active_wake_not_due`) are NOT recorded — POC parity so agents are not woken about scheduler polls. Loud `skipped` rows are recorded only if a policy returns a non-quiet reason.

Phase D extends the policy enum with `workflow-keepalive` (the policy deferred from Phase C). It reads `workflow_instances` directly via SQLite, requires `status: active|waiting`, and resolves frontier qitem owners from `queue_items`.

## Workflow Runtime (PL-004 Phase D)

`rig workflow` operates on the daemon-native Workflow Runtime: declarative spec validation, instance creation, step projection (transactional-scribe), trace, and idempotent continue. Workflow specs are markdown/YAML files on disk (workspace-surface); the daemon caches them in SQLite for fast lookup.

### `rig workflow`

- `validate <specPath>` — validate a workflow spec file; returns structured ok/error report (role resolution, step uniqueness, allowed-exits consistency, optional seat liveness).
- `instantiate <specPath> --root-objective <text> --created-by <session>` — create a new instance + entry-step qitem in the same daemon transaction; `--entry-owner <session>` overrides the default entry owner.
- `project --instance <id> --current-packet <qitem-id> --exit <handoff|waiting|done|failed> --actor-session <session>` — close the current packet AND project the next-step packet IN THE SAME daemon transaction (transactional-scribe; lost handoffs impossible by design). `--result-note <text>`, `--blocked-on <ref>`, `--next-owner <session>` modify behavior.
- `list [--status <s>]` — list instances; optionally filter by status (`active`/`waiting`/`completed`/`failed`).
- `show <instanceId>` — show one instance.
- `trace <instanceId>` — show the instance + its append-only step trail (audit-only).
- `continue <instanceId>` — idempotent inspector; in v1 returns the current state.

The owner-as-author + workflow-as-transactional-scribe contract is enforced by the daemon. The owner of a packet decides when it closes; the workflow runtime atomically records the closure AND creates/projects the next qitem per the workflow spec, in a single daemon transaction.

## Operational Inspection

Read-only inspection commands for context-window state, compaction planning, workflow heartbeat, and seat handover observability. Default mode is read-only across this section.

### `rig context`

Usage: `rig context [--rig <name>] [--threshold <pct>] [--refresh] [--full] [--json]`

Notes:
- Shows context-window usage across running agents.
- **v0.4.0 — compact-by-default (slice 30)**: default emits a compact summary (the few fields the common use needs); `--full` (or `--full --json`) returns today's complete current payload. Daemon skips the expensive aggregation when compact. Lower leverage than 28 / 29 but keeps the read-command surface compact-by-default after the upgrade.
- `--rig <name>` narrows to a single rig; `--threshold <pct>` filters to seats at or above the percent (plus unknown + stale).
- `--refresh` re-samples context usage before displaying instead of reading the latest cached snapshot.

### `rig compact-plan`

Usage: `rig compact-plan [--rig <name>] [--refresh] [--threshold-tokens <n>] [--threshold-percent <0-100>] [--json]`

Notes:
- Plans Claude compact-in-place candidates without compacting anything (read-only triage).
- `--threshold-tokens <n>` is the estimated used-token threshold; `--threshold-percent <0-100>` is the used-percent threshold when the context window size is missing.
- Output identifies seats that are candidates for compaction by current heuristics; the operator decides what (if anything) to compact.

### `rig heartbeat`

Usage: `rig heartbeat [--rig <name>] [--nudge] [--include-done] [--json]`

Notes:
- Shows workflow execution proof state from queue files.
- Default mode is read-only. `--nudge` sends informational proof instructions to stalled or unproven owners; it does not modify queue files or reroute work.
- `--include-done` includes done/handed-off queue items in the output (excluded by default).

### `rig seat`

Usage: `rig seat <subcommand>`

Subcommands:
- `status <seat> [options]` — show read-only seat handover observability status.
- `handover <seat> [options]` — plan a safe two-phase seat handover.
- `clear-attention <session> [--reason <text>] [--json]` — evidence-gated, operator-attested, audited reconcile of a stuck `attention_required` seat.

Notes:
- `status` reads the seat-handover observability tables (migration `021`); it does not mutate anything.
- `handover` plans the two-phase sequence; actual execution happens through the existing seat-launch surfaces under operator gating.
- `clear-attention` (v0.3.4) clears a stuck `attention_required` startup status using captured evidence; `--reason <text>` is an operator attestation override that skips the evidence gate (audited). Replaces SQLite hand-edit workarounds.

## Mission Control / Queue Observability (PL-005 Phase A)

Mission Control is an integrated product UI inside the existing shell, NOT a new `rig` command. Per PL-005 PRD line 301: "no new commands at v0; the `rig ps --nodes --json` surface is consumed read-only."

Mission Control is reached via the product UI at the `/mission-control` route. The HTTP API surface (`/api/mission-control/*`) is documented in `docs/as-built/architecture/mission-control.md`. The 7 verbs (`approve`, `deny`, `route`, `annotate`, `hold`, `drop`, `handoff`) execute via `POST /api/mission-control/action`; the 7 views are read via `GET /api/mission-control/views/:view-name`.

Mission Control consumes `rig ps --nodes --json` for fleet roll-up where the canonical CLI source is preferred. Cross-CLI-version drift is handled per the 4 sub-clauses of PRD § Runtime/Source Drift Acceptance: missing fields surface as honest "field unavailable on this rig's daemon version" placeholders; once-per-session-per-rig logging avoids spam; the fleet view shows a top-level "rigs running stale CLI" indicator.

## Agent Images, Context Packs, and Workspace (v0.3.0)

Three top-level commands shipped in v0.3.0 for operator-authored library content (agent images and context packs) and the workspace primitive.

### `rig agent-image`

Usage: `rig agent-image <subcommand>` — browse, snapshot, and manage agent images (PL-016).

Subcommands:
- `list [options]` — list all agent images in the library.
- `show <name-or-id> [options]` — show image manifest + statistics.
- `preview <name-or-id> [options]` — show manifest + sized supplementary file metadata + starter snippet.
- `create <source-session> [options]` — capture a productive seat's resumable state into a new agent image.
- `delete <name-or-id> [options]` — delete an agent image (subject to evidence-preservation guard).
- `pin <name-or-id> [options]` — pin an image so prune cannot delete it.
- `unpin <name-or-id> [options]` — unpin an image.
- `prune [options]` — delete evictable images (protected by evidence-preservation guard).
- `sync [options]` — re-walk discovery roots and refresh the library index.

Notes:
- Images are an operator-authored library form; deletion is gated by an evidence-preservation guard so productive seat snapshots are not lost accidentally.
- `pin` / `unpin` are the operator levers for explicit retention; `prune` honours them.

### `rig context-pack`

Usage: `rig context-pack <subcommand>` — browse, preview, send, and install operator-authored context packs.

Subcommands:
- `list [options]` — list all context packs in the library.
- `show <name-or-id> [options]` — show pack manifest + per-file metadata.
- `preview <name-or-id> [options]` — show the assembled bundle (the exact text that would be sent).
- `sync [options]` — re-walk discovery roots and refresh the library index.
- `add <source-dir> [options]` — install a context pack from a local directory into `~/.openrig/context-packs/`.
- `send <name-or-id> <destination-session> [options]` — assemble the pack into one paste-ready bundle and send to a seat.

Notes:
- Context packs are operator-authored bundles of context (manifest + files) intended to prime a managed seat with a coherent starting context.
- `preview` is the canonical way to see exactly what `send` will deliver; useful before priming a live seat.
- `send --dry-run` is supported for preview-then-deliver flows.

### `rig workspace`

Usage: `rig workspace <subcommand>` — Workspace Primitive (PL-007), v0 typed-kind tooling.

Subcommands:
- `validate [root] [--kind <kind>] [--no-recursive] [--require-frontmatter] [--max-files <n>] [--json]` — walk a workspace root, parse each `.md` file's YAML frontmatter, and emit a structured gap report. Advisory only — never modifies files. Default root: `cwd`. `--kind` validates against a specific workspace kind (`user | project | knowledge | lab | delivery`). `--max-files` (default `10000`) hard-caps the walk; v0.3.2 slice-01 GA enforces strict-int regex on this flag.
- `doctor [--workspace <path>] [--strict] [--json]` — v0.3.2 slice-21 FR-5. Run a 7-check workspace-readiness diagnostic against the daemon's resolved workspace (workspace root, missions folder, file allowlist, daemon alignment, daemon reload, optional slice docs, MISSION_NOTES presence). Read-only. Default exit-code: non-zero only on `fail`; `--strict` makes warn-or-fail non-zero. The CLI overlays `OPENRIG_FILES_ALLOWLIST` from the operator's shell env so doctor reflects the operator's intended allowlist even when the daemon's env is unchanged.

Notes:
- v0 surface was intentionally narrow (`validate` only); v0.3.2 added `doctor` as the operator-facing readiness diagnostic.
- Future versions will add typed-kind authoring/refactor tooling on the same root walker.
- See `rig config init-workspace` to scaffold a fresh default workspace.

## Plugin Inspection (v0.3.1)

One read-only top-level command added in v0.3.1 to inspect plugins
discovered from `$OPENRIG_HOME/plugins/` (default `~/.openrig/plugins/`).
No `install` verb at v0 — installation is explicit operator copy or
symlink per each plugin's `OPENRIG-INSTALL.md`.

### `rig plugin`

Usage: `rig plugin <subcommand>` — read-only plugin inspection.

Subcommands:
- `list [options]` — list discoverable plugins (aggregated across vendored + runtime caches).
- `show <id> [options]` — show plugin manifest + skills + hooks + mcp servers.
- `used-by <id> [options]` — list agents referencing this plugin in their `profile.uses.plugins[]`.
- `validate <path> [options]` — validate plugin manifest + skill frontmatter against the agentskills.io spec.

Notes:
- Plugin discovery aggregates `$OPENRIG_HOME/plugins/` (vendored at runtime by the operator) with the daemon's bundled plugin cache.
- `openrig-core` ships bundled with the daemon (11 skills). Additional plugins (`gstack` — 45 skills; `obra-superpowers` — 14 skills) ship as substrate references for plugin authors to copy-install per the `OPENRIG-INSTALL.md` workflow inside each plugin's source tree.
- A first-class `rig plugin install <substrate-path>` verb is deferred to 0.3.2.

## Scope Tree Primitive (v0.3.2)

One top-level command first shipped in v0.3.2 (`scopeCommand`,
`packages/cli/src/index.ts:20,187`; defined in
`packages/cli/src/commands/scope.ts`; release-0.3.2 slice 12). Operates
the scope tree (missions, slices, sub-slices) per
`conventions/scope-and-versioning`.

### `rig scope`

Usage: `rig scope <subcommand>` — scope tree primitive: missions, slices, sub-slices.

Top-level option:
- `--workspace <path>` — override workspace root (otherwise inferred from cwd or `$OPENRIG_WORK_ROOT`).

Two subcommand groups: `slice` and `mission`.

`rig scope slice <subcommand>` — slice-tier commands:
- `ls [--mission <name>] [--state <state>] [--json]` — list slices in a mission (or across all missions). `--state` filter: `active | closed | shipped | all` (default `active`).
- `show <slice-path> [--mission <name>] [--json]` — inspect a single slice (frontmatter + README + children). `slice-path` is absolute, relative-to-substrate, or `NN-slug`; `--mission` hints the mission when path is just `NN-slug`.
- `create <mission> <slug> [--template <kind>] [--title <text>] [--json]` — create a new slice in a mission. `--template` default `placeholder`. **v0.4.0 (slice 33)**: scaffolds a canonical `PROGRESS.md` (the structure the OpenRig PROGRESS UI page parses) plus a convention-correct README with proper frontmatter per `conventions/scope-and-versioning/README.md`, for EVERY template. Fixes the v0.3.x bug where newly-created slices were missing `PROGRESS.md` entirely.
- `progress <slice-path> [--mission <name>] [--status <state>] [--milestone <text>] [--owner <session>] [--note <text>] [--json]` — **v0.4.0 (slice 33)** new verb: append / set / update progress entries deterministically. Writes the canonical structure the OpenRig PROGRESS UI page reads. Replaces hand-editing `PROGRESS.md` with markdown.
- `ship <slice-path> <release-mission> [--mission <name>] [--json]` — ship a slice to a release mission (preserves git history).
- `close <slice-path> [--note <text>] [--mission <name>] [--json]` — close a slice (move to `<mission>/closed/`, update status). `--note` is an optional closure note.
- `move <slice-path> <dest-mission> [--mission <name>] [--json]` — move a slice between missions (re-numbers in destination).

`rig scope mission <subcommand>` — mission-tier commands:
- `ls [--json]` — list missions (top-level folders with `README.md`).
- `show <mission> [--json]` — inspect a single mission.
- `create <name> [--template <kind>] [--id <dot-id>] [--title <text>] [--json]` — create a new mission (mints a stable dot-ID into frontmatter). `--template` auto-selects when name matches `release-X.Y.Z`; `--id` overrides name-pattern inference. **v0.4.0 (slice 33)**: scaffolds a canonical `PROGRESS.md` plus a convention-correct README with proper frontmatter, per `conventions/scope-and-versioning/README.md`. Fixes the v0.3.x bug where newly-created missions were missing `PROGRESS.md` entirely.
- `progress <mission> [--status <state>] [--milestone <text>] [--owner <session>] [--note <text>] [--json]` — **v0.4.0 (slice 33)** new verb: append / set / update progress entries on a mission's `PROGRESS.md` deterministically. UI-valid by construction.

Notes:
- Surface source-verified against `packages/cli/src/commands/scope.ts` at `8d55ea60` (v0.4.0).

## Skill Cascade Audit (v0.4.0)

One top-level command first shipped in v0.4.0 (slice 10 — skill / knowledge lifecycle curation, Hermes-informed). Defined in `packages/cli/src/commands/skill.ts`. Pairs with the daemon-side audit surface at `packages/daemon/src/routes/skills/audit.ts` + `mirror-drift` detection.

### `rig skill`

Usage: `rig skill <subcommand>`

Subcommands:
- `audit [--json] [--include-cache] [--severity <level>] [--rig <name>]` — read-only audit of the skill cascade. Detects provenance + freshness issues across the canonical → product mirror → hub cwd → installed plugin chain.

Audit categories surfaced:
- **`missing`** — a skill location in the cascade lacks a SKILL.md file but a sibling location has one (declares the cascade-relative gap).
- **`stale`** — a SKILL.md file exists but is older than the canonical or has a content-hash mismatch.
- **`self-referential`** — a SKILL.md provenance pointer references its own location instead of an upstream source.
- **`invalid-date`** — frontmatter `last-verified` / `last-updated` is malformed or in the future.
- **`mirror-drift`** — a downstream mirror copy diverges from canonical with no documented intentional fork.

Notes:
- **Read-only**: the audit does NOT mutate any skill file. Findings are routed back to the lifecycle (curation-steward) for shaped propagation runs.
- **False-green prevention**: when mirror-drift evidence is unavailable for any reason (daemon offline, filesystem inaccessible), the CLI emits a clear `unable-to-audit` outcome with exit code `2` rather than reporting `clean`. This closes the failure mode the v0.3.4 wrap-gate AC-3 almost shipped ("Mirror sync verified via `npm run mirror-skills` clean" — that sync did not touch substrate canonical or hub cwd).
- `--include-cache` includes packaged-installer cache copies in the audit (default skips because those are immutable post-ship).
- `--severity <level>` filters output: `info` (default; everything), `warn` (stale + mirror-drift only), `error` (invalid-date + self-referential only).
- `--rig <name>` narrows the audit to a single rig's embedded skill copies.
- `--json` emits structured findings: `{cascade: [...locations...], findings: [{category, path, evidence, suggested-action}]}`.
- Exit codes: `0` clean, `1` findings present, `2` unable to audit.

Composes with the existing `scripts/mirror-skills.mjs` guardrails — the audit detects what `mirror-skills` would also catch, plus the canonical / hub cwd layers that script doesn't touch.

## Operator Context-Mode Bindings (v0.3.2)

One top-level command first shipped in v0.3.2 (`rigPolicyCommand`,
defined in `packages/cli/src/commands/rig-policy.ts`; release-0.3.2
slice 09). Pairs with the daemon's typed-primitive store at
`packages/daemon/src/db/migrations/041_rig_policy.ts`. Operates the
operator context-mode binding surface (sleep / desk / mobile / away /
focus / debug) used by mode-aware agent posture.

### `rig policy`

Usage: `rig policy <subcommand>`

Subcommands:
- `set <mode> [--scope <scope>] [--qualifier <id>] [--<field> ...] [--evidence <citation>] [--confirm] [--bearer <token>] [--json]` — propose a binding. Without `--confirm` the CLI echoes the proposed binding and exits with `exit 2` so scripts cannot accidentally apply; `--confirm` is the explicit operator action. `<scope>` is one of `global_host | rig | workstream | qitem` (defaults to the per-mode recommendation). `--qualifier <id>` is required for `rig | workstream | qitem` scopes and rejected for `global_host`. Per-field tuning flags: `--autonomy-scope`, `--heartbeat-cadence`, `--inspection-depth`, `--update-detail`, `--escalation-threshold`, `--concurrency-limit`, `--permission-prompt-posture` (one of `normal | batch_for_human | do_not_prompt_unless_blocked`; `auto_accept` is FORBIDDEN by convention), `--expiry-or-stale-rule`. `--evidence` carries a free-text operator citation (message id, file pointer, chatroom topic, etc.).
- `show [--json]` — list all operator-context-mode bindings.
- `effective [--rig <id>] [--workstream <id>] [--qitem <id>] [--json]` — resolve the effective mode for a (rig, workstream, qitem) read context. Surfaces `unknown_posture` when no binding matches.
- `cite [--rig <id>] [--workstream <id>] [--qitem <id>]` — emit the short-prose citation line for the effective mode at the read context (per convention §Citation Rules).
- `unset <scope> [qualifier] [--bearer <token>] [--json]` — delete one binding (operator-only).
- `defaults [--json]` — print the recommended per-mode 6×7 field defaults + default-scope mapping + stale rule.

Notes:
- The 6 modes are `sleep | desk | mobile | away | focus | debug`. Bare-word invocation is accepted (`set desk`); `mode:<word>` is the disambiguated prefix form.
- Restate-and-confirm posture (HG-4): `set` is restate-only until `--confirm` is passed. This prevents accidental script application.
- `--qualifier` strict reject for `global_host` (HG-7 guard finding): operators who type `--scope global_host --qualifier <id>` get an error and the daemon is never contacted. The CLI does NOT silently drop the qualifier.
- Operator-edit mutations (`set --confirm`, `unset`) require an operator bearer token (`--bearer` or `OPENRIG_AUTH_BEARER_TOKEN` env).
- Surface source-verified against `packages/cli/src/commands/rig-policy.ts` at `53794fbe` (v0.3.3).

## Commands Not Present

These are not current top-level `rig` commands:
- `rig claim`
- `rig blame`
- `rig replay`

If older docs or habits mention them, treat those references as stale.
