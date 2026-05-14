---
skill: executing-plans
openrig-relationship: vendored-modified
---

# OpenRig and this skill

## Origin

- **Upstream**: Obra Superpowers (https://github.com/obra/superpowers)
- **Vendoring pattern**: `modify-the-file`
- **Last upstream check**: 2026-05-13 (initial relationship declaration)

## How OpenRig uses this skill

This is the canonical "execute a plan that another seat wrote" skill for OpenRig implementation agents. The driver/guard/qa pattern depends on this skill to keep plan-execution checkpointable and reviewable. Without the batch-with-checkpoint structure, the orchestration loop loses its in-flight review surface.

## OpenRig-specific modifications

The skill was restructured from upstream's all-tasks-at-once execution shape into a batch-with-checkpoint shape:

| Aspect | Upstream | OpenRig |
|---|---|---|
| Execution unit | All tasks in plan, sequentially | Batch (default 3 tasks per batch) |
| Reporting cadence | Once at end (after all tasks complete) | Between every batch |
| Architect-review surface | None inside the skill | Step 3 "Report" + Step 4 "Continue" cycle |
| Subagent alternative | Suggests `superpowers:subagent-driven-development` as a better choice when subagents are available | **Removed**. OpenRig topologies already supply separate pods for review; the subagent pointer added cognitive overhead with no win. |
| Stop conditions | "Hit a blocker" | "Hit a blocker **mid-batch**" |
| Step 5 "Complete Development" | Step 3 in upstream | Renumbered to Step 5 to make room for the batch-and-report cycle |

The `## Integration` section preserves the upstream sub-skill pointers (`using-git-worktrees`, `writing-plans`, `finishing-a-development-branch`) — those are also vendored from obra-superpowers and present in OpenRig under the same names.

## Why these modifications

- **Batch-and-report cadence fits the OpenRig driver/guard/qa rhythm.** Architect feedback is in-the-loop rather than after-the-fact. A driver who reports between batches gives guard + qa room to surface direction corrections before more work compounds the wrong direction.
- **The subagent-driven-development pointer doesn't fit the OpenRig posture.** OpenRig already provides parallel-pod review via separate seats; routing through subagents is structurally redundant.
- **"Mid-batch" precision in stop conditions** matches the batch unit. A driver hitting a blocker between tasks should still report — the unit of "stop and ask" is the batch, not the whole plan.

## Companion files

None at the moment.

## When to re-sync upstream

Watch for upstream changes to:

- **Plan-execution discipline** — stop conditions, verification rules, blocker-handling cadence.
- **The relationship to writing-plans + finishing-a-development-branch** — if upstream changes how these compose, OpenRig should consider whether the new shape is worth adopting.

When upstream changes:

1. Pull non-conflicting changes into the OpenRig copy.
2. Preserve the batch-with-checkpoint structure unless founder direction reverses.
3. Re-check that the subagent-alternative pointer hasn't crept back in.
4. Bump `last_upstream_check` in `SKILL.md` frontmatter.
5. Note any structural shape changes in `divergence_notes`.
