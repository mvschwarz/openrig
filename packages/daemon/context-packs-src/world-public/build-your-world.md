# Build your world

## Keep the first version small

<!-- world-claim: minimal-world-layout -->
Start with a directory whose name says what world it serves:

```text
book-world/
  manifest.yaml
  world.md
  boundaries.md
```

<!-- world-claim: authoring-convention -->
The manifest names the files. The prose states durable purpose, relationships, and what to trust. Add atoms when the same bytes need situation, runtime, order, or region metadata. Add a claim ledger and verifier when authored statements can drift into consequential lies. Do not add ceremony that has no reader yet.

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

<!-- world-claim: coverage-map-contract -->
Each coverage entry names one dimension, one exact context address, and the task moment that should trigger the read.
The address is the source: retrieve it with `rig context get <address>` before making a load-bearing decision in that dimension.

| Dimension | Exact address | What it contains | Read it when the task asks you to… |
|---|---|---|---|
| product | `world-public/boundaries.md#this-pack-does-not-cover` | The boundary of public guidance; the project must supply its actual purpose and product judgment. | choose a product outcome or tradeoff and locate the project authority that can decide it. |
| topology | `skills/core/openrig-architect/SKILL.md` | Portable topology authoring, role selection, validation and context guidance. | add, split, merge, or assign a seat, pod, edge, or responsibility boundary. |
| context | `world-public/build-your-world.md#separate-kinds-tag-regions` | The World/Lore/Skills/Mission separation and region-tagging rule. | decide where knowledge belongs or whether it should be preloaded. |
| skill | `onboarding-width/public-reference-material.md#the-one-you-read-rather-than-consult` | The operating-model entry point and how it differs from lookup references. | choose an operating model or repeatable procedure instead of improvising one. |
| queue/custody | `onboarding-width/public-what-you-can-do.md#making-work-outlive-you` | Durable queue ownership, state, blocking, and transactional handoff. | assign, claim, block, hand off, or close work that must survive a turn or occupant. |
| source/worktree | `onboarding-width/public-reference-material.md#the-command-surface-docs-as-built-in-the-source-repo` | The maintained as-built source map and its trust metadata. | locate the source owner, choose authoritative documentation, or separate branch state from running behavior. |
| proof/review | `skills/process/verification-before-completion/SKILL.md` | Evidence before claims, content checks and untested dimensions; apply the project-selected proof standard. | decide what evidence supports a change or design its negative control. |
| lifecycle/release | `skills/core/rig-lifecycle/SKILL.md` | Lifecycle mechanics and limits; release ownership must come from the actual project authority. | plan a lifecycle operation and resolve who may execute or publish it. |
| continuity/recovery | `onboarding-width/public-what-you-can-do.md#when-something-is-broken` | Recovery, handover, compaction, snapshot, and restore capabilities. | restore, hand over, compact, or recover a seat, rig, daemon, or host without losing continuity. |
| host-boundary | `skills/core/cross-host-rig-commands/SKILL.md` | Host addressing, transport and verification limits; local authority remains separately declared. | move an operation between hosts or determine which target and authority apply. |

The addresses above are public entry points, not this project's decisions. When a
row calls for local product, release or host authority, resolve the configured
project context and record its exact address before acting. If no such authority
is authored or available, report the missing decision; do not treat the public
mechanics guide as permission. The map reveals where to start without inventing
a builtin project policy.

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

<!-- world-claim: book-exercise-guidance -->
Use the example to describe who the writer is, what manuscripts and sources exist, where they live, which editorial rules apply, what decisions shaped the draft, how current state is derived, and what the agent can do next; keep it pleasant to read, and simplify it if the arrangement feels like a filing system rather than a place.

<!-- world-claim: book-to-software -->
The book exercise maps its manuscript to a codebase, editorial rules to engineering laws and conventions, draft state to derived build and deploy state, and its writer to the team. Software worlds use the same moves.

<!-- world-claim: software-shaped-bridge -->
Agents already know software-shaped building through specifications, verification loops, tooling, and the programming substrate. A world pack built this way uses named files and a manifest as the spec shape, per-claim checks and a verifier that can fail as the test suite, and derive-at-source commands as the feedback loop. A blank-slate reader therefore already knows how to build this kind of artifact: world-building supplies the information architecture while software-shaping supplies buildability.

<!-- world-claim: optional-claim-checking-climb -->
The full public pack demonstrates the optional claim-checking climb.

<!-- world-claim: derive-pack-path -->
Use rig context show world-public --json to derive the installed pack directory.
<!-- world-claim: run-public-verifier -->
Run `node verify-world-native.mjs` in that derived directory instead of teaching a machine-specific path.
The POSIX `sh verify-world.sh` entry retains the same named checks.
