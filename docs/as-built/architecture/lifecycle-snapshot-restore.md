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
last-verified-against-source: a350c59b5a5fb37ee4a21b1026b595068b603df1
last-updated: 2026-10-05
---

# Lifecycle — Snapshot, Restore, Continuity

The durable-state half of the core product loop:
`down (auto-snapshot) → up <rig-name> (auto-restore) → handoff`. Snapshot
captures serialized rig state; restore replays it honestly (no silent
fresh-fallback); restore-check is a separate read-only readiness probe.

> Verified against source at main `a350c59b5a5fb37ee4a21b1026b595068b603df1`. Each count below sits beside the
> command that produces it; run the command from the repository root to refresh
> it.

## 1. Snapshot / restore / continuity types

All in `packages/daemon/src/domain/types.ts`. The spec/projection types live in
`agent-spec-and-startup.md`; the snapshot/restore types live here.

- **NodeRestoreOutcome** (`types.ts:500`) — the per-node restore outcome
  projected into `rig ps`. **9** values
  (`grep '^export type NodeRestoreOutcome' packages/daemon/src/domain/types.ts | grep -o '"[^"]*"' | wc -l`):
  `resumed`, `rebuilt`, `fresh`, `fresh-primed`, `awaiting-decision`,
  `failed`, `attention_required`, `operator_recovered`, `n-a`. The restore
  result itself, `RestoreNodeResult.status` (`types.ts:475`), has the same
  values without `n-a`: **8**
  (`grep -E '^  status: "resumed"' packages/daemon/src/domain/types.ts | grep -o '"[^"]*"' | wc -l`).
  Where `restore-orchestrator.ts` sets each one:
  - `resumed` — `baseStatus = "resumed"` after a legacy resume (`:1031`); the
    status is returned only by `finishJoinedResume` (defined `:1319`, called
    `:1245` and `:1312`, returning `resumed` at `:1381`) after it has rebound
    and verified the pane; otherwise that becomes `attention_required`
    (`:1353`, `:1377`).
  - `rebuilt` — a checkpoint file was written (`:1091`).
  - `fresh-primed` — the default for a deliberate non-resume launch
    (`:988`).
  - `fresh` — only the skip path for a pod node whose live continuity state
    is already `restoring` (`:786`).
  - `awaiting-decision` — the seat could not resume and nothing is running:
    before launch (`:821`), or after launch once the blank session is rolled
    back (`:1027`, `:1049`, `:1062`, `:1078`, `:1237`).
  - `attention_required` — a live session waiting on a runtime prompt
    (`:1040`, `:1263`) or a harness that never started (`:1126`).
  - `failed` — occupant ambiguity (`:773`, `:970`), launch failure (`:912`),
    a checkpoint that cannot be delivered (`:1087`, `:1093`), a missing
    required startup file (`:1162`), or a startup error (`:1272`, `:1283`,
    `:1293`, `:1301`).
  - `operator_recovered` — only from later reconciliation,
    `reconcileNodeRuntimeTruth` (`:1587`, event at `:1724`).
- **RestoreRigResult** (`types.ts:444`) — the rig-level rollup, **4** values
  (`grep '^export type RestoreRigResult' packages/daemon/src/domain/types.ts | grep -o '"[^"]*"' | wc -l`):
  `fully_restored`, `partially_restored`, `failed`, `not_attempted`.
  `rollupRestoreRigResult` (`restore-orchestrator.ts:82`) produces only the
  first three; `not_attempted` is set when pre-restore validation fails
  (`:282`).
- **SnapshotData** (`types.ts:351`) — the serialized snapshot payload. It has
  **7** optional fields, kept optional so older snapshots still load
  (`sed -n '/^export interface SnapshotData/,/^}/p' packages/daemon/src/domain/types.ts | grep -c '?:'`):
  `activeSessionIdByNode?`, `activeOccupantsByNode?`, `topologyRoster?`,
  `pods?`, `continuityStates?`, `nodeStartupContext?`, `envReceipt?`.
- **NodeStartupSnapshot** (`types.ts:344`) — persisted restore replay input:
  classification-free projection entries, resolved startup files, startup
  actions, runtime.
- **PersistedProjectionEntry** (`types.ts:332`) — the classification-free
  restore replay seam: persists only entry identity + source metadata, NOT
  stale `classification`, `conflicts`, or `noOps` (Architecture Rule 10).
  Restore rebuilds each entry as `safe_projection` with empty `conflicts` and
  `noOps` (`restore-orchestrator.ts:1171`, `:1176`, `:1177`).

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
  `:670`, ordering only `delegates_to` and `spawned_by` edges, `:72`, among
  the roster's intended nodes, `:671`), and service boot gating before agent
  restore (`serviceOrchestrator.boot`, `:332`).
- `restore-preconditions.ts` — `validatePreRestore` (`:7`), the one
  pre-restore validation shared by restore and restore-check (§3, §5.1).
- `restore-topology.ts` — `resolveSnapshotRestoreTopology` (`:12`), which
  splits a snapshot's nodes into intended and excluded (§3).
- `restore-attempt-receipt.ts` — `deriveRestoreAttemptReceipt` (`:42`), the
  read-only per-attempt receipt (§4).
- `rehydrate-eligibility.ts` — `snapshotMatchesCurrentOccupants` (`:20`) and
  `assessCurrentStateRehydrateEligibility` (`:66`), shared by `routes/up.ts`
  and `routes/restore-check.ts`.
- `active-occupant.ts` — the shared rule for which snapshot session row is a
  node's occupant (`resolveActiveSnapshotSession`, `:74`).

## 3. Restore flow and restore honesty

Restore behavior, each point checked in `restore-orchestrator.ts`:

- Selects the snapshot with `selectRestoreUsable` even when a snapshot id is
  given (`:252–253`), so wrong-rig and unusable snapshots are refused before
  any mutation. The selection (`RestoreSnapshotSelection`, `types.ts:396`)
  records whether it was explicit or automatic, why, and any newer usable
  alternative; it is carried on the result and on `restore.started`.
- Restores only the nodes the snapshot's topology roster intends
  (`SnapshotData.topologyRoster`, `types.ts:370`). The roster comes from the
  latest `topology.roster_recorded` event (`snapshot-capture.ts:171`), from
  `rig snapshot <rigId> --intended-seats` (`packages/cli/src/commands/snapshot.ts:20`),
  or, for older snapshots, all current nodes. `resolveSnapshotRestoreTopology`
  (`restore-topology.ts:12`) reports every other node as excluded with reason
  `historical_not_in_intended_roster` (`:27`); the result carries
  `intendedRoster` and `excludedNodes` (`types.ts:440–441`).
- Resolves each node's occupant from the snapshot's recorded active-occupant
  maps, not by picking the newest session row
  (`resolveActiveSnapshotSession`, `active-occupant.ts:74`, called at
  `restore-orchestrator.ts:768` and `:965`). An ambiguous occupant fails the
  node loudly (`activeOccupantAmbiguityError`, `active-occupant.ts:97`).
- Consults live `continuity_state`; preserves state when a node is already
  `restoring` (`:778–792` — `SELECT status FROM continuity_state …` at
  `:781`; if `status === "restoring"` the node is skipped with a warning and
  reported as `fresh`, `:784–786`; `degraded` only adds a warning).
- Reuses the seat's durably bound tmux session name when the prior binding
  has a usable one (`:841`), and otherwise falls back to the derived name
  with a warning (`:870`).
- Replays restore-safe startup using persisted startup context;
  prefilters missing optional artifacts into warnings; **hard-fails a node if
  a required startup file is missing** (`:1162` — status `"failed"`, error
  "Missing required startup files: …"). Before any mutation,
  `validatePreRestore` (`restore-preconditions.ts:7`, called at
  `restore-orchestrator.ts:272`) already blocks the whole restore when a node
  that will consume replay is missing a required startup file
  (`required_startup_file_missing`, `restore-preconditions.ts:151`; outcome
  `pre_restore_validation_failed`, `restore-orchestrator.ts:292`). Its other
  blockers are `invalid_snapshot_data` (`restore-preconditions.ts:27`),
  `invalid_topology_roster` (`:78`), `checkpoint_missing_node_cwd` (`:91`),
  `startup_owner_root_missing` (`:139`), `service_rig_root_missing` (`:187`)
  and `service_compose_file_missing` (`:197`). The `/api/up` route returns
  that outcome as HTTP 409 with `status: "not_attempted"`
  (`routes/up.ts:161`). A node that resumes its exact native session replays
  no startup files, actions, guidance or skills (`replayContained`,
  `restore-orchestrator.ts:1108`); its saved Claude activity-hook selection
  is reapplied before native resume. A skipped hook reapply adds a warning
  without changing the restore outcome.
- Writes a **transcript boundary marker before re-launch**
  (`writeBoundaryMarker`, `:894`, called before `launchNode` at `:905`) when
  the transcript store is enabled.
- Refuses to restore over live sessions (`:260–263` — `rig_not_stopped`: "Rig …
  has live sessions. Stop the rig with 'rig down' before restoring, or use the
  latest auto-pre-down snapshot."). A tmux probe that fails also blocks it
  (`classifyRunningSessions`, `:606`).
- Checks that the harness actually resumed. The resume adapters judge the
  pane with `assessNativeResumeProbe` (`domain/native-resume-probe.ts:84`). A
  pod-aware resume counts as resumed only when startup reports `resumed`
  continuity or the launched session row carries the snapshot's resume type
  and token (`launchedSessionMatchesSnapshotResume`,
  `restore-orchestrator.ts:1384`); a reported `fresh` continuity without that
  proof rolls back to `awaiting-decision` (`:1222–1239`).
- Saves a `rig up --non-interruptive` or `--no-non-interruptive` choice on
  the rig only after the live-session check and pre-restore validation pass
  (`:302`); see [adapters-and-runtimes.md](adapters-and-runtimes.md) for the
  launch flags.

`launchNodeSubset` (`:393`) and `launchSingleNode` restore chosen seats rather
than the whole rig; unlike a full restore, a failed tmux probe there proceeds
with a `liveness_probe_unknown` warning (`:511`).

**Restore-honesty rules** (texts in `architecture-rules-and-event-system.md`;
cited here by number with the code that carries them):

- Rule 7 — `RESTORE_POLICY_LEVEL`
  (`packages/daemon/src/domain/profile-resolver.ts:105`) orders the three
  policies, and `resolveRestorePolicy` (`profile-resolver.ts:526`) rejects a
  profile or member value that broadens it.
- Rule 14 — the outcome set is `RestoreNodeResult.status` (`types.ts:475`,
  §1); `rebuilt` is set only when a checkpoint is written
  (`restore-orchestrator.ts:1091`).
- Rule 15 — in `restore-orchestrator.ts`, a `resume_if_possible` seat with a
  session but no token stops as `awaiting-decision` before launch unless
  `--fresh` names it (`:806–825`); a failed resume kills the blank session
  (`rollbackToZeroSession`, `:934`) and returns `awaiting-decision`
  (`:1049`); pod-aware resume passes
  `allowFreshFallback: !(isPodAware && resumeRequested)` (`:1218`). Fresh
  launch is explicit: `rig up --existing <rig> --fresh <seats...>`
  (`packages/cli/src/commands/up.ts:92`). On a terminal, `rig up` asks
  yes or no for each `awaiting-decision` seat and re-posts with the accepted
  seats as fresh (`up.ts:618`).
- Rule 16 — `rig down` prints the snapshot id and a restore command
  (`packages/cli/src/commands/down.ts:236–246`); `rig up` on an existing rig
  prints per-node statuses and the attach command
  (`packages/cli/src/commands/up.ts:583–616`).

(The full rule list lives in `architecture-rules-and-event-system.md`.)

## 4. Auto-snapshot and existing-rig power-on

- `rig down <rig>` (name or id, `packages/cli/src/commands/down.ts:104`)
  auto-captures an `auto-pre-down` snapshot before teardown when the rig has
  live sessions (`packages/daemon/src/domain/rig-teardown.ts:116`, capture
  at `:127`, after refreshing resume metadata at `:118`; an already-stopped
  rig returns at `:93–114` without one).
- `rig up <rig-name>`: a source with no `/` and no
  `.yaml`/`.yml`/`.rigbundle`/`.rigtopology` extension is a rig name
  (`packages/daemon/src/domain/up-command-router.ts:49–50`). The CLI refuses
  a name that matches only archived rigs, with `rig unarchive` guidance
  (`packages/cli/src/commands/up.ts:290`). It then checks the spec library
  unless `--existing` is given, and refuses a name that matches both
  (`up.ts:338–353`). The daemon finds the rig by name, preferring unarchived
  rigs (`packages/daemon/src/routes/up.ts:222–225`), and restores from
  `selectRestoreUsable` (`routes/up.ts:105`), which prefers the newest
  `auto-pre-down` or `auto-periodic` snapshot, then the newest other usable
  one (`snapshot-repository.ts:75`).
- `rig up <rig-name> --plan` is a read-only restore preview that never
  captures a snapshot (`routes/up.ts:126`).
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
- `rig restore status <attemptId> --rig <rigId>`
  (`packages/cli/src/commands/restore.ts:120`) reads
  `GET /api/rigs/:rigId/restore/status/:attemptId`
  (`packages/daemon/src/routes/snapshots.ts:76`). `deriveRestoreAttemptReceipt`
  (`restore-attempt-receipt.ts:42`) folds that attempt's events into a
  per-node view without writing anything.

### Single-seat recovery and handover

- **`rig seat continue <seat>`** — when a fresh launch stops at a native
  prompt before its startup context is delivered, the startup orchestrator
  fails it as `attention_required` and adds "run: rig seat continue
  <session>" (`startup-orchestrator.ts:600`). The command
  (`packages/cli/src/commands/seat.ts:632`) calls
  `POST /api/seat/continue/:seatRef` (`routes/seat.ts:293`), which runs
  `continueFreshStartup` (`seat-lifecycle-service.ts:395`): it re-checks the
  binding, pane and runtime, then delivers the pending context to the same
  conversation without relaunching. In a restore, a pod-aware seat in this
  state reports `attention_required` (`restore-orchestrator.ts:1259`). See
  [agent-spec-and-startup.md](agent-spec-and-startup.md) for the startup side.
- **Per-seat startup decision** — `POST /api/startup/:rigId/:logicalId`
  (`routes/startup.ts:142`) takes `resume`, `start`, `fresh` or `continue`
  for one seat. `resume` captures an eligibility-checked `auto-rehydrate`
  snapshot when none exists and goes through `launchSingleNode`.
- **Seat handover** — `rig seat handover <seat> --source
  fresh|rebuild|fork:<id>|discovered:<id> [--dry-run]`
  (`packages/cli/src/commands/seat.ts:363`) calls
  `POST /api/seat/handover/:seatRef` (`routes/seat.ts:94`), which runs
  `SeatHandoverService.handover` (`seat-handover-service.ts:267`).
  `SuccessorSessionLauncher` (`successor-session-launcher.ts:90`) respawns
  the same pane in place, so the session name stays the same. The fresh
  source delivers a daemon-built restore packet (`buildRestorePacket`,
  `seat-handover-service.ts:1146`), which is separate from the CLI
  `rig restore-packet` below. The rebuild source primes from the seat's
  durable chain (`buildRebuildPrimingChain`, `rebuild-priming-chain.ts:22`).

## 5. Daemon-side restore-check and CLI restore-packet

### 5.1 `rig restore-check` — readiness probe

`GET /api/restore-check?rig=<name>&noQueue=true&noHooks=true&compact=1&ready=1`
(`routes/restore-check.ts:218–219`). The route calls
`createRestoreCheckService` (`:150`), which assembles a framework-free
`RestoreCheckDeps` (`:154–214`) over existing daemon projections —
`listRigs` from `rigRepo` (`:173–176`), `getNodeInventory` (joining
`node_id` by `logical_id`, `:25–30`, `:177–183`), `getStartupContext` (reads
`node_startup_context`, parses `projection_entries_json` /
`resolved_files_json` / `startup_actions_json`, `:48–142`), `hasSnapshot`
/ `getLatestSnapshot` from `snapshotRepo` (`:187–193`), `getRestoreInputs`
(`:194–205`), `probeQueueStore` (`:156–168`), `getClaudeActivityHookEvents`
(`:169–172`), and `probeDaemonHealth` (self-evident: "We're inside the
daemon — if this route is responding, daemon is healthy", `:206–209`). It
then runs `service.check(...)` (`:229–230`).

`RestoreCheckService.check()` (`restore-check-service.ts:254`) layers:

1. **Host checks** — `checkDaemonReachable` (probe-throw → `verdict:
   unknown`, NOT `not_restorable`, `:265–275`), `checkStateDirWritable`
   (`:277`, impl `:493`), `checkHostInfraDeclaration` (`:278`, impl `:510`).
2. **Rig enumeration** — `listRigs()` throw → `buildUnknown` (`:281–290`);
   `--rig` filter; unknown rig → red `rig.<name>.exists` (`:292–300`).
3. **Per-rig checks** — `checkSnapshot` (`:306`, impl `:779`),
   `checkSpecPresent` (`:311`, impl `:1142`), and
   `rig.<name>.restore-preconditions` (`checkRestorePreconditions`, `:333`,
   impl `:417`). The last runs the same `validatePreRestore` that restore
   runs (`:441`) on the inputs from `getRestoreInputs`: red on a blocker,
   yellow on a warning, green otherwise. Without a usable snapshot it is
   yellow when current-state rehydrate is eligible and red when it isn't;
   when the inputs can't be read it is yellow and the rig's rollup becomes
   `unknown` (see Verdict). The rig-status route sets
   `recoveryOnly` (`routes/rigs.ts:272`), which skips this check when every
   seat is ready (`restore-check-service.ts:332`).
4. **Per-seat checks** — `checkSeatReadiness` (`:341`), `checkStartupContext`
   (`:355`, impl `:867`; `unknownChecks` → `buildUnknown`, `:356–361`),
   `checkTranscript` (`:377`), `checkResumePath` (`:381`), and unless opted
   out: the daemon SQLite `queue_items` availability probe `checkQueueStore`
   (`:385–389`, gated by `--no-queue`; impl `:988`) and `checkHooks`
   (`:390–394`, gated by `--no-hooks`; impl `:1011`). Queue continuity is
   represented by the shared daemon store; an empty queue is valid
   (`routes/restore-check.ts:158–161`). Claude hook readiness follows the
   persisted `claude_activity_hooks` runtime-resource selection
   (`restore-check-service.ts:1034–1041`) and the adapter's activity-relay
   projection in the seat CWD (`restore-check-service.ts:1052–1053`). A seat
   that deliberately omits that resource is not applicable. In compact mode
   without `ready=1`, a seat whose readiness check is green gets only the
   startup-context check (`restore-check-service.ts:353`, `:363–375`); that
   check still counts toward the verdict.
5. **Verdict** — `buildResult` (`:1186`) aggregates: any red →
   `not_restorable`; else any rig rollup with status `unknown` → `unknown`
   (`:1204–1205`); else any yellow → `restorable_with_caveats`; else
   `restorable` (`:1201–1210`). A rig rollup is `unknown` when its restore
   inputs could not be read (`:1530–1532`). A probe that can't be inspected
   at all also gives `unknown` (`buildUnknown`, `:1219`). Plus a
   `RecoveryPlan` (`buildRecovery`, `:1323`) and a `RepairStep[]` packet
   (`buildRepairPacket`, `:1562`; `null` when fully restorable, `:1563`).

The result shape is `RestoreCheckResult` (`restore-check-service.ts:147–159`):
`verdict`, `readiness`, `continuity`, `rigs[]`, `hostInfra`, `recovery`,
`counts {red,yellow,green}`, `classCounts`, `checks[]`, `repairPacket`. With
`compact=1` the route returns a reduced body (`routes/restore-check.ts:232–259`).

**Honest-error design:** a daemon-probe *exception* produces
`verdict: unknown` (uninspectable state), distinct from a daemon
definitely-down state which is `red` / `not_restorable`
(`restore-check-service.ts:265–275`, `checkDaemonReachable` `:471–491`). The
route's catch-all returns the same `unknown`-shaped body with HTTP 500 + a
`probe.error` red check (`routes/restore-check.ts:262–310`).
`CheckEntry.remediationSafe` defaults to `false` (conservative —
unclassified remediations are NOT auto-execution-safe,
`restore-check-service.ts:22–27`, applied at `:1577`).

CLI surface (`../cli-reference.md` `### restore-check`; options in
`packages/cli/src/commands/restore-check.ts:222–227`):
`rig restore-check [--rig <name>] [--full] [--ready] [--no-queue] [--no-hooks] [--json]`.
Output is compact unless `--full` (`:313`). Exit codes: `0` restorable (or
with caveats), `1` not restorable (red), `2` unknown / probe error
(`:214–217`). When the daemon is down, the CLI builds a local
`not_restorable` result and exits 1 (`:269`).

### 5.2 `rig restore-packet` — cross-runtime restore packet

CLI-side, no restore-packet daemon route. `commands/restore-packet.ts`
(**539** lines, `wc -l < packages/cli/src/commands/restore-packet.ts`)
implements **3** subcommands
(`grep -c 'cmd.command(' packages/cli/src/commands/restore-packet.ts`;
`../cli-reference.md` `### restore-packet`): `write [options]` (`:216`;
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
  restore-preconditions,restore-topology,restore-attempt-receipt,
  rehydrate-eligibility,snapshot-capture,snapshot-repository,checkpoint-store,
  active-occupant,restore-check-service}.ts`,
  `packages/daemon/src/routes/{restore-check,up,snapshots}.ts`,
  `packages/cli/src/commands/{restore-packet,restore-check,restore}.ts`.
