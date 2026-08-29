# Build your world

## Keep the first version small

Start with a directory whose name says what world it serves:

```text
book-world/
  manifest.yaml
  world.md
  boundaries.md
```

The manifest names the files. The prose states durable purpose, relationships, and what to trust.
Add atoms when the same bytes need situation, runtime, order, or region metadata. Add a claim ledger
and verifier when authored statements can drift into consequential lies. Do not add ceremony that
has no reader yet.

## Separate kinds, tag regions

<!-- world-claim: context-kinds -->
WORLD + LORE + SKILLS + MISSION is the top-level separation of context kinds.

- WORLD: where the agent is — entities, relationships, rules, history, state sources, affordances.
- LORE: what a position learned by living there.
- SKILLS: repeatable procedural capability.
- MISSION: the current work and why it matters.

<!-- world-claim: regions-are-tags -->
The eight regions are metadata on atoms, not a required folder tree.
Tag existing authored files with identity, ontology, terrain, actors, laws, history, state, and
affordances. One coherent file may cover several regions; do not fork the same idea into eight
copies.

## Carry an honest coverage map

Inspect the public pack and compose it for a fresh session:

```bash
rig context get world-public
rig context profile world-public --situation fresh
```

<!-- world-claim: retrieve-public-pack -->
Use `rig context get world-public` to retrieve the assembled public pack bytes.

<!-- world-claim: compose-fresh-profile -->
Use `rig context profile world-public --situation fresh` to compose its fresh-session atom graph.

<!-- world-claim: region-metadata -->
The regions field says which dimensions an atom covers; atoms carry it as manifest metadata, and consumers may filter that metadata as data.
<!-- world-claim: no-region-selector -->
This pack promises no region selector or subset-composition operation.
If a real consumer needs region-subset composition, route that
capability as separate profile-composer work.

<!-- world-claim: derived-reading-cost -->
The reading cost is derived when a profile is composed, not copied into this pack.
Use the composed profile's reported token total to decide what a future consumer should request; do not cut sentences until
their meaning breaks.

## Exercise: Book world

<!-- world-claim: book-example-purpose -->
The exercise uses a book because the model's existing world-building fluency needs the least translation there, and a reader with no software context is the hardest stranger case.

<!-- world-claim: retrieve-world-example -->
Use `rig context get world-example` to retrieve the worked book-world template.

Use it to describe a book-writing project: who the writer is, what manuscripts and sources exist,
where they live, which editorial rules apply, what decisions shaped the draft, how current state is
derived, and what the agent can do next. Keep it pleasant to read. If the arrangement feels like a
filing system rather than a place, simplify it.

<!-- world-claim: book-to-software -->
The book exercise maps its manuscript to a codebase, editorial rules to engineering laws and conventions, draft state to derived build and deploy state, and its writer to the team. Software worlds use the same moves.

<!-- world-claim: software-shaped-bridge -->
Agents already know software-shaped building through specifications, verification loops, tooling, and the programming substrate. A world pack built this way uses named files and a manifest as the spec shape, per-claim checks and a verifier that can fail as the test suite, and derive-at-source commands as the feedback loop. A blank-slate reader therefore already knows how to build this kind of artifact: world-building supplies the information architecture while software-shaping supplies buildability.

The full public pack demonstrates the optional claim-checking climb.

<!-- world-claim: derive-pack-path -->
Use rig context show world-public --json to derive the installed pack directory.
<!-- world-claim: run-public-verifier -->
Run `sh verify-world.sh` in that derived directory instead of teaching a machine-specific path.
