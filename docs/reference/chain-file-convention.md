# The Chain-File Convention (CE-v2)

**This document is the SSOT for chain files**: what they are named, what each
altitude carries, and how the leaf-to-root trace resolves. Both trees' walkers
consume the paths defined here. If a walker and this document disagree, one of
them has a defect — report it; do not fork the convention.

## The one rule

**One filename, identical at every altitude of a tree.** A reader orients by
walking from where they stand toward the root, reading the same-named file at
each level. No pointers to follow, no branching, no per-level names. Inventing
a level-specific name breaks every walker.

Chain files sit on **nodes** (an instance, a rig, a pod, a seat; a mission, a slice)
— never on shelves (`rigs/`, `seats/`, `missions/` are containment, not
nodes, and carry no chain file).

## Two trees, two questions

| tree | path shape | carries | ships? |
|---|---|---|---|
| **Topology** | instance → rig → pod → seat | how work is done here | **yes** — generally applicable defaults ship in source |
| **Project** | project → mission → slice | what is being built | **no** — depends on what the user builds; see below |

### The topology tree

Rooted at the typed config key **`topology.root`** (resolution
`env OPENRIG_TOPOLOGY_ROOT > config file > derived default
$OPENRIG_HOME/topology`). Never hardcode the path — `rig config get
topology.root` is the answer on any machine. The instance altitude **is the
top of the root** (there is no instance directory to find; the root is the
instance):

```
<topology.root>/<NAME>.md                         # instance altitude
<topology.root>/rigs/<rig>/<NAME>.md              # rig altitude
<topology.root>/rigs/<rig>/pods/<pod>/<NAME>.md   # pod altitude
<topology.root>/rigs/<rig>/seats/<seat>/<NAME>.md # seat altitude
```

The engine creates the instance root, rig directory, and each declared pod
directory when it materializes topology, even when no authored chain default
exists. Pod context remains optional: use that altitude only for knowledge
shared within one context domain. Cross-pod guidance still belongs at the rig
altitude.

Established chain names on the topology tree:

- `LEARNED.md` — what a POSITION has learned; never shared or shipped as-is.
  A seat's LEARNED is identified by its PATH: the same seat name in two rigs
  is two different files.
- `CULTURE.md` — norms layered into members at startup.

### The project tree

Rooted at the workspace keys (`workspace.root`, `workspace.slices_root`).
Chain names there: `SPEC.md` (intent in frontmatter composes up the chain;
specification is a leaf property), `PROOF.md`, `PROGRESS.md`.

**Project-tree context cannot ship.** It describes what *you* are building —
mission intent, slice specifications, proof contracts. No vendor can author it
in advance, and shipping a default would install someone else's project as
your context. The demo project carries a worked example to copy from; real
projects author their own. (Topology-tree context is the opposite: how a team
of agents runs well is largely general, which is why included rigs ship
defaults.)

## Legacy location and the advisory

Before this convention the topology tree lived at `~/.openrig/shared-docs/rigs/`
(design decision 2026-08-14: an arbitrary folder on one machine, not a product
path). That location **stays readable** as a per-level fallback so existing
rigs migrate instead of breaking — but every read that resolves there emits a
named advisory (`legacy-topology-read: …`) stating the legacy source, the
canonical destination under `topology.root`, and the config key. A silent
legacy read is a defect. The legacy literal lives in exactly one helper per
settings twin (`resolveLegacyTopologyRigsRoot`); walkers import it and carry
no path literal.

## The trace

`rig context trace --rig <rig> [--pod <pod>] [--seat <seat>] --name <NAME>.md`
performs the walk: it prints each selected altitude root-first (general →
specific), marks whether content came from `topology.root`, the legacy tree
(with the advisory on stderr), or is absent, and needs no running daemon —
orientation is exactly when the daemon may be down. Existing rig/seat traces
remain valid; selecting `--pod` adds that context domain between them. `--json`
returns the structured result.

Your reads ARE the walk: a trace assembled from memory is a recitation that
reproduces the drift it was meant to catch. Run it; do not recall it.

## Shipped defaults and the curation path

Included rigs (product-team first) ship sensible-default chain files at the
applicable instance, rig, pod, and seat altitudes, installed under
`topology.root` at rig-up.
A shipped default is a **starting point** the occupying team appends to — it
is never overwritten by a later rig-up (existing files win).

Adding a discovered best practice to the shipped defaults is deliberately
lightweight:

1. **Discovery** — the practice appears where it was earned: a seat's
   `LEARNED.md`, a field note, a review observation.
2. **Curation** — someone judges it *generally applicable* (would it hold on a
   stranger's machine, in a different project?). If it is project-specific it
   stays at the altitude that earned it.
3. **Ship** — add it to the rig's default chain files in source
   (`packages/daemon/specs/rigs/…/topology/`), with the motivating incident in
   one line. It reaches new installs at the next release; running rigs pick it
   up only via explicit delivery (see the refocus channel) — **editing a file
   is not delivery to a running seat.**

## What this file does not cover

How chain files reach a RUNNING seat (the refocus channel) is specified in the
refocus documentation; quality bars for the work itself live in the rig's
operating-model skill and culture file.
