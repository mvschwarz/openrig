# Naming rigs, pods and seats

Names tell people and agents what a team does and who does each part. Use the
team's purpose for the rig, a domain for each pod, and a role for each seat.
These are authoring conventions, not additional parser restrictions.

## What each name means

| Level | Meaning | Example |
| --- | --- | --- |
| Fleet | A group of OpenRig instances | Your development fleet |
| Instance | One daemon and its rigs; several instances can share a machine | The instance selected by a registered host route |
| Rig | A team or project purpose | `starter`, `workshop`, `factory`, or your project's name |
| Pod | A domain or shared context | `orch`, `dev`, `review`, `research`, `sre` |
| Seat (member) | A role within that pod | `lead`, `advisor`, `build`, `qa`, `design`, `review` |

The logical seat ID is `pod.member`: `dev.build`. Its session address is
`pod-member@rig`: `dev-build@workshop`. A cross-instance command also selects the
registered host route; a display label is not a route. Discover actual addresses
with `rig ps --nodes` and host routes with `rig host list` before sending work.

Runtime, model and account belong in configuration. Changing a provider does not
change the role's name. Keep machine and instance identifiers stable rather than
renaming them whenever their workload changes.

## How the software teams grow

| Team | Logical seats |
| --- | --- |
| Starter | `dev.build`, `dev.review` |
| Workshop | `orch.lead`, `dev.build`, `dev.qa`, `dev.review` |
| Factory | `orch.lead`, `orch.advisor`, `dev.build`, `dev.qa`, `dev.design`, `review.r1`, `review.r2` |

Starter and Factory are built-in teams. Workshop is a
[bundle](https://github.com/mvschwarz/openrig-world/tree/main/rigs/workshop).
The built-in specs live under `packages/daemon/specs/rigs/launch/` in the product
source. Runtime presets keep these logical names.

Workshop's one code reviewer is `dev.review`; Factory has an independent review
pod with `review.r1` and `review.r2`. Both are intentional. A small team does not
need every pod or role from a larger one.

## Name a new team

Start with the outcome, then group its work by domain. For a team studying a
dataset, `research.analyst` and `research.synthesizer` describe useful roles.
For operating a service, `sre.admin` describes the domain and responsibility.
Use a project-specific rig name when that helps distinguish two teams.

Avoid a generic operation such as `check` as the pod name: it does not say whether
the team owns software quality, research validation or service health. Put the
role in its domain, such as `dev.qa`. This is a rule for choosing new names, not a
word blacklist or a demand that all teams share one roster.

Use the same IDs in the rig spec, edges, workflow targets, configuration presets,
startup instructions and terminal views. Validate those references together.
See [RigSpec](rig-spec.md) and [publishing a bundle](publishing-a-rig-bundle.md).

## Existing identities and retained references

An existing team's address remains its actual address until it is deliberately
migrated. Changing a label does not rename a seat or move its conversation, queue
or work. Preserve those records and verify the new routes when doing a migration;
do not edit a database or restart a team just to make a display match an example.

`first-project` is the compatibility name for Starter; it is not a second team
template. Existing-name safeguards still apply. See
[getting started](getting-started.md) before using the alias.

The `factory-rsi` bundle is a retained reference with original workflow-bound
addresses, including `build.implementer` and `check.qa`. It is distinct from the
current built-in Factory and is not the naming template for a new team. Old
release notes, pinned bundles, run records and compatibility tests keep the
identities they describe.
