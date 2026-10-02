---
kind: as-built
title: Living Notes — Composed Review and Frozen Exports
status: active
topics: [observability, knowledge-and-context]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  Tracing slice, mission, rig, or fleet review data back to scope documents,
  proof artifacts, judgments, queue state, or frozen exports.
last-verified-against-source: 712a61fbcc5ffe5a7c786fea12132567083ab507
last-updated: 2026-10-02
---

# Living Notes — Composed Review and Frozen Exports

Source snapshot: `712a61fbcc5ffe5a7c786fea12132567083ab507`. This describes the source at that commit;
it does not establish the version or behavior of a running daemon.

Living Notes builds review payloads from existing documents and recorded
state. The composition layer does not make an agent judgment or contact an
agent to obtain one. Its output distinguishes intent, plan, delivered proof,
attention, agents, and source lineage.

## Read and compose boundaries

[`ReviewGatherer`](../../../packages/daemon/src/domain/review/gather.ts)
performs filesystem, database, telemetry, and optional Git reads.
[`compose.ts`](../../../packages/daemon/src/domain/review/compose.ts) turns
those inputs into the contracts defined in
[`types.ts`](../../../packages/daemon/src/domain/review/types.ts), including
`ComposedSliceReview`, `ComposedMissionReview`, and `ComposedRigAgents`.

`gatherSlice` uses `resolveNodeFileVia` to select the scope node document,
reads `IMPLEMENTATION-PRD.md` and `PROOF.md`, and loads the `proof/` artifacts.
It also gathers approval stamps, locked artifacts, tagged queue attention,
agents, workflow exceptions, and `readSliceReadiness`. A current `SPEC.md`
is carried distinctly from a legacy `README.md`; the composer does not
blindly treat every file as an interchangeable source.

[`readProofArtifacts`](../../../packages/daemon/src/domain/review/proof-io.ts)
reads sorted top-level `.md` files in `proof/`, parses their headers with
`parseC1Header`, and uses file mtime as `droppedAt`. Missing directories and
unreadable entries yield no artifact for those entries. No claim that all
possible evidence was discovered follows from that read.

`composeMission` batches slice-index membership reads, gathers each slice,
and composes a mission board, completion ledger, attention union, agents,
and brief spine. `composeRig` reads queue/activity state and reports current
holders, recent holders, overdue work, settled work, and workflow exceptions.

## Slice source selection and phase

In [`composeSliceReview`](../../../packages/daemon/src/domain/review/compose.ts),
intent comes from the node document's `Intent` section. Placeholder-only
intent is treated as absent. Mini-requirements use current `SPEC.md` when
present; legacy selection can fall back from a pristine scaffold PRD section
to authored README material. Proof-contract selection delegates to
`selectProofContractBody` through `extractProofContractSelected`.

The phase is derived by `derivePhase`, in this precedence order:

| Phase | Signal |
|---|---|
| `locked` | Delivery approval stamp. |
| `review` | Recorded verdict or claimed proof pass. |
| `building` | Real proof artifacts, or active queue work paired with an authored/locked spec. |
| `spec` | Authored structure or a spec approval stamp. |
| `intent` | None of the above. |

File presence alone is insufficient: a scaffolded `PROOF.md` is not build
evidence, and a tracking queue item alone does not promote an unplanned
slice. Phase and proof readiness are separate output fields.

## Delivered items and current judgments

`extractProofContract` reads logical checkbox items, retaining authored raw
text for identity. `proofItemIdentity` uses an explicit `proof-item` marker
when supplied, otherwise an ID derived from the item's text. In the legacy
artifact join, `evidences` references match a promised item's exact display
text or its one-based index.

`composeDelivered` pairs each promise with curated media and a verification
state:

- With configured [proof readiness](../../../packages/daemon/src/domain/proof/judgments.ts),
  the matching current item must be `accepted`, and readiness must have no
  issues, to render `verified`. The note reports the current judgment state
  or why it is unavailable.
- Without configured readiness, a winning covering `qa` or `adjudication`
  artifact with a non-null `self_check` and a passing verdict supplies legacy
  verification. The note explicitly labels it **item revision unbound**.
- Other covering artifacts are `unverified`; no covering evidence/judgment
  is `missing`. Unmapped artifact media appears separately as `extraProof`.

This distinction matters after a proof contract changes: a legacy PASS
header is not automatically a current revision-bound judgment. Approval
stamps are also not a substitute for the delivered-item join.

## Approval, attention, and lineage

`ReviewGatherer.gatherApproval` reads `approved-spec-by`/`approved-spec-at`
and `approved-by`/`approved-at`, alongside matching `mission_control_actions`
approval audit records. The resulting locks preserve who/when/audit facts.
The approval writer is the separate
[`scope-approve` route](../../../packages/daemon/src/routes/scope-approve.ts).

`composeNeedsYou` combines recorded queue attention with derived exceptions;
`deriveWorkflowExceptions` adds workflow-specific observations. Mission
composition deduplicates attention identities across slice and mission views.
Media references outside the slice's relative-path contract produce defect
entries instead of disappearing silently.

Git facts are optional. [`startup.ts`](../../../packages/daemon/src/startup.ts)
passes `OPENRIG_REVIEW_GIT_REPO` to the gatherer. The gatherer reads that
repository's `HEAD`, searches merge messages keyed by scope ID, and computes
ancestry/behind facts when possible. Unavailable facts remain unknown; this
is not a fresh remote GitHub merge-status query.

`composeMissionReview` derives `cutComplete` from a nonempty ledger in which
every slice is green, has a merge SHA, and has no needs-human items. Configured
slice readiness supplies the green predicate; otherwise recorded verdicts
do. That computed field is not itself a publication or higher-level outcome
decision.

## HTTP routes

[`reviewRoutes`](../../../packages/daemon/src/routes/review.ts), mounted at
`/api/review` by [`server.ts`](../../../packages/daemon/src/server.ts):

| Method and suffix | Payload / behavior |
|---|---|
| `GET /slice/:name` | Composed slice plus proof-source observation. |
| `GET /mission/:name` | Composed mission plus proof-source observation. |
| `GET /agents?scope=…` | Agents band; scope is `slice:<id>`, `mission:<id>`, or `rig`. |
| `GET /rig` | Local rig review root. |
| `GET /fleet` | Local and registered remote host review union. |
| `POST /freeze` | Compose and export an approved slice; body requires `scope: slice` and `name`. |

Missing gatherer returns `503`; invalid agents scope returns `400`; unknown
slice/mission returns `404`. Fleet is a sibling aggregate, not another value
of the agents-scope parameter.

## Freeze and media

[`freezeSliceExport`](../../../packages/daemon/src/domain/review/freeze.ts)
requires a delivery lock and an allowlisted slice directory. It writes
`REVIEW-<scope-id-or-name>-<approval-date>.html` through
`FileWriteService.createAtomic`. An existing target is treated as already
frozen; it is not rewritten. A failed export does not undo approval.

The export embeds contained images as data URIs and links videos with an
optional poster. `containedMediaPath` checks both resolved paths and existing
symlink targets against the slice directory. Unavailable/outside media gets
an explicit rendered message.

After a new freeze, the route may update the generated spine in a conforming
`MISSION_BRIEF.md` through the conflict-checked file writer. A malformed brief
is skipped, and brief-write failures are reported without undoing the export.
The [`slices` routes](../../../packages/daemon/src/routes/slices.ts) separately
serve proof assets; [`files` asset serving](content-surfaces.md) has its own
allowlist and range behavior.

## Fleet composition

[`composeFleet`](../../../packages/daemon/src/domain/review/fleet-compose.ts)
composes local data in-process and reads registered hosts' composed rig
payloads. Its default fan-out concurrency is **4**, with a shared
**4-second** read budget. Synchronous local work cannot be preempted by that
timer; elapsed local work reduces the remaining remote budget.

`unionFleet` keys attention by host plus item identity and retains host
status. Unavailable hosts have absent counts, not synthetic zeros. A missing
registry produces a local-only result; an unreadable existing registry is
reported. Host-derived time/status facts are carried through, not recomputed
as if every host shared one clock.
