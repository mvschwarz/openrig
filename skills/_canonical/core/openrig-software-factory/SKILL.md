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
    - grow
    - queue create
    - queue handoff
    - workflow compile
    - workflow instantiate-lifecycle
  openrig:
    stage: WIP
    transfer_test: pending
---

# OpenRig Software Factory

Start with a useful repository outcome and add coordination when it earns its
cost. A beginner can complete reviewed work without Workflow. These are choices
using existing capabilities, not stages everyone must graduate through.

## Choose how the team works

| Need | Start here | Add more when… |
| --- | --- | --- |
| One change, close human guidance | Manual/team work: give an owner the outcome, use repository instructions, implement and obtain the chosen independent check. | Work must survive turns or move between seats. |
| Continuing work with visible ownership | Queue-supported orchestration: use `rig queue create`, claim work, then `rig queue handoff` with the candidate/evidence to the next owner. Record real blockers and the continuation. No Workflow instance is needed. | Repeated steps need an explicit dependency graph and permitted exits. |
| An explicit execution contract | Workflow: inspect `rig workflow compile`, then deliberately use `rig workflow instantiate-lifecycle`. Advance its packets through the workflow projection mechanism. | The actual project needs reusable profiles, additional roles or gates. |

For the concrete queue loop, wake behavior and optional two-slice Workflow,
read [references/worked-example.md](references/worked-example.md). Installed copy:
`rig context get skills/core/openrig-software-factory/references/worked-example.md`.
A roadmap, YAML file or wake does not execute work or authorize a new outcome.

## Establish the working agreement

Read the repository instructions, current work and desired user-visible result.
Verify the intended instance, code/work roots, real seat addresses and native
readiness. Reuse a suitable small team; an existing agent can bootstrap it.
A kernel operator is optional and is not automatically the project owner.

Agree the work boundary, time/spend limit, who answers unresolved choices, and
when to stop: checked result, no authorized next work, exhausted budget, or a real
user/permission/provider blocker. Background daemon checks are not themselves
model turns, but delivered wakes and resumed work **can spend tokens**. Prefer
an event-driven wait to frequent empty reminders. Wakes cannot answer a user
question, clear a permission prompt or guarantee progress.

**Choose permissions before launching or assigning work.** Offer ordinary prompts,
persistent rules for selected commands, or deliberately broader access. Follow
[Applying a permission policy](#find-the-compatible-permission-guide) to perform
the user's choice and verify it in the target conversation. Preserve restrictions
and unrelated settings. A whole `rig` allowance covers every verb, not just reads;
it does not grant new product authority or change everyone else's defaults.

Keep purpose, acceptance, decisions and evidence in existing project files.
Deliver selected context and obtain each seat's scope reaction; retrieval alone
is not peer delivery. The owner carries the candidate through the chosen check
and bounded repairs, reports how to try it, and retains the next authorized task
or explicitly reports none. Preserve work and custody before a supported stop.

## Grow your factory

Choose the team size separately from the coordination method above:

1. **Use the two-agent starter.** Keep the existing owner and independent checker
   while that pair meets the workload. The owner can implement and coordinate.
2. **Add one or two seats to the running rig.** This is the usual next step.
   Follow [Grow the running team](references/worked-example.md#grow-the-running-team)
   for `rig grow` commands, readiness/context/work
   assignment, and saving the expanded topology. Existing sessions need no
   rebuild or down/up cycle solely to add capacity.
3. **Author a custom rig when you want a different structure.** Read
   [OpenRig Architect](../openrig-architect/SKILL.md), available through
   `rig context get skills/core/openrig-architect/SKILL.md`. Request:
   “Design a user-owned rig for [outcome] using the compatible RigSpec/AgentSpec
   guidance. Reuse suitable agents, define responsibilities and context, and
   validate the files. Preserve the existing rig and agree any new launch.”

As independent work grows, the original owner can concentrate on orchestration,
multiple builders can implement separate outcomes, and the checker can retain
independent review capacity. Record that division explicitly; adding seats does
not assign work, change permissions or create parallelism. Agree file/worktree
boundaries and integration ownership, follow the project's existing review policy,
and keep active concurrency within the user's time/spend budget. Two seats are
an entry point, not a finished factory or a maximum.

## Read compatible guidance

Before installation, use this file and companion at the same published tag or
commit as the selected package. After installation:

```sh
rig --version
rig context list --json
rig context show skills/core/openrig-software-factory --json
rig context get skills/core/openrig-software-factory/SKILL.md
```

Compare build identity as well as version. Preserve missing, unreadable or older
recipe results; do not silently substitute newer main or skip a missing companion.

### Find the compatible permission guide

Retrieve the maintained procedure with
`rig context get skills/applying-a-permission-policy/SKILL.md`.
For source or archive readers, locate it below; the companion getting-started
guide contains optional broader launch-mode recipes under **Opt-in permissive
operation**. These paths are relative to the named root, not this skill:

| Reading from | Procedure and guide, at the same version as this recipe |
| --- | --- |
| Source checkout, including `skills/_canonical` | Below the repository root: `packages/daemon/assets/plugins/openrig-core/skills/applying-a-permission-policy/SKILL.md` and `docs/reference/getting-started.md`. |
| npm installation | Below the matching `npm root -g` or local `npm root`: `@openrig/cli/daemon/assets/plugins/openrig-core/skills/applying-a-permission-policy/SKILL.md` and `@openrig/cli/daemon/docs/reference/getting-started.md`. |
| Unpacked npm archive | Below the extraction directory: `package/daemon/assets/plugins/openrig-core/skills/applying-a-permission-policy/SKILL.md` and `package/daemon/docs/reference/getting-started.md`. |

For installed guidance, use the npm installation that supplies the selected
`rig` executable; another prefix or local project can contain a different version.
If the matching guide or section is missing, report the gap before proceeding;
do not substitute current main or guidance from another installation.

## Request to give your agent

> Help me achieve [observable change] in this repository. Read the compatible
> Software Factory recipe, choose the lightest useful team/queue/Workflow path,
> and keep the next owner visible. Preserve existing files and permissions.
> Agree time/spend limits, perform the authorized work and chosen independent
> check, and ask only about unresolved decisions or effects outside that scope.
> Keep publication and destructive changes out of this task.

When commands, defaults or permission semantics change, check this source and
companion together and regenerate their existing projections. Website guidance
should link to the same versioned recipe, not maintain another procedure.
