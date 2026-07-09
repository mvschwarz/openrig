---
name: mission-slice-sop
description: Use when working a mission or slice — the full SDLC flow (intent → mini-requirements + proof contract → mockups → plan-lock → build → QA visual compare → `rig proof` drops → proof-lock) plus how to track, prove, hand off, and carry state across agents and compaction via the canonical files (PROGRESS.md / PROOF.md / MISSION_NOTES.md / MISSION_BRIEF.md / README.md / IMPLEMENTATION-PRD.md). Covers the convention sections the Living Notes UI projects, the two locks, the three role contracts, per-file WHO/WHEN/HOW rules, the four-legs lifecycle, hot-potato queue handoffs, the moment-of-truth checklist, the deterministic `rig scope audit` backstop, and the ghost-text capture gotcha.
metadata:
  openrig:
    stage: shipped
    last_verified: "2026-07-06"
    distribution_scope: product-bound
    source_evidence: |
      The canonical product SDLC skill: it teaches the full SDLC flow the
      Living Notes UI projects — the convention sections, the proof-contract
      pairing, the two staged-approval locks, C1 proof drops, and the three
      role contracts. Conventions SSOT: docs/reference/sdlc-conventions.md
      (shipped with the CLI package). The deterministic backstop is the
      `rig scope audit` classifier.
    sibling_skills:
      - queue-handoff
      - seat-continuity-and-handover
      - claude-compaction-restore
---

# Mission/Slice SOP — how you work a mission & slice

Use this skill to actually **do** mission/slice work the way OpenRig expects: author the convention sections, track on the canonical files, prove on them, hand off through them, and survive compaction on them. **Do the work described here; do not merely explain the protocol.** The deterministic backstop is `rig scope audit` — the audit classifier is the source of truth for adherence. The conventions themselves live in ONE place: **`docs/reference/sdlc-conventions.md`** (shipped with the CLI package) — this skill teaches the flow; the SSOT defines the formats.

## The SDLC flow (intent → proof)

```
intent → mini-requirements + proof contract → (UI slices: mockups)
      → plan-lock (rig scope slice approve --scope spec)
      → build the LOCKED set
      → QA: mockup ↔ delivered VISUAL compare
      → proof drops (rig proof add <slice> …)
      → proof-lock (rig scope slice approve --scope delivery)
```

1. **Record intent** verbatim in the slice's `## Intent` section (`rig scope slice create` scaffolds it — every template kind).
2. **Author the mini-requirements + proof contract**: `## Mini-requirements` is the concise one-glance tier (approval starts there); `## Proof contract` is a checkbox list of promised deliverables, each written as an observable outcome. UI deliverables name their planned mockup. The IMPLEMENTATION-PRD opens with the mini-requirements; everything between intent and proof is **elastic** — for a small slice the mini-requirements may BE the whole PRD.
3. **Plan-lock**: `rig scope slice approve <slice> --scope spec` — "the PRD matches the intent; THIS artifact set is what gets built." One daemon-side write: frontmatter stamp + append-only audit row.
4. **Build the locked set** — look at the mockups, not just the spec text.
5. **QA visual compare**: for each deliverable, load the planned mockup, produce the real artifact in a test/demo environment, visually compare, and record the verdict.
6. **Drop proof**: `rig proof add <slice> --artifact-type qa --verdict PASS --candidate-sha <tip> --money-evidence "…" --evidences "1,3" --media "walk.webm,panel.png" --self-check "…"` — the C1 header's closed sets validate at drop time; `--evidences` joins the drop to its proof-contract items and `--media` names the curated proof/-relative media the drop stands behind (that pairing + media set is what the UI's DELIVERED section renders).
7. **Proof-lock**: `rig scope slice approve <slice> --scope delivery` — the terminal sign-off. Approval is freeze/sign-off, **never** proven-green: proven-green requires the recorded C1 verdicts.

## The three role contracts

- **Planning agent:** authors intent + mini-requirements + the proof contract; produces mockups for UI deliverables and attaches them to the locked set (a UI slice with no mockup is an incomplete plan; non-UI slices have none — not a gate); locks the plan.
- **Build agent:** builds against the LOCKED set only; looks at the mockups.
- **QA agent (owns the compare):** visually compares planned vs delivered per deliverable, records verdict + note via proof drops, and **curates** the canonical proof set (bounded, mapped to deliverables; the fix-loop pile stays in `proof/`, one drill-in down). On mismatch: fix-and-re-review or kick back with the reason — never escalate a raw mismatch to the human.

## The canonical files (the operating surface)

> The canonical files below are the **operating surface of the work** — you track on them, prove on them, hand off through them, and survive compaction on them. They are NOT side-artifacts to "maintain"; keeping them current *is* the work.

- **README.md** (mission + slice) — the overview, OPENING with the convention sections (`## Intent` / `## Mini-requirements` / `## Proof contract`). The **mission README carries this SOP at its bottom.**
- **IMPLEMENTATION-PRD.md** — the full PRD; opens with the mini-requirements; the `## Proof contract` here is what the UI's DELIVERED pairing joins proof against.
- **PROGRESS.md** — the live delivery state. One line per outcome; links down for detail.
- **MISSION_NOTES.md** — the accruing handoff + tribal-knowledge doc. Blank-slate onboarding + **compaction-restore** read it. `§1` top-of-mind + per-seat `§A–§X`.
- **MISSION_BRIEF.md** — the steering doc (the UI "Steering" tab). The 7-section schema.
- **PROOF.md** (+ `proof/`) — acceptance evidence. **A slice is not done until every proof-contract item has evidence.**

## Per-file rules — WHO / WHEN / HOW

### PROGRESS.md
- **WHO:** the orchestrator owns `§1` (current state); every agent logs its own outcomes.
- **WHEN:** after every slice-done **AND every commit**; on any material state change.
- **HOW:** one line per outcome (checkbox), link down for detail (workstream-continuity format); keep frontmatter `stage`/`verified` honest.

### PROOF.md + proof/
- **WHO:** the impl/QA pair that worked the slice.
- **WHEN:** a slice is **NOT "done"** until every proof-contract item has evidence.
- **HOW:** proof maps **1:1 to the proof contract's deliverables** — put media under `proof/`, then ATTACH it with `rig proof add <slice> … --evidences <item> --media <files>` (the drop writes the C1 header the DELIVERED pairing joins on) + a line in PROOF.md stating what it proves. **Hand-placing files in `proof/` without a drop is the anti-pattern** — the deliverable stays unpaired and `unverified`. No proof → not done.

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
- **HOW:** overview + honest frontmatter (`id`/`stage`/`verified`) + the convention sections up top; the mission README carries this SOP at its bottom.

## The lifecycle (4 legs)

**SCAFFOLD** (`rig scope` creates the files from templates — every slice kind emits the convention sections + `proof/` + the IMPLEMENTATION-PRD skeleton) → **POPULATE** (agents fill them as work happens, per the rules above) → **PROJECT** (the Living Notes UI reads them into INTENT → PLAN → DELIVERED) → **VERIFY** (`rig scope audit` checks adherence). "Loose freeform write + deterministic verify."

## Hot-potato (handoffs)

End every turn by passing the ball — a `rig queue` handoff to the next agent (close the qitem with a `closure_reason`). The **durable ball-pass is the queue close, not a chat message.** Never go idle without a handoff.

## Verify (deterministic backstop)

Run `rig scope audit` at slice-close. It flags: committed-without-touching-PROGRESS; slice-marked-done-without-PROOF; active-mission-without-MISSION_NOTES; MISSION_BRIEF off-schema; proof artifacts violating the C1 header; missing IMPLEMENTATION-PRD on a building slice; missing convention sections (`## Intent`, a well-formed `## Proof contract`, the UI-slice mockup ref). Every convention check is **advisory / fail-open** — it records and advises, never blocks a write. **Fix the flag, don't suppress it.**

## Reading terminal captures — KNOWN GOTCHA: ghost-text autocomplete is NOT real

When you `rig capture` a pane, **greyed / ghost autocomplete suggestions are NOT real content** — they are autocomplete *previews* (shell autosuggestion, the input-box ghost-text completion), not typed, staged, or committed input. **This is known, expected, and has been faking agents out a lot** — reading a ghost suggestion in a peer's input box as "staged text they're about to send," or as a real prompt, and then reasoning/acting on a string that was never actually there.

**Rule:** ignore ghost/autosuggest text entirely. Only *committed/rendered* pane output is real. If a `❯` input line shows text, treat it as an autocomplete artifact unless you have independent evidence it was actually entered. Do not build decisions (or worry about "colliding with staged text") on ghost text. When it matters, verify at source (git, the queue, the actual event) — never off a capture's ghost line.

## Moment-of-truth checklist

- **Starting a slice?** → intent recorded verbatim? mini-requirements + proof contract authored? mockups attached (UI slices)? plan locked (`--scope spec`)?
- **Finishing a slice?** → every proof-contract item has curated evidence via `rig proof add … --evidences --media` (C1 drops — never only hand-placed files)? PROGRESS updated? MISSION_NOTES `§1` refreshed? proof locked (`--scope delivery`)? Handed off via queue?
- **Committing?** → PROGRESS updated?
- **Compacting?** → filed your state in MISSION_NOTES?
- **Starting on a mission?** → read the mission README (incl. this SOP) + MISSION_NOTES + `docs/reference/sdlc-conventions.md`?
