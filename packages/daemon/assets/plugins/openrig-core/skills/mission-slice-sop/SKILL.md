---
name: mission-slice-sop
description: Use when working a mission or slice — how to track, prove, hand off, and carry state across agents and compaction via the canonical files (PROGRESS.md / PROOF.md / MISSION_NOTES.md / MISSION_BRIEF.md / README.md). Covers the per-file WHO/WHEN/HOW rules, the four-legs lifecycle (SCAFFOLD/POPULATE/PROJECT/VERIFY), hot-potato queue handoffs, the moment-of-truth checklist, the deterministic `rig scope audit` backstop, and the known ghost-text gotcha when reading terminal captures.
metadata:
  openrig:
    stage: shipped
    last_verified: "2026-07-03"
    distribution_scope: product-bound
    source_evidence: |
      Authored + embedded in release-0.4.3 slice 32 (mission-slice-sop). The
      canonical SOP is the operating surface for mission/slice work: the
      PROGRESS / PROOF / MISSION_NOTES / MISSION_BRIEF files drive the workspace
      UI and carry state across agents + compaction. Operationalizes the
      markdown-control-plane convention (loose freeform write + deterministic
      verify) and the shipped `rig scope audit` classifier — the deterministic
      backstop is the audit, not standalone check scripts.
    sibling_skills:
      - queue-handoff
      - seat-continuity-and-handover
      - claude-compaction-restore
---

# Mission/Slice SOP — how you work a mission & slice

Use this skill to actually **do** mission/slice work the way OpenRig expects: track on the canonical files, prove on them, hand off through them, and survive compaction on them. **Do the work described here; do not merely explain the protocol.** The deterministic backstop is `rig scope audit` — there are no separate bundled check scripts; the audit classifier is the source of truth for adherence.

> The canonical files below are the **operating surface of the work** — you track on them, prove on them, hand off through them, and survive compaction on them. They are NOT side-artifacts to "maintain"; keeping them current *is* the work.

## The canonical files (the operating surface)

- **README.md** (mission + slice) — the overview: what the mission/slice is + why. The **mission README carries this SOP at its bottom.**
- **PROGRESS.md** — the live delivery state. One line per outcome; links down for detail.
- **MISSION_NOTES.md** — the accruing handoff + tribal-knowledge doc. Blank-slate onboarding + **compaction-restore** read it. `§1` top-of-mind + per-seat `§A–§X`.
- **MISSION_BRIEF.md** — the steering doc (the UI "Steering" tab). The 7-section schema.
- **PROOF.md** (+ `proof/`) — acceptance evidence. **A slice is not done until every plan success-criterion has proof.**

## Per-file rules — WHO / WHEN / HOW

### PROGRESS.md
- **WHO:** the orchestrator owns `§1` (current state); every agent logs its own outcomes.
- **WHEN:** after every slice-done **AND every commit**; on any material state change.
- **HOW:** one line per outcome (checkbox), link down for detail (workstream-continuity format); keep frontmatter `stage`/`verified` honest.

### PROOF.md
- **WHO:** the impl/QA pair that worked the slice.
- **WHEN:** a slice is **NOT "done"** until PROOF.md exists and every plan success-criterion has evidence.
- **HOW:** proof maps **1:1 to the plan's acceptance/success criteria** — each criterion gets an evidence artifact (screenshot/capture/log) in `proof/` + a line in PROOF.md stating what it proves. No proof → not done.

### MISSION_NOTES.md
- **WHO:** any agent updates `§1` (top-of-mind); each seat owns + appends to its own `§A–§X` section.
- **WHEN:** on any material change; a compacting agent **files its state here BEFORE compaction and reads it on restore.**
- **HOW:** accruing tribal knowledge — `§1` ≤ 5–15 lines (gates, open decisions, surprises); per-seat continuation entries (latest = truth; other seats read-only). Pointer-first; don't duplicate.

### MISSION_BRIEF.md
- **WHO:** product/design (steering owner).
- **WHEN:** when steering changes.
- **HOW:** the 7-section steering schema (the UI "Steering" tab reads it).

### README.md
- **WHO:** the author at creation; refreshed on rescope.
- **WHEN:** at mission/slice creation + when scope/theme changes.
- **HOW:** overview + honest frontmatter (`id`/`stage`/`verified`); the mission README carries this SOP at its bottom.

## The lifecycle (4 legs)

**SCAFFOLD** (`rig scope` creates the files from templates) → **POPULATE** (agents fill them as work happens, per the rules above) → **PROJECT** (the workspace UI reads them into tabs) → **VERIFY** (`rig scope audit` + the validation scripts check adherence). "Loose freeform write + deterministic verify."

## Hot-potato (handoffs)

End every turn by passing the ball — a `rig queue` handoff to the next agent (close the qitem with a `closure_reason`). The **durable ball-pass is the queue close, not a chat message.** Never go idle without a handoff.

## Verify (deterministic backstop)

Run `rig scope audit` at slice-close. The validation scripts flag: committed-without-touching-PROGRESS; slice-marked-done-without-PROOF; active-mission-without-MISSION_NOTES; MISSION_BRIEF off-schema. **Fix the flag, don't suppress it.**

## Reading terminal captures — KNOWN GOTCHA: ghost-text autocomplete is NOT real

When you `rig capture` a pane, **greyed / ghost autocomplete suggestions are NOT real content** — they are autocomplete *previews* (shell autosuggestion, the input-box ghost-text completion), not typed, staged, or committed input. **This is known, expected, and has been faking agents out a lot** — reading a ghost suggestion in a peer's input box as "staged text they're about to send," or as a real prompt, and then reasoning/acting on a string that was never actually there.

**Rule:** ignore ghost/autosuggest text entirely. Only *committed/rendered* pane output is real. If a `❯` input line shows text, treat it as an autocomplete artifact unless you have independent evidence it was actually entered. Do not build decisions (or worry about "colliding with staged text") on ghost text. When it matters, verify at source (git, the queue, the actual event) — never off a capture's ghost line.

## Moment-of-truth checklist

- **Finishing a slice?** → PROOF complete (every criterion has evidence)? PROGRESS updated? MISSION_NOTES `§1` refreshed? Handed off via queue?
- **Committing?** → PROGRESS updated?
- **Compacting?** → filed your state in MISSION_NOTES?
- **Starting on a mission?** → read the mission README (incl. this SOP) + MISSION_NOTES?
