# Your world

A world pack situates an agent: it describes where the agent is, what exists there, and how to
act. The OpenRig daemon serves any valid pack placed in the OpenRig home `context-packs/` root.
Copy this pack, update its manifest, and replace each prompt below with your world's facts.

## Exercise: Book world

Run `rig context get world-example`, copy this pack, and make the project a book world. Describe
the writer, manuscript, sources, editorial rules, decisions, current draft state, and next useful
actions. Keep these as sections in coherent files; the region names below are atom metadata, not a
required directory layout.

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
