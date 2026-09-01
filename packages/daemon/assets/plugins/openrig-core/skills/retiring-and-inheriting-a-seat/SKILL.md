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
This is the practice that named the "seat" primitive.

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

1. **Trigger** — ~85% context, or a deliberate role transition. The oversight-rig context
   detector can fire this for you; you can also self-initiate when you feel the edge.
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
3. **Prime the fresh successor** — `rig walk` the packet into the seat (paced delivery lets the
   successor absorb it in order), or launch-with-packet. The successor reads it as
   *inheritance*, not *identity*. **The packet's first-read line MUST point the successor at
   `orienting-to-an-inherited-seat`** — its world model of what a handover *is*. Carry that
   pointer **in the durable packet artifact itself**; never inject it as a runtime prompt keyed
   to the seat name (that runtime mechanism is the **ghost-prompt** class the orientation skill
   teaches successors to refuse — and it has misfired on real successors). Artifact-carried
   survives the swap for free and needs no enabled gate.
4. **Preserve the physical seat at cutover** — the live seat address and its canonical tmux
   session, window, and pane stay stable. Assess the apprentice in a staged session; at the
   owner-worded cutover, resume the accepted successor history in the original canonical pane
   and remove the empty staging session. The retiring tenure becomes a cold advisor through its
   lineage token. Renaming tmux sessions is a repair fallback, because attached clients follow
   the physical pane rather than the logical seat name.
5. **Write your lineage-ledger row + a one-line tombstone** (below).
6. **Optional warm handoff** — a bounded apprenticeship window: the successor asks questions,
   the predecessor judges fitness, *then* the swap completes. Use it when the seat holds a lot
   of live judgment; skip it for a clean cut.

## Apprentice mode — incumbent

An `apprentice-handover` policy gives you an early preparation boundary, not permission to
automate the succession decision. Create a fresh, staged, unbound successor; prove the pinned
model before installing context; then open a **conversation, not a gauntlet**. Give coached
errands, answer questions, and judge work in the real domain. The experiment's scored probes are
optional tools whose rigor must match the stakes, not mandatory ceremony.

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

## Do NOT over-inherit — the key lesson from the practice's history

**You are inheriting a seat, not becoming your predecessor.** Frame it explicitly to the
successor: *"agents sat here before you and learned X; you carry the seat's mission, not their
identity."* The historical failure was agents getting confused about whether they **were** the
predecessor — carrying a stale self-model, over-claiming prior work as their own. Inherit the
seat's **mission and hard-won lessons**; keep your own **fresh identity and session**.

## Wake v0 — ask the agent who sat before you (a practice, not a verb)

A retired tenure is a cold advisor you can consult. Look up the seat's ledger → get that
generation's session token → resume it for **one question**, then let it sleep again:

- Claude: `claude -p --resume <session>`
- Codex: `codex exec` (resume the rollout)

This is also a `rig` verb: `rig ask <rig> "<q>" --wake <seat[@gen]|token>` (CLI 0.5.1; also
`--runtime`, `--wake-timeout`, default 180s). It wraps the harness resume above and is **not yet
well-exercised** — if it fails, fall back to `claude -p --resume <full-uuid>`. **A failing wrapper is
not a closed channel.** The ledger is how you **find** the right predecessor; wake is how you ask them.

**What to write in your packet about reaching you** — your successor asking you questions is the
reason this is a handover and not a compaction:

- **State that the channel does not expire**, and give your **verbatim resume handle**. You stay
  reachable after retirement; the only real bound is your own context wall, hit while answering. Ask
  them to treat your answers as testimony if you like — that is a posture claim, not a limit on access.
- **Pre-form the questions.** Inventory what only you hold and write the questions out. An affordance
  without a trigger goes unused, so *"you may consult your predecessor"* reliably produces none.

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
   identity, the wrong shape. The live address stays clean; only the retiree is versioned.
5. **Tombstone omitted or vague** — the ledger can no longer answer "who did this / who to
   wake." One honest line, every tenure.

## Field-validated refinements (pilot 2026-08-05 — two live runs, both runtimes)

Two live handovers (a Claude seat + a Codex seat) ran this sequence end-to-end and sharpened it:

- **A GATED handover uses STAGED primitives, not an all-in-one verb.** An atomic
  create/deliver/verify/rebind verb can't pause for a human go/no-go gate. Decompose it: boot the
  successor **staged (unbound)** → prime it → **retire** the incumbent (this frees the clean seat name)
  → **HOLD for the gate** → **swap** (bind the successor to the canonical name). The gate sits between
  retire and swap; a no-go rolls back by renaming the retiree back.
- **Prime AT BOOT, not walk-after-boot, for a staged successor.** Delivery verbs (`rig walk` / `rig
  send`) resolve via the **bound** session registry, so they cannot reach an unbound staged successor.
  Boot it **with the packet as startup/priming context** (the "primed from a handover/startup packet"
  path). In both runs the successor read the full packet and correctly stated inheritance-not-identity
  and held.
- **The lineage ledger is the ONLY reliable wake path — load-bearing, not convenient.** A retired
  occupant (`<seat>-vN`) is intentionally **absent from the managed registry** — discovery / walk / send
  cannot find it. The ledger's **boot-captured** session id is how you wake it: `claude -p --resume
  <id>` (Claude) or `codex exec` resume (Codex) — harness-level, not the rig registry.
- **Tombstone honest-approximate fallback.** If a long-idle retiree can't be woken to self-write its
  tombstone, the driver records an honest-approximate one and **flags it as such**.
- **Telemetry-degraded flag when warranted.** If a fresh successor's activity/producer-link telemetry
  is degraded, flag its ledger row so no future reader trusts its activity state. (One runtime showed a
  fresh-launch telemetry gap; the other was clean — capture the reality, don't assume.)

### Production-evidenced (first real-stakes run — a critical-seat generation swap, 2026-08-05)

The first live swap at a critical seat **succeeded** (the successor ruled a live domain question within the
hour — doctrine intact across the generation) and surfaced two hard refinements:

- **Boot-window queue re-check is REQUIRED — the successor's first action.** A qitem created *during* the
  swap window can land **after** the handover packet was frozen — and its boot nudge fails
  `session-not-found` because the seat is mid-cutover. The packet's snapshot is therefore incomplete by
  construction. So the successor's first action is a **checked-not-believed queue sweep** (`rig queue list`
  by destination / `--mine`), never trusting the packet's snapshot alone. The swap-window delivery seam is a
  known product gap until it's closed.
- **Complete the canonical rename AT cutover — or expect three breakages.** If the staged name
  (`<seat>-vN-staging`) survives past cutover, it breaks across three identity surfaces with inconsistent
  enforcement: **transport** (the staged label doesn't resolve; replies to the signature bounce),
  **queue-claim** (`claim_destination_mismatch` rejects the seat's own claim), and **queue-ledger**
  (`handoff-and-complete` stamps the phantom staged name durably as `sourceSession`). The product fix is
  tracked; until it lands, finish the canonical rename at cutover and treat a lingering staged name as a
  live defect, not cosmetic.
- **Pre-announce the swap to oversight at swap START.** A live swap fired oversight's liveness detector
  mid-swap (a false positive, cleared). Oversight clears such flags by consulting handover **receipts** —
  but receipts only land at swap **end**, so a long swap window can still misfire. So the executing party
  sends oversight a **one-line pre-announce at swap start** (seat + expected window); oversight honors it
  as a **suppression window** for its liveness / premature-park flags. See `oversight-team`.

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
