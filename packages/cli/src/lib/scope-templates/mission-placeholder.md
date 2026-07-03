---
id: {{id}}
mission: {{mission}}
stage: wip
verified: {{created_date}} against scaffold (rig scope create)
created: {{created_date}}
---

# Mission — {{title}}

## Purpose

[Why this mission exists and what success looks like]

## Slices

[List notable slices and their state]

## Status

[Where the mission is right now]

---

## Mission/Slice SOP — how you work this mission & slice

> The canonical files below are the **operating surface of the work** — you track on them, prove on them, hand off through them, and survive compaction on them. They are NOT side-artifacts to "maintain"; keeping them current *is* the work. Load the `mission-slice-sop` skill for the full operating procedure.

### The canonical files (the operating surface)

- **README.md** (mission + slice) — the overview: what the mission/slice is + why. The **mission README carries this SOP at its bottom.**
- **PROGRESS.md** — the live delivery state. One line per outcome; links down for detail.
- **MISSION_NOTES.md** — the accruing handoff + tribal-knowledge doc. Blank-slate onboarding + **compaction-restore** read it. `§1` top-of-mind + per-seat `§A–§X`.
- **MISSION_BRIEF.md** — the steering doc (the UI "Steering" tab). The 7-section schema.
- **PROOF.md** (+ `proof/`) — acceptance evidence. **A slice is not done until every plan success-criterion has proof.**

### Per-file rules — WHO / WHEN / HOW

- **PROGRESS.md** — WHO: the orchestrator owns `§1` (current state); every agent logs its own outcomes. WHEN: after every slice-done **AND every commit**; on any material state change. HOW: one line per outcome (checkbox), link down for detail; keep frontmatter `stage`/`verified` honest.
- **PROOF.md** — WHO: the impl/QA pair that worked the slice. WHEN: a slice is **NOT "done"** until PROOF.md exists and every plan success-criterion has evidence. HOW: proof maps **1:1 to the plan's acceptance/success criteria** — each criterion gets an evidence artifact in `proof/` + a line in PROOF.md. No proof → not done.
- **MISSION_NOTES.md** — WHO: any agent updates `§1`; each seat owns its own `§A–§X`. WHEN: on any material change; a compacting agent **files its state here BEFORE compaction and reads it on restore.** HOW: accruing tribal knowledge; `§1` ≤ 5–15 lines; pointer-first.
- **MISSION_BRIEF.md** — WHO: product/design (steering owner). WHEN: when steering changes. HOW: the 7-section steering schema (the UI "Steering" tab reads it).
- **README.md** — WHO: the author at creation; refreshed on rescope. WHEN: at creation + when scope/theme changes. HOW: overview + honest frontmatter; the mission README carries this SOP at its bottom.

### The lifecycle (4 legs)

**SCAFFOLD** (`rig scope` creates the files from templates) → **POPULATE** (agents fill them as work happens) → **PROJECT** (the workspace UI reads them into tabs) → **VERIFY** (`rig scope audit` checks adherence). "Loose freeform write + deterministic verify."

### Hot-potato (handoffs)

End every turn by passing the ball — a `rig queue` handoff to the next agent (close the qitem with a `closure_reason`). The **durable ball-pass is the queue close, not a chat message.** Never go idle without a handoff.

### Verify (deterministic backstop)

Run `rig scope audit` at slice-close. It flags: committed-without-touching-PROGRESS; slice-marked-done-without-PROOF; active-mission-without-MISSION_NOTES; MISSION_BRIEF off-schema. **Fix the flag, don't suppress it.**

### Moment-of-truth checklist

- **Finishing a slice?** → PROOF complete (every criterion has evidence)? PROGRESS updated? MISSION_NOTES `§1` refreshed? Handed off via queue?
- **Committing?** → PROGRESS updated?
- **Compacting?** → filed your state in MISSION_NOTES?
- **Starting on a mission?** → read the mission README (incl. this SOP) + MISSION_NOTES?
