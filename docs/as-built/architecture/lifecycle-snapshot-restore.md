---
kind: as-built
title: Lifecycle — Snapshot, Restore, Continuity
status: active
topics: [continuity, runtime-control]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Need to know how OpenRig captures a snapshot, restores a rig (resume vs
  rebuild vs fresh), enforces restore honesty, consults live continuity state,
  or how the daemon-side restore-check / restore-packet readiness probes work.
siblings: [daemon-core.md, agent-spec-and-startup.md, transport-and-transcripts.md]
prerequisite-reads: [../README.md, agent-spec-and-startup.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# Lifecycle — Snapshot, Restore, Continuity

The durable-state half of the core product loop:
`down (auto-snapshot) → up <rig-name> (auto-restore) → handoff`. Snapshot
captures serialized rig state; restore replays it honestly (no silent
fresh-fallback); restore-check is a separate read-only readiness probe.

> Verified against source at HEAD `7eaf524c` (`git describe` →
> `v0.3.1-6-g7eaf524c`). Package version **0.3.1** (slice-00 §1.1). Source
> located by `architecture.md` headings (§4 Execution and restore, §5
> Snapshot/restore/continuity, §6 Snapshot/restore + Auto-snapshot, §7 rules)
> per slice-08 §10.1 — line numbers advisory only. This module is a pure
> split EXCEPT §6 (restore-check/restore-packet) which is the D15
> author-from-source piece — flagged explicitly there.

## 1. Snapshot / restore / continuity types

(`architecture.md` §4 "Execution and restore" — spec/projection members live
in `agent-spec-and-startup.md`; the snapshot/restore members live here)

- **NodeRestoreOutcome** — `"resumed" | "rebuilt" | "fresh" | "failed" |
  "n-a"` — the locked restore vocabulary. Re-confirmed at source:
  `restore-orchestrator.ts:725-726` sets `baseStatus = "resumed"` on a
  resumed harness; `:763` sets `"rebuilt"` when a checkpoint is replayed; the
  outcome union appears at `:944` (`{ kind: "resumed" }` … ).
- **SnapshotData** — current serialized snapshot payload. Reboot extensions
  are optional for older-snapshot compatibility: `pods?`,
  `continuityStates?`, `nodeStartupContext?`.
- **NodeStartupSnapshot** — persisted restore replay input:
  classification-free projection entries, resolved startup files, startup
  actions, runtime.
- **PersistedProjectionEntry** — the classification-free restore replay seam:
  persists only entry identity + source metadata, NOT stale `classification`,
  `conflicts`, or `noOps` (Architecture Rule 10).

## 2. Snapshot, restore, continuity domain services

(`architecture.md` §5 "Snapshot, restore, and continuity")

- `checkpoint-store.ts` — checkpoint persistence with pod/continuity context.
- `snapshot-capture.ts` — captures pods, continuity state, startup replay
  context, and latest env receipt. Re-confirmed: `snapshot-capture.ts:66-77`
  pulls `pods`, `continuity_state`, and `node_startup_context` rows per rig.
- `snapshot-repository.ts` — snapshot CRUD.
- `restore-orchestrator.ts` — resume, checkpoint delivery, startup replay,
  live continuity consultation, topology ordering, and RigEnv boot gating
  before agent restore.

## 3. Restore flow and restore honesty

(`architecture.md` §6 "Snapshot / restore" + §7 rules 7/14/15/16)

Restore behavior, each point re-confirmed at `restore-orchestrator.ts`:

- Reads the newest session by **monotonic ULID**, not timestamp alone
  (`:700` — "Find the NEWEST session for this node. ULIDs are monotonic, so
  latest = max id").
- Consults live `continuity_state`; preserves state when a node is already
  `restoring` (`:611-615` — `SELECT status FROM continuity_state …`; if
  `status === "restoring"` the node is skipped with a warning).
- Replays restore-safe startup using persisted startup context;
  prefilters missing optional artifacts into warnings; **hard-fails a node if
  a required startup file is missing** (`:799` — status `"failed"`, error
  "Missing required startup files: …").
- Writes a **transcript boundary marker before re-launch** (`:652` — "Write
  transcript boundary marker BEFORE launch (before pipe-pane attaches)").
- Refuses to restore over live sessions (`:168` — `rig_not_stopped`: "Rig …
  has live sessions. Stop the rig with 'rig down' before restoring").
- Uses `nativeResumeProbe` to honestly assess whether the harness actually
  resumed (`:857` continuity-outcome reconciliation).

**Restore-honesty rules (carried verbatim, `architecture.md` §7):**

- Rule 7 — restore-policy narrowing is one-way only:
  `resume_if_possible` → `relaunch_fresh` → `checkpoint_only`.
- Rule 14 — resume states are locked: `resumed` / `rebuilt` / `fresh`.
  `rebuilt` = new process assembled from artifacts.
- Rule 15 — failed resume is FAILED loudly. No automatic fresh fallback.
  Fresh launch is explicit follow-up only.
- Rule 16 — post-command handoff required on `up`, `down`, `restore`,
  `snapshot create`: what happened + current state + next action.

(The full 25-rule list lives in `architecture-rules-and-event-system.md`.)

## 4. Auto-snapshot and existing-rig power-on

(`architecture.md` §6 "Auto-snapshot and existing-rig power-on")

- `rig down <rigId>` auto-captures an `auto-pre-down` snapshot before
  teardown.
- `rig up <rig-name>` (no file extension) searches for an existing rig by
  name and restores from the latest `auto-pre-down` snapshot.
- If no snapshot: error with guidance ("No saved snapshot for rig 'X'. Boot
  from a spec or bundle path.").
- Post-command handoff: `down` output includes snapshot ID + restore command;
  `up` output includes node statuses + attach command.

## 5. Daemon-side restore-check / restore-packet — AUTHORED FROM SOURCE (D15)

> **D15 author bit (flagged per slice-08 §4.7 binding):** `restore-check` and
> `restore-packet` have NO `architecture.md` narrative. This section is the
> one author-from-source piece in this otherwise pure-split module — authored
> at the slice-00 forensic bar from `routes/restore-check.ts` +
> `domain/restore-check-service.ts` + `commands/restore-packet.ts`, file:line
> cited, version-attribution forensically checked.
>
> **Version attribution (forensic):** restore-check is NOT a 0.3.1 feature.
> `routes/restore-check.ts` first-created `277e279c` ("feat: native rig
> restore-check command", 2026-04-23, pre-0.3.0); present at both `v0.3.0`
> and `v0.3.1` git trees (`git ls-tree` confirmed). `restore-packet`
> first-created `23f2921e` ("Restore-Packet vertical M2a", 2026-05-01),
> likewise present at v0.3.0 and v0.3.1. The gap is missing
> architecture.md *prose*, not a version-attribution drift.

### 5.1 `rig restore-check` — readiness probe

`GET /api/restore-check?rig=<name>&noQueue=<bool>&noHooks=<bool>`
(`routes/restore-check.ts:131`). The route assembles a framework-free
`RestoreCheckDeps` (`:138-168`) over existing daemon projections —
`listRigs` from `rigRepo`, `getNodeInventory` (joining `node_id` by
`logical_id`, `:21-26,143-149`), `getStartupContext` (reads
`node_startup_context`, parses `projection_entries_json` /
`resolved_files_json` / `startup_actions_json`, `:44-128`), `hasSnapshot`
/ `getLatestSnapshot` from `snapshotRepo`, and `probeDaemonHealth`
(self-evident: "We're inside the daemon — if this route is responding,
daemon is healthy", `:160-163`). It then runs
`new RestoreCheckService(deps).check(...)` (`:170-171`).

`RestoreCheckService.check()` (`restore-check-service.ts:244`) layers:

1. **Host checks** — `checkDaemonReachable` (probe-throw → `verdict:
   unknown`, NOT `not_restorable`, `:252-259`), `checkStateDirWritable`
   (`:261`), `checkHostInfraDeclaration` (`:262`, impl `:406`).
2. **Rig enumeration** — `listRigs()` throw → `buildUnknown` (`:267-274`);
   `--rig` filter; unknown rig → red `rig.<name>.exists` (`:276-284`).
3. **Per-rig checks** — `checkSnapshot` (`:290`, impl `:675`),
   `checkSpecPresent` (`:295`).
4. **Per-seat checks** — `checkSeatReadiness` (`:311`), `checkStartupContext`
   (`:315`, impl `:763`; `unknownChecks` → `buildUnknown`),
   `checkTranscript` (`:325`), `checkResumePath` (`:329`), and unless opted
   out: `checkQueueFile` (`:334`, gated by `--no-queue`, impl `:870`) and
   `checkHooks` (`:339`, gated by `--no-hooks`, impl `:896`).
5. **Verdict** — `buildResult` aggregates: any red → `not_restorable`; any
   yellow → `restorable_with_caveats`; else `restorable`; probe-uninspectable
   → `unknown` (`:1074-1085`, `:1362-1379`). Plus a `RecoveryPlan`
   (`buildRecovery`, `:1186`) and a `RepairStep[]` packet
   (`buildRepairPacket`, `:1392`; `null` when fully restorable).

The result shape is `RestoreCheckResult` (`restore-check-service.ts:120-130`):
`verdict`, `readiness`, `continuity`, `rigs[]`, `hostInfra`, `recovery`,
`counts {red,yellow,green}`, `checks[]`, `repairPacket`.

**Honest-error design (slice-00 bar):** a daemon-probe *exception* produces
`verdict: unknown` (uninspectable state), distinct from a daemon
definitely-down state which is `red` / `not_restorable`
(`restore-check-service.ts:249-259`). The route's catch-all returns the same
`unknown`-shaped body with HTTP 500 + a `probe.error` red check
(`routes/restore-check.ts:174-222`). `CheckEntry.remediationSafe` defaults to
`false` (conservative — unclassified remediations are NOT
auto-execution-safe, `restore-check-service.ts:18-24`).

CLI surface (`cli-reference.md` `### rig restore-check`):
`rig restore-check [--rig <name>] [--no-queue] [--no-hooks] [--json]`. Exit
codes: `0` restorable (or with caveats), `1` not restorable (red), `2`
unknown / probe error.

### 5.2 `rig restore-packet` — cross-runtime restore packet

CLI-side, no daemon route. `commands/restore-packet.ts` (528 lines)
implements three subcommands (`cli-reference.md` `### rig restore-packet`):
`write [options]` (generate a packet directory from a source session or JSONL
file, with `omitted-records` accounting), `read <packet-dir> [--json]`
(render contents; non-mutating), `validate <packet-dir> [--json]` (validate
against the v0 schema; non-mutating). Packet shape is the cross-runtime v0
standard — Claude Code and Codex transcripts both supported via runtime
parsers + redaction.

## OPEN / carried items

- **D15 (author-from-source, completed):** restore-check / restore-packet
  authored from source above; flagged as the single author bit in this
  module. Version attribution forensically resolved (both pre-0.3.0; the gap
  was missing prose, not drift).
- No slice-00 numeric drift applies to this module's split content (the
  footprint/migration/route counts land in `daemon-core.md`).

## See also

- `agent-spec-and-startup.md` — StartupOrchestrator persists the replay
  context that restore consumes.
- `daemon-core.md` — `/api/restore-check` is one of the 49 route mounts
  (`server.ts:513`).
- `transport-and-transcripts.md` — transcript boundary markers written on
  restore.
- Source roots: `packages/daemon/src/domain/{restore-orchestrator,
  snapshot-capture,snapshot-repository,checkpoint-store,
  restore-check-service}.ts`, `packages/daemon/src/routes/restore-check.ts`,
  `packages/cli/src/commands/restore-packet.ts`.
