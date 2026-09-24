---
name: openrig-software-factory
description: >-
  Use when a user wants a continuing software team for a real repository, or has a
  first OpenRig team and needs a repeatable path for reviewed work and later tasks.
metadata:
  cli_surfaces_referenced:
    - context get
    - context list
    - context show
    - workflow compile
    - workflow instantiate-lifecycle
  openrig:
    stage: WIP
    transfer_test: pending
---

# OpenRig Software Factory

Turn a repository and an outcome into useful reviewed work, visible ownership,
and a way through genuine waits. Compose the existing team, context and workflow
primitives. A single local edit need not become a factory or a new workflow.

## Start with compatible guidance

Before installation, read this file and its companion at the same published tag
or commit as the chosen package. Use the public getting-started guide for setup,
native login and the user's permission choice. An existing agent can bootstrap;
a ready kernel operator can help, but is neither required nor the project owner.

After installation, discover the bundled copy:

```sh
rig --version
rig context list --json
rig context show skills/core/openrig-software-factory --json
rig context get skills/core/openrig-software-factory/SKILL.md
```

Check the selected instance, package/build identity and served recipe version.
Equal version numbers alone do not prove equal builds. If the ref is missing,
unreadable or incompatible, retain that result and resolve the package/guidance
choice. Do not silently substitute current GitHub main for an older installation.
Do not proceed with an incomplete companion.

## Set up only what serves this outcome

1. Read the repository's instructions, existing work and the user's desired
   result. Establish the intended instance, code/work roots, available runtimes,
   permissions and spend boundary. Preserve existing files and unrelated edits.
   Ask only for decisions that remain unresolved; ordinary work already within
   the agreed scope needs no repeated approval.
2. Reuse a suitable team or preview a small one using the getting-started guide.
   The `first-project` owner/checker pair is one example. Verify actual native
   readiness and addresses before assigning work. Daemon health is insufficient;
   do not create duplicate seats to escape prompts. The project owner coordinates
   implementation and the independent check after bootstrap.
3. Read [references/worked-example.md](references/worked-example.md) when connecting
   project/mission/slice files, context and workflow. Installed retrieval:
   `rig context get skills/core/openrig-software-factory/references/worked-example.md`.
   Adapt its two dependent CSV changes to the real outcome; they are not a required
   decomposition. Keep readable intent and useful agreements in user-owned files.
   Bind actual workspace/topology roots, deliver the selected context, and verify
   each seat's role/scope reaction. A context retrieval is not a delivery receipt.
4. Distinguish authoring from execution. `rig workflow compile` inspects the
   selected lifecycle graph. Only a deliberate `rig workflow instantiate-lifecycle`
   creates the runtime and entry obligation. Inspect routes, prerequisites and
   advisories first; retain one operation key and reconcile a timeout before
   retrying. Running inputs do not silently adopt later YAML edits.
5. Let the current packet owner carry the exact candidate and evidence through
   implementation, the selected independent check and bounded repairs. Use the
   workflow projection mechanism for its packets. Preserve a real missing user
   decision as a wait on that same frontier; a timer is not an answer. Resume the
   retained step when the decision arrives, without creating another instance.
6. Report the checked result and how to try it. Retain the next authorized task
   with the same owner or explicitly record that none exists. Show why work is
   waiting, who acts next and what remains unverified. Use the existing lifecycle
   guide to stop only the intended team safely while preserving work and custody.
   A stop alone does not prove restore; one next-task pickup does not prove weeks
   of unattended operation.

## User request

> Help me achieve [observable change] in this repository. Read the compatible
> OpenRig Software Factory recipe. Use a small suitable team with an owner and
> independent checker, preserve existing instructions and files, and show who owns
> the next step. Perform the agreed local implementation and checks. Ask about
> unresolved product decisions or effects outside that scope. Keep publication
> and destructive changes out of this task.

## Verification and maintenance

This recipe is being prepared with OpenRig 0.5.14 source on macOS arm64. The
independent public-only native-agent journey is **not yet tested**; no platform,
provider, fresh-account or sustained-autonomy success is implied. Bind exact
source/build/archive and recipe bytes in the delivery receipt. Record actual
prerequisites, assistance, failures, reviewed work, wait/continuation, next pickup
and stop before replacing this limit with measured coverage.

When referenced commands, manifests, bootstrap or permission semantics change,
check the recipe and companion in that same change. Keep its index, public entry
and packaged copies aligned. Website presentation should link to or import the
same versioned source, with no separate maintained procedure.
