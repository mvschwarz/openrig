---
kind: as-built
title: Workflow Runtime + Watchdog Policies (PL-004 Phase C/D)
status: active
topics: [coordination, runtime-control]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Need to know how the daemon-native Workflow Runtime works — workflow specs
  cache, instance state, step trails, the transactional-scribe projection
  contract, or the watchdog policy set including workflow-keepalive.
siblings: [coordination-primitive.md, mission-control.md]
prerequisite-reads: [../README.md, coordination-primitive.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# Workflow Runtime + Watchdog Policies (PL-004 Phase C/D)

The daemon-native Workflow Runtime (PL-004 Phase D) turns an intended
sequence of work into durable SQLite state: declarative workflow specs, live
instance state, append-only step trails, and the load-bearing
transactional-scribe contract. The PRD §L4 operating model is
owner-as-author semantically plus workflow-as-transactional-scribe
mechanically (`architecture.md` §3 L398).

> Verified against source at HEAD `7eaf524c`.

## 1. The three Phase D tables (+ the diagnostic addition)

Re-confirmed at HEAD in `packages/daemon/src/db/migrations/`:

- **`workflow_specs`** (`033_workflow_specs.ts:33` `CREATE TABLE … workflow_specs`)
  — a read-through cache of human-authored markdown/YAML spec files. Sources
  are workspace-surface; the daemon caches by `(name, version)` with a
  content `source_hash` so valid operator edits to the spec file win at next
  read (workspace-surface reconciliation). Spec authoring stays
  markdown-authoritative; the cache exists for fast lookup and runtime
  resolution (`architecture.md` §3 L400).
- **`workflow_instances`** (`034_workflow_instances.ts:45` `CREATE TABLE …
  workflow_instances`) — live state per running workflow: `status`
  (`active|waiting|completed|failed`), `current_frontier_json` (active qitem
  ids), `hop_count` (loop-guard counter), `last_continuation_decision_json`.
  Instances survive daemon restart from SQLite — no filesystem
  reconciliation (`architecture.md` §3 L402).
- **`workflow_step_trails`** (`035_workflow_step_trails.ts:32` `CREATE TABLE …
  workflow_step_trails`) — append-only history of meaningful step
  transitions. Every closure produces one trail row pairing the prior qitem
  with the next qitem (null on terminal). `WorkflowStepTrailLog.record()` is
  the only writer (`architecture.md` §3 L404).
- **`040_workflow_specs_diagnostic.ts`** — slice-11 (`f68f453a`,
  slice-00 §1.3 provenance). An `ALTER TABLE ADD COLUMN` adding
  parser/validator diagnostic columns to `workflow_specs` (**no new table,
  no constraint changes beyond a DEFAULT**; the cache carries the
  parse/validation diagnostic for the UI to render — `040_..._diagnostic.ts:5–25`).
  **This migration is net-new since `architecture.md` was last edited** and
  is not described in any prior as-built doc (slice-00 §1.3 — `f68f453a`
  postdates the §3 body) — authored here from source per the slice-08
  drift-to-fix register.

`036_watchdog_policy_enum_extension.ts` is a documenting no-op that records
the Phase D watchdog enum extension (Phase C uses application-layer
enforcement via the `PHASE_D_POLICIES` array, so no DDL is needed —
`architecture.md` §3 L363).

## 2. The transactional-scribe contract

The load-bearing Phase D guarantee is implemented in
`WorkflowProjector.project()` (`packages/daemon/src/domain/workflow-projector.ts`).
Re-confirmed at HEAD: the projector header (`workflow-projector.ts:1–20`)
declares "transactional-scribe contract" and `project()` runs a single
`db.transaction` (`workflow-projector.ts:184` `const txn = this.db.transaction(...)`).
Inside that one transaction:

1. Close the current packet (state mutation on `queue_items`).
2. Create the next-step packet (`QueueRepository.createWithinTransaction()`,
   `workflow-projector.ts:230`).
3. Record the trail entry.
4. Update the instance frontier + status.
5. Persist workflow events.

Either everything commits or everything rolls back; lost handoffs are
impossible by design. Post-commit, subscribers are notified and the next
owner is nudged (`architecture.md` §3 L406).

`WorkflowRuntime` (`packages/daemon/src/domain/workflow-runtime.ts:61`
`export class WorkflowRuntime`) is the orchestration class above the
projector.

**Phase D scope boundary** (`architecture.md` §3 L412): excludes multi-hop
chaining, gate-return-sweep, and the closure-enforcement path. The daemon's
transactional state remains the closure authority via Phase A's hot-potato
strict-rejection (see `coordination-primitive.md` §3); the workflow runtime
**projects on closure, it does not gate closure**.

## 3. The workflow-keepalive watchdog policy

`workflow-keepalive` is the Phase C-deferred watchdog policy, a TypeScript
port of the POC `lib/policies/workflow-keepalive.mjs` adapted to read SQLite
(`packages/daemon/src/domain/policies/workflow-keepalive.ts:1–5`).
Re-confirmed at HEAD (`workflow-keepalive.ts:5–16`):

- **LOAD-BEARING:** it MUST read `workflow_instances` directly via SQLite —
  never the markdown source.
- Eligibility: `status === "active" || status === "waiting"`. Else
  `action=terminal, reason="workflow_not_active"`.
- Frontier empty + no fallback target: skip with `reason="empty_frontier"`.
- Resolves frontier qitem owners by querying `queue_items`; combines with
  explicit observer/created-by targets; sends to the first resolved target.

The watchdog supervision tree itself (PL-004 Phase C, `031_watchdog_jobs.ts` /
`032_watchdog_history.ts`) records only meaningful evaluations; quiet skip
reasons (`not_due`, `no_actionable_artifacts`, `active_wake_not_due`) are
NOT recorded and do NOT emit `watchdog.*` events — POC parity so agents are
not woken about scheduler polls (`architecture.md` §3 L362). The Phase D
policy enum extends Phase C's three values with `workflow-keepalive`.

## 4. Workflow events

> Drift-fix D8 / OPEN-4 (carried verbatim, slice-00): `architecture.md` §3
> L410 says "Existing 20 PL-004 events are unchanged" — internally
> inconsistent with L394's "32 PL-004 events untouched". **Do NOT carry
> either number.** The current `RigEvent` union
> (`packages/daemon/src/domain/types.ts:94`) has **73 members** total
> (slice-00 §1.8, re-confirmed at HEAD). The additive Phase D `workflow.*`
> events are described below WITHOUT asserting a contested PL-004 sub-count.

Phase D extends `RigEvent` with the additive `workflow.*` events
(re-confirmed `domain/types.ts:196–201`): `workflow.instantiated`,
`workflow.step_closed`, `workflow.next_qitem_projected`,
`workflow.completed`, `workflow.failed`, `workflow.routing_table_changed`
(6 members; a separate `workflow_spec` event also exists in the union).

## 5. Route surface

`/api/workflow` (`server.ts:495`) — `POST /validate`
(`routes/workflow.ts:82`), `POST /instantiate` (`:93`,
`getRuntime(c).instantiate(...)`), `POST /project` (`:118`,
`getRuntime(c).project(...)` — the transactional-scribe entry),
`GET /:instance_id/trace` (instance + trail), `POST /:instance_id/continue`
(idempotent inspect). Surface enumerated `routes/workflow.ts:21–28`.
Cross-ref: the `rig workflow` CLI surface — see `../cli-reference.md`.

## See also

- `coordination-primitive.md` — PL-004 Phase A; the closure authority the
  runtime projects against.
- `mission-control.md` — PL-005 queue observability + 7-verb contract.
- Source roots: `packages/daemon/src/domain/{workflow-projector,
  workflow-runtime,workflow-instance-store,workflow-spec-cache,
  workflow-step-trail-log,workflow-validator}.ts`,
  `packages/daemon/src/domain/policies/workflow-keepalive.ts`,
  `packages/daemon/src/routes/workflow.ts`.
