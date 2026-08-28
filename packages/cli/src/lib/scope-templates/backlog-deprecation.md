---
id: {{id}}
slice: {{slice_number}}-{{slug}}
mission: {{mission}}
status: placeholder
stage: wip
verified: {{created_date}} against scaffold (rig scope create)
created: {{created_date}}
intent: {{intent_yaml}}
depends_on: {{depends_on}}
---

# Slice {{slice_number}} — {{title}}

## Intent

{{intent}}

## Mini-requirements

1. [The deprecation path as observable outcomes. For a small deprecation this may BE the whole plan.]

## Proof contract

- [ ] [The migration landed / the removal is clean — captured. Pair with proof via `rig proof add … --evidences` (media attached with `--media`).]

## Target

[What is being deprecated]

## Current state

[How it works today; what depends on it]

## Migration

[Path off the deprecated thing]

## Removal

[When/how the deprecated thing gets deleted]

---

> **How you work this slice (SOP):** conventions SSOT: `docs/reference/sdlc-conventions.md` (installed: `$OPENRIG_HOME/reference/sdlc-conventions.md`) — read its COMPONENT MENU first: your mission chooses the build path (the simple default flow · the wave model · the assigned rigorous overlay) and the planning rigor (the P0–P4 dial); do not assume the heavy flow unless your mission or dispatch assigns it. Full flow for the default path: the `mission-slice-sop` skill. The floor on every path: track on PROGRESS.md; evidence lands via `rig proof add` (never hand-placed); a slice is **not done** until its promised outcomes have evidence; verify with `rig scope audit`.
