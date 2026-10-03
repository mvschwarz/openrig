---
kind: as-built
title: Architecture Invariants, Event System, Compatibility Notes
status: active
topics: [runtime-control, observability, doctrine]
domains: [engineering-advisor, operating-advisor, review]
applies-when: |
  Need the cross-cutting architecture invariants the codebase enforces (the
  25 architecture rules + startup/import constraints), the shape of the
  RigEvent union and its SSE delivery surfaces, or the intentional
  compatibility limits that still describe the shipped system.
siblings: [daemon-core.md, coordination-primitive.md]
prerequisite-reads: [../README.md, daemon-core.md]
last-verified-against-source: b6d37bfadcc189be8fd61e35abfc09676437bf48
last-updated: 2026-10-03
---

# Architecture Invariants, Event System, Compatibility Notes

This module collects the cross-cutting invariants that do not belong to any
single subsystem: the architecture rules the codebase holds itself to, the
event-system shape, and the intentional compatibility limits.

> Verified against source at main `b6d37bfadcc189be8fd61e35abfc09676437bf48`. Each count below sits beside the
> command that produces it; run the command from the repository root to refresh
> it.

## 1. Architecture rules

These are the invariants the codebase is built to preserve. Rule 6 (startup
layering) and rule 7 (restore-policy narrowing) are the spec/startup contract —
see `agent-spec-and-startup.md` for their flow detail; they are restated here as
system-level invariants.

1. No runtime Hono in `domain/` and `adapters/`. `adapters/` has none; `domain/`
   has type-only Hono imports (`import type`) in **3** files
   (`git grep -l 'from "hono' -- packages/daemon/src/domain packages/daemon/src/adapters | wc -l`).
2. Routes depend on the domain; the domain does not depend on routes at
   runtime. **1** type-only import crosses back:
   `domain/project-classifier.ts:1` imports `IdentityProvenance` from
   `routes/require-sender-identity.js`
   (`git grep -lE 'from "(\.\./)+routes/' -- packages/daemon/src/domain packages/daemon/src/adapters | wc -l`).
3. Shared DB-handle invariants are enforced at construction time.
4. The reboot is engine-first: domain services land before public-surface
   rewiring.
5. Runtime is member-authoritative in the pod-aware model.
6. Startup layering is additive and ordered: agent base → profile → rig
   culture file → rig startup → pod startup → member startup → operator debug
   append.
7. Restore-policy narrowing is one-way only: `resume_if_possible` →
   `relaunch_fresh` → `checkpoint_only`.
8. Base/import collisions warn; ambiguous import/import unqualified refs fail
   loudly.
9. Bundle assembly and startup-file resolution use containment checks rooted
   in the owning artifact.
10. Restore replay uses classification-free projection intent, not stale
    startup-time `no_op` / conflict classifications.
11. Startup status is explicit session state: `pending`, `ready`,
    `attention_required`, `failed` (`types.ts:100`).
12. Session recency depends on monotonic ULIDs: `session-registry.ts` uses
    `monotonicFactory()`. Restore does not pick the newest session by max
    ULID; it resolves the active occupant recorded in the snapshot
    (`resolveActiveSnapshotSession`, `active-occupant.ts:74`, called at
    `restore-orchestrator.ts:1171`).
13. Readiness checking is a retry loop with exponential backoff and
    configurable timeout, using adapter-specific probes (Claude TUI
    indicator, Codex ready message, terminal immediate).
14. Restore outcome states are a fixed set (`RestoreNodeResult.status`,
    `types.ts:476`): `resumed`, `rebuilt`, `fresh-primed`,
    `awaiting-decision`, `attention_required`, `failed`, plus
    `operator_recovered` (set only by later reconciliation) and `fresh`
    (retained only for the legacy continuity-restoring skip path). `rebuilt` =
    new process assembled from artifacts.
15. Restore honesty: a failed resume stops loudly as `awaiting-decision`, with
    the blank session rolled back and no session running
    (`restore-orchestrator.ts:1230`). No automatic fresh fallback. Fresh launch
    is explicit follow-up only (`rig up --fresh <logicalId>`,
    `packages/cli/src/commands/up.ts:85`).
16. Post-command handoff required on `up`, `down`, `restore`,
    `snapshot create`: what happened + current state + next action.
17. Session naming: `{pod}-{member}@{rig}` — human-authored,
    system-validated. No generation, no slugification.
18. Communication: tmux is transport, not truth. `send/capture/broadcast`
    wrap tmux reliably with honest errors.
19. Transcripts: bounded capture — a periodic `tmux capture-pane` snapshot of
    the trailing lines (default 1000, every 2 s) overwrites the transcript
    file, replacing pipe-pane (`transcript-rotation.ts:3`, `:27`–`28`; started
    at `node-launcher.ts:181`). ANSI strip on read. `rig ask` transcript
    search: `rg` preferred, `grep -E` fallback.
20. Config precedence: CLI flag > env var > config file
    (`~/.openrig/config.json`, or `$OPENRIG_HOME/config.json` when
    `OPENRIG_HOME` is set; `packages/cli/src/config-store.ts:915`) > default.
21. Semi-deterministic calibration: build what agents use constantly. Agent
    handles edge cases from error messages.
22. `rig ask` is context engineering: gathers evidence, does NOT call an
    external LLM. The agent IS the LLM. The exception is the explicit `--wake`
    flag (`packages/cli/src/commands/ask.ts:88`), which runs one headless
    question against an existing agent session (`codex exec resume` or
    `claude -p --resume`, `packages/cli/src/ask-wake.ts:58`–`60`).
23. Spec library truth is YAML on disk; daemon owns the structured
    review/index/cache layer.
24. Adopted-session parity is tmux-metadata parity, not fake env-var parity.
25. Human-readable IDs are UI-only presentation helpers. CLI/API/MCP/backend
    keep full canonical ids.

### Startup action constraints

- No shell startup actions.
- Action types are `slash_command`, `send_text` and `startup_proof` only
  (`startup-validation.ts:7`).
- Non-idempotent actions must not apply on restore.
- Retrying failed startup is handled as restore.

### Remote import constraints

The reboot supports `local:...` and `path:/abs/...` agent refs. Remote
`agent_ref` sources remain unsupported and fail in preflight (schema
validation, `rigspec-schema.ts:550`; restated in compat note 1).

## 2. Event system

The daemon's event surface is the single `RigEvent` discriminated union.

`RigEvent` is declared at `packages/daemon/src/domain/types.ts:106`
(`export type RigEvent =`) and runs through `types.ts:314`. It has **99 union
members** declaring **100** `type` literals: one member (`types.ts:107`) carries
both `proof.judged` and `proof.sources_changed`.

- Members:
  `sed -n '/^export type RigEvent =/,/^export type PersistedEvent/p' packages/daemon/src/domain/types.ts | grep -c 'type: "'`
- Type literals:
  `sed -n '/^export type RigEvent =/,/^export type PersistedEvent/p' packages/daemon/src/domain/types.ts | grep -oE '"[a-z_]+(\.[a-z_]+)+"' | sort -u | wc -l`

**96** of the 99 literals appear as a `type: "<x>"` literal somewhere in
`packages/daemon/src` outside `types.ts` (mostly in `domain/` and `routes/`;
`seat.model_divergence` is built in `startup.ts`). **3** are declared but never
constructed: `session.status_changed`, `continuity.sync`, and `continuity.degraded`
(per #490, `qitem.closure_overdue` is produced by `QueueRepository.recordClosureOverdue`
when swept by `queue-stuck-sweep`, and `mission_control.view_refreshed` was retired).
List them with:

`for t in $(sed -n '/^export type RigEvent =/,/^export type PersistedEvent/p' packages/daemon/src/domain/types.ts | grep -oE '"[a-z_]+(\.[a-z_]+)+"' | tr -d '"'); do git grep -q -F "type: \"$t\"" -- packages/daemon/src ':!packages/daemon/src/domain/types.ts' || echo "$t"; done`

### Per-prefix event families

Each count below is the number of `type` literals per prefix in the union body
(`types.ts:106`–`311`):
`sed -n '/^export type RigEvent =/,/^export type PersistedEvent/p' packages/daemon/src/domain/types.ts | grep -oE '"[a-z_]+(\.[a-z_]+)+"' | tr -d '"' | cut -d. -f1 | sort | uniq -c | sort -rn`.

| Prefix | Types | Sample / role |
|---|---|---|
| `node.*` | 15 | `node.added` (`types.ts:124`) … `node.startup_proof_rejected` (`:227`) — lifecycle/startup |
| `workflow.*` | 8 | workflow runtime (detail in `workflow-runtime.md`) |
| `session.*` | 8 | session discovery / status / detach / vanish / stop / clean / resume-token audit |
| `rig.*` | 7 | `rig.created` / `rig.deleted` / `rig.imported` / `rig.stopped` / `rig.archived` / `rig.unarchived` / `rig.expanded` (`:239`) |
| `watchdog.*` | 5 | `watchdog.evaluation_fired` (`:278`) … `watchdog.job_stopped` (`:282`) |
| `seat.*` | 5 | `seat.model_divergence` (`:113`) … `seat.handover_completed` (`:198`) — model divergence, fresh launch, attention clear, handover |
| `queue.*` | 5 | queue lifecycle (`:247`–`:250`, `:260`; detail in `coordination-primitive.md`) |
| `package.*` | 5 | legacy package/install engine events |
| `mission_control.*` | 4 | audit/notification (`:306`–`:311`; detail in `mission-control.md`) |
| `bootstrap.*` | 5 | legacy bootstrap-run events |
| `restore.*` | 4 | restore start/complete/subset-complete/reconcile (detail in `lifecycle-snapshot-restore.md`) |
| `classifier.*` | 4 | classifier-lease lifecycle |
| `qitem.*` | 2 | `qitem.fallback_routed` (`:251`), `qitem.closure_overdue` (`:252`) |
| `proof.*` | 2 | `proof.judged`, `proof.sources_changed` — one union member (`:107`) |
| `pod.*` | 2 | `pod.created` (`:213`), `pod.deleted` (`:214`) |
| `inbox.*` | 2 | `inbox.absorbed` (`:253`), `inbox.denied` (`:254`) |
| `continuity.*` | 2 | `continuity.sync` (`:228`), `continuity.degraded` (`:229`) |
| `agent.*` | 2 | `agent.activity` (`:149`), `agent.session_identity` (`:156`) |
| singletons | 12 | one type each: `workflow_spec.*`, `view.*`, `transport.*` (`:153`), `topology.*` (`:136`), `stream.*` (`:243`), `snapshot.*`, `project.*`, `kernel.*`, `event.*` (`:108`), `chat.*` (`:237`), `bundle.*`, `binding.*` |

Family counts sum to 99 type literals (18 multi-type families totalling 87 +
12 singletons).

### Emission and delivery

Events are emitted via `eventBus.emit({ type: ... })` (`event-bus.ts:57`) or,
inside a caller-managed transaction, `eventBus.persistWithinTransaction(...)`
(`event-bus.ts:70`) with subscribers notified after commit — across domain
services (`stream-store.ts`, `workflow-runtime.ts`, `restore-orchestrator.ts`,
`node-launcher.ts`, etc.) and route handlers. The event log is append-only and
SQLite-backed.

SSE delivery surfaces include the following. The daemon has **11**
`streamSSE(` call sites across **10** files in `packages/daemon/src/routes/`
(`git grep -o 'streamSSE(' -- packages/daemon/src/routes | wc -l`;
`git grep -l 'streamSSE(' -- packages/daemon/src/routes | wc -l`).

- `GET /api/events` — global stream of all events (`server.ts:731`
  `app.route("/api/events", eventsRoute)`).
- `GET /api/stream/watch` — new stream items (`routes/stream.ts:194`).
- `GET /api/queue/watch` — queue/inbox coordination events
  (`routes/queue.ts:994`).
- The chat SSE stream `GET /api/rigs/:rigId/chat/watch` delivers
  `chat.message` for one rig (`routes/chat.ts:68`, mounted at `server.ts:783`;
  rig-scoped; see compat note 6).

## 3. Remaining compatibility notes

Intentional limits that still describe the shipped system:

1. Remote `agent_ref` imports remain unsupported (see §1 remote import
   constraints).
2. Startup actions remain intentionally constrained (`slash_command`,
   `send_text`, `startup_proof`).
3. Legacy compatibility seams still ship for pre-reboot data and v1
   artifacts.
4. `rig ask` gathers context only — does not call an external LLM — unless
   `--wake` is passed (rule 22).
5. `rig ask` transcript search prefers `rg`, falls back to `grep -E`
   (`history-query.ts:252`, `:267`); quality/perf varies by backend.
6. Chat is rig-scoped only — no cross-rig channels or DMs.
7. `--verify` on `rig send` checks pane content for message visibility, not
   agent acknowledgement: it compares occurrences of the message's first 40
   characters before and after the send (`session-transport.ts:1413`–`1415`).
8. Terminal node readiness is shell-ready only — no service health probes.
9. Managed-app service surfaces are descriptive only — OpenRig does not
   auto-inject service URLs/tokens into agent prompts beyond authored
   startup/context files.
10. Specialist delegation is conventional, not automatic — addressed by
    session name or normal communication surfaces.

## 4. Cross-references

Under the modular as-built, this module owns the invariants and event shape;
`../codemap.md` is the navigation index for file-by-file structure.

## See also

- `daemon-core.md` — wiring, DB, migrations, startup.
- `coordination-primitive.md` — queue/stream/inbox/outbox events.
- `workflow-runtime.md` — `workflow.*` events.
- `mission-control.md` — `mission_control.*` events.
- Source roots: `packages/daemon/src/domain/types.ts` (RigEvent union),
  `packages/daemon/src/domain/event-bus.ts` (emit/persist),
  `packages/daemon/src/routes/{stream,queue}.ts` (SSE watch),
  `packages/daemon/src/server.ts` (`/api/events`).
