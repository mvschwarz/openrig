---
kind: as-built
title: Lifecycle — Snapshot, Restore, Continuity
status: active
topics: [continuity, runtime-control]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Need to know how OpenRig captures a snapshot, restores a rig (resume vs
  rebuild vs fresh-primed vs stop-and-ask), enforces restore honesty, consults
  live continuity state, or how the daemon-side restore-check readiness probe
  and the CLI restore-packet command work.
siblings: [daemon-core.md, agent-spec-and-startup.md, transport-and-transcripts.md]
prerequisite-reads: [../README.md, agent-spec-and-startup.md]
last-verified-against-source: 254122872cf477511514979a4300b695d77cd1f7
last-updated: 2026-10-03
---

# Lifecycle — Snapshot, Restore, Continuity

The durable-state half of the core product loop:
`down (auto-snapshot) → up <rig-name> (auto-restore) → handoff`. Snapshot
captures serialized rig state; restore replays it honestly (no silent
fresh-fallback); restore-check is a separate read-only readiness probe.

> Verified against source at main `254122872cf477511514979a4300b695d77cd1f7`. Each count below sits beside the
> command that produces it; run the command from the repository root to refresh
> it.

## 1. Snapshot / restore / continuity types

All in `packages/daemon/src/domain/types.ts`. The spec/projection types live in
`agent-spec-and-startup.md`; the snapshot/restore types live here.

- **NodeRestoreOutcome** (`types.ts:501`) — the per-node restore outcome
  projected into `rig ps`. **9** values
  (`grep '^export type NodeRestoreOutcome' packages/daemon/src/domain/types.ts | grep -o '"[^"]*"' | wc -l`):
  `resumed`, `rebuilt`, `fresh`, `fresh-primed`, `awaiting-decision`,
  `failed`, `attention_required`, `operator_recovered`, `n-a`. The restore
  result itself, `RestoreNodeResult.status` (`types.ts:476`), has the same
  values without `n-a`: **8**
  (`grep -E '^  status: "resumed"' packages/daemon/src/domain/types.ts | grep -o '"[^"]*"' | wc -l`).
  Where `restore-orchestrator.ts` sets each one:
  - `resumed` — `baseStatus = "resumed"` after a legacy resume (`:1212`); the
    status is returned only by `finishJoinedResume` (`:1499`, `:1561`) after
    it has rebound and verified the pane, otherwise that becomes
    `attention_required` (`:1533`).
  - `rebuilt` — a checkpoint file was written (`:1272`).
  - `fresh-primed` — the default for a deliberate non-resume launch
    (`:1194`).
  - `fresh` — only the skip path for a pod node whose live continuity state
    is already `restoring` (`:992`).
  - `awaiting-decision` — the seat could not resume and nothing is running:
    before launch (`:1027`), or after launch once the blank session is rolled
    back (`:1208`, `:1230`, `:1243`, `:1259`, `:1417`).
  - `attention_required` — a live session waiting on a runtime prompt
    (`:1221`, `:1443`) or a harness that never started (`:1307`).
  - `failed` — occupant ambiguity (`:979`), launch failure (`:1118`), a
    checkpoint that cannot be delivered (`:1268`, `:1274`), a missing
    required startup file (`:1343`), or a startup error.
  - `operator_recovered` — only from later reconciliation,
    `reconcileNodeRuntimeTruth` (`:1759`, event at `:1902`).
- **RestoreRigResult** (`types.ts:445`) — the rig-level rollup, **4** values
  (`grep '^export type RestoreRigResult' packages/daemon/src/domain/types.ts | grep -o '"[^"]*"' | wc -l`):
  `fully_restored`, `partially_restored`, `failed`, `not_attempted`
  (`rollupRestoreRigResult`, `restore-orchestrator.ts:82`).
- **SnapshotData** (`types.ts:352`) — the serialized snapshot payload. It has
  **7** optional fields, kept optional so older snapshots still load
  (`sed -n '/^export interface SnapshotData/,/^}/p' packages/daemon/src/domain/types.ts | grep -c '?:'`):
  `activeSessionIdByNode?`, `activeOccupantsByNode?`, `topologyRoster?`,
  `pods?`, `continuityStates?`, `nodeStartupContext?`, `envReceipt?`.
- **NodeStartupSnapshot** (`types.ts:345`) — persisted restore replay input:
  classification-free projection entries, resolved startup files, startup
  actions, runtime.
- **PersistedProjectionEntry** (`types.ts:333`) — the classification-free
  restore replay seam: persists only entry identity + source metadata, NOT
  stale `classification`, `conflicts`, or `noOps` (Architecture Rule 10).
  Restore rebuilds each entry as `safe_projection` with empty `conflicts` and
  `noOps` (`restore-orchestrator.ts:1352`, `:1357`, `:1358`).

## 2. Snapshot, restore, continuity domain services

All under `packages/daemon/src/domain/`:

- `checkpoint-store.ts` — checkpoint persistence with pod/continuity context.
- `snapshot-capture.ts` — captures pods, continuity state, startup replay
  context, the latest env receipt, the active-occupant maps and the intended
  topology roster. `captureSnapshot` (`:60`) derives the occupant maps
  (`:73–79`), resolves the roster (`:81–90`), then reads `pods` (`:96`),
  `continuity_state` (`:100`) and `node_startup_context` (`:106`) rows per rig
  and the env receipt (`:116–123`).
- `snapshot-repository.ts` — snapshot CRUD and restore-source selection:
  `findLatestRestoreUsable` (`:72`) and `selectRestoreUsable` (`:94`), which
  accept only snapshots that pass `isRestoreUsableSnapshotData` (`:283`).
- `restore-orchestrator.ts` — resume, checkpoint delivery, startup replay,
  live continuity consultation, topology ordering (`computeRestorePlan`,
  `:876`, ordering only `delegates_to` and `spawned_by` edges, `:72`), and
  service boot gating before agent restore (`serviceOrchestrator.boot`,
  `:328`).
- `active-occupant.ts` — the shared rule for which snapshot session row is a
  node's occupant (`resolveActiveSnapshotSession`, `:74`).

## 3. Restore flow and restore honesty

Restore behavior, each point checked in `restore-orchestrator.ts`:

- Resolves each node's occupant from the snapshot's recorded active-occupant
  maps, not by picking the newest session row
  (`resolveActiveSnapshotSession`, `active-occupant.ts:74`, called at
  `restore-orchestrator.ts:974` and `:1171`). An ambiguous occupant fails the
  node loudly (`activeOccupantAmbiguityError`, `active-occupant.ts:97`).
- Consults live `continuity_state`; preserves state when a node is already
  `restoring` (`:985–998` — `SELECT status FROM continuity_state …` at
  `:987`; if `status === "restoring"` the node is skipped with a warning and
  reported as `fresh`, `:990–992`; `degraded` only adds a warning).
- Replays restore-safe startup using persisted startup context;
  prefilters missing optional artifacts into warnings; **hard-fails a node if
  a required startup file is missing** (`:1343` — status `"failed"`, error
  "Missing required startup files: …"). Before any mutation,
  `validatePreRestore` (`:585`) already blocks the whole restore when a node
  that will consume replay is missing a required startup file
  (`required_startup_file_missing`, `:729`; outcome
  `pre_restore_validation_failed`, `:290`). A node that resumes its exact
  native session replays nothing (`replayContained`, `:1288`).
- Writes a **transcript boundary marker before re-launch**
  (`writeBoundaryMarker`, `:1100`, called before `launchNode`).
- Refuses to restore over live sessions (`:258–261` — `rig_not_stopped`: "Rig …
  has live sessions. Stop the rig with 'rig down' before restoring"). A tmux
  probe that fails also blocks it (`classifyRunningSessions`, `:812`).
- Checks that the harness actually resumed. The resume adapters judge the
  pane with `assessNativeResumeProbe` (`domain/native-resume-probe.ts:84`). A
  pod-aware resume counts as resumed only when startup reports `resumed`
  continuity or the launched session row carries the snapshot's resume type
  and token (`launchedSessionMatchesSnapshotResume`,
  `restore-orchestrator.ts:1564`); a reported `fresh` continuity without that
  proof rolls back to `awaiting-decision` (`:1405–1419`).

**Restore-honesty rules** (texts in `architecture-rules-and-event-system.md`;
cited here by number with the code that carries them):

- Rule 7 — `RESTORE_POLICY_LEVEL`
  (`packages/daemon/src/domain/profile-resolver.ts:103`) orders the three
  policies, and `resolveRestorePolicy` (`profile-resolver.ts:488`) rejects a
  profile or member value that broadens it.
- Rule 14 — the outcome set is `RestoreNodeResult.status` (`types.ts:476`,
  §1); `rebuilt` is set only when a checkpoint is written
  (`restore-orchestrator.ts:1272`).
- Rule 15 — in `restore-orchestrator.ts`, a `resume_if_possible` seat with a
  session but no token stops as `awaiting-decision` before launch unless
  `--fresh` names it (`:1020–1029`); a failed resume kills the blank session
  (`rollbackToZeroSession`, `:1140`) and returns `awaiting-decision`
  (`:1230`); pod-aware resume passes
  `allowFreshFallback: !(isPodAware && resumeRequested)` (`:1399`). Fresh
  launch is explicit: `rig up --existing <rig> --fresh <seat...>`
  (`packages/cli/src/commands/up.ts:85`).
- Rule 16 — `rig down` prints the snapshot id and a restore command
  (`packages/cli/src/commands/down.ts:236–246`); `rig up` on an existing rig
  prints per-node statuses and the attach command
  (`packages/cli/src/commands/up.ts:540–560`).

(The full rule list lives in `architecture-rules-and-event-system.md`.)

## 4. Auto-snapshot and existing-rig power-on

- `rig down <rig>` (name or id, `packages/cli/src/commands/down.ts:104`)
  auto-captures an `auto-pre-down` snapshot before teardown when the rig has
  live sessions (`packages/daemon/src/domain/rig-teardown.ts:116`; an
  already-stopped rig returns at `:89–109` without one).
- `rig up <rig-name>`: a source with no `/` and no
  `.yaml`/`.yml`/`.rigbundle`/`.rigtopology` extension is a rig name
  (`packages/daemon/src/domain/up-command-router.ts:49–50`). The CLI first
  checks the spec library unless `--existing` is given, and refuses a name
  that matches both (`packages/cli/src/commands/up.ts:287–302`). The daemon
  finds the rig by name (`packages/daemon/src/routes/up.ts:222`) and
  restores from `selectRestoreUsable` (`routes/up.ts:105`), which prefers the
  newest `auto-pre-down` or `auto-periodic` snapshot, then the newest other
  usable one (`snapshot-repository.ts:75`).
- If no usable snapshot exists, or the chosen one names an older occupant
  (`snapshotMatchesCurrentOccupants`, `routes/up.ts:109`), `rig up` captures
  an `auto-rehydrate` snapshot of current DB state when that state is
  eligible (`routes/up.ts:136–145`). Otherwise it errors with code
  `no_snapshot` and guidance ("… current DB state is insufficient for
  rehydrate. Start fresh with: rig up <spec-path>", `routes/up.ts:117–122`).
- Post-command handoff: `down` output includes the snapshot ID and
  `To restore: rig up <name>` (or `rig restore <snapshotId> --rig <rigId>`
  when the name is not unique); `up` output includes node statuses and an
  `Attach:` command (anchors under Rule 16 above).

## 5. Daemon-side restore-check and CLI restore-packet

### 5.1 `rig restore-check` — readiness probe

`GET /api/restore-check?rig=<name>&noQueue=true&noHooks=true&compact=1&ready=1`
(`routes/restore-check.ts:205–206`). The route calls
`createRestoreCheckService` (`:149`), which assembles a framework-free
`RestoreCheckDeps` (`:153–201`) over existing daemon projections —
`listRigs` from `rigRepo` (`:172–175`), `getNodeInventory` (joining
`node_id` by `logical_id`, `:24–29`, `:176–182`), `getStartupContext` (reads
`node_startup_context`, parses `projection_entries_json` /
`resolved_files_json` / `startup_actions_json`, `:47–141`), `hasSnapshot`
/ `getLatestSnapshot` from `snapshotRepo` (`:186–192`), `probeQueueStore`
(`:155–167`), `getClaudeActivityHookEvents` (`:168–171`), and
`probeDaemonHealth` (self-evident: "We're inside the daemon — if this route
is responding, daemon is healthy", `:193–196`). It then runs
`service.check(...)` (`:216–217`).

`RestoreCheckService.check()` (`restore-check-service.ts:243`) layers:

1. **Host checks** — `checkDaemonReachable` (probe-throw → `verdict:
   unknown`, NOT `not_restorable`, `:256–263`), `checkStateDirWritable`
   (`:265`), `checkHostInfraDeclaration` (`:266`, impl `:432`).
2. **Rig enumeration** — `listRigs()` throw → `buildUnknown` (`:271–278`);
   `--rig` filter; unknown rig → red `rig.<name>.exists` (`:280–287`).
3. **Per-rig checks** — `checkSnapshot` (`:294`, impl `:701`),
   `checkSpecPresent` (`:299`, impl `:1064`).
4. **Per-seat checks** — `checkSeatReadiness` (`:315`), `checkStartupContext`
   (`:329`, impl `:789`; `unknownChecks` → `buildUnknown`, `:330–335`),
   `checkTranscript` (`:351`), `checkResumePath` (`:355`), and unless opted
   out: the daemon SQLite `queue_items` availability probe `checkQueueStore`
   (`:360`, gated by `--no-queue`; impl `:910`) and `checkHooks` (`:365`,
   gated by `--no-hooks`; impl `:933`). Queue continuity is represented by
   the shared daemon store; an empty queue is valid
   (`routes/restore-check.ts:159–160`). Claude hook readiness follows the
   persisted `claude_activity_hooks` runtime-resource selection
   (`restore-check-service.ts:957`) and the adapter's activity-relay
   projection in the seat CWD (`restore-check-service.ts:974–975`). A seat
   that deliberately omits that resource is not applicable. In compact mode
   without `ready=1`, a seat whose readiness check is green gets only the
   startup-context check (`restore-check-service.ts:327`, `:347–349`); that
   check still counts toward the verdict (`:337–340`).
5. **Verdict** — `buildResult` (`:1106`) aggregates: any red →
   `not_restorable`; any yellow → `restorable_with_caveats`; else
   `restorable` (`:1121–1128`); probe-uninspectable → `unknown`
   (`buildUnknown`, `:1137`). Plus a `RecoveryPlan` (`buildRecovery`,
   `:1241`) and a `RepairStep[]` packet (`buildRepairPacket`, `:1475`;
   `null` when fully restorable, `:1476`).

The result shape is `RestoreCheckResult` (`restore-check-service.ts:144–156`):
`verdict`, `readiness`, `continuity`, `rigs[]`, `hostInfra`, `recovery`,
`counts {red,yellow,green}`, `classCounts`, `checks[]`, `repairPacket`. With
`compact=1` the route returns a reduced body (`routes/restore-check.ts:219–245`).

**Honest-error design:** a daemon-probe *exception* produces
`verdict: unknown` (uninspectable state), distinct from a daemon
definitely-down state which is `red` / `not_restorable`
(`restore-check-service.ts:253–263`, `checkDaemonReachable` `:393–413`). The
route's catch-all returns the same `unknown`-shaped body with HTTP 500 + a
`probe.error` red check (`routes/restore-check.ts:249–297`).
`CheckEntry.remediationSafe` defaults to `false` (conservative —
unclassified remediations are NOT auto-execution-safe,
`restore-check-service.ts:19–24`, applied at `:1490`).

CLI surface (`../cli-reference.md` `### rig restore-check`; options in
`packages/cli/src/commands/restore-check.ts:222–227`):
`rig restore-check [--rig <name>] [--full] [--ready] [--no-queue] [--no-hooks] [--json]`.
Output is compact unless `--full` (`:313`). Exit codes: `0` restorable (or
with caveats), `1` not restorable (red), `2` unknown / probe error
(`:214–217`).

### 5.2 `rig restore-packet` — cross-runtime restore packet

CLI-side, no restore-packet daemon route. `commands/restore-packet.ts`
(**539** lines, `wc -l < packages/cli/src/commands/restore-packet.ts`)
implements **3** subcommands
(`grep -c 'cmd.command(' packages/cli/src/commands/restore-packet.ts`;
`../cli-reference.md` `### rig restore-packet`): `write [options]` (`:216`;
generate a packet directory from a source session or JSONL file, with
`omitted-records` accounting; `--source-session` reads the transcript from the
daemon's `/api/transcripts/<session>/full`, `:156`), `read <packet-dir> [--json]`
(`:371`; render contents; non-mutating), `validate <packet-dir> [--json]`
(`:450`; validate against the v0 schema; non-mutating). Packet shape is the
cross-runtime v0 standard — Claude Code and Codex transcripts both supported
via runtime parsers + redaction (`packages/cli/src/restore-packet/`).

## See also

- `agent-spec-and-startup.md` — StartupOrchestrator persists the replay
  context that restore consumes.
- `daemon-core.md` — `/api/restore-check` is one of the **69** route mounts
  in `server.ts` (`grep -c 'app.route(' packages/daemon/src/server.ts`),
  mounted at `server.ts:836`.
- `transport-and-transcripts.md` — transcript boundary markers written on
  restore.
- Source roots: `packages/daemon/src/domain/{restore-orchestrator,
  snapshot-capture,snapshot-repository,checkpoint-store,active-occupant,
  restore-check-service}.ts`, `packages/daemon/src/routes/{restore-check,up}.ts`,
  `packages/cli/src/commands/{restore-packet,restore-check}.ts`.
