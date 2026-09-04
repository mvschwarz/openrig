---
name: openrig-upgrade
description: Use when an agent is preparing or performing an OpenRig CLI/daemon upgrade and must preserve live seats, verify each mutation, or reconcile managed plugin and skill files without overwriting local work.
metadata:
  cli_surfaces_referenced:
    - capture
    - daemon start
    - daemon status
    - daemon stop
    - plugin list
    - ps
    - restore-check
    - snapshot
    - version
  openrig:
    stage: factory-approved
    sibling_skills:
      - openrig-user
      - openrig-operator
      - forming-an-openrig-mental-model
---

# Upgrade OpenRig

An upgrade is an observed agent workflow, not a transaction hidden behind one
command. Hosts differ, process state drifts, local plugin files accumulate, and
the useful response to a failed step depends on what is still alive.

**The agent owns the sequence. Stop after every mutation and observe the actual
effect before choosing the next step.** There is deliberately no end-to-end
upgrade subcommand.

## Safety model

Keep these planes separate:

- Seats normally live in tmux and can survive a daemon restart.
- The daemon, database, wrappers, and managed plugin projection are the control
  plane being changed.
- `rig down` tears down seats. It is not part of a continuity-preserving upgrade.

Before acting, name the rigs and seats whose continuity matters. On a production
host, use the host's normal operator ceremony. On a recovery-friendly build VM,
the orchestrator may adopt a tested runtime directly, but still observes each
step and stops on unexplained drift.

## The loop

For every step:

1. **Inspect.** Derive current facts from the live host.
2. **Decide.** Choose one bounded mutation and state its expected effect.
3. **Act once.** Do not bundle the next mutation with it.
4. **Observe.** Check the process, listener, database, plugin, and seat surfaces
   that the step could have changed.
5. **Continue, adapt, or stop.** A failed expectation is information for the
   agent, not permission for a blind retry.

## Bounded helpers

Let `SKILL_DIR` be the directory containing this `SKILL.md`. These scripts emit
JSON and do not decide the upgrade sequence.

### Inspect current facts

```bash
node "$SKILL_DIR/scripts/inspect-upgrade.mjs"
```

This asks the installed `rig` for its version, daemon status, node inventory,
and plugin inventory. A missing surface remains visible with a suggested next
probe. `ready: false` means the agent must resolve or consciously bound the gap;
it does not mean the script should mutate anything.

### Back up SQLite

Take continuity snapshots first:

```bash
rig snapshot <rig-id>
node "$SKILL_DIR/scripts/backup-sqlite.mjs" \
  --source "$OPENRIG_HOME/openrig.sqlite" \
  --destination "/safe/path/openrig-before-upgrade.sqlite"
```

The helper refuses to overwrite a destination, uses SQLite's backup operation,
and verifies the backup with `PRAGMA integrity_check`. It does not stop the
daemon or restore a database.

### Plan or apply safe managed-plugin refreshes

Plugin trees may contain skills as well as hooks and metadata. Compare the last
packaged ancestor, the target package, and the live installed tree:

```bash
node "$SKILL_DIR/scripts/refresh-managed-plugin.mjs" \
  --ancestor /path/to/previous/package/plugin \
  --target /path/to/target/package/plugin \
  --live "$OPENRIG_HOME/plugins/<plugin>"
```

Review the sorted decisions. To apply only `refresh-safe` and `add-safe` files:

```bash
node "$SKILL_DIR/scripts/refresh-managed-plugin.mjs" \
  --ancestor /path/to/previous/package/plugin \
  --target /path/to/target/package/plugin \
  --live "$OPENRIG_HOME/plugins/<plugin>" \
  --apply-safe
```

The helper never deletes a live file and never overwrites a local modification.
Local deletions, live-only files, target removals, and ambiguous types are
reported for the agent to resolve. Re-run the plan after any manual resolution.

### Migrate a pre-0.5.9 instance layout

Version 0.5.9 moves Claude context-usage telemetry from
`$OPENRIG_HOME/context` to `$OPENRIG_HOME/state/context-usage`, moves provider
telemetry to `state/provider-usage`, claims `context/` as the addressable
library, and installs the default System World at
`context/system/system-world.yaml`. The migration is deliberately split so a
fresh telemetry sample proves writer/reader convergence before the library
move reuses the old telemetry directory.

With an exact protected preimage path, first inspect and then copy state plus
rewrite known live Claude collector projections:

```bash
node "$SKILL_DIR/scripts/migrate-telemetry-state-0.5.9.mjs" \
  --home "$OPENRIG_HOME"

node "$SKILL_DIR/scripts/migrate-telemetry-state-0.5.9.mjs" \
  --home "$OPENRIG_HOME" \
  --apply-state \
  --preimage "$OPENRIG_HOME/backups/layout-0.5.9-before"
```

After the target daemon is running, wait until every bounded post-apply legacy
tail is followed by newer samples for that same seat at both new state roots.
This proves temporal convergence without requiring blanket process replacement;
a later legacy write remains a hard stop. Capture the verification JSON; do not
infer success from a copied old sidecar:

```bash
node "$SKILL_DIR/scripts/migrate-telemetry-state-0.5.9.mjs" \
  --home "$OPENRIG_HOME" \
  --verify \
  --preimage "$OPENRIG_HOME/backups/layout-0.5.9-before" \
  > /safe/path/layout-0.5.9-verify.json
```

Only a successful receipt authorizes the context-library move:

```bash
node "$SKILL_DIR/scripts/migrate-telemetry-state-0.5.9.mjs" \
  --home "$OPENRIG_HOME" \
  --apply-library \
  --preimage "$OPENRIG_HOME/backups/layout-0.5.9-before" \
  --verification /safe/path/layout-0.5.9-verify.json
```

Stop on every reported issue: malformed or foreign legacy entries, an unknown
live Claude cwd, a nonempty target, collector drift, config drift, or a missing
fresh dual sample all require the named repair before continuing. Verification
records the exact bounded tail bytes and their paired-newer samples; library
apply revalidates that rule, refuses resumed legacy writes or byte drift, and
preserves accepted tails in the protected preimage before removal. The helper
does not stop/start the daemon, launch a seat, touch the database, or decide
whether the upgrade proceeds.

To recover, restore the prior runtime as the agent-led workflow requires, then
reverse only helper-owned layout/projection writes. The new state copies remain
for inspection:

```bash
node "$SKILL_DIR/scripts/migrate-telemetry-state-0.5.9.mjs" \
  --home "$OPENRIG_HOME" \
  --rollback "$OPENRIG_HOME/backups/layout-0.5.9-before"
```

## Agent-led continuity upgrade

This is a decision guide, not a command recipe. Adapt paths and checks to the
host in front of you.

1. Inspect the current CLI, daemon, nodes, and plugins with the helper.
2. Checkpoint active work and record the exact protected tmux/session census.
3. Run `rig snapshot <rig-id>` for each protected rig.
4. Create and verify the SQLite backup.
5. Build or stage the target runtime separately. Prove its version and source
   identity before touching the live daemon.
6. Run `rig daemon stop`. Verify both the listener and the identified daemon
   process are gone. If the command returns while either remains, stop: inspect
   identity and use the host's authorized recovery procedure. Do not blindly
   signal a PID.
7. Start the target with `rig daemon start` or the host's known wrapper. Verify
   daemon status, process path, listener, version, and database integrity.
8. Run the plugin refresh helper in plan mode. Apply safe writes only after the
   three roots and classifications make sense; resolve preserved paths one at a
   time when required.
9. Verify protected seats with `rig ps --nodes -A --json`, representative
   `rig capture`, and `rig restore-check` where applicable. `-A` is required:
   without it the node read is your CURRENT rig only, and a daemon upgrade
   protects seats across every rig on the host — so the narrow form reports
   success while seats outside your rig went unchecked.
10. Align wrappers only after deriving how that host owns them. Use its existing
    mechanism; this skill does not rewrite launchers.
11. Record the observed result, remaining local preservation decisions, and the
    exact rollback runtime and backup.

## Stop and hand back when

- a protected tmux session is missing before the upgrade;
- database integrity or backup verification fails;
- the running process or listener does not match the expected runtime;
- daemon stop reports success but the identified process or listener remains;
- the target cannot start against the existing database;
- plugin roots cannot be tied to a known ancestor and target;
- a required plugin path is classified as locally modified or deleted and the
  correct ownership decision is unclear;
- continuing would require `rig down`, destructive restore, credential changes,
  or broader authority than the operator has.

When stopping, report the last proven-good state, the first failed expectation,
the exact evidence, and the smallest decision needed from the owner. Preserve
live seats and the database unless recovery specifically requires otherwise.

## Rollback is also agent-led

Prefer starting the previous known runtime against the still-valid database.
Restore the database backup only when a migration or corruption finding requires
it; a degraded projection alone is not proof that the database should be
replaced. After rollback, repeat the same process, listener, database, plugin,
and seat observations used during the forward path.
