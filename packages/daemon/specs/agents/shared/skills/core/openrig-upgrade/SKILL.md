---
name: openrig-upgrade
description: Use when upgrading the OpenRig CLI/daemon on a host with running rigs, especially when preserving tmux-backed agent sessions through a daemon restart or documenting hot-upgrade SOP evidence.
metadata:
  cli_surfaces_referenced:
    - capture
    - daemon adopt-state
    - daemon start
    - daemon status
    - daemon stop
    - down
    - ps
    - restore-check
    - snapshot
    - up
    - upgrade backup
    - upgrade preflight
    - upgrade promote-runtime
    - upgrade verify
    - version
  openrig:
    stage: factory-approved
    sibling_skills:
      - openrig-user
      - openrig-operator
      - openrig-builder
      - openrig-architect
      - forming-an-openrig-mental-model
      - ai-dev-workflows
---

# OpenRig Upgrade

## Core Principle

OpenRig has two different failure domains:

- **Agent process plane:** Claude/Codex/terminal seats running inside tmux.
- **Management plane:** the OpenRig daemon, CLI, SQLite DB, transcripts, node inventory,
  send/capture APIs, restore metadata, and migrations.

A hot daemon upgrade is possible when the continuity seats remain alive in tmux and
the new daemon restarts against the same DB and transcript root. Do not run
`rig down` on continuity rigs unless the goal is a disruptive restore test; `rig down`
kills OpenRig-launched tmux sessions.

## Preferred Live-Cutover Operator Mode

For live production daemon cutovers, prefer an **out-of-band upgrade operator**:
a temporary host-local tmux seat outside the managed OpenRig topology, spawned
from the lifecycle/runtime-upgrade agent's current mental model.

Why: the managed rig stays in the agent process plane while a disposable sidecar
mutates the management plane. The sidecar inherits enough context to avoid a
cold handoff, but it is not inside the failure domain it is modifying.

Use this when all are true:

- the upgrade mutates the live daemon, CLI wrapper, DB, runtime worktree, tmux
  lifecycle, or active control-plane truth;
- continuity seats should keep working during the upgrade;
- a lifecycle/runtime-upgrade seat has already prepared the packet or owns the
  needed context;
- the human has granted an `operator auto window`.

In this SOP, `operator auto window` means a bounded operator-authorized upgrade lane. It does not
mean standing Codex `auto_review`, `--full-auto`, or approval-bypass mode. Use
`security-and-consequence-boundary-policy` skill for the current
security and consequence-boundary policy.

Do not use this pattern as a standing orchestration seat. The sidecar exists for
one cutover and then closes after handback.

### Sidecar Contract

The in-rig lifecycle/runtime-upgrade seat owns packet preparation and final
interpretation. The out-of-band sidecar owns only execution inside the approved
window.

Sidecar starter prompt shape:

```text
You are the host-local OpenRig runtime upgrade operator, outside the managed rig
topology. Execute the approved daemon-only cutover only after explicit human
approval. First read the upgrade preflight artifact and runtime-upgrade
decision. Prove you are outside the topology before mutation. Never run rig
down. Preserve tmux topology. Stop/start only the daemon, verify protected rigs,
write cutover evidence, unblock downstream artifacts only when the blocker is
truly closed, and rollback to <previous-wrapper-or-commit> if needed.
```

Required handback:

- write the live cutover evidence under the lifecycle evidence shelf;
- include proof that the sidecar was outside the topology/failure domain it
  mutated;
- update any blocked downstream dogfood/runtime task only when the blocking
  condition is truly closed;
- preserve caveats as downstream material instead of using them to reopen a
  closed cutover gate;
- report back to the in-rig lifecycle/runtime-upgrade seat or orch surface with
  daemon provenance, topology verification, caveats, rollback state, and one
  compact paragraph of operator judgment about ambiguous choices;
- close the sidecar after the original lifecycle owner has absorbed the result.

Stop conditions for the sidecar:

- preflight or runtime-upgrade decision is missing;
- human approval is absent or narrower than the requested cutover;
- protected topology is already degraded beyond the packet's expected caveats;
- target runtime cannot be verified by process path, port listener, and command
  evidence;
- any step would require `rig down` or destructive DB restore without a new
  explicit human decision.

Generic primitive: this upgrade specialization composes over the
`sidecar-operator` skill (the underlying out-of-band-operator pattern;
this skill is the upgrade-specific specialization).

## What Changed On 2026-04-27

Initial belief:

- All rigs had to be down before daemon restart.
- Live upgrade was research-gated because DB migrations might break session/node
  state while sessions were running.
- A parallel isolated daemon/adoption path looked necessary before production use.

Observed result:

- A daemon-only hot cutover preserved the live `example-seat` tmux
  sessions.
- The old daemon was stopped without running `rig down`.
- The new source-pinned daemon started against the same production DB.
- `rig ps --nodes --json`, `rig capture`, and `rig restore-check` could inspect the
  still-running continuity seats after restart.

The simpler model is now preferred for tmux-backed continuity rigs: snapshot and
back up state, stop only the daemon, start the new daemon, then verify that live
sessions are still observable and manageable.

## Proven Hot Path

Use this as the canonical first-choice workflow for a host where continuity rigs
are tmux-backed and the operator wants non-disruptive daemon upgrade.

0. **Spawn the out-of-band operator when live cutover is required.**
   The sidecar must be host-local and outside the managed topology being
   upgraded. Keep the lifecycle/runtime-upgrade owner inside the rig so it can
   continue to observe, ask questions, and absorb the handback.

1. **Choose continuity targets.**
   Name the exact rigs that must remain live. Everything else is source material.
   Do not let "nice to resume later" rigs expand the success criteria.

2. **Freeze active work.**
   Get continuity seats to a stable/idle checkpoint. Record resume commands if
   available.

3. **Inventory with filters.**
   Do not dump full `rig ps` output on this host. Use filtered JSON:

   ```bash
   rig ps --nodes --json \
     | jq -r 'map(select(.rigName=="<rig>")) | sort_by(.canonicalSessionName)[] | "\(.canonicalSessionName) \(.sessionStatus) \(.startupStatus) \(.resumeToken // "none")"'
   ```

4. **Take a non-destructive snapshot of each continuity rig.**
   This records rollback/recovery metadata without killing tmux sessions:

   ```bash
   rig snapshot <rigId>
   ```

   Verify the snapshot payload in SQLite has the expected nodes, sessions,
   checkpoints, and resume tokens.

5. **Create a post-snapshot SQLite backup.**
   Use SQLite's online backup API while the daemon is live. Then run
   `PRAGMA integrity_check` on the backup and verify it contains the continuity
   snapshot.

6. **Prepare a clean runtime artifact.**
   Prefer a dedicated clean source worktree pinned to a commit:

   ```bash
   git worktree add --detach /path/to/openrig-runtime-<shortsha> <commit>
   cd /path/to/openrig-runtime-<shortsha>
   PATH=/path/to/node22/bin:$PATH npm ci
   PATH=/path/to/node22/bin:$PATH npm run build
   ```

   Use even/LTS Node. The 2026-04-27 upgrade used Node `v22.22.1`.

7. **Stop only the daemon.**
   First try:

   ```bash
   rig daemon stop
   ```

   If the daemon state file is missing but the PID is known and verified as the
   OpenRig daemon, gracefully terminate that PID:

   ```bash
   kill -TERM <daemonPid>
   ```

   Do not use `kill -9` unless recovering from a wedged process with human
   approval. Do not run `rig down` on continuity rigs.

8. **Start the pinned daemon against the same production DB.**

   ```bash
   PATH=/path/to/node22/bin:$PATH \
     node packages/cli/dist/index.js daemon start \
       --port 7433 \
       --host 127.0.0.1 \
       --db ~/.openrig/openrig.sqlite
   ```

9. **Verify management continuity.**
   Required checks:

   ```bash
   rig daemon status
   lsof -nP -iTCP:7433 -sTCP:LISTEN
   rig ps --nodes --json | jq -r 'map(select(.rigName=="<rig>")) | ...'
   rig capture --rig <rig> --lines 1 --json
   rig restore-check --rig <rig>
   ```

   Success means the daemon is healthy, continuity sessions remain running/ready,
   capture works, transcripts are present, and `restore-check` reports no red
   blockers.

10. **Align the default CLI with the new daemon.**
    If `rig` is a wrapper, make sure it delegates to the new CLI.

11. **Write evidence and hand back.**
    The sidecar writes a cutover evidence packet with daemon provenance,
    protected topology counts, representative capture/restore checks, smoke
    results, caveats, and rollback state. Then it notifies the original in-rig
    lifecycle/runtime-upgrade owner. Do not rely on chat as the only proof.

## Proof Point: Daemon-Only Hot Cutover

A clean source runtime on an LTS Node version replaced the old daemon while one
tmux-backed continuity rig stayed live. The operator took a post-snapshot online
database backup, verified its integrity, stopped only the daemon, started the
new runtime against the same database, and confirmed that every protected seat
remained running and ready with no red restore blockers.

Important caveat: this proves hot daemon cutover for the tested tmux-backed
Claude runtime shape. It does not prove that arbitrary migrations,
non-tmux runtimes, service-backed rigs, or dead sessions can be recovered without
separate testing.

## Proof Point: Out-of-Band Sidecar Cutover

A lifecycle owner prepared the decision and preflight artifacts, then spawned a
host-local tmux sidecar outside the managed topology. The sidecar stopped only
the daemon, used a verified graceful PID fallback when daemon state was stale,
started the pinned runtime, aligned the default wrapper, verified the protected
topology, ran targeted smoke checks, retained cutover evidence, and handed the
result back while delivery continued.

Important caveat: live `rig up --plan --json` accepted valid `starter_ref`
specs and rejected forbidden compositions, but plan-mode output did not emit the
`resolve_starter.detail.starterContent` stage expected by the Dogfood proof bar.
This is a product/dogfood caveat, not an upgrade failure.

## Brittle Edges Observed On 2026-04-27

Operator lessons from the daemon upgrade:

- `rig down` kills OpenRig-launched tmux sessions. Do not use it as a snapshot
  primitive when resumability depends on keeping sessions alive.
- Old daemon/CLI combinations can be partially functional even when newer health
  checks fail. A `/healthz` mismatch blocked `rig down --snapshot` even though
  other daemon APIs still worked.
- `rig daemon stop` can fail when the daemon state file is missing. Operators
  need a verified PID fallback, but the product should reconcile daemon state
  automatically.
- If the sidecar has an operator auto window and `rig daemon stop` refuses only
  because state is stale, a verified graceful PID termination is acceptable:
  identify the daemon PID, verify its runtime path, send graceful `TERM`, and
  verify the port is gone before starting the target daemon.
- CLI and daemon provenance can drift. Repointing or verifying the default
  `rig` wrapper is part of the upgrade, not an afterthought.
- Raw `rig ps` output can be noisy. Use filtered JSON until the product
  has compact first-class inventory views.
- Snapshot and backup verification is too manual. The SOP currently depends on
  checking snapshot rows, resume tokens, SQLite backups, and integrity by hand.

## Disruptive Restore Path

Use disruptive restore when the goal is to test recovery from killed sessions, or
when hot upgrade is blocked by incompatible migrations or corrupted management
state.

```bash
rig snapshot <rigId>
rig down <rigId>
# upgrade daemon/CLI
rig up <rigName>
rig restore-check --rig <rigName>
```

Expected restore results:

| Result | Meaning | Action |
|---|---|---|
| `fully_restored` | All nodes resumed or rebuilt | Resume normal work |
| `partially_restored` | Some nodes succeeded, some failed | Inspect failed nodes and relaunch manually |
| `failed` | Zero nodes restored | Check daemon logs, snapshot integrity, provider tokens |
| `not_attempted` | Pre-restore blockers | Fix blockers before retrying |

Do not confuse this path with hot upgrade. `rig down` is intentionally
disruptive.

## Stop Conditions

Do not proceed with hot upgrade if:

- continuity targets are mid-task and cannot checkpoint;
- continuity target tmux sessions are missing before upgrade;
- no verified DB backup exists after continuity snapshots;
- the target runtime cannot build under an even/LTS Node version;
- the daemon migration plan is known to rewrite session/binding semantics in a
  way that has not been tested;
- disk space or DB integrity checks fail;
- the operator cannot identify the current daemon PID and runtime source.

## Rollback

Rollback means restoring the previous daemon runtime and, if necessary, the DB
backup.

For source runtime:

1. Stop the new daemon.
2. Start the previous runtime or npm/global daemon.
3. Verify `/healthz`, filtered continuity inventory, and `rig capture`.
4. Restore the DB backup only if migration or DB corruption is confirmed. Do not
   replace the DB just because continuity sessions are still live but management
   projection is degraded.

For npm runtime:

```bash
npm install -g @openrig/cli@<previous-version>
rig daemon stop
rig daemon start
```

## Roadmap: Better Hot Upgrades

The product should make the proven manual path boring and explicit.

Needed product surfaces:

- `rig upgrade preflight`:
  daemon PID/runtime source, CLI source, DB path, migration plan, active rigs,
  continuity targets, tmux liveness, disk space, DB integrity, backup target,
  and rollback runtime.
- `rig daemon adopt-state` or equivalent:
  recover a healthy daemon on a port when `daemon.json` is missing.
- `rig upgrade backup`:
  online SQLite backup plus integrity and snapshot-presence verification.
- `rig upgrade promote-runtime <commit|artifact>`:
  start from a clean worktree or packaged artifact under an even/LTS Node.
- `rig upgrade verify --rig <name>`:
  filtered inventory, capture, transcript, restore-check, and honest continuity
  classification.
- CLI/daemon provenance:
  `rig version --json` should report CLI path, daemon path, commit/package
  version, Node version, DB path, and started-at.
- Wrapper alignment:
  the default `rig` wrapper should clearly show which real CLI it delegates to.
- Compact inventory:
  first-class `rig ps --rig <name> --nodes --compact` or equivalent, so
  operators do not need ad hoc `jq` for routine safety checks.

Research still needed:

1. Migration-bearing hot upgrade on a throwaway rig.
2. Hot upgrade with non-critical live Codex seats.
3. Hot upgrade with service-backed rigs.
4. Adoption/reconciliation when daemon DB says sessions are running but tmux has
   partially drifted.
5. Automated rollback on daemon startup failure or migration failure.

## Operator Summary

Hot upgrade rule:

**Snapshot continuity rigs, back up the DB, stop only the daemon, start the new
daemon against the same DB, then verify live tmux sessions through filtered
management surfaces.**

Disruptive restore rule:

**Use `rig down` only when testing or accepting session teardown.**
