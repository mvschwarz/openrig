---
name: retiring-and-inheriting-a-seat
description: Use when you are a sitting agent near your context threshold (~85%) and a PLANNED seat transition is due — retire deliberately and hand your seat to a fresh successor primed from a packet, rather than let compaction degrade you. Covers the handover packet, the append-only lineage ledger (one row per tenure), physical-seat continuity, the do-not-over-inherit framing, the optional warm-handoff window, and wake-v0 (consulting a retired predecessor). NOT for unplanned compaction/crash recovery (session-compaction-and-restore / claude-compaction-restore) and NOT the seat-binding primitive mechanics (seat-continuity-and-handover).
metadata:
  openrig:
    stage: provisional
    sibling_skills:
      - orienting-to-an-inherited-seat
      - session-compaction-and-restore
      - seat-continuity-and-handover
      - claude-compaction-restore
      - agent-starters
      - queue-handoff
      - openrig-user
---

# Retiring and Inheriting a Seat

A **planned** seat transition. A long-lived seat accumulates context; as it nears the
window's edge, don't wait for compaction to degrade you into a cold-started agent —
**retire deliberately** and hand the seat to a fresh successor primed from a packet plus
the seat's accumulated lineage. The **seat address is stable; its occupants are a lineage.**
Keep the transition and its authority explicit.

## Use this when

- You are a sitting agent near your context threshold (~85%) with a **planned** transition
  (or a deliberate role change), and want the successor to start clean.
- You are priming a fresh successor into an **existing** seat.
- You are recording a tenure in the seat's lineage ledger / writing your tombstone.
- You are **inheriting** a seat and need the do-not-over-inherit framing.
- You want to consult the agent who sat in this seat before you.

## Don't use this when

- Unplanned compaction or a crash already happened — that is the backstop path:
  `session-compaction-and-restore` / `claude-compaction-restore`.
- You need the seat-binding **primitive mechanics** (rebuild/fork/fresh, the two-outcome
  honesty model, the provenance schema) — `seat-continuity-and-handover`.
- The seat is fresh with no occupant to retire — `rig launch` / `agent-starters`.

## Why planned handover beats riding compaction

Compaction is the **crash-class backstop** (it stays that). A **planned** handover is
deliberate: you author the packet with a clear head *before* degradation sets in, the
successor starts on a clean context, and the transition is auditable. Reach for this at a
threshold you can see coming; fall back to compaction only when a transition wasn't planned.

## The handover sequence

1. **Trigger** — the selected continuity threshold or a deliberate role transition.
   Use the configured policy and named transition owner; a context estimate alone
   does not authorize a cutover.
2. **Author the handover packet, deliberately** — a composed context pack carrying current
   work + next owner, the seat's durable pointers, constraints and authority boundaries, and
   the accumulated **lineage wisdom** ("those before you learned X"). This IS a restore packet
   in the `session-compaction-and-restore` 16-field contract — **reuse that contract, don't
   reinvent it.** Compose it with `rig context compose` (see openrig-user → "Context packs and
   paced delivery").
   **Enumerate the seat's standing duties as first-class packet content:** what recurs, at what
   cadence, on which surface, and who will hold it after cutover. Carry each duty both in this
   packet and in durable seat state, because recurring duties are the content most often lost at
   a generation boundary while urgent one-off work carries cleanly.
   **Write the seat's recap too:** run `rig context recap-write --rig <rig> --seat <seat> --file <draft>`
   alongside updating `LEARNED.md`. A `rebuild` reads `RECAP.md` before anything else. The format
   the store checks is in `seat-continuity-and-handover`, "Write the seat's recap before a handover".
3. **Prime the fresh successor** — `rig walk` the packet into the seat (paced delivery lets the
   successor absorb it in order), or launch-with-packet. The successor reads it as
   *inheritance*, not *identity*. **The packet's first-read line MUST point the successor at
   `orienting-to-an-inherited-seat`** — its world model of what a handover *is*. Carry that
   pointer **in the durable packet artifact itself**; never inject it as a runtime prompt keyed
   to the seat name (that runtime mechanism is the **ghost-prompt** class the orientation skill
   teaches successors to refuse). Artifact-carried
   survives the swap for free and needs no enabled gate.
4. **Assess before cutover.** If an apprenticeship or warm handoff is selected,
   use that staged window for questions and domain work before the owner decides.
   The incumbent retains authority until the owner-worded cutover; do not retire
   it merely to free a name while waiting for that decision.
5. **Preserve the physical seat at cutover** — follow the portable SOP linked from
   `seat-continuity-and-handover`. Keep the canonical tmux session, window and pane;
   resume the exact accepted successor history there and reconcile binding,
   environment, queue identity and attached clients. Preserve the incumbent's
   exact token as a cold-advisor handle when that is the selected disposition.
   Renaming tmux sessions is a repair fallback, not the default sequence.
6. **Write the lineage-ledger row and tombstone** (below). Record the actual
   outcomes and transfer each standing duty explicitly. Complete the successor's
   post-cutover self-check before unfreezing authority.

## Apprentice mode — incumbent

An `apprentice-handover` policy gives you an early preparation boundary, not permission to
automate the succession decision. Create a fresh, staged, unbound successor; prove the pinned
model before installing context; then open a **conversation, not a gauntlet**. Give coached
errands, answer questions, and judge work in the real domain. Scored probes are optional tools whose rigor must match the stakes, not
mandatory ceremony.

Stay the authority-bearing incumbent until the named owner words the gate and the mechanic records
the effect receipt. Before that word, the apprentice may observe, ask, and produce evidence but may
not act as the seat. Enumerate deposits and transfer every standing duty explicitly, **because
recurring duties** are otherwise easy to lose while visible one-off work appears complete. Put the
mechanical cutover in the portable SOP linked from `seat-continuity-and-handover`; do not duplicate
or improvise it here.

## The lineage ledger (append-only, one row per tenure)

The seat's tenure record, written at handover **by the retiring agent**. One tiny row per
tenure:

- **generation** — `v1`, `v2`, … (a seat accumulates 20–40 tenures over months)
- **harness session id** — **captured AT BOOT**, not at retirement (a crash never gets the
  chance to write it later)
- **started / retired** timestamps
- **handover-packet pointer** — the pack ref
- **tombstone** — one line: what this tenure did, written by the retiring agent itself

**Why it works (zero search infrastructure):** any timestamped record — a git commit, a
qitem, a NOTES.md line, a stream item — joins to the seat's ledger by interval match →
generation + session token → wake that tenure. One row per handover, append-only. The
ledger is the tenure record; work-tree notes remain lived context, not identity state.

**Crash-ended tenures** get their row appended **post-hoc** by the crash-cart / restore path,
flagged **honest-approximate** (the boot-captured session id is what makes this recoverable).

## Inherit the seat, not the predecessor's identity

**You are inheriting a seat, not becoming your predecessor.** Frame it explicitly to the
successor: *"agents sat here before you and learned X; you carry the seat's mission, not their
identity."* Do not claim a predecessor's work as your own or use its stale identity
as the current binding. Inherit the
seat's **mission and hard-won lessons**; keep your own **fresh identity and session**.

## Reach back to a retained predecessor

A retired tenure is a cold advisor you can consult. Look up the seat's ledger → get that
generation's session token → resume it for **one question**, then let it sleep again:

- Claude: `claude -p --resume <session>`
- Codex: `codex exec` (resume the rollout)

Use `rig ask <rig> "<q>" --wake <seat[@gen]|token>` for an explicit bounded
consultation (introduced in CLI 0.5.1). Check `rig ask --help` for `--runtime`
and `--wake-timeout`. The wrapper uses a runtime resume; its presence is not
proof that a particular retained history is available. For a Claude history,
`claude -p --resume <full-uuid>` is the runtime-level fallback when supported.
Diagnose the specific failure before declaring the channel unavailable.

**What to write in your packet about reaching you** — your successor asking you questions is the
reason this is a handover and not a compaction:

- **Give your verbatim resume handle and known availability limits.** Retirement alone
  does not expire retained history. Resuming still depends on that history, runtime
  access and remaining context; distinguish these failure modes. The advisor
  supplies testimony and does not regain the live seat's authority.
- **Pre-form the questions.** Inventory what only you hold and write the questions out. An affordance
  needs a trigger: name the tradeoff, missing rationale or conflict that should prompt a question.

**Wake-tenancy — the identity halves (a woken tenure can mistake itself for the live seat).** The
hardest thing to apply *checked-not-believed* to is your own identity — a retired tenure resumed for a
question can answer, and act, as if it still held the seat. Two rules close it:

- **Waker: disclose the target's tenure status in the wake prompt.** Open with *"you are retired; gen-N
  holds this seat now — I'm consulting you for one question."* An oriented tenure gives honest testimony;
  an un-oriented one may reason as the live occupant.
- **Woken: verify your OWN tenancy before your first act.** If you are being resumed / woken (a parked or
  retired session, or any session waking on a seat that already issued READY), your **first** check is
  `rig whoami` + a **successor check** — confirm whether you are still the live occupant or a successor
  now holds the seat, *before* you do anything. Answer the question; do not resume the job.

## Failure modes

1. **Riding compaction when a planned handover was available** — a degraded agent authors a
   degraded packet. Retire deliberately at the threshold you can see coming.
2. **Over-inheriting** — the successor believes it *is* the predecessor (stale self-model,
   mis-claimed history). Frame inheritance explicitly; keep a fresh identity.
3. **Session id captured at retirement, not boot** — a crash then leaves no row, or an
   unfindable tenure. Capture at boot.
4. **Suffixing the LIVE seat** (`<seat>-v2` as the active address) — lineage leaking into
   identity, the wrong shape. The live address stays clean; generation belongs in the ledger.
5. **Tombstone omitted or vague** — the ledger can no longer answer "who did this / who to
   wake." One honest line, every tenure.

## Checks around a planned transition

- **Stage and assess before the owner calls cutover.** Use startup context when the
  successor is unbound; check its actual address before relying on registry-routed
  delivery. Keep incumbent authority and physical-pane custody until the selected
  SOP's cutover steps apply. A rejected candidate does not require renaming the
  incumbent back into a seat it should still hold.
- **Preserve exact resume handles.** A retained advisor may have no managed node or
  live pane. The ledger identifies its history independently of the live-seat
  registry; absence from `rig ps` alone does not prove that history is gone.
- **Recheck work at the boundary.** Queue items can arrive after the packet was
  frozen. The successor reads its current owned queue, reconciles transition-window
  work and staged inputs, and records every remaining obligation.
- **Verify identity across surfaces.** Canonical binding, provider history,
  process environment, queue identity and attached clients must agree. Correct a
  staged identity residue through the supported cutover/reconciliation path;
  renaming a tmux session alone is not proof that those surfaces agree.
- **Keep incomplete evidence explicit.** Flag unavailable activity telemetry as
  unavailable, and mark a tombstone written by someone else as approximate.
- **Coordinate the maintenance window.** Tell the routing/monitoring owner the
  target and expected window before an authorized cutover. Only an explicitly
  configured suppression changes monitoring behavior; close the window with the
  actual effect receipt, deviations and unresolved gaps.

These are verification prompts, not a claim that a particular runtime transition
has passed. Use the linked portable SOP for mechanics and record the actual run.

## See also

- `orienting-to-an-inherited-seat` — the **successor-side** world model your packet points
  them at (loaded at boot); the load-bearing counterpart to this driver-side mechanic.
- `session-compaction-and-restore` — the 16-field packet contract this practice reuses, and
  the UNPLANNED-compaction backstop it replaces for *planned* transitions.
- `seat-continuity-and-handover` — the seat-binding primitive mechanics + stable-seat-identity
  architecture; the lineage ledger is the concrete form of its abstract provenance record.
- `openrig-user` → "Context packs and paced delivery" — `rig context compose` + `rig walk`, to
  author and deliver the packet.
- `claude-compaction-restore` — the Claude crash-class restore SOP.
- `agent-starters` — composing a primed starting point for the successor.
