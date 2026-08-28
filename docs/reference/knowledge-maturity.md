---
doc: reference
title: Knowledge maturity — the epistemic ladder
stage: established
warrant: >-
  RECOVERED 2026-08-28 (slice OPR.0.5.6.9). The ladder's prior defining documents
  (skill-maturity-convention.md; the EMM knowledge schema) were verified absent from
  this machine by enumeration (2026-08-28 survey). This document re-authors the model
  faithfully from the founder-direct design session capture
  product/DESIGN-context-distribution-2026-08-10.html §1–2 (near-verbatim ground) and
  §5, bound by founder rulings 2026-08-28 (maturity is multi-dimensional; the ladder
  CONCEPT is the product ingredient, tier counts non-normative; machinery waits for
  ~6.2/6.3, labeling starts now).
sources:
  - product/DESIGN-context-distribution-2026-08-10.html §1–2, §3b, §5 (corpus; the recoverable source of record)
  - release-0.5.6 slice 09 design contract (founder rulings 2026-08-28, desk-locked)
  - corpus/canon/chooser/the-chooser.md and corpus/canon/laws/scoped-read.md (lived warrant practice, two grades)
  - context-engineering-v2 operating-model.md §4 (audience vs maturity)
  - conventions/feature-lifecycle-convention.md (the orthogonal lifecycle axis)
---

# Knowledge maturity — the epistemic ladder

**This document is the addressed canonical home for the maturity model**: the ladder,
its timescales, promotion and demotion, the warrant rule, and where maturity is
carried on each surface. Documents that previously defined this model are absent from
this machine; citations to them should point here. A corpus that cannot state its own
trust model cannot tell you it is rotting — that is why this document exists.

## The ladder

Knowledge climbs four rungs:

**DATA → FIELD NOTES / OBSERVATIONS → INSIGHTS → CANON**

Trust tracks maturity, and **a claim's address tells you its trust**. Each rung's
expected rate of change is roughly an order slower than the one below:

| Rung | Timescale of change | Where it lives (by address) |
|---|---|---|
| Canon | years — "it was always true; we only discover and curate it" | `conventions/` · `doctrine/` · primitives · `SOP.md` · `CULTURE.md` |
| Insights | months — stable, still earning | the upper half of `LEARNED.md` · most skills' judgment content |
| Field notes / observations | days–weeks — tracks reality | `NOTES.md` · the raw half of `LEARNED.md` · `field-notes/` |
| Data | continuous | stream events · transcripts · receipts · logs |

## Canon is defined by its timescale

"What makes something canon is that its expected rate of change is very long."
Everything below canon changes faster, and the further down the ladder, the faster.
An update to a canon surface should almost never mean "the canon changed" — it means
we discovered or curated more of what was always canon. `LEARNED.md` is the file that
tracks a changing reality; `SOP.md` is the file that accretes settled truth.

The lived consequence: **a canon diff should read as addition.** Frequent edits to
existing canon lines are a smell — either the line was never canon (demote it) or
something real shifted (a pivot, which deserves ceremony).

## Promotion and demotion

Promotion is an explicit act at each rung: **harvest / notice → fold, in own words →
curate (explicit, dated).** Content enters the lived layer (`LEARNED.md`) at whatever
maturity it has, proves itself stable over time, and graduates.

Discovery flows up; canon almost never flows back down — and "when canon flows back
down, that's a demotion event worth noticing." **Demotion is legal but LOUD**: the
2026-08-10 levelset demoted three generations of assumed-canon in one ruling, which is
the principle lived, not violated.

## The warrant rule

**A promoted claim carries its compressed warrant** — the scar, evidence, or ruling
that earned it travels with it. "Canon without warrants is cargo cult with good
formatting." The populated canon tree is the lived specimen: `canon/chooser/the-chooser.md`
carries a FOUNDER-RULED warrant, `canon/laws/scoped-read.md` a TRIPLE-CONFIRMED one —
two different grades, and the difference is legible precisely because the warrant
states it. This document's own frontmatter practices the rule.

## Maturity is multi-dimensional

The epistemic ladder above is one dimension. A second is the
**context-architecture ladder** (founder ruling 2026-08-28): how context itself is
produced, with prose-in-a-world-shape at the bottom rung — comprehensible, effective,
and prone to drift — and derived-from-source at the top, where content cannot rot
because a command re-derives it.

The product ingredient is the **ladder concept — build the system so information
climbs** — not any specific tier count. Tier counts here are descriptive, not
normative. Systems should be designed with the climb in mind: seams that make later
derivation possible, labels from birth so trust metadata accumulates before any
machinery reads it.

## Two encodings, one ladder

Maturity is carried differently per surface. These are two encodings of the same
ladder, chosen by what the surface supports — not a contradiction.

**Corpus and tree files carry maturity by ADDRESS.** The filename law is the ladder:
`NOTES.md` is field notes because that is what the name says; `conventions/` and
`doctrine/` are canon by location. Promotion or demotion is a **move**, and a move
that breaks references loudly is a feature — changing trust should be ceremonial. No
per-section level tags are needed; the address is the tag.

**Pack, lore, and scope items carry maturity as a stage FIELD from birth**, using the
shipped vocabulary (verified against the live `rig scope slice stage` surface and the
`Stage` type at the source, 2026-08-28 — four rungs plus two exits):

`wip | provisional | established | canonical | superseded | retired`

`superseded` must name its successor; `retired` means do-not-use. These are the ONLY
valid values — invented stages (shape, shaped, draft) are rejected. Items minted under
new conventions carry a stage from birth: labeling from day one is free, retrofitting
is archaeology.

This section is the stage-vocabulary source for lore and pack work (slice 08 cites
it). The taxonomy axis (WORLD / LORE / SKILLS / MISSION) is orthogonal to stage:
**taxonomy says what kind, stage says how trusted.**

## What maturity is not

Two axes are habitually conflated with maturity and are not it:

- **Audience / placement.** Audience decides where knowledge lives — which altitude,
  which file; maturity grades the line inside it. A pod-level item can be raw
  observation, a seat-level one can be canon. Promotion to canon is a maturity event,
  not a move up the tree. Facts about mechanisms can skip rungs (a one-command
  verification settles them); inferences about practice must accrue evidence.
  (operating-model §4.)
- **Feature lifecycle.** "Feature lifecycle is separate from epistemic maturity" —
  lifecycle (`active | deprecated | retired`) answers whether agents should still
  build on a behavior; maturity answers how trustworthy a piece of knowledge is.
  (feature-lifecycle convention.)

## Direction, not construction

The recovered source sketches an end-state — a level-first corpus tree where one
address string carries trust, domain, claim, and freshness at once — and marks it
"may not survive contact with reality." It is cited here as direction only. **Nothing
in this document is mechanized**: no enforcement tooling, no mass relabeling, no new
tier scheme. Ladder machinery (readers, parity checks, promotion tooling) is expected
around 6.2/6.3; what starts now is the vocabulary above and labeling from birth.
