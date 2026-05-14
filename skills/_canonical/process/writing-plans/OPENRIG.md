---
skill: writing-plans
openrig-relationship: vendored-modified
---

# OpenRig and this skill

## Origin

- **Upstream**: Obra Superpowers (https://github.com/obra/superpowers)
- **Vendoring pattern**: `modify-the-file`
- **Last upstream check**: 2026-05-13 (diff against plugin source pulled 2026-05-11)

## How OpenRig uses this skill

`writing-plans` is the middle step of OpenRig's three-stage implementation flow: `brainstorming` produces the design, `writing-plans` turns the design into a bite-sized task plan, and `executing-plans` (also OpenRig-modified) drives the plan to completion in batches. Driver seats use this skill when authoring plans for guard + qa to review and for downstream drivers to execute.

## OpenRig-specific modifications

| Surface | Upstream | OpenRig |
|---|---|---|
| Plan save path | `docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md` | `docs/plans/YYYY-MM-DD-<feature-name>.md` (matches OpenRig's `docs/plans/` convention; coordinated with the matching change in `brainstorming`) |
| Scope Check section | Explicit step to break multi-subsystem specs into sub-project specs | **Removed.** OpenRig's slice + mission decomposition (handled at the orchestration layer) already enforces single-coherence scope per plan. |
| File Structure section | Explicit step to map files-to-be-created/modified with responsibilities before defining tasks | **Removed.** OpenRig drivers work inside an already-scoped slice; file-decomposition decisions live in the slice spec, not the plan. |
| Worktree context hint | "If working in an isolated worktree, it should have been created via the `superpowers:using-git-worktrees` skill at execution time." | "This should be run in a dedicated worktree (created by brainstorming skill)." — less explicit cross-skill dependency. |
| "For agentic workers" plan-header pointer | Suggests `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` | "For Claude: REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task." Removed the subagent-driven-development pointer (consistent with the `executing-plans` modification). |
| Step tracking syntax | `- [ ] **Step 1: ...**` (checkbox for TodoWrite tracking) | `**Step 1: ...**` (bare bold; OpenRig drivers use their own task-tracking) |

## Why these modifications (inferred)

- **Path coordination**: `docs/plans/` is OpenRig's canonical home for plan documents. The `brainstorming` skill produces designs at `docs/plans/...-design.md`; `writing-plans` produces plans at `docs/plans/...-feature-name.md`. Same root.
- **Scope + structure handled higher**: OpenRig's slice spec already constrains scope (one coherent slice) and identifies the touched-file surface. Repeating those checks inside the plan-authoring skill double-gates the work.
- **No subagent-driven-development pointer**: same reason as the `executing-plans` modification — OpenRig topologies provide parallel-pod review via separate seats; routing through subagents is structurally redundant.
- **Bare bold step syntax**: OpenRig drivers track progress via the orchestration queue + their own task tooling, not via in-file TodoWrite checkboxes.

## Companion files

None.

## When to re-sync upstream

Watch upstream for:

- Changes to plan structure or task-granularity guidance.
- Coordination changes with `brainstorming` and `executing-plans` (this skill is the middle of a 3-skill chain; changes to either end may require this skill to follow).

When upstream changes:

1. Pull non-conflicting changes into the OpenRig copy.
2. Preserve the `docs/plans/` save path and the absence of the Scope Check + File Structure sections unless founder direction reverses.
3. Re-check that the subagent-driven-development pointer hasn't crept back in.
4. Bump `last_upstream_check` in `SKILL.md` frontmatter.
