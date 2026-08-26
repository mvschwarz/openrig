# Changelog — openrig-operating-model

Why the model is shaped the way it is. **`SKILL.md` carries the model; this file carries how it
got there.** Rationale, superseded designs, and the incidents that produced a rule live here so
the instruction surface stays instructional.

---

## 2026-08-12/13 — the simplification

### `NOTES.md` was retired and restored the next day — a measurement error worth keeping

Retired 2026-08-12 on the evidence that **`NOTES.md` had zero instances anywhere.** That number was
correct and the conclusion was wrong: the function was adopted **55 times as `MISSION_NOTES.md`**
(35 at mission root). **The name was searched for; the function was not.**

Restored as the work tree's **lived** file — the counterpart to `LEARNED.md` on the topology tree,
never generated, never projected, written by whoever is doing the work. `MISSION_NOTES.md` stays
resolvable as the legacy spelling, but the chain name is `NOTES.md`: `MISSION_` is
altitude-specific, and a chain uses one name at every altitude.

The general form, since it recurred all week: **a scoped search reported as a global absence.**
Asking "does this filename exist" answers a different question from "does this job have a home."

### Five chains became three

Superseded: `INTENT.md`, `SPEC.md`, `NOTES.md`, `PROGRESS.md` as separate work-tree chains, plus
`SOP.md` on the topology tree.

Now: **`LEARNED.md`** (topology) and **`SPEC.md`** (work), with `intent:` in `SPEC.md`'s
frontmatter.

- The four-chain work tree was designed and never adopted — `INTENT.md` existed **twice** across
  1,051 files. The design asked for four files where the work only ever produced one.
- Intent is a *chain* (every altitude) and spec is a *leaf* (missions organise, they do not
  specify), which argues for two files right until intent moves into frontmatter. Then one file
  serves both: the walk composes the **field**, the body is read only when you stand on that node.
- `README.md` → `SPEC.md` because names are prompts. README says "background reading"; what is
  actually there is a node definition with machine-read frontmatter. Legacy `README.md` stays
  valid indefinitely and the resolver prefers `SPEC.md`, so nothing is ever forced to migrate.
- `PROOF.md` was kept. It is the one check that reliably goes unmade.

### `SOP.md` left the tree

It is knowledge about a *kind*, and kinds are what plugins package. It now ships as a skill inside
the rig's mode plugin. The chains kept only what is true of a *position*.

This also fixed a packaging bug: `openrig-core` shipped the factory's `mission-slice-sop` alongside
genuine primitives, so **every rig installing "core" inherited the factory's operating model
whether it was a factory or not.** This VM felt like a factory before anyone chose one.

### `instance` entered the taxonomy

`fleet → instance → rig → pod → seat`.

Every hardware-flavoured word failed because the altitude is not hardware — it is one daemon and
the rigs it manages. `host` failed specifically because substrate *nests* (a VM runs on a host runs
in a datacentre), so a reader can resolve it to the wrong rung; **that conflation once sent a real
upgrade to the wrong machine.** `topology` was demoted: the code already uses it for the
arrangement of pods and seats within one rig, which is the natural reading.

### Shelves stopped being nodes

Directories that hold instances of an altitude (`rigs/`, `missions/`, `slices/`) carry no chain
file. Briefly they did here — added to make a walk report a clean 5/5, which inflated a checkmark
by writing a *definition of the kind* into a *position* chain, duplicated from `SKILL.md`.

### Audience and maturity were separated

They had been quietly multiplied into one axis: a tempting model where climbing the tree *was*
climbing the epistemic ladder. It is wrong. Pod-level content can be raw observation; seat-level
content can be canon. Audience decides the file; maturity is an attribute of a line inside it, and
promotion to canon can happen at any altitude.

### Tooling caught up

- `compose.py --field` composes one frontmatter field up a chain.
- `compose.py --prefer` treats `--name` as a precedence list resolved per level, so a tree
  mid-rename walks instead of reading as broken, and the map names which file answered.
- `scaffold.sh` was **generating the superseded design** — `work) FILES=(INTENT.md NOTES.md)` —
  for a day after the docs changed. Docs that lie are annoying; tools that lie rebuild what you
  removed. **Check what generates a convention before what describes it.**

---

## Known gaps

- The walk map renders a **shelf** and a real **gap** identically (`✗ absent`). It wants a third
  state; until then correct-and-expected screams as loudly as a genuine hole.
- The topology tree has no configuration key, so a shipped script cannot resolve it portably the
  way the work tree resolves from `workspace.root`.
- `LEARNED` distillation has a designed trigger (deposit boundaries) and no implementation.
