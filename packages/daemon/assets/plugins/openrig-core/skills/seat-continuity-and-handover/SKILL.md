---
name: seat-continuity-and-handover
description: Use when replacing a seat's occupant (rebuild/handover/swap), reasoning about stable-seat-identity vs fluid-occupant-identity, choosing an old-occupant disposition (retire/advise/shadow), or recording provenance for an occupant change. Two independent outcomes (continuityOutcome + seatBindingOutcome) and the 5 failure modes that prevent silent dishonesty.
metadata:
  openrig:
    stage: factory-approved
    last_verified: "2026-05-04"
    distribution_scope: product-bound
    source_evidence: |
      Option A rebuild MVP shipped 2026-04-30. Option B (full code-direct
      seat handover via SeatHandoverService daemon module) is a future
      follow-on.
    sibling_skills:
      - claude-compaction-restore
      - mental-model-ha
      - scope-recovery
      - agent-startup-and-context-ingestion
    transfer_test: pending
---

# Seat Continuity and Handover

A pair of primitive families that separate *who is sitting in a seat* from
*what the seat itself is*:

1. **Occupant-creation primitives** — `resume`, `fork`, `rebuild`, `fresh` — produce a candidate new occupant. Answer: "where did the new occupant come from?"
2. **Seat-binding primitives** — `seat handover`, later `seat transfer` / `seat retire` / `seat swap` — bind a candidate occupant into the topology. Answer: "what happened to the stable seat identity?"

Core architectural decision: **stable seat identity, fluid occupant
identity, explicit provenance.** Today's `lead2`/`lead3`/`lead4`/`lead5`
pattern encodes successor lineage into seat names — that's the wrong
shape. Stable seat name + separately-recorded provenance trail is the
right shape.

## Use this when

- Replacing a seat's occupant via rebuild, fork, fresh, or future seat-handover
- Choosing old-occupant disposition: retire / advise / shadow
- Reasoning about whether a seat's lineage is stable or has drifted
- Reading or writing the provenance record for a seat
- Designing or auditing topology stability across an occupant change

## Don't use this when

- The seat is freshly created (no occupant to replace) — use `rig launch` / `rig expand` directly
- The intent is to change topology shape (add/remove seats), not replace an occupant — use topology-mutation primitives

## The two-outcome honesty model

Every seat-binding operation produces two **independent** outcomes:

```yaml
continuityOutcome: rebuilt | resumed | forked | fresh | failed
seatBindingOutcome: handed_over | partial | failed | unchanged
```

These can disagree honestly. Examples:

- `continuityOutcome: failed` + `seatBindingOutcome: unchanged` — new occupant didn't materialize; seat correctly retains old occupant.
- `continuityOutcome: rebuilt` + `seatBindingOutcome: failed` — candidate created OK; bind failed mid-flight; provenance records the gap.

**Don't collapse these into one outcome.** The system can describe what
actually happened only if the two are recorded independently.

## Provenance record (durable, queryable)

Every handover writes:

- seat id
- old occupant id
- new occupant id
- creation mode (`resume`/`fork`/`rebuild`/`fresh`)
- source artifacts used
- whether old occupant remains alive as advisor/shadow
- operator or loop that initiated the motion
- timestamp
- result (`handed_over` / `partial` / `failed`)

This is the system's truth-source for "how did the current occupant get
there." Without it, the control plane shows the current occupant but
not the legitimacy of the transition.

## State models — independent

### Occupant-creation state (per candidate)

1. **Requested** — input to rebuild/fork/fresh/resume
2. **Realized** — runtime/artifact path produced an occupant with managed-seat shape
3. **Failed** — candidate didn't materialize; `continuityOutcome: failed`

### Seat-binding state (per seat)

1. **Stable** — current occupant attached, no in-flight binding
2. **Binding** — handover in progress
3. **Bound** — handover succeeded; provenance record written
4. **Unchanged** — bind failed before completion; seat retains old occupant

A seat stays `Stable` even if multiple candidate-occupants were produced and discarded.

## Failure modes (5)

1. **Candidate creation failed** — `rebuild` couldn't synthesize from artifacts; `fork` couldn't resolve `session_source`; `fresh` couldn't launch. **Action**: bind operation does not begin; seat unchanged; provenance records the failed candidate-creation step.
2. **Old occupant cannot be detached cleanly** — runtime hung, tmux locked, etc. **Action**: bind halts mid-flight; seat enters `Binding` state with explicit "halted" sub-status; operator alerted. **Do NOT auto-rollback by reattaching old-occupant if detach didn't complete cleanly.**
3. **Bind succeeded but provenance write failed** — disk/db error. **Action**: not durable until provenance writes; treat as `Binding` halted, not `Bound`.
4. **Old occupant disposition unfulfillable** — operator requested `advise` (keep alive as advisor) but runtime can't keep old alive. **Action**: degrade to `retire` with explicit notification, OR fail if operator passed strict-disposition flag.
5. **Concurrent handover attempts** — two operations target the same seat. **Action**: serialize by seat-id lock; second attempt refuses with clear error.

## Hard boundaries (do-not list; verbatim)

- **Do NOT collapse `rebuild` and `seat handover` into one primitive.** The design specifically separates them so the system can describe what actually happened.
- **Do NOT introduce successor-suffix seat names** (`lead2`/`lead3`). Stable seat identity is the architectural goal.
- **Do NOT report `seatBindingOutcome: handed_over`** if the provenance record didn't write durably.
- **Do NOT auto-rollback a half-completed handover** by re-attaching the old occupant unless detach completed cleanly first.

## Composition: seat handover over fork

Once `session_source` fork v1 lands (already shipped at openrig
`c7b6df1`), the next composition is **seat handover over fork**:
candidate occupant created via fork, bound into the existing seat via
handover. Continuity outcome is `forked`; binding outcome is independent.

## Currently shipped vs deferred

- **Option A (rebuild) shipped** at openrig `578bd5c` (2026-04-30): `session_source.mode: rebuild` with `ref.kind: artifact_set`; identity-honesty bedrock at 4 layers (schema dispatch, orchestrator threading, SQLite read-back, negative-grep on resolver output). 26/26 Tier 1 cases green; full daemon regression 2146/2146 PASS.
- **Option B partially shipped, partially deferred to Mode 3**: the `rig seat handover` CLI exists as a planning/observability surface — `status <seat>` reads the seat-handover observability tables (migration `021`); `handover <seat>` plans a safe two-phase handover sequence with actual execution flowing through existing seat-launch surfaces under operator gating. Full code-direct `SeatHandoverService` daemon module + `seat-binding-outcome` provenance record + nodes-table provenance migration remain deferred to Mode 3. MVP composition `seat handover over fork` is highest-leverage v1.

## Why load-bearing for RSI

Any recursive seat-refresh loop must be able to replace an occupant
while keeping topology stable. Without these primitives, RSI loops will
either accumulate suffixed seat names (lineage leaking into identity) or
destabilize topology references on each cycle. Provenance must be
durable AND queryable so RSI loops can decide whether a seat is fresh
enough to receive new work or needs re-handover.

## See also

- `claude-compaction-restore` skill — packet-driven restore after Claude compaction
- `mental-model-ha` skill — HA-pair pattern for preserving mental model across seat resets
- `agent-startup-and-context-ingestion` skill — ingestion path for restore packets at agent boot
