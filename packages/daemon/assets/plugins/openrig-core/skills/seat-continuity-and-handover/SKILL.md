---
name: seat-continuity-and-handover
description: Use when replacing a seat's occupant (rebuild/handover/swap), reasoning about stable-seat-identity vs fluid-occupant-identity, choosing an old-occupant disposition (retire/advise/shadow), or recording provenance for an occupant change. Two independent outcomes (continuityOutcome + seatBindingOutcome) and the 5 failure modes that prevent silent dishonesty.
metadata:
  openrig:
    stage: factory-approved
    sibling_skills:
      - claude-compaction-restore
      - session-compaction-and-restore
      - retiring-and-inheriting-a-seat
      - agent-startup-and-context-ingestion
      - agent-starters
      - session-source-fork
---

# Seat Continuity and Handover

A pair of primitive families that separate *who is sitting in a seat* from
*what the seat itself is*:

1. **Occupant-creation primitives** — `resume`, `fork`, `rebuild`, `fresh` — produce a candidate new occupant. Answer: "where did the new occupant come from?"
2. **Seat-binding operations** — handover binds a candidate occupant into the topology. Answer: "what happened to the stable seat identity?" Inspect the current CLI for executable operations; design vocabulary alone does not establish a command.

Core architectural decision: **stable seat identity, fluid occupant
identity, explicit provenance.** Do not encode successive occupants into live
seat names. Keep the stable address and record lineage separately.

## Use this when

- Replacing a seat's occupant via rebuild, fork, fresh, or seat-handover
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
- **Do NOT introduce successor-suffix seat names** (`lead2`/`lead3`). Stable seat identity is the architectural goal. The live address stays stable. A retired tenure is distinguished by its ledger
generation and exact history token; preserving it does not require a renamed live pane.

- **Do NOT report `seatBindingOutcome: handed_over`** if the provenance record didn't write durably.
- **Do NOT auto-rollback a half-completed handover** by re-attaching the old occupant unless detach completed cleanly first.

## Composition and current command surface

A fork can create a candidate occupant; handover binds it into an existing seat.
The continuity outcome is `forked`; the binding outcome is independent.

The packaged `rig handover <seat>` and `rig seat handover <seat>` accept `fresh`,
`discovered:<id>`, `fork:<id>` and `rebuild` sources. Use `--dry-run` to request
planning only. Without it, these surfaces can execute; do not infer read-only
behavior from the shorter seat command's planning-oriented description.
`rig seat status <seat>` is the read-only observability surface.

Source support is declared by the running daemon and depends on actual identity,
history and artifact prerequisites. Read the returned source, continuity, binding
and provenance results independently. A help listing or dry-run is not proof of a
successful transition. The linked cutover SOP supplies the operator mechanics
and required effect checks after the named owner authorizes the action.

## Write the seat's recap before a handover

A `rebuild` primes the successor from the seat's durable artifacts, highest trust
first:
1. the authored `RECAP.md`;
2. `LEARNED.md`;
3. the latest restore packet, when one is marked;
4. the superseded recaps.

A missing `RECAP.md` is recorded as a gap. The successor is directed to the remaining
available artifacts in that order. So before a handover, a compaction or a long pause,
the sitting occupant writes its recap alongside `LEARNED.md`:

```sh
rig context recap-write --rig <rig> --seat <seat> --file <draft.md>
```

- `<seat>` is the seat's folder under `rigs/<rig>/seats/`, the part of its session
  name before `@`.
- The command reads `topology.root` and doesn't need the daemon.
- Each write moves the previous recap into the seat's `recap-superseded/` chain,
  which later rebuilds also read. Write through this command, not a file tool, so
  the chain is kept.

**The store refuses the write, and writes nothing,** when a section can't be
addressed. Only H2 and H3 headings are sections. Addresses lowercase the title,
remove Markdown formatting markers, replace remaining runs outside `a-z`/`0-9` with
a hyphen, and trim edge hyphens. Duplicate section paths, a nonblank H2/H3 title
that normalizes to an empty slug, and an unclosed code fence are refused. A
duplicate path is two H2s with the same address, or two H3s with the same address
under one H2. Blank headings are retained as scope boundaries.

**It writes, with an advisory on stderr,** when:
- no H2 or H3 title contains "decision";
- a line mentions "unverified" without the exact marker `UNVERIFIED:`.

**A recap that passes the first time** has:
- a short summary;
- a `## Decisions, with reasons` section, each decision with its reason;
- what's in flight and who owns the next step;
- an `UNVERIFIED:` line for each fact you haven't checked yourself.

## Why load-bearing for RSI

Any recursive seat-refresh loop must be able to replace an occupant
while keeping topology stable. Without these primitives, RSI loops will
either accumulate suffixed seat names (lineage leaking into identity) or
destabilize topology references on each cycle. Provenance must be
durable AND queryable so RSI loops can decide whether a seat is fresh
enough to receive new work or needs re-handover.

## Managed binding and retained history

A retired advisor's history can remain available without a managed node or live
pane. Query current binding and the lineage ledger separately: one answers who
holds the seat, the other identifies the retained history and exact resume token.
Do not infer that a predecessor is unreachable from registry absence alone, or
that a preserved token proves a successful resume. Check the actual runtime and
history when consultation is needed; see `retiring-and-inheriting-a-seat`.

## See also

- `references/apprentice-successor-seat-cutover.md` — the portable mechanic SOP used only after the owner-worded gate
- `references/orchestrator-role.md` — the orchestration judgment, authority, custody, and receipt contract
- `references/apprentice-evidence-toolkit.md` — optional evidence apparatus selected only when the stakes earn it
- `session-source-fork` skill — `fork` occupant-creation primitive (sibling)
- `agent-starters` skill — composes occupant-creation + binding into named reusable starting points
- `cross-host-rig-commands` skill — remote addressing and transport; verify lifecycle support on the target
