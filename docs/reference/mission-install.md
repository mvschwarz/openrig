---
doc: reference
title: The mission install — the project half of agent onboarding
stage: established
warrant: >-
  Minted 2026-08-28 from three lived installs run before this convention was written
  (receipts preserved in the minting slice's proof directory): a full five-layer seat
  rebuild with a verified correction round, a release-boundary re-prime of a whole team
  at two depths, and a successor install composed entirely from a mission's own
  artifacts. Confirmed by a three-leg research round: the anatomy maps 1:1 onto the
  shipped three-source composition contract, push-composition is convergent practice in
  independent agent systems, and the only measured causal evidence available supports
  composing authored artifacts over generating summaries.
sources:
  - the minting slice's SPEC design-contract block (recorded direction, decisions, prototypes)
  - the minting slice's research synthesis (machinery table, tensions, evidence weights)
  - docs/reference/sdlc-conventions.md (the build conventions this composes with)
---

# The mission install

An agent joining work needs two installs. The **world install** teaches the system it
now lives in — what this place is, how to act, what it can do. The **mission install**
teaches the project — what is being built, how it got here, where it stands, and what
is theirs to do. This document is the convention for the second half. It applies to any
project a mission tree can hold: software, a book, accounting, research.

**The reader who cannot help you wrote this convention.** A freshly started or freshly
cleared agent cannot pull context — it does not know what exists, so it cannot ask.
Every rule below follows from that: the install is **composed on the agent's behalf and
pushed**, piece by piece, by someone who already holds the project.

## When to run one

- A fresh seat joins a mission.
- An occupant handover: the successor inherits the seat, then gets the project.
- A release or phase boundary: every continuing seat re-primes on the new frontier.
- A project switch: a seat moves from one mission to another.

Always AFTER the world install. The mission install assumes a situated reader.

## The five layers

Compose every install from these layers, in this order. They are a skeleton, not a
script — depth profiles (below) select how much of each layer a given seat receives.

1. **PIECES** — the authored history and design: the artifacts that explain how the
   project got to now. Composed by address from the mission tree, each piece carrying
   its source path and content hash. Never paraphrased.
2. **ARRANGEMENT** — how the pieces connect. This is the one layer whose content is
   not on disk anywhere else: an authored recap by someone who held the work, stating
   what joins the pieces, what to trust, and what supersedes what. If no arrangement
   document exists, writing one is part of preparing the install — it is the
   dispatcher's knowledge, deposited.
3. **POSITION** — what this seat specifically has learned and holds: its accumulated
   lessons file and its most recent recap. Position is private to the lineage; it is
   installed, never published.
4. **CONTRACT** — the current plan and the open decisions. This is the fastest-moving
   layer, so every contract piece must carry its own `updated-at`, and any fact not
   re-derived at compose time carries an explicit `UNVERIFIED` marker. A stale plan
   misleads more than a missing one.
5. **DERIVE-YOUR-OWN-DELTA** — the final walked piece assigns a **derive list**: the
   volatile facts the installee must re-derive itself, each stated as the command that
   derives it (never as a remembered value). The installee runs the list and writes a
   **dated delta** — what is true now that the install did not say — as its first
   artifact, homed beside the seat's recap. This is the layer that turns a briefing
   into an instrument check.

## Two depth profiles

- **Planning-class seats get FULL depth**: the complete ordered read set across all
  five layers, ending at the live work pointer (the current plan's own next item).
- **Execution-class seats get HIGH-ALTITUDE depth**: a handful of addressed reads —
  the project frame, the governing scope contract, the source index, the operating
  playbook — plus layer 5. Slice-level depth deliberately arrives LATER, with each
  routed work item, whose own spec opens with its full design contract.

The situation (fresh, handover, boundary, switch) selects subsets over the layers;
the seat class selects depth. Do not send everyone everything. Two invariants hold at
every depth: **the arrangement layer is never skipped** (it is what tells the reader
whom to trust), and **a profile slot with no matching artifact is never authored at
install time** — fill it with a derived listing (add it to the derive list) or leave
it empty and say so.

## Delivery rules

- **Push, composed on the agent's behalf.** The dispatcher composes; the installee
  receives. One piece per message, paced, with room to absorb between pieces — a
  concatenated dump of the same bytes is a failed delivery regardless of content.
- **Pointer-walk by default**: for a world-installed seat, each paced message names
  the artifact to read and frames the read as a prerequisite to the seat's own next
  task. The seat executes the read itself; reading is the install.
- **Byte-walk only where the seat cannot read** (no file access, cross-machine
  delivery): then the walk carries the bytes, in pieces, never as one block.
- **Ask for a reaction per piece** where consumption matters: one line stating what
  the piece changes for the reader. A silent walk is unverified delivery.
- **A pointer may be section-scoped.** When one file mixes install content with
  reference material, the pointer names the sections to read and the sections that
  are reference; the reader's reaction names the sections actually read. Splitting
  the file is better when two consumers keep needing different subsets.

## Mission-selected execution components

A mission may carry `mission.yaml`, and a slice may carry `slice.yaml`, as an
address map for the work arrangement. When present, install `mission.yaml` in
the ARRANGEMENT layer and the active `slice.yaml` in the CONTRACT layer. Read
the mission file first; the slice may narrow or override mission defaults.

The reusable component catalog is repo
`docs/reference/product-journey-sdlc.md` and installed
`$OPENRIG_HOME/reference/product-journey-sdlc.md`. A catalog with
`root: repository` resolves from `git rev-parse --show-toplevel`; use the
`loading-addressable-markdown` skill for addressed H2/H3 sections.

Before the installee claims work, require one readiness statement naming:
**role; user outcome; starting candidate; boundaries**. The selected component
IDs and explicit edges arrange the work; they do not expand scope, create a
mode, or enforce gates. If no composition exists, the light Part A flow in
`mission-slice-sop` is complete—absence is not a reason to mint YAML.

## Composition, not generation

The install **composes authored, cited artifacts. It never generates summary prose at
install time.** A generated summary is a second source that drifts and cannot be
trusted or verified; an authored piece carries its provenance. The one place authorship
is created for the install is the arrangement layer — and that is deposited knowledge
written by someone accountable for it, kept and reused, not regenerated per install.

## The exclusion rule

A mission tree accumulates material that is **reference, never install content**:
incident residue, superseded planning, transcript archives, dead ends kept for the
record. The install inherits a **cleaned** view — current truth plus the arrangement's
account of how it got there. Excluded material stays addressable; the arrangement may
point at it, but the walk never carries it. When preparing an install, sort every
candidate piece: install content, or reference. If unsure, it is reference.

## The layer-5 verification loop

Layer 5 is a sequence, not a suggestion. Run all of it:

1. The dispatcher's final walked piece assigns the derive list — each volatile fact
   paired with the command that derives it — **and names the exact destination path
   for the delta** (a fresh seat has no recap yet to sit beside; the dispatcher
   decides the home, the installee does not guess).
2. The installee runs every command and writes the dated delta at the named path.
3. The dispatcher verifies the artifact **exists** (not that it is claimed).
4. A second reader — anyone but the installee — checks the delta's **facts**. When
   the project has only a dispatcher and an installee, the dispatcher performs the
   fact check and the delta records that the check was self-performed — an honest
   degradation, stated, never silent.
5. A factual error triggers a re-derive round: the installee re-runs the commands,
   corrects, and reseals the delta. The correction round is value, not overhead:
   it verifies consumption and calibrates the instrument in one act.

A volatile fact with **no deriving command** — one only a human or external party can
settle — goes on the list anyway, marked `UNVERIFIED` with an explicit
ask-instruction; the delta carries it forward unresolved rather than silently
adopting a value.

An install without a landed, checked delta is not complete. It is a broadcast.

## The fidelity law

Design detail that lives in conversation gets **deposited at mint time**. A work item
whose spec holds only a one-line intent, when the real design filled a discussion, is
a 20:1 compression — and building from it makes correctness a coincidence. The
convention therefore names where deposited design lives: the work item's own
**design-contract block** (or a DESIGN-INPUT file beside it). Layer-1 pieces point at
that full-fidelity record, never at the compressed intent line.

## The boundary

**The mission install stops at the mission root.** Everything above it — what the
wider system is, the team's shape, the culture — belongs to the world install, which
runs first. Tracing above the project root is a separate tool for a separate question.
One install, one tree.

## Composing with the shipped machinery

The layers compose from surfaces that already exist; no new mechanism is required:

- Pieces and contract: one `--mission` grant spans the mission and its slices —
  `rig context profile <pack-ref> --situation <fresh|handover|post-compaction> --mission <mission>`
  composes addressed sections with per-piece provenance and content hashes. The
  `--situation` flag is required and is a SEPARATE input from the depth profile:
  situation says which composition menu applies (fresh boot, occupant handover,
  post-compaction restore); FULL vs HIGH-ALTITUDE says how much of each layer the
  seat class receives. Choose both, independently.
- Position: the `--rig`/`--seat` grant serves the seat's lessons and recap.
- Delivery: `rig walk <seat> --through <files> --pace <interval>` for byte-walks;
  paced sends naming addressed reads for pointer-walks.
- The delta: a dated markdown file beside the seat's recap; verified by reading it.

Where these verbs are unavailable (a different toolchain, a plain filesystem), the
convention still holds: compose by copying addressed sections with their source paths,
deliver paced, assign the derive list, require the delta.

## Quickstart for any project

1. Sort the mission's artifacts: install content vs reference (the exclusion rule).
2. Write or update the arrangement document — how the pieces connect, what to trust.
3. Mark every contract piece with `updated-at`; mark underived facts `UNVERIFIED`.
4. Choose the profile: planning-class full, or execution-class high-altitude.
5. If mission/slice YAML selects execution components, include those files and
   their addressed catalog sections at the appropriate layers.
6. Compose the ordered piece list with provenance; deliver it paced, pointer-first.
7. End with the derive list; require the dated delta; verify existence; second-read
   the facts; re-derive on error.

A project of any kind fits this: for a book, the pieces are the outline's history and
voice decisions, the arrangement is how the drafts relate, the position is this
editor-seat's lessons, the contract is the current chapter plan with its dates, and
the derive list is "count the chapters, read the latest editorial notes, state today's
word count" — facts the new agent must touch, not trust.
