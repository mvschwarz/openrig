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
build into proof. The TUI is a **plain projection of well-formed
markdown on disk** — agents change the files, the UI re-projects. These
conventions define "well-formed." Everything here is **advisory / fail-open
for agents**: nothing below blocks a write; the audit records and advises.


## WHERE YOU ARE DECIDES WHICH LOOP YOU RUN — the VM inner loop vs the host outer loop

The parent host's SDLC was being applied wholesale to the VM. **They are different worlds with
different responsibilities**, and conflating them is what turned this document into friction.

| | **INNER LOOP — the VM** | **OUTER LOOP — the parent host** |
|---|---|---|
| **question it answers** | *does it actually work?* | *does what was delivered match what was intended?* |
| **method** | ground → fix → upgrade in place → **run it and look** → iterate | intent-vs-delivered comparison, commit-message review, privacy/leak scrub, release management, publish |
| **definition of done** | to the best of our knowledge the code is **completely functional and works**, and needs **no heavy refactoring** to be release-ready | the release is shippable and honest |
| **ceremony** | **Part A only.** Part B is not the default here. | **Part B applies.** The release itself earns it. |

**WHY the ceremony belongs there and not here — the rule that makes this self-enforcing:** the
proof ceremony is a **protocol for transmitting confidence to someone who was not there.**
Plan-lock, proof contracts, C1 drops and intent-vs-delivered all exist so a reader who did NOT
watch the work happen can verify that it did. On the host that is exactly the situation, so the
artifacts must carry the confidence. **On the VM the builder IS there** — they ran it and looked at
it. Running the ceremony there re-encodes, at high cost, something already known, for an audience
standing in the room.

**WHERE A FIX GOES — go where the validation is POSSIBLE, not where the ceremony lives:**

- **Needs a live daemon to verify → the VM.** That is the only place it CAN be verified. (Worked
  example: proving the ACTIVITY telemetry was really fixed required cutting the runtime over and
  reading real values; no amount of host-side review could establish it.)
- **Verifiable by reading — docs, comment scrubs, message hygiene → the host.**

**The VM's north star for a release:** hand the host code that, to the best of our knowledge, is
completely functional and works. Not a proof pack. **Effect-verified functionality.**


## HOW TO READ THIS DOCUMENT — two parts, and only one of them is the default

| | applies | contents |
|---|---|---|
| **PART A — THE SIMPLE SDLC** | **ALWAYS. This is the default.** | artifact conventions, proportionality, the advisory audit, the honesty rails |
| **PART B — THE RIGOROUS OVERLAY** | **ONLY when the founder, or an orchestrator relaying the founder, ASSIGNS the heavy path to a NAMED piece of work** | the proof-contract format, the two locks, C1 proof drops, the locked role contracts |

**You may not select Part B for yourself.** If you believe something earns it, say so in ONE
sentence and continue on Part A until told otherwise. Part A corresponds to the `mission-slice-sop`
skill; Part B to `mission-slice-intent-proof-sop`.


## THE COMPONENT MENU — this document is a menu, not a pipeline

The SDLC is assembled from **components chosen per mission**, not a single mandated flow.
This document describes the components and carries recommendations; a mission (or the team
running it) picks per phase. Multiple valid options can exist for the same phase — choosing
one does not deprecate the others. Nothing below deletes or overrides an existing component.

| phase | components available today |
|---|---|
| **PLAN** | **The planning dial** — planning rigor is a spectrum chosen per piece: P0 mini-requirements and pointers (simple, reversible work) · P1 an authored spec with a proof contract (the default) · P2 plus a research round before the spec freezes, run BEFORE build dispatch · P3 plus an adversarial pass by a non-author, judged against product goals, landing amendments with proof-contract teeth · P4 plus a blind from-scratch design diffed against priors before proceeding. Dial up by what the piece is, exactly as build care is priced below. |
| **BUILD** | **Part A, the simple flow** (below — the default) · **the wave model** — slices build in parallel in disjoint file territories, an integrator merges serially, and independent review fires once per wave (two reviewers with different vantages, never the writers; fix rounds re-earn verdicts at one final revision; per-slice discipline stays failing-test-first and verify-by-effect). The wave IS the care dial: what shares a wave decides how much review each piece gets · **Part B, the rigorous overlay** (below — only when assigned). These combine: a wave can carry one Part-B piece. |
| **RELEASE** | The release ceremony conventions (publication identity, honest release notes, the capability-delta lifecycle: each delta expires when canon absorbs it). |
| **BOUNDARY** | **The release boundary** — housekeeping run once per fence so the next release starts clean: seats reset or re-primed per their continuity needs, memory distilled (keep what changed a decision recently), every queue swept by destination and dispositioned, substrate torn down, boards frozen as records, a clean-box baseline captured. A checklist of judgment guides, not gates. |

> Fuller reference documents for the planning dial, the wave model, and the release
> boundary are being graduated into `docs/reference/`; until they land, the summaries
> above are the shipped description and this document remains the SSOT pointer for all
> of them.

# PART A — THE SIMPLE SDLC (applies always)

## A1. The flow in one pass

```
intent (what is this for, what does done look like)
      → build it
      → test it with your own eyes
      → record honestly what you verified, and what you did NOT
      → hand off (rig queue handoff) or stop
```

One full-breadth review at the end, not per increment. Bring work when it is **done**. The human
should almost never see something that doesn't match what was planned — QA catches mismatches and
kicks them back. When the human looks, they map intent → plan → delivered at a glance, mostly by
scanning screenshots down a single column, and give the final 1% approval.

**The heavier flow — proof contracts, plan-lock, C1 drops, proof-lock — is PART B and is not in
force unless assigned.**

## A2. Slice artifact conventions (what the UI projects)

Each slice directory carries:

- **`SPEC.md`** — the one authored node file. Its frontmatter carries
  `intent:` and may carry `depends_on:` as a list of sibling work-node IDs;
  `depends_on` orders siblings and is never followed by the path-only context
  trace. The body opens with the three convention sections, in this order and
  with these exact headings:
  - **`## Intent`** — the recorded intent, verbatim. The UI projects this
    text as the INTENT section.
  - **`## Mini-requirements`** — the concise, one-glance requirement tier
    (numbered list). This is the founder's first structured catchpoint;
    approval starts here.
  - **`## Proof contract`** — a checkbox list of promised deliverables (see
    §3). The UI's DELIVERED section pairs each item with its proof.
- **`PROGRESS.md`** — the slice's acceptance checklist: the durable
  mission/slice-level to-do checked at acceptance. In-process steps stay in
  the working agent's own todo tool.
- **`PROOF.md`** — the retained proof summary, explicitly paired to the
  `SPEC.md` proof contract.
- **`proof/`** — the proof-artifact directory. Curated canonical evidence
  lands here via `rig proof` with valid C1 headers (§5).

Legacy `README.md`, `IMPLEMENTATION-PRD.md`, and pre-convention trees remain
readable indefinitely. New scaffolds do not create or mirror them, and repair
is additive: it never deletes, renames, or rewrites legacy bytes.

The three sections project into the UI's one review structure: a vertical
stack of **INTENT → PLAN → DELIVERED**. A slice missing a section still
renders (the projection degrades to a muted "—", never invents content) —
but it does not carry its weight in review.

## A3. Honesty rails (public surfaces + cited hashes)

### Public-repo surfaces read as product engineering

Commit messages, code comments, and markdown/docs are **public-repo surfaces**: they
ship to readers who have no access to — and no interest in — how the work was
governed internally. Two rules, **forward-only** (existing history is not rewritten
for these):

- **No verbatim internal quotes**, and especially not emotional or frustrated ones.
  Quote the *technical content* of a decision, never the person or the mood in which
  it was made.
- **No governance framing.** Write what the change does and why it is correct on its
  own terms — not who ruled it, who approved it, or which internal gate it passed.
  "The guard fires at lock because a placeholder would otherwise satisfy the join"
  is product engineering. "X ruled this at the Y gate" is internal governance leaking
  into a public artifact.

The test: a reader outside the project should be able to act on the text without
knowing any internal role, seat, or process name. This is the same principle applied
to attribution and tone rather than to vocabulary.
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

**Canonical convention (the ONE origin — cite it, do not restate it here),
cited in the form that convention itself prescribes — path + section anchor +
dated whole-file hash:**

- **path:** `artifact-cross-citation-path-plus-lineage.md` (internal authoring convention — not shipped in this public repo)
- **anchor:** *A cited hash STATES ITS COVERAGE — span is part of the definition*
  (2026-08-08)
- **hash:** `sha256 14d9a273d542648ab1e0a82c7fd98e8a8c59cb02a83be76b8af9abfb717b34d2`
  — **coverage: WHOLE FILE, bytes as stored, INCLUDING the trailing newline**
  (0x0a terminal byte verified), 229 lines, as-of 2026-08-08.

The **path + anchor is the AUTHORITY**; the whole-file hash **DATES** the
citation. That artifact is a living doc: the hash goes stale at the next
legitimate append, the anchor does not — the CURRENT-line convention applied to
a citation.
## A4. When implementation finds the intent rested on something that does not exist

A slice's intent can only be honoured to the extent its assumptions hold. Sometimes implementation
discovers that a LOCKED intent depends on functionality that **is not there** — not a missing
detail, a missing capability.

**The honest response is to revise the ambition DOWN to what reality supports, and name the missing
functionality as its own work.** Mark the slice **PARTIAL**, and write one document that tells a
downstream reader the accurate story:

1. what the intent asked for (quote the locked text)
2. what actually shipped, and how it was verified BY EFFECT
3. **what did not ship and precisely why** — name each missing capability, at source, with the file
   and line that proves it is absent
4. what the delivery does NOT cover, stated plainly — a scenario or feature that overstates its
   coverage is worse than one that does not exist
5. **follow-on slices scoped from what you know NOW**, including which release you think they belong
   in — the agents holding the context at discovery time are the most knowledgeable readers that
   problem will ever have, and a downstream planner should not have to rediscover any of it

**What is NOT acceptable:** silently narrowing the claim; quietly expanding the slice to build the
missing capability; or declaring victory on a reduced surface while still using the original slice's
name. **Building the missing pieces inside the slice IS the scope creep.** Discovering them and
routing them is the slice working correctly — and a slice that reveals a real product gap has
produced something more valuable than the feature it set out to deliver.

Do not over-engineer this. The entire goal is an accurate story for whoever reads it next.

## A5. The elastic middle (proportionality — no minted ceremony)

The SDLC has exactly three fixed capture points: **intent** → a
**proportional structured requirement** → **proof**. Everything between is
elastic. For a small slice (a bug fix, a research note), the
mini-requirements may BE the whole specification — the convention sections must be
present so the slice projects, but their contents scale to the work. Gates
are losslessness checks on the decompression from intent to delivery, not
paperwork. Scaffolding emits the sections; it must never mint ceremony.
## A6. The audit (advisory, fail-open — always)

`rig scope audit` (and the advisory rows in `rig workspace validate` /
`doctor`) checks these conventions: the section headings present, the proof
contract well-formed, `proof/` artifacts carrying valid C1 headers, UI slices
referencing a mockup. Every finding **records and advises — it never blocks a
write path and never changes exit semantics into a gate**. Unknown is
reported as unknown, not failure.
## A7. Where the knowledge lives (the four pointers)

- **This document** — the SSOT.
- **Scaffold**: `rig scope slice create` emits `SPEC.md` + `PROGRESS.md` +
  `PROOF.md` + `proof/` for every template kind; `rig scope mission create`
  emits an intent-bearing `SPEC.md` + `NOTES.md`. Core emits only this
  mode-neutral shape; mode plugins add richer material through the extension
  seam rather than teaching core a mode.
- **Skills — TWO, matching this document's two parts**: `mission-slice-sop`
  teaches **Part A**, the light default; `mission-slice-intent-proof-sop`
  teaches **Part B**, the assigned overlay. Assigned-only, never self-selected.
- **Bootstrap**: the shipped agent overlay points fresh seats at the skill
  and this document at boot.

# PART B — THE RIGOROUS OVERLAY (assigned only)

> **ENTRY CONDITION:** everything below applies **only** when the founder — or an orchestrator
> explicitly relaying the founder — has assigned the heavy path to a **named** piece of work.
> If you arrived here without an assignment, stop and use Part A.
>
> **Rails:** the locks are **two, and only two**. Nothing here authorizes a second gate round on
> the same work, a gate on documentation / comments / tests / fixtures, or asking a peer to gate
> what you can verify with your own eyes. **Cut rounds, never checks.** The tier is **re-chosen**
> when the surface changes.

## B0. The assigned flow in one pass

```
intent → mini-requirements + proof contract → (UI slices: mockups)
      → plan-lock (rig scope slice approve --scope spec)
      → build the LOCKED set
      → QA: mockup ↔ delivered VISUAL compare
      → proof drops (rig proof add <slice> …)
      → proof-lock (rig scope slice approve --scope delivery)
```

## B1. The proof contract format

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

## B2. The two locks (shipped verb — not new machinery)

Two deliberate stamps, both written by the SAME shipped verb
(`rig scope slice approve`, one daemon-side write path: frontmatter stamp +
append-only audit row land together):

- **Plan-lock:** `rig scope slice approve <slice> --scope spec` — "the spec
  matches my intent; THIS artifact set is what gets built." Pins `SPEC.md`
  (and planned mockups, when present) out of everything else in the folder.
- **Proof-lock:** `rig scope slice approve <slice> --scope delivery`
  (the default scope) — the terminal "this is done" sign-off; fires the
  freeze.

Approval is freeze/sign-off — **never** proven-green. Proven-green requires a
recorded verdict (a C1 proof artifact, §5); presence of an approval stamp does
not assert the work was proven. `--on-behalf-of` records delegation honestly
(the actor stays the real invoking session).

## B3. Proof drops and the C1 header (closed sets)

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

## B4. Role contracts (what makes the structure self-enforcing)

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

## Scratch-daemon hermeticity: the DB a scratch daemon opens is the one you named

*(Desk-ruled 2026-08-25, row qitem-20260825005846-7960f4dd; 0.5.3-era doctrine — a harness rule,
not product behavior.)*

A scratch daemon launch **strips the inherited environment's `OPENRIG_DB` and names an explicit
scratch DB path under the scratch `OPENRIG_HOME`** — both halves, every launch:

```bash
env -u OPENRIG_DB \
  OPENRIG_HOME="$SCRATCH_HOME" \
  OPENRIG_DB="$SCRATCH_HOME/openrig.sqlite" \
  node <daemon entry> …
```

An inherited fleet DB reaching a scratch daemon is a **harness defect regardless of outcome** —
the scratch context read or wrote state it never owned, and whether anything visibly broke is
luck, not hermeticity.

**The discriminator that keeps this rule honest:** an explicit `OPENRIG_DB` still WINS by design
(`daemon-db-path.ts`; prior ruling 00c4ab76) — deliberate split-path configuration is legitimate
and untouched. This rule governs **inheritance into scratch contexts**, where nobody decided
anything: strip what you did not choose, then choose.
