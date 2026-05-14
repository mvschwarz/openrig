---
skill: brainstorming
openrig-relationship: vendored-modified
---

# OpenRig and this skill

## Origin

- **Upstream**: Obra Superpowers (https://github.com/obra/superpowers)
- **Vendoring pattern**: `modify-the-file`
- **Last upstream check**: 2026-05-13 (diff against plugin source pulled 2026-05-11)

## How OpenRig uses this skill

`brainstorming` is the "intent → design" front of the OpenRig planning chain. Agents use it before any creative or implementation work — to refine user intent into a shareable design doc that downstream skills (`writing-plans`, then `executing-plans`) consume.

## OpenRig-specific modifications

| Surface | Upstream | OpenRig |
|---|---|---|
| Visual Companion offer step | Standalone step #2 in the flow — "offer Visual Companion in its own message before clarifying questions" | **Removed.** OpenRig agents typically operate without a separate visual-companion mode; visual design work routes through dedicated design-pod seats. |
| Spec self-review step | Step #7 — inline self-review for placeholders/contradictions/scope | **Removed.** Self-review is handled at the rig/orchestration layer (driver/guard pattern + review-lead). |
| User reviews written spec | Step #8 — pause for user to review the spec file | **Removed.** OpenRig's founder-walk and orchestration gates already cover this checkpoint at a higher level. |
| Spec save path | `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` | `docs/plans/YYYY-MM-DD-<topic>-design.md` (matches OpenRig's `docs/plans/` convention) |
| Process flow diagram | Includes Visual Companion + Spec self-review nodes | Simplified to remove those nodes; edges rewired |

## Why these modifications (inferred)

- **Multi-platform / multi-step gates removed**: OpenRig's rig-level orchestration (driver → guard → qa, founder-walks) already provides the checkpoint structure that the upstream skill builds inline. Keeping those steps inside the skill double-gates the work.
- **`docs/plans/` path**: OpenRig's project structure uses `docs/plans/` as the canonical home for design + implementation plan documents (matches `writing-plans` modification — both are co-ordinated).

## Companion files

None.

## When to re-sync upstream

Watch upstream for:

- New phases or checkpoints in the brainstorming flow that OpenRig might want to adopt (rare; the skill is structurally stable in upstream).
- Changes to the brainstorming-to-writing-plans handoff (must stay coordinated with the `writing-plans` modifications).

When upstream changes:

1. Pull non-conflicting changes into the OpenRig copy.
2. Preserve the simplified 6-step flow and the `docs/plans/` save path unless founder direction reverses.
3. Bump `last_upstream_check` in `SKILL.md` frontmatter.
