---
name: rig-bundles-and-shareable-artifacts
description: Use when authoring or installing a rig bundle (packaged, shareable artifact that instantiates an opinionated OpenRig topology + workflow), reasoning about the bundle vs extension boundary, or auditing a bundle for portability. Covers the 4 failure modes that prevent bundles from working anywhere but the operator's machine, and the inspect-before-install discipline.
metadata:
  cli_surfaces_referenced:
    - bundle create
    - bundle inspect
    - bundle install
  openrig:
    stage: factory-approved
    sibling_skills:
      - rig-lifecycle
      - topology-mutation-and-seat-management
      - seat-scaling-and-specialization
      - cross-host-rig-commands
      - sidecar-operator
      - specification-system
      - extension-and-user-workspace
---

# Rig Bundles and Shareable Artifacts

A **rig bundle** is a packaged, shareable artifact that can instantiate
an opinionated OpenRig topology and workflow. It may include:

- rig specs
- agent specs
- workflow specs
- startup files
- skills or skill references
- operating-mode declarations
- proof expectations
- supporting fragments

**Shareable artifact** is broader than bundle: specs, bundles, skills,
workflows, and extensions can all be shared. A bundle is the packaged
form for "load this topology and way of working."

## Use this when

- Authoring a bundle from a proven lab pattern
- Installing a bundle (`rig bundle install <path>`)
- Inspecting a bundle before install (`rig bundle inspect <path>`)
- Reasoning about bundle vs extension boundary (bundle declares topology + workflow; extension adds behavior)
- Auditing a bundle for portability — does it work on a clean OpenRig environment, or only the author's machine?

## Don't use this when

- The work is a one-off topology you won't reuse. Specs alone are sufficient.
- The intent is to add runtime behavior (commands, views, dashboards). Use `extension-and-user-workspace`, not bundles.
- You want to ship a workflow as a daemon feature. Bundle is the path *before* daemon promotion.

## The bundle vs extension boundary (load-bearing)

| Concept | Declares | Example |
|---|---|---|
| **Bundle** | Rig shape + workflow ("load this topology and way of working") | A Velocity Team bundle |
| **Extension** | Behavior added to user workspace/runtime | A custom command, view, or dashboard |

Don't confuse them. A bundle is *opinionated content*; an extension is
*added behavior*. Both can be shareable artifacts, but they're
structurally distinct.

## Failure modes (4)

1. **A bundle works only on the operator's machine** because paths, providers, or credentials are implicit. Bundles must be self-describing for a clean OpenRig environment.
2. **A bundle includes too much local state and becomes a backup archive instead of a reusable artifact.** Bundle is the *intended shape*, not the current state of one specific install.
3. **A bundle declares topology but omits proof expectations or workflow mode.** Topology alone doesn't tell users what "working as advertised" means.
4. **Users cannot inspect what a bundle will create before installing it.** `rig bundle inspect` must show what will be created without side effects.

## Proof standard

Proof should:

1. Install the bundle into a **clean OpenRig environment**
2. Instantiate it
3. Verify the expected seats and workflow mode
4. Run a small smoke proof that the topology behaves as advertised

## Bundle path → product

Bundles are how proven lab patterns become reusable product experiences:

```
local dogfood pattern
  → bundle (with manifest, parameterization, proof expectations)
  → installed by another user on clean OpenRig
  → opinionated workflow shipped without becoming a daemon feature
  → if dependable, graduate parts into core daemon
```

This is also how OpenRig can ship opinionated workflows **without making
every workflow a daemon feature.**

## See also

- `extension-and-user-workspace` skill — sibling primitive for user-owned behavior added to runtime; bundle vs extension boundary
- `specification-system` skill — rig specs / agent specs / workflow specs that bundles package
- `agent-starters` skill — bundles can include or reference Agent Starters
- `composable-priming-packs` skill — bundles can package priming packs
- `openrig-user` skill — `rig bundle create / inspect / install` CLI surface
