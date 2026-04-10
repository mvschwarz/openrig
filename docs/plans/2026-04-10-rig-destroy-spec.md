# Rig Destroy And Recovery Hardening

Date: 2026-04-10
Status: approved-for-implementation
Author: demo-agent

## Problem

OpenRig currently has a strong happy-path lifecycle, but recovery from a polluted local environment is too manual and too error-prone.

In real dogfooding on a machine that had:

- a globally installed `@openrig/cli`
- a locally built source checkout
- stale `~/.openrig` daemon state
- leftover managed tmux sessions
- a daemon process occupying the default port without a clean matching state file

the operator lost substantial time determining:

- which daemon instance was active
- whether the port owner was the expected daemon
- whether the database represented current truth or stale truth
- whether old managed tmux sessions were contaminating fresh boots
- whether `cmux` failures were product bugs or environment contamination

The product needs a first-class destructive recovery surface for cases where the operator intentionally wants to discard current OpenRig state and start from a true blank slate.

## Goals

1. Provide a canonical, explicit, operator-facing recovery command for destructive cleanup.
2. Make the destructive scope clear before execution.
3. Support two operator intents:
   - preserve current state by moving it aside
   - destroy current state entirely
4. Remove the most common contamination sources in one command:
   - daemon process
   - daemon lifecycle files
   - SQLite state
   - transcripts
   - snapshots/checkpoints/context
   - managed tmux sessions for currently known rigs
5. Keep the command hard to run accidentally.

## Non-Goals

This change does not attempt to solve every lifecycle issue in one PR.

Out of scope for this implementation:

- daemon status redesign
- automatic mixed-install conflict diagnosis
- source-vs-installed state-root isolation
- non-destructive `doctor --repair`
- generalized cleanup of repo-local generated files outside the OpenRig state root
- cleanup of arbitrary unrelated tmux sessions

Those are follow-on hardening items listed later in this document.

## Proposed Command Surface

Add a new top-level command group:

```text
rig destroy
```

Initial sub-surface is flag-driven rather than nested subcommands.

### Supported forms

```bash
rig destroy --state --backup --yes --confirm destroy-openrig-state
rig destroy --state --yes --confirm destroy-openrig-state
rig destroy --all --backup --yes --confirm destroy-openrig-state
rig destroy --all --yes --confirm destroy-openrig-state
```

### Required confirmation model

Every destructive invocation requires:

- one of `--state` or `--all`
- `--yes`
- `--confirm destroy-openrig-state`

If any are missing, the command exits non-zero with explicit guidance.

Reasoning:

- `destroy` is canonical infra/operator language
- `--yes` is standard CLI confirmation
- the exact confirmation string prevents accidental/autonomous execution

## Semantics

### `rig destroy --state`

Destroys the OpenRig state root contents, but does not attempt broad session cleanup beyond the daemon itself.

Effects:

1. Stop the daemon if a state file exists and it points to a live OpenRig process.
2. Best-effort kill the process currently listening on the configured daemon port if it appears to be OpenRig.
3. Remove daemon lifecycle files:
   - `daemon.json`
   - `daemon.log`
4. Remove the state root contents:
   - SQLite database files
   - checkpoints
   - context store
   - snapshots
   - transcripts
   - specs under the state root
   - any other managed state under `OPENRIG_HOME`
5. Recreate an empty state root directory.

This is the “blank state directory” reset.

### `rig destroy --state --backup`

Same cleanup intent as `--state`, but instead of deleting the state root, move it aside first.

Behavior:

1. Stop daemon / best-effort clear active OpenRig listener as above.
2. Rename the state root:
   - `~/.openrig` -> `~/.openrig.backup-YYYYMMDD-HHMMSS`
3. Recreate a fresh empty `~/.openrig`.
4. Print the backup location.

### `rig destroy --all`

Includes `--state`, plus managed tmux session cleanup.

Effects:

1. Execute all `--state` behavior.
2. Kill managed tmux sessions that correspond to OpenRig-managed rigs discoverable from the database before wipe.

Target set:

- all canonical session names for nodes in known rigs from the current DB
- current daemon-owned bootstrap sessions if any are represented in DB state

Non-goal:

- do not kill arbitrary tmux sessions that merely look related
- do not kill user sessions outside explicit managed rig membership

### `rig destroy --all --backup`

Performs managed tmux cleanup, then backs up the state root instead of deleting it.

## State Paths Covered

The command operates on the effective OpenRig state root resolved by compatibility rules:

- `OPENRIG_HOME` if set
- legacy `RIGGED_HOME` if set
- otherwise `~/.openrig`, with legacy fallback behavior where already implemented

Destroy scope includes the state root and its contents, not arbitrary project repos.

The command must print:

- resolved state root
- resolved daemon config
- whether backup mode is enabled
- whether tmux cleanup is enabled

## Safety Rules

### Refuse ambiguous intent

Reject:

- no scope flag
- both `--state` and unrelated future incompatible flags
- missing `--yes`
- missing or incorrect `--confirm`

### Refuse silent destructive broadening

`--state` must not kill tmux sessions.

`--all` is the only variant that kills managed tmux sessions.

### Backup naming

Backup names must be timestamped and collision-safe:

```text
~/.openrig.backup-20260410-010203
~/.openrig.backup-20260410-010203-2
```

### Daemon stop behavior

Destroy should not depend solely on `daemon.json`.

It should:

1. try normal lifecycle stop
2. probe the configured/default port
3. if the listener responds like OpenRig, stop that process as well
4. continue best-effort even if the state file is stale

This is important because the whole purpose of the command is recovery from stale state.

## Output Contract

Human output should be compact and explicit.

Example:

```text
DESTROY PLAN
  scope: all
  state root: /Users/wrandom/.openrig
  backup: /Users/wrandom/.openrig.backup-20260410-010203
  tmux cleanup: enabled

DESTROY RESULT
  daemon: stopped
  port 7433: cleared
  tmux sessions removed: 7
  state root: moved to /Users/wrandom/.openrig.backup-20260410-010203
  fresh state root: created
```

JSON mode is optional for this first implementation. Human-first output is acceptable.

## Implementation Plan

### CLI

Add a new command module:

- `packages/cli/src/commands/destroy.ts`

Register it in:

- `packages/cli/src/index.ts`

### Shared helpers

Add a small recovery helper module for destructive operations:

- resolve effective state root
- generate backup path
- stop daemon best-effort
- inspect / kill OpenRig listener on configured port
- enumerate managed tmux sessions from current DB before wiping
- remove or move state root

This can live either in:

- `packages/cli/src/destroy-helpers.ts`

or inside the command module if the surface stays small.

### Data sources

For `--all`, enumerate managed sessions from the current DB before wipe using the SQLite database path from config/defaults.

Session discovery should come from persisted OpenRig records, not by fuzzy tmux name matching.

### Dependencies

The command will need:

- filesystem ops
- tmux commands
- port/process inspection
- best-effort daemon lifecycle reuse

## Testing Plan

### Unit tests

Add CLI tests for:

1. requires exactly one scope flag
2. requires `--yes`
3. requires exact `--confirm`
4. `--state --backup` renames state root and recreates fresh dir
5. `--state` deletes state root contents and recreates fresh dir
6. `--all` kills only enumerated managed tmux sessions
7. stale daemon state still allows destroy to proceed
8. backup name collision gets a suffixed backup path

### Integration-style verification

Dogfood locally with:

1. source daemon running + fresh demo rig
2. stale daemon state file + no live daemon
3. live daemon on port + stale DB
4. mixed old tmux sessions present
5. `--state --backup`
6. `--all`
7. post-destroy `rig daemon start`
8. post-destroy fresh `rig up demo`

Success criteria:

- clean blank-slate recovery works in one step
- no accidental deletion of unrelated tmux sessions
- backup mode preserves old state root

## Follow-On Hardening Backlog

These should follow after `rig destroy` lands.

1. Richer `rig daemon status`
   - state-file PID
   - listener PID
   - healthz result
   - daemon binary path
   - state root path
   - DB path
   - source-vs-installed hints

2. Mixed-install conflict detection
   - warn when source build and installed package share state root and port

3. Source/dev isolation mode
   - repo-local state root and alternate default port for source testing

4. `rig doctor --repair`
   - non-destructive stale-state cleanup

5. cmux focus verification
   - distinguish created/attached from successfully focused

## Recommendation

Implement the first PR as:

- `rig destroy`
- backup and wipe modes
- managed tmux cleanup under `--all`
- tests
- CLI reference/docs update

Do not bundle daemon-status redesign into the same PR.
