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

**Choose permissions before launching or assigning work.** Keep ordinary native
prompts, or deliberately select the user's permissive policy after explaining
its filesystem/network risks. Read the [permission guidance](../../../../../../../../docs/reference/getting-started.md#opt-in-permissive-operation)
(the installed `getting-started.md` has the same section). Check the effective
native mode: an OpenRig resource profile is not a permission profile, and a
Codex YOLO sandbox setting alone does not select its approval policy. Preserve
user defaults; never silently add global trust, network grants or bypass flags.

Keep purpose, acceptance, decisions and evidence in existing project files.
Deliver selected context and obtain each seat's scope reaction; retrieval alone
is not peer delivery. The owner carries the candidate through the chosen check
and bounded repairs, reports how to try it, and retains the next authorized task
or explicitly reports none. Preserve work and custody before a supported stop.

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

## Request to give your agent

> Help me achieve [observable change] in this repository. Read the compatible
> Software Factory recipe, choose the lightest useful team/queue/Workflow path,
> and keep the next owner visible. Preserve existing files and permissions.
> Agree time/spend limits, perform the authorized work and chosen independent
> check, and ask only about unresolved decisions or effects outside that scope.
> Keep publication and destructive changes out of this task.

## What has been observed

A bounded macOS/Codex trial on 0.5.14 completed independently reviewed two-slice
work, next-task pickup and a supported stop with setup assistance. It required
**48 one-time approvals (34 owner, 14 checker)**. This is not an unattended or
low-friction result. A genuine product-decision wait/answer and automatic refocus
were not demonstrated; these revised instructions have not had a new native trial.
No fresh-account, other-platform/provider, restore or weeks-long autonomy claim.

When commands, defaults or permission semantics change, check this source and
companion together and regenerate their existing projections. Website guidance
should link to the same versioned recipe, not maintain another procedure.
