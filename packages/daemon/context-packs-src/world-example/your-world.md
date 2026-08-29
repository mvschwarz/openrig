# Your world

<!-- world-claim: world-example-purpose -->
A world pack situates an agent: it describes where the agent is, what exists there, and how to act.
<!-- world-claim: world-example-install -->
Use `rig context add <pack-directory>` to install a world pack, confirm its ref with `rig context list`, and derive the configured store with `rig config get context.packs_root` only when a path is needed.
Copy this pack, update its manifest, and replace each prompt below with your world's facts.

## Exercise: Book world

Run `rig context get world-example`, copy this pack, and make the project a book world. Describe
the writer, manuscript, sources, editorial rules, decisions, current draft state, and next useful
actions in a few coherent files.

<!-- world-claim: world-example-regions -->
The region names below are atom metadata, not a required directory layout.

## Identity

Name the world and the agent's place in it.

## Ontology

Define the important kinds of things and what each is for.

## Actors

Name who else is present, what they own, and how to reach them.

## Terrain

Map where code, records, documentation, and operational surfaces live.

## Laws

State the durable rules and precedence that govern action here.

## History

Record prior decisions and events that explain the world's current shape.

## State

Point to commands or sources that derive what is true right now.

## Affordances

List what the agent can do and the trigger for reaching each capability.

## Checks

For every checkable authored claim, add a named check that can fail. Flag taste or genuinely
unverifiable claims instead of dressing judgment up as a test. Derive paths, counts, inventories,
and live state from commands rather than copying their current answers into this file.
