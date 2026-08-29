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

## Load only the useful width

Inspect the public pack and compose it for a fresh session:

```bash
rig context get world-public
rig context profile world-public --situation fresh
```

<!-- world-claim: subset-regions -->
Compose a subset by region when a full world is more context than the situation needs.

<!-- world-claim: derived-reading-cost -->
The reading cost is derived when a profile is composed, not copied into this pack.
Cut coverage deliberately by situation or region; do not cut sentences until their meaning breaks.

## Exercise: Book world

Retrieve the worked template:

```bash
rig context get world-example
```

Use it to describe a book-writing project: who the writer is, what manuscripts and sources exist,
where they live, which editorial rules apply, what decisions shaped the draft, how current state is
derived, and what the agent can do next. Keep it pleasant to read. If the arrangement feels like a
filing system rather than a place, simplify it.

The full public pack demonstrates the optional claim-checking climb.

<!-- world-claim: derive-pack-path -->
Use rig context show world-public --json to derive the installed pack directory.
Run `sh verify-world.sh` there instead of teaching a machine-specific path.
