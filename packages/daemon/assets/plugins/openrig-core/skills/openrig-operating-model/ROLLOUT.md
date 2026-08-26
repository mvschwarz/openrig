# ROLLOUT — adopting the Operating Model on a live fleet

This file is deliberately verbose. It is the adoption plan, the interim
practices, and the reasoning — everything time-bound that does NOT belong in
SKILL.md (which teaches the model itself, timelessly).

## Why a rollout plan exists at all

This model was designed after a measured failure: several consecutive
generations of critical seats onboarded through handover documents alone and
each lost most of the operational knowledge of its predecessor — without
knowing it (the Dunning-Kruger shape: the loss is invisible from inside).
The fleet also has real rate limits: fifty seats reading a large skill
simultaneously is a provider incident, not a rollout. Both facts shape
everything below.

## The three pieces

1. **The markdown** — files must exist before anyone can walk them.
2. **The rolling upgrade** — seats adopt in small waves, top-down.
3. **The enforcement floor** — watchdog-fired due-checks keep the trace habit
   alive without any new product code.

## Piece 1 — the markdown layer (create/rename/map; migrate nothing finished)

- **Rule zero: no migration of finished work.** Completed missions, closed
  specs, historical notes stay untouched forever. The model starts with work
  IN FLIGHT and everything new.
- **Renames:** the old `STEERING.md` files become `INTENT.md` (same content,
  new name — "steering" predated the fleet's settled use of the word intent).
  Leave a one-line pointer file at the old name for one transition period.
  The frozen drift-correction spec (0.5.4) refers to the steering substrate;
  its owner amends the naming there (see ROADMAP.md).
- **Mappings, not moves:** today's standalone slice PRD IS the slice-level
  `SPEC.md`, as-is, no edits. `MISSION_NOTES.md` keeps serving every mission
  that already uses it; new missions start with `NOTES.md`.
- **Creation:** `scripts/scaffold.sh` places missing chain files as UNSEEDED
  templates. It never overwrites, never deletes.
- **Topology-tree root, RULED (pm-lead wave-1 review, 2026-08-10):** the
  canonical on-disk root for topology chain files is the existing rig home —
  `shared-docs/rigs/<rig>/` — so a seat's files live at
  `shared-docs/rigs/<rig>/seats/<seat>/`. That shelf already holds each rig's
  `rig.yaml`, rig-level `CULTURE.md`, and `state/`, so the chain composes with
  what exists instead of minting a parallel tree. Seat instances never live
  inside this skill's directory (the skill is distribution canon, not runtime
  state; the two early seeds that diverged were reconciled here: pm-openrig's
  provisional placement confirmed, pm-lead's moved to match).
- **Seat files:** created by scaffold, but their CONTENT is seeded only by the
  protocol below — never mass-produced.

## Piece 2 — the rolling upgrade

**Wave order and why:** those who review others must hold the model first.

- **Wave 1 — coordinators:** the PMs, the operator agent, the oversight lead,
  rig orchestrators. Small group, immediately; they will be reviewing every
  later seed.
- **Wave 2 — the priority rig.** (At the time of writing: the build VM — the
  current unblock focus.) Its orchestrator paces its own seats: a few at a
  time, as their work allows, never all at once.
- **Wave 3 — the next rig.** (At the time of writing: the studio rig.)
- **Wave 4 — everyone else, on contact:** a seat reads the skill the first
  time work reaches it under the model. No seat is interrupted just to read.

**Pacing law:** waves are small and self-paced BY DESIGN — this is a
rate-limit safety rule, not a preference. An orchestrator rolling its rig
staggers reads. If a wave would put more than a handful of seats into
simultaneous heavy reading, split the wave.

**The adoption receipt is the seed.** A seat has adopted when its
`LEARNED.md` v1 exists, written BY THAT SEAT in its own words (distilled from
whatever records it has — handover documents, its runtime memory, its queue
history), and reviewed by its orchestrator or PM. Reading without seeding is
not adoption; there is deliberately no other receipt to fake.

**Seeding doubles as the capability audit.** A seat that cannot write its own
MY JOB HERE section has just revealed precisely what its handover lineage
lost. That discovery is a SUCCESS of the rollout, not a failure — it converts
an invisible capability gap into a named, fixable one. Orchestrators: when a
seed comes back thin or confused, that seat needs re-onboarding against its
SOP, not a rewrite of its seed by someone else.

**Hierarchy-seeded exceptions:** empty seats, broken seats, and seats being
re-staffed get their files written by whoever is responsible for them, with
those lines marked as written-for-the-instance. The next real occupant
rewrites them in its own words as a first act.

## Piece 3 — the enforcement floor (no product code required)

Register a watchdog (or any scheduler) per adopted seat that fires
`scripts/trace-due.sh` on a modest cadence. The script no-ops silently unless
enough has actually changed since the seat's last trace, so the schedule can
be dumb while the action stays evidence-gated. When it reports DUE, the seat
runs the trace per SKILL.md §5 and stamps (`scripts/trace-stamp.sh`).
Schedulers, files, and two tiny scripts — that is the entire interim
enforcement system, and it degrades gracefully: if every scheduler dies, the
model still works, just without reminders.

## The dual-home interim (skills are NOT drained yet)

Much altitude-specific knowledge currently lives in the skill layer (pod
handbooks, seat SOPs, fleet doctrine) because the skill layer was the only
durable shelf that existed. The placement rule says that knowledge belongs in
the trees — AND the drain does not happen now. During rollout:

- existing skills remain exactly where they are and remain authoritative;
- the new tree files are built USING them as reference material;
- the same knowledge deliberately lives in both places for a while;
- the drain happens later, deliberately, when the unified skill registry
  lands (see ROADMAP.md) — never as a side effect of the rollout.

## SOP authoring plan (owner-approved 2026-08-10; product team owns)

**Composition (owner-ruled 2026-08-10):** pod SOP = the general layer ·
seat SOP = a TYPE fragment, shared/projected across same-type seats (byte-
identical; occupant edits go to LEARNED, never the fragment; divergence is a
parity scream) · LEARNED = the lived instance. Fragments are authored per TYPE
(roughly ten fleet-wide), never per seat.

**Round 1 — type fragments, by the three-hands pattern:**
1. *Incumbents* of the type dump raw seat-truth to a `SOP-STASH-raw.md`
   (facts as learned, not doctrine), including a **drift-check line**: which
   skills they actually consult vs what their `agent.yaml` declares.
2. *A fresh one-shot author* (single-purpose agent, no continuity required —
   all state lives in files, so the step is robust to handover/compaction
   failures) distills the fragment from a **named reading list**, pinned at
   dispatch with an existence check on every path:
   exemplar fragments (the accepted product-manager fragment + the PM pod
   layer) → the seat's `agents/<role>/agent.yaml` (its `uses.skills` list IS
   the derived canon list) + `guidance/role.md` (the fragment's direct
   ancestor — read AGE-STAMPED; where it disagrees with the STASH, record
   drift, don't resolve) → the 2–4 declared team/role skills →
   `state/onboarding/` material and ADRs where the rig has them → the STASH.
   Constraints inline: ~1 page · type-level only (instance→LEARNED candidates,
   rig-wide→pod/rig layer — the author routes, never dumps) · `Sources:` line ·
   flag gaps, never invent.
3. *Type occupants verify* ("does this describe my job?") and the rig
   orchestrator/PM holds the coherence + placement review.
   **Criterion upgrade (from the wave-1 outside-lineage cold read, 2026-08-11):**
   beyond voice/duties/scars/gaps, review for **SELF-CONSISTENCY** — does the
   file obey its own stated rules? (the wave-1 misses were all files breaking
   their own rule: cached doctrine beside a read-at-source rule; a volatile
   snapshot beside a presence-check rule; an expiry with no trigger beside a
   remembered-follow-up-is-not-a-mechanism rule) — and **POST-SEED ALIVENESS**:
   a one-sitting seed legitimately wears the dated-ledger form, but reviewers
   re-read at ~+2 weeks; a LEARNED that never gains a post-seed entry is a
   monument, not a rail.
   Old artifacts (role.md, agent.yaml, team skills) stay exactly where they
   are and stay authoritative — dual-home until the deliberate drain.
   Order: wave-2 build-VM types first, then oversight, kernel/ops, studio.
   skills-architect spends ZERO tokens now (context-constrained + handover in
   process); their batched consistency pass rides the 0.6 registry drain.

**Binding inputs registered for round-1 fragments** (owner-flagged content
that MUST land in the named fragment; a draft missing its binding input fails
review — this list is read at every one-shot dispatch and at every review):
- **DRIVER type (build VM)** — owner recurrence flag 2026-08-10 (~100th
  correction, zero uptake while it lived only in chat): on the VM, the DEFAULT
  for a runtime defect is the **inner loop** — ground → fix → upgrade the
  daemon in place → test with your own eyes → iterate; ship-rigor once at the
  end; rollback only for a VM that cannot work. The conveyor is not the
  default for a one-mechanism defect.
- **ORCHESTRATOR type (build VM)** — same flag: before routing any defect
  into the conveyor, ask first whether ONE grounded agent with its own
  feedback loop can fix and verify it in place. Conveyor only for what ships
  beyond the VM or touches locked contracts.
- **THE CHOOSER (owner root diagnosis, same conversation, addendum 2026-08-11):**
  the incoherence under the recurrence is that every task gets the identical
  SDLC regardless of shape. Carried as ONE principle, not a rubric: **default =
  the lightest thing that could work** (one agent, own judgment, own feedback
  loop); the conveyor must be EARNED by a stated one-line reason (ships beyond
  VM / public / locked contract / security boundary / multi-hand scope); no
  reason line = light path. The orchestrator fragment carries the triage
  question; the driver fragment carries the inner loop. Deliberately NOT a
  classification taxonomy — a taxonomy would be new ceremony.
- **SHARPER FORM (orch-advisor's self-seeded fold — use this shape):**
  (1) SCAR-vs-LAW — a lesson stated only negatively teaches fear of one
  mistake, and occupants drift back UP because ceremony always FEELS like
  rigor at zero visible cost; the fragment must state the POSITIVE default
  (light; conveyor earns entry with a reason line) because that is what makes
  the choice decidable. (2) THE COROLLARY — a tier chosen correctly once does
  not stay correct; the tier is a function of the atom, not a property the
  atom keeps; RE-CHOOSE whenever the surface changes (specimen: P18 judged
  conveyor-worthy with a config surface, descoped to mostly-deletion, old
  tier = ceremony inherited by momentum). Both belong in the ORCHESTRATOR
  fragment, verbatim-substance.
- **ALL-TYPES binding input (triple-confirmed 2026-08-11: dev50-driver ×4 in
  one night, orch-advisor ×3, pm-openrig desk ×2): THE SCOPED-READ LAW —
  "a scoped read that does not name its scope manufactures a false absence."**
  Every list/show/ps/send resolves against SOME scope (rig, daemon, host,
  registry, filter); a negative result is only evidence within the named
  scope. Every seat-type fragment carries this; reviewers enforce it like the
  chooser.
(Companion folds already in flight at the implicated seats' LEARNED files:
product planning done; operator a947ed35 and advisor 1f89e5d6 owner-directed.)

**Round 2 — ontology backfill per seat, pod, and rig (owner-directed
2026-08-10):** after a node's SOP/LEARNED pair exists, one deliberate
audit pass folds the rest of its scattered wisdom into the walkable layer:
- **Claude memory files** (`~/.claude/projects/*/memory/` per seat) — tribal
  wisdom that is written but almost never re-read (the "learning banked, then
  never consulted again" failure mode this model exists to kill). Each memory
  item either folds into LEARNED/SOP at its altitude or is explicitly
  left as session-scoped; LEARNED folds are executed by the seat itself
  (self-seeded law), playbook-layer folds by the fragment's owner.
- **openrig-work core** — doctrines, `conventions/`, and skills content that
  is really seat/pod/rig practice — same routing, same dual-home rule:
  originals stay in place and authoritative; the trees gain the walkable copy;
  the drain stays a later deliberate act.

## Current status (update this section as waves complete)

- Design locked by the owner: 2026-08-09.
- Skill authored (sole-context authorship) and projected on the primary host:
  2026-08-09. VM projection: operator's leg, with wave 2.
- Wave 1 COMPLETE 2026-08-10: all five coordinator seats seeded + reviewed
  (pm-openrig, pm-lead, watch-lead, pm-studiobox, operator-agent). Wave 2
  (build VM) released the same day; its orchestrator paces.
- First SOPs exist: PM pod layer + product-manager type fragment
  (projected to both product-PM seats) + program-manager type fragment.
- STEERING→INTENT rename: openrig-platform done (owner) · factory anchor +
  openrig-work root done 2026-08-10 (pointers at old names) · studio-boxes =
  pm-studiobox's to execute · idea-ledger-gstack pending its owner.
- The factory is unparked (wave-1 adoption complete).
- NAMING RULED (owner, 2026-08-11): PLAYBOOK.md -> **SOP.md** fleet-wide
  (names are prompts; SOP = the consult-and-follow trigger, factory-native).
  All seven existing files renamed with one-transition pointers at old names;
  LEARNED keeps its name (it is the maturity PIPELINE, and the low-friction
  write-prompt is load-bearing). Projection recipes are **maps** (codemaps,
  the name's prior holder, retire into this system). The corpus/canon
  distribution program = skill **openrig-corpus-canon** (design of record:
  product/DESIGN-context-distribution-2026-08-10.html); round-2's
  hand-fold-canon leg is SUPERSEDED by it — round-2's lived-side leg
  (claude-memory -> LEARNED, seat-executed) continues unchanged.
