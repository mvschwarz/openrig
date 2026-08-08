# SDLC conventions — the markdown control plane

> **Succession rule (source of truth):** this document was derived from the
> corrective review-surface redesign spec
> (`CORRECTIVE-REDESIGN-review-surface-2026-07-05`, DRAFT v0.2, §2–§6,
> grounded against openrig main `c27f2aff`, 2026-07-05/06). **Once shipped,
> THIS repo document is the living SSOT for the SDLC conventions going
> forward**; the corrective spec is the historical design record. Scaffold
> templates, the advisory scope audit, the `mission-slice-sop` skill, and the
> shipped bootstrap overlay all point HERE — they must not restate this
> document in full (restatement is how drift is born).

OpenRig is a software factory the human steers from a high altitude. The human
records intent; agents turn intent into a plan, the plan into a build, the
build into proof. The Living Notes UI is a **plain projection of well-formed
markdown on disk** — agents change the files, the UI re-projects. These
conventions define "well-formed." Everything here is **advisory / fail-open
for agents**: nothing below blocks a write; the audit records and advises.

## 1. The flow in one pass

```
intent → mini-requirements + proof contract → (UI slices: mockups)
      → plan-lock (rig scope slice approve --scope spec)
      → build the LOCKED set
      → QA: mockup ↔ delivered VISUAL compare
      → proof drops (rig proof add <slice> …)
      → proof-lock (rig scope slice approve --scope delivery)
```

The human should almost never see something that doesn't match what was
planned — QA catches mismatches and kicks them back. When the human looks,
they map intent → plan → delivered at a glance, mostly by scanning screenshots
down a single column, and give the final 1% approval.

## 2. Slice artifact conventions (what the UI projects)

Each slice directory carries:

- **`README.md`** (or the slice body) opening with the three convention
  sections, in this order and with these exact headings:
  - **`## Intent`** — the recorded intent, verbatim. The UI projects this
    text as the INTENT section.
  - **`## Mini-requirements`** — the concise, one-glance requirement tier
    (numbered list). This is the founder's first structured catchpoint;
    approval starts here.
  - **`## Proof contract`** — a checkbox list of promised deliverables (see
    §3). The UI's DELIVERED section pairs each item with its proof.
- **`IMPLEMENTATION-PRD.md`** — the full PRD. It OPENS with the
  mini-requirements; everything between intent and proof is **elastic**
  (see §7 — for a small slice the mini-requirements may BE the whole PRD).
- **`proof/`** — the proof-artifact directory. Curated canonical evidence
  lands here via `rig proof` with valid C1 headers (§5).

The three sections project into the UI's one review structure: a vertical
stack of **INTENT → PLAN → DELIVERED**. A slice missing a section still
renders (the projection degrades to a muted "—", never invents content) —
but it does not carry its weight in review.

## 3. The proof contract format

`## Proof contract` is a markdown checkbox list; each item is one promised
deliverable, written as an observable outcome:

```markdown
## Proof contract

- [ ] The consolidated `rig ps` default renders all rigs with a rollup footer — captured.
- [ ] UI: the slice review tab renders the three-section stack — screenshot vs the locked mockup.
```

- Each item is joined (by item text or 1-based index) to the proof artifacts
  that evidence it — that pairing is what the DELIVERED section renders, so
  the human never hunts through dozens of artifacts to find which one proves
  what.
- **UI deliverables carry a planned mockup** (`plannedRef`): the planning
  agent produces the mockup and attaches it to the locked set. A UI slice
  with no mockup in its locked set is an incomplete plan. Non-UI slices
  (backend, skills, markdown) have no mockup and no `plannedRef` — that is
  not a gap and not a gate.
- A deliverable QA did not actually verify shows as `unverified`/`missing`
  in the UI — visible, never hard-blocking.

## 4. The two locks (shipped verb — not new machinery)

Two deliberate stamps, both written by the SAME shipped verb
(`rig scope slice approve`, one daemon-side write path: frontmatter stamp +
append-only audit row land together):

- **Plan-lock:** `rig scope slice approve <slice> --scope spec` — "the PRD
  matches my intent; THIS artifact set is what gets built." Pins the locked
  artifact set (spec/PRD/mockups) out of everything else in the folder.
- **Proof-lock:** `rig scope slice approve <slice> --scope delivery`
  (the default scope) — the terminal "this is done" sign-off; fires the
  freeze.

Approval is freeze/sign-off — **never** proven-green. Proven-green requires a
recorded verdict (a C1 proof artifact, §5); presence of an approval stamp does
not assert the work was proven. `--on-behalf-of` records delegation honestly
(the actor stays the real invoking session).

## 5. Proof drops and the C1 header (closed sets)

Proof artifacts land in `proof/` via the shipped verb:

```bash
rig proof add <slice> \
  --artifact-type qa \
  --verdict PASS \
  --candidate-sha <the-proven-tip> \
  --money-evidence "one line of money evidence" \
  --file <artifact.md> \
  --evidences "1,3" \
  --media "walk.webm,panel.png" \
  --self-check "I looked at the captures; they show the claim"
```

The C1 header's five required fields: `slice`, `candidate_sha`,
`artifact_type`, `verdict`, `money_evidence`. Two **ratified closed sets**
(extending either is a convention change, not a local edit):

- `artifact_type`: `guard | qa | rev1-r1 | rev1-r2 | adjudication`
- `verdict`: `CLEAR | BLOCKING | CONCERNING | PASS | NOT-CLEAR`

### A cited hash STATES WHAT IT COVERS

A hash offered as evidence is only checkable if the reader knows what bytes it
was taken over. **State the coverage with the hash**, in one of two forms:

- **whole-file** — and say so, including whether a **trailing newline** is
  inside the hashed bytes; or
- **file + an exact span definition** — the span is *part of the definition*,
  not a hint about where to look.

Two honest people can hash the same artifact and get different digests without
either being wrong (for example, one over the frontmatter block and one over
the whole file). Coverage is what makes a cited hash verifiable rather than
merely impressive.

**Canonical convention (the ONE origin — cite it, do not restate it here):**
`openrig-work/conventions/artifact-cross-citation-path-plus-lineage.md`,
section *span-is-part-of-the-definition* (2026-08-08), which carries the
specimen (twin frontmatter hashes, neither wrong) and the full rule.

`candidate_sha` is the join key: the proven candidate tip this artifact
judges. `--evidences` names which proof-contract deliverable(s) the drop
covers (item text or 1-based index) — that reference populates the
planned↔delivered pairing. `--self-check` is the agent's recorded assertion
that it LOOKED at the evidence. `--media` names the curated media files
(relative to the slice's `proof/` dir — co-located, never absolute) this
drop stands behind; the composer projects them into the DELIVERED items'
proof set. Validation happens at drop time; the audit
(§6) backstops artifacts that arrived by other paths. **Hand-placing files
in `proof/` without a drop is the anti-pattern**: the deliverable stays
unpaired and `unverified` in the DELIVERED view — always attach media via
`--media` on a drop.

## 6. Role contracts (what makes the structure self-enforcing)

- **Planning agent:** authors intent verbatim, the mini-requirements, and the
  `## Proof contract` (each UI deliverable with its mockup `plannedRef`);
  produces the mockups; locks the plan (`--scope spec`).
- **Build agent:** builds against the LOCKED set only; looks at the mockups,
  not just the spec text.
- **QA agent (owns the compare):** for each deliverable — load the locked
  `plannedRef`, produce the real artifact in a test/demo environment,
  **visually compare**, record the verdict + note via a proof drop, and
  **curate** the canonical proof set. On mismatch beyond minutiae: fix and
  have another agent review, or kick back with the reason — never escalate a
  raw mismatch to the human. A proof drop with no recorded comparison leaves
  the deliverable `unverified` — visibly.

**Curation rule:** the primary proof set is the curated canonical "this is
what it looks like now" evidence the agent stands behind — bounded, mapped
1:1 (or few:1) to deliverables. The fix-loop's full artifact history stays in
`proof/`, one drill-in down, NEVER in the primary view. The anti-pattern:
an append-only pile where the human can't tell final from superseded.

## 7. The elastic middle (proportionality — no minted ceremony)

The SDLC has exactly three fixed capture points: **intent** → a
**proportional structured requirement** → **proof**. Everything between is
elastic. For a small slice (a bug fix, a research note), the
mini-requirements may BE the whole PRD — the convention sections must be
present so the slice projects, but their contents scale to the work. Gates
are losslessness checks on the decompression from intent to delivery, not
paperwork. Scaffolding emits the sections; it must never mint ceremony.

## 8. The audit (advisory, fail-open — always)

`rig scope audit` (and the advisory rows in `rig workspace validate` /
`doctor`) checks these conventions: the section headings present, the proof
contract well-formed, `proof/` artifacts carrying valid C1 headers, UI slices
referencing a mockup. Every finding **records and advises — it never blocks a
write path and never changes exit semantics into a gate**. Unknown is
reported as unknown, not failure.

## 9. Where the knowledge lives (the four pointers)

- **This document** — the SSOT.
- **Scaffold**: `rig scope slice create` emits the convention sections +
  `proof/` + an `IMPLEMENTATION-PRD.md` skeleton for every template kind;
  `rig scope mission create` emits the convention pointer.
- **Skill**: `mission-slice-sop` teaches the full flow (shipped in the
  product skill tree and the bundled plugin, mechanically mirrored).
- **Bootstrap**: the shipped agent overlay points fresh seats at the skill
  and this document at boot.
