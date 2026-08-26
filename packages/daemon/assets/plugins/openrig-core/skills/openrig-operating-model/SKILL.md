---
name: openrig-operating-model
description: >-
  Use when you do not know WHERE something belongs: you learned a lesson and are unsure which file
  takes it; you are about to create a new doc, folder, or convention; you are asking "should this be
  a skill, a note, or a chain file?"; you inherited a seat and want to know what SHOULD exist; or you
  are about to duplicate knowledge that already has a home. Also the trace-to-root: how a seat orients
  by reading one filename at each level from where it stands up to the fleet.
metadata:
  openrig:
    stage: draft
    author: OpenRig product team (sole-context authorship; revisions per REVISION-GUIDE.md)
---

# The OpenRig Operating Model

**Canonical term: the Operating Model.** How an OpenRig topology organizes every
kind of context so that any agent — cold, fresh, or five generations in — can
find what it needs and knows where to write what it learns. Everything below
runs on **markdown files, scripts, and conventions only**; the `rig` verbs that
formalize pieces of it are conveniences, never dependencies.

**Boundary (2026-08-11):** this skill owns the STRUCTURE (trees, chains, trace,
write protocol). The SUPPLY layer — how canon content flows into the chains:
addresses, maps, renders, EMM maturity, census — is `openrig-corpus-canon`,
the deliberate drain mechanism the dual-home interim anticipated.

Companion files in this skill's folder — routed, not inlined:
- `ROLLOUT.md` — how the model is being adopted on a live fleet (waves, interim
  practices, what happens to existing files).
- `ROADMAP.md` — what later gets formalized in product code, and when.
- `REVISION-GUIDE.md` — for agents revising this skill.
- `templates/` and `scripts/` — starters and working tools, described in §8.

## 1. The model in one breath

Everything lives on one of **two trees**, and every kind of context is a
**chain**: the same filename at every level of a tree. To know anything, you
**trace from where you are toward the root**, reading that one filename at each
level — nearer levels refine or override farther ones. The **trace** (§5) is
the act of doing that ascent deliberately, with your own file reads.

- **Topology tree** — how work is done: `fleet → instance → rig → pod → seat`.
- **Work tree** — how the product gets built: `project → mission → slice → proof item`.

An **instance** is one OpenRig daemon and the rigs it manages; a **fleet** is all instances. Where
a daemon runs is a deployment fact, not an altitude — say the instance's name when you mean a
particular one.

**The one-parent law (design-ruled 2026-08-10):** the trace follows the
directory path and NOTHING else — no pointer fields, no link-following, no
branching, ever. The trace is the instrument confused agents reach for, so it
must be simpler than anything it corrects: path-only ascent fails only in
obvious ways. A child that relates to a second parent gets an `also-serves:`
ANNOTATION (read by humans and agents, walked by nothing) — and a genuine
two-parent tie usually means the item belongs one level up, under the common
ancestor, with mentions pointing down. The operational many-to-many lives in
the queue's tags, which are maintained by use. Legacy `serves:` lines are
transition bridges for the flat layout only: never required, never walked,
deleted as work nests properly.

**The filename law:** one name per chain, identical at every level. The folder
tells you *whose* it is; the filename tells you *what kind* it is. A seat named
`pm-lead` in two different rigs has two different `LEARNED.md` files — the path
is the identity. Never invent per-level names (no SEAT.md, no RIG.md): that
breaks the trace, the self-description, and every tool at once.

## 2. THE GRID — what exists at each level, and who keeps it true

This table is the model. If you internalize one thing, internalize this.

### Topology tree

The chains carry what is true of a **position**. How a *kind* of thing works — the operating
model — ships in the mode-neutral `openrig-core` plugin; an operating-mode plugin
(`openrig-lab`, `openrig-factory`, or `openrig-hq`) may refine it.

| Level | `CULTURE.md` — values | `LEARNED.md` — what THIS ONE has learned | kept true by |
|---|---|---|---|
| fleet | default culture (ships with OpenRig) | fleet-level lived practice | **operator agent** |
| instance | *(inherits)* | what is true of every rig on this daemon | **the instance's operator** |
| rig | the rig's constitution | this rig's lived practice | **the rig's orchestrator** |
| pod | *(inherits)* | this pod's lived practice — the **context domain**: anything useful to anyone in this pod | **the pod's lead** |
| seat | *(inherits)* | this seat's lived knowledge — **the file that fixes handovers** | **the seat itself** |

**Chain files sit on nodes, not on the shelves that hold them.** `rigs/`, `pods/`, `seats/`,
`missions/` and `slices/` are shelves — the trace passes through them and expects nothing there.

### Work tree

**ONE authored node file: `SPEC.md`.** Intent lives in its FRONTMATTER; the specification lives in
its body. Alongside it sit three files with different jobs and different writers:

| file | what it is | who writes it |
|---|---|---|
| `SPEC.md` | the node — `intent:` composes, body specifies | the node's owner |
| `NOTES.md` | **LIVED** — what actually happened doing it, in the doer's own words | whoever is doing it |
| `PROOF.md` | evidence the thing does what was intended | the prover |
| `PROGRESS.md` | authored acceptance checklist — each checkbox is a stored mark; roll-ups above those marks are derived | the scope's owner and provers |

**A scaffold may create `NOTES.md` and its starter instructions; its lived entries are never
generated or projected.** It is the work tree's lived file, the way `LEARNED.md` is the topology
tree's — the field-notes rung, where raw observation goes before anything has earned a place in the
node itself. Keeping lived files out of the render path is what makes them safe to write freely in.

**Legacy name:** the adopted spelling is `MISSION_NOTES.md` (35 at mission root). It stays
resolvable, but the chain name is `NOTES.md` — `MISSION_` is altitude-specific and a chain uses one
name at every altitude.

| Level | `SPEC.md` — frontmatter `intent:` (why) + body (what must be built) | progress | kept true by |
|---|---|---|---|
| project | `intent:` only — stable, changes at real pivots | derived roll-up | the project's PM |
| mission | `intent:` only — a mission ORGANISES slices; it specifies nothing | authored checklist marks; roll-up derived | the mission's PM |
| slice | `intent:` **and** a body — the only altitude that specifies | authored checklist marks; roll-up derived | the slice's owner |
| proof item | *(inherits)* | **the checkbox — the stored acceptance mark** | the prover |

**PROGRESS reconciliation (2026-08-26):** Checkbox items stored in a mission or slice
`PROGRESS.md` are authored acceptance marks. In-process task tracking stays in the agent's own todo
tool. Everything that rolls those marks up above the managed checklist is derived at render time,
so authored checklists and the never-author-a-derived-roll-up rule are the same model.

**Intent composes; the body does not.** The trace reads the `intent:` FIELD at every altitude, so
four levels unfurl as four sentences rather than four documents. The body is read only when you
are standing on that node.

    compose.py up <node> --name SPEC.md --field intent --root <project>

A level whose file exists but lacks `intent:` is reported as a gap — a mission with no intent is
real information, never silently skipped.

**Legacy `README.md` nodes stay valid indefinitely** — the resolver prefers `SPEC.md` and falls
back, so nothing is forced to migrate and dormant missions need no attention.

**PROGRESS stays separate.** Its checklist items are authored stored marks; everything above those
marks renders from them. Folding a derived roll-up into an authored file is how a stored derivation
becomes a confident lie.

Two directions on the same trees: intent/values/practice **compose downward**
(you trace UP to read them); progress **aggregates upward** (never hand-written
above the stored marks). **And PROGRESS above the managed checklist is a RENDER, not a
file** (design-ruled 2026-08-10): the checkbox is the stored acceptance mark;
`scripts/compose.py progress` derives the roll-up tree at render time. The
old PROGRESS.md files that embedded a hand-rendered tree were the right idea
in the wrong home — a stored derivation drifts into a confident lie (the same
law that retired `serves:`). Existing legacy PROGRESS.md files with embedded
trees stay per rule zero and are read as testimony; nobody authors a progress
tree by hand again.

**The axis behind the columns:** every context kind has a *template* half
(what ships — SOP, the default culture) and a *learned* half (what living
in it taught — LEARNED, culture amendments). Only the pace of change differs:
values change rarely and deliberately, like a constitution; practice changes
constantly and cheaply, like working notes; intent changes at real pivots.
Keep each file's pace; don't constitutionalize your notes or scribble on the
constitution.

## 3. Why this exists (the failure it fixes)

*How this seat does its job, learned over time* had no durable home. It lived
in one runtime's private memory (invisible to the other runtime, the operator,
and every successor), in handover documents (where day-to-day duties drown
under urgent state), and in skills nobody opened at the right moment. Measured
result: several consecutive generations of critical seats each started with a
fraction of their predecessor's ability, without knowing it. The structural fix
is the pair: `openrig-core`'s operating-model skill (the job, by type — shared,
versioned, shipped) + `LEARNED.md` on the chain (the job, as lived — per-instance,
occupant-written) — **read at every boot before any handover document**, written
by every generation. A bad handover now costs recent state, not the job itself.

## 4. LEARNED.md — the living file (all altitudes; seat shown)

Sections, in order — see `templates/LEARNED.md`:

1. **Header** — coords · which SOP it refines · updated date (from the
   clock command, never from memory).
2. **MY JOB HERE** — this instance's actual function, in plain operational terms.
3. **STANDING DUTIES** — every recurring duty, each with its rhythm and where
   it happens. Duties listed anywhere else die at the next handover; this
   section is why they survive.
4. **HOW I WORK** — practices learned on the job, **each with its reason**.
   A practice with its why can be re-judged when the world changes; a bare
   rule outlives its reason and gets misapplied.
5. **GATES & AUTHORITIES** — what this instance may decide alone, what it must
   never assume. Authority exists in writing or not at all.
6. **KEY RELATIONSHIPS** — who it hands to, who reviews it, who it reports to.
7. **TRIGGER POINTERS** — "when X happens, read Y." Attach pointers to the
   *moments* that need them; lists of boot-time reading decay.
8. **LESSONS** — dated, newest first. Periodically distill old entries into
   HOW I WORK or drop them.

**Size: soft guidance, not a rule.** Keep it as small as honestly covers the
job — attention is the budget, and every reader pays it. Some seats genuinely
need more; write what the job needs. The failure mode to watch for is the
rulebook that only ever grows — hundreds of accumulated edicts nobody can hold
(the Deuteronomy pattern, which this fleet has lived through once at population
scale). The antidote is the distillation habit in §8 above, not a line count.

## 5. The trace — deliberate reorientation

A trace is walking your chains **with your own file reads** and writing down
where you stand: what am I doing (queue/NOTES) → under what contract (SPEC) →
toward what intent (INTENT chain, leaf to root) → by what practice (LEARNED +
SOP) → within what values (CULTURE). A few written lines at the end.
`scripts/compose.py up` assembles any chain for you.

Two rules give the trace its value:

- **Your reads are the trace.** A trace written from memory is a recitation —
  if you didn't open the files, you didn't trace, and you will confidently
  re-derive whatever drift you already have.
- **Report broken links; never obey them.** A missing file, a stale date, an
  intent that contradicts observable reality — say so to the level that owns
  it. That is how the chains stay true: they are audited by being used. And
  the chains **inform** decisions; they never enforce anything by themselves —
  a stale map must never be able to block true work.

**When to trace — one principle:** *trace when enough has changed that your
picture of where you stand may be stale* — after a large stretch of work, at a
boundary (boot, handover, new mission, confusion), or when someone asks you to
reorient. Why not simply "every N hours": identical scheduled prompts fade
from an agent's attention with repetition, and idle seats accumulate ritual
traces that crowd out real context — both failures observed here, at cost.
Where a schedule fits your context anyway, use one — but prefer gating the
*action* on evidence of change: `scripts/trace-due.sh` decides "has enough
happened since my last trace?" deterministically and stays silent when the
answer is no, so a scheduler can fire it as often as it likes.

## 5b. Trace and `rig walk` — one idea, two ends

These get confused because they share a word. They are not in conflict; they are the same thing
seen from either end, and the relationship is worth holding.

**A chain is an ordered sequence of context meant to be absorbed one piece at a time.** Two kinds
exist and both are chains in that sense:

- **Altitude chain** — the same filename at every level of a tree, read by ascending
  (`LEARNED.md`; `SPEC.md` with `intent:`). The sequence is *position*: leaf → root.
- **Boot chain** — a seat's startup reading sequence. The sequence is *order of onboarding*.

**A chain can be traversed two ways, and that is the only real difference:**

| | who drives | mechanism | when |
|---|---|---|---|
| **PULL** | the agent | `compose.py up` renders the chain; the agent reads it | it is awake and oriented enough to look — a trace, a refocus |
| **PUSH** | an orchestrator | `rig walk --through <files> --pace <n>` sends one piece at a time into the pane | it *cannot* self-start — freshly cleared, re-primed, cold |

**Pacing is the mechanism in both directions, and it is the load-bearing part.** Absorption
*between* pieces is what makes a chain land; a concatenated dump of the same bytes is a failed
delivery regardless of content. That is why `rig walk` elapses `--pace` between pieces, and why a
composed render is meant to be read as a sequence rather than skimmed as a wall.

**NAMING, RULED 2026-08-14 — the two ends have two words and neither is shared.**

- **TRACE** — the pull ascent. `compose.py up` renders a node's chain to the root. This is what
  `refocus` means by *run a trace*, and it is what the render itself now prints.
- **`rig walk`** — the push verb, paced delivery into a seat's pane. It ships in the CLI, so treat
  renaming it as a product change.

**"Walk" no longer means the ascent.** It drifted in through the render's own header and started
competing with `trace`, which was already the word in `refocus` and in this file. **The fix is the
name, not a sentence explaining the name** — a disambiguation you have to maintain is a defect you
decided to live with.

## 6. Writing — two principles

1. **Your LEARNED.md is yours.** You write it, in your own words, as part of
   doing the job — when you learn something about how to do your work, the
   file carries it before you move on. When anyone else wants it changed
   (a correction, new doctrine), they tell you and *you* write it — knowledge
   someone else typed into your file was never yours. The one exception:
   when an instance is empty or broken, whoever is responsible for it writes
   what's needed, marks those lines as written-for-the-instance, and the next
   occupant rewrites them in its own words.
2. **Shipped things belong to their authors.** `openrig-core`'s operating-model
   skill and the shipped culture change through their owners, never by an instance
   editing in place. If it is wrong for everyone, propose the change to its owner;
   if it is wrong for *you*, that's what LEARNED.md is for.

Everywhere: date what you write (from the clock), and correct by adding a
dated correction rather than silently rewriting history.

## 7. Composed views

Any node can be **rendered**: its chains assembled into one document
(`scripts/compose.py`; `up` = your effective view from a leaf, `down` = every
chain file under a root — run `down` at a tree root and you get the whole
operating picture in one document). Two rules:

- **Rendered documents are generated, never edited.** The chain files are the
  source of truth; a render is a snapshot view of them.
- **Every chain render opens with a TRACE** — a tree-shaped orientation
  header derived at render time (never stored in any file): one line per
  level showing its state (seeded ✓ / unseeded ⟂ / stale-marker ⚠ / absent ✗)
  and a "you are here" anchor at the leaf. It shows the shape of your context
  the way `tree` shows the shape of a directory — where you sit, and where the
  screams are, before you read a word of content.
- **When an approval must freeze exact content** (for example a plan-lock on a
  spec), it records the *hash of a render* — the frozen bytes live in the
  approval record while the chain files stay live for reading and revision.

The **root render + diff** is how a high-altitude seat keeps a current mental
model of a changing fleet without reading everything: render the tree root,
diff against your previous render, read only the diff
(`scripts/trunk-diff.sh`).

## 8. Where knowledge goes — the placement rule

**Context lives at the narrowest scope that needs it; skills are only for what
has no scope.** Seat-specific knowledge → that seat's LEARNED.md. Rig practice
→ the rig's files. Only truly scope-free craft (useful to any agent anywhere)
belongs in the skill layer.

### The one axis that decides file-vs-plugin: KIND or POSITION

- **A chain holds knowledge about a POSITION** — *this* seat, *this* mission. **Unshareable by
  construction**, because the path is the identity.
- **A plugin holds knowledge about a KIND** — a seat-type's job, a domain's craft, an operating
  model. Shareable, versionable, cross-harness.

**A plugin cannot hold LEARNED.** Plugins are shared; LEARNED is per-instance. Two rigs installing
the same orchestrator plugin must not share what one seat learned about its own merge desk. That
is why chains exist alongside plugins rather than being replaced by them.

**And plugins are the distribution mechanism, which imposes a hard test.** A plugin ships skills;
a skill may ship a script; **that script must run unmodified on a stranger's machine.** So it
resolves paths from configuration (`rig config get workspace.root`), never from a literal, and it
never asks the agent to work out which of several candidate directories is the real one. If a user
points their workspace at a git repo or a `projects/` folder, everything keeps working with no
further setup. **A script that only works for its author is not shippable, however correct it is.**

### What belongs INSIDE a node — two tests before a sentence goes in

**A node holds what is true of THIS position and stays true.**

- **Portability.** If a sentence would read correctly on a stranger's machine, it is knowledge about
  a KIND. It belongs in this skill or a plugin, not on the tree. A node body that is fully portable
  is documentation that wandered onto the chain.
- **Volatility.** A value that changes faster than the file gets edited — a SHA, a count, a status,
  a roster — goes in as the **command that derives it**, never as the answer.

**Then check which tree.** Traps, practice and how-we-work are position knowledge on the *topology*
tree (`LEARNED.md`). What is being built is the *work* tree (`SPEC.md`). One rig owns both; they
still do not mix.

**Project and mission bodies are short or absent** — `intent:` is the whole job at those altitudes.
The slice is the only altitude that specifies.

### The other axis: AUDIENCE is not MATURITY

These are independent, and merging them is seductive because the merged version is prettier.

- **Audience decides WHERE knowledge lives** — which altitude, which file. Something belongs at
  pod level because anyone in that pod benefits. Full stop.
- **Maturity is an attribute of a LINE inside that file** — the epistemic ladder: data →
  observation → field note → insight → **canon**. The vocabulary already ships as the `stage:`
  enum (`wip | provisional | established | canonical | superseded | retired`).

A pod-level item can be raw observation; a seat-level one can be canon. **A skill can contain
something immature and still be the right home**, because audience picked the file.

**So promotion to canon is NOT a move up the tree.** It is a maturity event and can happen at any
altitude — a seat-level observation that is universally true graduates straight to a skill. What
earns maturity is evidence: recurrence, independent corroboration, a measured cost, surviving
change, surviving an attempt to falsify it. **Facts about mechanisms can skip the ladder**
(*backticks substitute in double-quoted shell strings* is one command away); **inferences about
practice must accrue** (*never broadcast to a large rig* took an incident).

**LEARNED.md is not a staged item — it is the bed everything lies in.** Its gradient is
positional: the dated append-log at the bottom is raw observation, the concise sections at the top
are what survived. What is missing is a **trigger**, not structure — "periodically distill" has
meant *never*. The answer: distil at deposit boundaries (pre-clear, pre-handover) where a write is
already required and the author still remembers why each line exists; refocus merely *notices*
when the log has outgrown the distilled part.

## 9. Standing the structure up

`scripts/scaffold.sh` creates any missing chain files from `templates/` and
**never overwrites or deletes anything** — so a brand-new workspace and a
living system are the same command with different starting states. Created
files are marked UNSEEDED until their real owner writes the first true
version. **Never mass-produce LEARNED.md content for other instances** — each
instance writing its own first version is both how the knowledge becomes real
and how you discover which seats can't describe their own job (see
`ROLLOUT.md` on why that discovery is the point).

## 10. Pitfalls (only what isn't taught above)

- Editing a rendered document instead of its chain files — your edit is lost
  at the next render, silently.
- "Improving" the trace with pointer-following, serves-resolution, or any
  branching — the trace's entire value is that path-only ascent cannot fail
  subtly; a smarter trace is a worse trace (design-ruled 2026-08-10).
- Summarizing this model for another agent instead of pointing them here —
  secondhand operating models are how operating models die; this skill was
  authored precisely because a chain of summaries destroyed the last one.
- Scripts in `scripts/` are macOS-flavored in places (`stat -f`); on Linux,
  check `REVISION-GUIDE.md` for the portability notes before trusting them.

## Files in this skill

`ROLLOUT.md` · `ROADMAP.md` · `REVISION-GUIDE.md` ·
`CHANGELOG.md` — why the model is shaped this way, and what it replaced ·
`templates/{SPEC,LEARNED,SOP}.md` ·
`scripts/{compose.py, trace-due.sh, trace-stamp.sh, trunk-diff.sh, scaffold.sh}`
