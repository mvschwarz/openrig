---
kind: as-built
title: Workflow Runtime — Specs, Packets, and Lifecycle Graphs
status: active
topics: [orchestration, coordination]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Following workflow validation, instantiation, projection, routing, failure
  recovery, lifecycle graph revisions, or the corresponding CLI/API.
last-verified-against-source: 712a61fbcc5ffe5a7c786fea12132567083ab507
last-updated: 2026-10-02
---

# Workflow Runtime — Specs, Packets, and Lifecycle Graphs

Source snapshot: `712a61fbcc5ffe5a7c786fea12132567083ab507`. This describes the source at that commit;
it does not establish the version or behavior of a running daemon.

A workflow binds a specification to durable queue packets. The daemon
records the instance, its current frontier, and the step trail; agents supply
step outcomes and evidence. Serial workflows and dependency graphs share
this runtime. The engine checks declared fields and recorded state; it does
not judge the substance of a referenced proof document.

## Source map

All paths in this table are under `packages/daemon/src/`.

| File / symbol | Responsibility |
|---|---|
| [`domain/workflow-types.ts`](../../../packages/daemon/src/domain/workflow-types.ts) | Spec, instance, trail, frontier, and failure-occurrence contracts. |
| [`WorkflowSpecCache`](../../../packages/daemon/src/domain/workflow-spec-cache.ts) | YAML parsing, source-hash cache, stored specs, diagnostics and retention. |
| [`WorkflowValidator`](../../../packages/daemon/src/domain/workflow-validator.ts) | Roles, exits, routing/dependency edges, pins, cycles, and advisories. |
| [`WorkflowRuntime`](../../../packages/daemon/src/domain/workflow-runtime.ts) | Instantiation, inspection, routing, resume, abort, and lifecycle facade. |
| [`WorkflowProjector`](../../../packages/daemon/src/domain/workflow-projector.ts) | Close the current step and update its successor/frontier state. |
| [`WorkflowInstanceStore`](../../../packages/daemon/src/domain/workflow-instance-store.ts) | Instances, guarded updates, frontier bindings, and failure occurrences. |
| [`WorkflowStepTrailLog`](../../../packages/daemon/src/domain/workflow-step-trail-log.ts) | Append/read step history. |
| [`workflow-reconciliation.ts`](../../../packages/daemon/src/domain/workflow-reconciliation.ts) | Inspect graph changes, apply explicit revisions, recover operation receipts. |
| [`workflow-keepalive.ts`](../../../packages/daemon/src/domain/policies/workflow-keepalive.ts) | Watchdog evaluation and reminders. |

## Specification and cache

`parseWorkflowSpec` parses the `workflow` document and checks known key sets.
`WorkflowValidator.validate` then checks relationships between roles, steps,
exits, and targets. The exits are `handoff`, `waiting`, `done`, and `failed`.
An exit-specific `next_hop.on` mapping takes precedence over structural
routing; without a mapping, `resolveNextStep` considers `forbid`, suggested
roles, `require`, and then the next array element.

The language includes `harness`, `host`, singular `gate`, `depends_on`, typed
`acceptance`, and waiting re-presentation settings. At this pin,
`WORKFLOW_AGENT_HARNESSES` contains only `claude-code` and `codex`; support for
another runtime elsewhere in OpenRig does not add it to this pin's workflow
harness grammar. Nonlocal host pins can validate as registered names but
`instantiate` still rejects execution with `host_pin_remote_unsupported`.
This is a workflow-step restriction, not a claim that all queue traffic is
local-only.

`allowed_exits` and `max_hops` affect validation/projection. In contrast,
`continuation_required`, `preserve_lineage`, `closure_required`, closure
messages, `skill_refs`, and `spawn_budget` produce
`declared_not_enforced_v1` advisories. Legacy `gates: []` and
`next_hop.mode: prefer` are rejected by the parser rather than silently
accepted. Prerequisite cycles are rejected; a routing cycle requires a
`max_hops` declaration and is distinct from a prerequisite cycle.

`WorkflowSpecCache.readThrough` parses the source file, hashes it, and
updates the `(name, version)` cache row. Full `spec_json` preserves fields
that the older scalar columns cannot represent. A same-name/same-version
source edit can update that cache row; the version label alone is not an
immutable content pin. `getByNameVersion` is the runtime lookup.
Diagnostic-only rows, moved sources, and versions retained for unfinished
work have separate paths in `readThrough`, `writeDiagnostic`, and
`isPinnedByUnfinishedWork`.

## Durable state

The migration files record the storage evolution; they are not a count of
all database migrations:

| Migration | Workflow state introduced |
|---|---|
| [`033`](../../../packages/daemon/src/db/migrations/033_workflow_specs.ts), [`034`](../../../packages/daemon/src/db/migrations/034_workflow_instances.ts), [`035`](../../../packages/daemon/src/db/migrations/035_workflow_step_trails.ts) | Spec cache, instances/frontier/current step, and append-only trail API. |
| [`040`](../../../packages/daemon/src/db/migrations/040_workflow_specs_diagnostic.ts), [`050`](../../../packages/daemon/src/db/migrations/050_workflow_spec_json.ts) | Cache diagnostics and complete parsed spec JSON. |
| [`049`](../../../packages/daemon/src/db/migrations/049_workflow_instance_version.ts), [`051`](../../../packages/daemon/src/db/migrations/051_workflow_resume.ts), [`052`](../../../packages/daemon/src/db/migrations/052_workflow_instance_bound_rig.ts) | Optimistic version guard, resume/hop baseline, and bound rig. |
| [`079`](../../../packages/daemon/src/db/migrations/079_workflow_lifecycle_parallel.ts) | Lifecycle operation key/digest/binding, packet-to-step frontier bindings, and failure occurrences. |

Current instance states include `active`, `waiting`, `completed`, `failed`,
and `aborted`. A multi-packet frontier needs packet-to-step bindings; a
single `current_step_id` cannot describe all parallel work.

## Instantiation and owner selection

`WorkflowRuntime.instantiate` resolves a cached spec name or explicit path,
validates it, resolves the rig and entry owners, then creates the instance
and entry packets through the transactional event/queue path. An explicit
unknown `targetRig` fails; an unknown spec-default rig produces an advisory
and falls back to unbound operation. A bound rig without a required declared
role is a different error.

`resolveDefaultOwner` uses declared `preferred_targets` first, applying a
harness match when pinned. With no preferred targets and a bound rig, it uses
[`selectRoleSeat`](../../../packages/daemon/src/domain/workflow-role-resolver.ts):
a running managed agent with the declared role and required runtime, ordered
by pending-only backlog and then canonical coordinate. Infrastructure and
unresolvable/adopted coordinates do not become implicit replacement agents.
Explicit owner overrides are reconciled with harness pins. A structured gate
resolves either a human destination or a handler role.

Instantiation also emits advisories for missing members in otherwise
registered target rigs. That member check is advisory and does not imply
all preferred targets received a live-readiness test.

## Projection, waiting, and concurrency

`WorkflowProjector.project` checks active/waiting status, frontier membership,
packet-to-step identity, allowed exits, and applicable evidence requirements.
For a successful advance, queue closure, successor creation, trail entries,
frontier/version updates, durable events, and wake intent staging share the
transactional notification envelope. Terminal delivery happens after the
commit. A committed packet or staged wake is not evidence that its recipient
consumed the message.

The serial path absorbs an identical waiting replay by matching the stored
closure intent; changed wait data is a new decision. A consumed terminal
packet is no longer on the frontier and is refused. `max_hops` constrains
routing relative to the current drive's baseline; resume establishes a new
bounded drive rather than erasing history.

Presence of `depends_on` selects `projectDependencyGraph`. It uses durable
packet bindings to advance eligible successors and record per-occurrence
failures without treating an unrelated live branch as completed. Inspection
reports unknown bindings rather than inventing a step from trail order.

The injected [`createWorkflowFrontierPredicate`](../../../packages/daemon/src/domain/workflow-frontier-guard.ts)
lets the queue refuse ordinary terminal closure of live workflow packets.
Workflow mutations use the explicit workflow path; the queue does not need
to import the workflow domain to evaluate that predicate.

## Recovery operations

`WorkflowRuntime` distinguishes these operations:

| Operation | Meaning |
|---|---|
| `route` | Replace a current packet's owner while retaining the step. This is not step advancement. Multiple frontier packets require an explicit packet selection. |
| `resume` | Redrive failed work with a recorded decision and newly resolved owner. Dependency failures use occurrence identity; multiple unresolved failures require selection. Identical occurrence/decision replay returns the recorded redrive, while changed decision bytes conflict. |
| `abort` | Explicitly stop unfinished work with an actor and reason. |
| `continue` | Read-only inspection of instance, trail, guidance, reconciliation, frontier, failures, unknowns, and boundary obligations. It does not mechanically advance a step. |

## Deadlines and exceptions

[`evaluateStepDeadline`](../../../packages/daemon/src/domain/workflow-deadline.ts)
derives overdue state from frontier queue rows. Claimed work uses its closure
deadline, otherwise its claim time plus **4 hours** (creation time if the
claim time is absent). Pending work uses creation time plus **4 hours**.
Blocked waits are not overdue under this evaluator. This is a diagnostic,
not a substitute for packet existence or binding checks.

[`resolveExceptionRoute`](../../../packages/daemon/src/domain/workflow-exception-router.ts)
selects per-class configuration, then workflow default, host default, and
finally orchestrator-first behavior. An unresolved orchestrator route falls
back to registered-human selection. A human gate is intrinsically human
routed. Agent-routed exceptions use the ordinary workflow tier; human-routed
ones use `human-gate`.

[`workflow-human-destination.ts`](../../../packages/daemon/src/domain/workflow-human-destination.ts)
handles human selection. A valid agent route need not have a human fallback
configured. If fallback is needed, missing/ambiguous selection is an explicit
error, not an invented destination. Failure admission is transactional;
overdue detection is handled by boot/keepalive paths. Runtime reconciliation
closes recovered overdue occurrences against their own packets, preserving
unresolved siblings and unknown provenance.

## Project lifecycle graphs

`compileLifecycle` delegates to
[`compileProjectLifecycle`](../../../packages/daemon/src/domain/project-lifecycle-compiler.ts).
`instantiateLifecycle` requires an operation key and compiled input digest.
An exact replay retrieves the recorded instance/entry packet; changed input
under the same key conflicts. Compilation and an eligible result do not by
themselves launch work.

`inspectGraph`, `reviseGraph`, and `recoverGraphOperation` in
[`workflow-reconciliation.ts`](../../../packages/daemon/src/domain/workflow-reconciliation.ts)
separate inspection from explicit graph revision and operation recovery.
`guidance` reads context and current packet information without interpreting
an agent's substantive judgment.

For lifecycle steps that require a receipt, a `done`/`handoff` projection
requires an `evidence_ref`. Typed acceptance gates additionally compare the
submitted candidate, allowed verdict, and evidence reference against the
step declaration. These are mechanical identity/presence checks; the
projector does not read the referenced prose to decide whether the work is
good or ready to publish.

## CLI and HTTP surface

The [CLI inventory](../cli-reference.md#workflow) lists every registered
`rig workflow` subcommand and option. The implementation is
[`packages/cli/src/commands/workflow.ts`](../../../packages/cli/src/commands/workflow.ts).
The [`workflow` routes](../../../packages/daemon/src/routes/workflow.ts)
are mounted under `/api/workflow`:

| Method | Suffixes |
|---|---|
| `POST` | `/validate`, `/compile`, `/instantiate`, `/instantiate-lifecycle`, `/project` |
| `GET` | `/list`, `/specs`, `/operations/:key`, `/:instance_id`, `/:instance_id/trace`, `/:instance_id/guidance`, `/:instance_id/revision` |
| `POST` | `/:instance_id/route`, `/:instance_id/resume`, `/:instance_id/abort`, `/:instance_id/continue`, `/:instance_id/revision` |
| `GET` | `/sse`, `/watch` (same live event stream handler) |

The stream filters the named workflow events; it is not a general queue
stream or a stored-history replay. Route error mapping distinguishes missing
records, authoring errors, state/version conflicts, and internal failures.
See the source mapping before assigning a meaning to a nonzero CLI result.

For authoring examples and project-level boundaries, use
[product journey SDLC](../../reference/product-journey-sdlc.md) and
[release boundaries](../../reference/release-boundary.md).
