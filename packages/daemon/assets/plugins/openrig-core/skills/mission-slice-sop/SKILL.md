---
name: mission-slice-sop
description: >-
  Use when starting, building, handing off, restoring, or closing a mission or slice under the default lightweight SDLC.
metadata:
  openrig:
    stage: shipped
    sibling_skills:
      - queue-handoff
      - seat-continuity-and-handover
      - claude-compaction-restore
---

# Mission/Slice SOP — Part A

Use this skill to actually **do** mission/slice work: track on the canonical files, record what you proved, hand off through them, and survive compaction on them. **Do the work described here; do not merely explain the protocol.**

**Full convention SSOT:** repo `docs/reference/sdlc-conventions.md`; installed `$OPENRIG_HOME/reference/sdlc-conventions.md`. This skill is the concise Part-A teaching surface and does not replace the full convention.

## THIS IS THE LIGHT DEFAULT — read this before anything else

**The default for any slice is the inner loop:** ground yourself → build → **test with your own eyes** → iterate → **ONE** full-breadth review at the end. That is the whole process. It is not a reduced form of a better process; it IS the process.

**Part B is defined in the SSOT above and applies only when the human operator — or an orchestrator explicitly relaying that decision — assigns it to a named piece of work.** You may not select it yourself. If you believe something earns it, say so in one sentence and **continue on Part A** until told otherwise.

## Proportionality — this SOP serves shipping; it is not the work itself

The working product is the deliverable. This bookkeeping exists so the work survives handoff, compaction, and review — nothing more. **Match it to stakes.** The `rig scope audit` backstop is **advisory and fail-open**: it never blocks a build and is not a gate you clear before proceeding. If you're spending more time on the convention files or the audit than on the running product, stop and go build. Running the full apparatus on a small change is the letter-worship failure, not diligence.

## The three role contracts

- **Planning agent:** records what the slice is for and what "done" looks like, in the slice's own words; produces mockups for UI deliverables so the builder has something to look at (a UI slice with no mockup is an incomplete plan; non-UI slices have none — not a gate).
- **Build agent:** builds it, and **looks at the mockups**. Verifies by running the thing.
- **QA agent (owns the compare):** compares planned vs delivered per deliverable, records the verdict and the note. On mismatch: fix-and-re-review, or kick back with the reason — never escalate a raw mismatch to the human.

These three are a division of labour, not a chain of gates. One agent may hold all three on a small slice.

## The current file contract

> These files are the **operating surface of the work** — you track on them, record on them, hand off through them, and survive compaction on them. Keep them current because that is what lets the work survive. But they **serve** the product; they are not the product. If you're polishing files while the actual thing isn't shipping, you've inverted it: go build, then update them.

- **Slice:** `SPEC.md`, `PROGRESS.md`, `PROOF.md`, and `proof/`.
- **Mission:** `SPEC.md` and `NOTES.md`.

## Per-file rules — WHO / WHEN / HOW

### SPEC.md
- **WHO:** the planning owner authors it; builders and reviewers read it as the scope and intent source.
- **WHEN:** at creation and whenever scope changes.
- **HOW:** a slice carries `intent:` in frontmatter and opens with `## Intent`, `## Mini-requirements`, and `## Proof contract`. A mission carries its intent and mission-level specification in the same authored node file. Keep depth proportional to the work.

### PROGRESS.md
- **WHO:** the orchestrator owns `§1` (current state); every agent logs its own outcomes.
- **WHEN:** on material delivery-state changes and at acceptance.
- **HOW:** one line per outcome (checkbox), link down for detail; keep frontmatter `stage`/`verified` honest.

### PROOF.md + proof/
- **WHO:** the impl/QA pair that worked the slice.
- **WHEN:** before you call a slice done.
- **HOW:** say what you verified and how you verified it — **by effect**: you ran it and looked at the result. Put supporting media under `proof/`. State plainly what is proven and what is **not**; an honest "this half is untested" is worth more than a checkmark. If a drop verb is in play for this slice, prefer it over hand-placing files so the artifact carries its own provenance.

### NOTES.md
- **WHO:** any agent updates `§1` (top-of-mind); each seat owns and appends to its own `§A–§X`.
- **WHEN:** on material mission-context changes; a compacting agent **files its state here BEFORE compaction and reads it on restore.**
- **HOW:** accruing tribal knowledge — `§1` ≤ 5–15 lines (gates, open decisions, surprises); per-seat continuation entries (latest = truth; other seats read-only). Pointer-first; don't duplicate.

## The lifecycle (4 legs)

**SCAFFOLD** (`rig scope` creates the files from templates) → **POPULATE** (agents fill them as work happens) → **PROJECT** (the Living Notes UI reads them into INTENT → PLAN → DELIVERED) → **VERIFY** (`rig scope audit`, advisory). "Loose freeform write + deterministic verify."

## Hot-potato (handoffs)

End every turn by passing the ball — a `rig queue handoff` to the next agent. The handoff verb is **transactional**: it closes the source as handed-off and mints the successor owned by `--to`, so the baton cannot be dropped. A handoff terminates only at the orchestrator seat, which holds the context to judge whether a park is legitimate.

**A plain `rig queue create` row is informational** — a durable message. It is not a baton and does not carry this obligation. Use `handoff` when you are passing real work; use `create` when you are informing.

Never go idle holding a baton.

## Verify (deterministic backstop)

Run `rig scope audit` at slice-close. Every convention check is **advisory / fail-open** — it records and advises, never blocks a write. Fix what's real, skip what isn't, keep moving. **A clean audit score is not required to proceed.**

## Reading terminal captures — KNOWN GOTCHA: ghost-text autocomplete is NOT real

When you `rig capture` a pane, **greyed / ghost autocomplete suggestions are NOT real content** — they are autocomplete *previews*, not typed, staged, or committed input. **This has been faking agents out a lot**: reading a ghost suggestion in a peer's input box as "staged text they're about to send," then reasoning on a string that was never there.

**Rule:** ignore ghost/autosuggest text entirely. Only *committed/rendered* pane output is real. When it matters, verify at source (git, the queue, the actual event) — never off a capture's ghost line.

## Moment-of-truth checklist

- **Starting a slice?** → do you know what it's for and what done looks like? mockups attached (UI slices)? **Are you on the light path?** (You are, unless the mission owner assigned the overlay.)
- **Finishing a slice?** → does `PROOF.md` say what you actually verified, by effect, including what is NOT covered? `PROGRESS.md` updated? mission `NOTES.md` refreshed? handed off via `rig queue handoff`?
- **Compacting?** → file your state in mission `NOTES.md`; on restore, read it plus the active slice's `SPEC.md`, `PROGRESS.md`, and `PROOF.md`.
- **Starting on a mission?** → read mission `SPEC.md`, `NOTES.md`, and the conventions SSOT.
