---
skill: using-superpowers
openrig-relationship: vendored-modified
---

# OpenRig and this skill

## Origin

- **Upstream**: Obra Superpowers (https://github.com/obra/superpowers)
- **Vendoring pattern**: `modify-the-file`
- **Last upstream check**: 2026-05-13 (diff against plugin source pulled 2026-05-11)

## How OpenRig uses this skill

`using-superpowers` is the catalog-aware "always reach for a skill before answering" bootstrap. It's loaded into every OpenRig agent's startup context to enforce the discipline that skills must be invoked through the `Skill` tool (not Read'd directly), and that the agent should pattern-match descriptions against the work at hand before producing free-form output.

## OpenRig-specific modifications

| Surface | Upstream | OpenRig |
|---|---|---|
| `<SUBAGENT-STOP>` block | Skip the skill if dispatched as a subagent | **Removed.** OpenRig doesn't use the upstream subagent-dispatch pattern; this directive doesn't fit the rig/pod/seat topology. |
| Instruction Priority section | 3-tier priority: user > skills > system | **Removed.** OpenRig handles priority at the AgentSpec + agent-startup-content layer, not inside this skill. |
| Platform-specific sections (Copilot CLI, Gemini CLI) | Each platform gets its own paragraph for how to access skills | **Removed.** OpenRig targets Claude Code + Codex specifically. The Claude Code paragraph is preserved. |
| Platform Adaptation section | Points to `references/copilot-tools.md` and `references/codex-tools.md` for tool mapping | **Removed.** OpenRig agents don't need the upstream tool-mapping references; the rig spec lists tools directly. |

## Why these modifications (inferred)

- **Topology mismatch**: OpenRig's subagent model is the rig/pod/seat structure, not the upstream's "dispatch a subagent" pattern. The `<SUBAGENT-STOP>` block would silently skip the skill in seats that should be loading it.
- **OpenRig is opinionated about target runtimes**: Claude Code + Codex are the supported pair. Multi-platform copy adds cognitive overhead without product value for OpenRig users.
- **Priority lives at the spec layer**: OpenRig's AgentSpec + startup content (role.md, guidance/, CULTURE.md) is where instruction precedence is encoded; baking it into this skill duplicates the layering.

## Companion files

None. (Upstream ships `references/copilot-tools.md` and `references/codex-tools.md` but these reference the upstream Copilot tool surface, not OpenRig's. They are not vendored.)

## When to re-sync upstream

Watch upstream for:

- Changes to the core "always invoke a skill" discipline (the heart of the skill).
- New platforms upstream supports that OpenRig might also want to support — would need to add a corresponding paragraph here.

When upstream changes:

1. Pull non-conflicting changes into the OpenRig copy.
2. Do NOT re-introduce the multi-platform sections, SUBAGENT-STOP block, or Instruction Priority section unless founder direction reverses.
3. Bump `last_upstream_check` in `SKILL.md` frontmatter.
